/**
 * 写入：**只执行已决定的 op**，一个字节都不自己写 FACT / MEMORY。
 *
 * 契约（00 §4.3 / 02 §7.4）：
 *  - 只通过 `@dsh-external/dsh-persona-memory/store` 访问记忆文件：闸口、备份、
 *    原子写、读写锁都在 store 里（00 §9 审计 P0：这三件事必须收进 store，否则
 *    本插件会与主插件的压缩管线抢文件）；
 *  - 撞限（`MEMORY_BUDGET_EXCEEDED`）⇒ **降级写 JOURNAL 一次**，不重试、不合并、
 *    不删条目，并把水位记进 runlog；
 *  - 被改掉的旧值**不写 JOURNAL**（否则 recall 会召回旧事实、L2 会把旧值升格
 *    回 FACT），只写 `consolidate/superseded.jsonl`（只读审计，不进任何检索）；
 *  - UPDATE 优先走「两段式失效」（DESIGN §6）：先 ADD 新正文，成功后才
 *    `store.supersedeEntry(旧)`（`by` = 新条目 contentId）；任一步不成立就退回原子
 *    `replaceEntry`，**绝不**出现「旧条目被标记失效、新条目没写进去」；
 *  - `MEMORY_BUDGET_EXCEEDED` 之外的错误：记 FAIL，交给预算层算退避，**不在本
 *    模块重试**。
 *
 * 影子模式（P1，`mode: observe`）：
 *  - 该判定的照常判定（含 `store.assertEntry` 闸口预演，所以「本来会撞限」能被提前
 *    看到），但 **`insertEntry` / `replaceEntry` / `deleteEntry` / `appendJournal`
 *    一个都不调**，一个字节都不写进 FACT / MEMORY / JOURNAL；
 *  - 「本来会写什么」落盘到 `consolidate/would-write/<yyyy-mm-dd>.jsonl`，一行一个算子；
 *  - 落盘失败**绝不当成成功**：该条记 FAIL、`counts.failed` 加一（pipeline 据此把整次
 *    运行标成 FAIL），`wouldWrite.failed` 也能让上层看到。
 *
 * store 是**注入**的（`resolveStore` 或直接给 `store`），所以单测不需要装主插件。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { STATUS, supersededPath, wouldWritePath } from './runlog.js';
import { codeOf } from './llm.js';
import { MODE, normalizeMode } from './mode.js';
import { STORE_SCOPE_MAP, toStoreScope, redact } from './validate.js';

/** 写入结果状态（runlog 与面板共用）。 */
export const WRITE_STATUS = {
    WRITTEN: 'written',
    REPLACED: 'replaced',
    DELETED: 'deleted',
    DEMOTED: 'demoted',
    DROPPED: 'dropped',
    NOOP: 'noop',
    DRY: 'dry',
    FAILED: 'failed',
    /* ── 影子模式（P1）：`would-*` 一律表示「本来会这样，但一个字节都没写」── */
    WOULD_WRITTEN: 'would-written',
    WOULD_REPLACED: 'would-replaced',
    WOULD_DELETED: 'would-deleted',
    WOULD_DEMOTED: 'would-demoted',
    WOULD_DROPPED: 'would-dropped',
    WOULD_NOOP: 'would-noop',
    WOULD_JOURNAL: 'would-journal',
    WOULD_FAILED: 'would-failed',
};

/** 影子状态前缀（计数时只认这个前缀，绝不混进真实写入数）。 */
export const WOULD_PREFIX = 'would-';

/** 超限错误码（00 §9 审计：主插件只加 code，不改 message）。 */
export const BUDGET_EXCEEDED = 'MEMORY_BUDGET_EXCEEDED';

/**
 * 判断一个错误是不是「撞限」。
 *
 * @param {any} error
 * @returns {boolean}
 */
export function isBudgetExceeded(error) {
    if (error === null || error === undefined) return false;
    if (error.code === BUDGET_EXCEEDED) return true;
    if (error.name === BUDGET_EXCEEDED) return true;
    return typeof error.message === 'string' && error.message.includes(BUDGET_EXCEEDED);
}

/**
 * 把一条「旧值被替换」的记录写进 `superseded.jsonl`。
 *
 * 强制过一遍脱敏：这个文件不进检索，但会被人 `cat` 或未来的工具读到。
 *
 * @param {{ ts?: number, workspaceId?: string, scope?: string, old?: string, new?: string, reason?: string }} record
 * @param {{ file?: string }} [options]
 * @returns {boolean}
 */
export function appendSuperseded(record, options = {}) {
    const file = options.file ?? supersededPath();
    const mask = (text) => {
        const masked = redact(String(text ?? ''));
        return masked.drop ? '[redacted]' : masked.text;
    };
    const line = {
        ts: Number.isFinite(record?.ts) ? Number(record.ts) : Date.now(),
        workspaceId: String(record?.workspaceId ?? ''),
        scope: String(record?.scope ?? ''),
        old: mask(record?.old),
        new: mask(record?.new),
        reason: String(record?.reason ?? ''),
    };
    try {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8');
        return true;
    } catch {
        return false;
    }
}

/**
 * store 是否**明确降级**（P0-2）。
 *
 * 主插件 0.7+ 的返回是 `{written:false, demoted:'drop'|'journal', reason}`（`store.js`
 * 的 `insertEntry` / `replaceEntry` 校验不过时都是这个形状），早期契约里还有布尔
 * `demoted:true`。这里两种都认：**布尔 true 或非空字符串都算降级**。
 *
 * @param {any} result
 * @returns {boolean}
 */
function isDemoted(result) {
    const value = result?.demoted;
    return value === true || (typeof value === 'string' && value.trim() !== '');
}

/**
 * 降级方向：`'journal'`（写 JOURNAL）/ `'drop'`（整条丢弃）/ `true`（老契约 = journal）。
 *
 * @param {any} result
 * @returns {string}
 */
function demoteTargetOf(result) {
    const value = result?.demoted;
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    return 'journal';
}

/**
 * 从 store 结果里判「是不是没找到」。
 *
 * **必须排除降级**：`{written:false, demoted:'journal', reason:'问句'}` 是「条目被校验拒了」，
 * 不是「目标不存在」。旧实现只排除 `demoted === true`，于是字符串降级被误判成 not-found
 * ⇒ UPDATE 降级 ADD ⇒ 闸口再拒一次 ⇒ 记 `failed:error`，那批行永远不消费（P0-2 分支 2）。
 *
 * @param {any} result
 * @returns {boolean}
 */
function isNotFound(result) {
    if (result === null || result === undefined) return false;
    if (result.reason === 'not-found') return true;
    if (result.notFound === true) return true;
    if (isDemoted(result)) return false;
    return result.written === false;
}

/**
 * 追加一行影子记录（`would-write/<yyyy-mm-dd>.jsonl`）。
 *
 * 与 runlog 不同：这里**保留正文**（content）——影子文件存在的唯一理由就是让人看到
 * 「本来会写什么」。正文在管线里已经过 `validate()` 的打码闸口，这里不再二次处理。
 *
 * **不抛**，返回是否写成；失败由调用方折成 FAIL（绝不静默）。
 *
 * @param {Record<string, any>} record
 * @param {{ file?: string }} [options]
 * @returns {boolean}
 */
export function appendWouldWrite(record, options = {}) {
    const file = options.file ?? wouldWritePath(Number.isFinite(record?.ts) ? record.ts : Date.now());
    try {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
        return true;
    } catch {
        return false;
    }
}

/**
 * 预算预判：拿当前水位 + 本算子带来的增量，算「本来会不会撞限」。
 *
 * 只是**预判**：ADD 有 `assertEntry` 兜底（权威），UPDATE / DELETE 没有可预演的接口
 * （`replaceEntry` / `deleteEntry` 会真写），所以它们的 `authoritative` 是 false。
 *
 * @param {any} mark `store.watermark()` 的返回（可能是 null）
 * @param {{ storeScope: string, lineDelta: number, charDelta: number }} delta
 * @returns {Record<string, any>}
 */
export function predictBudget(mark, delta) {
    const base = { scope: String(delta.storeScope ?? ''), known: false, authoritative: false, exceeded: null, reason: 'no-watermark' };
    if (mark === null || mark === undefined || typeof mark !== 'object') return base;

    const lines = Number.isFinite(mark.lines) ? Number(mark.lines) : 0;
    const chars = Number.isFinite(mark.chars) ? Number(mark.chars) : 0;
    const bytes = Number.isFinite(mark.bytes) ? Number(mark.bytes) : 0;
    const lineDelta = Number.isFinite(delta.lineDelta) ? delta.lineDelta : 0;
    const charDelta = Number.isFinite(delta.charDelta) ? delta.charDelta : 0;
    const byteDelta = Number.isFinite(delta.byteDelta) ? delta.byteDelta : charDelta;
    const predicted = {
        scope: String(delta.storeScope ?? ''),
        known: true,
        authoritative: delta.authoritative === true,
        lines,
        chars,
        bytes,
        limit: mark.limit ?? null,
        predictedLines: Math.max(0, lines + lineDelta),
        predictedChars: Math.max(0, chars + charDelta),
        predictedBytes: Math.max(0, bytes + byteDelta),
        exceeded: false,
        reason: 'ok',
    };

    // 上限口径两种都认：FACT 是 `{lines, bytes}`，项目 MEMORY 是 `{chars}`；万一将来给了标量，
    // 按字符上限处理（宁可多报一次「会撞限」，不要漏报）。
    const limit = mark.limit;
    if (Number.isFinite(limit)) {
        if (predicted.predictedChars > Number(limit)) return { ...predicted, exceeded: true, reason: 'chars' };
        return predicted;
    }
    if (limit !== null && typeof limit === 'object') {
        if (Number.isFinite(limit.lines) && predicted.predictedLines > Number(limit.lines)) return { ...predicted, exceeded: true, reason: 'lines' };
        if (Number.isFinite(limit.chars) && predicted.predictedChars > Number(limit.chars)) return { ...predicted, exceeded: true, reason: 'chars' };
        if (Number.isFinite(limit.bytes) && predicted.predictedBytes > Number(limit.bytes)) return { ...predicted, exceeded: true, reason: 'bytes' };
    }
    return predicted;
}

/**
 * 造写入器。
 *
 * @param {{
 *   store?: any,
 *   resolveStore?: () => Promise<any | null>,
 *   storeScopeMap?: Record<string, string>,
 *   supersededFile?: string,
 *   wouldWriteFile?: string,
 *   mode?: string,
 *   resolveMode?: () => string,
 *   supersedeOnUpdate?: boolean,
 *   resolveSupersedeOnUpdate?: () => boolean,
 *   now?: number,
 * }} [options]
 *   `resolveMode`：现取生效档位（`index.js` 传 `() => resolveMode(config)`，配置改了下一轮就生效）；
 *   `mode` 只给单测用。两者都没有 ⇒ `auto`（= 改造前的行为，一字不改）。
 *   `resolveSupersedeOnUpdate`：现取「改写走不走失效标记」开关（设置页关掉下一轮生效）；
 *   `supersedeOnUpdate` 只给单测用。两者都没有 ⇒ 开（老 store 自动回落替换）。
 * @returns {{
 *   apply: (ops: any[], context?: { cwd?: string, workspaceId?: string, dryRun?: boolean, mode?: string, layer?: number, runId?: string }) => Promise<{
 *     results: any[], counts: Record<string, number>, watermarks: Record<string, any>,
 *     wouldWrite: { file: string, lines: number, failed: number } | null,
 *   }>,
 * }}
 */
export function createWriter(options = {}) {
    const scopeMap = options.storeScopeMap ?? STORE_SCOPE_MAP;
    const supersededFile = options.supersededFile ?? supersededPath();
    const resolveStore = typeof options.resolveStore === 'function'
        ? options.resolveStore
        : () => Promise.resolve(options.store ?? null);

    const reader = async () => {
        if (options.store !== undefined && options.store !== null) return options.store;
        try {
            return (await resolveStore()) ?? null;
        } catch {
            return null;
        }
    };

    /** 读水位（主插件 0.7.0 有则记，没有就空）。 */
    const watermark = async (store, workspaceCwd) => {
        if (typeof store?.watermark !== 'function') return {};
        const marks = {};
        for (const [name, scope] of [['fact', 'fact'], ['memory', 'memory']]) {
            try {
                const mark = await store.watermark(scope, { cwd: workspaceCwd });
                if (mark !== null && typeof mark === 'object') marks[name] = mark;
            } catch {
                /* 水位是观测，失败就算了 */
            }
        }
        return marks;
    };

    /**
     * 生效档位：`context.mode`（管线显式传）→ `options.resolveMode()`（运行时 config）→
     * `options.mode`（单测）。全部拿不到就是 `auto`。
     */
    const modeOf = (context) => {
        const explicit = normalizeMode(context?.mode);
        if (explicit !== null) return explicit;
        if (typeof options.resolveMode === 'function') {
            try {
                const resolved = normalizeMode(options.resolveMode());
                if (resolved !== null) return resolved;
            } catch {
                /* 取档位炸了：按 auto 走，不因此静默也不因此误写 */
            }
        }
        return normalizeMode(options.mode) ?? MODE.AUTO;
    };

    /**
     * 改写是否走「先新增、后标记失效」的两段式（DESIGN §6）。
     *
     * 默认开：主插件 0.10+ 才有 `store.supersedeEntry`，老 store 会自动回落原子替换。
     * 单测用 `options.supersedeOnUpdate`（布尔）直接钉住；运行时用
     * `options.resolveSupersedeOnUpdate()` 现取 config（设置页关掉下一轮立刻生效）。
     */
    const supersedeEnabled = () => {
        if (typeof options.resolveSupersedeOnUpdate === 'function') {
            try {
                return options.resolveSupersedeOnUpdate() !== false;
            } catch {
                /* 取开关炸了：按默认开走，但下面还会 `typeof store.supersedeEntry` 兜底 */
            }
        }
        return options.supersedeOnUpdate !== false;
    };

    const apply = async (ops = [], context = {}) => {
        const results = [];
        const counts = { written: 0, replaced: 0, deleted: 0, demoted: 0, dropped: 0, noop: 0, dry: 0, failed: 0, observed: 0 };
        const watermarks = {};
        const store = await reader();
        const now = Number.isFinite(context.now) ? context.now : Date.now();
        // 影子模式：`dryRun` 是一个更强的一次性开关（`/memory-consolidate dry`），
        // 两者同时为真时按 dryRun 走 —— 老行为优先，且 dry 只出报告不落影子文件。
        const observe = modeOf(context) === MODE.OBSERVE && context.dryRun !== true;
        const runId = typeof context.runId === 'string' ? context.runId : '';
        const workspaceId = String(context.workspaceId ?? '');
        let wouldWrite = observe ? { file: '', lines: 0, failed: 0 } : null;
        /** 影子模式下的水位缓存（同一个 scope 一次运行只读一次）。 */
        const markCache = new Map();

        const record = (op, status, reason, extra = {}) => {
            results.push({ op: op.op, target: op.target ?? '', scope: op.scope ?? '', status, reason, content: op.content ?? '', ...extra });
            if (String(status).startsWith(WOULD_PREFIX)) {
                // 影子结果只进 observed 计数：**绝不算进 written / replaced / demoted**。
                counts.observed += 1;
                return;
            }
            const key = status === WRITE_STATUS.WRITTEN ? 'written' : status;
            if (counts[key] !== undefined) counts[key] += 1;
        };

        /** 影子模式下读一次水位（拿不到就 null，预判会标 known:false）。 */
        const markOf = async (storeScope) => {
            if (markCache.has(storeScope)) return markCache.get(storeScope);
            let mark = null;
            if (typeof store?.watermark === 'function') {
                try {
                    mark = await store.watermark(storeScope, { cwd: context.cwd });
                } catch {
                    mark = null;
                }
            }
            markCache.set(storeScope, mark ?? null);
            return mark ?? null;
        };

        /**
         * 落一行影子记录。失败时记 FAIL（并让 counts.failed 加一，pipeline 会据此把整次
         * 运行标成 FAIL）——**绝不假装成功**。
         */
        const shadow = async (op, status, reason, extra = {}) => {
            const file = options.wouldWriteFile ?? wouldWritePath(now);
            // 每行都带 `budget`：拿不到水位时它是 `{known:false}`，比缺字段更容易被代码消费
            // （「没有预判」与「预判不撞限」是两件事，不能靠字段存在与否区分）。
            const budget = extra.budget ?? predictBudget(null, { storeScope: extra.storeScope });
            const line = {
                ts: now,
                runId,
                workspaceId,
                layer: Number.isFinite(extra.layer) ? extra.layer : (Number.isFinite(op.layer) ? op.layer : 1),
                scope: String(op.scope ?? ''),
                storeScope: String(extra.storeScope ?? ''),
                op: String(op.op ?? ''),
                target: String(op.target ?? ''),
                content: String(op.content ?? ''),
                status,
                reason: String(reason ?? ''),
                confidence: String(op.confidence ?? ''),
                budget,
            };
            if (wouldWrite === null) wouldWrite = { file, lines: 0, failed: 0 };
            wouldWrite.file = file;
            if (!appendWouldWrite(line, { file })) {
                wouldWrite.failed += 1;
                record(op, WRITE_STATUS.FAILED, 'would-write-failed');
                return false;
            }
            wouldWrite.lines += 1;
            record(op, status, reason, { budget });
            return true;
        };

        /** 降级写 JOURNAL：一次，不重试（§7.4 ③）。 */
        const demote = async (op, reason) => {
            if (typeof store?.appendJournal !== 'function') {
                record(op, WRITE_STATUS.DROPPED, `${reason}:no-journal-api`);
                return;
            }
            if (context.dryRun === true) {
                record(op, WRITE_STATUS.DRY, `${reason}:would-demote`);
                return;
            }
            try {
                await store.appendJournal(op.content, ['consolidate', 'demoted']);
                record(op, WRITE_STATUS.DEMOTED, reason);
            } catch {
                record(op, WRITE_STATUS.FAILED, `${reason}:append-failed`);
            }
        };

        /**
         * store 明确降级时的落账（P0-2）。
         *
         *  - `demoted:'journal'`（或老契约 `demoted:true`）⇒ **真的写一次 JOURNAL**，记 DEMOTED；
         *    这是「内容还有价值，只是进不了 FACT/MEMORY」，算写成（不算 failed，行可以消费）。
         *  - `demoted:'drop'` ⇒ 一个字都没写，记 **FAILED** 并带上 store 的 `reason`；
         *    绝不能像旧实现那样记成 `written`（那会让 pipeline 消费掉回合、结论却不存在）。
         *
         * @param {Record<string, any>} op
         * @param {any} result `insertEntry` / `replaceEntry` 的返回
         */
        const handleDemoted = async (op, result) => {
            const how = demoteTargetOf(result);
            const why = String(result?.reason ?? 'store-demoted');
            if (how === 'drop') {
                record(op, WRITE_STATUS.FAILED, `store-rejected:${why}`);
                return;
            }
            await demote(op, `store-demoted:${why}`);
        };

        if (store === null || store === undefined) {
            // 每行都记一条，别让「本来会写什么」因为 store 不可用而整块消失。
            for (const op of ops) {
                if (observe && op !== null && typeof op === 'object') {
                    await shadow(op, WRITE_STATUS.WOULD_DROPPED, 'store-unavailable');
                    continue;
                }
                record(op, WRITE_STATUS.DROPPED, 'store-unavailable');
            }
            return { results, counts, watermarks, wouldWrite };
        }

        if (typeof store.watermark === 'function') {
            Object.assign(watermarks, await watermark(store, context.cwd));
        }

        /**
         * 影子模式下一个算子的判定：**只读、不写**。
         *
         * ADD（及未知算子）走 `store.assertEntry` 闸口预演 —— 主插件那个薄包装会真的
         * 预演落位并卡上限，所以「本来会撞限」和「本来会被打码/模板拒掉」都能提前看到；
         * UPDATE / DELETE 没有可预演的只读接口（`replaceEntry` / `deleteEntry` 会真写），
         * 只能靠水位预判，标 `reason: unverified` 让人知道这一条不如 ADD 可信。
         */
        const shadowOp = async (op, storeScope) => {
            const content = String(op.content ?? '');
            const charDelta = content.length + 2; // 粗略：条目前的 "- " 与换行
            const byteDelta = Buffer.byteLength(content, 'utf8');
            const mark = await markOf(storeScope);

            if (op.op === 'DELETE') {
                await shadow(op, WRITE_STATUS.WOULD_DELETED, 'unverified', {
                    storeScope,
                    budget: predictBudget(mark, { storeScope, lineDelta: -1, charDelta: 0, byteDelta: 0 }),
                });
                return;
            }
            if (op.op === 'UPDATE') {
                await shadow(op, WRITE_STATUS.WOULD_REPLACED, 'unverified', {
                    storeScope,
                    budget: predictBudget(mark, { storeScope, lineDelta: 0, charDelta, byteDelta }),
                });
                return;
            }

            if (typeof store.assertEntry !== 'function') {
                await shadow(op, WRITE_STATUS.WOULD_WRITTEN, 'unverified', {
                    storeScope,
                    budget: predictBudget(mark, { storeScope, lineDelta: 1, charDelta, byteDelta }),
                });
                return;
            }

            try {
                await store.assertEntry(storeScope, op.content, { cwd: context.cwd });
                await shadow(op, WRITE_STATUS.WOULD_WRITTEN, 'ok', {
                    storeScope,
                    budget: predictBudget(mark, { storeScope, lineDelta: 1, charDelta, byteDelta, authoritative: true }),
                });
            } catch (error) {
                if (isBudgetExceeded(error)) {
                    Object.assign(watermarks, await watermark(store, context.cwd));
                    await shadow(op, WRITE_STATUS.WOULD_DEMOTED, 'budget-exceeded', {
                        storeScope,
                        budget: { ...predictBudget(mark, { storeScope, lineDelta: 1, charDelta, byteDelta, authoritative: true }), exceeded: true, reason: 'assert-entry' },
                    });
                    return;
                }
                const rejected = error?.code === 'MEMORY_ENTRY_REJECTED' || error?.name === 'MEMORY_ENTRY_REJECTED';
                if (rejected) {
                    // 主插件的 reject 会带 `demote`：journal ⇒ 真跑时降级写 JOURNAL，否则整条丢弃。
                    const demoteTo = String(error?.details?.demote ?? '');
                    await shadow(
                        op,
                        demoteTo === 'journal' ? WRITE_STATUS.WOULD_DEMOTED : WRITE_STATUS.WOULD_DROPPED,
                        String(error?.details?.reason ?? 'entry-rejected'),
                        { storeScope, budget: predictBudget(mark, { storeScope, lineDelta: 0, charDelta: 0, byteDelta: 0, authoritative: true }) },
                    );
                    return;
                }
                await shadow(op, WRITE_STATUS.WOULD_FAILED, String(error?.code ?? 'error'), {
                    storeScope,
                    budget: predictBudget(mark, { storeScope, lineDelta: 0, charDelta: 0, byteDelta: 0, authoritative: true }),
                });
            }
        };

        for (const op of ops) {
            if (op === null || typeof op !== 'object' || op.content === undefined) {
                continue;
            }
            if (op.op === 'NOOP') {
                if (observe) await shadow(op, WRITE_STATUS.WOULD_NOOP, op.reason ?? 'noop');
                else record(op, WRITE_STATUS.NOOP, op.reason ?? 'noop');
                continue;
            }
            if (op.scope === 'journal') {
                // journal 类结论直接进 JOURNAL（不进 FACT/MEMORY，不需要闸口）。
                if (context.dryRun === true) {
                    record(op, WRITE_STATUS.DRY, 'would-journal');
                    continue;
                }
                if (observe) {
                    await shadow(op, WRITE_STATUS.WOULD_JOURNAL, 'journal', { storeScope: 'journal' });
                    continue;
                }
                try {
                    await store.appendJournal(op.content, ['consolidate', op.layer === 2 ? 'layer2' : 'layer1']);
                    record(op, WRITE_STATUS.WRITTEN, 'journal');
                } catch {
                    record(op, WRITE_STATUS.FAILED, 'journal-failed');
                }
                continue;
            }

            const storeScope = toStoreScope(op.scope, scopeMap);
            if (storeScope === '') {
                if (observe) await shadow(op, WRITE_STATUS.WOULD_DROPPED, 'bad-scope');
                else record(op, WRITE_STATUS.DROPPED, 'bad-scope');
                continue;
            }
            if (context.dryRun === true) {
                record(op, WRITE_STATUS.DRY, `would-${String(op.op).toLowerCase()}`);
                continue;
            }
            if (observe) {
                await shadowOp(op, storeScope);
                continue;
            }

            try {
                if (op.op === 'DELETE') {
                    if (typeof store.deleteEntry !== 'function') {
                        record(op, WRITE_STATUS.DROPPED, 'no-delete-api');
                        continue;
                    }
                    const result = await store.deleteEntry(storeScope, op.target);
                    if (result?.deleted === false || result?.deleted === undefined) {
                        record(op, WRITE_STATUS.NOOP, 'not-found');
                        continue;
                    }
                    record(op, WRITE_STATUS.DELETED, 'ok');
                    if (op.superseded !== undefined) {
                        appendSuperseded({ ts: now, workspaceId: context.workspaceId, scope: op.scope, old: op.superseded.text, new: '', reason: 'delete' }, { file: supersededFile });
                    }
                    continue;
                }

                if (op.op === 'UPDATE') {
                    /*
                     * 两段式失效（DESIGN §6）：**先**把新正文写进去，成功后才给旧条目打
                     * `status=superseded` 标记。顺序反过来（先标记再写）会出现「旧条目
                     * 失效了、新条目没写进去」——那是不可恢复的数据丢失。
                     *
                     * `updateBySupersede()` 返回 false 表示「两段式不成立/没写成」，
                     * 这时才退回改造前的原子替换 `replaceEntry`。
                     */
                    if (await updateBySupersede(op, storeScope)) continue;
                    if (typeof store.replaceEntry !== 'function') {
                        record(op, WRITE_STATUS.DROPPED, 'no-replace-api');
                        continue;
                    }
                    const result = await store.replaceEntry(storeScope, op.target, entryOf(op), { cwd: context.cwd });
                    if (isNotFound(result)) {
                        // 找不到 ⇒ 降级 ADD（§7.3 定位方式初版），并在 runlog 里记下原因。
                        await insert(op, { reason: 'replace-not-found' });
                        continue;
                    }
                    if (isDemoted(result)) {
                        await handleDemoted(op, result);
                        continue;
                    }
                    record(op, WRITE_STATUS.REPLACED, 'ok', { target: result?.target ?? op.target });
                    if (op.superseded !== undefined) {
                        appendSuperseded({
                            ts: now,
                            workspaceId: context.workspaceId,
                            scope: op.scope,
                            old: op.superseded.text,
                            new: op.content,
                            reason: 'update',
                        }, { file: supersededFile });
                    }
                    continue;
                }

                // ADD（以及任何未知算子：按 ADD 处理，绝不当 UPDATE/DELETE 乱改）
                await insert(op, { reason: op.reason ?? 'ok' });
            } catch (error) {
                if (isBudgetExceeded(error)) {
                    const mark = await watermark(store, context.cwd);
                    Object.assign(watermarks, mark);
                    await demote(op, 'budget-exceeded');
                    continue;
                }
                // 带上真实错误码 / 拒绝原因：只写 'error' 等于把「为什么没写」扔掉
                // （P0-2 分支 2 的排查就是卡在这里）。
                record(op, WRITE_STATUS.FAILED, String(error?.code ?? error?.details?.reason ?? 'error'));
            }
        }

        /**
         * UPDATE 的两段式失效（DESIGN §6）。
         *
         * 成功路径：`insertEntry` 写新正文 → `supersedeEntry` 给旧条目打失效标记
         * （`by` = 新条目的 contentId）→ 记 REPLACED。旧正文仍留在文件里（只加注释），
         * 审计可恢复；`superseded.jsonl` 照旧记一份。
         *
         * @returns {Promise<boolean>} true = 这条已经处理完（记过结果）；
         *   false = 两段式不成立或第一步没写成，调用方应退回 `replaceEntry`。
         */
        async function updateBySupersede(op, storeScope) {
            /*
             * 前置条件（任一不成立就退回原子替换）：
             *  - 开关关 / store 没有 `supersedeEntry`（主插件 < 0.10、假 store）；
             *  - 拿不到旧正文（`op.superseded.text`）⇒ 无法证明「新旧不同」，
             *    无法审计被取代的是什么，宁可用更保守的替换；
             *  - 新旧正文相同 ⇒ 根本不需要改（替换一次即可，省字符也省一条 id）。
             */
            const oldText = typeof op.superseded?.text === 'string' ? op.superseded.text : '';
            const newText = String(op.content ?? '');
            if (supersedeEnabled() !== true) return false;
            if (typeof store.supersedeEntry !== 'function' || typeof store.insertEntry !== 'function') return false;
            if (String(op.target ?? '') === '') return false;
            if (oldText === '' || newText.trim() === '' || newText.trim() === oldText.trim()) return false;

            /* ── ① 先把新条目写进去（与 `insert()` 同一套闸口 / 降级口径）── */
            if (typeof store.assertEntry === 'function') {
                try {
                    await store.assertEntry(storeScope, newText, { cwd: context.cwd });
                } catch (error) {
                    if (isBudgetExceeded(error)) {
                        Object.assign(watermarks, await watermark(store, context.cwd));
                        await demote(op, 'budget-exceeded');
                        return true; // 已降级写 JOURNAL：旧条目保持 active，绝不标记失效
                    }
                    return false; // 非撞限的闸口拒绝 ⇒ 交给 replaceEntry 走旧路径
                }
            }

            let inserted;
            try {
                inserted = await store.insertEntry(storeScope, entryOf(op), { cwd: context.cwd });
            } catch (error) {
                if (isBudgetExceeded(error)) {
                    Object.assign(watermarks, await watermark(store, context.cwd));
                    await demote(op, 'budget-exceeded');
                    return true;
                }
                // 写异常：旧条目此刻仍是 active（没有半截状态），退回替换再试一次。
                return false;
            }
            if (isDemoted(inserted)) {
                /*
                 * store 明确降级：
                 *  - `journal` ⇒ 内容已经落进 JOURNAL，再走一次 replaceEntry 会重复写，
                 *    到此为止（记 DEMOTED，旧条目不动）；
                 *  - `drop` ⇒ 一个字没写，退回 replaceEntry 让旧条目至少有机会被更新
                 *    （这也是契约里「任一步失败回退替换」的兜底）。
                 */
                if (demoteTargetOf(inserted) === 'drop') return false;
                await handleDemoted(op, inserted);
                return true;
            }
            if (inserted?.written === false) return false; // 没写成 ⇒ 旧条目绝不能标记失效

            /* ── ② 新条目已经在了，才允许给旧条目打失效标记 ── */
            // 契约 §6：`by` 写**新条目的 contentId**（`store.entryId('', text)`，与池 / 索引 id
            // 同源）。主插件 `insertEntry` 回的是带 firstSeen 的索引 id，不是 contentId，
            // 所以优先自己算；只有 store 没给 entryId 时才退回插入返回值。
            const contentId = typeof store.entryId === 'function' ? String(store.entryId('', newText)) : '';
            const newId = contentId !== '' ? contentId : String(inserted?.id ?? '');
            try {
                const supersededResult = await store.supersedeEntry(storeScope, { id: op.target }, {
                    cwd: context.cwd,
                    by: newId,
                    at: now,
                });
                // 契约：`{ok:true,...}` 或 `{ok:false, reason}`。拿不到明确成功就当失败。
                if (supersededResult !== null && typeof supersededResult === 'object' && supersededResult.ok === false) {
                    const refusal = new Error(String(supersededResult.reason ?? 'supersede-failed'));
                    refusal.code = String(supersededResult.reason ?? 'supersede-failed');
                    throw refusal;
                }
            } catch (error) {
                /*
                 * 第二步失败：新条目已写进去、旧条目仍是 active ⇒ 没有数据丢失，只是暂时
                 * 重复。按契约回退 `replaceEntry`（原子替换），**先替换再清理**：
                 * 顺序反过来（先删刚写的那条）一旦旧目标也找不到，内容就两头落空了。
                 * 替换成功后把多写的那条尽力删掉，让文件里只剩一份新正文。
                 */
                const code = codeOf(error, 'supersede-failed');
                if (typeof store.replaceEntry !== 'function') {
                    record(op, WRITE_STATUS.FAILED, `supersede-failed:${code}`);
                    return true;
                }
                let replaced;
                try {
                    replaced = await store.replaceEntry(storeScope, op.target, entryOf(op), { cwd: context.cwd });
                } catch (replaceError) {
                    // 替换也失败：新条目至少已在文件里（内容不丢），两面都记下来。
                    record(op, WRITE_STATUS.FAILED, `supersede-failed:${code}|replace:${codeOf(replaceError, 'error')}`);
                    return true;
                }
                if (isNotFound(replaced)) {
                    // 旧条目已不在（可能被人工改掉）：刚写的新条目就是结果，别再插一条。
                    record(op, WRITE_STATUS.WRITTEN, `supersede-fallback:${code}:target-gone`, { target: newId });
                    return true;
                }
                if (isDemoted(replaced)) {
                    await handleDemoted(op, replaced);
                    return true;
                }
                if (newId !== '' && typeof store.deleteEntry === 'function') {
                    try {
                        await store.deleteEntry(storeScope, newId);
                    } catch {
                        /* 撤不掉就留着：重复一条好过丢内容，但绝不记成失败（替换已经成功） */
                    }
                }
                record(op, WRITE_STATUS.REPLACED, `supersede-fallback:${code}`, { target: replaced?.target ?? op.target });
                if (op.superseded !== undefined) {
                    appendSuperseded({
                        ts: now,
                        workspaceId: context.workspaceId,
                        scope: op.scope,
                        old: op.superseded.text,
                        new: op.content,
                        reason: 'update',
                    }, { file: supersededFile });
                }
                return true;
            }

            record(op, WRITE_STATUS.REPLACED, 'supersede', { target: newId || op.target });
            if (op.superseded !== undefined) {
                appendSuperseded({
                    ts: now,
                    workspaceId: context.workspaceId,
                    scope: op.scope,
                    old: op.superseded.text,
                    new: op.content,
                    reason: 'update',
                }, { file: supersededFile });
            }
            return true;
        }

        async function insert(op, extra = {}) {
            if (typeof store.insertEntry !== 'function') {
                record(op, WRITE_STATUS.DROPPED, 'no-insert-api');
                return;
            }
            // 先过闸口薄包装（若主插件提供）：撞限时连插入都不尝试，直接降级。
            if (typeof store.assertEntry === 'function') {
                try {
                    await store.assertEntry(toStoreScope(op.scope, scopeMap), op.content, { cwd: context.cwd });
                } catch (error) {
                    if (isBudgetExceeded(error)) {
                        const mark = await watermark(store, context.cwd);
                        Object.assign(watermarks, mark);
                        await demote(op, 'budget-exceeded');
                        return;
                    }
                    throw error;
                }
            }
            const result = await store.insertEntry(toStoreScope(op.scope, scopeMap), entryOf(op), { cwd: context.cwd });
            if (isDemoted(result)) {
                // store 明确降级：'journal' ⇒ 我们补写一次 JOURNAL；'drop' ⇒ 记 FAILED（一个字没写）。
                await handleDemoted(op, result);
                return;
            }
            if (result?.written === false) {
                // 既没降级、也没写成（例如主插件拿不到项目根）⇒ **绝不算 written**（P0-2 分支 1）。
                record(op, WRITE_STATUS.FAILED, `store-not-written:${String(result?.reason ?? 'unknown')}`);
                return;
            }
            record(op, WRITE_STATUS.WRITTEN, extra.reason ?? 'ok', { target: result?.target ?? '' });
        }

        return { results, counts, watermarks, wouldWrite };
    };

    return { apply };
}

/**
 * store 条目形状：本插件只带这三个字段（模板与格式归主插件）。
 *
 * ⚠️ 字段名必须是 `text` 而不是 `content`：主插件 `store.insertEntry` /
 * `replaceEntry` / `validateEntry` 内部一律走 `normalizeEntryInput()`，只读
 * `entry.text`（`{text, confidence, workspaceId, section}`），传 `content` 会被当成
 * 空条目 ⇒ 写入静默落空（M1 修掉的 A0 缺陷，`test/writer.test.mjs` 用假 store 钉住）。
 */
function entryOf(op) {
    return {
        text: op.content,
        confidence: op.confidence ?? 'medium',
        ts: op.ts,
    };
}

/** runlog 状态常量再导出一次，省得调用方到处 import。 */
export { STATUS };
