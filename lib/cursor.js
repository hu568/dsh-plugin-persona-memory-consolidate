/**
 * 游标：`$DSH_HOME/memory/consolidate/cursor.json`，按 `${workspaceId}:${sessionId}` 记。
 *
 * 为什么按「工作区 + 会话」双键，而不是只按 sessionId：
 *  - 消费门槛是按 workspaceId 聚合的（02 §7.0），所以读游标的人手里一定有两个键；
 *  - 会话可能被移动/复制到别的工作区（同 sessionId 出现在两个桶里），单键会串。
 *
 * 崩溃语义（02 §7.0「崩溃语义」）：游标只在 L1 成功后推进，L1 跑到一半崩溃 ⇒
 * `consumed` 仍为 false ⇒ 下次重跑。所以这里**只存状态，不做事务**。
 *
 * 铁律：**读坏文件当空游标，绝不抛**。一次手改/半截 rename 都不该让沉淀整个停摆。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { renameWithRetry } from './atomic.js';

/** `$DSH_HOME`；空串回落 `~/.dsh`（与主插件同口径）。 */
export function dshHome() {
    return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 本插件的运行数据目录（02 §7.7：不进项目目录）。 */
export function consolidateDir(home = dshHome()) {
    return join(home, 'memory', 'consolidate');
}

/** 游标文件路径。 */
export function cursorPath(home = dshHome()) {
    return join(consolidateDir(home), 'cursor.json');
}

/** L0 暂存目录（`pending/<bucket>/<session>.jsonl`）。 */
export function pendingDir(home = dshHome()) {
    return join(consolidateDir(home), 'pending');
}

/** 按 runId 分的快照目录（M4 回滚用，保留 10 份）。 */
export function backupsDir(home = dshHome()) {
    return join(consolidateDir(home), 'backups');
}

/** 第二层（跨会话）游标文件路径。 */
export function crossCursorPath(home = dshHome()) {
    return join(consolidateDir(home), 'cross-cursor.json');
}

/** 空游标。 */
export function emptyCursor() {
    return { version: 1, sessions: {}, updatedAt: 0 };
}

/** 双键。`workspaceId` 缺省用 `_unassigned`（与桶名一致）。 */
export function cursorKey(workspaceId, sessionId) {
    return `${workspaceId === undefined || workspaceId === null || workspaceId === '' ? '_unassigned' : String(workspaceId)}:${String(sessionId ?? '')}`;
}

/**
 * 读任意 JSON；不存在 / 坏 JSON / 不是对象 → null。**不抛**。
 *
 * @param {string} file
 * @returns {any | null}
 */
export function readJsonSafe(file) {
    let raw;
    try {
        raw = readFileSync(file, 'utf8');
    } catch {
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed;
    } catch {
        return null;
    }
}

/**
 * 原子写 JSON（临时文件 + rename）。**不抛**，返回是否写成。
 *
 * @param {string} file
 * @param {any} value
 * @returns {boolean}
 */
export function writeJsonAtomic(file, value) {
    try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
        writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        renameWithRetry(tmp, file);
        return true;
    } catch {
        return false;
    }
}

/**
 * 把任意读入值归一成合法游标（坏条目逐条丢，不整份丢）。
 *
 * @param {any} raw
 * @returns {{ version: number, sessions: Record<string, { turn: number, at: number, chars: number }>, updatedAt: number }}
 */
export function sanitizeCursor(raw) {
    const cursor = emptyCursor();
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return cursor;
    cursor.updatedAt = Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : 0;
    const sessions = raw.sessions;
    if (sessions === null || typeof sessions !== 'object' || Array.isArray(sessions)) return cursor;
    for (const [key, entry] of Object.entries(sessions)) {
        if (key === '' || entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
        cursor.sessions[key] = {
            turn: Number.isFinite(entry.turn) ? Math.trunc(Number(entry.turn)) : 0,
            at: Number.isFinite(entry.at) ? Number(entry.at) : 0,
            chars: Number.isFinite(entry.chars) ? Math.trunc(Number(entry.chars)) : 0,
        };
    }
    return cursor;
}

/**
 * 读游标。文件缺失 / 坏 JSON / 结构不对 ⇒ **空游标**（不抛）。
 *
 * @param {string} [file]
 * @returns {ReturnType<typeof emptyCursor>}
 */
export function readCursor(file = cursorPath()) {
    return sanitizeCursor(readJsonSafe(file));
}

/**
 * 写游标（整份原子替换）。**不抛**，返回是否写成。
 *
 * @param {ReturnType<typeof emptyCursor>} cursor
 * @param {string} [file]
 * @param {number} [now]
 * @returns {boolean}
 */
export function writeCursor(cursor, file = cursorPath(), now = Date.now()) {
    const next = sanitizeCursor(cursor);
    next.updatedAt = now;
    return writeJsonAtomic(file, next);
}

/**
 * 取某会话的游标（没有就返回 0 值，不写盘）。
 *
 * @param {ReturnType<typeof emptyCursor>} cursor
 * @param {string} workspaceId
 * @param {string} sessionId
 * @returns {{ turn: number, at: number, chars: number }}
 */
export function getSessionCursor(cursor, workspaceId, sessionId) {
    const key = cursorKey(workspaceId, sessionId);
    const entry = cursor?.sessions?.[key];
    if (entry === undefined) return { turn: 0, at: 0, chars: 0 };
    return { ...entry };
}

/**
 * 推进某会话的游标（原地改 cursor，返回该条目）。
 *
 * 只允许**单调前进**：`turn` 比现有值小就忽略——宿主重启后 `lastTurn` 可能短暂
 * 回退，回退会造成重复消费（同样的回合被抽两次，FACT 里就会出现重复结论）。
 *
 * @param {ReturnType<typeof emptyCursor>} cursor
 * @param {string} workspaceId
 * @param {string} sessionId
 * @param {{ turn?: number, chars?: number, at?: number }} patch
 * @returns {{ turn: number, at: number, chars: number }}
 */
export function setSessionCursor(cursor, workspaceId, sessionId, patch = {}) {
    const key = cursorKey(workspaceId, sessionId);
    const current = getSessionCursor(cursor, workspaceId, sessionId);
    const nextTurn = Number.isFinite(patch.turn) ? Math.max(current.turn, Math.trunc(Number(patch.turn))) : current.turn;
    const nextChars = Number.isFinite(patch.chars) ? Math.trunc(Number(patch.chars)) : current.chars;
    const nextAt = Number.isFinite(patch.at) ? Number(patch.at) : current.at;
    if (cursor.sessions === null || typeof cursor.sessions !== 'object') cursor.sessions = {};
    cursor.sessions[key] = { turn: nextTurn, at: nextAt, chars: nextChars };
    return cursor.sessions[key];
}
