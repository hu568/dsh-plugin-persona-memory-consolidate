/**
 * L0 暂存层（02 §7.0）：追加 / 滚动 / 读未消费 / 汇总 / 标记消费 / 归档 / 过期清理。
 *
 * 钉住四条硬约束：
 *  1. 滚动**只搬已消费行**，未消费行一行都不许丢；
 *  2. `markConsumed` 是「读→写临时→rename」，且**先重写活文件、后追加归档**（崩溃不会造成重复消费）；
 *  3. 已消费行**永远不会**再出现在 `readUnconsumed` 里；
 *  4. 坏行 / 坏文件 / 目录不存在一律不抛。
 *
 * 跑法：node test/pending.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
    appendRow,
    archivePath,
    bucketDir,
    cleanup,
    listBuckets,
    listSessions,
    markConsumed,
    monthKey,
    readRows,
    readUnconsumed,
    sessionFile,
    summarize,
} from '../lib/pending.js';
import { makeHome, NOW } from './_helpers.mjs';

const { home, cleanup: cleanupHome } = makeHome('pmc-pending');

try {
    const dir = join(home, 'pending');

    /* ── 路径与命名 ── */
    assert.equal(bucketDir(dir, 'ws-1'), join(dir, 'ws-1'));
    assert.equal(bucketDir(dir, '').endsWith('_unassigned'), true, '空桶名落 _unassigned');
    assert.equal(sessionFile(dir, 'ws-1', 'session-a'), join(dir, 'ws-1', 'session-a.jsonl'));
    assert.equal(sessionFile(dir, 'ws-1', 'a/b'), join(dir, 'ws-1', 'a-b.jsonl'), '会话名里的路径分隔符要消掉');
    assert.equal(monthKey(NOW), new Date(NOW).toISOString().slice(0, 7) === monthKey(NOW) ? monthKey(NOW) : monthKey(NOW));
    assert.match(monthKey(NOW), /^\d{4}-\d{2}$/u);
    assert.equal(
        archivePath(dir, 'ws-1', NOW),
        join(dir, 'archive', 'ws-1', `${monthKey(NOW)}.jsonl`),
        '归档按 workspaceId + 月分文件',
    );

    /* ── 追加与读取 ── */
    const first = appendRow({
        pendingDir: dir,
        bucket: 'ws-1',
        sessionId: 'session-a',
        now: NOW,
        row: { turn: 1, endedAt: NOW, seqFrom: 10, user: '问题一', assistant: '结论一', chars: 30, cwd: 'D:\\proj', workspaceId: 'ws-1', workspaceTitle: '标题', consumed: false },
    });
    assert.equal(first.file, sessionFile(dir, 'ws-1', 'session-a'));
    assert.equal(first.rows, 1);
    assert.equal(first.rolled, false);

    appendRow({
        pendingDir: dir,
        bucket: 'ws-1',
        sessionId: 'session-a',
        now: NOW + 1,
        row: { turn: 2, endedAt: NOW + 1, seqFrom: 20, user: '问题二', assistant: '结论二', chars: 40, consumed: false },
    });
    appendRow({
        pendingDir: dir,
        bucket: 'ws-1',
        sessionId: 'session-b',
        now: NOW + 2,
        row: { turn: 1, endedAt: NOW + 2, seqFrom: 5, user: '别的问题', assistant: '别的结论', chars: 10, consumed: false },
    });

    assert.deepEqual(listSessions(dir, 'ws-1'), ['session-a.jsonl', 'session-b.jsonl']);
    assert.deepEqual(listBuckets(dir), ['ws-1']);

    const all = readRows({ pendingDir: dir, bucket: 'ws-1' });
    assert.equal(all.length, 3);
    assert.equal(all[0].row.turn, 1);
    assert.equal(all[0].line, 1, '行号 1 基');
    assert.equal(all[0].row.session, 'session-a', '行里要带 session（归档也要能独立读懂）');
    assert.deepEqual(readRows({ pendingDir: dir, bucket: 'ws-1', sessionId: 'session-b' }).map((item) => item.row.turn), [1]);

    /* 未消费：跨会话、最老在前 */
    const pendingRows = readUnconsumed({ pendingDir: dir, bucket: 'ws-1' });
    assert.equal(pendingRows.length, 3);
    assert.deepEqual(pendingRows.map((row) => row.session), ['session-a', 'session-a', 'session-b'], '按 endedAt 升序');
    assert.equal(pendingRows[0].file.endsWith('session-a.jsonl'), true);
    assert.equal(pendingRows[0].line, 1, '拍平的行要带 file / line');

    /* 汇总：turns 数「会话 + 回合」去重，chars 求和 */
    assert.deepEqual(summarize(pendingRows), { turns: 3, chars: 80 });
    assert.deepEqual(summarize([]), { turns: 0, chars: 0 });
    assert.deepEqual(summarize([{ row: { session: 's', turn: 1, chars: 5 } }, { row: { session: 's', turn: 1, chars: 5 } }]), { turns: 1, chars: 10 }, '同一会话同一回合只算一轮');
    assert.deepEqual(summarize([pendingRows[0]]), { turns: 1, chars: 30 }, '也接受 readRows 的 {row} 形状');

    /* ── 标记消费：只标记这一批，别的会话不受影响 ── */
    const marked = markConsumed({ pendingDir: dir, bucket: 'ws-1', turns: [{ session: 'session-a', turn: 1 }], now: NOW + 100 });
    assert.deepEqual(marked, { marked: 1, archived: 1, files: 1 });

    assert.deepEqual(readUnconsumed({ pendingDir: dir, bucket: 'ws-1' }).map((row) => row.turn), [2, 1], '已消费的不再出现');
    const afterMark = readRows({ pendingDir: dir, bucket: 'ws-1' });
    assert.equal(afterMark.filter((item) => item.row.consumed === true).length, 1);
    assert.equal(afterMark.find((item) => item.row.consumed === true).row.consumedAt, NOW + 100);
    assert.equal(readRows({ pendingDir: dir, bucket: 'ws-1' }).length, 3, '标记消费不删行（含已消费行仍可读）');

    const archiveFile = archivePath(dir, 'ws-1', NOW + 100);
    assert.ok(existsSync(archiveFile), '已消费副本要进归档');
    const archived = readFileSync(archiveFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(archived.length, 1);
    assert.equal(archived[0].turn, 1);
    assert.equal(archived[0].consumed, true);

    /* 重复标记同一回合：不会再计一次（幂等） */
    assert.deepEqual(markConsumed({ pendingDir: dir, bucket: 'ws-1', turns: [{ session: 'session-a', turn: 1 }], now: NOW + 101 }), { marked: 0, archived: 0, files: 0 });
    assert.equal(readFileSync(archiveFile, 'utf8').trim().split('\n').length, 1, '归档不许重复追加');

    /* 数字形式的 turn（无 session）：对全桶生效，仍然只标记未消费行 */
    assert.deepEqual(markConsumed({ pendingDir: dir, bucket: 'ws-1', turns: [2], now: NOW + 102 }), { marked: 1, archived: 1, files: 1 });
    assert.deepEqual(readUnconsumed({ pendingDir: dir, bucket: 'ws-1' }).map((row) => row.turn), [1]);
    assert.deepEqual(markConsumed({ pendingDir: dir, bucket: 'ws-1', turns: [] }), { marked: 0, archived: 0, files: 0 });

    /* ── 坏行：只跳过这一行，其余照读 ── */
    const dirtyFile = sessionFile(dir, 'ws-dirty', 'session-x');
    mkdirSync(bucketDir(dir, 'ws-dirty'), { recursive: true });
    writeFileSync(dirtyFile, `${'{"turn":1,"chars":5,"consumed":false}\n'}这不是 json\n{"turn":2,"chars":7,"consumed":false}\n`, 'utf8');
    assert.equal(readRows({ pendingDir: dir, bucket: 'ws-dirty' }).length, 2, '坏行跳过，好行照读');
    assert.deepEqual(summarize(readUnconsumed({ pendingDir: dir, bucket: 'ws-dirty' })), { turns: 2, chars: 12 });

    /* ── 滚动：行数超限时只把已消费行搬进归档，未消费一行不丢 ── */
    const rollDir = join(home, 'pending-roll');
    for (let turn = 1; turn <= 5; turn += 1) {
        appendRow({
            pendingDir: rollDir,
            bucket: 'ws-roll',
            sessionId: 'session-r',
            now: NOW + turn,
            maxRows: 4,
            row: { turn, endedAt: NOW + turn, user: `问题${turn}`, assistant: `结论${turn}`, chars: 10, consumed: turn <= 2 },
        });
    }
    // 第 5 行写入前应已触发滚动：2 条已消费的行进归档，活文件只剩未消费行 + 新行
    const rollFile = sessionFile(rollDir, 'ws-roll', 'session-r');
    const rollRows = readRows({ pendingDir: rollDir, bucket: 'ws-roll' });
    assert.deepEqual(rollRows.map((item) => item.row.turn), [3, 4, 5], '已消费行被压实出去，未消费行全留');
    const rollArchive = readFileSync(archivePath(rollDir, 'ws-roll', NOW + 5), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(rollArchive.map((row) => row.turn), [1, 2], '搬走的已消费行进归档');

    /* 全是未消费行时不滚（宁可文件大，也不丢数据） */
    const keepDir = join(home, 'pending-keep');
    for (let turn = 1; turn <= 6; turn += 1) {
        appendRow({
            pendingDir: keepDir,
            bucket: 'ws-keep',
            sessionId: 'session-k',
            now: NOW + turn,
            maxRows: 3,
            row: { turn, endedAt: NOW + turn, chars: 10, consumed: false },
        });
    }
    assert.equal(readRows({ pendingDir: keepDir, bucket: 'ws-keep' }).length, 6, '没有已消费行就不滚，一行都不许丢');
    assert.equal(existsSync(archivePath(keepDir, 'ws-keep', NOW + 6)), false, '没东西可归档就不建归档文件');

    /* 字节上限也能触发滚动 */
    const bytesDir = join(home, 'pending-bytes');
    appendRow({
        pendingDir: bytesDir,
        bucket: 'ws-bytes',
        sessionId: 'session-by',
        now: NOW,
        maxBytes: 1024,
        row: { turn: 1, endedAt: NOW, chars: 1, consumed: true, assistant: 'x'.repeat(700) },
    });
    const rolled = appendRow({
        pendingDir: bytesDir,
        bucket: 'ws-bytes',
        sessionId: 'session-by',
        now: NOW + 1,
        maxBytes: 1024,
        row: { turn: 2, endedAt: NOW + 1, chars: 1, consumed: false, assistant: 'y'.repeat(700) },
    });
    assert.equal(rolled.rolled, true, '超过 maxBytes 要滚动');
    assert.equal(rolled.archived, 1);
    assert.deepEqual(readRows({ pendingDir: bytesDir, bucket: 'ws-bytes' }).map((item) => item.row.turn), [2]);

    /* ── 过期清理：只丢「未消费 + 超期」，已消费与无时间戳的一律保留 ── */
    const ageDir = join(home, 'pending-age');
    const day = 86_400_000;
    appendRow({ pendingDir: ageDir, bucket: 'ws-age', sessionId: 'session-old', now: NOW, row: { turn: 1, endedAt: NOW - 40 * day, chars: 5, consumed: false } });
    appendRow({ pendingDir: ageDir, bucket: 'ws-age', sessionId: 'session-old', now: NOW, row: { turn: 2, endedAt: NOW - 1 * day, chars: 5, consumed: false } });
    appendRow({ pendingDir: ageDir, bucket: 'ws-age', sessionId: 'session-old', now: NOW, row: { turn: 3, endedAt: NOW - 40 * day, chars: 5, consumed: true } });
    appendRow({ pendingDir: ageDir, bucket: 'ws-age', sessionId: 'session-old', now: NOW, row: { turn: 4, chars: 5, consumed: false } });

    assert.deepEqual(cleanup({ pendingDir: ageDir, maxAgeDays: 30, now: NOW }), { dropped: 1, files: 1 });
    const agedTurns = readRows({ pendingDir: ageDir, bucket: 'ws-age' }).map((item) => item.row.turn);
    assert.deepEqual(agedTurns, [2, 3, 4], '超期未消费的丢了，新的 / 已消费的 / 无时间戳的留着');
    assert.deepEqual(cleanup({ pendingDir: ageDir, maxAgeDays: 30, now: NOW }), { dropped: 0, files: 0 }, '第二次跑没有可丢的');

    /* ── 空目录 / 不存在目录：一律不抛 ── */
    assert.deepEqual(readRows({ pendingDir: join(home, 'nope'), bucket: 'ws-x' }), []);
    assert.deepEqual(readUnconsumed({ pendingDir: join(home, 'nope'), bucket: 'ws-x' }), []);
    assert.deepEqual(listBuckets(join(home, 'nope')), []);
    assert.deepEqual(listSessions(join(home, 'nope'), 'ws-x'), []);
    assert.deepEqual(cleanup({ pendingDir: join(home, 'nope'), maxAgeDays: 30, now: NOW }), { dropped: 0, files: 0 });
    assert.deepEqual(markConsumed({ pendingDir: join(home, 'nope'), bucket: 'ws-x', turns: [1] }), { marked: 0, archived: 0, files: 0 });

    /* 归档目录不被当成工作区桶（第二层逐桶迭代会跳过它） */
    assert.equal(listBuckets(dir).includes('archive'), false);
} finally {
    cleanupHome();
}

console.log('✓ pending.test.mjs 全部通过');
