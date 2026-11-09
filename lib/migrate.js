/**
 * 历史暂存回填（0.1.2）：把「放错桶」的暂存行搬回按 **cwd 路径**解析出的工作区桶。
 *
 * 为什么需要它：0.1.1 及更早按 `workspace.json` 的 `sessionIds` 反查分桶，
 * 而会话常常先于登记写入（本机 6 个会话桶里 5 个落在 `_unassigned`）。
 * 归属修正之后，**新行**会直接进正确桶；**旧行**仍躺在 `_unassigned`，
 * 只靠消费时的行级兜底也能写对项目记忆，但游标与桶身份仍是错的，
 * 后续补漏还可能重复写。这里做一次真正的搬家：行文件 + 行内 workspaceId + 游标。
 *
 * 安全边界：
 *  - 只搬「整批行指向**同一个**工作区」的会话（混桶不猜）；
 *  - 目标文件已存在时按 `turn` 去重合并，绝不覆盖已有行；
 *  - 写目标用「临时文件 + rename」，成功后才删源；崩溃时最坏是重复（去重可解），不是丢行；
 *  - 游标只迁移该会话的键，且取 `max(turn)`，绝不回退。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { renameWithRetry } from './atomic.js';
import {
    cursorKey,
    cursorPath,
    pendingDir as defaultPendingDir,
    readCursor,
    writeCursor,
} from './cursor.js';
import { listBuckets, listSessions, readRows, sessionFile } from './pending.js';
import { loadRegistry, resolveRowsWorkspace } from './workspace.js';

/** 读文件的行（不存在 ⇒ []）。 */
function readLines(file) {
    try {
        return readFileSync(file, 'utf8').split(/\r?\n/u).filter((line) => line.trim() !== '');
    } catch {
        return [];
    }
}

/** 行身份：同一会话里 `turn` 唯一（把重复行挡在合并之外）。 */
function rowIdentity(row) {
    return `${Number(row?.turn) || 0}`;
}

/** 原子写行（临时文件 + rename）。 */
function writeAtomicLines(file, lines) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8');
    renameWithRetry(tmp, file);
}

/**
 * 生成回填计划（**只读**）。
 *
 * @param {{ pendingDir?: string, registry?: any, registryFile?: string }} [input]
 * @returns {{
 *   pendingDir: string,
 *   moves: { fromBucket: string, toBucket: string, sessionId: string, title: string, path: string, rows: number, unconsumed: number }[],
 *   skipped: { fromBucket: string, sessionId: string, reason: string }[],
 * }}
 */
export function planMigration(input = {}) {
    const dir = input.pendingDir ?? defaultPendingDir();
    const registry = input.registry ?? loadRegistry(input.registryFile);
    const moves = [];
    const skipped = [];

    for (const fromBucket of listBuckets(dir)) {
        for (const name of listSessions(dir, fromBucket)) {
            const sessionId = name.replace(/\.jsonl$/u, '');
            const rows = readRows({ pendingDir: dir, bucket: fromBucket, sessionId }).map((item) => item.row);
            if (rows.length === 0) {
                skipped.push({ fromBucket, sessionId, reason: 'empty' });
                continue;
            }
            const target = resolveRowsWorkspace(registry, rows);
            if (target === null) {
                skipped.push({ fromBucket, sessionId, reason: 'no-single-workspace' });
                continue;
            }
            if (target.workspaceId === fromBucket) {
                skipped.push({ fromBucket, sessionId, reason: 'already-correct' });
                continue;
            }
            moves.push({
                fromBucket,
                toBucket: target.workspaceId,
                sessionId,
                title: target.title,
                path: target.path,
                rows: rows.length,
                unconsumed: rows.filter((row) => row?.consumed !== true).length,
            });
        }
    }
    return { pendingDir: dir, moves, skipped };
}

/**
 * 执行回填计划：搬行文件 → 合并去重 → 重写行内 `workspaceId` → 迁游标。
 *
 * @param {ReturnType<typeof planMigration>} plan
 * @param {{ now?: number }} [input]
 * @returns {{
 *   moved: any[], failed: { move: any, reason: string }[],
 *   cursor: { remapped: number, skipped: number },
 * }}
 */
export function applyMigration(plan, input = {}) {
    const dir = plan?.pendingDir ?? defaultPendingDir();
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    const moved = [];
    const failed = [];

    for (const move of plan?.moves ?? []) {
        try {
            const source = sessionFile(dir, move.fromBucket, move.sessionId);
            const target = sessionFile(dir, move.toBucket, move.sessionId);
            const sourceRows = readRows({ pendingDir: dir, bucket: move.fromBucket, sessionId: move.sessionId })
                .map((item) => item.row);
            const targetRows = existsSync(target)
                ? readRows({ pendingDir: dir, bucket: move.toBucket, sessionId: move.sessionId }).map((item) => item.row)
                : [];
            const seen = new Set(targetRows.map(rowIdentity));
            const merged = [...targetRows];
            for (const row of sourceRows) {
                const rewritten = {
                    ...row,
                    workspaceId: move.toBucket,
                    workspaceTitle: move.title !== '' ? move.title : (row.workspaceTitle ?? ''),
                };
                if (seen.has(rowIdentity(rewritten))) continue;
                seen.add(rowIdentity(rewritten));
                merged.push(rewritten);
            }
            writeAtomicLines(target, merged.map((row) => JSON.stringify(row)));
            rmSync(source, { force: true });
            moved.push(move);
        } catch (error) {
            failed.push({ move, reason: String(error?.message ?? error) });
        }
    }

    /* 游标：只迁成功搬走的会话；目标键已存在时取 max(turn)，绝不回退。 */
    const file = input.cursorFile ?? cursorPath();
    const cursor = readCursor(file);
    let remapped = 0;
    let cursorSkipped = 0;
    for (const move of moved) {
        const fromKey = cursorKey(move.fromBucket, move.sessionId);
        const toKey = cursorKey(move.toBucket, move.sessionId);
        const from = cursor.sessions?.[fromKey];
        if (from === undefined || from === null) {
            cursorSkipped += 1;
            continue;
        }
        const to = cursor.sessions?.[toKey] ?? { turn: 0, at: 0, chars: 0 };
        cursor.sessions[toKey] = {
            turn: Math.max(Number(from.turn) || 0, Number(to.turn) || 0),
            at: Math.max(Number(from.at) || 0, Number(to.at) || 0),
            chars: Number(from.chars) || Number(to.chars) || 0,
        };
        delete cursor.sessions[fromKey];
        remapped += 1;
    }
    if (remapped > 0) writeCursor(cursor, file, now);
    return { moved, failed, cursor: { remapped, skipped: cursorSkipped } };
}

/** 回填结果的一行摘要（命令与日志共用，避免两处文案漂移）。 */
export function summarizeMigration(plan, result) {
    const moved = result?.moved?.length ?? 0;
    const rows = (result?.moved ?? []).reduce((sum, move) => sum + (Number(move.rows) || 0), 0);
    const unconsumed = (result?.moved ?? []).reduce((sum, move) => sum + (Number(move.unconsumed) || 0), 0);
    return `搬 ${moved} 个会话 / ${rows} 行（未消费 ${unconsumed}）`
        + ` · 游标迁移 ${result?.cursor?.remapped ?? 0}`
        + ` · 跳过 ${(plan?.skipped?.length ?? 0) + (result?.failed?.length ?? 0)}`;
}
