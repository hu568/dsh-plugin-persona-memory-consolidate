/**
 * 数据源三档 + 降级链 + 频次升格 + 逐桶迭代（02 §3.1 / §6.4 / §7.1 / §7.6）。
 *
 * M4 起这三档都是**真实现**（不再是「适配器形状」）：
 *  - `journal`：JOURNAL 尾部 30 条 × 200 字符；
 *  - `service`：`ctx.sessionQuery` 的 `listSessions` / `readSession`（精确读，不碰 search*）；
 *  - `files`：多帧 zstd（按 magic 切帧 → 逐帧解压 → 失败帧计数，>5% 整档降级）。
 *
 * 多帧样本用 `zlib.zstdCompressSync` **现场造**（不依赖仓库里的二进制夹具），
 * 所以「失败帧容忍」这条能真的构造出来，而不是靠注释保证。
 *
 * 跑法：node test/sources.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import {
    CROSS_REASON,
    decideCross,
    frequencyPromotion,
    planCrossRun,
    readCrossCursor,
    writeCrossCursor,
} from '../lib/crosssession.js';
import {
    CHAIN,
    MAX_FRAME_FAILURE_RATE,
    SOURCE,
    ZSTD_MAGIC,
    createFilesSource,
    createJournalSource,
    createServiceSource,
    createSourceChain,
    decodeMultiFrame,
    entriesFromEvents,
    listPendingBuckets,
    readSessionFile,
    sourceChain,
    splitZstdFrames,
    truncateEntry,
} from '../lib/sources.js';
import { makeHome } from './_helpers.mjs';

const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function';

/** 造一个多帧 zstd 缓冲区（每帧一段 JSONL）。 */
function multiFrame(lines, { corruptFrame = -1, corruptAll = false } = {}) {
    const frames = lines.map((line, index) => {
        const frame = zlib.zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'));
        if (!corruptAll && index !== corruptFrame) return frame;
        // 保留 magic 但破坏正文：解压一定失败 ⇒ 记一个失败帧。
        const broken = Buffer.from(frame);
        for (let at = ZSTD_MAGIC.length; at < broken.length; at += 1) broken[at] = 0xff;
        return broken;
    });
    return Buffer.concat(frames);
}

/** 造事件（最小形状，够 `entriesFromEvents` 用）。 */
function sessionEvents({ user, assistant, cwd = 'D:\\proj\\a', time = 1_800_000_000_000 }) {
    return [
        { type: 'session', seq: 1, time, data: { cwd } },
        { type: 'user/message', seq: 2, time: time + 1, data: { message: { role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'user' } } } },
        { type: 'user/message', seq: 3, time: time + 2, data: { message: { role: 'user', content: [{ type: 'text', text: '时间上下文不该取样' }], source: { kind: 'time-context' } } } },
        { type: 'assistant/message', seq: 4, time: time + 3, data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '思维链不该取样' }, { type: 'text', text: assistant }] } } },
    ];
}

/* ────────────────────────── 降级链：auto 不含 files ────────────────────────── */
assert.deepEqual(sourceChain('auto'), [SOURCE.SERVICE, SOURCE.JOURNAL], 'auto = service → journal，绝不自动扫会话文件');
assert.deepEqual(sourceChain('journal'), [SOURCE.JOURNAL]);
assert.deepEqual(sourceChain('service'), [SOURCE.SERVICE, SOURCE.JOURNAL]);
assert.deepEqual(sourceChain('files'), [SOURCE.FILES, SOURCE.JOURNAL]);
assert.deepEqual(sourceChain('不认识'), [SOURCE.JOURNAL], '未知取值退回默认档');
assert.deepEqual(CHAIN.auto, sourceChain('auto'));
assert.ok(!CHAIN.auto.includes(SOURCE.FILES), 'files 只在明确配置时才用（02 §7.1 体量实测）');

/* ────────────────────────── 截断：每条 200 字符（02 §7.1） ────────────────────────── */
const truncated = truncateEntry({ id: 'j1', ts: '2026-10-31T00:00:00Z', text: 'x'.repeat(500), tags: ['a', 'b'] }, 200);
assert.equal(truncated.text.length, 201, '200 字符 + 省略号');
assert.deepEqual(truncated.tags, ['a', 'b']);
assert.equal(truncated.ts, '2026-10-31T00:00:00Z');
assert.equal(truncated.origin, '', '缺省 origin 是空串');

/* ────────────────────────── C 档 journal ────────────────────────── */
const fakeJournalStore = {
    async listJournal({ tail }) {
        return Array.from({ length: 5 }, (_, index) => ({ id: `j${index}`, ts: '2026-10-31', text: `日志 ${index}`, tags: [] })).slice(-tail);
    },
};
const journalSource = createJournalSource({ store: fakeJournalStore, tail: 3 });
assert.equal(journalSource.available(), true);
const listed = await journalSource.list({ limit: 3 });
assert.equal(listed.ok, true);
assert.equal(listed.source, SOURCE.JOURNAL);
assert.equal(listed.entries.length, 3);
assert.equal(listed.entries[2].id, 'j4');
assert.equal(listed.entries[2].origin, SOURCE.JOURNAL, '素材出处要标出来（只有 journal 的 id 能交给 supersedeJournal）');

/* 默认 30 条 × 200 字符 */
const bigStore = {
    async listJournal({ tail }) {
        return Array.from({ length: 60 }, (_, index) => ({ id: `b${index}`, ts: '2026-10-31', text: 'y'.repeat(400), tags: [] })).slice(-tail);
    },
};
const bigList = await createJournalSource({ store: bigStore }).list();
assert.equal(bigList.entries.length, 30, '默认尾部 30 条');
assert.equal(bigList.entries[0].text.length, 201, '每条截到 200 字符');

/* `readJournal` 口径（返回 `{entries,total}` 而不是数组）也要能吃 */
const readJournalStore = {
    async readJournal(limit) {
        return { entries: Array.from({ length: 4 }, (_, index) => ({ id: `r${index}`, ts: '', text: `旧 ${index}`, tags: [] })).slice(-limit), total: 4 };
    },
};
const viaReadJournal = await createJournalSource({ store: readJournalStore }).list({ limit: 2 });
assert.equal(viaReadJournal.ok, true);
assert.equal(viaReadJournal.entries.length, 2);

/* journal 没有 API（主插件未装）→ ok:false，不抛 */
const noApiJournal = createJournalSource({ getStore: async () => null });
const noApi = await noApiJournal.list();
assert.equal(noApi.ok, false);
assert.equal(noApi.reason, 'journal-api-missing');

/* ────────────────────────── A 档 service（假 sessionQuery） ────────────────────────── */
const fakeSessionQuery = {
    sessions: [
        { id: 'session-old', updatedAt: 1_700_000_000_000 },
        { id: 'session-new', updatedAt: 1_800_000_000_000 },
        { id: 'session-mid', updatedAt: 1_750_000_000_000 },
    ],
    async listSessions() {
        return this.sessions;
    },
    async readSession(id) {
        return { events: sessionEvents({ user: `问题 ${id}`, assistant: `结论：依赖用 tarball 装（${id}）` }) };
    },
};

const serviceSource = createServiceSource({ sessionQuery: fakeSessionQuery, maxSessions: 2, maxChars: 4000 });
assert.equal(serviceSource.available(), true);
const serviceList = await serviceSource.list();
assert.equal(serviceList.ok, true);
assert.equal(serviceList.source, SOURCE.SERVICE);
assert.equal(serviceList.attempted, 2, '最多读 crossMaxSessions 个会话（新的优先）');
assert.ok(serviceList.entries.every((entry) => entry.session !== 'session-old'), '最老的那个被 maxSessions 挡在外面');
assert.ok(serviceList.entries.some((entry) => entry.session === 'session-new'), '最新的会话一定在内');
assert.ok(serviceList.entries.some((entry) => entry.text.includes('依赖用 tarball 装')), '取到 assistant 的 text 块');
assert.ok(serviceList.entries.some((entry) => entry.text === '问题 session-new'), '取到 user/message（source.kind=user）');
assert.ok(!serviceList.entries.some((entry) => entry.text.includes('时间上下文')), '注入类 user/message 不取样');
assert.ok(!serviceList.entries.some((entry) => entry.text.includes('思维链')), 'reasoning 块不取样');
assert.ok(serviceList.entries.every((entry) => entry.origin === SOURCE.SERVICE));

/* available() 只认 `listSessions`（拿不到就降级，不假装能用） */
assert.equal(createServiceSource().available(), false);
assert.equal((await createServiceSource().list()).reason, 'service-unavailable');
assert.equal(createServiceSource({ sessionQuery: { search() {} } }).available(), false, '只有 search 的实例不算可用（且我们从不调 search）');

/* 读会话抛错：整档失败（ok:false），不抛 */
const throwingService = createServiceSource({
    sessionQuery: {
        async listSessions() {
            return [{ id: 's1' }, { id: 's2' }];
        },
        async readSession() {
            throw new Error('SESSION_QUERY_SEARCH_DISABLED');
        },
    },
});
assert.equal((await throwingService.list()).reason, 'service-read-failed');

/* 总量有上限：maxChars 到顶就停 */
const manySessions = Array.from({ length: 10 }, (_, index) => ({ id: `s${index}`, updatedAt: 1_800_000_000_000 - index }));
const chatty = createServiceSource({
    sessionQuery: {
        async listSessions() {
            return manySessions;
        },
        async readSession(id) {
            return { events: sessionEvents({ user: 'x', assistant: 'z'.repeat(300) }) };
        },
    },
    maxChars: 700,
});
const bounded = await chatty.list();
assert.ok(bounded.entries.length >= 1, '至少装一条');
assert.ok(bounded.entries.reduce((sum, entry) => sum + entry.text.length, 0) <= 700, '总量不超过 maxChars');

/* ────────────────────────── B 档 files（合成多帧 zstd） ────────────────────────── */
const { home, cleanup } = makeHome('pmc-sources-files');
try {
    const NOW = 1_800_000_000_000;
    const linesFor = (cwd, user, assistant) => sessionEvents({ cwd, user, assistant }).map((event) => JSON.stringify(event));

    /**
     * 造一个会话目录：`<会话根>/<cwd编码>/<session-id>/session.v4.jsonl.zstd`。
     *
     * 每个用例用**独立的会话根**：这样「一个坏文件」与「整档降级」两条断言互不干扰
     * （否则坏文件会按帧摊薄到整档失败率里，断言就要跟着算分数）。
     */
    const writeSession = (root, bucket, sessionId, lines, options = {}) => {
        const dir = join(root, bucket, sessionId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'session.v4.jsonl.zstd'), multiFrame(lines, options));
        return join(dir, 'session.v4.jsonl.zstd');
    };

    if (HAS_ZSTD) {
        const goodRoot = join(home, 'sessions-good');
        const fileA = writeSession(goodRoot, 'enc-a', 'session-a', linesFor('D:\\proj\\a', '问题 A', '结论 A：依赖用 tarball 装'));
        writeSession(goodRoot, 'enc-b', 'session-b', linesFor('D:\\proj\\b', '问题 B', '结论 B：别的地方的结论'));
        writeSession(goodRoot, 'enc-a', 'session-c', linesFor('D:\\proj\\a', '问题 C', '结论 C：改完 lib 要重启 DSH'));

        /* 单文件：多帧全部解开 */
        const read = readSessionFile(fileA, { maxEvents: 50 });
        assert.equal(read.ok, true, `合成多帧应能解开：${read.reason}`);
        assert.equal(read.failed, 0);
        assert.equal(read.failureRate, 0);
        assert.equal(read.frames, 4, '4 个事件 = 4 帧');
        assert.equal(read.totalEvents, 4);
        assert.equal(read.events[0].type, 'session');
        assert.equal(read.events[3].type, 'assistant/message');

        /* maxEvents 只保留尾部 */
        const tailOnly = readSessionFile(fileA, { maxEvents: 2 });
        assert.equal(tailOnly.events.length, 2);
        assert.equal(tailOnly.totalEvents, 4, 'totalEvents 仍是全部');

        /* 切帧：magic 计数与帧数一致 */
        const { frames, prefix } = splitZstdFrames(multiFrame(['a', 'b', 'c']));
        assert.equal(frames.length, 3);
        assert.equal(prefix, 0);
        assert.equal(decodeMultiFrame(multiFrame(['a', 'b'])).text, 'a\nb\n');

        /* files 档：cwd 过滤 + 每桶内最新的优先 */
        const filesSource = createFilesSource({ sessionsDir: goodRoot, cwd: 'D:\\proj\\a', lookbackDays: 7, maxSessions: 5 });
        assert.equal(filesSource.available(), true);
        const filesList = await filesSource.list({ cwd: 'D:\\proj\\a', now: Date.now() });
        assert.equal(filesList.ok, true, `files 档应可用：${filesList.reason}`);
        assert.equal(filesList.failedFrames, 0, '好样本 0 失败帧');
        assert.ok(filesList.entries.every((entry) => !entry.text.includes('结论 B')), '别的 cwd 的会话不算本桶素材');
        assert.ok(filesList.entries.some((entry) => entry.text.includes('结论 A')));
        assert.ok(filesList.entries.some((entry) => entry.text.includes('结论 C')));
        assert.ok(filesList.entries.every((entry) => entry.origin === SOURCE.FILES));

        /* maxSessions：最多碰 N 个文件（mtime 最新在前） */
        const one = createFilesSource({ sessionsDir: goodRoot, cwd: '', lookbackDays: 3650, maxSessions: 1 });
        const oneList = await one.list({ now: Date.now() });
        assert.ok(oneList.attempted <= 1, `maxSessions=1 时最多碰 1 个文件，实得 ${oneList.attempted}`);
        assert.equal(oneList.ok, true);
        assert.ok(oneList.entries.every((entry) => entry.session !== ''));

        /* 回溯窗口：把 now 推到很久以后 ⇒ 一个文件都不碰 */
        const expired = createFilesSource({ sessionsDir: goodRoot, cwd: '', lookbackDays: 1 });
        const expiredList = await expired.list({ now: Date.now() + 400 * 86_400_000 });
        assert.equal(expiredList.attempted, 0, '近 1 天的窗口里没有文件');
        assert.equal(expiredList.entries.length, 0);

        /* 单个坏文件（4 帧坏 1 帧 = 25% > 5%）⇒ readSessionFile 降级 */
        const badRoot = join(home, 'sessions-bad');
        const oneBad = writeSession(badRoot, 'enc-a', 'session-bad', linesFor('D:\\proj\\a', '问题', '结论'), { corruptFrame: 1 });
        const badRead = readSessionFile(oneBad);
        assert.equal(badRead.failed, 1, '坏帧被计数');
        assert.equal(badRead.failureRate > MAX_FRAME_FAILURE_RATE, true);
        assert.equal(badRead.ok, false);
        assert.equal(badRead.reason, 'decode-degraded');

        /* 整档降级：两个全坏文件 ⇒ files 档 ok:false（不拿半截日志当证据） */
        const degradedRoot = join(home, 'sessions-degraded');
        writeSession(degradedRoot, 'enc-a', 'session-d1', linesFor('D:\\proj\\a', '问', '答'), { corruptAll: true });
        writeSession(degradedRoot, 'enc-a', 'session-d2', linesFor('D:\\proj\\a', '问', '答'), { corruptAll: true });
        const degradedList = await createFilesSource({ sessionsDir: degradedRoot, cwd: '', lookbackDays: 3650 })
            .list({ now: Date.now() });
        assert.equal(degradedList.ok, false);
        assert.equal(degradedList.reason, 'decode-degraded');
        assert.equal(degradedList.degraded, true);
        assert.equal(degradedList.failureRate, 1);

        /* 24 帧坏 1 帧 ≈ 4.2% < 5% ⇒ 可用（跳过那一帧） */
        const mostlyRoot = join(home, 'sessions-mostly');
        const manyLines = Array.from({ length: 24 }, (_, index) => JSON.stringify({
            type: 'assistant/message',
            seq: index,
            time: NOW + index,
            data: { message: { role: 'assistant', content: [{ type: 'text', text: `第 ${index} 条结论` }] } },
        }));
        const mostlyOk = writeSession(mostlyRoot, 'enc-a', 'session-mostly', manyLines, { corruptFrame: 5 });
        const mostlyRead = readSessionFile(mostlyOk);
        assert.equal(mostlyRead.ok, true, `1/24 失败在容忍范围内：${mostlyRead.reason}`);
        assert.equal(mostlyRead.failed, 1);
        assert.equal(mostlyRead.events.length, 23);
        const mostlyList = await createFilesSource({ sessionsDir: mostlyRoot, cwd: '', lookbackDays: 3650 })
            .list({ now: Date.now() });
        assert.equal(mostlyList.ok, true, '单帧坏不拖垮整档');
        assert.equal(mostlyList.failedFrames, 1);
    } else {
        console.log('SKIP 多帧 zstd 用例：当前 node 没有 zstdCompressSync/zstdDecompressSync');
    }

    /* sessions 目录不存在 ⇒ 可用性 false（降级链会退到 journal） */
    const missing = createFilesSource({ sessionsDir: join(home, 'nope') });
    assert.equal(missing.available(), false);
    assert.equal((await missing.list()).reason, 'sessions-dir-missing');
    assert.deepEqual(missing.limits, { maxSessions: 20, lookbackDays: 7, cwd: '' });
} finally {
    cleanup();
}

/* 读不存在的文件 / 坏文件：不抛，只报原因 */
assert.equal(readSessionFile(join(tmpdir(), 'pmc-missing-session.zstd')).ok, false);
assert.equal(readSessionFile(join(tmpdir(), 'pmc-missing-session.zstd')).reason, 'read-failed');

/* ────────────────────────── 事件 → 素材 ────────────────────────── */
const entries = entriesFromEvents(sessionEvents({ user: '问题', assistant: '结论' }), { origin: 'files', session: 's1', workspaceId: 'ws-1' });
assert.equal(entries.length, 2, '一条 user + 一条 assistant');
assert.deepEqual(entries.map((entry) => entry.tags[0]), ['user', 'assistant']);
assert.equal(entries[0].workspaceId, 'ws-1');
assert.equal(entries[0].session, 's1');
assert.deepEqual(entriesFromEvents([], {}), []);
/* 预算从尾部取：只保留最近的那一条 */
const tailEntries = entriesFromEvents(sessionEvents({ user: '问题', assistant: 'q'.repeat(100) }), { maxChars: 50 });
assert.equal(tailEntries.length, 1);
assert.ok(tailEntries[0].text.length <= 100);

/* ────────────────────────── 降级链行为 ────────────────────────── */
const chain = createSourceChain({
    preferred: 'auto',
    sources: { journal: journalSource, service: serviceSource, files: createFilesSource({ sessionsDir: '/nope' }) },
});
const chained = await chain.list({ limit: 2 });
assert.equal(chained.ok, true);
assert.equal(chained.source, SOURCE.SERVICE, 'service 可用 ⇒ 直接用（不再退到 journal）');
assert.deepEqual(chained.attempts.map((attempt) => attempt.source), [SOURCE.SERVICE]);
assert.deepEqual(chain.chain, [SOURCE.SERVICE, SOURCE.JOURNAL]);

/* service 不可用 → journal 命中（files 不在 auto 链里，连尝试都不该有） */
const fallback = createSourceChain({
    preferred: 'auto',
    sources: { journal: journalSource, service: createServiceSource(), files: createFilesSource({ sessionsDir: '/nope' }) },
});
const fellBack = await fallback.list({ limit: 2 });
assert.equal(fellBack.source, SOURCE.JOURNAL);
assert.deepEqual(fellBack.attempts.map((attempt) => attempt.source), [SOURCE.SERVICE, SOURCE.JOURNAL], 'auto 只试 service 与 journal');

/* 全都失败 → 明确 ok:false，并带完整 attempts */
const allFailed = await createSourceChain({
    preferred: 'auto',
    sources: { journal: noApiJournal, service: createServiceSource() },
}).list();
assert.equal(allFailed.ok, false);
assert.equal(allFailed.reason, 'all-sources-failed');
assert.equal(allFailed.attempts.length, 2);

/* files 档明确配置时仍然会试 */
const filesConfigured = await createSourceChain({
    preferred: 'files',
    sources: { journal: journalSource, files: createFilesSource({ sessionsDir: '/nope' }) },
}).list();
assert.deepEqual(filesConfigured.attempts.map((attempt) => [attempt.source, attempt.reason]), [
    [SOURCE.FILES, 'unavailable'],
    [SOURCE.JOURNAL, 'ok'],
]);

/* ────────────────────────── 频次升格 ────────────────────────── */
const promoted = frequencyPromotion([
    { text: '- 依赖用 tarball 装。', workspaceId: 'ws-1', ts: 1 },
    { text: '依赖用 tarball 装', workspaceId: 'ws-2', ts: 2 },
    { text: '只出现一次的结论', workspaceId: 'ws-1' },
], { minHits: 2 });
assert.equal(promoted.length, 1);
assert.equal(promoted[0].hits, 2);
assert.deepEqual(promoted[0].workspaces, ['ws-1', 'ws-2']);
assert.equal(promoted[0].content, '依赖用 tarball 装', '取更短的那份当正文');

assert.equal(frequencyPromotion([{ text: '只出现一次' }], { minHits: 2 }).length, 0);
assert.equal(frequencyPromotion([{ text: '' }, { text: '   ' }], { minHits: 1 }).length, 0);

/* 逐桶计划：project 只在本桶内升格，_unassigned 跳过，global 跨桶 */
const plan = planCrossRun({
    entries: [
        { text: '依赖用 tarball 装', workspaceId: 'ws-1' },
        { text: '依赖用 tarball 装', workspaceId: 'ws-1' },
        { text: '同一个结论在两处出现', workspaceId: 'ws-1' },
        { text: '同一个结论在两处出现', workspaceId: 'ws-2' },
        { text: '未分组里出现两次', workspaceId: '_unassigned' },
        { text: '未分组里出现两次', workspaceId: '_unassigned' },
    ],
    buckets: [{ workspaceId: 'ws-1' }, { workspaceId: 'ws-2' }, { workspaceId: '_unassigned' }],
    config: { crossPromoteHits: 2, unassignedBucket: '_unassigned' },
});
assert.equal(plan.counts.buckets, 3);
assert.equal(plan.counts.entries, 6);
assert.equal(plan.counts.unassignedSkipped, 2, '_unassigned 不参与 project 归并');
const ws1 = plan.perBucket.find((bucket) => bucket.workspaceId === 'ws-1');
assert.equal(ws1.candidates.length, 1, 'ws-1 桶内只有 tarball 那条出现两次');
assert.equal(ws1.candidates[0].scope, 'project');
assert.ok(plan.perBucket.find((bucket) => bucket.workspaceId === '_unassigned').candidates.length === 0);
const globalContents = plan.global.map((item) => item.content).sort();
assert.deepEqual(globalContents, ['依赖用 tarball 装', '同一个结论在两处出现', '未分组里出现两次'].sort(), 'global 跨桶统计（含 _unassigned）');
assert.ok(plan.global.every((item) => item.scope === 'global'));
assert.ok(plan.global.find((item) => item.content === '同一个结论在两处出现').workspaces.length === 2);

/* ────────────────────────── L2 触发判定 ────────────────────────── */
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const CONFIG = { crossEnabled: true, crossIntervalHours: 24, crossMinEntries: 20 };

assert.equal(decideCross({ config: { ...CONFIG, crossEnabled: false } }).reason, CROSS_REASON.DISABLED);
assert.equal(decideCross({ config: CONFIG, lastRunAt: 0, now: NOW }).reason, CROSS_REASON.FIRST_RUN);
assert.equal(decideCross({ config: CONFIG, lastRunAt: NOW - 25 * HOUR, now: NOW }).reason, CROSS_REASON.INTERVAL);
assert.equal(decideCross({ config: CONFIG, lastRunAt: NOW - 1 * HOUR, newEntries: 25, now: NOW }).reason, CROSS_REASON.MIN_ENTRIES);
const tooSoon = decideCross({ config: CONFIG, lastRunAt: NOW - 1 * HOUR, newEntries: 3, now: NOW });
assert.equal(tooSoon.run, false);
assert.equal(tooSoon.reason, CROSS_REASON.TOO_SOON);
assert.equal(tooSoon.nextAt, NOW - 1 * HOUR + 24 * HOUR);
assert.equal(decideCross({ config: CONFIG, lastRunAt: NOW - 1 * HOUR, newEntries: 25, now: NOW, budgetOk: false }).reason, CROSS_REASON.BUDGET);
assert.equal(decideCross({ config: CONFIG, lastRunAt: NOW - 1 * HOUR, newEntries: 25, now: NOW, locked: false }).run, false);
assert.equal(decideCross({ config: CONFIG, lastRunAt: NOW - 1 * HOUR, newEntries: 0, now: NOW, manual: true }).reason, CROSS_REASON.MANUAL);

/* L2 游标：坏文件不炸，写后能读回 */
const { home: crossHome, cleanup: cleanupCross } = makeHome('pmc-cross');
try {
    const cursorFile = join(crossHome, 'consolidate', 'cross-cursor.json');
    assert.deepEqual(readCrossCursor(cursorFile), { lastRunAt: 0, lastCount: 0, lastRunId: '' });
    mkdirSync(join(crossHome, 'consolidate'), { recursive: true });
    writeFileSync(cursorFile, '{坏掉了', 'utf8');
    assert.equal(readCrossCursor(cursorFile).lastRunAt, 0);
    assert.equal(writeCrossCursor({ lastRunAt: NOW, lastCount: 7, lastRunId: 'r1' }, cursorFile), true);
    assert.deepEqual(readCrossCursor(cursorFile), { lastRunAt: NOW, lastCount: 7, lastRunId: 'r1' });
} finally {
    cleanupCross();
}

/* ────────────────────────── 逐桶迭代 ────────────────────────── */
assert.deepEqual(listPendingBuckets(join(tmpdir(), 'pmc-definitely-missing', 'pending')), []);

const { home: home2, cleanup: cleanup2 } = makeHome('pmc-buckets');
try {
    mkdirSync(join(home2, 'pending', 'ws-1'), { recursive: true });
    mkdirSync(join(home2, 'pending', '_unassigned'), { recursive: true });
    mkdirSync(join(home2, 'pending', 'archive'), { recursive: true });
    writeFileSync(join(home2, 'pending', 'ws-1', 'session-a.jsonl'), '', 'utf8');
    writeFileSync(join(home2, 'pending', 'ws-1', 'not-a-jsonl.txt'), '', 'utf8');
    const buckets = listPendingBuckets(join(home2, 'pending'));
    assert.deepEqual(buckets, [
        { workspaceId: '_unassigned', sessions: [] },
        { workspaceId: 'ws-1', sessions: ['session-a.jsonl'] },
    ], 'archive 不算桶，非 jsonl 文件不算会话');
} finally {
    cleanup2();
}

console.log('✓ sources.test.mjs 全部通过');
