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
/** 输出被 max-tokens 截断：半截 JSON 不可用（宁可这轮不算，也不许写进记忆）。 */
export const LLM_TRUNCATED = 'LLM_TRUNCATED';

/** 默认超时（与 `budget.DEFAULT_CALL_TIMEOUT_MS` 同值，这里不 import 那个常量是为了不引入相位概念）。 */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** 带 `code` 的错误（上层靠 code 决定退避/降级，不解析 message）。 */
function codedError(code, message, extra) {
    const error = new Error(message);
    error.code = code;
    if (extra !== undefined && extra !== null) Object.assign(error, extra);
    return error;
}

/** 取第一个非空字符串。 */
function firstText(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return '';
}

/**
 * 取**非空**错误码：空字符串也当缺失。
 *
 * 为什么必须判空：本机 2026-11-09 实测宿主返回过 `finish.failure.code: ''`，而
 * `finish?.failure?.code ?? LLM_FINISHED_ABORTED` 遇到 `''` 不会回退 ⇒ 错误码是空串
 * ⇒ `extractor` 的 `String(error?.code ?? 'model-error')` 也是空串 ⇒ pipeline 只记下
 * 裸的 `extract-model-error`，35/35 次失败看不出任何原因。空 code 一律回退到
 * `fallback`（默认 `'error'`），再不行用 `error.name`。
 *
 * @param {any} error
 * @param {string} [fallback]
 * @returns {string}
 */
export function codeOf(error, fallback = 'error') {
    const code = error?.code;
    if (typeof code === 'string' && code.trim() !== '') return code.trim();
    if (typeof code === 'number' && Number.isFinite(code)) return String(code);
    const name = error?.name;
    if (typeof name === 'string' && name !== '' && name !== 'Error') return name;
    return fallback;
}

/**
 * 把 `finish` 块折成**一行纯文本**（排障用，绝不含模型正文）：
 * `finish.kind=error failure.code='' failure.kind=...`。
 *
 * 为什么连空的 `code` 也要原样写出来：`failure.code=''` 与「没有 failure」
 * 是两种不同的故障，前者说明宿主返回了非正常结束块，后者才更像路线没接上。
 *
 * @param {any} finish `{kind, failure?}`
 * @returns {string}
 */
export function describeFinish(finish) {
    if (finish === null || typeof finish !== 'object') return 'finish=(none)';
    // 两种形状都认：`finishOf()` 给的 `{kind, failure}`，以及宿主原始块
    // `{type:'finish', reason:{kind, failure}}`（`details.finish` 里放的是后者）。
    if (finish.reason !== null && typeof finish.reason === 'object') return describeFinish(finish.reason);
    const kind = typeof finish.kind === 'string' && finish.kind !== '' ? finish.kind : 'unknown';
    const bits = [`finish.kind=${kind}`];
    if (finish.failure !== undefined && finish.failure !== null) {
        const rawCode = typeof finish.failure === 'object' ? finish.failure.code : undefined;
        bits.push(`failure.code='${typeof rawCode === 'string' ? rawCode : String(rawCode ?? '')}'`);
        const failureKind = finish.failure?.kind ?? finish.failure?.type;
        if (failureKind !== undefined && failureKind !== null && String(failureKind) !== '') bits.push(`failure.kind=${String(failureKind)}`);
        if (typeof finish.failure?.message === 'string' && finish.failure.message !== '') bits.push(`failure.message=${finish.failure.message}`);
    }
    return bits.join(' ');
}

/**
 * 错误 → `detail`（`error.name: error.message` + finish 摘要）。
 *
 * 落 runlog 前会再脱敏并按 200 字符截断（`runlog.sanitizeRecord`）。
 *
 * @param {any} error
 * @returns {string}
 */
export function detailOfError(error) {
    if (error === null || error === undefined) return '';
    const name = firstText(error.name, 'Error');
    const message = String(error.message ?? '');
    const bits = [`${name}: ${message}`];
    // `details.finish` 是宿主形状（`{reason:{kind, failure:{code,message}}}`）的首选来源；
    // 也兼容旧字段 `error.finish` 与裸 `error.failure`。
    const finish = error.details?.finish ?? error.finish;
    if (finish !== undefined && finish !== null) bits.push(describeFinish(finish));
    else if (error.details?.failure !== undefined && error.details.failure !== null) {
        bits.push(describeFinish({ kind: 'error', failure: error.details.failure }));
    } else if (error.failure !== undefined && error.failure !== null) {
        bits.push(describeFinish({ kind: 'error', failure: error.failure }));
    }
    return bits.join(' · ');
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

/** 抽取路线来源（`/memory-consolidate status` 与测试共用，字符串稳定）。 */
export const ROUTE_SOURCE = {
    SETTINGS: 'settings',
    SESSION: 'session',
    DEFAULT: 'default',
    UNKNOWN: 'unknown',
};

/** 一个 route 对象归一（缺一侧也照样返回，让调用方逐字段回落）。 */
function normalizeRouteShape(route) {
    if (route === null || typeof route !== 'object') return null;
    const provider = typeof route.provider === 'string' ? route.provider.trim() : '';
    const model = typeof route.model === 'string' ? route.model.trim() : '';
    if (provider === '' && model === '') return null;
    return { provider, model };
}

/**
 * 报告**实际会用的**抽取路线与它的来源（只读，**不做任何猜测**）。
 *
 * 优先级与 `resolveRoute()` 逐字段一致：设置页显式值 → 会话最近一次 route →
 * 宿主默认模型（`agentDefaultModel`）。逐字段判定是因为三者可以混用
 * （设置页只填了 provider、model 走宿主默认也是合法组合）。
 *
 * 拿不到就是 `''` / `unknown`，**绝不编造**。
 *
 * @param {{
 *   config?: Record<string, any>,
 *   lastRoute?: { provider?: string, model?: string } | null,
 *   defaultRoute?: { provider?: string, model?: string } | null,
 * }} [input]
 * @returns {{
 *   ok: boolean, provider: string, model: string,
 *   providerSource: string, modelSource: string, sources: string[],
 * }}
 */
export function resolveRouteSource(input = {}) {
    const config = input.config ?? {};
    const session = normalizeRouteShape(input.lastRoute);
    const hostDefault = normalizeRouteShape(input.defaultRoute);
    const pickFor = (key) => {
        const candidates = [
            [ROUTE_SOURCE.SETTINGS, typeof config[key] === 'string' ? config[key].trim() : ''],
            [ROUTE_SOURCE.SESSION, session === null ? '' : session[key]],
            [ROUTE_SOURCE.DEFAULT, hostDefault === null ? '' : hostDefault[key]],
        ];
        for (const [source, value] of candidates) {
            if (typeof value === 'string' && value !== '') return { value, source };
        }
        return { value: '', source: ROUTE_SOURCE.UNKNOWN };
    };
    const provider = pickFor('provider');
    const model = pickFor('model');
    const sources = [...new Set([provider.source, model.source])].filter((source) => source !== ROUTE_SOURCE.UNKNOWN);
    return {
        ok: provider.value !== '' && model.value !== '',
        provider: provider.value,
        model: model.value,
        providerSource: provider.source,
        modelSource: model.source,
        sources,
    };
}

/**
 * 宿主的 finish 块形状是 `{ type:'finish', reason:{ kind, failure? } }`
 * （`/opt/dsh` 的 `StreamChunk` 声明与 `dsh-llm` 实现均如此）；
 * A0/M0 早期单测里用的是 `{ type:'finish', kind }`。两种都认，别再让合同漂移
 * 变成「每次沉淀都失败、还看不到原因」。
 *
 * @param {any} chunk
 * @returns {{ kind?: string, failure?: any } | null}
 */
export function finishOf(chunk) {
    if (chunk === null || typeof chunk !== 'object') return null;
    if (chunk.reason !== null && typeof chunk.reason === 'object') return chunk.reason;
    if (chunk.kind !== undefined || chunk.failure !== undefined) return { kind: chunk.kind, failure: chunk.failure };
    return null;
}

/** 正常结束的 kind（`end` 是旧测试形状，兼容保留）。 */
const SUCCESS_FINISH = new Set(['stop', 'end', 'tool-calls']);

/**
 * 一次调用的 `purpose`（宿主用它归因日志/计量；与 `session-title` 同款约定）。
 */
export const CALL_PURPOSE = 'memory-consolidate';

/** 默认输出上限（别指望宿主的 `defaultMaxTokens`——它可能不存在，等于不限）。 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
/** `maxOutputTokens` 的下限（低于它连一条结论都写不完）。 */
export const MIN_MAX_OUTPUT_TOKENS = 256;

/**
 * 沉淀调用的推理等级默认值。
 *
 * **为什么不是「不传」**：宿主对 DeepSeek 系列的 `reasoning` 默认是 `high`
 * （`dsh-llm-deepseek`：`options.reasoningEffort ?? defaults.reasoningEffort
 * ?? (thinking === 'disabled' ? 'off' : 'high')`）。沉淀是「照对话抽结论」的机械活，
 * high 会把 `maxOutputTokens` 的大半花在思考上——本机 2026-11-09 12:02 的真实失败
 * 就是 6 轮 / 7926 字符的桶在 50.8s 后 `finish.kind=max-tokens`，一个字都没写。
 *
 * `low` 而不是 `off`：抽取仍要理解「哪两轮说的是同一件事」，完全关掉思考容易把
 * 冲突判成 NOOP；`low` 在官方模型里存在且足够省。模型若只支持 `off`（`thinking:
 * disabled`）或压根不支持推理，`pickReasoningEffort()` 会安全降级，绝不硬塞。
 */
export const DEFAULT_REASONING_EFFORT = 'low';

/** 允许显式配置的推理等级（另加 `auto`＝交回宿主默认）。 */
export const REASONING_EFFORT_VALUES = ['off', 'low', 'high', 'max'];
/** 配置里的「你按宿主的默认来」哨兵值。 */
export const REASONING_EFFORT_AUTO = 'auto';

/**
 * 生效的 `maxTokens`：`request.maxOutputTokens`（单次覆盖）> 设置页/配置 > 默认值。
 *
 * 为什么需要**单次覆盖**（0.7.0）：近重复判重只回一句 JSON，512 就够；如果沿用设置页
 * 给抽取的 8192，这个上限对短调用没有意义，反而让「模型开始长篇解释」时白烧额度。
 * 覆盖值同样过 `MIN_MAX_OUTPUT_TOKENS` 下限——低于它连一行 JSON 都写不完。
 */
function maxTokensOf(options, request) {
    const raw = request?.maxOutputTokens ?? options?.config?.maxOutputTokens ?? options?.maxOutputTokens;
    const value = Number(raw);
    if (!Number.isFinite(value)) return DEFAULT_MAX_OUTPUT_TOKENS;
    return Math.max(MIN_MAX_OUTPUT_TOKENS, Math.trunc(value));
}

/**
 * 归一化配置里的 `reasoningEffort`。
 *
 * 返回 `''` 表示「一个键都别传」（`auto`、空值、非法值都按这个处理：
 * 非法值退默认等级由 `pickReasoningEffort()` 决定，而不是把怪值塞给宿主）。
 *
 * @param {Record<string, any>} [config]
 * @returns {string} `''` | `off` | `low` | `high` | `max`
 */
export function configuredReasoningEffort(config) {
    const raw = config?.reasoningEffort;
    if (raw === undefined || raw === null) return DEFAULT_REASONING_EFFORT;
    const value = String(raw).trim().toLowerCase();
    if (value === REASONING_EFFORT_AUTO || value === '') return REASONING_EFFORT_AUTO;
    return REASONING_EFFORT_VALUES.includes(value) ? value : DEFAULT_REASONING_EFFORT;
}

/**
 * 按**模型真实能力**挑一个能用的推理等级。
 *
 * 三条安全约束（每一条都对应宿主的一条硬校验）：
 *  1. 模型没有 `reasoning` 能力（非推理模型）⇒ 返回 `''`：宿主对「不支持却传了
 *     reasoningEffort」直接抛 `UNSUPPORTED_REASONING_EFFORT`，整次沉淀就废了；
 *  2. 想用的等级不在 `efforts` 里 ⇒ 退到该模型**支持的最低档**（`efforts[0]`，
 *     官方 title 插件同款做法），而不是硬塞；
 *  3. 配置是 `auto` ⇒ 返回 `''`，完全交回宿主默认（用户明确要「别替我决定」）。
 *
 * @param {any} model 宿主 `prepareCall` 的第二个回调参数（model info）
 * @param {Record<string, any>} [config]
 * @returns {string} `''` 或一个 `efforts` 里的 id
 */
export function pickReasoningEffort(model, config) {
    const wanted = configuredReasoningEffort(config);
    if (wanted === REASONING_EFFORT_AUTO) return '';
    return pickSupportedReasoningEffort(model, wanted);
}

/**
 * 按**模型真实能力**校验一个外部指定的推理等级（截断重试用它把等级压到最低档）。
 *
 * 语义与 `pickReasoningEffort()` 的校验部分完全一致：
 *  - 不在 `model.reasoning.efforts` 里 ⇒ 退 `efforts[0]`；
 *  - 没有 `efforts`（非推理模型 / 拿不到能力）⇒ `''`，调用侧**一个键都不传**；
 *  - `''` / `auto` ⇒ `''`（= 不干预）。
 *
 * 为什么必须过这一道：`overrides.reasoningEffort` 是「意图」，不是「命令」。盲传
 * 一个模型不支持的等级会让宿主抛 `UNSUPPORTED_REASONING_EFFORT`，重试反而把整次
 * 沉淀彻底废掉（DESIGN §13「绝不盲传」）。
 *
 * @param {any} model
 * @param {unknown} wanted
 * @returns {string} `''` 或一个 `efforts` 里的 id
 */
export function pickSupportedReasoningEffort(model, wanted) {
    const value = typeof wanted === 'string' ? wanted.trim().toLowerCase() : '';
    if (value === '' || value === REASONING_EFFORT_AUTO) return '';
    const efforts = Array.isArray(model?.reasoning?.efforts) ? model.reasoning.efforts : null;
    if (efforts === null || efforts.length === 0) return '';
    const ids = efforts.map((effort) => (typeof effort?.id === 'string' ? effort.id : '')).filter((id) => id !== '');
    if (ids.length === 0) return '';
    if (ids.includes(value)) return value;
    return ids[0];
}

/**
 * 把 `finish.failure` 折成短摘要：`UNKNOWN: 401 invalid api key`。
 *
 * 为什么 message 里必须带 `failure.message`：适配器/HTTP 层的真实原因只在这里
 * （本机 `custom-commandcode` 的 401 就藏在这一层），只写 kind 等于把根因扔掉。
 *
 * @param {any} failure
 * @returns {string}
 */
function failureSummary(failure) {
    if (failure === null || typeof failure !== 'object') return '';
    const code = typeof failure.code === 'string' ? failure.code.trim() : String(failure.code ?? '');
    const message = typeof failure.message === 'string' ? failure.message.trim() : '';
    if (code !== '' && message !== '') return `${code}: ${message}`;
    return code !== '' ? code : message;
}

/** 把流吃成一段正文；`finish` 不是正常结束就抛（带宿主给的 failure.code / message）。 */
async function collect(stream, signal) {
    let text = '';
    for await (const chunk of stream) {
        // 超时/取消后立刻停止拉流：宿主的 stream 认 signal，但这里再兜一道，
        // 免得「我们不等了」之后还继续把 token 读进内存。
        if (signal?.aborted === true) {
            throw signal.reason instanceof Error ? signal.reason : codedError(LLM_ABORTED, '调用已被取消');
        }
        if (chunk === null || typeof chunk !== 'object') continue;
        if (chunk.type === 'text-delta') {
            if (typeof chunk.text === 'string') text += chunk.text;
            continue;
        }
        if (chunk.type === 'finish') {
            const finish = finishOf(chunk);
            const kind = typeof finish?.kind === 'string' && finish.kind !== '' ? finish.kind : 'unknown';
            if (SUCCESS_FINISH.has(kind)) return text;
            const summary = failureSummary(finish?.failure);
            // `details.finish` 放**宿主原始块**（`{type:'finish', reason:{kind, failure}}`）：
            // 上层（runlog detail / status）按 `details.finish.reason.failure.message` 原样渲染，
            // 不必从 message 里正则抠消息；`finish` 仍留归一后的 reason 供老调用方使用。
            const details = { finish: chunk };
            if (kind === 'max-tokens') {
                // **带上已经收到的正文**：`max_tokens` 是「推理 + 正文」的总预算，额度在
                // 上游就被思考吃完了；但截断不代表正文是废的——很可能 JSON 已经写完整，
                // 只是最后一点尾巴没了。抽取侧（`extractor.salvageTruncatedResponse`）
                // 会拿这段正文尝试补全解析，能救就救，救不了才判失败。
                throw codedError(LLM_TRUNCATED, `模型输出被 max-tokens 截断，结论不完整${summary === '' ? '' : `（${summary}）`}`, { finish, details, text });
            }
            // 空字符串的 failure.code 也会回退（见 `codeOf()`）：否则上层只能看到裸的
            // `extract-model-error`，本机 37/37 的现场就查不出原因。
            // 注意：宿主对非 HarnessError 会给 `code: 'UNKNOWN'`（此时 reason 记 :UNKNOWN，
            // 真实原因在 failure.message 里）；适配器自己吐的可能是 `code: ''`。
            const code = codeOf({ code: finish?.failure?.code ?? '' }, LLM_FINISHED_ABORTED);
            throw codedError(
                code,
                `模型调用未正常结束（${kind}${summary === '' ? '' : `，${summary}`}）`,
                { finish, details },
            );
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
 * @returns {(request: {
 *   prompt: string, provider?: string, model?: string, sessionId?: string, signal?: AbortSignal,
 *   overrides?: { reasoningEffort?: string }, maxOutputTokens?: number,
 * }) => Promise<string>}
 */
export function createCallModel(options = {}) {
    /**
     * 生效的超时（毫秒），**每次调用现读**：
     *  1. `config.callTimeoutMs`（设置页可改，改完下一轮就生效，不用重启）；
     *  2. `options.timeoutMs`（单测/注入用）；
     *  3. `DEFAULT_TIMEOUT_MS`（20s，老默认，仅作回退）。
     */
    const timeoutMsOf = () => {
        if (Number.isFinite(options.config?.callTimeoutMs)) return Math.max(1, options.config.callTimeoutMs);
        if (Number.isFinite(options.timeoutMs)) return Math.max(1, options.timeoutMs);
        return DEFAULT_TIMEOUT_MS;
    };

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
        const sessionId = typeof request.sessionId === 'string' && request.sessionId.trim() !== ''
            ? request.sessionId.trim()
            : '';
        // 输出上限显式给：宿主的 `defaultMaxTokens` 可能不存在（等于不限），
        // 而截断/不截断直接决定登录失败时能不能看到真实报错。
        const maxTokens = maxTokensOf(options, request);
        const timeoutMs = timeoutMsOf();

        /*
         * 自己造一个 AbortController：超时后必须**真的把底层流掐掉**。
         *
         * 旧的 `withTimeout` 只是 `Promise.race` 里我们不等了，`call.stream` 还在跑、
         * 还在烧额度（真实现场就是 20s 超时后请求仍在继续）。现在：
         *  - `prepareCall(..., signal, ...)` 与 `call.stream({..., signal})` 都用这个 signal；
         *  - 超时分支里 `controller.abort(LLM_TIMEOUT 错误)`，宿主适配器会中断请求；
         *  - 调用方自己的 `request.signal` 也转发进来（取消/超时共用一条链路）。
         */
        const controller = new AbortController();
        const callerSignal = request.signal;
        const forwardAbort = () => {
            try {
                controller.abort(callerSignal?.reason);
            } catch {
                controller.abort();
            }
        };
        if (callerSignal !== undefined && typeof callerSignal.addEventListener === 'function') {
            callerSignal.addEventListener('abort', forwardAbort, { once: true });
        }
        const signal = controller.signal;

        /**
         * 真正发一次调用。**优先走 `prepareCall`**（官方写法，见
         * `@deepseek-ai/dsh-session-title-llm/lib/index.js`）：
         *  - `prepareCall` 把 adapters 注册、模型能力、默认值**一次性绑定**，返回的
         *    `call.stream` 只接受与 `call.config` 逐字段相等的 options（`callConfigEquals`
         *    会校验 provider/model/reasoningEffort/temperature/maxTokens/stop），所以我们
         *    只往上加 `messages` / `sessionId` / `purpose` / `signal`；
         *  - 直接 `llm.stream({provider, model, messages})` 会在 prepared === undefined 时
         *    临时再 `prepareCall` + `resolveCallWithInfo`，缺 `maxTokens/purpose` 时更容易
         *    在「进 adapter 之前」就死掉（本机线上 0 次调用、37/37 失败的嫌疑点）。
         *  - 宿主没有 `prepareCall`（老版本 / 单测假 llm）⇒ **回退** 一次性 `llm.stream`。
         */
        const invoke = async () => {
            if (typeof llm.prepareCall === 'function') {
                /*
                 * 推理等级的**意图**：`request.overrides.reasoningEffort`（截断重试用它压到
                 * 最低档）优先于设置页的 `config.reasoningEffort`。两者都只是意图，最终能否
                 * 使用由下面的能力回调决定（DESIGN §13）。
                 */
                const wantedEffort = typeof request.overrides?.reasoningEffort === 'string'
                    ? request.overrides.reasoningEffort
                    : '';
                const call = await llm.prepareCall(
                    { provider: route.provider, model: route.model, maxTokens },
                    signal,
                    (controls, model) => {
                        // 推理等级**只能在回调里定**：`model` 是这次调用绑定到的
                        // 真实模型能力（`reasoning.efforts`），拿不到就一个键都不传，
                        // 否则宿主抛 `UNSUPPORTED_REASONING_EFFORT` 把整次沉淀废掉。
                        const effort = wantedEffort === ''
                            ? pickReasoningEffort(model, options.config)
                            : pickSupportedReasoningEffort(model, wantedEffort);
                        return effort === '' ? controls : { ...controls, reasoningEffort: effort };
                    },
                );
                const prepared = {
                    // 先兜底 route，再用 `call.config` 覆盖：宿主会拿 prepared 的 config 与
                    // `call.config` 做 `callConfigEquals` 校验，字段必须逐字一致。
                    provider: route.provider,
                    model: route.model,
                    maxTokens,
                    ...(call?.config ?? {}),
                    messages,
                    purpose: CALL_PURPOSE,
                };
                if (sessionId !== '') prepared.sessionId = sessionId;
                prepared.signal = signal;
                if (typeof call?.stream !== 'function') {
                    throw codedError(NO_ADAPTER, '宿主 llm.prepareCall 没有返回 stream()');
                }
                return collect(call.stream(prepared), signal);
            }
            /**
             * 回退分支**故意不传 `reasoningEffort`**：这里拿不到模型能力（没有
             * `prepareCall` 的 model 回调），盲传会让不支持推理的模型直接
             * `UNSUPPORTED_REASONING_EFFORT`。老宿主上「少省一点 token」比「整次失败」划算。
             */
            const direct = {
                provider: route.provider,
                model: route.model,
                maxTokens,
                messages,
                purpose: CALL_PURPOSE,
            };
            if (sessionId !== '') direct.sessionId = sessionId;
            direct.signal = signal;
            return collect(llm.stream(direct), signal);
        };

        try {
            const outcome = await withTimeout(invoke, timeoutMs);
            if (outcome.ok) return outcome.value;
            if (outcome.reason === 'timeout') {
                const error = codedError(LLM_TIMEOUT, `模型调用超时（${timeoutMs}ms）`, { timeoutMs });
                // **先掐断，再报错**：只抛不 abort 会让请求继续在后台跑（真实故障：
                // 20s 超时后底层还在烧额度）。
                try {
                    controller.abort(error);
                } catch {
                    /* abort 本身不该把错误替换掉 */
                }
                options.logger?.warn?.(`[persona-memory-consolidate] LLM 超时（${timeoutMs}ms，${route.provider}/${route.model}，已中断请求）`);
                throw error;
            }
            // 原始错误原样上抛：`finish.failure.code` 是上层决定退避还是放弃的唯一依据。
            throw outcome.error ?? codedError('LLM_ERROR', '模型调用失败');
        } finally {
            if (callerSignal !== undefined && typeof callerSignal.removeEventListener === 'function') {
                callerSignal.removeEventListener('abort', forwardAbort);
            }
        }
    };
}

/**
 * 从宿主会话对象读「最近一次请求的 route」：`session.requestHeader()?.config`。
 *
 * 这是「继承最近使用的模型」的第一优先来源——用户刚用它跑完这轮对话，
 * 沉淀就用同一个路线，不要求用户再去设置页填一次 provider/model。
 *
 * @param {any} session
 * @returns {{ provider: string, model: string } | null}
 */
export function readSessionRoute(session) {
    try {
        const config = session?.requestHeader?.()?.config;
        if (config === null || typeof config !== 'object') return null;
        const provider = typeof config.provider === 'string' ? config.provider.trim() : '';
        const model = typeof config.model === 'string' ? config.model.trim() : '';
        return provider === '' || model === '' ? null : { provider, model };
    }
    catch {
        return null;
    }
}

/**
 * 宿主设置页里的默认模型（`agentDefaultModel` 服务）；会话还没跑过请求时的兜底。
 *
 * @param {any} ctx
 * @returns {{ provider: string, model: string } | null}
 */
export function readDefaultModelRoute(ctx) {
    try {
        const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.();
        if (selection === null || typeof selection !== 'object') return null;
        const provider = typeof selection.provider === 'string' ? selection.provider.trim() : '';
        const model = typeof selection.model === 'string' ? selection.model.trim() : '';
        return provider === '' || model === '' ? null : { provider, model };
    }
    catch {
        return null;
    }
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
