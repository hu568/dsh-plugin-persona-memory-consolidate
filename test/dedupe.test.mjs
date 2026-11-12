/**
 * 近重复**模型裁决**（0.7.0）：每条验收点一条断言，全部用临时 DSH_HOME + 假模型。
 *
 * 为什么单独一个文件而不是塞进 pipeline.test.mjs：pipeline 那份已经 1.9s / 57KB，
 * 判重是**新的一层**（dedupe.js），它的失败兜底（抛错 / 垃圾返回 / 关闭开关）必须能一眼看全。
 *
 * 覆盖（与任务验收一一对应）：
 *  1. 候选 1 被判重复 ⇒ 改判 NOOP（reason=`model-near-duplicate`），其它照写；
 *  2. 判重模型抛错 ⇒ 全部照写、不 FAIL、原因码进 runlog；
 *  3. `config.dedupeModel=false` ⇒ 一次都不调用判重（调用计数为 0）；
 *  4. 返回垃圾字符串（非 JSON）⇒ 不崩、全部照写；
 *  5. journal 候选不送判重（只判 global/project）；
 *  6. 判重调用的预算记账（多一次调用 = 多扣一次日配额）与两个运行参数（512 / 最低推理档）。
 *
 * 跑法：node test/dedupe.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readUnconsumed } from '../lib/pending.js';
import { runL1 } from '../lib/pipeline.js';
import { readLastRun } from '../lib/runlog.js';
import { buildDedupePrompt, MAX_DEDUPE_CANDIDATES, DEDUPE_MAX_OUTPUT_TOKENS, DEDUPE_REASONING_EFFORT, DEDUPE_REASON, adjudicateNearDuplicates, parseDedupeVerdict } from '../lib/dedupe.js';
import { NOW, makeHome, makeRuntime, memoryStore, seedRows } from './_helpers.mjs';

/* 池：四条**与候选不语义重复**的已有条目；其中 ① 是候选 ② 的「同事实、不同措辞」版本。 */
const POOL_LINES = [
    '依赖用 tarball 装，不用 pnpm install',
    '跨池预筛只拦完全相同或相似度 0.95 以上的结论',
    '插件用 tgz 包分发，安装后要重启引擎',
    '长期记忆不存过程日志，只写结论',
]
const FACT_SEED = `## 约定\n\n${POOL_LINES.map((line) => `- ${line}`).join('\n')}\n`;

/* 三条候选：0 新结论、1 是 ① 的近义改写（统计相似度只有 0.048 —— 这正是阈值判不出来的形态）、2 新结论 */
const CAND_NEW_A = '跨池闸口放行的全新结论应该写进 FACT';
const CAND_DUP = '装载依赖时只用压缩包解压安装，别用包管理器直接装';
const CAND_NEW_B = '调试日志只写本地文件，不进长期记忆';
const EXTRACTION = JSON.stringify({
    memories: [
        { scope: 'global', content: CAND_NEW_A, confidence: 'high' },
        { scope: 'global', content: CAND_DUP, confidence: 'high' },
        { scope: 'global', content: CAND_NEW_B, confidence: 'high' },
    ],
});

/** 判重答案：只把候选 1 判成已有条目 ① 的改写（`of` = 近邻序号，仅用于日志）。 */
const DEDUPE_ANSWER = '{"duplicates":[{"index":1,"of":0,"why":"同一事实：用压缩包装，不用包管理器"}]}';

/**
 * 会记「按类型分了几次」的假模型（抽取 / 归并裁决 / 判重）。
 *
 * 为什么不用 helpers 的 `fakeModel`：它只按「下面是已存在的记忆条目」认裁决，判重 prompt
 * 会被它当成抽取（于是判重永远走 bad-shape 兜底）——那样这个文件测不到任何判重行为。
 */
function scriptedModel(replies = {}) {
    const calls = { total: 0, extraction: 0, adjudication: 0, dedupe: 0 };
    const requests = [];
    const model = async (request) => {
        const prompt = String(request?.prompt ?? '');
        calls.total += 1;
        requests.push(request);
        const kind = prompt.includes('候选与近邻：')
            ? 'dedupe'
            : (prompt.includes('下面是已存在的记忆条目') ? 'adjudication' : 'extraction');
        calls[kind] += 1;
        const reply = replies[kind];
        const value = typeof reply === 'function' ? reply(request) : reply;
        if (value instanceof Error) throw value;
        if (value === undefined) return kind === 'dedupe' ? '{"duplicates":[]}' : (kind === 'adjudication' ? '{"ops":[]}' : '{"memories":[]}');
        return value;
    };
    model.calls = calls;
    model.requests = requests;
    return model;
}

/** 计费用的假预算：只记「补扣了几次」，让「一次判重 = 一次调用」可断言。 */
function spyBudget() {
    const charges = [];
    return {
        charges,
        cooldownUntil: () => 0,
        tryStart: () => ({ ok: true, reason: 'ok', token: 'tok-spy' }),
        settle: () => ({ failures: 0, cooldownUntil: 0 }),
        charge: (phase, count) => {
            charges.push(Number(count) || 0);
            return { total: 0, layer1: 0, layer2: 0 };
        },
    };
}

/** 一次完整 L1（6 轮门槛 → 抽取 → 判重 → 归并 → 写盘）。 */
async function runOnce(home, name, options = {}) {
    const projectDir = join(home, name);
    mkdirSync(projectDir, { recursive: true });
    const store = memoryStore({ home, projectDir, factText: FACT_SEED });
    const model = options.model ?? scriptedModel({ extraction: EXTRACTION, dedupe: DEDUPE_ANSWER });
    const budget = options.budget ?? spyBudget();
    const bucket = `ws-${name}`;
    const runtime = makeRuntime({ store, model, budget, config: { dryRun: false, ...(options.config ?? {}) } });
    seedRows({ bucket, sessionId: `session-${name}`, count: 6, cwd: projectDir });
    const run = await runL1({ runtime, bucket: { workspaceId: bucket, path: projectDir }, now: NOW });
    return {
        run,
        store,
        model,
        budget,
        runtime,
        projectDir,
        bucket,
        factText: () => (() => {
            try {
                return readFileSync(store.factPath(), 'utf8');
            } catch {
                return '';
            }
        })(),
        logged: () => readLastRun({ file: runtime.runLog.path }),
        unconsumed: () => readUnconsumed({ pendingDir: runtime.pendingDir, bucket }),
    };
}

/* ── 0. 纯函数层：prompt 形状 / 解析宽容度 ── */
{
    const prompt = buildDedupePrompt([
        { index: 3, content: '候选甲的正文', neighbors: [{ id: 'a', text: '旧条目一' }, { id: 'b', text: '旧条目二' }] },
    ]);
    assert.ok(prompt.includes('近义改写'), 'prompt 必须点明判的是近义改写');
    assert.ok(prompt.includes('同主题的不同结论'), '必须显式列出「不算重复」的反例（否则模型爱把同主题当同事实）');
    assert.ok(prompt.includes('[3] 候选甲的正文'), '候选必须带原下标');
    assert.ok(prompt.includes('近邻 0: 旧条目一') && prompt.includes('近邻 1: 旧条目二'), '两个近邻都要进 prompt');
    assert.ok(prompt.includes('"duplicates"'), '只要求 JSON 对象');

    assert.deepEqual(parseDedupeVerdict('{"duplicates":[]}').duplicates, []);
    assert.equal(parseDedupeVerdict('{"duplicates":[{"index":1,"of":0,"why":"x"}]}').duplicates.length, 1);
    // 模型常见的两种「不是错」：代码块围栏、前后寒暄（由 extractor.parseModelJson 容错）
    assert.equal(parseDedupeVerdict('好的：\n```json\n{"duplicates":[{"index":0}]}\n```\n以上。').ok, true, '围栏 + 寒暄必须能解析');
    assert.equal(parseDedupeVerdict('抱歉，我看不出重复').ok, false);
    assert.equal(parseDedupeVerdict('{"duplicates":{}}').reason, 'bad-shape');
    assert.equal(parseDedupeVerdict('[]').reason, 'bad-shape', '裸数组不是约定形状，按失败兜底');

    /* 直连 adjudicateNearDuplicates：模型编出来的下标一律忽略（不能因幻觉判死真结论） */
    const hallu = await adjudicateNearDuplicates({
        candidates: [{ scope: 'global', content: CAND_NEW_B }, { scope: 'global', content: CAND_NEW_A }],
        pool: [{ id: 'd', text: '长期记忆不存过程日志，只写结论' }],
        callModel: async () => '{"duplicates":[{"index":99,"why":"瞎编"}]}',
    });
    assert.equal(hallu.checked, 2, '两条 global 候选都要送判');
    assert.equal(hallu.duplicates.length, 0, '不存在的下标必须忽略');
    assert.equal(hallu.kept.length, 2, '全部放行');

    /* 开关关闭 ⇒ 一次都不问 */
    let asked = 0;
    await adjudicateNearDuplicates({
        candidates: [{ scope: 'global', content: CAND_NEW_B }],
        pool: [{ id: 'd', text: '长期记忆不存过程日志，只写结论' }],
        enabled: false,
        callModel: async () => { asked += 1; return '{"duplicates":[]}'; },
    });
    assert.equal(asked, 0, 'enabled:false 不许调用模型');
}

const { home, cleanup } = makeHome('pmc-dedupe');
try {
    /* ── 1. 判重把候选 1 改判 NOOP，其它两条照写 ── */
    const first = await runOnce(home, 'dup-basic');
    assert.equal(first.run.skipped, undefined, `不该被跳过：${first.run.skipped}`);
    assert.equal(first.run.status, 'OK', `判重后仍应成功：${first.run.status}/${first.run.reason}`);
    assert.equal(first.model.calls.dedupe, 1, '一次沉淀只发一次判重调用（12 条候选一起判）');
    assert.equal(first.run.calls, 2, '抽取 1 次 + 判重 1 次（三条都是低相似度，归并不再裁决）');
    assert.equal(first.run.candidates, 3, '三条候选都进过闸口');
    assert.equal(first.run.counts.written, 2, '两条新结论写入');
    assert.equal(first.run.counts.noop, 1, '被判重的那条记 noop（不许静默消失）');
    assert.equal(first.run.dedupe.checked, 3, '三条 global 候选都送判');
    assert.equal(first.run.dedupe.duplicates, 1, '判掉一条');
    assert.equal(first.run.dedupe.error, null, '正常路径不该有兜底原因');
    let fact = first.factText();
    assert.ok(fact.includes(CAND_NEW_A), '候选 0 要落盘');
    assert.ok(fact.includes(CAND_NEW_B), '候选 2 要落盘');
    assert.ok(!fact.includes(CAND_DUP), '被判近重复的候选 1 一个字都不许写');
    const firstLogged = first.logged();
    assert.ok(String(firstLogged.detail).includes('dedupe:checked=3,dup=1'), `runlog 要能看见判了几个、判掉几个：${firstLogged.detail}`);
    assert.equal(first.unconsumed().length, 0, '写成功就消费');

    /* 判重调用的两个运行参数：512 输出上限 + 最低推理档（省思考预算） */
    const dedupeRequest = first.model.requests.find((request) => String(request?.prompt ?? '').includes('候选与近邻：'));
    assert.equal(dedupeRequest.maxOutputTokens, DEDUPE_MAX_OUTPUT_TOKENS, '判重只给 512 输出上限');
    assert.equal(DEDUPE_MAX_OUTPUT_TOKENS, 512);
    assert.equal(dedupeRequest.overrides.reasoningEffort, DEDUPE_REASONING_EFFORT, '判重压到最低推理档');
    assert.equal(DEDUPE_REASONING_EFFORT, 'off');

    /* 预算：抽取占锁扣 1 次，判重那一次必须补扣（否则绕过日配额） */
    assert.deepEqual(first.budget.charges, [1], '判重多花的 1 次要补扣到日配额');
    assert.equal(MAX_DEDUPE_CANDIDATES, 12);

    /* ── 2. 判重模型抛错 ⇒ 全部照写、不 FAIL、原因码进 runlog ── */
    const boomModel = scriptedModel({ extraction: EXTRACTION, dedupe: () => new Error('判重调用炸了') });
    const boom = await runOnce(home, 'dup-throw', { model: boomModel });
    assert.equal(boom.run.status, 'OK', '判重抛错绝不能把整轮打成 FAIL');
    assert.equal(boom.run.candidates, 3);
    assert.equal(boom.run.counts.written, 3, '抛错时全部原样放行');
    assert.equal(boom.run.counts.noop, 0);
    assert.equal(boom.run.dedupe.error, 'model-error', '原因码要是稳定的 model-error');
    assert.ok(String(boom.logged().detail).includes('model-error'), `兜底要留痕（含排错原因码）：${boom.logged().detail}`);
    assert.ok(String(boom.logged().detail).includes('checked=3'), '兜底时「判了几条」也要有');
    assert.ok(boom.factText().includes(CAND_DUP), '兜底时那条「本可能被判重」的也要写进去');

    /* ── 3. dedupeModel:false ⇒ 一次都不调用（行为回到 0.6.1） ── */
    const off = await runOnce(home, 'dup-off', { config: { dedupeModel: false } });
    assert.equal(off.model.calls.dedupe, 0, '开关关闭时不许发判重调用');
    assert.equal(off.run.calls, 1, '只剩抽取那一次');
    assert.equal(off.run.dedupe.checked, 0);
    assert.equal(off.run.counts.written, 3, '关闭判重 ⇒ 三条都照写（旧行为）');
    assert.ok(off.factText().includes(CAND_DUP), '旧行为会把近义改写再写一遍（这就是本版要解决的问题）');
    assert.deepEqual(off.budget.charges, [], '没多花调用就不补扣');
    assert.equal(String(off.logged().detail ?? '').includes('dedupe:'), false, '没判重就不留判重痕迹');

    /* ── 4. 返回垃圾字符串（非 JSON）⇒ 不崩、全部照写 ── */
    const junk = await runOnce(home, 'dup-junk', { model: scriptedModel({ extraction: EXTRACTION, dedupe: '抱歉，我判断不了，请你人工核对一下。' }) });
    assert.equal(junk.run.status, 'OK', '垃圾返回不崩');
    assert.equal(junk.run.counts.written, 3, '解析失败一律全部放行');
    assert.equal(junk.run.dedupe.error, 'invalid-json');
    assert.ok(String(junk.logged().detail).includes('invalid-json'), `垃圾返回的原因码要留痕：${junk.logged().detail}`);

    /* ── 5. journal 候选不送判重（只判会进静态槽的两类） ── */
    const MIXED = JSON.stringify({
        memories: [
            { scope: 'global', content: CAND_NEW_A, confidence: 'high' },
            // 与池里 ④ 高度相关的**事件**：journal 本来就允许同义反复，不该花判重的钱
            { scope: 'journal', content: '这次又确认了一遍长期记忆不存过程日志', confidence: 'medium' },
        ],
    });
    const mixedModel = scriptedModel({ extraction: MIXED, dedupe: '{"duplicates":[]}' });
    const mixed = await runOnce(home, 'dup-journal', { model: mixedModel });
    assert.equal(mixed.run.status, 'OK');
    const mixedRequest = mixedModel.requests.find((request) => String(request?.prompt ?? '').includes('候选与近邻：'));
    assert.ok(!String(mixedRequest.prompt).includes('这次又确认了一遍长期记忆不存过程日志'), 'journal 候选不许进判重 prompt');
    assert.ok(String(mixedRequest.prompt).includes(CAND_NEW_A), 'global 候选要进判重 prompt');
    assert.equal(mixed.run.dedupe.checked, 1, '只送 1 条（journal 跳过）');
} finally {
    cleanup();
}

console.log('✓ dedupe.test.mjs 全部通过');
