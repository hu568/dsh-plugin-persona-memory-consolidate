/**
 * 历史暂存回填（0.1.2）：把 `_unassigned` 里的会话按 cwd 搬回正确工作区桶。
 *
 * 钉住：
 *  1. 计划只搬「整批行指向同一个工作区」的会话（混桶/未知 cwd 一律跳过）；
 *  2. 已归属正确的会话不重复搬；
 *  3. 目标桶已有同会话文件时按 turn 去重合并，不覆盖已有行；
 *  4. 行内 `workspaceId` 一并改写，游标从旧键迁到新键且不回退；
 *  5. `planMigration()` 只读，不产生任何文件写入。
 *
 * 跑法：node test/migrate.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cursorKey, cursorPath, pendingDir, readCursor, writeCursor } from '../lib/cursor.js';
import { applyMigration, planMigration } from '../lib/migrate.js';
import { appendRow, readRows, sessionFile } from '../lib/pending.js';
import { makeHome } from './_helpers.mjs';

const NOW = 1_800_000_000_000;

/** 一行 L0（字段够用即可，迁移只关心 cwd / turn / consumed）。 */
function row({ sessionId, turn, cwd, bucket = '_unassigned', consumed = false }) {
    return {
        turn,
        endedAt: NOW + turn,
        seqFrom: turn * 10,
        user: `第 ${turn} 轮的问题`,
        assistant: `第 ${turn} 轮的结论：依赖用 tarball 装`,
        chars: 40,
        session: sessionId,
        cwd,
        workspaceId: bucket,
        workspaceTitle: '',
        consumed,
    };
}

const { home, cleanup } = makeHome('pmc-migrate');
const dir = pendingDir();

try {
    const registry = {
        workspaces: {
            'ws-one': { path: '/proj/one', title: '项目一', sessionIds: [] },
            'ws-two': { path: '/proj/two', title: '项目二', sessionIds: [] },
        },
    };

    /* session-a：两行都落在 ws-one 的子目录（未登记 sessionIds） */
    appendRow({ pendingDir: dir, bucket: '_unassigned', sessionId: 'session-a', row: row({ sessionId: 'session-a', turn: 1, cwd: '/proj/one/sub' }), now: NOW });
    appendRow({ pendingDir: dir, bucket: '_unassigned', sessionId: 'session-a', row: row({ sessionId: 'session-a', turn: 2, cwd: '/proj/one/sub' }), now: NOW });

    /* session-b：cwd 同时踩到两个项目（混桶）⇒ 不搬 */
    appendRow({ pendingDir: dir, bucket: '_unassigned', sessionId: 'session-b', row: row({ sessionId: 'session-b', turn: 1, cwd: '/proj/one' }), now: NOW });
    appendRow({ pendingDir: dir, bucket: '_unassigned', sessionId: 'session-b', row: row({ sessionId: 'session-b', turn: 2, cwd: '/proj/two' }), now: NOW });

    /* session-c：已经在正确桶里 ⇒ 不搬 */
    appendRow({ pendingDir: dir, bucket: 'ws-two', sessionId: 'session-c', row: row({ sessionId: 'session-c', turn: 1, cwd: '/proj/two', bucket: 'ws-two' }), now: NOW });

    /* session-dup：目标桶已有同一会话的 turn 1（重复行必须去重） */
    appendRow({ pendingDir: dir, bucket: '_unassigned', sessionId: 'session-dup', row: row({ sessionId: 'session-dup', turn: 1, cwd: '/proj/one' }), now: NOW });
    appendRow({ pendingDir: dir, bucket: '_unassigned', sessionId: 'session-dup', row: row({ sessionId: 'session-dup', turn: 2, cwd: '/proj/one' }), now: NOW });
    appendRow({ pendingDir: dir, bucket: 'ws-one', sessionId: 'session-dup', row: row({ sessionId: 'session-dup', turn: 1, cwd: '/proj/one', bucket: 'ws-one' }), now: NOW });

    /* 旧游标：迁移后要跟到新键 */
    const cursor = readCursor(cursorPath());
    writeCursor(cursor, cursorPath(), NOW);

    /* ── 1. 计划：只读 ── */
    const before = readFileSync(sessionFile(dir, '_unassigned', 'session-a'), 'utf8');
    const plan = planMigration({ pendingDir: dir, registry });
    assert.equal(readFileSync(sessionFile(dir, '_unassigned', 'session-a'), 'utf8'), before, 'planMigration 不许写文件');

    const planned = plan.moves.map((move) => `${move.fromBucket}/${move.sessionId}→${move.toBucket}`);
    assert.deepEqual(planned.sort(), ['_unassigned/session-a→ws-one', '_unassigned/session-dup→ws-one']);
    assert.ok(plan.skipped.some((item) => item.sessionId === 'session-b' && item.reason === 'no-single-workspace'));
    assert.ok(plan.skipped.some((item) => item.sessionId === 'session-c' && item.reason === 'already-correct'));

    /* ── 2. 先写一条旧游标，验证迁移 ── */
    const withCursor = readCursor(cursorPath());
    withCursor.sessions[cursorKey('_unassigned', 'session-a')] = { turn: 2, at: NOW + 2, chars: 0 };
    writeCursor(withCursor, cursorPath(), NOW);

    /* ── 3. 执行 ── */
    const result = applyMigration(plan, { now: NOW });
    assert.equal(result.failed.length, 0);
    assert.equal(result.moved.length, 2);

    assert.ok(!existsSync(sessionFile(dir, '_unassigned', 'session-a')), '源文件必须搬走');
    const movedRows = readRows({ pendingDir: dir, bucket: 'ws-one', sessionId: 'session-a' }).map((item) => item.row);
    assert.equal(movedRows.length, 2);
    assert.ok(movedRows.every((item) => item.workspaceId === 'ws-one'), '行内 workspaceId 要改写');
    assert.ok(movedRows.every((item) => item.workspaceTitle === '项目一'));

    const merged = readRows({ pendingDir: dir, bucket: 'ws-one', sessionId: 'session-dup' }).map((item) => item.row);
    assert.deepEqual(merged.map((item) => item.turn), [1, 2], '目标已有 turn 1 ⇒ 去重合并，不重复');

    /* ── 4. 游标：旧键消失、新键保留最大 turn ── */
    const after = readCursor(cursorPath());
    assert.equal(after.sessions[cursorKey('_unassigned', 'session-a')], undefined, '旧键要删掉');
    assert.equal(after.sessions[cursorKey('ws-one', 'session-a')]?.turn, 2, '新键保留进度');
    assert.equal(result.cursor.remapped, 1);

    /* ── 5. 再跑一次：没有可搬的了 ── */
    const again = planMigration({ pendingDir: dir, registry });
    assert.equal(again.moves.length, 0);
} finally {
    cleanup();
}

console.log('✓ migrate.test.mjs 全部通过');
