/**
 * 自动触发（M2）：`turn/end` → 写 L0 → 门槛到了才花钱（02 §6 / §6.5 / §7.0 / §7.1）。
 *
 * 三条硬规矩在**这一层**的落点（02 §6.5）：
 *  1. **回合结束只做本地写**：`turn/end` 到达时最多一次 JSONL 追加 + 一次游标写，
 *     全程同步、无 await、不碰 LLM；是否花钱由 `maybeConsume` 判定，真正执行扔进
 *     微任务（`queueMicrotask`）——事件处理器必须立刻返回，绝不允许拖慢用户请求；
 *  2. **中断回合直接丢**：`reason.kind !== 'completed'` 连 L0 都不写（02 §6.6）；
 *  3. **单飞 + 并发 1**：不在这里加锁（`pipeline` 里 `budget` 已经保证），这里也**不**
 *     做第二次加锁——多排一次消费最多被 `budget` 判 `concurrency-limit`，不会重复花钱。
 *
 * 事件契约（M0 实测，见 `PLAN/M0-findings.md`）：
 *  - `ctx.on('session/event', (session, event) => …)`；`turn/end` 载荷
 *    `{ type:'turn/end', data:{ turn, reason:{ kind:'completed' } } }`；
 *  - `agent/status` 载荷 `{ agent, status }`；`idle` / `maintenance` 都算「会话空了」；
 *  - `agent/disposed` 载荷 `{ agent }`；
 *  - 会话事件流 `session.snapshotEvents?.() ?? session.events`；
 *  - 最后完成的回合号优先用 `ctx.sessionProjections.stateOf(session,'turnBoundary').lastTurn`，
 *    读不到就用 `sampler.countTurns()` 数 `turn/end` 兜底（02 §6.0）。
 *
 * 为什么主触发用 `session/event` 的 `turn/end` 而不是轮询 `agent/status`（M0 建议）：
 * 事件是**每次**都来的、带 `reason.kind`（中断回合必须丢）；`status` 只是状态快照，
 * 漏一次就永远不知道那个回合存在过，而且 `running → idle` 之间的多次往返会被压成一次。
 * 所以 `onStatus` 只做补漏，绝不当主路径。
 *
 * 降级路径（都只做**补漏**，绝不与主路径抢活）：
 *  - `onStatus`：`turnBoundary.lastTurn` 比游标大 ⇒ 事件路径漏了回合，补写 L0；
 *  - `scan()`：`config.idleScanMinutes` 扫一遍所有 pending 桶（阈值达标的补消费 + 过期行清理）；
 *  - `onDisposed`：会话销毁前最多 3s 收尾一次，超时就放弃（行留在暂存里，下次兜底还能捡）。
 */

import { DEFAULT_DISPOSE_TIMEOUT_MS, withTimeout } from './budget.js';
import {
    cursorPath,
    getSessionCursor,
    pendingDir as defaultPendingDir,
    readCursor,
    setSessionCursor,
    writeCursor,
} from './cursor.js';
import { lastRouteFromEvents, readSessionRoute } from './llm.js';
import { isConsolidationEnabled } from './mode.js';
import * as pending from './pending.js';
import { runL1 } from './pipeline.js';
import { STATUS } from './runlog.js';
import { MIN_TEXT_CHARS, countTurns, sampleTurn, turnWindows } from './sampler.js';
import { listPendingBuckets } from './sources.js';
import { TURN_COMPLETED, decideConsume } from './trigger.js';
import { bucketForSession, bucketInfo, loadRegistry } from './workspace.js';

/** 兜底扫描默认间隔（分钟，与 `config.idleScanMinutes` 默认值一致）。 */
export const DEFAULT_IDLE_SCAN_MINUTES = 30;
/** `onStatus` 补漏一次最多补多少回合（防日志被截断/游标被清零时的病态补写）。 */
export const MAX_BACKFILL_TURNS = 12;

/** 丢弃原因（写日志用，字符串要稳定）。 */
export const AUTO_DROP = {
    DISABLED: 'disabled',
    INTERRUPTED: 'interrupted',
    SUBAGENT: 'subagent',
    NO_TURN: 'no-turn',
    NO_SESSION: 'no-session',
    DUPLICATE: 'duplicate',
    NO_CONTENT: 'no-content',
    NO_EVENTS: 'no-events',
};

/** 日志前缀（与 index.js 其它地方一致）。 */
const TAG = '[persona-memory-consolidate]';

/**
 * 取会话 id：宿主会话对象的 `id`；没有就用 `sessionId` / `header.id`。
 *
 * @param {any} value
 * @returns {string} 空串 = 拿不到（调用方直接放弃，绝不猜）。
 */
function sessionIdOf(value) {
    if (value === null || typeof value !== 'object') return '';
    const candidates = [value.id, value.sessionId, value.session?.id, value.header?.id];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
    }
    return '';
}

/**
 * 从事件载荷里取会话对象。
 *
 * `agent/status` / `agent/disposed` 给的是 `{agent}`，会话挂在 `agent.session` 上；
 * 拿不到 `agent.session` 时退化成 agent 本身（某些宿主形状里两者合一）。
 *
 * @param {any} payload
 * @returns {any | null}
 */
function sessionFromPayload(payload) {
    const agent = payload?.agent;
    if (agent?.session !== undefined && agent?.session !== null) return agent.session;
    if (payload?.session !== undefined && payload?.session !== null) return payload.session;
    if (agent !== undefined && agent !== null) return agent;
    return null;
}

/**
 * 会话事件流：`snapshotEvents()` 优先，其次 `events`。**不抛**。
 *
 * @param {any} session
 * @returns {any[]}
 */
export function eventsOf(session) {
    let events;
    try {
        events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined;
    } catch {
        events = undefined;
    }
    if (!Array.isArray(events)) events = session?.events;
    return Array.isArray(events) ? events : [];
}

/**
 * 委派深度（子代理判定）。
 *
 * `header.delegationDepth` 是 M0 实测的口径；`delegationLevel` 是 A0 早期写法，
 * 两个都认——判错的代价是「把子代理的回合写进记忆」，比多认一个字段危险得多。
 *
 * @param {any} session
 * @returns {number}
 */
export function delegationDepthOf(session) {
    const header = session?.header ?? {};
    const raw = header.delegationDepth ?? header.delegationLevel ?? session?.delegationDepth;
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
}

/** 会话 cwd（行里存一份，便于人工排查；拿不到就空串）。 */
function cwdOf(session) {
    const candidates = [session?.header?.cwd, session?.cwd, session?.header?.worktree];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate !== '') return candidate;
    }
    return '';
}

/**
 * 造自动触发器。
 *
 * @param {{
 *   runtime: Record<string, any>,
 *   ctx?: any,
 *   logger?: any,
 *   now?: number | (() => number),
 *   prepare?: () => void | Promise<void>,
 *   runConsume?: (bucket: { workspaceId: string, title?: string, path?: string }) => Promise<any>,
 *   disposeTimeoutMs?: number,
 * }} options
 * @returns {{
 *   start: () => any,
 *   onSessionEvent: (session: any, event: any) => void,
 *   onStatus: (payload: any) => void,
 *   onDisposed: (payload: any) => void,
 *   scan: () => { buckets: number, scheduled: string[], dropped: number },
 *   dispose: () => void,
 *   stats: Record<string, number>,
 * }}
 */
export function createAutoTrigger(options = {}) {
    const runtime = options.runtime ?? {};
    const config = runtime.config ?? {};
    const ctx = options.ctx ?? null;
    const logger = options.logger ?? ctx?.logger;
    const disposeTimeoutMs = Number.isFinite(options.disposeTimeoutMs)
        ? Math.max(1, options.disposeTimeoutMs)
        : DEFAULT_DISPOSE_TIMEOUT_MS;

    const clock = options.now;
    const nowOf = typeof clock === 'function'
        ? clock
        : (Number.isFinite(clock) ? () => clock : () => Date.now());

    const dir = () => runtime.pendingDir ?? defaultPendingDir();
    const cursorFile = () => runtime.cursorFile ?? cursorPath();
    const registryOf = () => runtime.registry ?? loadRegistry(runtime.registryFile);
    const unassigned = () => (typeof config.unassignedBucket === 'string' ? config.unassignedBucket : undefined);

    /**
     * 真实消费执行体：把模型接上（M1 起的「命令触发时才接线」在这里也要走一遍——
     * 自动触发没有命令入口）然后跑**这个桶**的 L1。
     *
     * 为什么是单桶 `runL1` 而不是 `runAllBuckets`：触发点是「这个桶刚攒够」，其它桶
     * 要么没到门槛（`runL1` 自己会判），要么会由它们自己的触发点或兜底扫描处理；
     * 单桶运行也少占一次全局锁的等待。
     */
    const defaultRunConsume = async (bucket) => {
        if (typeof options.prepare === 'function') await options.prepare();
        return runL1({ runtime, bucket });
    };
    const runConsume = typeof options.runConsume === 'function' ? options.runConsume : defaultRunConsume;

    const state = {
        timer: null,
        intervalMs: 0,
        disposed: false,
        /** 已排进微任务的桶（只防同一 tick 重复排队，**不是**流水线锁）。 */
        scheduled: new Set(),
        disposers: [],
        stats: { rows: 0, scheduled: 0, consumed: 0, dropped: 0 },
    };

    /**
     * 记住「这个会话最近一次真实请求用的 route」。
     *
     * 为什么在事件路径上顺手做：`session.requestHeader()` 只有会话对象在手时才读得到，
     * 而沉淀真正跑在微任务/定时器里，那时会话可能已经变了；这里只是读一个结构体，
     * 零 I/O、零 await，不违反「事件处理器不许拖慢请求」。
     * 读不到 requestHeader 就退回事件流里的 `request/header`。
     */
    const rememberRoute = (session, events) => {
        const route = readSessionRoute(session) ?? lastRouteFromEvents(events);
        if (route !== null) runtime.lastRoute = route;
    };

    const warn = (message) => {
        try {
            logger?.warn?.(`${TAG} ${message}`);
        } catch {
            /* 日志本身不能反过来把触发路径弄挂 */
        }
    };

    /** 门槛判定：读该桶未消费行 + `trigger.decideConsume`（纯函数，不花钱）。 */
    const thresholdOf = (bucketId) => {
        const rows = pending.readUnconsumed({ pendingDir: dir(), bucket: bucketId });
        const summary = pending.summarize(rows);
        return decideConsume({
            pendingTurns: summary.turns,
            pendingChars: summary.chars,
            cooldownUntil: typeof runtime.budget?.cooldownUntil === 'function' ? runtime.budget.cooldownUntil() : 0,
            now: nowOf(),
            config,
        });
    };

    /** 预算里已有的连续失败次数（判断「这次失败管线自己记过了没」）。 */
    const failuresOf = () => {
        if (typeof runtime.budget?.snapshot !== 'function') return 0;
        const snapshot = runtime.budget.snapshot(nowOf());
        return Number.isFinite(snapshot?.failures) ? snapshot.failures : 0;
    };

    /**
     * 记一次失败（喂 `budget` 的 5/10/20 分钟退避）。
     *
     * 只有在「管线自己没记过」时才补：`runL1` 的 `finally` 一定会 `settle(token,{ok:false})`，
     * 再补一次会把连续失败数成两倍（退避提前到 10 分钟，且与实际不符）。
     */
    const recordFailure = (before, reason) => {
        const after = failuresOf();
        if (after <= before) {
            if (typeof runtime.budget?.noteFailure === 'function') runtime.budget.noteFailure(nowOf());
            else if (typeof runtime.budget?.settle === 'function') runtime.budget.settle('', { ok: false, now: nowOf() });
        }
        const snapshot = typeof runtime.budget?.snapshot === 'function' ? runtime.budget.snapshot(nowOf()) : null;
        runtime.runLog?.append({
            phase: 'layer1',
            status: STATUS.FAIL,
            reason: `auto-trigger-${reason}`,
            turns: 0,
            chars: 0,
        }, nowOf());
        warn(`自动消费失败（${reason}）：连续失败 ${snapshot?.failures ?? '?'} 次`
            + `${Number.isFinite(snapshot?.cooldownUntil) && snapshot.cooldownUntil > nowOf() ? `，退避到 ${new Date(snapshot.cooldownUntil).toLocaleTimeString()}` : ''}`);
    };

    /**
     * 真正跑一次消费（**只在微任务/定时器里被调用**，永远不 await 在事件路径上）。
     *
     * 失败语义：`runL1` 失败时**不会**标记消费（行留在 pending），所以这里只负责
     * 记日志 + 喂退避，**绝不**动行、绝不把异常抛回事件总线。
     */
    const consume = async (bucket) => {
        const before = failuresOf();
        state.stats.consumed += 1;
        try {
            const result = await runConsume(bucket);
            if (result?.status === STATUS.FAIL) {
                warn(`自动消费失败（${bucket.workspaceId}）：${result?.skipped ?? 'FAIL'} · ${result?.reason ?? ''}`
                    + '（暂存行保留，等门槛/兜底再试）');
            }
            return result ?? null;
        } catch (error) {
            recordFailure(before, String(error?.code ?? 'error'));
            return null;
        }
    };

    /** 把一个桶排进微任务（同 tick 只排一次；真实并发由 `budget` 管）。 */
    const scheduleConsume = (bucket) => {
        const id = String(bucket?.workspaceId ?? '');
        if (id === '' || state.scheduled.has(id)) return false;
        state.scheduled.add(id);
        state.stats.scheduled += 1;
        const run = () => {
            state.scheduled.delete(id);
            if (state.disposed) return;
            void consume(bucket);
        };
        // 微任务：事件处理器必须立刻返回（02 §6.5 规矩 1）。
        if (typeof queueMicrotask === 'function') queueMicrotask(run);
        else Promise.resolve().then(run);
        return true;
    };

    /** 门槛达标就排队消费；返回判定（测试与日志都能看到「为什么不消费」）。 */
    const maybeConsume = (bucket) => {
        if (!isConsolidationEnabled(config)) return { consume: false, reason: AUTO_DROP.DISABLED, turns: 0, chars: 0, which: [] };
        const verdict = thresholdOf(bucket.workspaceId);
        if (verdict.consume === true) scheduleConsume(bucket);
        return verdict;
    };

    /** 该会话是否已经有这个回合的 L0 行（重复事件/重启重投的去重依据）。 */
    const hasRow = (bucketId, sessionId, turn) => {
        const rows = pending.readRows({ pendingDir: dir(), bucket: bucketId, sessionId });
        return rows.some((item) => Number(item.row?.turn) === turn);
    };

    /** 推进游标（单调前进，`setSessionCursor` 内部保证不回退）。 */
    const advanceCursor = (bucketId, sessionId, turn, now) => {
        const file = cursorFile();
        const cursor = readCursor(file);
        setSessionCursor(cursor, bucketId, sessionId, { turn, at: now });
        writeCursor(cursor, file, now);
    };

    /** 游标里的「已处理到第几回合」。 */
    const cursorTurnOf = (bucketId, sessionId) => {
        const cursor = readCursor(cursorFile());
        return getSessionCursor(cursor, bucketId, sessionId).turn;
    };

    /**
     * 会话 → 桶，并守住**会话唯一桶**（P1-5）。
     *
     * 现算出来的归属（路径优先 → sessionIds → 未分组）如果和「这个会话已经落在哪个桶」
     * 不一致，一律**沿用旧桶**，并留一条 WARN。否则同一对话会被拆到两个桶：
     * 两边各跑一次 L1（结论重复写）、游标双键分裂、任一侧都可能永远凑不够门槛。
     *
     * @param {string} sessionId
     * @param {string} cwd
     * @returns {{ workspaceId: string, title: string, path: string }}
     */
    const bucketFor = (sessionId, cwd) => {
        const guessed = bucketForSession(registryOf(), sessionId, { unassigned: unassigned(), cwd });
        const resolved = pending.resolveBucket(dir(), guessed.workspaceId, sessionId);
        if (resolved.adopted !== true) return guessed;
        const info = bucketInfo(registryOf(), resolved.bucket, { unassigned: unassigned() });
        runtime.runLog?.append({
            phase: 'layer1',
            status: STATUS.WARN,
            reason: 'bucket-split-adopted',
            workspaceId: resolved.bucket,
            detail: `会话 ${sessionId} 已在 ${resolved.buckets.join(' / ')}，本次沿用 ${resolved.bucket}（现算归属 ${resolved.requested}）`,
        }, nowOf());
        return { ...guessed, workspaceId: resolved.bucket, title: info.title || guessed.title };
    };

    /** 写一行 L0（唯一的一次本地写；行形状见 02 §7.0）。 */
    const appendL0 = ({ session, sessionId, bucket, turn, sample, now }) => {
        const user = typeof sample?.user === 'string' ? sample.user : '';
        const assistant = typeof sample?.assistant === 'string' ? sample.assistant : '';
        const row = {
            turn,
            endedAt: Number.isFinite(sample?.endedAt) ? sample.endedAt : now,
            seqFrom: Number.isFinite(sample?.seqFrom) ? sample.seqFrom : 0,
            user,
            assistant,
            chars: Number.isFinite(sample?.chars) ? sample.chars : user.length + assistant.length,
            session: sessionId,
            cwd: cwdOf(session) || (typeof bucket?.path === 'string' ? bucket.path : ''),
            workspaceId: bucket.workspaceId,
            workspaceTitle: typeof bucket?.title === 'string' ? bucket.title : '',
            consumed: false,
        };
        pending.appendRow({
            pendingDir: dir(),
            bucket: bucket.workspaceId,
            sessionId,
            row,
            maxRows: config.pendingMaxRows,
            now,
        });
        state.stats.rows += 1;
        return row;
    };

    /**
     * 一个已完成回合 → 一行 L0。
     *
     * @returns {{ written: boolean, reason: string }}
     */
    const writeTurn = ({ session, sessionId, bucket, turn, events, now, rows }) => {
        if (rows.some((item) => Number(item.row?.turn) === turn)) return { written: false, reason: AUTO_DROP.DUPLICATE };
        const sample = sampleTurn(events, turn, {
            perTurnCap: Number.isFinite(config.perTurnCap) ? config.perTurnCap : undefined,
            minTextChars: MIN_TEXT_CHARS,
        });
        if (sample.found !== true) return { written: false, reason: AUTO_DROP.NO_CONTENT };
        appendL0({ session, sessionId, bucket, turn, sample, now });
        return { written: true, reason: 'ok' };
    };

    const drop = (reason, detail) => {
        state.stats.dropped += 1;
        try {
            logger?.debug?.(`${TAG} 丢弃回合：${reason}${detail === undefined ? '' : `（${detail}）`}`);
        } catch {
            /* 同 warn */
        }
    };

    /* ────────────────────── 主触发：session/event 的 turn/end ────────────────────── */
    /**
     * @param {any} session 宿主会话对象（`id` / `header` / `events`）。
     * @param {any} event `{type, data, seq, time}`。
     */
    function onSessionEvent(session, event) {
        try {
            if (state.disposed || !isConsolidationEnabled(config)) return;
            if (event?.type !== 'turn/end') return;

            const reasonKind = event.data?.reason?.kind;
            if (reasonKind !== TURN_COMPLETED) {
                // 中断回合直接丢：`aborted` 里那些「有正文但只是旁白」的回合不许进记忆（02 §6.6）。
                drop(AUTO_DROP.INTERRUPTED, String(reasonKind ?? 'none'));
                return;
            }

            const depth = delegationDepthOf(session);
            if (depth > 0 && config.subagent !== true) {
                drop(AUTO_DROP.SUBAGENT, `depth=${depth}`);
                return;
            }

            const turn = Number(event.data?.turn);
            if (!Number.isFinite(turn)) {
                drop(AUTO_DROP.NO_TURN);
                return;
            }

            const sessionId = sessionIdOf(session);
            if (sessionId === '') {
                drop(AUTO_DROP.NO_SESSION);
                return;
            }

            const events = eventsOf(session);
            rememberRoute(session, events);

            const bucket = bucketFor(sessionId, cwdOf(session));
            const now = nowOf();
            const rows = pending.readRows({ pendingDir: dir(), bucket: bucket.workspaceId, sessionId });
            if (rows.some((item) => Number(item.row?.turn) === turn)) {
                drop(AUTO_DROP.DUPLICATE, `turn=${turn}`);
                return;
            }

            const outcome = writeTurn({ session, sessionId, bucket, turn, events, now, rows });
            if (outcome.written !== true) drop(outcome.reason, `turn=${turn}`);

            // 没正文的回合也推进游标：不然兜底路径每 30 分钟都会重试同一回合。
            advanceCursor(bucket.workspaceId, sessionId, turn, now);

            maybeConsume(bucket);
        } catch (error) {
            // 事件总线上抛异常会污染宿主的 dispatch：这里一律兜住，只记 warn。
            warn(`turn/end 处理失败：${String(error?.message ?? error)}`);
        }
    }

    /* ────────────────────── 补漏 ①：agent/status ────────────────────── */

    /** `turnBoundary` 里的最后回合号；投影读不到就用 `turn/end` 数（02 §6.0 兜底）。 */
    function lastTurnOf(session) {
        const projections = ctx?.sessionProjections
            ?? (typeof ctx?.get === 'function' ? ctx.get('sessionProjections') : undefined);
        try {
            const stateOf = projections?.stateOf ?? null;
            const boundary = typeof stateOf === 'function' ? stateOf.call(projections, session, 'turnBoundary') : null;
            const candidate = boundary?.lastTurn ?? boundary?.turn;
            if (Number.isFinite(candidate)) return Number(candidate);
        } catch {
            /* 投影服务不可用 ⇒ 落到数事件 */
        }
        const counted = countTurns(eventsOf(session));
        return Number.isFinite(counted.lastTurn) ? counted.lastTurn : null;
    }

    /**
     * 状态兜底：只在 `idle` / `maintenance`（宿主语义里都算「空了」）时补漏。
     *
     * `running` 一律不碰——那正是用户请求正在跑的时候（02 §6.5 规矩 1）。
     *
     * @param {any} payload `{agent, status}`
     */
    function onStatus(payload) {
        try {
            if (state.disposed || !isConsolidationEnabled(config)) return;
            const status = payload?.status;
            if (status !== 'idle' && status !== 'maintenance') return;

            const session = sessionFromPayload(payload);
            const sessionId = sessionIdOf(session);
            if (sessionId === '') return;
            if (delegationDepthOf(session) > 0 && config.subagent !== true) return;

            const lastTurn = lastTurnOf(session);
            if (!Number.isFinite(lastTurn)) return;

            const events = eventsOf(session);
            rememberRoute(session, events);

            const bucket = bucketFor(sessionId, cwdOf(session));
            const cursorTurn = cursorTurnOf(bucket.workspaceId, sessionId);
            if (lastTurn <= cursorTurn) return; // 事件路径已经处理过：什么都不做（绝不重复写）

            const missed = turnWindows(events)
                .filter((window) => window.end !== -1
                    && window.reasonKind === TURN_COMPLETED
                    && Number.isFinite(window.turn)
                    && window.turn > cursorTurn)
                .slice(-MAX_BACKFILL_TURNS);
            if (missed.length === 0) return;

            const now = nowOf();
            const rows = pending.readRows({ pendingDir: dir(), bucket: bucket.workspaceId, sessionId });
            let written = 0;
            let highest = cursorTurn;
            for (const window of missed) {
                const outcome = writeTurn({ session, sessionId, bucket, turn: window.turn, events, now, rows });
                if (outcome.written === true) {
                    written += 1;
                    rows.push({ row: { turn: window.turn } });
                }
                highest = Math.max(highest, window.turn);
            }
            advanceCursor(bucket.workspaceId, sessionId, highest, now);
            if (written > 0) {
                logger?.info?.(`${TAG} 状态兜底补写了 ${written} 个回合（${bucket.workspaceId}）`);
                maybeConsume(bucket);
            }
        } catch (error) {
            warn(`agent/status 补漏失败：${String(error?.message ?? error)}`);
        }
    }

    /* ────────────────────── 补漏 ②：agent/disposed 收尾 ────────────────────── */
    /**
     * 会话销毁：该会话还有未消费行时，最多给 3s 收尾一次，超时就放弃（行留在暂存里）。
     *
     * 为什么不 await：宿主的事件分发不等插件，await 只会把销毁流程拖住 3s；
     * 这里启动一个带超时的任务就返回。
     *
     * @param {any} payload `{agent}`
     */
    function onDisposed(payload) {
        try {
            if (state.disposed || !isConsolidationEnabled(config)) return;
            const session = sessionFromPayload(payload);
            const sessionId = sessionIdOf(session);
            if (sessionId === '') return;

            const bucket = bucketFor(sessionId, cwdOf(session));
            const rows = pending.readUnconsumed({ pendingDir: dir(), bucket: bucket.workspaceId })
                .filter((row) => row.session === sessionId);
            if (rows.length === 0) return;

            // 硬上限：超时就不等了（LLM 调用自己还会继续，结果由 runlog 记；行不会丢）。
            void withTimeout(() => consume(bucket), disposeTimeoutMs)
                .then((outcome) => {
                    if (outcome.ok !== true) {
                        warn(`会话销毁收尾未完成（${outcome.reason}）：${bucket.workspaceId}/${sessionId} 的 ${rows.length} 行留在暂存里`);
                    }
                })
                .catch(() => {
                    /* withTimeout 本身不抛，这里只是兜底 */
                });
        } catch (error) {
            warn(`agent/disposed 收尾失败：${String(error?.message ?? error)}`);
        }
    }

    /* ────────────────────── 补漏 ③：定时扫描 ────────────────────── */
    /**
     * 兜底扫描：所有 pending 桶重算门槛（达标就排队消费）+ 过期未消费行清理。
     *
     * 每个 tick **重新读** 生效档位（`mode.js`：`off` 等价 `enabled=false`）：A0 的缺陷是「启动时 enabled=false ⇒
     * 以后再打开也不会有定时器」，所以定时器只在启动时建一次，开关放在 tick 里判。
     *
     * @returns {{ buckets: number, scheduled: string[], dropped: number }}
     */
    function scan() {
        const empty = { buckets: 0, scheduled: [], dropped: 0 };
        try {
            if (state.disposed || !isConsolidationEnabled(config)) return empty;
            const now = nowOf();
            const cleaned = pending.cleanup({
                pendingDir: dir(),
                maxAgeDays: Number.isFinite(config.pendingMaxAgeDays) ? config.pendingMaxAgeDays : undefined,
                now,
            });

            const buckets = listPendingBuckets(dir());
            const scheduled = [];
            for (const entry of buckets) {
                const verdict = thresholdOf(entry.workspaceId);
                if (verdict.consume !== true) continue;
                const bucket = bucketInfo(registryOf(), entry.workspaceId, { unassigned: unassigned() });
                if (scheduleConsume(bucket)) scheduled.push(bucket.workspaceId);
            }
            if (cleaned.dropped > 0) {
                logger?.info?.(`${TAG} 兜底清理丢弃 ${cleaned.dropped} 行过期暂存`);
            }
            return { buckets: buckets.length, scheduled, dropped: cleaned.dropped };
        } catch (error) {
            warn(`兜底扫描失败：${String(error?.message ?? error)}`);
            return empty;
        }
    }

    /* ────────────────────── 监听与定时器 ────────────────────── */

    /** 挂一个监听并记住 disposer（`ctx.on` 在 cordis 里返回 disposer）。 */
    const attach = (type, handler) => {
        if (typeof ctx?.on !== 'function') return;
        try {
            const off = ctx.on(type, handler);
            if (typeof off === 'function') state.disposers.push(off);
        } catch (error) {
            warn(`订阅 ${type} 失败：${String(error?.message ?? error)}`);
        }
    };

    const intervalMs = () => {
        const minutes = Number.isFinite(config.idleScanMinutes) ? Math.max(1, config.idleScanMinutes) : DEFAULT_IDLE_SCAN_MINUTES;
        return minutes * 60_000;
    };

    /** 定时器**无条件**注册（是否干活由 tick 里读生效档位决定）。 */
    const ensureTimer = () => {
        const wanted = intervalMs();
        if (state.timer !== null && state.intervalMs === wanted) return;
        if (state.timer !== null) clearInterval(state.timer);
        state.intervalMs = wanted;
        state.timer = setInterval(() => {
            scan();
            ensureTimer(); // 设置页改了 idleScanMinutes ⇒ 下一个 tick 换成新间隔
        }, wanted);
        // 别让一个 30 分钟的定时器把宿主进程的退出拖住。
        if (typeof state.timer.unref === 'function') state.timer.unref();
    };

    const api = {
        /** 挂监听 + 建定时器（`index.js` 在 `apply` 里调一次）。 */
        start() {
            attach('session/event', onSessionEvent);
            attach('agent/status', onStatus);
            attach('agent/disposed', onDisposed);
            ensureTimer();
            return api;
        },
        onSessionEvent,
        onStatus,
        onDisposed,
        scan,
        /** 门槛判定（诊断/测试用；不排队、不花钱）。 */
        thresholdOf,
        /** 卸载：清定时器 + 摘监听（每次 `ctx.effect` 的清理都走这里）。 */
        dispose() {
            state.disposed = true;
            if (state.timer !== null) {
                clearInterval(state.timer);
                state.timer = null;
            }
            for (const off of state.disposers.splice(0)) {
                try {
                    off();
                } catch {
                    /* 宿主可能已先卸载 */
                }
            }
            state.scheduled.clear();
        },
        /** 计数快照（诊断用）。 */
        get stats() {
            return { ...state.stats };
        },
        get timer() {
            return state.timer;
        },
    };

    return api;
}
