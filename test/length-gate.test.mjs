/**
 * 长度门（0.5.0 格式约束）：'global' / 'project' 候选正文超过 160 字符时改判 JOURNAL。
 *
 * 真实故障背景（2026-11-12 体检）：项目 MEMORY.md 49 条长编号段落，中位 105 字、
 * 17 条 >200 字、最长 596 字，总 7974/8000 字符 = 99.66%。压缩器要求「合并结果 ≤120 字 /
 * 逐条精简 ≤200 字且合计必须更短、具体值不许丢」，对 596 字那条基本无法通过 ⇒ 水位
 * 只涨不降。根因是格式：一条塞了一段版本演进史，而不是上限太小。
 *
 * 本文件覆盖：
 *  1. routeByLength 纯函数：160/161 边界、journal / 未知 scope 不动、不改入参、按字符计；
 *  2. 抽取提示词真的带上了规则 9 / 10（每条一个结论 + ≤100 字；编年史一律 journal）；
 *  3. 端到端：>200 字 project 候选只进 JOURNAL、FACT/MEMORY 一字未动、layers.reroutedLong
 *     落 runlog、消费正常推进。
 *
 * 跑法：node test/length-gate.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildExtractionPrompt } from '../lib/extractor.js';
import { readUnconsumed } from '../lib/pending.js';
import { MAX_STATIC_ENTRY_CHARS, routeByLength, runL1 } from '../lib/pipeline.js';
import { readLastRun } from '../lib/runlog.js';
import { NOW, fakeModel, makeHome, makeRuntime, memoryStore, seedRows, sha256 } from './_helpers.mjs';

/** 造一条恰好 n 个字符（CJK 每字一个码点）的正文。 */
const cjk = (n) => '结'.repeat(n);

/* ══════════ 1. 纯函数：routeByLength（零 IO、零 LLM） ══════════ */

assert.equal(MAX_STATIC_ENTRY_CHARS, 160, '阈值 160 要作为模块常量导出（测试与设置页口径一致）');

assert.deepEqual(routeByLength(), { candidates: [], reroutedLong: 0 }, '无参数 ⇒ 空结果');
assert.deepEqual(routeByLength(null), { candidates: [], reroutedLong: 0 }, 'null 不炸');

/* 边界：160 不动 / 161 改判（正文 trim 后按字符计） */
const boundary160 = [{ scope: 'global', content: cjk(160) }];
const kept160 = routeByLength(boundary160);
assert.equal(kept160.reroutedLong, 0, '恰 160 字符在阈值以内，不许改判');
assert.equal(kept160.candidates[0].scope, 'global', '160 字符仍是静态槽候选');

const boundary161 = [{ scope: 'global', content: cjk(161) }];
const routed161 = routeByLength(boundary161);
assert.equal(routed161.reroutedLong, 1, '161 字符超过阈值 ⇒ 改判计数 +1');
assert.equal(routed161.candidates[0].scope, 'journal', '改判目标是 JOURNAL（不丢弃）');
assert.equal(routed161.candidates[0].content, boundary161[0].content, '正文一个字都不改');
assert.equal(boundary161[0].scope, 'global', '纯函数不许改调用方的对象（返回的是副本）');
assert.notEqual(routed161.candidates[0], boundary161[0], '改判项必须是副本，不能就地改写');

/* project 同款；已经 journal 的与未知 scope 原样通过、不计数 */
const mixed = [
    { scope: 'project', content: cjk(161) },
    { scope: 'journal', content: cjk(500) },
    { scope: 'nonsense', content: cjk(500) },
    { scope: '  PROJECT  ', content: cjk(161) },
    { scope: 'global' },
    null,
    '裸字符串原样通过',
];
const mixedOut = routeByLength(mixed);
assert.equal(mixedOut.reroutedLong, 2, 'project 与大小写/空格变体各算一条；journal / 未知 scope 不算');
assert.deepEqual(
    mixedOut.candidates.map((item) => (item !== null && typeof item === 'object' ? item.scope : item)),
    ['journal', 'journal', 'nonsense', 'journal', 'global', null, '裸字符串原样通过'],
    '只有 global/project 改判；无 content 的、非对象的都原样通过',
);

/* trim：首尾空白不计入长度（与 store 的 countChars 同口径） */
assert.equal(routeByLength([{ scope: 'global', content: `  \
${cjk(160)}\t ` }]).reroutedLong, 0, '首尾空白不算正文长度');

/* 按字符（码点）计，不是 UTF-16 码元：emoji 一个算一个 */
const emoji160 = '😀'.repeat(160);
assert.equal(emoji160.length, 320, '前置校验：这串 emoji 的 UTF-16 长度是 320');
assert.equal([...emoji160].length, 160, '前置校验：按字符是 160');
assert.equal(routeByLength([{ scope: 'global', content: emoji160 }]).reroutedLong, 0, '160 个 emoji 按 160 字符计（用 .length 会被误杀）');
assert.equal(routeByLength([{ scope: 'global', content: emoji160 + '结' }]).reroutedLong, 1, '160 emoji + 1 字符 = 161 ⇒ 改判');

/* 中英文混排按字符计：80 + 80 = 160 不动；再多一个字就改判 */
const mixed160 = `${'a'.repeat(80)}${cjk(80)}`;
assert.equal(routeByLength([{ scope: 'project', content: mixed160 }]).reroutedLong, 0, '中英混排 160 字符不动');
assert.equal(routeByLength([{ scope: 'project', content: `${mixed160}结` }]).reroutedLong, 1, '中英混排 161 字符改判');

/* maxChars 可覆盖（只给测试用；管线里永远用默认 160） */
assert.equal(routeByLength([{ scope: 'global', content: cjk(161) }], { maxChars: 200 }).reroutedLong, 0, '自定义上限 200 ⇒ 161 不动');
assert.equal(routeByLength([{ scope: 'global', content: cjk(6) }], { maxChars: 5 }).reroutedLong, 1, '自定义上限 5 ⇒ 6 字符改判');
assert.equal(routeByLength([{ scope: 'global', content: cjk(161) }], { maxChars: 0 }).reroutedLong, 1, '非法上限回落默认 160（不是 0）');

/* ══════════ 2. 提示词：规则 9 / 10 真的在 prompt 里 ══════════ */

const prompt = buildExtractionPrompt({ turns: [{ turn: 1, user: '问', assistant: '答' }], cwd: '/root/workspace/demo' });
assert.ok(prompt.includes('每条只写一个结论，正文 ≤100 字'), 'prompt 要明确「一条一个结论 + ≤100 字」');
assert.ok(prompt.includes('超了拆成多条短条目'), 'prompt 要给出超长时的动作：拆条而不是写成一整段');
assert.ok(prompt.includes('版本演进史、实现过程、调试记录、文件清单一律 scope=journal'), 'prompt 要把编年史类内容一律赶进 JOURNAL');
assert.ok(prompt.includes('不许写进 FACT / MEMORY'), 'prompt 要明确禁止写进静态槽');

/* ══════════ 3. 端到端：>200 字 project 候选 ⇒ 只进 JOURNAL ══════════ */

/* 一条 >200 字的「版本演进史」：旧行为会写进项目 MEMORY.md 并占住静态槽。 */
const longContent = `这条结论其实写了一整段版本演进史：${'第N版增加实现细节；'.repeat(20)}`;
assert.ok([...longContent].length > 200, `前置校验：长条目必须 >200 字符，实得 ${[...longContent].length}`);
const shortFact = '设置页的 provider 覆盖只在下一轮生效';

const { home, cleanup } = makeHome('pmc-length-gate');
try {
    const projectDir = join(home, 'proj-length');
    mkdirSync(projectDir, { recursive: true });
    const factSeed = '## 约定\n\n- 依赖用 tarball 装，不用 pnpm install\n';
    const memorySeed = '## 结论\n\n1. 项目记忆里已有的一条结论\n';
    const store = memoryStore({ home, projectDir, factText: factSeed, memoryText: memorySeed });

    const model = fakeModel({
        extraction: JSON.stringify({
            memories: [
                { scope: 'project', content: longContent, confidence: 'high', kind: 'conclusion', importance: 4 },
                { scope: 'global', content: shortFact, confidence: 'high', kind: 'conclusion', importance: 4 },
            ],
        }),
    });
    const runtime = makeRuntime({ store, model, config: { dryRun: false } });
    const factShaBefore = sha256(store.factPath());
    const memoryFile = join(projectDir, 'MEMORY.md');
    const memoryShaBefore = sha256(memoryFile);

    seedRows({ bucket: 'ws-length', sessionId: 'session-length', count: 6, cwd: projectDir });
    const run = await runL1({
        runtime,
        bucket: { workspaceId: 'ws-length', title: '长度门', path: projectDir },
        now: NOW + 300,
    });

    assert.equal(run.status, 'OK', '长度门是改判不是失败：' + run.reason);
    assert.equal(run.counts.failed, 0, '改判不该产生 failed');
    assert.equal(run.counts.written, 2, '两条都真的写进文件（长条目写 JOURNAL，短结论写 FACT）');
    assert.equal(run.candidates, 2, '改判不减少候选数（内容不丢）');

    /* layers：只在真的发生时才多这个键（与 reroutedNoOwner 同口径） */
    assert.equal(run.layers.reroutedLong, 1, '长度门改判 1 条');
    assert.equal(run.layers.rerouted, 0, '分层改判与长度门是两件事');
    assert.equal(run.layers.reroutedNoOwner, undefined, '归属已知 ⇒ 不写归属改判键');

    /* 长条目：只进 JOURNAL，正文完整保留 */
    const journal = existsSync(store.journalPath()) ? readFileSync(store.journalPath(), 'utf8') : '';
    assert.ok(journal.includes(longContent), '长条目必须原样落进 JOURNAL（一个字都不许改）');
    assert.ok(journal.includes(shortFact) === false, '短结论不该进 JOURNAL（它照旧写 FACT）');

    /* 静态槽：FACT 只多了短结论；项目 MEMORY.md 一个字节都没动 */
    const fact = readFileSync(store.factPath(), 'utf8');
    assert.ok(fact.includes(shortFact), '短结论照常写进全局 FACT');
    assert.ok(!fact.includes(longContent), '>200 字条目不许进 FACT');
    assert.equal(sha256(memoryFile), memoryShaBefore, '项目 MEMORY.md 一个字节都不许动');
    assert.notEqual(sha256(store.factPath()), factShaBefore, 'FACT 有写（说明管线真的动了，不是空跑）');
    assert.equal(store.calls.filter((call) => call.name === 'insertEntry').length, 1, '只有短结论走 insertEntry');
    assert.equal(store.calls.filter((call) => call.name === 'appendJournal').length, 1, '长条目只走 appendJournal 一次');

    /* runlog：白名单认 reroutedLong，否则写了也会被静默丢掉 */
    const logged = readLastRun({ file: runtime.runLog.path });
    assert.equal(logged.layers.reroutedLong, 1, 'runlog 要落长度门改判条数');
    assert.equal(logged.layers.conclusion, 2, '两条都是 conclusion（改判只动 scope，不动 kind）');

    /* 改判算「写成」：暂存行要被消费，否则同一批素材会反复重跑、反复烧 LLM */
    assert.equal(readUnconsumed({ pendingDir: runtime.pendingDir, bucket: 'ws-length' }).length, 0, '行被消费');
} finally {
    cleanup();
}

console.log('✓ length-gate.test.mjs 全部通过');
