/**
 * 自动触发（M2）：`turn/end` → 写 L0 → 门槛到了才花钱（02 §6 / §6.5 / §7.0 / §7.1）。
 *
 * 钉住的十条：
 *  1. `completed` 回合 → **正好一行** L0，字段与 02 §7.0 的行形状逐个对齐；
 *  2. `aborted` / `error` / `max-tokens` → 零行（中断回合直接丢）；
 *  3. 子代理（`delegationDepth > 0`）→ 零行（`config.subagent` 默认关）；
 *  4. 同一个回合的第二次事件 → 不重复写；
 *  5. 门槛达标 → 消费**排进微任务**（处理器同步返回、当时一行都没跑）；
 *     门槛未到 → 什么都不排；
 *  6. `agent/status` 只做补漏：`running` 不干活，`idle` / `maintenance` 补写漏掉的回合且不重写；
 *  7. `agent/disposed` → 硬上限收尾，超时/抛错都不穿透事件分发；
 *  8. 定时扫描能捡起事件路径漏掉的桶，并按 `pendingMaxAgeDays` 清过期行；
 *  9. `enabled: false` → 什么都不发生；启动时关着、之后打开也能干活（A0 缺陷）；
 *     10. 连续失败喂 `budget` 退避（5/10/20 分钟），失败不消费行。
 *
 * 全部用例：临时 DSH_HOME + 每个用例自己的 `pending-<label>` 目录 + 注入的假执行体，
 * 不触网、不碰真实 `~/.dsh`，也不会因为别的用例留下的暂存行把计数搅乱。
 *
 * 跑法：node test/autotrigger.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTO_DROP, createAutoTrigger, delegationDepthOf, eventsOf } from '../lib/autotrigger.js';
import { backoffMinutes } from '../lib/budget.js';
import { readCursor } from '../lib/cursor.js';
import { appendRow, readRows, readUnconsumed } from '../lib/pending.js';
import { readLastRun } from '../lib/runlog.js';
import { NOW, fakeModel, makeHome, makeRuntime, makeTurn, memoryStore, seedRows } from './_helpers.mjs';

/* ────────────────────────────── 夹具 ────────────────────────────── */

const SESSION_MAIN = 'session-auto';
const SESSION_THR = 'session-thr';
const SESSION_SCAN = 'session-scan';
const SESSION_STATUS = 'session-status';

/** 工作区注册表：三个会话各自归属一个桶（未登记的会话会落 `_unassigned`，另有专门用例）。 */
const REGISTRY = {
    workspaces: {
        'ws-auto': { path: '/proj/auto', title: '工作区一', sessionIds: [SESSION_MAIN] },
        'ws-thr': { path: '/proj/thr', title: '工作区二', sessionIds: [SESSION_THR] },
        'ws-scan': { path: '/proj/scan', title: '工作区三', sessionIds: [SESSION_SCAN] },
        'ws-status': { path: '/proj/status', title: '工作区四', sessionIds: [SESSION_STATUS] },
    },
};

const BASE_CONFIG = { enabled: true, dryRun: true, pendingMaxRows: 200, pendingMaxAgeDays: 30 };

/** 假会话：`header` 形状与宿主一致（`delegationDepth` / `cwd`）。 */
function sessionOf(id, events, header = {}) {
    return {
        id,
        header: { cwd: '/proj/auto', delegationDepth: 0, ...header },
        events,
        snapshotEvents() {
            return this.events;
        },
    };
}

/** `turn/end` 事件（载荷形状来自 M0 实测）。 */
function turnEnd(turn, kind = 'completed') {
    return { type: 'turn/end', seq: 9_999, time: NOW + 1, data: { turn, reason: { kind } } };
}

/** 假 ctx：监听表 + effect 表 + 收集 warn（`ctx.on` 返回 disposer，与 cordis 一致）。 */
function fakeCtx({ projections } = {}) {
    const listeners = new Map();
    const effects = [];
    const warns = [];
    return {
        listeners,
        effects,
        warns,
        logger: { info() {}, debug() {}, warn: (message) => warns.push(String(message)) },
        on(type, handler) {
            listeners.set(type, handler);
            return () => listeners.delete(type);
        },
        effect(fn) {
            effects.push(fn);
        },
        get(service) {
            return service === 'sessionProjections' ? projections : undefined;
        },
    };
}

/** 等微任务 + 一个宏任务边界（消费是 `void async`，要给它机会跑完再断言）。 */
function flush() {
    return new Promise((resolve) => {
        setImmediate(resolve);
    });
}

const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});

/** 足够长（≥ 80 字符）的结论正文，保证取样规则 4 取到它。 */
const LONG_ASSISTANT = '因为回合结束必须立刻返回：写一行 L0 只是一次本地追加，真正的抽取要等门槛达标之后在微任务里做，'
    + '这样用户请求路径上永远不会多一次 await。';

const { home, cleanup } = makeHome('pmc-autotrigger');

/** 每个用例一个独立 pending 目录（同一个临时 DSH_HOME）。 */
function freshRuntime(label, configOverrides = {}) {
    const runtime = makeRuntime({ registry: REGISTRY, config: { ...BASE_CONFIG, ...configOverrides } });
    runtime.pendingDir = join(home, `pending-${label}`);
    return runtime;
}

/** 假执行体：只记录被调用，不改行、不花钱。 */
function recordingRunner(sink) {
    return async (bucket) => {
        sink.push(bucket);
        return { status: 'OK', bucket: bucket.workspaceId };
    };
}

try {
    /* ── 1. completed → 正好一行 L0，字段齐 ── */
    const runtime = freshRuntime('main');
    const runs = [];
    const trigger = createAutoTrigger({ runtime, now: NOW, runConsume: recordingRunner(runs) });

    const userText = '为什么自动沉淀不在这里直接调模型？';
    const counter = { seq: 0 };
    const events1 = makeTurn({ turn: 1, user: userText, assistant: [LONG_ASSISTANT] }, counter);
    const session = sessionOf(SESSION_MAIN, events1);

    const returned = trigger.onSessionEvent(session, turnEnd(1));
    assert.equal(returned, undefined, '事件处理器不该有返回值（宿主的 dispatch 不等它）');

    const rows = readRows({ pendingDir: runtime.pendingDir, bucket: 'ws-auto', sessionId: SESSION_MAIN });
    assert.equal(rows.length, 1, 'completed 回合要正好写一行');
    const row = rows[0].row;
    assert.equal(row.turn, 1);
    assert.equal(row.session, SESSION_MAIN);
    assert.equal(row.workspaceId, 'ws-auto');
    assert.equal(row.workspaceTitle, '工作区一', '标题来自工作区注册表');
    assert.equal(row.cwd, '/proj/auto');
    assert.equal(row.user, userText);
    assert.equal(row.assistant, LONG_ASSISTANT);
    assert.equal(row.chars, userText.length + LONG_ASSISTANT.length);
    assert.equal(row.endedAt, events1.at(-1).time, 'endedAt 取 turn/end 事件时间');
    assert.ok(row.seqFrom > 0, 'seqFrom 取用户消息的 seq');
    assert.equal(row.consumed, false);
    assert.deepEqual(
        Object.keys(row).sort(),
        ['assistant', 'chars', 'consumed', 'cwd', 'endedAt', 'seqFrom', 'session', 'turn', 'user', 'workspaceId', 'workspaceTitle'],
        '行形状必须是 02 §7.0 定的那 11 个键',
    );

    /* 游标推进到这一回合 */
    assert.equal(readCursor(runtime.cursorFile).sessions['ws-auto:session-auto'].turn, 1);

    /* 门槛未到（1 轮 / 小字符数）→ 不排消费 */
    await flush();
    assert.deepEqual(runs, [], '门槛未到不许消费');

    /* ── 2. 中断回合（aborted / error / max-tokens）→ 零行 ── */
    for (const [index, kind] of ['aborted', 'error', 'max-tokens'].entries()) {
        const turn = 10 + index;
        const localCounter = { seq: 0 };
        const events = makeTurn({ turn, user: '这一轮会被打断', assistant: [LONG_ASSISTANT], reason: kind }, localCounter);
        trigger.onSessionEvent(sessionOf(SESSION_MAIN, events), turnEnd(turn, kind));
    }
    assert.equal(
        readRows({ pendingDir: runtime.pendingDir, bucket: 'ws-auto', sessionId: SESSION_MAIN }).length,
        1,
        '中断回合连 L0 都不许写（含 max-tokens 这种「有正文」的）',
    );

    /* ── 3. 子代理默认不沉淀；显式 subagent:true 才写 ── */
    const subCounter = { seq: 0 };
    const subEvents = makeTurn({ turn: 1, user: '子代理的问题', assistant: [LONG_ASSISTANT] }, subCounter);
    trigger.onSessionEvent(sessionOf('session-sub', subEvents, { delegationDepth: 1 }), turnEnd(1));
    assert.equal(
        readRows({ pendingDir: runtime.pendingDir, bucket: '_unassigned', sessionId: 'session-sub' }).length,
        0,
        'delegationDepth > 0 且 config.subagent=false ⇒ 零行',
    );
    assert.equal(delegationDepthOf({ header: { delegationLevel: 1 } }), 1, 'A0 的 delegationLevel 也认');

    const subRuntime = freshRuntime('subagent', { subagent: true });
    const subTrigger = createAutoTrigger({ runtime: subRuntime, now: NOW });
    subTrigger.onSessionEvent(sessionOf('session-sub', subEvents, { delegationDepth: 1 }), turnEnd(1));
    assert.equal(
        readRows({ pendingDir: subRuntime.pendingDir, bucket: '_unassigned', sessionId: 'session-sub' }).length,
        1,
        'subagent:true ⇒ 子代理回合也写；未登记的会话落 _unassigned',
    );

    /* ── 4. 同一回合的第二个事件 → 不重复写 ── */
    trigger.onSessionEvent(session, turnEnd(1));
    trigger.onSessionEvent(session, turnEnd(1));
    assert.equal(
        readRows({ pendingDir: runtime.pendingDir, bucket: 'ws-auto', sessionId: SESSION_MAIN }).length,
        1,
        '重复投递不许写出第二行',
    );

    /* ── 5. 门槛：未达标不排、达标只排一次且不阻塞事件处理器 ── */
    const thrRuntime = freshRuntime('threshold');
    const thrRuns = [];
    const thrTrigger = createAutoTrigger({ runtime: thrRuntime, now: NOW, runConsume: recordingRunner(thrRuns) });

    seedRows({ pendingDir: thrRuntime.pendingDir, bucket: 'ws-thr', sessionId: SESSION_THR, count: 2 });
    const thrCounter = { seq: 0 };
    const thrEvents = makeTurn({ turn: 3, user: '第三轮的问题', assistant: [LONG_ASSISTANT] }, thrCounter);
    assert.equal(thrTrigger.onSessionEvent(sessionOf(SESSION_THR, thrEvents), turnEnd(3)), undefined);
    assert.equal(
        readRows({ pendingDir: thrRuntime.pendingDir, bucket: 'ws-thr', sessionId: SESSION_THR }).length,
        3,
        'L0 写入是同步的（处理器返回前就落盘）',
    );
    assert.deepEqual(thrRuns, [], '处理器返回时消费还没开始（异步在微任务里）');
    await flush();
    assert.deepEqual(thrRuns, [], '3 轮 < minTurns 6 且字符远小于 8000 ⇒ 不消费');

    /* 补到 6 轮：seed 5 行 + 本轮事件 = 6 轮 */
    seedRows({ pendingDir: thrRuntime.pendingDir, bucket: 'ws-thr', sessionId: SESSION_THR, count: 5, startTurn: 4 });
    const sixthCounter = { seq: 0 };
    const sixthEvents = makeTurn({ turn: 9, user: '第六轮的问题', assistant: [LONG_ASSISTANT] }, sixthCounter);
    thrTrigger.onSessionEvent(sessionOf(SESSION_THR, sixthEvents), turnEnd(9));
    assert.deepEqual(thrRuns, [], '达标也不许在处理器里同步跑（必须等微任务）');
    await flush();
    assert.equal(thrRuns.length, 1, '门槛达标 ⇒ 排一次消费');
    assert.equal(thrRuns[0].workspaceId, 'ws-thr', '只消费达标的那一个桶');
    assert.equal(thrRuns[0].title, '工作区二', '桶信息来自注册表');

    /* 同一 tick 内多次达标事件：只排一次 */
    const multiRuntime = freshRuntime('multi');
    const multiRuns = [];
    const multiTrigger = createAutoTrigger({ runtime: multiRuntime, now: NOW, runConsume: recordingRunner(multiRuns) });
    seedRows({ pendingDir: multiRuntime.pendingDir, bucket: 'ws-thr', sessionId: SESSION_THR, count: 6 });
    multiTrigger.onSessionEvent(sessionOf(SESSION_THR, makeTurn({ turn: 7, user: 'a', assistant: [LONG_ASSISTANT] }, { seq: 0 })), turnEnd(7));
    multiTrigger.onSessionEvent(sessionOf(SESSION_THR, makeTurn({ turn: 8, user: 'b', assistant: [LONG_ASSISTANT] }, { seq: 0 })), turnEnd(8));
    await flush();
    assert.equal(multiRuns.length, 1, '同一 tick 只排一次（真正的并发由 budget 管）');

    /* ── 5b. 默认执行体：门槛达标 → 微任务里真的跑 runL1（并先调 prepare 接模型） ── */
    const e2eStore = memoryStore({ home, factText: '## 约定\n\n- 已有的结论\n' });
    const e2eModel = fakeModel({
        extraction: JSON.stringify({ memories: [{ scope: 'global', content: '自动触发也能真的落进 FACT', confidence: 'high' }] }),
    });
    const e2eRuntime = makeRuntime({ store: e2eStore, model: e2eModel, registry: REGISTRY, config: { ...BASE_CONFIG, dryRun: false } });
    e2eRuntime.pendingDir = join(home, 'pending-e2e');
    let prepared = 0;
    const e2eTrigger = createAutoTrigger({
        runtime: e2eRuntime,
        now: NOW,
        prepare() {
            prepared += 1;
        },
    });
    seedRows({ pendingDir: e2eRuntime.pendingDir, bucket: 'ws-auto', sessionId: SESSION_MAIN, count: 5 });
    const e2eEvents = makeTurn({ turn: 6, user: '第六轮的问题', assistant: [LONG_ASSISTANT] }, { seq: 0 });
    e2eTrigger.onSessionEvent(sessionOf(SESSION_MAIN, e2eEvents), turnEnd(6));
    await sleep(50);
    assert.equal(prepared, 1, '自动消费也要走 prepare（后台没有命令入口来接线）');
    assert.ok(
        readFileSync(e2eStore.factPath(), 'utf8').includes('自动触发也能真的落进 FACT'),
        `默认执行体要真的跑通 runL1，实得：${readFileSync(e2eStore.factPath(), 'utf8')}`,
    );
    assert.equal(
        readUnconsumed({ pendingDir: e2eRuntime.pendingDir, bucket: 'ws-auto' }).length,
        0,
        '真跑成功后 6 行都被标记消费',
    );
    assert.equal(readLastRun({ file: e2eRuntime.runLog.path }).status, 'OK');

    /* ── 6. agent/status：只补漏，running 不干活，重复 idle 不重写 ── */
    const statusRuntime = freshRuntime('status');
    const statusCtx = fakeCtx();
    const statusRuns = [];
    const statusTrigger = createAutoTrigger({
        runtime: statusRuntime,
        ctx: statusCtx,
        now: NOW,
        runConsume: recordingRunner(statusRuns),
    });
    const missedCounter = { seq: 0 };
    const missedEvents = [
        ...makeTurn({ turn: 1, user: '第一轮', assistant: [LONG_ASSISTANT] }, missedCounter),
        ...makeTurn({ turn: 2, user: '第二轮', assistant: [LONG_ASSISTANT] }, missedCounter),
    ];
    const statusSession = sessionOf(SESSION_STATUS, missedEvents);

    /* 事件路径一个都没跑过 ⇒ 游标 0，投影说最后回合是 2 */
    const projections = { stateOf: (target, name) => (name === 'turnBoundary' ? { lastTurn: 2 } : null) };
    const withProjections = createAutoTrigger({
        runtime: statusRuntime,
        ctx: fakeCtx({ projections }),
        now: NOW,
        runConsume: recordingRunner(statusRuns),
    });

    /* running：绝对不干活 */
    withProjections.onStatus({ agent: { session: statusSession }, status: 'running' });
    assert.equal(
        readRows({ pendingDir: statusRuntime.pendingDir, bucket: 'ws-status', sessionId: SESSION_STATUS }).length,
        0,
        'status=running 时绝不做任何工作',
    );

    /* idle：用 turnBoundary 补写漏掉的 2 个回合 */
    withProjections.onStatus({ agent: { session: statusSession }, status: 'idle' });
    assert.equal(
        readRows({ pendingDir: statusRuntime.pendingDir, bucket: 'ws-status', sessionId: SESSION_STATUS }).length,
        2,
        '事件路径漏了回合 ⇒ 由 status 兜底补写',
    );
    assert.equal(readCursor(statusRuntime.cursorFile).sessions['ws-status:session-status'].turn, 2, '补写后游标推进到最后一轮');

    /* maintenance 也是 idle 语义，但不许重写 */
    withProjections.onStatus({ agent: { session: statusSession }, status: 'maintenance' });
    assert.equal(
        readRows({ pendingDir: statusRuntime.pendingDir, bucket: 'ws-status', sessionId: SESSION_STATUS }).length,
        2,
        '重复的 idle / maintenance 不许写出第二份',
    );

    /* 没有 sessionProjections 服务时退回「数 turn/end」 */
    statusTrigger.onStatus({ agent: { session: statusSession }, status: 'idle' });
    assert.equal(
        readRows({ pendingDir: statusRuntime.pendingDir, bucket: 'ws-status', sessionId: SESSION_STATUS }).length,
        2,
        '拿不到投影时数事件兜底（已写过的不重复）',
    );

    /* ── 7. agent/disposed：硬上限收尾，绝不抛 ── */
    const hangRuntime = freshRuntime('dispose-hang');
    seedRows({ pendingDir: hangRuntime.pendingDir, bucket: 'ws-auto', sessionId: SESSION_MAIN, count: 1 });
    const hangWarns = [];
    const hangTrigger = createAutoTrigger({
        runtime: hangRuntime,
        now: NOW,
        disposeTimeoutMs: 20,
        runConsume: () => new Promise(() => {
            /* 永不 resolve：模拟一个卡住的 LLM 调用 */
        }),
        logger: { info() {}, debug() {}, warn: (message) => hangWarns.push(String(message)) },
    });
    let threw = false;
    try {
        hangTrigger.onDisposed({ agent: { session: sessionOf(SESSION_MAIN, []) } });
    } catch {
        threw = true;
    }
    assert.equal(threw, false, 'disposed 处理器绝不许把异常抛回宿主');
    await sleep(60);
    assert.ok(hangWarns.some((message) => message.includes('收尾未完成')), `要记一条超时 warn，实得：${JSON.stringify(hangWarns)}`);
    assert.equal(
        readUnconsumed({ pendingDir: hangRuntime.pendingDir, bucket: 'ws-auto' }).length,
        1,
        '超时放弃后行仍留在暂存里（绝不丢数据）',
    );

    /* 执行体直接抛错：同样不穿透，且失败要喂退避 */
    const throwRuntime = freshRuntime('dispose-throw');
    seedRows({ pendingDir: throwRuntime.pendingDir, bucket: 'ws-auto', sessionId: SESSION_MAIN, count: 1 });
    const throwTrigger = createAutoTrigger({
        runtime: throwRuntime,
        now: NOW,
        disposeTimeoutMs: 1000,
        runConsume: async () => {
            throw new Error('llm 502');
        },
    });
    throwTrigger.onDisposed({ agent: { session: sessionOf(SESSION_MAIN, []) } });
    await flush();
    assert.equal(throwRuntime.budget.snapshot(NOW).failures, 1, '抛错的执行体也要记一次失败');

    /* 没有未消费行的会话：什么都不做 */
    const emptyRuntime = freshRuntime('dispose-empty');
    const emptyRuns = [];
    const emptyTrigger = createAutoTrigger({ runtime: emptyRuntime, now: NOW, runConsume: recordingRunner(emptyRuns) });
    emptyTrigger.onDisposed({ agent: { session: sessionOf(SESSION_MAIN, []) } });
    await flush();
    assert.deepEqual(emptyRuns, [], '没有暂存行 ⇒ 不跑收尾');

    /* ── 8. scan()：捡起事件路径漏掉的桶 + 清过期行 ── */
    const scanRuntime = freshRuntime('scan');
    const scanRuns = [];
    const scanTrigger = createAutoTrigger({ runtime: scanRuntime, now: NOW, runConsume: recordingRunner(scanRuns) });
    seedRows({ pendingDir: scanRuntime.pendingDir, bucket: 'ws-scan', sessionId: SESSION_SCAN, count: 6 });
    /* 一条 40 天前（> pendingMaxAgeDays 30）的未消费行：要被清掉 */
    appendRow({
        pendingDir: scanRuntime.pendingDir,
        bucket: 'ws-old',
        sessionId: 'session-old',
        now: NOW,
        row: {
            turn: 1,
            endedAt: NOW - 40 * 86_400_000,
            seqFrom: 1,
            user: '很老的问题',
            assistant: '很老的结论',
            chars: 104,
            session: 'session-old',
            cwd: '',
            workspaceId: 'ws-old',
            workspaceTitle: '',
            consumed: false,
        },
    });

    assert.deepEqual(scanRuns, [], '扫描前什么都没跑');
    const scanned = scanTrigger.scan();
    assert.deepEqual(scanned.scheduled, ['ws-scan'], '只有达标的桶被排进消费');
    assert.equal(scanned.dropped, 1, '过期未消费行要被清掉');
    assert.equal(readRows({ pendingDir: scanRuntime.pendingDir, bucket: 'ws-old' }).length, 0, '过期行真的没了');
    await flush();
    assert.equal(scanRuns.length, 1, '定时扫描补上了事件路径漏掉的消费');
    assert.equal(scanRuns[0].workspaceId, 'ws-scan');

    /* ── 9. enabled=false：什么都不发生；之后打开还能干活 ── */
    const offRuntime = freshRuntime('disabled', { enabled: false });
    const offCtx = fakeCtx();
    const offRuns = [];
    const offTrigger = createAutoTrigger({ runtime: offRuntime, ctx: offCtx, now: NOW, runConsume: recordingRunner(offRuns) });
    offTrigger.start();
    assert.notEqual(offTrigger.timer, null, '定时器**无条件**注册（开关在每个 tick 里读，A0 缺陷）');

    const offCounter = { seq: 0 };
    const offEvents = makeTurn({ turn: 1, user: '关着的时候', assistant: [LONG_ASSISTANT] }, offCounter);
    offTrigger.onSessionEvent(sessionOf(SESSION_MAIN, offEvents), turnEnd(1));
    offTrigger.onStatus({ agent: { session: sessionOf(SESSION_MAIN, offEvents) }, status: 'idle' });
    offTrigger.onDisposed({ agent: { session: sessionOf(SESSION_MAIN, offEvents) } });
    assert.deepEqual(offTrigger.scan(), { buckets: 0, scheduled: [], dropped: 0 });
    await flush();
    assert.equal(
        readRows({ pendingDir: offRuntime.pendingDir, bucket: 'ws-auto', sessionId: SESSION_MAIN }).length,
        0,
        'enabled=false ⇒ 一行都不写',
    );
    assert.deepEqual(offRuns, [], 'enabled=false ⇒ 一次都不跑');

    /* 之后再打开（设置页就会这么改）：同一个触发器立刻开始干活 */
    offRuntime.config.enabled = true;
    offTrigger.onSessionEvent(sessionOf(SESSION_MAIN, offEvents), turnEnd(1));
    assert.equal(
        readRows({ pendingDir: offRuntime.pendingDir, bucket: 'ws-auto', sessionId: SESSION_MAIN }).length,
        1,
        '打开后立刻生效（不需要重载插件）',
    );
    offTrigger.dispose();

    /* ── 10. 连续失败 → budget 退避（5/10/20 分钟），失败不消费行 ── */
    const backoffRuntime = freshRuntime('backoff');
    const backoffRuns = [];
    const backoffTrigger = createAutoTrigger({
        runtime: backoffRuntime,
        now: NOW,
        runConsume: async (bucket) => {
            backoffRuns.push(bucket);
            throw new Error('上游 502');
        },
    });
    seedRows({ pendingDir: backoffRuntime.pendingDir, bucket: 'ws-scan', sessionId: SESSION_SCAN, count: 6 });

    assert.deepEqual(backoffTrigger.scan().scheduled, ['ws-scan']);
    await flush();
    assert.equal(backoffRuntime.budget.snapshot(NOW).failures, 1);
    assert.equal(backoffRuntime.budget.snapshot(NOW).cooldownUntil, 0, '只失败一次不冷却（可能是抖动）');

    assert.deepEqual(backoffTrigger.scan().scheduled, ['ws-scan'], '还不在冷却里 ⇒ 再试一次');
    await flush();
    const afterTwo = backoffRuntime.budget.snapshot(NOW);
    assert.equal(afterTwo.failures, 2);
    assert.equal(backoffMinutes(2), 5);
    assert.equal(afterTwo.cooldownUntil, NOW + 5 * 60_000, '连续 2 次失败 ⇒ 退避 5 分钟');

    assert.deepEqual(backoffTrigger.scan().scheduled, [], '冷却期间不许再排');
    await flush();
    assert.equal(backoffRuns.length, 2, '冷却期间一次都不许跑');
    assert.equal(
        readUnconsumed({ pendingDir: backoffRuntime.pendingDir, bucket: 'ws-scan' }).length,
        6,
        '失败的运行绝不消费暂存行',
    );

    /* 管线自报 FAIL（而不是抛错）：同样不消费、同样不穿透 */
    const failRuntime = freshRuntime('failstatus');
    const failRuns = [];
    const failTrigger = createAutoTrigger({
        runtime: failRuntime,
        now: NOW + 20 * 60_000,
        runConsume: async (bucket) => {
            failRuns.push(bucket);
            return { status: 'FAIL', skipped: 'extract-failed', reason: 'invalid-json' };
        },
    });
    seedRows({ pendingDir: failRuntime.pendingDir, bucket: 'ws-scan', sessionId: SESSION_SCAN, count: 6 });
    failTrigger.scan();
    await flush();
    assert.equal(failRuns.length, 1);
    assert.equal(
        readUnconsumed({ pendingDir: failRuntime.pendingDir, bucket: 'ws-scan' }).length,
        6,
        'FAIL 的管线条目吊销不了任何行',
    );

    /* ── 11. 生命周期：start() 挂三个监听，dispose() 一个不留 ── */
    const lifeCtx = fakeCtx();
    const lifeRuntime = freshRuntime('lifecycle');
    const lifeTrigger = createAutoTrigger({ runtime: lifeRuntime, ctx: lifeCtx, now: NOW });
    lifeTrigger.start();
    assert.ok(lifeCtx.listeners.has('session/event'), 'M2 主触发走 session/event');
    assert.ok(lifeCtx.listeners.has('agent/status'));
    assert.ok(lifeCtx.listeners.has('agent/disposed'));
    assert.ok(!lifeCtx.listeners.has('agent/pre-step'), '铁律：绝不订阅 pre-step');
    assert.notEqual(lifeTrigger.timer, null, '兜底定时器要真的建起来');

    lifeTrigger.dispose();
    assert.equal(lifeTrigger.timer, null, 'dispose 要清定时器');
    assert.equal(lifeCtx.listeners.size, 0, 'dispose 要摘掉所有监听');
    assert.deepEqual(lifeTrigger.scan(), { buckets: 0, scheduled: [], dropped: 0 }, 'dispose 之后不再扫');

    /* 事件路径确实挂在 ctx 上（用 ctx 上的 handler 走一遍完整链路） */
    const wiredCtx = fakeCtx();
    const wiredRuntime = freshRuntime('wired');
    const wiredRuns = [];
    createAutoTrigger({ runtime: wiredRuntime, ctx: wiredCtx, now: NOW, runConsume: recordingRunner(wiredRuns) }).start();
    const wiredEvents = makeTurn({ turn: 1, user: '走 ctx 的链路', assistant: [LONG_ASSISTANT] }, { seq: 0 });
    wiredCtx.listeners.get('session/event')(sessionOf(SESSION_MAIN, wiredEvents), turnEnd(1));
    assert.equal(
        readRows({ pendingDir: wiredRuntime.pendingDir, bucket: 'ws-auto', sessionId: SESSION_MAIN }).length,
        1,
        'ctx.on("session/event") 注册的处理器就是主触发',
    );

    /* ── 12. 影子档（observe）自动触发与 auto 一致：门槛到了照常排队消费 ── */
    const observeRuntime = freshRuntime('observe', { mode: 'observe', minTurns: 1, minChars: 100 });
    const observeRuns = [];
    const observeTrigger = createAutoTrigger({ runtime: observeRuntime, now: NOW, runConsume: recordingRunner(observeRuns) });
    observeTrigger.onSessionEvent(
        sessionOf(SESSION_MAIN, makeTurn({ turn: 1, user: '影子档也自动跑', assistant: [LONG_ASSISTANT] }, { seq: 0 })),
        turnEnd(1),
    );
    await flush();
    assert.equal(observeRuns.length, 1, 'observe 档与 auto 同口径：门槛到了就自动消费一次');
    assert.equal(observeRuns[0].workspaceId, 'ws-auto');
    assert.equal(
        readRows({ pendingDir: observeRuntime.pendingDir, bucket: 'ws-auto', sessionId: SESSION_MAIN }).length,
        1,
        'L0 照写（影子档也走同一条自动链路）',
    );

    /* off 档则相反：完全不花调用 */
    const offModeRuntime = freshRuntime('off-mode', { mode: 'off', minTurns: 1, minChars: 100 });
    const offModeRuns = [];
    const offModeTrigger = createAutoTrigger({ runtime: offModeRuntime, now: NOW, runConsume: recordingRunner(offModeRuns) });
    offModeTrigger.onSessionEvent(
        sessionOf(SESSION_MAIN, makeTurn({ turn: 1, user: 'off 档静默', assistant: [LONG_ASSISTANT] }, { seq: 0 })),
        turnEnd(1),
    );
    await flush();
    assert.deepEqual(offModeRuns, [], 'off 档不许有任何自动消费');
    assert.equal(
        readRows({ pendingDir: offModeRuntime.pendingDir, bucket: 'ws-auto', sessionId: SESSION_MAIN }).length,
        0,
        'off 档连 L0 都不写',
    );

    /* ── 13. 坏输入不炸（宿主形状变了也不许抛） ── */
    const rough = createAutoTrigger({ runtime: freshRuntime('rough'), now: NOW });
    for (const [session, event] of [
        [undefined, undefined],
        [null, { type: 'turn/end' }],
        [{}, { type: 'turn/end', data: {} }],
        [{ id: SESSION_MAIN }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }],
        [sessionOf(SESSION_MAIN, []), { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }],
    ]) {
        rough.onSessionEvent(session, event);
    }
    rough.onStatus(undefined);
    rough.onStatus({ status: 'idle' });
    rough.onDisposed({ agent: { id: 'agent-x' } });
    rough.onDisposed(undefined);
    assert.deepEqual(eventsOf(undefined), [], 'eventsOf 拿不到事件就给空数组');
    assert.deepEqual(
        Object.values(AUTO_DROP).sort(),
        ['disabled', 'duplicate', 'interrupted', 'no-content', 'no-events', 'no-session', 'no-turn', 'subagent'],
        '丢弃原因是稳定字符串表（日志/排查按它 grep）',
    );
} finally {
    cleanup();
}

console.log('✓ autotrigger.test.mjs 全部通过');
