/**
 * 归并：确定性预筛、近邻检索、target 白名单、四算子硬约束、冲突裁决（02 §7.3）。
 *
 * 跑法：node test/merger.test.mjs
 */

import assert from 'node:assert/strict';
import {
    MAX_OPS,
    PRE_SCREEN,
    SIM_ADD,
    SIM_NOOP,
    buildPool,
    entryId,
    mergeCandidates,
    normalizeText,
    normalizedSimilarity,
    parseFactEntries,
    parseMemoryEntries,
    preScreen,
    resolveConflict,
    sanitizeOps,
    topNeighbors,
} from '../lib/merger.js';

/* 归一化：列表前缀、全角、大小写、句末标点、空白都应该被抹平 */
assert.equal(normalizeText('- 依赖用 tarball 装。'), '依赖用 tarball 装');
assert.equal(normalizeText('  依赖用   tarball 装  '), '依赖用 tarball 装');
assert.equal(normalizeText('１２３ ABC'), '123 abc');
assert.equal(normalizeText('1. 编号条目'), '编号条目');

/* 稳定 id：同文本同 id，不同文本不同 id */
assert.equal(entryId('- 依赖用 tarball 装。'), entryId('依赖用 tarball 装'));
assert.equal(entryId('依赖用 tarball 装').length, 10);
assert.notEqual(entryId('依赖用 tarball 装'), entryId('依赖用 tarball 装，不用 pnpm'));

/* 从 FACT.md 切条目，保留分组 */
const FACT = [
    '# FACT.md',
    '',
    '## 环境',
    '- 系统 node v22.23.3',
    '- adb 用 platform-tools 那份',
    '',
    '## 安装',
    '- 依赖用 tarball 装，不用 pnpm install',
].join('\n');
const factEntries = parseFactEntries(FACT);
assert.equal(factEntries.length, 3);
assert.equal(factEntries[0].section, '环境');
assert.equal(factEntries[2].section, '安装');
assert.equal(factEntries[2].text, '依赖用 tarball 装，不用 pnpm install');
assert.ok(factEntries.every((entry) => entry.scope === 'fact'));

/* 从 MEMORY.md 切条目（只取编号行） */
const MEMORY = ['# MEMORY.md', '', '1. 工作区定位', '   - 本目录是插件装配站', '', '2. 安装与重启', '   - 依赖用 tarball 装'].join('\n');
const memoryEntries = parseMemoryEntries(MEMORY);
assert.equal(memoryEntries.length, 2);
assert.equal(memoryEntries[0].text, '工作区定位');
assert.ok(memoryEntries.every((entry) => entry.scope === 'memory'));

/* 池 = FACT + MEMORY，JOURNAL 不进池 */
const pool = buildPool({ factText: FACT, memoryText: MEMORY });
assert.equal(pool.length, 5);

/* 归一化相似度的性质 */
assert.equal(normalizedSimilarity('依赖用 tarball 装', '依赖用 tarball 装'), 1);
assert.ok(normalizedSimilarity('依赖用 tarball 装', '依赖用 tarball 装') > 0.99);
assert.ok(normalizedSimilarity('依赖用 tarball 装', '量子纠缠实验记录') < SIM_ADD, '毫不相关应低于 ADD 阈值');
const near = normalizedSimilarity('依赖用 tarball 装，不用 pnpm install', '依赖用 tarball 装，不要 pnpm install');
assert.ok(near > 0.6 && near < SIM_NOOP, `近似重复应落在中间带（实得 ${near.toFixed(3)}）`);

/* BM25 近邻：数量不超过 3，按分数降序，最相关的排第一 */
const neighbors = topNeighbors('依赖用 tarball 装', pool, { topK: 3 });
assert.ok(neighbors.length >= 1 && neighbors.length <= 3, `近邻数量应在 1..3，实得 ${neighbors.length}`);
assert.equal(neighbors[0].entry.text, '依赖用 tarball 装，不用 pnpm install', '最相关的应是 tarball 那条');
for (let position = 1; position < neighbors.length; position += 1) {
    assert.ok(neighbors[position - 1].score >= neighbors[position].score, '应按 BM25 分数降序');
}
/* 多条都相关时命中数量受 topK 限制 */
const broadPool = buildPool({
    factText: ['- 依赖用 tarball 装', '- tarball 装完要重启', '- 装依赖别用 pnpm install'].join('\n'),
});
const broad = topNeighbors('tarball 装依赖', broadPool, { topK: 2 });
assert.equal(broad.length, 2, 'topK=2 时最多两条');
assert.ok(broad.every((hit) => hit.similarity > 0));
assert.equal(topNeighbors('xyzzy 不存在', pool).length, 0, '无命中应返回空');

/* 预筛四档（用合成近邻把阈值测干净） */
const pick = (similarity, text = '旧条目') => [{ entry: { id: 'a', text }, score: 1, similarity }];
assert.equal(preScreen('依赖用 tarball 装，不用 pnpm install', []).decision, PRE_SCREEN.ADD);
assert.equal(preScreen('依赖用 tarball 装', pick(1, '依赖用 tarball 装。')).decision, PRE_SCREEN.NOOP, '归一化后完全相同 → NOOP');
assert.equal(preScreen('依赖用 tarball 装', pick(1, '依赖用 tarball 装')).reason, 'exact');
assert.equal(preScreen('依赖用 tarball 装', pick(SIM_NOOP, '依赖用 tarball 装一下')).decision, PRE_SCREEN.NOOP, '≥0.95 → NOOP');
assert.equal(preScreen('依赖用 tarball 装', pick(SIM_NOOP - 0.001)).decision, PRE_SCREEN.ADJUDICATE, '0.949 → 交 LLM');
assert.equal(preScreen('新的结论', pick(SIM_ADD - 0.001)).decision, PRE_SCREEN.ADD, '<0.45 → ADD');
assert.equal(preScreen('新的结论', pick(SIM_ADD)).decision, PRE_SCREEN.ADJUDICATE, '=0.45 落在中间带');

/* 冲突裁决：时间 > 置信度 > 保守保留旧的 */
assert.equal(resolveConflict({ ts: 100, confidence: 'low' }, { ts: 200, confidence: 'low' }), 'new');
assert.equal(resolveConflict({ ts: 200, confidence: 'high' }, { ts: 100, confidence: 'high' }), 'old', '旧条目时间更新 → 不覆盖');
assert.equal(resolveConflict({ ts: 100, confidence: 'low' }, { ts: 100, confidence: 'high' }), 'new', '时间相同比置信度');
assert.equal(resolveConflict({ ts: 100, confidence: 'high' }, { ts: 100, confidence: 'low' }), 'old');
assert.equal(resolveConflict({}, {}), 'old', '全未知 → 保留旧的');
assert.equal(resolveConflict({ confidence: 'medium' }, { confidence: 'medium' }), 'old');

/* 硬约束（§7.3.5） */
const allowed = new Set(['a3f2', '9c11']);
const addOp = { op: 'ADD', content: '全新的信息' };
assert.equal(sanitizeOps([addOp], { allowedTargets: allowed }).ops[0].op, 'ADD');

const badOp = sanitizeOps([{ op: 'MERGE', content: 'x' }], { allowedTargets: allowed });
assert.equal(badOp.ops.length, 0);
assert.equal(badOp.rejects[0].reason, 'bad-op');

const updateNoTarget = sanitizeOps([{ op: 'UPDATE', target: '', content: '覆盖点东西' }], { allowedTargets: allowed });
assert.equal(updateNoTarget.ops[0].op, 'ADD', 'UPDATE 缺 target → 降级 ADD');

const badTarget = sanitizeOps([{ op: 'UPDATE', target: 'zzzz', content: '覆盖点东西' }], { allowedTargets: allowed });
assert.equal(badTarget.ops[0].op, 'ADD');
assert.equal(badTarget.ops[0].reason, 'bad-target');

const goodUpdate = sanitizeOps([{ op: 'update', target: 'a3f2', content: '改一下' }], { allowedTargets: allowed });
assert.equal(goodUpdate.ops[0].op, 'UPDATE', '小写算子应被归一');
assert.equal(goodUpdate.ops[0].target, 'a3f2');

const layer1Delete = sanitizeOps([{ op: 'DELETE', target: 'a3f2', content: '' }], { allowedTargets: allowed, layer: 1 });
assert.equal(layer1Delete.ops[0].op, 'NOOP', '第一层 DELETE 必须降级 NOOP');
assert.equal(layer1Delete.ops[0].reason, 'layer1-delete');

const layer2Delete = sanitizeOps([{ op: 'DELETE', target: 'a3f2' }], { allowedTargets: allowed, layer: 2 });
assert.equal(layer2Delete.ops[0].op, 'DELETE');

const overLimit = sanitizeOps(
    Array.from({ length: MAX_OPS + 2 }, () => ({ op: 'ADD', content: '结论' })),
    { allowedTargets: allowed },
);
assert.equal(overLimit.ops.length, MAX_OPS, `单批 ops 上限 ${MAX_OPS}`);
assert.equal(overLimit.rejects.length, 2);

/* 归并：确定性部分不开销 LLM */
const exactPool = buildPool({ factText: '- 依赖用 tarball 装' });
const deterministic = await mergeCandidates({
    candidates: [{ content: '依赖用 tarball 装。', scope: 'global', confidence: 'high' }],
    pool: exactPool,
    layer: 1,
    callModel: async () => {
        throw new Error('确定性预筛命中的用例不该调模型');
    },
});
assert.equal(deterministic.ok, true);
assert.equal(deterministic.ops[0].op, 'NOOP');
assert.equal(deterministic.counts.noop, 1);

/* 无关结论 → ADD，也不调模型 */
const unrelated = await mergeCandidates({
    candidates: [{ content: '量子纠缠可以用于密钥分发实验', scope: 'global' }],
    pool: exactPool,
    layer: 1,
    callModel: async () => {
        throw new Error('低相似度不该调模型');
    },
});
assert.equal(unrelated.ops[0].op, 'ADD');

/* 中间带 → 调模型；目标 id 在池里 → UPDATE，且带 superseded 旧值 */
const ambiguousPool = buildPool({ factText: '- 依赖用 tarball 装，不用 pnpm install' });
const ambiguousId = ambiguousPool[0].id;
const adjudicated = await mergeCandidates({
    candidates: [{ content: '依赖用 tarball 装，不要 pnpm install', scope: 'global', confidence: 'high', ts: 2_000 }],
    pool: ambiguousPool.map((entry) => ({ ...entry, ts: 1_000, confidence: 'medium' })),
    layer: 1,
    callModel: async ({ prompt }) => {
        assert.ok(prompt.includes('旧条目：'), '裁决 prompt 必须带旧条目');
        assert.ok(prompt.includes(`[${ambiguousId}]`), '旧条目要带 id');
        return JSON.stringify({ ops: [{ op: 'UPDATE', target: ambiguousId, content: '依赖用 tarball 装，不要 pnpm install' }] });
    },
});
assert.equal(adjudicated.ok, true);
assert.equal(adjudicated.ops[0].op, 'UPDATE');
assert.equal(adjudicated.ops[0].target, ambiguousId);
assert.equal(adjudicated.ops[0].superseded.text, '依赖用 tarball 装，不用 pnpm install');
assert.equal(adjudicated.counts.adjudicated, 1);

/* 旧条目时间更新 → 冲突裁决保旧的，op 变 NOOP */
const keepOld = await mergeCandidates({
    candidates: [{ content: '依赖用 tarball 装，不要 pnpm install', scope: 'global', confidence: 'high', ts: 500 }],
    pool: ambiguousPool.map((entry) => ({ ...entry, ts: 9_000 })),
    layer: 1,
    callModel: async () => JSON.stringify({ ops: [{ op: 'UPDATE', target: ambiguousId, content: '依赖用 tarball 装，不要 pnpm install' }] }),
});
assert.equal(keepOld.ops[0].op, 'NOOP');
assert.equal(keepOld.ops[0].reason, 'conflict-keep-old');

/* 模型乱给 target → 降级 ADD */
const badTargetOp = await mergeCandidates({
    candidates: [{ content: '依赖用 tarball 装，不要 pnpm install', scope: 'global', ts: 2_000 }],
    pool: ambiguousPool.map((entry) => ({ ...entry, ts: 1_000 })),
    layer: 1,
    callModel: async () => JSON.stringify({ ops: [{ op: 'UPDATE', target: 'not-in-pool', content: '依赖用 tarball 装，不要 pnpm install' }] }),
});
assert.equal(badTargetOp.ops[0].op, 'ADD');
assert.equal(badTargetOp.ops[0].reason, 'bad-target');

/* 非法 JSON → 整次放弃 */
const invalid = await mergeCandidates({
    candidates: [{ content: '依赖用 tarball 装，不要 pnpm install', scope: 'global' }],
    pool: ambiguousPool,
    layer: 1,
    callModel: async () => '我想了想，还是不写 JSON 了',
});
assert.equal(invalid.ok, false);
assert.equal(invalid.reason, 'invalid-json');
assert.deepEqual(invalid.ops, []);

/* 没有 callModel 且确实需要裁决 → 明确失败，而不是瞎猜 */
const noModel = await mergeCandidates({
    candidates: [{ content: '依赖用 tarball 装，不要 pnpm install', scope: 'global' }],
    pool: ambiguousPool,
    layer: 1,
});
assert.equal(noModel.ok, false);
assert.equal(noModel.reason, 'no-model');

/* ops 上限：候选超过 8 条只取前 8 */
const many = await mergeCandidates({
    candidates: Array.from({ length: 12 }, (_, index) => ({ content: `第 ${index} 条全新的结论，与前文无关` , scope: 'global' })),
    pool: exactPool,
    layer: 1,
});
assert.equal(many.decisions.length, MAX_OPS);

console.log('✓ merger.test.mjs 全部通过');
