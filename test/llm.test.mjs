/**
 * 真实模型调用（M1）：`ctx.llm.stream` 的块协议、route 解析优先级、错误码、route 回读。
 *
 * 宿主的块形状取自 M0 §1（`dsh-llm/README.md` 的 Minimal composition）：
 * `block-start` / `text-delta{text}` / `tool-call-delta` / `usage` / `finish{kind, failure?}`。
 *
 * 全部用例用**假流**，一个网络包都不发。
 *
 * 跑法：node test/llm.test.mjs
 */

import assert from 'node:assert/strict';
import {
    CALL_PURPOSE,
    DEFAULT_MAX_OUTPUT_TOKENS,
    DEFAULT_TIMEOUT_MS,
    MIN_MAX_OUTPUT_TOKENS,
    createCallModel,
    codeOf,
    describeFinish,
    detailOfError,
    finishOf,
    lastRouteFromEvents,
    readDefaultModelRoute,
    readSessionRoute,
    resolveRoute,
    resolveRouteSource,
    ROUTE_SOURCE,
    LLM_FINISHED_ABORTED,
    LLM_NO_FINISH,
    LLM_TIMEOUT,
    LLM_TRUNCATED,
    NO_ADAPTER,
    NO_ROUTE,
} from '../lib/llm.js';

/** 假 llm 服务：按给定块序列回放，并记录收到的请求。 */
function fakeLlm(chunks, options = {}) {
    const requests = [];
    return {
        requests,
        stream(request) {
            requests.push(request);
            return (async function* replay() {
                if (typeof options.delayMs === 'number') await new Promise((resolve) => setTimeout(resolve, options.delayMs));
                for (const chunk of chunks) yield chunk;
            })();
        },
    };
}

const MESSAGES = (prompt) => [{ role: 'user', content: [{ type: 'text', text: prompt }] }];

/* ── 1. 正常一轮：只拼 text-delta，遇到 finish 就停 ── */
const okLlm = fakeLlm([
    { type: 'block-start', index: 0 },
    { type: 'text-delta', text: '结论一。' },
    { type: 'tool-call-delta', name: 'shell' },
    { type: 'text-delta', text: '结论二。' },
    { type: 'usage', inputTokens: 10, outputTokens: 4 },
    { type: 'finish', kind: 'end' },
    { type: 'text-delta', text: 'finish 之后的块必须被忽略' },
]);
const callModel = createCallModel({ getLlm: () => okLlm, config: { provider: 'workbuddy-cn', model: 'deepseek-v4.1-flash' } });
assert.equal(await callModel({ prompt: '把这段对话抽成结论' }), '结论一。结论二。');
assert.equal(okLlm.requests.length, 1);
const { signal: directSignal, ...directShape } = okLlm.requests[0];
assert.deepEqual(directShape, {
    provider: 'workbuddy-cn',
    model: 'deepseek-v4.1-flash',
    maxTokens: 2048,
    messages: MESSAGES('把这段对话抽成结论'),
    purpose: 'memory-consolidate',
}, '没有 prepareCall 时回退 llm.stream，并显式带 maxTokens / purpose');
assert.equal(typeof directSignal?.aborted, 'boolean', '必须把 AbortSignal 传下去（超时才能真中断）');
assert.equal(directSignal.aborted, false, '正常返回后 signal 不该被 abort');

/* ── 2. route 优先级：显式参数 → config → defaults ── */
assert.deepEqual(resolveRoute({ provider: 'p-explicit', model: 'm-explicit', config: { provider: 'p-config', model: 'm-config' } }), {
    provider: 'p-explicit',
    model: 'm-explicit',
});
assert.deepEqual(resolveRoute({ config: { provider: 'p-config', model: 'm-config' }, defaults: { provider: 'p-default', model: 'm-default' } }), {
    provider: 'p-config',
    model: 'm-config',
});
assert.deepEqual(resolveRoute({ provider: '', model: '  ', config: { provider: '', model: '' }, defaults: { provider: 'p-default', model: 'm-default' } }), {
    provider: 'p-default',
    model: 'm-default',
}, '空串 = 没设过，必须继续回落');
assert.equal(resolveRoute({ config: {}, defaults: {} }), null);
assert.equal(resolveRoute({ config: { provider: 'only-provider' } }), null, '只有一半也不能算有效 route');
const dynamicDefaults = createCallModel({
    getLlm: () => fakeLlm([{ type: 'finish', kind: 'end' }]),
    config: {},
    defaults: () => ({ provider: 'workbuddy-cn', model: 'deepseek-v4.1-flash' }),
});
assert.equal(await dynamicDefaults({ prompt: 'x' }), '', 'defaults 可以是函数（M2 用它跟随会话 route）');

/* ── 3. 没有 route ⇒ NO_ROUTE；没有 llm 服务 ⇒ NO_ADAPTER ── */
await assert.rejects(
    () => createCallModel({ getLlm: () => okLlm, config: {} })({ prompt: 'x' }),
    (error) => error.code === NO_ROUTE,
);
await assert.rejects(
    () => createCallModel({ getLlm: () => undefined, config: { provider: 'p', model: 'm' } })({ prompt: 'x' }),
    (error) => error.code === NO_ADAPTER,
);
await assert.rejects(
    () => createCallModel({ getLlm: () => ({ stream: 'not-a-function' }), config: { provider: 'p', model: 'm' } })({ prompt: 'x' }),
    (error) => error.code === NO_ADAPTER,
);

/* ── 4. finish 不是 end ⇒ 抛 talking 错误码（绝不把半截正文当结论） ── */
await assert.rejects(
    () => createCallModel({
        getLlm: () => fakeLlm([{ type: 'text-delta', text: '半截结论' }, { type: 'finish', kind: 'error', failure: { code: 'RATE_LIMIT' } }]),
        config: { provider: 'p', model: 'm' },
    })({ prompt: 'x' }),
    (error) => error.code === 'RATE_LIMIT',
    '宿主的稳定错误码要原样带出来（NO_ADAPTER / AUTH / RATE_LIMIT / QUOTA / CONTEXT_WINDOW_EXCEEDED）',
);
await assert.rejects(
    () => createCallModel({
        getLlm: () => fakeLlm([{ type: 'finish', kind: 'aborted' }]),
        config: { provider: 'p', model: 'm' },
    })({ prompt: 'x' }),
    (error) => error.code === LLM_FINISHED_ABORTED,
    '没带 failure 时用兜底码',
);

/* ── 5. 流结束但没 finish ⇒ 明确报错（不返回半截） ── */
await assert.rejects(
    () => createCallModel({
        getLlm: () => fakeLlm([{ type: 'text-delta', text: '只有正文' }]),
        config: { provider: 'p', model: 'm' },
    })({ prompt: 'x' }),
    (error) => error.code === LLM_NO_FINISH,
);

/* ── 6. 超时（02 §7.5 单次 20s；这里用 20ms 验证机制） ── */
await assert.rejects(
    () => createCallModel({
        getLlm: () => fakeLlm([{ type: 'finish', kind: 'end' }], { delayMs: 60 }),
        config: { provider: 'p', model: 'm' },
        timeoutMs: 20,
    })({ prompt: 'x' }),
    (error) => error.code === LLM_TIMEOUT,
);

/* ── 7. 已取消的 signal：连 stream 都不开 ── */
const abortLlm = fakeLlm([{ type: 'finish', kind: 'end' }]);
const controller = new AbortController();
controller.abort();
await assert.rejects(
    () => createCallModel({ getLlm: () => abortLlm, config: { provider: 'p', model: 'm' } })({ prompt: 'x', signal: controller.signal }),
    (error) => error.code === 'LLM_ABORTED',
);
assert.equal(abortLlm.requests.length, 0);

/* ── 8. 从会话事件流回读「最近一次 route」（02 §7.1） ── */
const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'request/header', seq: 2, data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } } } },
    { type: 'assistant/message', seq: 3, data: {} },
    { type: 'request/header', seq: 4, data: { header: { config: { provider: 'workbuddy-cn', model: 'deepseek-v4.1-flash' } } } },
    { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } },
];
assert.deepEqual(lastRouteFromEvents(events), { provider: 'workbuddy-cn', model: 'deepseek-v4.1-flash' }, '取最后一条 request/header');
assert.equal(lastRouteFromEvents([]), null);
assert.equal(lastRouteFromEvents(undefined), null);
assert.equal(lastRouteFromEvents([{ type: 'turn/end', data: {} }]), null, '没有 request/header ⇒ null');
assert.equal(
    lastRouteFromEvents([{ type: 'request/header', data: { header: { config: { provider: 'p' } } } }]),
    null,
    'config 里缺 model ⇒ 不算有效 route',
);
assert.deepEqual(
    lastRouteFromEvents([{ type: 'request/header', data: { config: { provider: 'p', model: 'm' } } }]),
    { provider: 'p', model: 'm' },
    '兼容「config 直接挂在 data 上」的旧形状',
);


/* ── 9. 宿主真实 finish 形状：`{ reason: { kind, failure } }`（2026-11 合同） ── */
const hostShape = fakeLlm([
    { type: 'text-delta', text: '宿主导出的结论。' },
    { type: 'finish', reason: { kind: 'stop' } },
]);
assert.equal(
    await createCallModel({ getLlm: () => hostShape, config: { provider: 'p', model: 'm' } })({ prompt: 'x' }),
    '宿主导出的结论。',
    'reason.kind = stop 必须当成功（旧代码只看 chunk.kind ⇒ 每次都当失败）',
);
assert.deepEqual(finishOf({ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } }), { kind: 'error', failure: { code: 'AUTH' } });
assert.deepEqual(finishOf({ type: 'finish', kind: 'end' }), { kind: 'end', failure: undefined }, '旧形状仍兼容');

await assert.rejects(
    () => createCallModel({
        getLlm: () => fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad key' } } }]),
        config: { provider: 'p', model: 'm' },
    })({ prompt: 'x' }),
    (error) => error.code === 'AUTH',
    '宿主的 failure.code 必须原样上抛（runlog 才看得见原因）',
);
await assert.rejects(
    () => createCallModel({
        getLlm: () => fakeLlm([{ type: 'text-delta', text: '{"memories":' }, { type: 'finish', reason: { kind: 'max-tokens' } }]),
        config: { provider: 'p', model: 'm' },
    })({ prompt: 'x' }),
    (error) => error.code === LLM_TRUNCATED,
    '截断的半截 JSON 不许当结论',
);

/* ── 10. 继承最近一次真实请求的 route（session.requestHeader → 默认模型） ── */
const sessionLike = { requestHeader: () => ({ config: { provider: 'workbuddy-cn', model: 'deepseek-v4.1-flash' } }) };
assert.deepEqual(readSessionRoute(sessionLike), { provider: 'workbuddy-cn', model: 'deepseek-v4.1-flash' });
assert.equal(readSessionRoute({ requestHeader: () => ({}) }), null);
assert.equal(readSessionRoute({ requestHeader: () => { throw new Error('boom'); } }), null, '读 route 永不抛');
assert.equal(readSessionRoute(null), null);

const defaultModelCtx = { get: (key) => (key === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'qianfan', model: 'deepseek-v4.1-flash-1017' }) } : undefined) };
assert.deepEqual(readDefaultModelRoute(defaultModelCtx), { provider: 'qianfan', model: 'deepseek-v4.1-flash-1017' });

let inheritedRoute = null;
const inherited = createCallModel({
    getLlm: () => fakeLlm([{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }]),
    config: {},
    defaults: () => readSessionRoute(sessionLike) ?? readDefaultModelRoute(defaultModelCtx),
});
inheritedRoute = await inherited({ prompt: 'x' });
assert.equal(inheritedRoute, 'ok', 'config 空 + 会话 route 在 ⇒ 必须能真正调起来（本次修复的核心）');

/* ── 11. 空字符串 failure.code 必须回退（本机 35/35 只看到裸 extract-model-error 的根因） ── */
await assert.rejects(
    () => createCallModel({
        getLlm: () => fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { code: '' } } }]),
        config: { provider: 'p', model: 'm' },
    })({ prompt: 'x' }),
    (error) => error.code === LLM_FINISHED_ABORTED,
    "failure.code 是空串时必须回退成 LLM_FINISHED_ABORTED（`??` 不会为空串兜底）",
);
assert.equal(codeOf({ code: '' }, 'fallback'), 'fallback');
assert.equal(codeOf({ code: '   ' }, 'fallback'), 'fallback', '纯空白也算缺失');
assert.equal(codeOf({ code: 'AUTH' }, 'fallback'), 'AUTH');
assert.equal(codeOf(new TypeError('x'), 'model-error'), 'TypeError', 'name 作为最后一级来源');
assert.equal(codeOf(null, 'model-error'), 'model-error');

/* ── 12. finish 形状要能原样写进 detail（区分「非正常结束」与「路线没接上」） ── */
assert.equal(describeFinish({ kind: 'error', failure: { code: '' } }), "finish.kind=error failure.code=''");
assert.ok(describeFinish({ kind: 'error', failure: { code: 'AUTH', message: 'bad key' } }).includes("failure.code='AUTH'"));
assert.equal(describeFinish({ kind: 'stop' }), 'finish.kind=stop');
assert.equal(describeFinish(null), 'finish=(none)');
const abortedDetail = detailOfError(Object.assign(new Error('模型调用未正常结束（error）'), { code: '', finish: { kind: 'error', failure: { code: '' } } }));
assert.ok(abortedDetail.startsWith('Error: 模型调用未正常结束'), `detail 要含 name: message：${abortedDetail}`);
assert.ok(abortedDetail.includes("finish.kind=error failure.code=''"), `detail 要原样带 finish 形状：${abortedDetail}`);

/* ── 13. 抽取路线的来源（status 用；逐字段回落，绝不猜） ── */
assert.deepEqual(
    resolveRouteSource({ config: { provider: 'p-set', model: 'm-set' }, lastRoute: { provider: 'p-sess', model: 'm-sess' } }),
    { ok: true, provider: 'p-set', model: 'm-set', providerSource: ROUTE_SOURCE.SETTINGS, modelSource: ROUTE_SOURCE.SETTINGS, sources: [ROUTE_SOURCE.SETTINGS] },
    '设置页优先',
);
const fromSession = resolveRouteSource({ config: {}, lastRoute: { provider: 'p-sess', model: 'm-sess' }, defaultRoute: { provider: 'p-host', model: 'm-host' } });
assert.equal(fromSession.providerSource, ROUTE_SOURCE.SESSION);
assert.equal(fromSession.modelSource, ROUTE_SOURCE.SESSION);
const mixed = resolveRouteSource({ config: { provider: 'p-set' }, defaultRoute: { provider: 'p-host', model: 'm-host' } });
assert.deepEqual(mixed.sources, [ROUTE_SOURCE.SETTINGS, ROUTE_SOURCE.DEFAULT], 'provider 与 model 可以来自不同级');
assert.equal(mixed.modelSource, ROUTE_SOURCE.DEFAULT);
const unknown = resolveRouteSource({ config: {}, lastRoute: null, defaultRoute: null });
assert.equal(unknown.ok, false);
assert.deepEqual(unknown.sources, [], '拿不到就报 unknown，绝不编造');

/* ── 14. prepareCall 优先（官方写法）：purpose / maxTokens / sessionId 都要传下去 ── */
function fakePreparedLlm(chunks) {
    const preparedCalls = [];
    const streams = [];
    return {
        preparedCalls,
        streams,
        async prepareCall(config, signal, configure) {
            preparedCalls.push({ config, signal, configured: configure({}, { defaultMaxTokens: 1024 }) });
            const resolved = { provider: config.provider, model: config.model, maxTokens: config.maxTokens, temperature: 0.2 };
            return {
                config: resolved,
                stream(options) {
                    // 模拟宿主的 `callConfigEquals`：prepared 的 config 字段必须逐字带回来，
                    // 少一个/改一个都会抛 INVALID_PREPARED_CALL（真实故障很难复现，这里钉死）。
                    const same = options.provider === resolved.provider
                        && options.model === resolved.model
                        && options.maxTokens === resolved.maxTokens
                        && options.temperature === resolved.temperature;
                    if (!same) throw new Error('INVALID_PREPARED_CALL: prepared config changed before adapter dispatch');
                    streams.push(options);
                    return (async function* replay() {
                        for (const chunk of chunks) yield chunk;
                    })();
                },
            };
        },
        stream() {
            throw new Error('有 prepareCall 时绝不该走回退的 llm.stream');
        },
    };
}

const preparedLlm = fakePreparedLlm([
    { type: 'text-delta', text: '走 prepareCall' },
    { type: 'finish', reason: { kind: 'stop' } },
]);
const preparedCall = createCallModel({
    getLlm: () => preparedLlm,
    config: { provider: 'p-host', model: 'm-host', maxOutputTokens: 512 },
});
assert.equal(await preparedCall({ prompt: 'x', sessionId: 'session-abc' }), '走 prepareCall');
assert.equal(preparedLlm.preparedCalls.length, 1, '必须先 prepareCall');
assert.deepEqual(preparedLlm.preparedCalls[0].config, { provider: 'p-host', model: 'm-host', maxTokens: 512 }, 'maxTokens 来自 config.maxOutputTokens');
assert.equal(preparedLlm.streams.length, 1, 'prepared 的 stream 只发一次');
assert.equal(preparedLlm.streams[0].purpose, CALL_PURPOSE, 'purpose 必须是 memory-consolidate');
assert.equal(preparedLlm.streams[0].sessionId, 'session-abc', 'sessionId 要透传（宿主归因）');
assert.equal(preparedLlm.streams[0].maxTokens, 512, 'prepared 的 config 字段必须逐字带回去（宿主会 callConfigEquals 校验）');
assert.equal(preparedLlm.streams[0].provider, 'p-host');
assert.equal(preparedLlm.streams[0].model, 'm-host');
assert.equal(preparedLlm.streams[0].messages[0].content[0].text, 'x');
assert.equal(typeof preparedLlm.preparedCalls[0].signal?.aborted, 'boolean', 'prepareCall 也要收到 signal');
assert.equal(preparedLlm.preparedCalls[0].signal, preparedLlm.streams[0].signal, 'prepareCall / stream 用同一个 signal');
assert.equal(preparedLlm.streams[0].signal.aborted, false, '正常返回后 signal 不该被 abort');
assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, 2048);
assert.equal(MIN_MAX_OUTPUT_TOKENS, 256);

/* 回退路径（没有 prepareCall）：显式 maxTokens / purpose，且不给 sessionId 时就不带该键 */
const fallbackLlm = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }]);
await createCallModel({ getLlm: () => fallbackLlm, config: { provider: 'p', model: 'm', maxOutputTokens: 100 } })({ prompt: 'x' });
assert.equal(fallbackLlm.requests[0].maxTokens, 256, '低于下限按 256 收口');
assert.equal(Object.prototype.hasOwnProperty.call(fallbackLlm.requests[0], 'sessionId'), false, '没有 sessionId 就不加这个键');

/* ── 15. finish.failure 的真实 message 必须透出（401 这类根因只在 failure.message 里） ── */
const authMessageLlm = fakeLlm([
    { type: 'finish', reason: { kind: 'error', failure: { code: '', message: '401 invalid api key' } } },
]);
let authError = null;
try {
    await createCallModel({ getLlm: () => authMessageLlm, config: { provider: 'p', model: 'm' } })({ prompt: 'x' });
} catch (error) {
    authError = error;
}
assert.ok(authError !== null, '必须抛错');
assert.equal(authError.code, LLM_FINISHED_ABORTED, '空 code 回退成 LLM_FINISHED_ABORTED');
assert.ok(authError.message.includes('401 invalid api key'), `error.message 要带 failure.message：${authError.message}`);
assert.equal(authError.details.finish.reason.failure.message, '401 invalid api key', 'details.finish 要是宿主原始形状');
const authDetail = detailOfError(authError);
assert.ok(authDetail.includes('401 invalid api key'), `detail 要含 failure.message：${authDetail}`);
assert.ok(authDetail.includes("failure.code=''"), `detail 也要保留空 code 的事实：${authDetail}`);

/* ── 16. failure.code='UNKNOWN'（宿主对非 HarnessError 的归一）也要能显示 message ── */
const unknownLlm = fakeLlm([
    { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: '401 invalid api key' } } },
]);
let unknownError = null;
try {
    await createCallModel({ getLlm: () => unknownLlm, config: { provider: 'p', model: 'm' } })({ prompt: 'x' });
} catch (error) {
    unknownError = error;
}
assert.equal(unknownError.code, 'UNKNOWN', "reason 会记成 extract-model-error:UNKNOWN");
assert.ok(unknownError.message.includes('UNKNOWN') && unknownError.message.includes('401 invalid api key'), unknownError.message);
assert.ok(detailOfError(unknownError).includes("failure.code='UNKNOWN'"));
assert.ok(detailOfError(unknownError).includes('401 invalid api key'));

/* ── 17. describeFinish / detailOfError 兼容宿主原始 finish 块（details.finish.reason.*） ── */
assert.equal(describeFinish({ type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: 'bad key' } } }),
    "finish.kind=error failure.code='UNKNOWN' failure.message=bad key");
const nestedDetail = detailOfError({
    name: 'Error',
    message: 'boom',
    details: { finish: { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: '401 invalid api key' } } } },
});
assert.ok(nestedDetail.includes('401 invalid api key'), nestedDetail);

/* ── 18. 超时必须**真的中断请求**：signal.aborted === true（旧实现只是不等了，请求还在烧钱） ── */
function hangingLlm(onAbort) {
    const requests = [];
    return {
        requests,
        stream(request) {
            requests.push(request);
            return (async function* replay() {
                await new Promise((resolve) => {
                    if (request.signal.aborted) {
                        onAbort();
                        resolve();
                        return;
                    }
                    request.signal.addEventListener('abort', () => {
                        onAbort();
                        resolve();
                    }, { once: true });
                });
                throw Object.assign(new Error('aborted by timeout'), { code: 'ABORTED' });
            })();
        },
    };
}

let abortSeen = 0;
const hanging = hangingLlm(() => { abortSeen += 1; });
// 超时值取自 config.callTimeoutMs（动态生效，不再写死 20s）
const hangingModel = createCallModel({ getLlm: () => hanging, config: { provider: 'p', model: 'm', callTimeoutMs: 25 } });
let timeoutError = null;
try {
    await hangingModel({ prompt: 'x' });
} catch (error) {
    timeoutError = error;
}
assert.ok(timeoutError !== null, '必须超时报错');
assert.equal(timeoutError.code, LLM_TIMEOUT);
assert.equal(timeoutError.message, '模型调用超时（25ms）', '超时值来自 config.callTimeoutMs');
assert.equal(timeoutError.timeoutMs, 25);
assert.equal(hanging.requests[0].signal.aborted, true, '超时后必须 abort 底层请求（signal.aborted === true）');
await new Promise((resolve) => setImmediate(resolve));
assert.equal(abortSeen, 1, '底层流真的收到了 abort（不是只在我们这边不等了）');

/* 调用方自己的 signal 也会被转发进来（取消/超时共用一条链路） */
const callerController = new AbortController();
const forwarded = hangingLlm(() => {});
const forwardedModel = createCallModel({ getLlm: () => forwarded, config: { provider: 'p', model: 'm', callTimeoutMs: 5_000 } });
const forwardedPromise = forwardedModel({ prompt: 'x', signal: callerController.signal });
callerController.abort();
let forwardedError = null;
try {
    await forwardedPromise;
} catch (error) {
    forwardedError = error;
}
assert.ok(forwardedError !== null, '调用方取消后必须抛错');
assert.equal(forwarded.requests[0].signal.aborted, true, '调用方 abort 要转发到内部 controller');

/* ── 19. 生效超时的优先级：config.callTimeoutMs > options.timeoutMs > DEFAULT_TIMEOUT_MS ── */
assert.equal(DEFAULT_TIMEOUT_MS, 20_000, '老默认常量保留（仅作回退）');
const fallbackTimeout = createCallModel({
    getLlm: () => hangingLlm(() => {}),
    // 不给 callTimeoutMs，也不给 timeoutMs ⇒ 回退 20s（这里只断言构造不炸，不等它超时）
    config: { provider: 'p', model: 'm' },
});
assert.equal(typeof fallbackTimeout, 'function');

console.log('✓ llm.test.mjs 全部通过');
