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
import { createCallModel, lastRouteFromEvents, resolveRoute, LLM_FINISHED_ABORTED, LLM_NO_FINISH, LLM_TIMEOUT, NO_ADAPTER, NO_ROUTE } from '../lib/llm.js';

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
assert.deepEqual(okLlm.requests[0], {
    provider: 'workbuddy-cn',
    model: 'deepseek-v4.1-flash',
    messages: MESSAGES('把这段对话抽成结论'),
}, '调用形状要与 M0 §1 的 Minimal composition 一致');

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

console.log('✓ llm.test.mjs 全部通过');
