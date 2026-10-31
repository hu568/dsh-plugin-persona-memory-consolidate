/**
 * 真实 LLM 调用（M1 接线）：`ctx.llm.stream()` 是**宿主平面**服务，不需要用户回合
 * （M0 §1 已实测：`dsh-base/cordis.patch.yml` 在宿主平面挂载 `@deepseek-ai/dsh-llm`，
 * `GenerateOptions.sessionId` 只是日志归属，不是调用前提）。
 *
 * 块形状（M0 §1 / `dsh-llm/README.md`）：
 *
 *   {type:'block-start'} | {type:'text-delta', text} | {type:'tool-call-delta'}
 *   | {type:'usage'} | {type:'finish', kind:'end'|'error'|'aborted', failure?}
 *
 * 三条纪律：
 *  1. **只取 `text-delta.text`**：推理块与工具块一律不要（02 §7.1「不取样思维链」的同一理由——
 *     沉淀的输入只有结论，调用侧同理只要正文）；
 *  2. **`finish.kind !== 'end'` 一律算失败**：拿半截正文当结论写进 FACT 是最坏的污染源，
 *     错误码带 `finish.failure?.code`（`NO_ADAPTER` / `AUTH` / `RATE_LIMIT` / `QUOTA` /
 *     `CONTEXT_WINDOW_EXCEEDED`，见 M0 §1）；
 *  3. **20s 超时**：预算是按次算钱的，卡住的调用既烧预算又卡住单飞锁。
 *
 * `getLlm` 是注入的（`() => ctx.get('llm')`），所以单测可以塞一个假流，**永不触网**。
 */

import { withTimeout } from './budget.js';

/** 没有可用的 provider/model（设置页与 default 都空）。 */
export const NO_ROUTE = 'NO_ROUTE';
/** 宿主 llm 服务不在（插件被裁掉 / 组合里没有 dsh-llm）。 */
export const NO_ADAPTER = 'NO_ADAPTER';
/** 超时（02 §7.5「单次时长 20s」）。 */
export const LLM_TIMEOUT = 'LLM_TIMEOUT';
/** 流结束了但没给 `finish`（宿主不会这样，防御性错误码）。 */
export const LLM_NO_FINISH = 'LLM_NO_FINISH';
/** `finish.kind` 是 `error` / `aborted` 但没带 failure 时的兜底码。 */
export const LLM_FINISHED_ABORTED = 'LLM_FINISHED_ABORTED';
/** 调用前 signal 已取消。 */
export const LLM_ABORTED = 'LLM_ABORTED';

/** 默认超时（与 `budget.DEFAULT_CALL_TIMEOUT_MS` 同值，这里不 import 那个常量是为了不引入相位概念）。 */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** 带 `code` 的错误（上层靠 code 决定退避/降级，不解析 message）。 */
function codedError(code, message, extra) {
    const error = new Error(message);
    error.code = code;
    if (extra !== undefined && extra !== null) Object.assign(error, extra);
    return error;
}

/**
 * 取第一个非空字符串。
 *
 * 为什么「空串」不算命中：设置页把 `provider` 清空表示「沿用会话 route」，
 * 空串必须继续往下一级回落，否则清空就成了「写死空 provider」。
 */
function pick(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return '';
}

/**
 * 解析生效的 route：**显式参数 → config → 调用方给的默认值**（02 §7.2「默认沿用会话最近一次
 * route，可配置覆盖」）。任一侧为空 ⇒ 返回 null（调用侧抛 `NO_ROUTE`）。
 *
 * @param {{
 *   provider?: string,
 *   model?: string,
 *   config?: Record<string, any>,
 *   defaults?: { provider?: string, model?: string } | (() => { provider?: string, model?: string }),
 * }} [input]
 * @returns {{ provider: string, model: string } | null}
 */
export function resolveRoute(input = {}) {
    const defaults = typeof input.defaults === 'function' ? input.defaults() : input.defaults;
    const provider = pick(input.provider, input.config?.provider, defaults?.provider);
    const model = pick(input.model, input.config?.model, defaults?.model);
    if (provider === '' || model === '') return null;
    return { provider, model };
}

/** 把流吃成一段正文；`finish` 不是 `end` 就抛。 */
async function collect(stream) {
    let text = '';
    for await (const chunk of stream) {
        if (chunk === null || typeof chunk !== 'object') continue;
        if (chunk.type === 'text-delta') {
            if (typeof chunk.text === 'string') text += chunk.text;
            continue;
        }
        if (chunk.type === 'finish') {
            if (chunk.kind === 'end') return text;
            throw codedError(chunk.failure?.code ?? LLM_FINISHED_ABORTED, `模型调用未正常结束（${String(chunk.kind ?? 'unknown')}）`, {
                finish: chunk,
            });
        }
    }
    throw codedError(LLM_NO_FINISH, '模型调用没有返回 finish 块');
}

/**
 * 造真实 callModel。
 *
 * @param {{
 *   getLlm?: (() => any) | any,
 *   config?: Record<string, any>,
 *   logger?: { info?: Function, warn?: Function, debug?: Function },
 *   timeoutMs?: number,
 *   defaults?: { provider?: string, model?: string } | (() => { provider?: string, model?: string }),
 * }} [options]
 * @returns {(request: { prompt: string, provider?: string, model?: string, signal?: AbortSignal }) => Promise<string>}
 */
export function createCallModel(options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : DEFAULT_TIMEOUT_MS;

    const readLlm = () => {
        try {
            return typeof options.getLlm === 'function' ? options.getLlm() : options.getLlm;
        } catch {
            return null;
        }
    };

    return async function callModel(request = {}) {
        if (request.signal?.aborted === true) throw codedError(LLM_ABORTED, '调用已被取消');

        const route = resolveRoute({ provider: request.provider, model: request.model, config: options.config, defaults: options.defaults });
        if (route === null) throw codedError(NO_ROUTE, '没有可用的 provider/model（设置页与会话 route 都是空）');

        const llm = readLlm();
        if (llm === null || llm === undefined || typeof llm.stream !== 'function') {
            throw codedError(NO_ADAPTER, '宿主 llm 服务不可用（ctx.get("llm") 为 undefined 或没有 stream）');
        }

        const messages = [{
            role: 'user',
            content: [{ type: 'text', text: String(request.prompt ?? '') }],
        }];

        const outcome = await withTimeout(
            () => collect(llm.stream({ provider: route.provider, model: route.model, messages })),
            timeoutMs,
        );
        if (outcome.ok) return outcome.value;
        if (outcome.reason === 'timeout') {
            options.logger?.warn?.(`[persona-memory-consolidate] LLM 超时（${timeoutMs}ms，${route.provider}/${route.model}）`);
            throw codedError(LLM_TIMEOUT, `模型调用超时（${timeoutMs}ms）`);
        }
        // 原始错误原样上抛：`finish.failure.code` 是上层决定退避还是放弃的唯一依据。
        throw outcome.error ?? codedError('LLM_ERROR', '模型调用失败');
    };
}

/**
 * 从会话事件流里读「最近一次 route」（02 §7.1 末尾：`request/header` 的
 * `data.header.config.{provider, model}`）。
 *
 * 为什么这样读而不是问宿主：宿主没有「当前 route」的服务接口，而会话日志里每次都记了；
 * 实测本机出现过 `deepseek-account/deepseek-flash`、`workbuddy-cn/deepseek-v4.1-flash`、
 * `qianfan/deepseek-v4.1-flash-1017` 三种，说明「跟随会话」确实比写死默认值靠谱。
 *
 * @param {{ type?: string, data?: any }[]} events
 * @returns {{ provider: string, model: string } | null}
 */
export function lastRouteFromEvents(events = []) {
    if (!Array.isArray(events)) return null;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type !== 'request/header') continue;
        const config = event.data?.header?.config ?? event.data?.config ?? event.header?.config;
        if (config === null || typeof config !== 'object') return null;
        const provider = typeof config.provider === 'string' ? config.provider.trim() : '';
        const model = typeof config.model === 'string' ? config.model.trim() : '';
        if (provider === '' || model === '') return null;
        return { provider, model };
    }
    return null;
}
