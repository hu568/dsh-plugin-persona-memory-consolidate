/**
 * 预算与单飞：`02 §6.5` 的三条硬规矩里有两条落在这里。
 *
 *  - **单飞**：同会话互斥 + 全局并发 1（防止多会话同时开跑吃光日预算）；
 *  - **预算**：每日调用总数 60、按阶段扣减（第一层 50 / 第二层 10，见 §8 注释）、
 *    连续失败 2 次起退避 5/10/20 分钟（§7.5）、单次调用 20s 超时。
 *
 * 全部状态在内存里：日预算不需要跨重启精确——重启后重新数当天已用次数本来也
 * 只能靠 runlog 抽样，用内存 + 日期滚动已足够，且不会因为在磁盘上写坏一个小
 * 计数器就把沉淀整个锁死。
 *
 * 时间都靠参数注入（`now`），因此退避与日期滚动的测试不需要真的等 5 分钟。
 */

/** 阶段名（runlog 与预算扣减共用）。 */
export const PHASE_LAYER1 = 'layer1';
export const PHASE_LAYER2 = 'layer2';

/**
 * 判定输入归一：允许 `canStart('layer1')` 这种「只给阶段」的简写。
 *
 * 为什么要这个简写：M1 管线里「占一次锁、扣一次预算」是最常见的调用，
 * 写成 `tryStart({ phase: PHASE_LAYER1 })` 每天要看几十遍；简写能让调用点一眼看出
 * 「这是一次第一层调用」。
 *
 * @param {{ sessionKey?: string, phase?: string, now?: number } | string | undefined} input
 * @returns {{ sessionKey?: string, phase?: string, now?: number }}
 */
function normalizeInput(input) {
    if (typeof input === 'string') return { phase: input };
    return input ?? {};
}

/** 默认配额（02 §7.5 / §8）。 */
export const DEFAULT_DAILY_LIMIT = 60;
export const DEFAULT_LAYER1_LIMIT = 50;
export const DEFAULT_LAYER2_LIMIT = 10;
/** 连续失败 2 次起依次退避（分钟）；再失败继续用最后一个值。 */
export const BACKOFF_MINUTES = [5, 10, 20];
/** 单次调用超时 / 会话销毁收尾超时（02 §7.5、§6.3）。 */
export const DEFAULT_CALL_TIMEOUT_MS = 20_000;
export const DEFAULT_DISPOSE_TIMEOUT_MS = 3_000;

/** 拒绝原因（写进 runlog，字符串要稳定）。 */
export const BUDGET_REASON = {
    OK: 'ok',
    SESSION_BUSY: 'session-busy',
    CONCURRENCY_LIMIT: 'concurrency-limit',
    COOLDOWN: 'cooldown',
    DAILY_BUDGET: 'daily-budget',
    PHASE_BUDGET: 'phase-budget',
};

/** 本地日期键（`YYYY-MM-DD`）。用本地时区：「每日 60 次」是给人看的配额。 */
export function dayKey(now = Date.now()) {
    const date = new Date(now);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * 连续失败 → 退避分钟数（0 = 不退避）。
 *
 * 阈值是「连续失败 2 次」（§7.5）：单次失败不冷却，因为一次网络抖动就停 5 分钟
 * 会让沉淀长时间停摆；两次连续失败才说明上游真的不可用。
 *
 * @param {number} failures 连续失败次数。
 * @returns {number} 分钟。
 */
export function backoffMinutes(failures) {
    const count = Math.trunc(Number(failures) || 0);
    if (count < 2) return 0;
    const index = Math.min(count - 2, BACKOFF_MINUTES.length - 1);
    return BACKOFF_MINUTES[index];
}

/**
 * 造一个进程内预算器。
 *
 * @param {{
 *   dailyLlmBudget?: number,
 *   layer1Limit?: number,
 *   layer2Limit?: number,
 *   maxConcurrent?: number,
 *   now?: number,
 * }} [options]
 */
export function createBudget(options = {}) {
    const dailyLimit = Number.isFinite(options.dailyLlmBudget) ? options.dailyLlmBudget : DEFAULT_DAILY_LIMIT;
    const layer1Limit = Number.isFinite(options.layer1Limit) ? options.layer1Limit : DEFAULT_LAYER1_LIMIT;
    const layer2Limit = Number.isFinite(options.layer2Limit) ? options.layer2Limit : DEFAULT_LAYER2_LIMIT;
    const maxConcurrent = Number.isFinite(options.maxConcurrent) ? Math.max(1, options.maxConcurrent) : 1;

    const state = {
        day: dayKey(Number.isFinite(options.now) ? options.now : Date.now()),
        used: { total: 0, layer1: 0, layer2: 0 },
        failures: 0,
        cooldownUntil: 0,
        /** 在跑的 token。 */
        tokens: new Set(),
        /** token → 会话键（放锁时要一起清）。 */
        sessionOf: new Map(),
        /** 正在跑的会话键集合（同会话互斥）。 */
        sessions: new Set(),
        busy: 0,
    };

    /** 跨日归零（每次判定/扣减前都跑一遍，不依赖定时器）。 */
    const rollover = (now) => {
        const key = dayKey(now);
        if (key === state.day) return false;
        state.day = key;
        state.used = { total: 0, layer1: 0, layer2: 0 };
        return true;
    };

    const budget = {
        /** 当天日期键（诊断用）。 */
        get day() {
            return state.day;
        },

        /**
         * 看一眼能不能开跑（不占锁、不扣预算）。
         *
         * @param {{ sessionKey?: string, phase?: string, now?: number } | string} [input]
         * @returns {{ ok: boolean, reason: string, retryAt?: number }}
         */
        canStart(rawInput = {}) {
            const input = normalizeInput(rawInput);
            const now = Number.isFinite(input.now) ? input.now : Date.now();
            rollover(now);
            if (input.sessionKey !== undefined && state.sessions.has(input.sessionKey)) {
                return { ok: false, reason: BUDGET_REASON.SESSION_BUSY };
            }
            if (state.busy >= maxConcurrent) return { ok: false, reason: BUDGET_REASON.CONCURRENCY_LIMIT };
            if (state.cooldownUntil > now) {
                return { ok: false, reason: BUDGET_REASON.COOLDOWN, retryAt: state.cooldownUntil };
            }
            if (state.used.total >= dailyLimit) return { ok: false, reason: BUDGET_REASON.DAILY_BUDGET };
            if (input.phase === PHASE_LAYER1 && state.used.layer1 >= layer1Limit) {
                return { ok: false, reason: BUDGET_REASON.PHASE_BUDGET };
            }
            if (input.phase === PHASE_LAYER2 && state.used.layer2 >= layer2Limit) {
                return { ok: false, reason: BUDGET_REASON.PHASE_BUDGET };
            }
            return { ok: true, reason: BUDGET_REASON.OK };
        },

        /**
         * 占锁 + 扣一次预算。成功返回 `{ok:true, token}`，必须用 `settle(token, …)` 收尾。
         *
         * 预算**在开始时**扣：调用已经发出去了，失败也是花了钱；放在结束时扣会让
         * 并发/重入把当日次数顶穿。
         *
         * @param {{ sessionKey?: string, phase?: string, now?: number } | string} [rawInput]
         * @returns {{ ok: boolean, reason: string, token?: string, retryAt?: number }}
         */
        tryStart(rawInput = {}) {
            const input = normalizeInput(rawInput);
            const verdict = budget.canStart(input);
            if (!verdict.ok) return verdict;
            const now = Number.isFinite(input.now) ? input.now : Date.now();
            const phase = input.phase === PHASE_LAYER2 ? PHASE_LAYER2 : PHASE_LAYER1;
            state.used.total += 1;
            state.used[phase] += 1;
            state.busy += 1;
            const token = `${phase}:${now}:${state.used.total}`;
            state.tokens.add(token);
            state.sessionOf.set(token, input.sessionKey);
            if (input.sessionKey !== undefined) state.sessions.add(input.sessionKey);
            return { ok: true, reason: BUDGET_REASON.OK, token };
        },

        /**
         * 补扣预算（一次 LLM 调用一次），**不占锁、不看上限**。
         *
         * 为什么需要它：`runAllBuckets` 一次运行只占一次全局锁（并发 1，不能每个桶再抢一次），
         * 但一次运行可能对每个桶各发 1–2 次真实调用。所以「锁」按运行计、「预算」按调用计：
         * 额外的那几次用这里补扣，日配额才反映真实花费（02 §7.5「每日调用 60」的语义）。
         *
         * 上限判定仍只在 `tryStart` 做：补扣属于「已经花掉的钱」，不该因为超限而记账造谎。
         *
         * @param {string} [phase]
         * @param {number} [count]
         * @param {number} [now] 跨日滚动的判定时刻（多段循环里要与 `tryStart` 用同一个 `now`，
         *   否则「注入的 now」与真实时钟不同天时会把刚扣的次数清零）。
         * @returns {{ total: number, layer1: number, layer2: number }}
         */
        charge(phase = PHASE_LAYER1, count = 1, now = Date.now()) {
            const extra = Math.max(0, Math.trunc(Number(count) || 0));
            if (extra === 0) return { ...state.used };
            rollover(Number.isFinite(now) ? now : Date.now());
            const key = phase === PHASE_LAYER2 ? PHASE_LAYER2 : PHASE_LAYER1;
            state.used.total += extra;
            state.used[key] += extra;
            return { ...state.used };
        },

        /**
         * 收尾：放锁、按成败更新退避。
         *
         * @param {string} token `tryStart` 给的 token。
         * @param {{ ok?: boolean, now?: number }} [result]
         * @returns {{ failures: number, cooldownUntil: number }}
         */
        settle(token, result = {}) {
            const now = Number.isFinite(result.now) ? result.now : Date.now();
            if (state.tokens.delete(token)) {
                const sessionKey = state.sessionOf.get(token);
                state.sessionOf.delete(token);
                if (sessionKey !== undefined) state.sessions.delete(sessionKey);
                state.busy = Math.max(0, state.busy - 1);
            }
            if (result.ok === true) {
                state.failures = 0;
                state.cooldownUntil = 0;
            } else {
                state.failures += 1;
                const minutes = backoffMinutes(state.failures);
                state.cooldownUntil = minutes > 0 ? now + minutes * 60_000 : 0;
            }
            return { failures: state.failures, cooldownUntil: state.cooldownUntil };
        },

        /**
         * 直接记一次失败（`settle` 之外的入口）。
         *
         * 为什么需要它：自动触发（M2）里，失败**通常**由 `pipeline` 的
         * `finally { settle(token,{ok:false}) }` 记过；但如果连那一段都没跑到
         * （注入的执行体直接抛、store 解析炸在上层），失败也必须喂进退避——否则
         * 每个回合结束都会重试一次，把上游打穿。
         *
         * ⚠️ 已经 `settle({ok:false})` 过的失败**不要**再调它：连续失败会被数两遍，
         * 退避提前到 10 分钟，与实际不符。
         *
         * @param {number} [now]
         * @returns {{ failures: number, cooldownUntil: number }}
         */
        noteFailure(now = Date.now()) {
            state.failures += 1;
            const minutes = backoffMinutes(state.failures);
            state.cooldownUntil = minutes > 0 ? now + minutes * 60_000 : 0;
            return { failures: state.failures, cooldownUntil: state.cooldownUntil };
        },

        /** 退避截止时间戳（没有冷却 → 0，可直接喂给 `trigger.decideConsume`）。 */
        cooldownUntil() {
            return state.cooldownUntil;
        },

        /**
         * 还剩几次调用（按总量与阶段各算一次）。
         *
         * 为什么需要它：`canStart()` 会连并发一起看，而 `runL2All` / `runAllBuckets`
         * 这类「持锁跑多段」的循环里，锁本来就攥在自己手上，再问 `canStart` 只会得到
         * `concurrency-limit`。多段循环需要的是「预算还剩几次」这一个数，不是许可。
         *
         * @param {string} [phase]
         * @param {number} [now]
         * @returns {{ total: number, phase: number }}
         */
        remaining(phase = PHASE_LAYER1, now = Date.now()) {
            rollover(Number.isFinite(now) ? now : Date.now());
            const key = phase === PHASE_LAYER2 ? PHASE_LAYER2 : PHASE_LAYER1;
            const limit = key === PHASE_LAYER2 ? layer2Limit : layer1Limit;
            return {
                total: Math.max(0, dailyLimit - state.used.total),
                phase: Math.max(0, limit - state.used[key]),
            };
        },

        /** 诊断快照（runlog / 面板用）。 */
        snapshot(now = Date.now()) {
            rollover(now);
            return {
                day: state.day,
                used: { ...state.used },
                remaining: Math.max(0, dailyLimit - state.used.total),
                failures: state.failures,
                cooldownUntil: state.cooldownUntil,
                busy: state.busy,
                /** 在跑的调用：`phase:now:序数`。 */
                inflight: [...state.tokens],
            };
        },

        /** 测试/诊断用：当前是否有人在跑。 */
        get busyCount() {
            return state.busy;
        },
    };

    return budget;
}

/** 超时哨兵（`withTimeout` 内部用；`Promise.race` 不抛异常就能区分）。 */
const TIMEOUT = Symbol('timeout');

/**
 * 给一个 Promise 套超时。**不抛**，返回 `{ok, value|reason}`。
 *
 * 为什么不用 AbortController：本插件要超时的对象是后台 LLM 调用，宿主侧不一定
 * 认 signal；这里只要「不再等它」就够了，结果直接丢掉（预算已扣，不走重试）。
 *
 * @template T
 * @param {() => Promise<T>} task
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: true, value: T } | { ok: false, reason: 'timeout' | 'error', error?: unknown }>}
 */
export async function withTimeout(task, timeoutMs) {
    const run = Promise.resolve().then(task);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        try {
            return { ok: true, value: await run };
        } catch (error) {
            return { ok: false, reason: 'error', error };
        }
    }

    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
        // 别让一个 20s 的定时器把宿主进程的退出拖住。
        if (typeof timer.unref === 'function') timer.unref();
    });

    try {
        const value = await Promise.race([run, timeout]);
        if (value === TIMEOUT) return { ok: false, reason: 'timeout' };
        return { ok: true, value };
    } catch (error) {
        return { ok: false, reason: 'error', error };
    } finally {
        clearTimeout(timer);
    }
}
