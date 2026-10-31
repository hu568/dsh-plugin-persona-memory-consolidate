/**
 * 抽取：提示词逐字对照 02 §4.1、裁决段注入、JSON 解析与逐条校验（§7.2 / §7.3.5）。
 *
 * 跑法：node test/extractor.test.mjs
 */

import assert from 'node:assert/strict';
import {
    ADJUDICATION_RULES,
    CONFIDENCES,
    EXTRACTION_RULES,
    MAX_CANDIDATES,
    buildAdjudicationBlock,
    buildConversation,
    buildExtractionPrompt,
    createExtractor,
    normalizeMemories,
    parseExtractionResponse,
    parseModelJson,
} from '../lib/extractor.js';

/* 规则正文必须与 02 §4.1 一致（5 条规则 + 输出格式） */
const ruleLines = EXTRACTION_RULES.split('\n');
assert.equal(ruleLines[0], '从下面的对话里，抽出值得长期记住的结论。');
assert.ok(EXTRACTION_RULES.includes('1. 一条一个结论，第三人称陈述句。'));
assert.ok(EXTRACTION_RULES.includes('2. 只写结论，不写原因、不写过程、不写评价。'));
assert.ok(EXTRACTION_RULES.includes('3. 没有值得记的就返回空数组。'));
assert.ok(EXTRACTION_RULES.includes('4. scope：global=任何项目都成立的；project=只跟当前目录有关的；journal=一次性事件。'));
assert.ok(EXTRACTION_RULES.includes('5. 不写密钥、密码、token、手机号、身份证、卡号；必须提到时一律写成 ⟨redacted⟩。'));
assert.equal(
    ruleLines[ruleLines.length - 1],
    '{"memories":[{"scope":"global|project|journal","content":"...","confidence":"high|medium|low"}]}',
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
assert.deepEqual(memories[0], { scope: 'global', content: '依赖用 tarball 装', confidence: 'high' }, 'scope/confidence 应归一');
assert.equal(memories[1].confidence, 'medium', '未知 confidence 回落 medium');
assert.deepEqual(rejects.map((item) => item.reason), ['empty-content', 'bad-scope', 'not-object']);
assert.deepEqual(CONFIDENCES, ['high', 'medium', 'low']);

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
assert.equal(requests.length, 1, '一次沉淀只调一次模型');
assert.equal(requests[0].provider, 'deepseek');
assert.equal(requests[0].model, 'chat');
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

console.log('✓ extractor.test.mjs 全部通过');
