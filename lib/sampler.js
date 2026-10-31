/**
 * 取样：从**会话事件流**里取「一轮 = 用户问题 + 助手结论」两段正文（02 §7.1）。
 *
 * 纯函数：输入是事件数组，输出是文本，不读盘、不调 store、不看时钟。
 *
 * 为什么按回合取而不是按消息取（02 §7.1 实测）：一轮里有十几到二十几条
 * `assistant/message`，绝大多数是 `reasoning` + `tool-call`；`user/message` 里
 * 一大半是插件注入（recall / time-context / skill-catalog / agent-instructions）。
 * 不过滤就是「拿工具日志当记忆」：22,732 事件里正文只有 2,432 + 364 条。
 *
 * 实测约束（决定了下面这些写法）：
 *  - `user/message` **不带 turn** ⇒ 只能按「回合窗口内第一条 `source.kind==='user'`」配对；
 *  - `turn/start` 在前、`user/message` 紧随其后（seq 8 → 12），不是反过来；
 *  - 每回合 text 条数平均 7.94（长回合每步一句旁白）⇒ 必须明确「取最后一条
 *    ≥ 80 字符的 text」，否则会取到「现在跑一下测试：」这类过程话。
 */

/** 纯图片回合的占位（02 §7.1 规则 3）。 */
export const IMAGE_PLACEHOLDER = '[图片]';
/** 旁白过滤下限：都不到这个长度时退回「最后一条 text」（规则 4）。 */
export const MIN_TEXT_CHARS = 80;
/** 单回合正文截断上限（02 §8 `perTurnCap`）。 */
export const DEFAULT_PER_TURN_CAP = 1200;
/** 单次沉淀输入上限（02 §8 `maxSampleChars`）。 */
export const DEFAULT_MAX_SAMPLE_CHARS = 8000;

/** 事件里的消息本体：`data.message`，兼容直接挂 `data` 上的老形状。 */
export function messageOf(event) {
    const data = event?.data;
    if (data === undefined || data === null) return undefined;
    return data.message ?? data;
}

/** 只认 text 块（reasoning / tool-call / image 一律不进沉淀）。 */
export function textOf(message) {
    if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return '';
    const parts = [];
    for (const block of message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('\n').trim();
}

/** 真人输入：`source.kind === 'user'`（注入类一律不算，见文件头）。 */
export function isUserSourced(message) {
    return message !== null && typeof message === 'object' && message.source?.kind === 'user';
}

/** 消息里有没有图片/附件块（用于「纯图片回合」判定）。 */
export function hasImage(message) {
    if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return false;
    return message.content.some((block) => typeof block?.type === 'string' && block.type.includes('image'));
}

/**
 * 切回合窗口。未闭合的窗口（还没 `turn/end`）也返回，但 `end === -1`，调用方不取。
 *
 * @param {any[]} events
 * @returns {{ turn: number | undefined, start: number, end: number, reasonKind: string | undefined }[]}
 */
export function turnWindows(events = []) {
    const windows = [];
    let current = null;
    for (let position = 0; position < events.length; position += 1) {
        const event = events[position];
        if (event?.type === 'turn/start') {
            current = { turn: event.data?.turn, start: position, end: -1, reasonKind: undefined };
            windows.push(current);
            continue;
        }
        if (event?.type !== 'turn/end') continue;
        const turn = event.data?.turn;
        if (current !== null && current.end === -1 && (turn === undefined || current.turn === undefined || turn === current.turn)) {
            current.end = position;
            current.reasonKind = event.data?.reason?.kind;
            current.turn = current.turn ?? turn;
            current = null;
            continue;
        }
        // 没有对应 `turn/start` 的 `turn/end`（日志从中间截断）：自成窗口。
        windows.push({ turn, start: position, end: position, reasonKind: event.data?.reason?.kind });
    }
    return windows;
}

/**
 * 数回合：`turnBoundary` 读不到时用它兜底（02 §6.0「读不到时兜底：数 turn/end 事件」）。
 *
 * @param {any[]} events
 * @returns {{ total: number, completed: number, lastTurn: number | null }}
 */
export function countTurns(events = []) {
    let total = 0;
    let completed = 0;
    let lastTurn = null;
    for (const event of events) {
        if (event?.type !== 'turn/end') continue;
        total += 1;
        if (event.data?.reason?.kind === 'completed') completed += 1;
        if (Number.isFinite(event.data?.turn)) lastTurn = event.data.turn;
    }
    return { total, completed, lastTurn };
}

/** 截断（不追加省略号：截断本身记在 `truncated` 标记上，正文保持模型原样）。 */
function cap(text, maxChars) {
    if (text.length <= maxChars) return { text, truncated: false };
    return { text: text.slice(0, maxChars), truncated: true };
}

/**
 * 取某一个回合的两段正文。
 *
 * @param {any[]} events 会话事件（顺序 = 落盘顺序）。
 * @param {number} turn 回合号。
 * @param {{ perTurnCap?: number, minTextChars?: number }} [options]
 * @returns {{
 *   found: boolean,
 *   reason: string,
 *   turn: number,
 *   user: string,
 *   assistant: string,
 *   chars: number,
 *   seqFrom: number,
 *   seqTo: number,
 *   endedAt: number | undefined,
 *   reasonKind: string | undefined,
 *   userSynthetic: boolean,
 *   truncated: boolean,
 * }}
 */
export function sampleTurn(events = [], turn, options = {}) {
    const perTurnCap = Number.isFinite(options.perTurnCap) ? options.perTurnCap : DEFAULT_PER_TURN_CAP;
    const minTextChars = Number.isFinite(options.minTextChars) ? options.minTextChars : MIN_TEXT_CHARS;
    const empty = {
        found: false,
        reason: 'no-window',
        turn,
        user: '',
        assistant: '',
        chars: 0,
        seqFrom: 0,
        seqTo: 0,
        endedAt: undefined,
        reasonKind: undefined,
        userSynthetic: false,
        truncated: false,
    };

    const windows = turnWindows(events);
    const index = windows.findIndex((window) => window.turn === turn);
    if (index === -1) return empty;
    const window = windows[index];
    if (window.end === -1) return { ...empty, reason: 'open-window' };

    // ① 回合窗口内第一条真人输入。
    let userText = '';
    let userSeq = events[window.start]?.seq ?? 0;
    let sawImage = false;
    for (let position = window.start; position <= window.end; position += 1) {
        const event = events[position];
        if (event?.type !== 'user/message') continue;
        const message = messageOf(event);
        if (hasImage(message)) sawImage = true;
        if (!isUserSourced(message)) continue;
        const text = textOf(message);
        if (text === '') continue;
        userText = text;
        userSeq = event.seq ?? userSeq;
        break;
    }

    // ② 找不到就向前找一条不跨 `turn/end` 的真人输入（规则 2）。
    if (userText === '') {
        for (let position = window.start - 1; position >= 0; position -= 1) {
            const event = events[position];
            if (event?.type === 'turn/end') break;
            if (event?.type !== 'user/message') continue;
            const message = messageOf(event);
            if (hasImage(message)) sawImage = true;
            if (!isUserSourced(message)) continue;
            const text = textOf(message);
            if (text === '') continue;
            userText = text;
            userSeq = event.seq ?? userSeq;
            break;
        }
    }

    // ③ 纯图片回合用占位，不丢这一轮（规则 3）。
    let userSynthetic = false;
    if (userText === '' && sawImage) {
        userText = IMAGE_PLACEHOLDER;
        userSynthetic = true;
    }

    // ④ 结论 = 窗口内最后一条 ≥ minTextChars 的 text；都不够就退回最后一条（规则 4）。
    let lastText = '';
    let lastSeq = 0;
    let longText = '';
    let longSeq = 0;
    for (let position = window.start; position <= window.end; position += 1) {
        const event = events[position];
        if (event?.type !== 'assistant/message') continue;
        const text = textOf(messageOf(event));
        if (text === '') continue;
        lastText = text;
        lastSeq = event.seq ?? lastSeq;
        if (text.length >= minTextChars) {
            longText = text;
            longSeq = event.seq ?? longSeq;
        }
    }
    const assistantText = longText !== '' ? longText : lastText;
    const assistantSeq = longText !== '' ? longSeq : lastSeq;

    const cappedUser = cap(userText, perTurnCap);
    const cappedAssistant = cap(assistantText, perTurnCap);
    const endEvent = events[window.end];

    return {
        found: cappedUser.text !== '' || cappedAssistant.text !== '',
        reason: 'ok',
        turn,
        user: cappedUser.text,
        assistant: cappedAssistant.text,
        chars: cappedUser.text.length + cappedAssistant.text.length,
        seqFrom: userSeq,
        seqTo: assistantSeq !== 0 ? assistantSeq : (endEvent?.seq ?? 0),
        endedAt: endEvent?.time,
        reasonKind: window.reasonKind,
        userSynthetic,
        truncated: cappedUser.truncated || cappedAssistant.truncated,
    };
}

/**
 * 取一批回合（末尾优先），并压进 `maxSampleChars`。
 *
 * 从**最新**的开始往回装：预算不够时应保住最近的上下文（最新的结论才是这轮沉淀
 * 的目标），而不是最早那几轮。
 *
 * @param {any[]} events
 * @param {{ turns?: number[], lastTurn?: number, maxTurnsPerCall?: number, perTurnCap?: number, maxSampleChars?: number }} [options]
 * @returns {{ samples: ReturnType<typeof sampleTurn>[], turns: number[], chars: number, dropped: number }}
 */
export function sampleTurns(events = [], options = {}) {
    const maxTurnsPerCall = Number.isFinite(options.maxTurnsPerCall) ? options.maxTurnsPerCall : 6;
    const maxSampleChars = Number.isFinite(options.maxSampleChars) ? options.maxSampleChars : DEFAULT_MAX_SAMPLE_CHARS;

    let wanted = Array.isArray(options.turns) ? [...options.turns] : [];
    if (wanted.length === 0) {
        const completed = turnWindows(events).filter((window) => window.end !== -1 && window.reasonKind === 'completed');
        wanted = completed
            .map((window) => window.turn)
            .filter((turn) => Number.isFinite(turn))
            .slice(-Math.max(1, maxTurnsPerCall));
    }
    wanted = wanted.filter((turn) => Number.isFinite(turn)).slice(-Math.max(1, maxTurnsPerCall));

    const picked = [];
    let chars = 0;
    for (let position = wanted.length - 1; position >= 0; position -= 1) {
        const sample = sampleTurn(events, wanted[position], options);
        if (!sample.found) continue;
        if (chars + sample.chars > maxSampleChars && picked.length > 0) continue;
        chars += sample.chars;
        picked.unshift(sample);
    }

    return {
        samples: picked,
        turns: picked.map((sample) => sample.turn),
        chars,
        dropped: wanted.length - picked.length,
    };
}
