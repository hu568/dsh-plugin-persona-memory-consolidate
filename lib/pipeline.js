/**
 * L1 单次闭环：L0 暂存 → 门槛 → 抽取（1 次 LLM）→ 归并 → 写入 → 标记消费（02 §3 L1 / §6.2 / §7.2–§7.4）。
 *
 * 一次 `runL1` 做且只做**一个工作区桶**的沉淀；`runAllBuckets` 逐桶循环并只占**一次**
 * 全局单飞锁（02 §6.5 规矩 3：全局并发 = 1，不能每个桶再抢一次）。
 *
 * 成本纪律（02 §7.5）：
 *  - **正常是 1 次调用**（抽取 + 裁决同一份 prompt 的原始设计）；
 *  - 例外是**最多 2 次**：某个候选落在归一化相似度 `[0.45, 0.95)` 时需要一次裁决，
 *    而「同一次调用」在事实顺序上不可能实现（要先抽取才知道有哪些候选、要检索才知道
 *    该带哪几条旧条目进 prompt）。所以这里**认账**：真的发了两次就在 runlog / 返回值
 *    的 `calls` 里写 2，绝不假装一次（M3 再考虑把「抽取 + 裁决」合并成真正的单趟）。
 *
 * 数据纪律：
 *  - 所有文件系统写入都在 `$DSH_HOME/memory/consolidate/` 下（pending / backups / runlog）；
 *    FACT.md / JOURNAL.jsonl / MEMORY.md **只经主插件 store** 写，本模块不碰；
 *  - 唯一例外是 `rollbackRun`：它把 `backups/<runId>/` 的快照**恢复**回原路径（含项目
 *    `MEMORY.md`），这是回滚的定义，也是 02 §7.7「项目目录里只可能改 MEMORY.md」的唯一豁免。
 *
 * 失败语义：
 *  - 抽取非法 JSON / 归并失败 / 写入失败 ⇒ **不标记消费、不推进游标**（下次重跑，靠
 *    抽取 prompt 的「已在记忆里的不重复写」+ 模板闸口保幂等），runlog 记 FAIL；
 *  - `dryRun` ⇒ 管线照跑（抽取、归并、校验都真的执行），writer 对每条只记 `DRY`，
 *    行保持未消费、快照也不建。
 *  - `mode: observe`（影子模式）⇒ 管线同样真跑（真调 LLM、真打码、真校验），writer 只把
 *    「本来会写什么」落进 `would-write/<日期>.jsonl`，不写 FACT / MEMORY / JOURNAL。
 *    **内部记账与 auto 完全一致**：暂存行照常 `markConsumed` + 归档、游标照常推进、预算照常扣
 *    —— 只有这样「同一批素材」才不会被反复采样、反复烧 LLM；代价是观察期被消费的素材在切到
 *    auto 后不会补写（这是有意的，见 README「影子模式」）。
 *    唯一不做的副作用是**记忆文件快照**：一个字节都没写，快照只会堆垃圾、也没法回滚。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { PHASE_LAYER1 } from './budget.js';
import { backupsDir, cursorPath, pendingDir as defaultPendingDir, readCursor, setSessionCursor, writeCursor } from './cursor.js';
import { buildConversation } from './extractor.js';
import { mergeCandidates, parseFactEntries, parseMemoryEntries } from './merger.js';
import { MODE, resolveMode } from './mode.js';
import * as pending from './pending.js';
import { STATUS } from './runlog.js';
import { listPendingBuckets } from './sources.js';
import { decideConsume } from './trigger.js';
import { bucketInfo, loadRegistry } from './workspace.js';

/** 快照文件名：与目标同名，回滚时一眼能对上（02 §9 M4「回滚后 SHA256 一致」）。 */
export const SNAPSHOT_NAMES = { fact: 'FACT.md', journal: 'JOURNAL.jsonl', memory: 'MEMORY.md' };
/** 快照清单：记录「备份里的这份文件原本在哪」，回滚靠它还原。 */
export const MANIFEST_FILE = 'manifest.json';
/** 保留多少份运行快照（02 §9 M4：保留 10 份）。 */
export const DEFAULT_KEEP_BACKUPS = 10;

/**
 * 生效的 `dryRun`：**显式参数 → config.dryRun → 默认干跑**。
 *
 * 为什么「没传就当 config 说了算」：`dryRun` 默认 true 是这条管线的安全网
 * （00 §5.1「附属插件默认 dryRun: true → 只出报告不落盘」）。如果调用方忘了传，
 * 默认值必须是「不写盘」而不是「写盘」——否则一次手误就能改到 FACT.md。
 *
 * @param {boolean | undefined} explicit
 * @param {Record<string, any>} config
 * @returns {boolean}
 */
export function resolveDryRun(explicit, config = {}) {
    if (explicit === true) return true;
    if (explicit === false) return false;
    return config.dryRun !== false;
}

/** 空计数（返回值与 runlog 共用的形状）。 */
function emptyCounts() {
    // `observed`：影子档「本来会写」的算子数（不是真实写入数，别混进 written）。
    return { candidates: 0, ops: 0, written: 0, replaced: 0, deleted: 0, demoted: 0, dropped: 0, noop: 0, dry: 0, failed: 0, observed: 0 };
}

/** 运行 id：`run-<本地时间戳>-<3 位随机>`；runlog 与 `backups/<runId>/` 用它对齐。 */
export function makeRunId(now = Date.now()) {
    const date = new Date(now);
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`;
    const salt = Math.random().toString(16).slice(2, 5);
    return `run-${stamp}-${salt}`;
}

/** 原子写文本（临时文件 + rename）。 */
function writeTextAtomic(file, text) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
    return true;
}

/** 读文本（不存在 ⇒ null，**不抛**）。 */
function readTextSafe(file) {
    try {
        return readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

/* ────────────────────────────── 快照与回滚 ────────────────────────────── */

/** 项目 `MEMORY.md` 的绝对路径（store 的两种口径都试；拿不到 ⇒ 空串）。 */
function projectMemoryPathOf(store, cwd) {
    if (typeof store?.findProjectMemory === 'function') {
        try {
            const found = store.findProjectMemory(cwd);
            if (found !== null && typeof found?.path === 'string' && found.path !== '') return found.path;
        } catch {
            /* 落到下一种口径 */
        }
    }
    if (typeof store?.watermark === 'function') {
        try {
            const mark = store.watermark('memory', { cwd });
            if (typeof mark?.path === 'string' && mark.path !== '') return mark.path;
        } catch {
            /* 没有水位接口就只备份 FACT / JOURNAL */
        }
    }
    return '';
}

/** 只保留最近 `keep` 份快照（按目录 mtime，`current` 与它自己永不被删）。 */
function pruneBackups(root, keep, current) {
    let entries;
    try {
        entries = readdirSync(root, { withFileTypes: true });
    } catch {
        return [];
    }
    const dirs = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
            const full = join(root, entry.name);
            let at = 0;
            try {
                at = statSync(full).mtimeMs;
            } catch {
                at = 0;
            }
            return { name: entry.name, full, at };
        })
        .sort((left, right) => right.at - left.at);

    const removed = [];
    dirs.forEach((dir, index) => {
        if (index < keep || dir.full === current) return;
        try {
            rmSync(dir.full, { recursive: true, force: true });
            removed.push(dir.full);
        } catch {
            /* 删不掉就算了：观测手段不该把运行弄挂 */
        }
    });
    return removed;
}

/**
 * 跑前快照：把这次可能改到的三个文件复制进 `consolidate/backups/<runId>/`。
 *
 * 为什么要快照（00 §9 审计 P1「回滚按 runId 但没有 per-run 备份」）：主插件 store 自己也备份，
 * 但它的备份是**按文件 + 时间戳**平的，无法回答「这次运行改了哪些文件」；
 * 回滚需要一个以 run 为单位的切片。
 *
 * `dryRun` 一律跳过：干跑不改文件，建快照只会堆垃圾。
 *
 * @param {{
 *   runId: string,
 *   store: any,
 *   cwd?: string,
 *   dir?: string,
 *   dryRun?: boolean,
 *   keep?: number,
 *   now?: number,
 * }} input
 * @returns {{ dir: string, copied: string[], manifest: Record<string, any>, skipped?: string }}
 */
export function snapshotFiles(input = {}) {
    const { runId, store } = input;
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    const empty = { dir: '', copied: [], manifest: {} };

    if (input.dryRun === true) return { ...empty, skipped: 'dry-run' };
    if (typeof runId !== 'string' || runId.trim() === '') return { ...empty, skipped: 'no-run-id' };
    if (store === null || store === undefined || typeof store.readText !== 'function') {
        return { ...empty, skipped: 'no-store' };
    }

    const dir = input.dir ?? join(backupsDir(), runId);
    const candidates = [];
    if (typeof store.factPath === 'function') {
        try {
            candidates.push({ name: SNAPSHOT_NAMES.fact, source: store.factPath() });
        } catch {
            /* 拿不到路径就不备份这一份 */
        }
    }
    if (typeof store.journalPath === 'function') {
        try {
            candidates.push({ name: SNAPSHOT_NAMES.journal, source: store.journalPath() });
        } catch {
            /* 同上 */
        }
    }
    const memoryPath = projectMemoryPathOf(store, input.cwd);
    if (memoryPath !== '') candidates.push({ name: SNAPSHOT_NAMES.memory, source: memoryPath });

    const manifest = {};
    const copied = [];
    for (const candidate of candidates) {
        if (typeof candidate.source !== 'string' || candidate.source === '') continue;
        let text;
        try {
            text = store.readText(candidate.source);
        } catch {
            text = null;
        }
        // 文件不存在（首次运行）⇒ 不写空壳进快照，回滚时也就不会把「不存在」变成「空文件」。
        if (typeof text !== 'string') continue;
        const target = join(dir, candidate.name);
        try {
            writeTextAtomic(target, text);
        } catch {
            continue;
        }
        // `source` = 原本的位置（回滚要写回这里），`backup` = 快照文件本身。
        manifest[candidate.name] = { source: candidate.source, backup: target, bytes: Buffer.byteLength(text, 'utf8') };
        copied.push(target);
    }

    if (copied.length === 0) return { dir: '', copied: [], manifest: {}, skipped: 'nothing-to-copy' };

    writeTextAtomic(join(dir, MANIFEST_FILE), `${JSON.stringify({ runId, createdAt: now, files: manifest }, null, 2)}\n`);
    pruneBackups(backupsDir(), Number.isFinite(input.keep) ? Math.max(1, input.keep) : DEFAULT_KEEP_BACKUPS, dir);
    return { dir, copied, manifest };
}

/** 列出所有快照（最新在前）。 */
export function listBackups(root = backupsDir()) {
    let entries;
    try {
        entries = readdirSync(root, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
            const full = join(root, entry.name);
            let at = 0;
            try {
                at = statSync(full).mtimeMs;
            } catch {
                at = 0;
            }
            return { runId: entry.name, dir: full, at };
        })
        .sort((left, right) => right.at - left.at);
}

/**
 * `last` 的解析：最新的一份快照。
 *
 * @param {{ dir?: string }} [options]
 * @returns {string} runId，没有快照则空串。
 */
export function latestRunId(options = {}) {
    const backups = listBackups(options.dir ?? backupsDir());
    return backups.length === 0 ? '' : backups[0].runId;
}

/**
 * 按 runId 回滚：把快照里的三份文件写回它们原来的位置。
 *
 * **先验父目录存在**：项目可能被移走/删掉，这时宁可不恢复（并报告 skipped），
 * 也不能在 `D:\` 根上凭旧路径造一个新目录出来。
 *
 * @param {{ runId: string, runtime?: any, dir?: string }} input
 * @returns {{ runId: string, restored: string[], skipped: { target: string, reason: string }[] } | { error: string, runId?: string }}
 */
export function rollbackRun(input = {}) {
    const runId = typeof input.runId === 'string' ? input.runId.trim() : '';
    if (runId === '') return { error: 'no-run-id' };

    const root = input.dir ?? input.runtime?.backupsDir ?? backupsDir();
    const dir = join(root, runId);
    const raw = readTextSafe(join(dir, MANIFEST_FILE));
    if (raw === null) return { error: 'no-snapshot', runId };

    let manifest;
    try {
        manifest = JSON.parse(raw);
    } catch {
        return { error: 'bad-manifest', runId };
    }
    const files = manifest?.files;
    if (files === null || typeof files !== 'object') return { error: 'bad-manifest', runId };

    const restored = [];
    const skipped = [];
    for (const [name, meta] of Object.entries(files)) {
        const target = typeof meta?.source === 'string' && meta.source !== ''
            ? meta.source
            : (typeof meta?.target === 'string' ? meta.target : '');
        if (target === '') {
            skipped.push({ target: name, reason: 'no-target' });
            continue;
        }
        if (!existsSync(dirname(target))) {
            skipped.push({ target, reason: 'parent-missing' });
            continue;
        }
        const backupFile = typeof meta?.backup === 'string' && meta.backup !== '' ? meta.backup : join(dir, basename(name));
        const text = readTextSafe(backupFile);
        if (text === null) {
            skipped.push({ target, reason: 'backup-missing' });
            continue;
        }
        try {
            writeTextAtomic(target, text);
            restored.push(target);
        } catch {
            skipped.push({ target, reason: 'write-failed' });
        }
    }

    if (restored.length === 0) return { error: 'nothing-restored', runId, skipped };
    return { runId, restored, skipped };
}

/* ────────────────────────────── runL1 ────────────────────────────── */

/** 从 store 上取路径（拿不到 ⇒ 空串）。 */
function pathOf(store, method) {
    if (typeof store?.[method] !== 'function') return '';
    try {
        const value = store[method]();
        return typeof value === 'string' ? value : '';
    } catch {
        return '';
    }
}

/** 读 store 视角的文本（不存在 ⇒ 空串）。 */
function textOf(store, file) {
    if (file === '' || typeof store?.readText !== 'function') return '';
    try {
        const value = store.readText(file);
        return typeof value === 'string' ? value : '';
    } catch {
        return '';
    }
}

/** 归并池：FACT 条目 + 项目 MEMORY 条目，id 优先用 store 的口径（替换时才认得出）。 */
function buildPool(store, factText, memoryText) {
    const withStoreId = (entry) => ({
        ...entry,
        id: typeof store?.entryId === 'function' ? store.entryId('', entry.text) : entry.id,
    });
    return [...parseFactEntries(factText).map(withStoreId), ...parseMemoryEntries(memoryText).map(withStoreId)];
}

/** 本次消费的行按会话聚合出「最大回合 + 字符数」——游标用。 */
function cursorPatches(rows) {
    const map = new Map();
    for (const row of rows) {
        const session = typeof row.session === 'string' ? row.session : '';
        if (session === '') continue;
        const turn = Number.isFinite(row.turn) ? Math.trunc(row.turn) : 0;
        const chars = Number.isFinite(row.chars) ? Math.trunc(row.chars) : 0;
        const current = map.get(session) ?? { turn: 0, chars: 0 };
        map.set(session, { turn: Math.max(current.turn, turn), chars: current.chars + chars });
    }
    return map;
}

/**
 * 跑一个工作区桶的 L1。
 *
 * @param {{
 *   runtime: Record<string, any>,
 *   bucket: string | { workspaceId: string, title?: string, path?: string },
 *   dryRun?: boolean,
 *   now?: number,
 *   lock?: { token?: string },
 * }} input
 * @returns {Promise<{
 *   runId: string, bucket: string, title: string, turns: number, chars: number,
 *   candidates: number, ops: number, counts: Record<string, number>, calls: number,
 *   status?: string, skipped?: string, reason?: string, snapshot?: string,
 * }>}
 */
export async function runL1(input = {}) {
    const runtime = input.runtime ?? {};
    const config = runtime.config ?? {};
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    const dryRun = resolveDryRun(input.dryRun, config);
    // 影子档：`dry` 是一次性显式开关，优先于档位（老行为不变）。
    const observe = dryRun !== true && resolveMode(config) === MODE.OBSERVE;
    const runId = typeof input.runId === 'string' && input.runId !== '' ? input.runId : makeRunId(now);

    const bucket = typeof input.bucket === 'string' ? { workspaceId: input.bucket } : (input.bucket ?? {});
    const workspaceId = String(bucket.workspaceId ?? '');
    const title = typeof bucket.title === 'string' ? bucket.title : '';
    const cwd = typeof bucket.path === 'string' ? bucket.path : '';
    const dir = runtime.pendingDir ?? defaultPendingDir();

    const base = { runId, bucket: workspaceId, title, dryRun, mode: resolveMode(config), observe };
    const skip = (skipped, reason, extra = {}) => ({
        ...base,
        turns: 0,
        chars: 0,
        candidates: 0,
        ops: 0,
        counts: emptyCounts(),
        calls: 0,
        skipped,
        reason,
        ...extra,
    });

    /* ① 读未消费行（纯本地，读不到就跳过） */
    const rows = pending.readUnconsumed({ pendingDir: dir, bucket: workspaceId });
    const stats = pending.summarize(rows);
    if (rows.length === 0) return skip('empty', 'no-unconsumed-rows');

    /* ② 消费门槛（先到先算：≥minTurns 或 ≥minChars） */
    const verdict = decideConsume({
        pendingTurns: stats.turns,
        pendingChars: stats.chars,
        cooldownUntil: typeof runtime.budget?.cooldownUntil === 'function' ? runtime.budget.cooldownUntil() : 0,
        now,
        config,
    });
    if (verdict.consume !== true) {
        return skip('below-threshold', verdict.reason, { turns: stats.turns, chars: stats.chars });
    }

    /* 模型没接线时提前退出：不占预算、不写快照（M1 由命令触发时才会接线） */
    if (typeof runtime.extractor?.extract !== 'function') {
        const summary = skip('no-model', 'model-not-wired', { turns: stats.turns, chars: stats.chars });
        runtime.runLog?.append({ runId, phase: 'layer1', status: STATUS.FAIL, reason: 'model-not-wired', workspaceId, turns: 0, chars: 0 }, now);
        return { ...summary, status: STATUS.FAIL };
    }

    /* ③ 全局单飞 + 第一层预算（runAllBuckets 已持锁时直接复用） */
    const inheritedToken = typeof input.lock?.token === 'string' ? input.lock.token : '';
    const ownsLock = inheritedToken === '';
    let token = inheritedToken;
    if (ownsLock) {
        const started = typeof runtime.budget?.tryStart === 'function' ? runtime.budget.tryStart(PHASE_LAYER1) : { ok: true, token: '' };
        if (started.ok !== true) return skip('budget', started.reason ?? 'budget-unavailable');
        token = started.token;
    }

    let ok = false;
    try {
        const result = await execute();
        ok = result.status !== STATUS.FAIL;
        return result;
    } catch (error) {
        // 管线自己出错也绝不吞成「成功」：写 runlog 记 FAIL，行保持未消费。
        runtime.runLog?.append({ runId, phase: 'layer1', status: STATUS.FAIL, reason: String(error?.code ?? 'pipeline-error'), workspaceId, turns: 0, chars: 0 }, now);
        return { ...skip('error', String(error?.code ?? 'pipeline-error')), status: STATUS.FAIL, turns: stats.turns, chars: stats.chars };
    } finally {
        if (ownsLock && token !== '') runtime.budget?.settle?.(token, { ok, now });
    }

    /** 真正干活的那一段（放在 try/finally 里，保证预算一定被 settle）。 */
    async function execute() {
        /* ④ 取最后 maxTurnsPerCall 行（最新结论才是这轮沉淀的目标） */
        const maxTurns = Number.isFinite(config.maxTurnsPerCall) ? Math.max(1, Math.trunc(config.maxTurnsPerCall)) : 6;
        const picked = rows.slice(-maxTurns);
        const conversation = buildConversation(picked);

        /* ⑤ 解析 store + 读现有池（项目 MEMORY.md 走 cwd 定位） */
        let store = null;
        try {
            store = typeof runtime.resolveStore === 'function' ? await runtime.resolveStore() : (runtime.store ?? null);
        } catch {
            store = null;
        }
        if (store === null || store === undefined) {
            runtime.runLog?.append({ runId, phase: 'layer1', status: STATUS.FAIL, reason: 'store-unavailable', workspaceId, turns: 0, chars: 0 }, now);
            return { ...skip('store-unavailable', 'store-unavailable'), status: STATUS.FAIL };
        }

        // 抽取提示词里的「目标格式」来自主插件 —— 不在这里硬编码条目模板（00 §4.1 拍板）。
        if (typeof store.templates === 'function') {
            try {
                runtime.templatesCache = store.templates();
            } catch {
                runtime.templatesCache = null;
            }
        }
        const pool = buildPool(store, textOf(store, pathOf(store, 'factPath')), textOf(store, projectMemoryPathOf(store, cwd)));

        /* ⑥ 抽取：一次调用；非法 JSON 整次放弃（不重试、行保留） */
        let extraction;
        try {
            extraction = await runtime.extractor.extract({ conversation, scope: config.scope });
        } catch {
            extraction = { ok: false, reason: 'model-error', memories: [], ops: [], rejects: [] };
        }
        const modelCalls = extraction.reason === 'no-model' ? 0 : 1;
        if (extraction.ok !== true) {
            runtime.runLog?.append({ runId, phase: 'layer1', status: STATUS.FAIL, reason: `extract-${extraction.reason}`, workspaceId, turns: picked.length, chars: stats.chars }, now);
            return {
                ...skip('extract-failed', extraction.reason),
                turns: picked.length,
                chars: stats.chars,
                calls: modelCalls,
                status: STATUS.FAIL,
            };
        }

        const scope = config.scope === 'journal' ? 'journal' : '';
        const candidates = extraction.memories.map((memory) => ({
            content: memory.content,
            scope: scope === '' ? memory.scope : scope,
            confidence: memory.confidence ?? 'medium',
            ts: now,
        }));

        if (candidates.length === 0) {
            // 抽取成功但没结论：**不标记消费**（回合还有价值，下次门槛达标会再抽一次），
            // 也不写盘。是否该把这类回合消费掉由 M2 的自动触发策略决定（见 README「已知边界」）。
            runtime.runLog?.append({ runId, phase: 'layer1', status: STATUS.NOOP, reason: 'no-candidates', workspaceId, turns: picked.length, chars: stats.chars, calls: modelCalls }, now);
            return {
                ...skip('no-candidates', 'nothing-worth-remembering'),
                turns: picked.length,
                chars: stats.chars,
                calls: modelCalls,
                status: STATUS.NOOP,
            };
        }

        /* ⑦ 归并：预筛（纯 BM25）→ 只有落在 [0.45,0.95) 的才追加一次裁决调用 */
        let extraCalls = 0;
        const countingModel = typeof runtime.callModel === 'function'
            ? async (request) => {
                extraCalls += 1;
                return runtime.callModel(request);
            }
            : undefined;

        const merged = await mergeCandidates({
            candidates,
            pool,
            layer: 1,
            callModel: countingModel,
            provider: config.provider,
            model: config.model,
            maxOps: 8,
        });
        const calls = modelCalls + extraCalls;
        // 预算按**真实发出的调用数**记账：占锁时已经扣了 1 次（= 抽取那一次），
        // 多出来的裁决调用在这里补扣 —— 日配额 60 说的是「调用次数」，不是「运行次数」。
        if (calls > 1 && typeof runtime.budget?.charge === 'function') runtime.budget.charge(PHASE_LAYER1, calls - 1);

        if (merged.ok !== true) {
            runtime.runLog?.append({ runId, phase: 'layer1', status: STATUS.FAIL, reason: `merge-${merged.reason}`, workspaceId, turns: picked.length, chars: stats.chars, calls }, now);
            return {
                ...skip('merge-failed', merged.reason),
                turns: picked.length,
                chars: stats.chars,
                candidates: candidates.length,
                calls,
                status: STATUS.FAIL,
            };
        }

        /* ⑧ 写前快照（dryRun / observe 不建：这两档都不改记忆文件，快照只会堆垃圾）
           → 执行算子（撞限由 writer 降级 JOURNAL） */
        const snapshot = snapshotFiles({ runId, store, cwd, dryRun: dryRun === true || observe, now });
        // UPDATE 要把被覆盖的旧值交给 writer 写进 superseded.jsonl（只审计，不进
        // JOURNAL / 不进第二层）。旧值只存在于 pool 里，所以在这里按 target 取回来。
        const poolById = new Map(pool.map((entry) => [entry.id, entry]));
        const writeOps = merged.ops.map((op) => {
            if (op?.op !== 'UPDATE' || typeof op.target !== 'string' || op.target === '') return op;
            const old = poolById.get(op.target);
            return old === undefined ? op : { ...op, superseded: { id: old.id, text: old.text } };
        });
        const write = await runtime.writer.apply(writeOps, { cwd, workspaceId, dryRun, mode: observe ? MODE.OBSERVE : undefined, layer: 1, runId, now });

        const counts = { ...emptyCounts(), ...write.counts };
        counts.candidates = candidates.length;
        counts.ops = merged.ops.length;

        /* ⑨ 成功才标记消费 + 推进游标（失败/干跑不动，下次重跑；影子档与 auto 同口径） */
        let marked = { marked: 0, archived: 0, files: 0 };
        const succeeded = counts.failed === 0;
        if (dryRun !== true && succeeded && picked.length > 0) {
            marked = pending.markConsumed({
                pendingDir: dir,
                bucket: workspaceId,
                turns: picked.map((row) => ({ session: row.session, turn: row.turn })),
                now,
            });
            const cursorFile = runtime.cursorFile ?? cursorPath();
            const cursor = readCursor(cursorFile);
            for (const [session, patch] of cursorPatches(picked)) {
                setSessionCursor(cursor, workspaceId, session, { turn: patch.turn, chars: patch.chars, at: now });
            }
            writeCursor(cursor, cursorFile, now);
        }

        // 影子档：没写盘，但也不能算成功（`OK` 会被统计成「真实写入成功」）。
        const status = dryRun === true
            ? STATUS.DRY
            : (!succeeded ? STATUS.FAIL : (observe === true ? STATUS.OBSERVED : STATUS.OK));
        /* ⑩ runlog：只写结构化摘要（正文一个字都不进） */
        runtime.runLog?.append({
            runId,
            phase: 'layer1',
            status,
            reason: merged.reason === 'ok' ? (dryRun === true ? 'dry-run' : (observe === true ? 'observe' : 'ok')) : merged.reason,
            workspaceId,
            bucket: title === '' ? workspaceId : title,
            turns: picked.length,
            chars: stats.chars,
            calls,
            counts,
            watermarks: write.watermarks,
        }, now);

        return {
            ...base,
            turns: picked.length,
            chars: stats.chars,
            candidates: candidates.length,
            ops: merged.ops.length,
            counts,
            calls,
            marked,
            snapshot: snapshot.dir,
            status,
            watermarks: write.watermarks,
            wouldWrite: write.wouldWrite ?? null,
        };
    }
}

/**
 * 逐桶跑一遍 L1（02 §7.6「L2 逐桶」同款口径：桶之间**绝不聚合**）。
 *
 * 为什么全局只占一次锁：`maxConcurrent` 默认 1，若每个桶各 `tryStart` 一次，
 * 第二个桶一定拿到 `concurrency-limit` ⇒ 一次命令只能沉淀一个桶。
 *
 * @param {{ runtime: Record<string, any>, dryRun?: boolean, now?: number, runId?: string }} input
 * @returns {Promise<{
 *   runId: string, dryRun: boolean, runs: any[], skipped?: string, reason?: string,
 * }>}
 */
export async function runAllBuckets(input = {}) {
    const runtime = input.runtime ?? {};
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    const config = runtime.config ?? {};
    const dryRun = resolveDryRun(input.dryRun, config);
    const mode = resolveMode(config);
    const observe = dryRun !== true && mode === MODE.OBSERVE;
    const runId = typeof input.runId === 'string' && input.runId !== '' ? input.runId : makeRunId(now);
    const dir = runtime.pendingDir ?? defaultPendingDir();

    const registry = runtime.registry ?? loadRegistry(runtime.registryFile);
    const buckets = [];
    for (const entry of listPendingBuckets(dir)) {
        const rows = pending.readUnconsumed({ pendingDir: dir, bucket: entry.workspaceId });
        if (rows.length === 0) continue; // 空桶直接跳过，不占预算
        buckets.push(bucketInfo(registry, entry.workspaceId, { unassigned: config.unassignedBucket }));
    }
    if (buckets.length === 0) return { runId, dryRun, mode, observe, runs: [], skipped: 'empty', reason: 'no-pending-rows' };

    const started = typeof runtime.budget?.tryStart === 'function' ? runtime.budget.tryStart(PHASE_LAYER1) : { ok: true, token: '' };
    if (started.ok !== true) return { runId, dryRun, mode, observe, runs: [], skipped: 'budget', reason: started.reason };

    const runs = [];
    let ok = false;
    try {
        for (const bucket of buckets) {
            runs.push(await runL1({ runtime, bucket, dryRun, now, runId, lock: started }));
        }
        // 影子运行没写盘，「成功」口径按「没出 FAIL」；OBSERVED 不算 FAIL。
        ok = runs.every((run) => run.status !== STATUS.FAIL);
        return { runId, dryRun, mode, observe, runs };
    } finally {
        if (started.token !== '') runtime.budget?.settle?.(started.token, { ok, now });
    }
}
