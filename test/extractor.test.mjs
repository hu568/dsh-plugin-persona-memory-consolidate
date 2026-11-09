/**
 * 抽取：提示词逐字对照 02 §4.1、裁决段注入、JSON 解析与逐条校验（§7.2 / §7.3.5）。
 *
 * 跑法：node test/extractor.test.mjs
 */

import assert from 'node:assert/strict';
import {
    ADJUDICATION_RULES,
    CONFIDENCES,
    DEFAULT_IMPORTANCE,
    DEFAULT_KIND,
    EXTRACTION_RULES,
    KINDS,
    MAX_CANDIDATES,
    TRUNCATE_RETRY_REASONING_EFFORT,
    buildAdjudicationBlock,
    buildConversation,
    buildExtractionPrompt,
    createExtractor,
    normalizeImportance,
    normalizeKind,
    normalizeMemories,
    parseExtractionResponse,
    parseModelJson,
    salvageTruncatedResponse,
} from '../lib/extractor.js';
import { LLM_TRUNCATED } from '../lib/llm.js';

/* 规则正文必须与 02 §4.1 + DESIGN v3 §14.1 一致（8 条规则 + 输出格式） */
const ruleLines = EXTRACTION_RULES.split('\n');
assert.equal(ruleLines[0], '从下面的对话里，抽出值得长期记住的结论。');
assert.ok(EXTRACTION_RULES.includes('1. 一条一个结论，第三人称陈述句。'));
assert.ok(EXTRACTION_RULES.includes('2. 只写结论，不写原因、不写过程、不写评价。'));
assert.ok(EXTRACTION_RULES.includes('3. 没有值得记的就返回空数组。'));
assert.ok(EXTRACTION_RULES.includes('4. scope：global=任何项目都成立的；project=只跟当前目录有关的；journal=一次性事件。'));
assert.ok(EXTRACTION_RULES.includes('5. 不写密钥、密码、token、手机号、身份证、卡号；必须提到时一律写成 ⟨redacted⟩。'));
assert.ok(EXTRACTION_RULES.includes('6. 不写「助手能 / 不能做什么」这类服务边界'));
/* DESIGN §14.1 规则 7：结论/细节分层（实现细节不进静态槽） */
assert.ok(EXTRACTION_RULES.includes('7. 只写换个话题仍然成立、以后还会反复用到的结论'));
assert.ok(EXTRACTION_RULES.includes('实现细节'));
assert.ok(EXTRACTION_RULES.includes('scope=journal'));
/* DESIGN §14.1 规则 8：每条标 kind 与 importance */
assert.ok(EXTRACTION_RULES.includes('8. 每条标 kind 与 importance'));
assert.ok(EXTRACTION_RULES.includes('kind=detail 或 importance≤2 的 scope 必须写 journal'));
assert.equal(
    ruleLines[ruleLines.length - 1],
    '{"memories":[{"scope":"global|project|journal","content":"...","confidence":"high|medium|low","kind":"conclusion|detail","importance":3}]}',
);
assert.ok(ruleLines.length <= 15, `§4.1 说「约 15 行」，实得 ${ruleLines.length} 行`);
assert.ok(EXTRACTION_RULES.includes('不要解释，不要代码块围栏'));

/* 对话渲染 */
const conversation = buildConversation([
    { turn: 3, user: '问一下 tarball 怎么装', assistant: '用 pnpm add file:xxx.tgz。' },
    { turn: 4, user: '', assistant: '' },
]);
assert.ok(conversation.includes('### 第 3 轮'));
assert.ok(conversation.includes('用户：问一下 tarball 怎么装'));
assert.ok(conversation.includes('助手：用 pnpm add file:xxx.tgz。'));
assert.ok(!conversation.includes('第 4 轮'), '空回合不该出现');

/* 基础 prompt：规则 + 对话 */
const prompt = buildExtractionPrompt({ turns: [{ turn: 1, user: '问题', assistant: '结论' }] });
assert.ok(prompt.startsWith(EXTRACTION_RULES));
assert.ok(prompt.includes('对话：'));
assert.ok(!prompt.includes('旧条目：'), '没有近邻时不该有裁决段');

/* scope=journal 时收窄规则（不改规则正文） */
const journalPrompt = buildExtractionPrompt({ turns: [{ turn: 1, user: 'a', assistant: 'b' }], scope: 'journal' });
assert.ok(journalPrompt.includes('本次限制：只允许 scope=journal'));
assert.ok(journalPrompt.startsWith(EXTRACTION_RULES), '规则正文仍然逐字不变');

/* 模板片段来自主插件（本插件不定义格式） */
const withTemplates = buildExtractionPrompt({
    turns: [{ turn: 1, user: 'a', assistant: 'b' }],
    templates: { promptFragment: 'FACT 用「- 一句话」，MEMORY 用编号。' },
});
assert.ok(withTemplates.includes('目标格式（由主插件提供，写 FACT / MEMORY 时遵守）：'));
assert.ok(withTemplates.includes('FACT 用「- 一句话」，MEMORY 用编号。'));

/* 超预算从尾部截断（保住最近的对话） */
const longConversation = `${'很早的对话。'.repeat(200)}最近的结论`;
const clipped = buildExtractionPrompt({ conversation: longConversation, maxChars: 100 });
assert.ok(clipped.includes('前段已截断'));
assert.ok(clipped.includes('最近的结论'));

/* 裁决段（§7.3.3） */
const block = buildAdjudicationBlock([
    { content: '改 tarball 后必须 remove 再 add', neighbors: [{ id: 'a3f2', text: '依赖用 tarball 装' }, { id: '9c11', text: '改完 lib/*.js 要重启 DSH' }] },
    { content: '第二条新结论', neighbors: [{ id: 'a3f2', text: '依赖用 tarball 装' }] },
]);
assert.ok(block.includes(ADJUDICATION_RULES));
assert.ok(block.includes('[a3f2] 依赖用 tarball 装'));
assert.ok(block.includes('[9c11] 改完 lib/*.js 要重启 DSH'));
assert.equal(block.split('[a3f2]').length - 1, 1, '重复的近邻只列一次');
assert.ok(block.includes('- 改 tarball 后必须 remove 再 add'));
assert.ok(block.includes('{"ops":[{"op":"ADD|UPDATE|NOOP|DELETE"'));

const withAdjudication = buildExtractionPrompt({
    turns: [{ turn: 1, user: 'a', assistant: 'b' }],
    adjudication: [{ content: '新结论', neighbors: [{ id: 'x1', text: '旧条目正文' }] }],
});
assert.ok(withAdjudication.includes('旧条目：'), '有近邻时必须追加裁决段');
assert.ok(withAdjudication.includes('[x1] 旧条目正文'));

/* parseModelJson：裸 JSON / 围栏 / 前后寒暄 / 坏 JSON */
assert.deepEqual(parseModelJson('{"a":1}').value, { a: 1 });
assert.deepEqual(parseModelJson('```json\n{"a":1}\n```').value, { a: 1 });
assert.deepEqual(parseModelJson('好的，结果如下：\n{"a":1}\n需要我继续吗？').value, { a: 1 });
assert.equal(parseModelJson('').reason, 'empty-response');
assert.equal(parseModelJson('我不会写 JSON').ok, false);
assert.equal(parseModelJson('{"a":1,}').ok, false, '宽松但不容忍真坏掉的 JSON');
assert.equal(parseModelJson('{"a":1}').reason, 'ok');

/* memories 逐条校验 */
const { memories, rejects } = normalizeMemories([
    { scope: 'Global', content: '依赖用 tarball 装', confidence: 'HIGH' },
    { scope: 'project', content: '   ', confidence: 'high' },
    { scope: 'nonsense', content: '无效 scope' },
    { scope: 'journal', content: '一次性事件', confidence: 'weird' },
    'not-an-object',
]);
assert.equal(memories.length, 2);
assert.deepEqual(
    memories[0],
    { scope: 'global', content: '依赖用 tarball 装', confidence: 'high', kind: 'conclusion', importance: 3 },
    'scope/confidence 归一；kind/importance 缺失时按缺省值补齐',
);
assert.equal(memories[1].confidence, 'medium', '未知 confidence 回落 medium');
assert.deepEqual(rejects.map((item) => item.reason), ['empty-content', 'bad-scope', 'not-object']);
assert.deepEqual(CONFIDENCES, ['high', 'medium', 'low']);

/* DESIGN §14.2：kind / importance 归一（非法 → 缺省，越界收敛到 1–5） */
assert.deepEqual(KINDS, ['conclusion', 'detail']);
assert.equal(DEFAULT_KIND, 'conclusion');
assert.equal(DEFAULT_IMPORTANCE, 3);
assert.equal(normalizeKind('detail'), 'detail');
assert.equal(normalizeKind(' Detail '), 'detail', '大小写 / 空白容忍');
assert.equal(normalizeKind('conclusion'), 'conclusion');
assert.equal(normalizeKind('细节'), 'conclusion', '非法 kind ⇒ conclusion（保守：宁可占静态槽也别丢结论）');
assert.equal(normalizeKind(undefined), 'conclusion');
assert.equal(normalizeImportance(5), 5);
assert.equal(normalizeImportance(1), 1);
assert.equal(normalizeImportance('4'), 4, '数字字符串当合法值');
assert.equal(normalizeImportance(9), 5, '越界上限收敛到 5');
assert.equal(normalizeImportance(0), 1, '越界下限收敛到 1');
assert.equal(normalizeImportance(-3), 1);
assert.equal(normalizeImportance(2.6), 3, '非整数取整');
assert.equal(normalizeImportance('乱写'), 3, '非法 ⇒ 3');
assert.equal(normalizeImportance(undefined), 3);
assert.equal(normalizeImportance(Number.NaN), 3);
assert.equal(normalizeImportance(Number.POSITIVE_INFINITY), 3, 'Infinity 不是合法重要性');

const granular = normalizeMemories([
    { scope: 'project', content: 'rAF 合并触摸写入，一帧最多一次', kind: 'detail', importance: 5 },
    { scope: 'global', content: '依赖用 tarball 装', kind: 'conclusion', importance: 4 },
    { scope: 'project', content: '调试时临时改过缓存目录', kind: 'conclusion', importance: 1 },
    { scope: 'journal', content: '一次性事件', kind: 'detail', importance: 2 },
]);
assert.deepEqual(granular.memories.map((item) => item.kind), ['detail', 'conclusion', 'conclusion', 'detail']);
assert.deepEqual(granular.memories.map((item) => item.importance), [5, 4, 1, 2], 'kind / importance 要原样带出（路由要读它们）');
assert.equal(granular.rejects.length, 0, 'kind / importance 非法绝不淘汰条目');

/* 超过上限只留前 8 条并记 over-limit */
const many = normalizeMemories(Array.from({ length: MAX_CANDIDATES + 3 }, (_, index) => ({ scope: 'global', content: `结论 ${index}` })));
assert.equal(many.memories.length, MAX_CANDIDATES);
assert.ok(many.rejects.some((item) => item.reason === 'over-limit'));

/* 整个响应解析 */
const parsed = parseExtractionResponse(JSON.stringify({
    memories: [{ scope: 'global', content: '结论一', confidence: 'high' }],
    ops: [{ op: 'ADD', content: '结论一' }],
}));
assert.equal(parsed.ok, true);
assert.equal(parsed.memories.length, 1);
assert.equal(parsed.ops.length, 1, '裁决 ops 与抽取是同一次调用，应原样带出');

assert.equal(parseExtractionResponse('随便一段话').reason, 'invalid-json');
assert.equal(parseExtractionResponse('[]').reason, 'bad-shape');
assert.equal(parseExtractionResponse('{"memories":"不是数组"}').memories.length, 0);

/* createExtractor：注入的 callModel */
const requests = [];
const extractor = createExtractor({
    provider: 'deepseek',
    model: 'chat',
    templates: () => ({ promptFragment: 'FACT 用「- 一句话」。' }),
    callModel: async (request) => {
        requests.push(request);
        return JSON.stringify({ memories: [{ scope: 'project', content: '本目录是插件装配站', confidence: 'medium' }] });
    },
});
const extracted = await extractor.extract({ turns: [{ turn: 1, user: '问', assistant: '答' }] });
assert.equal(extracted.ok, true);
assert.equal(extracted.memories.length, 1);
assert.equal(extracted.memories[0].scope, 'project');
assert.equal(extracted.memories[0].kind, 'conclusion', '模型没给 kind 时按缺省值补齐');
assert.equal(extracted.memories[0].importance, 3);
assert.equal(extracted.calls, 1, '正常一次沉淀只调一次模型');
assert.equal(requests.length, 1, '一次沉淀只调一次模型');
assert.equal(requests[0].provider, 'deepseek');
assert.equal(requests[0].model, 'chat');
assert.equal(requests[0].overrides, undefined, '正常路径不要求覆盖推理等级');
assert.ok(requests[0].prompt.includes('FACT 用「- 一句话」。'));

/* 非法 JSON → 整次放弃（不重试） */
const garbage = createExtractor({ callModel: async () => '不是 JSON' });
const failed = await garbage.extract({ turns: [{ turn: 1, user: 'a', assistant: 'b' }] });
assert.equal(failed.ok, false);
assert.equal(failed.reason, 'invalid-json');
assert.equal(failed.memories.length, 0);

/* 模型抛错 / 没有 callModel / 空响应 */
assert.equal((await createExtractor({ callModel: async () => { throw new Error('上游 500'); } }).extract({})).reason, 'model-error');
assert.equal((await createExtractor({}).extract({})).reason, 'no-model');
assert.equal((await createExtractor({ callModel: async () => '' }).extract({})).reason, 'empty-response');

/* 支持 callModel 返回 {text} 形态（宿主适配器可能包一层） */
const wrapped = createExtractor({ callModel: async () => ({ text: '{"memories":[]}' }) });
assert.equal((await wrapped.extract({})).ok, true);

/* ── 截断抢救：max-tokens 吃光了额度，但已经吐出来的正文可能是完整的 ── */

/* 1. 完整 JSON：直接返回，一个字符都不改 */
{
    const full = salvageTruncatedResponse('{"memories":[{"scope":"global","content":"A","confidence":"high"}]}');
    assert.deepEqual(full?.value, { memories: [{ scope: 'global', content: 'A', confidence: 'high' }] });
}

/* 2. 缺尾 `]}`：按元素边界补全（真实截断最常见的形态） */
{
    const partial = salvageTruncatedResponse('{"memories":[{"scope":"global","content":"A","confidence":"high"},');
    assert.deepEqual(partial?.value, { memories: [{ scope: 'global', content: 'A', confidence: 'high' }] });
}

/* 3. 第二条写到一半：只保留完整的第一条，半条绝不救 */
{
    const partial = salvageTruncatedResponse('{"memories":[{"scope":"global","content":"A","confidence":"high"},{"scope":"project","content":"半');
    const memories = partial?.value?.memories ?? [];
    assert.equal(memories.length, 1, '半条结论不许被救回来');
    assert.equal(memories[0].content, 'A');
}

/* 4. 截断在字符串中间 ⇒ 救不了，返回 null（宁可这轮不算） */
assert.equal(salvageTruncatedResponse('{"memories":[{"scope":"global","content":"写到一半'), null);
assert.equal(salvageTruncatedResponse(''), null);
assert.equal(salvageTruncatedResponse('模型开始胡言乱语，没有 JSON'), null);

/* 5. 带 ops 的形状也能救 */
{
    const partial = salvageTruncatedResponse('{"memories":[{"scope":"global","content":"A"}],"ops":[{"op":"ADD","target":"","content":"A"},');
    assert.equal(partial?.value?.memories?.length, 1);
    assert.equal(partial?.value?.ops?.length, 1);
}

/* 6. extract 层：LLM_TRUNCATED 带正文 ⇒ 救回来判 ok，并打上 truncated 标记 */
{
    const truncating = createExtractor({
        callModel: async () => {
            const error = new Error('模型输出被 max-tokens 截断');
            error.code = LLM_TRUNCATED;
            error.text = '{"memories":[{"scope":"global","content":"本机 git 协议访问 GitHub 会失败","confidence":"high"},';
            throw error;
        },
    });
    const salvaged = await truncating.extract({ turns: [{ turn: 1, user: 'a', assistant: 'b' }] });
    assert.equal(salvaged.ok, true, '能救就按成功处理');
    assert.equal(salvaged.truncated, true, '必须留痕，否则人看不出输出上限已经不够');
    assert.equal(salvaged.salvage, 'max-tokens');
    assert.equal(salvaged.memories.length, 1);
    assert.equal(salvaged.memories[0].content, '本机 git 协议访问 GitHub 会失败');
}

/* 7. 截断且无正文 / 正文救不回来 ⇒ 仍判失败（不写半条） */
{
    const noText = createExtractor({
        callModel: async () => {
            const error = new Error('截断');
            error.code = LLM_TRUNCATED;
            throw error;
        },
    });
    const failed = await noText.extract({});
    assert.equal(failed.ok, false);
    assert.equal(failed.code, LLM_TRUNCATED);

    const unusable = createExtractor({
        callModel: async () => {
            const error = new Error('截断');
            error.code = LLM_TRUNCATED;
            error.text = '{"memories":[{"scope":"globa';
            throw error;
        },
    });
    assert.equal((await unusable.extract({})).ok, false, '救不回来就不许冒充成功');
}

/* 8. 别的错误码不走抢救（401 / 超时没有可救的正文） */
{
    const auth = createExtractor({
        callModel: async () => {
            const error = new Error('401');
            error.code = 'AUTH';
            error.text = '{"memories":[{"scope":"global","content":"A"}]}';
            throw error;
        },
    });
    const failed = await auth.extract({});
    assert.equal(failed.ok, false, '只有 LLM_TRUNCATED 才走抢救');
    assert.equal(failed.code, 'AUTH');
    assert.equal(failed.calls, 1, '非截断错误不重试');
}

/* ── DESIGN §13：截断且救不回来 ⇒ 同 prompt 降推理等级重试**一次** ── */

/** 截断错误（正文截断在字符串中间 ⇒ `salvageTruncatedResponse` 必然救不回来）。 */
function truncatedError(text = '{"memories":[{"scope":"globa') {
    const error = new Error('模型输出被 max-tokens 截断');
    error.code = LLM_TRUNCATED;
    error.text = text;
    error.details = { finish: { type: 'finish', reason: { kind: 'max-tokens' } } };
    return error;
}

/* 9. 第二次成功：返回 retry:max-tokens / calls:2，且第二次请求带 overrides */
{
    const requests = [];
    let attempt = 0;
    const retrying = createExtractor({
        provider: 'deepseek',
        model: 'chat',
        callModel: async (request) => {
            requests.push(request);
            attempt += 1;
            if (attempt === 1) throw truncatedError();
            return JSON.stringify({
                memories: [{ scope: 'global', content: '重试后拿到的结论', confidence: 'high', kind: 'conclusion', importance: 4 }],
            });
        },
    });
    const result = await retrying.extract({ turns: [{ turn: 1, user: 'a', assistant: 'b' }], sessionId: 'session-1' });
    assert.equal(result.ok, true, '重试成功要按成功返回');
    assert.equal(result.truncated, true, '仍要留痕：这轮是截断后救回来的');
    assert.equal(result.retry, 'max-tokens');
    assert.equal(result.salvage, undefined, '走的是重试，不是补括号抢救');
    assert.equal(result.calls, 2, '真实调用次数必须是 2（预算是按调用算钱的）');
    assert.equal(result.memories.length, 1);
    assert.equal(result.memories[0].importance, 4);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].prompt, requests[0].prompt, '重试必须用同一份 prompt');
    assert.deepEqual(requests[1].overrides, { reasoningEffort: TRUNCATE_RETRY_REASONING_EFFORT }, '重试要把推理等级压到最低档');
    assert.equal(requests[1].sessionId, 'session-1', 'sessionId 也要带上（宿主归因）');
}

/* 10. `retryOnTruncate:false` ⇒ 回到旧行为：只调一次，整次 FAIL */
{
    let calls = 0;
    const noRetry = createExtractor({
        retryOnTruncate: false,
        callModel: async () => {
            calls += 1;
            throw truncatedError();
        },
    });
    const failed = await noRetry.extract({});
    assert.equal(failed.ok, false);
    assert.equal(failed.code, LLM_TRUNCATED);
    assert.equal(failed.calls, 1);
    assert.equal(calls, 1, '开关关掉就不许偷偷再调一次');
}

/* 11. 重试仍失败 ⇒ FAIL，detail 保留**第一次**的 finish 摘要 */
{
    let calls = 0;
    const stillFailing = createExtractor({
        callModel: async () => {
            calls += 1;
            throw truncatedError();
        },
    });
    const failed = await stillFailing.extract({});
    assert.equal(failed.ok, false, '重试仍失败必须判失败（绝不写半条）');
    assert.equal(failed.reason, 'model-error');
    assert.equal(failed.code, LLM_TRUNCATED);
    assert.equal(failed.calls, 2);
    assert.equal(calls, 2, '只重试一次');
    assert.ok(failed.detail.includes('finish.kind=max-tokens'), `detail 要保留第一次 finish 摘要：${failed.detail}`);
    assert.ok(failed.detail.includes('retry:'));

    /* 重试返回非法 JSON：同样按失败处理，detail 仍带第一次摘要 */
    let attempt = 0;
    const badRetry = createExtractor({
        callModel: async () => {
            attempt += 1;
            if (attempt === 1) throw truncatedError();
            return '还是不是 JSON';
        },
    });
    const bad = await badRetry.extract({});
    assert.equal(bad.ok, false);
    assert.equal(bad.calls, 2);
    assert.ok(bad.detail.includes('finish.kind=max-tokens'));
    assert.ok(bad.detail.includes('retry:invalid-json'), `detail 要能看出重试也没救回来：${bad.detail}`);
}

/* 12. 截断但抢救成功 ⇒ 不触发重试（省一次调用） */
{
    let calls = 0;
    const salvageable = createExtractor({
        callModel: async () => {
            calls += 1;
            throw truncatedError('{"memories":[{"scope":"global","content":"救回来的","confidence":"high"},');
        },
    });
    const result = await salvageable.extract({});
    assert.equal(result.ok, true);
    assert.equal(result.retry, undefined);
    assert.equal(result.calls, 1, '抢救成功就不该再花钱重试');
    assert.equal(calls, 1);
}

/* 13. `resolveRetryOnTruncate` 现取开关（设置页关掉下一轮生效） */
{
    let enabled = false;
    let calls = 0;
    const dynamic = createExtractor({
        resolveRetryOnTruncate: () => enabled,
        callModel: async () => {
            calls += 1;
            throw truncatedError();
        },
    });
    assert.equal((await dynamic.extract({})).calls, 1);
    enabled = true;
    const second = await dynamic.extract({});
    assert.equal(second.calls, 2, '开关打开后下一轮立刻重试');
    assert.equal(calls, 3);
}

console.log('✓ extractor.test.mjs 全部通过');
