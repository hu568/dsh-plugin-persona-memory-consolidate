/**
 * 游标（`consolidate/cursor.json`）：坏文件不炸、原子写、单调前进。
 *
 * 跑法：node test/cursor.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    cursorKey,
    crossCursorPath,
    cursorPath,
    emptyCursor,
    getSessionCursor,
    readCursor,
    readJsonSafe,
    sanitizeCursor,
    setSessionCursor,
    writeCursor,
    writeJsonAtomic,
} from '../lib/cursor.js';
import { makeHome } from './_helpers.mjs';

const { home, cleanup } = makeHome('pmc-cursor');
try {
    const ws = 'aae899f6-a922-45a8-9f91-22caf132122b';
    const session = 'session-952b74aa';

    /* 双键 */
    assert.equal(cursorKey(ws, session), `${ws}:${session}`);
    assert.equal(cursorKey(undefined, session), `_unassigned:${session}`, '缺工作区时落 _unassigned');

    /* 文件不存在 → 空游标 */
    const missing = readCursor(join(home, 'nope', 'cursor.json'));
    assert.deepEqual(missing.sessions, {});
    assert.equal(missing.version, 1);

    /* 坏 JSON → 空游标，且**不抛** */
    const corrupt = join(home, 'corrupt.json');
    writeFileSync(corrupt, '{"version":1,"sessions":{ 坏掉了', 'utf8');
    assert.deepEqual(readCursor(corrupt).sessions, {});

    /* 不是对象 / 是数组 / 是数字 → 空游标 */
    const wrongShape = join(home, 'wrong.json');
    for (const payload of ['[]', '42', '"text"', 'null']) {
        writeFileSync(wrongShape, payload, 'utf8');
        assert.deepEqual(readCursor(wrongShape).sessions, {}, `${payload} 应回落空游标`);
    }

    /* 半坏结构：坏条目逐条丢，好条目留下 */
    const partial = join(home, 'partial.json');
    writeFileSync(partial, JSON.stringify({
        version: 1,
        updatedAt: 123,
        sessions: {
            'ws:good': { turn: 12, at: 456, chars: 100 },
            'ws:bad-turn': { turn: 'x', at: null },
            'ws:not-object': 42,
            '': { turn: 1 },
        },
    }), 'utf8');
    const sanitized = readCursor(partial);
    assert.equal(sanitized.updatedAt, 123);
    assert.equal(sanitized.sessions['ws:good'].turn, 12);
    assert.equal(sanitized.sessions['ws:bad-turn'].turn, 0, '坏 turn 归零而不是整份丢掉');
    assert.equal(sanitized.sessions['ws:not-object'], undefined);
    assert.equal(sanitized.sessions[''], undefined, '空键丢弃');

    /* 读写往返（原子写：rename 后文件是完整 JSON） */
    const file = cursorPath();
    const cursor = emptyCursor();
    setSessionCursor(cursor, ws, session, { turn: 12, chars: 1247, at: 999 });
    assert.equal(writeCursor(cursor, file, 1_000), true);
    const raw = readFileSync(file, 'utf8');
    assert.ok(raw.endsWith('\n'), '写完应以换行结尾');
    assert.equal(JSON.parse(raw).updatedAt, 1_000);
    const reloaded = readCursor(file);
    assert.deepEqual(getSessionCursor(reloaded, ws, session), { turn: 12, chars: 1247, at: 999 });

    /* 单调前进：turn 回退被忽略（宿重重启后 lastTurn 可能回退） */
    const next = setSessionCursor(reloaded, ws, session, { turn: 9, chars: 0, at: 1_001 });
    assert.equal(next.turn, 12, '回退的 turn 不能覆盖已消费进度');
    assert.equal(next.at, 1_001, '时间戳仍前进');
    assert.equal(next.chars, 0, '字符数是每次覆盖的（它描述的是「这一批」）');

    /* 没写过的会话 → 0 值，不写盘 */
    assert.deepEqual(getSessionCursor(reloaded, 'other-ws', 'other'), { turn: 0, at: 0, chars: 0 });

    /* 写不进（父路径是个文件）→ false，不抛 */
    const blocker = join(home, 'blocker');
    writeFileSync(blocker, 'x', 'utf8');
    assert.equal(writeJsonAtomic(join(blocker, 'child.json'), { a: 1 }), false);
    assert.equal(readJsonSafe(join(blocker, 'child.json')), null);

    /* 第二层游标路径与第一层同目录 */
    assert.ok(crossCursorPath().endsWith(join('consolidate', 'cross-cursor.json')));
    assert.ok(cursorPath().endsWith(join('consolidate', 'cursor.json')));

    /* sanitizeCursor 对 null / undefined 宽容 */
    assert.deepEqual(sanitizeCursor(null).sessions, {});
    assert.deepEqual(sanitizeCursor(undefined).sessions, {});

    /* 目录不存在时写入会自动建目录 */
    const deep = join(home, 'a', 'b', 'cursor.json');
    mkdirSync(join(home, 'a'), { recursive: true });
    assert.equal(writeJsonAtomic(deep, { version: 1 }), true);
    assert.deepEqual(readJsonSafe(deep), { version: 1 });
} finally {
    cleanup();
}

console.log('✓ cursor.test.mjs 全部通过');
