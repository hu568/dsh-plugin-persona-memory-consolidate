/**
 * 归属兜底（P0-A）：工作区归属未知时静态槽候选改判 JOURNAL；归属已知时行为不变；
 * 抽取提示词带上真实 cwd（未知时明确要求 scope=journal）。
 *
 * 真实故障背景：未归属批次（_unassigned 桶 / 注册表查不到）的 scope=global 候选
 * 照样写进全局 FACT ⇒ FACT 被 15 行英语语法污染；scope=project 候选被主插件
 * assertEntry 拒（details.reason = project 条目缺少工作目录（cwd））且挡住消费。
 *
 * 跑法：node test/ownership.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTRACTION_RULES, buildExtractionPrompt, createExtractor } from '../lib/extractor.js';
import { readUnconsumed } from '../lib/pending.js';
import { routeByOwnership, runL1 } from '../lib/pipeline.js';
import { readLastRun } from '../lib/runlog.js';
import { NOW, fakeModel, makeHome, makeRuntime, memoryStore, seedRows, sha256 } from './_helpers.mjs';

/* ══════════ 1. 纯函数：routeByOwnership（零 IO、零 LLM） ══════════ */

assert.deepEqual(routeByOwnership(), { candidates: [], reroutedNoOwner: 0 }, '无参数 ⇒ 空结果');
assert.deepEqual(routeByOwnership(null), { candidates: [], reroutedNoOwner: 0 }, 'null 不炸');

const ownedInput = [{ scope: 'global', content: 'a' }, { scope: 'project', content: 'b' }];
const owned = routeByOwnership(ownedInput, { owned: true });
assert.equal(owned.reroutedNoOwner, 0, '归属已知 ⇒ 一条都不改判');
assert.equal(owned.candidates[0].scope, 'global');
assert.equal(owned.candidates[1].scope, 'project');

const unownedInput = [
    { scope: 'global', content: '全局结论' },
    { scope: 'project', content: '项目结论' },
    { scope: 'journal', content: '本来就是 JOURNAL' },
    { scope: ' GLOBAL ', content: '大小写/空格也要认' },
    { scope: 'nonsense', content: '未知 scope 不动' },
    null,
];
const unowned = routeByOwnership(unownedInput);
assert.equal(unowned.reroutedNoOwner, 3, 'global / project / GLOBAL 各算一条改判');
assert.deepEqual(
    unowned.candidates.map((item) => item?.scope),
    ['journal', 'journal', 'journal', 'journal', 'nonsense', undefined],
    'global 与 project 一律改判 journal；journal / 未知 scope 原样通过；非对象原样保留',
);
assert.equal(unownedInput[0].scope, 'global', '纯函数不许改调用方的对象（返回的是副本）');
assert.equal(unowned.candidates[0].content, '全局结论', '改判只动 scope，正文一字不改');

/* ══════════ 2. 抽取提示词：真实 cwd 进 prompt；未知时收窄成 journal ══════════ */

const promptWithCwd = buildExtractionPrompt({
    turns: [{ turn: 1, user: '问', assistant: '答' }],
    cwd: '/root/workspace/demo',
});
assert.ok(promptWithCwd.startsWith(EXTRACTION_RULES), '规则正文仍然逐字在前（不改产品提示词骨架）');
assert.ok(promptWithCwd.includes('当前工作目录：/root/workspace/demo'), '真实 cwd 必须写进提示词');
assert.ok(promptWithCwd.includes('project = 只属于这个目录'), '有 cwd 时要告诉模型 project 的边界');

const promptNoCwd = buildExtractionPrompt({ turns: [{ turn: 1, user: '问', assistant: '答' }] });
assert.ok(promptNoCwd.includes('当前工作目录：未知'), '拿不到 cwd 时必须明说「未知」，不许留空让模型猜');
assert.ok(promptNoCwd.includes('这种批次一律写 scope=journal'), '未归属批次必须收窄成 journal');
assert.ok(promptNoCwd.includes('不要写 global / project'), '未归属批次不许产出静态槽候选');

const blankCwd = buildExtractionPrompt({ conversation: '对话：\n用户：a\n助手：b', cwd: '   ' });
assert.ok(blankCwd.includes('当前工作目录：未知'), '空白 cwd 等同未知');

/* 抽取器把 cwd 透传进 prompt（pipeline 传的是归属解析后的真实目录） */
const seen = [];
const extractor = createExtractor({
    callModel: async (request) => {
        seen.push(String(request?.prompt ?? ''));
        return '{"memories":[]}';
    },
});
await extractor.extract({ turns: [{ turn: 1, user: '问', assistant: '答' }], cwd: '/root/workspace/target' });
await extractor.extract({ turns: [{ turn: 1, user: '问', assistant: '答' }] });
assert.ok(seen[0].includes('当前工作目录：/root/workspace/target'), 'extract({cwd}) 要真的进 prompt');
assert.ok(seen[1].includes('当前工作目录：未知'), '没传 cwd ⇒ prompt 里写未知');

/* ══════════ 3. 端到端：归属未知 ⇒ 三条候选全进 JOURNAL，FACT 一字不动 ══════════ */

const { home, cleanup } = makeHome('pmc-ownership');
try {
    const factSeed = '## 约定\n\n- 依赖用 tarball 装，不用 pnpm install\n';
    const unownedStore = memoryStore({ home, factText: factSeed });
    const unownedModel = fakeModel({
        extraction: JSON.stringify({
            memories: [
                { scope: 'global', content: '未归属批次的通用结论不许写进全局事实', confidence: 'high', kind: 'conclusion', importance: 5 },
                { scope: 'project', content: '未归属批次的目录结论也不许写进项目记忆', confidence: 'high', kind: 'conclusion', importance: 5 },
                { scope: 'journal', content: '未归属批次的一次性事件照旧写进日志', confidence: 'high', kind: 'conclusion', importance: 3 },
            ],
        }),
    });
    const unownedRuntime = makeRuntime({ store: unownedStore, model: unownedModel, config: { dryRun: false } });
    const factShaBefore = sha256(unownedStore.factPath());
    seedRows({ bucket: '_unassigned', sessionId: 'session-unowned', count: 6 });
    const unownedRun = await runL1({
        runtime: unownedRuntime,
        bucket: { workspaceId: '_unassigned', title: '', path: '' },
        now: NOW,
    });

    assert.equal(unownedRun.status, 'OK', '归属兜底不该把运行判失败：' + unownedRun.reason);
    assert.equal(unownedRun.layers.reroutedNoOwner, 2, 'global + project 各改判一条；本来就是 journal 的不重复计数');
    assert.equal(unownedRun.layers.rerouted, 0, '分层改判与归属改判是两件事');
    assert.equal(unownedRun.counts.failed, 0, '归属兜底是改判，不是失败');
    assert.equal(unownedRun.counts.written, 3, '三条都真的写进了 JOURNAL（算 written）');
    assert.equal(sha256(unownedStore.factPath()), factShaBefore, 'FACT 一个字节都不许动（污染路径被堵住）');
    const journal = readFileSync(unownedStore.journalPath(), 'utf8');
    assert.ok(journal.includes('未归属批次的通用结论不许写进全局事实'), 'global 候选要降级进 JOURNAL（不丢弃）');
    assert.ok(journal.includes('未归属批次的目录结论也不许写进项目记忆'), 'project 候选要降级进 JOURNAL（不丢弃）');
    assert.ok(journal.includes('未归属批次的一次性事件照旧写进日志'));
    assert.equal(readUnconsumed({ pendingDir: unownedRuntime.pendingDir, bucket: '_unassigned' }).length, 0, '改判成 JOURNAL 算写成，行要消费');
    const unownedLogged = readLastRun({ file: unownedRuntime.runLog.path });
    assert.equal(unownedLogged.layers.reroutedNoOwner, 2, 'runlog 要落改判条数（白名单 LAYER_FIELDS 认它）');
    assert.equal(unownedLogged.projectWorkspaceId, undefined, '归属未知时不该冒出 projectWorkspaceId');
    assert.ok(unownedModel.calls[0].includes('当前工作目录：未知'), 'pipeline 要把「未归属」真的传给抽取器（提示词不是空值）');
    assert.equal(unownedStore.calls.filter((call) => call.name === 'insertEntry').length, 0, '归属未知的候选不该尝试写正式记忆（也就不会撞上 assertEntry 拒绝）');
    assert.equal(unownedStore.calls.filter((call) => call.name === 'assertEntry').length, 0);

    /* ══════════ 4. 端到端：归属已知 ⇒ 行为不变（global→FACT / project→MEMORY） ══════════ */

    const projectDir = join(home, 'proj-owned');
    mkdirSync(projectDir, { recursive: true });
    const ownedStore = memoryStore({
        home,
        projectDir,
        factText: factSeed,
        memoryText: '## 结论\n\n1. 项目里已有的一条结论\n',
    });
    const ownedModel = fakeModel({
        extraction: JSON.stringify({
            memories: [
                { scope: 'global', content: '侧栏手势收尾动画可以被再次触摸打断并冻结像素', confidence: 'high', kind: 'conclusion', importance: 4 },
                { scope: 'project', content: '这个仓库的临时产物统一放在 TMP 目录里', confidence: 'high', kind: 'conclusion', importance: 4 },
            ],
        }),
    });
    const ownedRuntime = makeRuntime({ store: ownedStore, model: ownedModel, config: { dryRun: false } });
    seedRows({ bucket: 'ws-owned', sessionId: 'session-owned', count: 6, cwd: projectDir });
    const ownedRun = await runL1({
        runtime: ownedRuntime,
        bucket: { workspaceId: 'ws-owned', title: '归属已知', path: projectDir },
        now: NOW,
    });

    assert.equal(ownedRun.status, 'OK');
    assert.equal(ownedRun.layers.reroutedNoOwner, undefined, '归属已知 ⇒ 不写这条观测（老记录形状不变）');
    assert.equal(ownedRun.counts.written, 2);
    assert.ok(readFileSync(ownedStore.factPath(), 'utf8').includes('侧栏手势收尾动画可以被再次触摸打断并冻结像素'), 'global 照旧写 FACT');
    assert.ok(readFileSync(join(projectDir, 'MEMORY.md'), 'utf8').includes('这个仓库的临时产物统一放在 TMP 目录里'), 'project 照旧写项目 MEMORY');
    assert.ok(ownedModel.calls[0].includes('当前工作目录：' + projectDir), '归属已知时提示词要带真实 cwd（不是「未知」）');
    const ownedJournal = existsSync(ownedStore.journalPath()) ? readFileSync(ownedStore.journalPath(), 'utf8') : '';
    assert.ok(!ownedJournal.includes('侧栏手势收尾动画可以被再次触摸打断并冻结像素'), '归属已知的 global 候选不该被塞进 JOURNAL');
    assert.ok(!ownedJournal.includes('这个仓库的临时产物统一放在 TMP 目录里'), '归属已知的 project 候选不该被塞进 JOURNAL');
    assert.equal(readUnconsumed({ pendingDir: ownedRuntime.pendingDir, bucket: 'ws-owned' }).length, 0);
} finally {
    cleanup();
}

console.log('✓ ownership.test.mjs 全部通过');
