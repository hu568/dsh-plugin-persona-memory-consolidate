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
import { buildDedupePrompt, MAX_DEDUPE_CANDIDATES, DEDUPE_MAX_NEIGHBORS, DEDUPE_MAX_PROMPT_CHARS, DEDUPE_MAX_OUTPUT_TOKENS, DEDUPE_REASONING_EFFORT, DEDUPE_REASON, adjudicateNearDuplicates, parseDedupeVerdict } from '../lib/dedupe.js';
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
    const store = memoryStore({
        home,
        projectDir,
        factText: options.factText ?? FACT_SEED,
        memoryText: options.memoryText,
    });
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
        {
            index: 3,
            content: '候选甲的正文',
            neighbors: [
                { id: 'a', scope: 'fact', text: '旧条目一' },
                { id: 'b', scope: 'memory', text: '旧条目二' },
            ],
        },
    ]);
    assert.ok(prompt.includes('近义改写'), 'prompt 必须点明判的是近义改写');
    assert.ok(prompt.includes('同主题的不同结论'), '必须显式列出「不算重复」的反例（否则模型爱把同主题当同事实）');
    assert.ok(prompt.includes('[3] 候选甲的正文'), '候选必须带原下标');
    assert.ok(prompt.includes('近邻 0【FACT】: 旧条目一') && prompt.includes('近邻 1【MEMORY】: 旧条目二'), '两个近邻都要进 prompt 且带作用域标签');
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

/*
 * ── 0b. 0.7.1：近邻必须覆盖「同作用域 + 跨作用域」──
 *
 * 审计现场：FACT 池里两条无关条目 BM25 排前（F24 的 top1 是 F5），真正的重复其实躺在
 * 项目 MEMORY（M43 的 top1 反而是 M58）——旧实现只取池内 top-2，等于让模型对着一堆
 * 无关条目判重，永远判不出跨作用域的那条重复。下面两个方向各钉一条。
 */
{
    const FACT_NOISE = [
        { id: 'f1', scope: 'fact', text: '依赖装载顺序由 package.json 决定' },
        { id: 'f2', scope: 'fact', text: '依赖版本锁在 lock 文件里' },
    ];
    const MEMORY_TRUTH = [{ id: 'm1', scope: 'memory', text: '插件依赖一律用 tgz 包，不要 pnpm install' }];
    let prompt = '';
    const verdict = await adjudicateNearDuplicates({
        candidates: [{ scope: 'global', content: '依赖装载统一走压缩包，别用包管理器' }],
        pool: [...FACT_NOISE, ...MEMORY_TRUTH],
        callModel: async (request) => {
            prompt = String(request?.prompt ?? '');
            return '{"duplicates":[]}';
        },
    });
    assert.equal(verdict.checked, 1);
    assert.ok(prompt.includes('依赖装载顺序由 package.json 决定'), '同作用域（FACT）近邻要在');
    assert.ok(prompt.includes('插件依赖一律用 tgz 包'), '跨作用域（MEMORY）那条真重复必须在——否则模型永远判不出来');
    assert.ok(prompt.includes('【FACT】') && prompt.includes('【MEMORY】'), 'scopeLabel 要生效（模型能看出作用域）');

    /* 反方向：project 候选 + 真重复在 FACT（内存侧塞满 3 条噪声，旧口径 top-2 会被噪声占满） */
    const memoryNoise = [
        { id: 'n1', scope: 'memory', text: '工程目录名固定为 project-root' },
        { id: 'n2', scope: 'memory', text: '依赖锁文件不许手改' },
        { id: 'n3', scope: 'memory', text: '工程内所有路径一律用相对路径' },
    ];
    let promptB = '';
    await adjudicateNearDuplicates({
        candidates: [{ scope: 'project', content: '工程依赖一律用 tarball 装，别走包管理器' }],
        pool: [{ id: 'g1', scope: 'fact', text: '依赖用 tarball 装，不用 pnpm install' }, ...memoryNoise],
        callModel: async (request) => {
            promptB = String(request?.prompt ?? '');
            return '{"duplicates":[]}';
        },
    });
    assert.ok(promptB.includes('依赖用 tarball 装，不用 pnpm install'), 'project 候选的跨作用域（FACT）真重复也要在');
    assert.ok(promptB.includes('【FACT】') && promptB.includes('【MEMORY】'), '两个方向都要带标签');

    /* 上限：一条候选最多 4 个近邻（同 2 + 跨 2）；build 再切片一次，多给也不许超 */
    assert.equal(DEDUPE_MAX_NEIGHBORS, 4);
    const tooMany = buildDedupePrompt([{
        index: 0,
        content: '候选',
        neighbors: Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, scope: i % 2 === 0 ? 'fact' : 'memory', text: `近邻正文${i}` })),
    }]);
    assert.ok(tooMany.includes('近邻 3【') && !tooMany.includes('近邻 4【'), '超过 4 条必须截断');

    /* 越界截断：超长正文 / 超长近邻不炸，且被截到预算内（判重不需要完整上下文） */
    const huge = buildDedupePrompt([{
        index: 0,
        content: '长'.repeat(5000),
        neighbors: [{ id: 'z', scope: 'fact', text: '长'.repeat(5000) }],
    }]);
    assert.ok(huge.length < 3000, `超长输入要截断，不能整段塞进 prompt：${huge.length}`);
    assert.ok(huge.includes('长'.repeat(200)) && !huge.includes('长'.repeat(201)), '正文按 200 字保留、超出的切掉');

    const crowded = buildDedupePrompt(Array.from({ length: 40 }, (_, i) => ({
        index: i,
        content: '候'.repeat(200),
        neighbors: Array.from({ length: 4 }, (_, k) => ({ id: `${i}-${k}`, scope: 'fact', text: '邻'.repeat(160) })),
    })));
    assert.ok(crowded.length <= DEDUPE_MAX_PROMPT_CHARS + 400, `总预算要生效：${crowded.length}`);
    assert.ok(crowded.includes('候选清单超出上下文预算'), '截断要留痕（没列出的候选本次不判）');
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

    /*
     * ── 5b. 端到端跨作用域（0.7.1 回归）──
     *
     * 真重复**只**躺在项目 MEMORY 里：FACT 池那两条同词根、BM25 分更高（旧口径会占满 top-2）。
     * 断言判重 prompt 里能看到 MEMORY 那条 —— 这是审计「正确旧条目不在近邻里」的端到端钉子。
     */
    const CROSS_MEMORY_OLD = '插件依赖一律用 tgz 包，不要 pnpm install';
    const CROSS_CAND = '依赖装载统一走压缩包，别用包管理器';
    const crossModel = scriptedModel({
        extraction: JSON.stringify({ memories: [{ scope: 'global', content: CROSS_CAND, confidence: 'high' }] }),
        dedupe: '{"duplicates":[{"index":0,"of":0,"why":"同一事实：用压缩包装，不用包管理器"}]}',
    });
    const cross = await runOnce(home, 'dup-cross-scope', {
        model: crossModel,
        factText: `## 约定\n\n- 依赖装载顺序由 package.json 决定\n- 依赖版本锁在 lock 文件里\n`,
        memoryText: `# MEMORY.md\n\n1. ${CROSS_MEMORY_OLD}\n`,
    });
    assert.equal(cross.run.status, 'OK', `跨作用域判重不该失败：${cross.run.reason}`);
    assert.equal(cross.run.calls, 2, '抽取 1 次 + 判重 1 次（低相似度，归并不再裁决）');
    assert.equal(cross.run.dedupe.duplicates, 1, '模型判掉了那条跨作用域重复');
    assert.equal(cross.run.counts.noop, 1, '改判 NOOP（不许静默消失）');
    assert.equal(cross.run.counts.written, 0, '没有新条目要写');
    const crossRequest = crossModel.requests.find((request) => String(request?.prompt ?? '').includes('候选与近邻：'));
    assert.ok(String(crossRequest.prompt).includes(CROSS_MEMORY_OLD), '项目 MEMORY 里那条真重复必须进判重 prompt（0.7.1 修复点）');
    assert.ok(String(crossRequest.prompt).includes('【MEMORY】'), '跨作用域近邻要带 MEMORY 标签');
    assert.ok(!cross.factText().includes(CROSS_CAND), '被判重复的候选一个字都不许写进 FACT');
} finally {
    cleanup();
}

console.log('✓ dedupe.test.mjs 全部通过');
