/**
 * 触发判定：**纯函数**，输入一个快照，输出「写不写 L0」「消不消费」。
 *
 * 设计来源：02 §6.1（主触发：回合结束只写 L0，不调 LLM）、§6.2（消费触发：门槛
 * 到了才花钱）、§6.5（三条硬规矩）。这里不读盘、不看时钟、不碰 ctx——所有状态
 * （游标、待消费数量、冷却截止）都由调用方传进来，测试才好把真值表写全。
 *
 * 三条硬规矩的落点：
 *  1. **绝不在 pre-step 里 await 沉淀** ⇒ 本模块只做同步判定，任何异步都在
 *     「空闲后的 void run」里，`index.js` 不订阅 pre-step。
 *  2. **中断回合直接丢** ⇒ `reasonKind !== 'completed'` 一律不写 L0（含 `aborted`
 *     里那 13 个「有正文但只是旁白」的回合，见 02 §6.6 实测）。
 *  3. **单飞 / 并发 1** ⇒ 不在本模块，属 `budget.js`；这里只提供一个
 *     `cooldownUntil` 的旁路判定，让退避能被真值表覆盖。
 */

/** 宿主的「回合正常收尾」取值（`turn/end` 的 `data.reason.kind`）。 */
export const TURN_COMPLETED = 'completed';

/** 消费门槛默认值（02 §8 的 `minTurns` / `minChars`）。 */
export const DEFAULT_MIN_TURNS = 6;
export const DEFAULT_MIN_CHARS = 8000;

/** 判定原因（写进 runlog，字符串要稳定，别随手改）。 */
export const REASON = {
    OK: 'ok',
    DISABLED: 'disabled',
    SUBAGENT: 'subagent',
    NO_TURN_END: 'no-turn-end',
    INTERRUPTED: 'interrupted',
    NO_TURN_SIGNAL: 'no-turn-signal',
    NO_NEW_TURN: 'no-new-turn',
    BELOW_THRESHOLD: 'below-threshold',
    MIN_TURNS: 'min-turns',
    MIN_CHARS: 'min-chars',
    COOLDOWN: 'cooldown',
};

/**
 * 未消费回合数。
 *
 * 取 `lastTurn - cursorTurn` 而**不是**「pending 里已有几行」：游标推进可能滞后于
 * 落盘（先写 pending 再推进游标），两者口径统一到回合号才不会重复消费。
 *
 * @param {number | undefined} lastTurn 宿主最后完成的回合号（`turnBoundary.lastTurn`）。
 * @param {number | undefined} cursorTurn 该会话已消费到的回合号。
 * @returns {number} ≥ 0 的整数。
 */
export function unconsumedTurns(lastTurn, cursorTurn) {
    if (!Number.isFinite(lastTurn)) return 0;
    const from = Number.isFinite(cursorTurn) ? cursorTurn : 0;
    return Math.max(0, Math.trunc(lastTurn) - Math.trunc(from));
}

/**
 * 主触发判定：这一回合要不要写进 L0 暂存层。
 *
 * @param {{
 *   lastTurn?: number,
 *   cursorTurn?: number,
 *   reasonKind?: string,
 *   delegationDepth?: number,
 *   pendingTurns?: number,
 *   pendingChars?: number,
 *   cooldownUntil?: number,
 *   now?: number,
 *   config?: Record<string, any>,
 * }} input
 * @returns {{ writeL0: boolean, reason: string, turns: number, partialEligible: boolean }}
 */
export function decideL0Write(input = {}) {
    const config = input.config ?? {};
    const turns = unconsumedTurns(input.lastTurn, input.cursorTurn);
    const partialEligible = input.reasonKind !== TURN_COMPLETED && config.partialKeep === true;
    const deny = (reason) => ({ writeL0: false, reason, turns, partialEligible });

    if (config.enabled === false) return deny(REASON.DISABLED);
    if (Number(input.delegationDepth) > 0 && config.subagent !== true) return deny(REASON.SUBAGENT);

    // 只有 `turn/end` 到达才允许消费（02 §7.1 第 5 条）。宿主没给 reason 就当没收到。
    if (typeof input.reasonKind !== 'string' || input.reasonKind === '') return deny(REASON.NO_TURN_END);
    if (input.reasonKind !== TURN_COMPLETED) return deny(REASON.INTERRUPTED);

    if (!Number.isFinite(input.lastTurn)) return deny(REASON.NO_TURN_SIGNAL);
    if (turns <= 0) return deny(REASON.NO_NEW_TURN);

    return { writeL0: true, reason: REASON.OK, turns, partialEligible };
}

/**
 * 消费触发判定：攒够门槛了没。
 *
 * 阈值口径是「**先到先算**」：轮数 ≥ `minTurns` **或** 字符 ≥ `minChars`。
 * 为什么不是「且」：长会话可能 3 轮就 8000 字（一轮几千字），短会话可能 8 轮
 * 才 4000 字；用「且」会在其中一类里永远等不到（02 §6.2 / §7.1 成本参数）。
 *
 * @param {{
 *   pendingTurns?: number,
 *   pendingChars?: number,
 *   cooldownUntil?: number,
 *   now?: number,
 *   config?: Record<string, any>,
 * }} input
 * @returns {{ consume: boolean, reason: string, turns: number, chars: number, which: string[] }}
 */
export function decideConsume(input = {}) {
    const config = input.config ?? {};
    const minTurns = Number.isFinite(config.minTurns) ? config.minTurns : DEFAULT_MIN_TURNS;
    const minChars = Number.isFinite(config.minChars) ? config.minChars : DEFAULT_MIN_CHARS;
    const turns = Math.max(0, Math.trunc(Number(input.pendingTurns) || 0));
    const chars = Math.max(0, Math.trunc(Number(input.pendingChars) || 0));
    const deny = (reason) => ({ consume: false, reason, turns, chars, which: [] });

    if (config.enabled === false) return deny(REASON.DISABLED);

    const now = Number.isFinite(input.now) ? input.now : Date.now();
    if (Number.isFinite(input.cooldownUntil) && input.cooldownUntil > now) return deny(REASON.COOLDOWN);

    const which = [];
    if (turns >= minTurns) which.push('turns');
    if (chars >= minChars) which.push('chars');
    if (which.length === 0) return deny(REASON.BELOW_THRESHOLD);

    return {
        consume: true,
        reason: which[0] === 'turns' ? REASON.MIN_TURNS : REASON.MIN_CHARS,
        turns,
        chars,
        which,
    };
}

/**
 * 两个判定一次算完（`agent/status → idle` 之后与兜底扫描都走这里）。
 *
 * @param {Parameters<typeof decideL0Write>[0] & Parameters<typeof decideConsume>[0]} input
 * @returns {{ write: ReturnType<typeof decideL0Write>, consume: ReturnType<typeof decideConsume> }}
 */
export function decide(input = {}) {
    return {
        write: decideL0Write(input),
        consume: decideConsume(input),
    };
}
