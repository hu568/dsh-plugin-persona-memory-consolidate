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
 *  - `MEMORY_BUDGET_EXCEEDED` 之外的错误：记 FAIL，交给预算层算退避，**不在本
 *    模块重试**。
 *
 * store 是**注入**的（`resolveStore` 或直接给 `store`），所以单测不需要装主插件。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { STATUS, supersededPath } from './runlog.js';
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
};

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

/** 从 store 结果里判「是不是没找到」。 */
function isNotFound(result) {
    if (result === null || result === undefined) return false;
    if (result.reason === 'not-found') return true;
    if (result.notFound === true) return true;
    return result.written === false && result.demoted !== true;
}

/**
 * 造写入器。
 *
 * @param {{
 *   store?: any,
 *   resolveStore?: () => Promise<any | null>,
 *   storeScopeMap?: Record<string, string>,
 *   supersededFile?: string,
 *   now?: number,
 * }} [options]
 * @returns {{
 *   apply: (ops: any[], context?: { cwd?: string, workspaceId?: string, dryRun?: boolean, layer?: number }) => Promise<{
 *     results: any[], counts: Record<string, number>, watermarks: Record<string, any>,
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

    const apply = async (ops = [], context = {}) => {
        const results = [];
        const counts = { written: 0, replaced: 0, deleted: 0, demoted: 0, dropped: 0, noop: 0, dry: 0, failed: 0 };
        const watermarks = {};
        const store = await reader();
        const now = Number.isFinite(context.now) ? context.now : Date.now();

        const record = (op, status, reason, extra = {}) => {
            results.push({ op: op.op, target: op.target ?? '', scope: op.scope ?? '', status, reason, content: op.content ?? '', ...extra });
            const key = status === WRITE_STATUS.WRITTEN ? 'written' : status;
            if (counts[key] !== undefined) counts[key] += 1;
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

        if (store === null || store === undefined) {
            for (const op of ops) record(op, WRITE_STATUS.DROPPED, 'store-unavailable');
            return { results, counts, watermarks };
        }

        if (typeof store.watermark === 'function') {
            Object.assign(watermarks, await watermark(store, context.cwd));
        }

        for (const op of ops) {
            if (op === null || typeof op !== 'object' || op.content === undefined) {
                continue;
            }
            if (op.op === 'NOOP') {
                record(op, WRITE_STATUS.NOOP, op.reason ?? 'noop');
                continue;
            }
            if (op.scope === 'journal') {
                // journal 类结论直接进 JOURNAL（不进 FACT/MEMORY，不需要闸口）。
                if (context.dryRun === true) {
                    record(op, WRITE_STATUS.DRY, 'would-journal');
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
                record(op, WRITE_STATUS.DROPPED, 'bad-scope');
                continue;
            }
            if (context.dryRun === true) {
                record(op, WRITE_STATUS.DRY, `would-${String(op.op).toLowerCase()}`);
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
                    if (result?.demoted === true) {
                        record(op, WRITE_STATUS.DEMOTED, 'store-demoted');
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
                record(op, WRITE_STATUS.FAILED, 'error');
            }
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
            if (result?.demoted === true) {
                // store 自己已经降级（写了 JOURNAL）⇒ 不再写第二次。
                record(op, WRITE_STATUS.DEMOTED, 'store-demoted');
                return;
            }
            record(op, WRITE_STATUS.WRITTEN, extra.reason ?? 'ok', { target: result?.target ?? '' });
        }

        return { results, counts, watermarks };
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
