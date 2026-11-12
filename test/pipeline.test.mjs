/**
 * L1 单次闭环（02 §3 L1 / §6.2 / §7.2–§7.4 / §9 M1）。
 *
 * 覆盖：happy path（2 条候选 → 1 ADD + 1 UPDATE）、非法 JSON 整次放弃、门槛未到跳过、
 * 干跑不落盘、预算拒绝、撞限降级 JOURNAL 且 FACT/MEMORY 一字未动、快照与回滚、
 * 逐桶运行只占一次全局锁。
 *
 * 全部用例：临时 DSH_HOME + **文件后端的假 store** + 假模型，不触网、不碰真实 `~/.dsh`。
 *
 * 跑法：node test/pipeline.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBudget } from '../lib/budget.js';
import { createCallModel } from '../lib/llm.js';
import { LLM_TRUNCATED } from '../lib/llm.js';
import { readCursor } from '../lib/cursor.js';
import { archivePath, readRows, readUnconsumed } from '../lib/pending.js';
import { latestRunId, rollbackRun, runAllBuckets, runL1, screenCrossPool, snapshotFiles, attachImportance, routeByGranularity } from '../lib/pipeline.js';
import { mergeCandidates } from '../lib/merger.js';
import { readLastRun } from '../lib/runlog.js';
import { NOW, fakeModel, fakeStore, makeHome, makeRuntime, memoryStore, seedRows, sha256 } from './_helpers.mjs';

const FACT_SEED = '## 约定\n\n- 依赖用 tarball 装，不用 pnpm install\n';
const MEMORY_SEED = '## 结论\n\n1. 项目记忆里已有的一条结论\n';

/** 两个候选：一条与 FACT 近似（0.75 ⇒ 需要裁决 → UPDATE），一条全新（⇒ ADD）。 */
const EXTRACTION = JSON.stringify({
    memories: [
        { scope: 'global', content: '依赖用 tarball 装，不要用 pnpm install', confidence: 'high' },
        { scope: 'global', content: '设置页的 provider 覆盖只在下一轮生效', confidence: 'high' },
    ],
});

/** 裁决答案：把 prompt 里给出的第一条旧条目 id 当 target（target 白名单校验会认它）。 */
function adjudicate(request) {
    const prompt = String(request?.prompt ?? '');
    const id = /\[([0-9a-f]{10})\]/u.exec(prompt)?.[1] ?? '';
    return JSON.stringify({ ops: [{ op: 'UPDATE', target: id, content: '依赖用 tarball 装，不要用 pnpm install' }] });
}

const { home, cleanup } = makeHome('pmc-pipeline');

try {
    const projectDir = join(home, 'proj');
    mkdirSync(projectDir, { recursive: true });
    const store = memoryStore({ home, projectDir, factText: FACT_SEED, memoryText: MEMORY_SEED });

    const model = fakeModel({ extraction: EXTRACTION, adjudication: adjudicate });
    const runtime = makeRuntime({ store, model, config: { dryRun: false } });

    /* ── 1. happy path：6 轮 → 2 条候选 → 1 ADD + 1 UPDATE（2 次调用） ── */
    seedRows({ bucket: 'ws-1', sessionId: 'session-a', count: 6, cwd: projectDir });
    const factBefore = sha256(store.factPath());
    const happy = await runL1({ runtime, bucket: { workspaceId: 'ws-1', title: 'DSH插件装配站', path: projectDir }, now: NOW });

    assert.equal(happy.skipped, undefined, 'happy path 不该被跳过');
    assert.equal(happy.status, 'OK');
    assert.equal(happy.bucket, 'ws-1');
    assert.equal(happy.turns, 6);
    assert.ok(happy.chars > 0);
    assert.equal(happy.candidates, 2);
    assert.equal(happy.ops, 2);
    assert.equal(happy.calls, 2, '抽取 1 次 + 裁决 1 次（计划里的「同一次调用」在事实上不可能）');
    assert.equal(happy.counts.written, 1, '1 条 ADD');
    assert.equal(happy.counts.replaced, 1, '1 条 UPDATE');
    assert.equal(happy.counts.failed, 0);
    assert.notEqual(sha256(store.factPath()), factBefore, 'FACT.md 应被写过');

    const fact = readFileSync(store.factPath(), 'utf8');
    assert.ok(fact.includes('设置页的 provider 覆盖只在下一轮生效'), 'ADD 的新条目要落进 FACT');
    assert.ok(fact.includes('不要用 pnpm install'), 'UPDATE 后的新正文要落进 FACT');
    assert.ok(!fact.includes('不用 pnpm install'), 'UPDATE 要覆盖旧条目，不能新旧并存');

    /* 旧值只进只写不读的审计文件：既不能被 recall 召回，也不能被第二层升格回 FACT */
    assert.ok(existsSync(runtime.supersededFile), 'UPDATE 的旧值要写 superseded.jsonl');
    const superseded = readFileSync(runtime.supersededFile, 'utf8');
    assert.ok(superseded.includes('依赖用 tarball 装，不用 pnpm install'), 'superseded.jsonl 要含被覆盖的旧正文');
    const journalAfterUpdate = existsSync(store.journalPath()) ? readFileSync(store.journalPath(), 'utf8') : '';
    assert.ok(!journalAfterUpdate.includes('依赖用 tarball 装，不用 pnpm install'), '旧值绝不能写进 JOURNAL');

    /* 行全部标记已消费 + 归档 + 游标推进 */
    assert.equal(readUnconsumed({ pendingDir: runtime.pendingDir, bucket: 'ws-1' }).length, 0, '成功后才消费，且必须全部消费');
    const rows = readRows({ pendingDir: runtime.pendingDir, bucket: 'ws-1' });
    assert.equal(rows.length, 6);
    assert.ok(rows.every((item) => item.row.consumed === true));
    const archive = archivePath(runtime.pendingDir, 'ws-1', NOW);
    assert.ok(existsSync(archive), '已消费行要进 pending/archive/<bucket>/<yyyy-mm>.jsonl');
    assert.equal(readFileSync(archive, 'utf8').trim().split('\n').length, 6);
    assert.equal(readCursor(runtime.cursorFile).sessions['ws-1:session-a'].turn, 6, '游标推进到本次消费的最大回合');

    /* 快照 + runlog（calls / counts / watermarks / runId 都要在） */
    assert.ok(existsSync(join(happy.snapshot, 'FACT.md')), '写盘前要按 runId 快照 FACT.md');
    assert.ok(existsSync(join(happy.snapshot, 'manifest.json')));
    const logged = readLastRun({ file: runtime.runLog.path });
    assert.equal(logged.runId, happy.runId);
    assert.equal(logged.calls, 2);
    assert.equal(logged.status, 'OK');
    assert.equal(logged.counts.written, 1);
    assert.ok(logged.watermarks.fact.lines > 0, '水位要进 runlog');

    /* 回滚：把 FACT.md 手改掉 → 回滚 → 内容回到快照 */
    writeFileSync(store.factPath(), '## 手改\n\n- 全被改掉了\n', 'utf8');
    const rollback = rollbackRun({ runId: happy.runId, runtime });
    assert.equal(rollback.error, undefined, `回滚不该失败：${JSON.stringify(rollback)}`);
    assert.ok(rollback.restored.includes(store.factPath()));
    assert.equal(readFileSync(store.factPath(), 'utf8'), FACT_SEED, '回滚后应与快照逐字一致');
    assert.deepEqual(rollback.skipped, []);
    assert.equal(latestRunId({ dir: runtime.backupsDir }), happy.runId, 'latestRunId 应能找到这次运行');

    /* 回滚不存在的 runId：明确报错，不假装成功 */
    assert.equal(rollbackRun({ runId: 'run-不存在', runtime }).error, 'no-snapshot');
    assert.equal(rollbackRun({ runId: '', runtime }).error, 'no-run-id');

    /* 干跑不建快照 */
    assert.equal(snapshotFiles({ runId: 'run-dry', store, dryRun: true }).skipped, 'dry-run');

    /* ── 2. 非法 JSON → 整次放弃，行保持未消费，FACT 一字不动 ── */
    seedRows({ bucket: 'ws-2', sessionId: 'session-b', count: 6 });
    const brokenRuntime = makeRuntime({ store, model: fakeModel({ extraction: '抱歉，我无法输出 JSON' }), config: { dryRun: false } });
    const factShaBefore = sha256(store.factPath());
    const broken = await runL1({ runtime: brokenRuntime, bucket: 'ws-2', now: NOW + 10 });

    assert.equal(broken.skipped, 'extract-failed');
    assert.equal(broken.status, 'FAIL');
    assert.equal(broken.reason, 'invalid-json');
    assert.equal(readUnconsumed({ pendingDir: brokenRuntime.pendingDir, bucket: 'ws-2' }).length, 6, '非法 JSON 不许消费任何行');
    assert.equal(sha256(store.factPath()), factShaBefore, '非法 JSON 不许写盘');
    assert.equal(readLastRun({ file: brokenRuntime.runLog.path }).status, 'FAIL');

    /* ── 3. 门槛未到 → 跳过（不花预算、不读 store） ── */
    seedRows({ bucket: 'ws-3', sessionId: 'session-c', count: 2 });
    const belowRuntime = makeRuntime({ store, model, config: { dryRun: false } });
    const below = await runL1({ runtime: belowRuntime, bucket: 'ws-3', now: NOW + 20 });
    assert.equal(below.skipped, 'below-threshold');
    assert.equal(below.turns, 2);
    assert.equal(below.calls, 0);
    assert.equal(belowRuntime.budget.snapshot().used.total, 0, '门槛未到不许扣预算');

    /* 字符门槛单独成立也能消费（先到先算） */
    seedRows({ bucket: 'ws-3b', sessionId: 'session-cb', count: 1, chars: 9000 });
    const byChars = await runL1({ runtime: makeRuntime({ store, model, config: { dryRun: true } }), bucket: 'ws-3b', now: NOW + 21 });
    assert.equal(byChars.skipped, undefined, '≥ minChars 也算达标');
    assert.equal(byChars.turns, 1);

    /* ── 4. 干跑：管线照跑，什么都不写，行仍是未消费 ── */
    seedRows({ bucket: 'ws-4', sessionId: 'session-d', count: 6, cwd: projectDir });
    const dryRuntime = makeRuntime({ store, model: fakeModel({ extraction: EXTRACTION, adjudication: adjudicate }), config: { dryRun: true } });
    const factShaDry = sha256(store.factPath());
    const dry = await runL1({ runtime: dryRuntime, bucket: { workspaceId: 'ws-4', path: projectDir }, dryRun: true, now: NOW + 30 });

    assert.equal(dry.status, 'DRY');
    assert.equal(dry.candidates, 2);
    assert.equal(dry.counts.dry, 2, '每条只记 DRY');
    assert.equal(dry.counts.written, 0);
    assert.equal(sha256(store.factPath()), factShaDry, '干跑不许改 FACT');
    assert.equal(dry.snapshot, '', '干跑不建快照');
    assert.equal(readUnconsumed({ pendingDir: dryRuntime.pendingDir, bucket: 'ws-4' }).length, 6, '干跑不消费行');
    assert.equal(readCursor(dryRuntime.cursorFile).sessions['ws-4:session-d'], undefined, '干跑不推进游标');

    /* ── 5. 预算/单飞拒绝 → 跳过 ── */
    seedRows({ bucket: 'ws-5', sessionId: 'session-e', count: 6 });
    const tight = createBudget({ dailyLlmBudget: 1 });
    tight.tryStart('layer1'); // 用掉唯一一次额度，并占住并发 1
    const budgetRuntime = makeRuntime({ store, model, config: { dryRun: false }, budget: tight });
    const denied = await runL1({ runtime: budgetRuntime, bucket: 'ws-5', now: NOW + 40 });
    assert.equal(denied.skipped, 'budget');
    assert.ok(['daily-budget', 'concurrency-limit'].includes(denied.reason), `实得 ${denied.reason}`);
    assert.equal(readUnconsumed({ pendingDir: budgetRuntime.pendingDir, bucket: 'ws-5' }).length, 6);

    /* ── 6. 撞限 → 降级 JOURNAL，FACT / MEMORY 一字未动（绝不自行压缩） ── */
    seedRows({ bucket: 'ws-6', sessionId: 'session-f', count: 6, cwd: projectDir });
    store.state.budgetExceeded.add('fact');
    const demoteRuntime = makeRuntime({
        store,
        model: fakeModel({ extraction: JSON.stringify({ memories: [{ scope: 'global', content: '撞限时这条只降级写 JOURNAL', confidence: 'high' }] }) }),
        config: { dryRun: false },
    });
    const factShaLimit = sha256(store.factPath());
    const memoryShaLimit = sha256(join(projectDir, 'MEMORY.md'));
    const demoted = await runL1({ runtime: demoteRuntime, bucket: { workspaceId: 'ws-6', path: projectDir }, now: NOW + 50 });

    assert.equal(demoted.calls, 1, '没有候选需要裁决时只有 1 次调用');
    assert.equal(demoted.counts.demoted, 1);
    assert.equal(demoted.counts.written, 0);
    assert.equal(demoted.counts.failed, 0);
    assert.equal(sha256(store.factPath()), factShaLimit, '撞限后 FACT.md 的 SHA256 必须不变');
    assert.equal(sha256(join(projectDir, 'MEMORY.md')), memoryShaLimit, '撞限后 MEMORY.md 的 SHA256 必须不变');
    const journalText = readFileSync(store.journalPath(), 'utf8');
    assert.ok(journalText.includes('撞限时这条只降级写 JOURNAL'), '撞限的那条要降级进 JOURNAL');
    assert.ok(journalText.includes('demoted'), '降级要带 demoted 标记');
    assert.equal(readUnconsumed({ pendingDir: demoteRuntime.pendingDir, bucket: 'ws-6' }).length, 0, '降级属于写成了，行要消费掉');
    store.state.budgetExceeded.delete('fact');

    /* ── 7. 逐桶运行：多桶共用一次全局锁；空桶跳过 ── */
    // 用一个独立的 pending 根：前面几组用例故意留下了「未消费」的桶（非法 JSON / 门槛未到 / 预算拒绝），
    // 混进来就数不清「这次到底跑了几个桶」。
    const allDir = join(home, 'pending-all');
    /*
     * 归属兜底上线后（P0-A）：未归属批次（cwd 未知）的 global 候选会改判 JOURNAL、不再写
     * FACT。这条用例要验的是「逐桶跑 + 共用一次锁」，所以给两个桶真实的 cwd/注册表路径，
     * 让它们保持「归属已知 ⇒ 照常写 FACT」的老语义。
     */
    seedRows({ pendingDir: allDir, bucket: 'ws-7', sessionId: 'session-g', count: 6, cwd: projectDir });
    seedRows({ pendingDir: allDir, bucket: 'ws-8', sessionId: 'session-h', count: 6, cwd: projectDir });
    /* 内容刻意拉开（相似度 < 0.45），两个桶都该走 ADD；相等的正文会被跨池闸口判成
     * near-duplicate——那正好是「同一条结论被写两遍」的现场，不能拿它当「两桶都跑了」的证据。 */
    const replies = ['第一桶写入：本地打包流程已核对完成', '第二桶写入：界面配色改成黛青色'];
    let replyIndex = 0;
    const perBucket = makeRuntime({
        store,
        /*
         * 抽取调用按**真实调用次数**换正文。
         *
         * 旧写法把计数器挂在 `perBucket.callModel` 上，但抽取器在 `makeRuntime` 时
         * 就捕获了注入的 model 函数（`createExtractor({ callModel })`），那个包装根本
         * 不会被抽取路径调用 ⇒ 两个桶一直拿到同一句。跨池闸口上线后第二个桶会被判
         * `near-duplicate`，于是这里必须让「每次调用换一条」真的生效。
         */
        model: fakeModel({
            extraction: () => JSON.stringify({
                memories: [{ scope: 'global', content: replies[Math.min(replyIndex++, replies.length - 1)] }],
            }),
        }),
        config: { dryRun: false },
        registry: {
            workspaces: {
                'ws-7': { path: projectDir, title: '工作区七', sessionIds: ['session-g'] },
                'ws-8': { path: projectDir, title: '工作区八', sessionIds: ['session-h'] },
            },
        },
    });
    perBucket.pendingDir = allDir;

    const all = await runAllBuckets({ runtime: perBucket, dryRun: false, now: NOW + 60 });
    assert.equal(all.skipped, undefined);
    assert.equal(all.runs.length, 2, '两个非空桶都要跑');
    assert.deepEqual(all.runs.map((run) => run.bucket).sort(), ['ws-7', 'ws-8']);
    assert.ok(all.runs.every((run) => run.status === 'OK'));
    assert.equal(
        all.runs.reduce((sum, run) => sum + (run.counts?.written ?? 0), 0),
        2,
        '两个桶各写一条（内容不同，不该被跨池判重）',
    );
    assert.ok(all.runs.every((run) => (run.gate?.['near-duplicate'] ?? 0) === 0), '两条内容不同，不该有跨池拦截');
    const bucketFactText = readFileSync(store.factPath(), 'utf8');
    assert.ok(bucketFactText.includes(replies[0]) && bucketFactText.includes(replies[1]), '两条结论都要落盘');
    const titled = all.runs.find((run) => run.bucket === 'ws-7');
    assert.equal(titled.title, '工作区七', '桶标题来自工作区注册表');
    assert.equal(perBucket.budget.snapshot().used.total, 1, '一次运行只占一次预算（额外的裁决调用才补扣）');
    assert.equal(perBucket.budget.snapshot().busy, 0, '跑完必须放锁');

    /* 全空 → 明确 skipped:empty */
    const empty = await runAllBuckets({ runtime: perBucket, dryRun: false, now: NOW + 70 });
    assert.equal(empty.skipped, 'empty');
    assert.deepEqual(empty.runs, []);

    /* ── 8. store 不可用 → FAIL，不假装成功 ── */
    seedRows({ bucket: 'ws-9', sessionId: 'session-i', count: 6 });
    const noStoreRuntime = makeRuntime({ store: null, model, config: { dryRun: false } });
    const noStore = await runL1({ runtime: noStoreRuntime, bucket: 'ws-9', now: NOW + 80 });
    assert.equal(noStore.skipped, 'store-unavailable');
    assert.equal(noStore.status, 'FAIL');
    assert.equal(readUnconsumed({ pendingDir: noStoreRuntime.pendingDir, bucket: 'ws-9' }).length, 6);

    /* ── 9. 模型未接线 → 提前退出（不占预算、不写 runlog 成功） ── */
    seedRows({ bucket: 'ws-10', sessionId: 'session-j', count: 6 });
    const unwired = makeRuntime({ store, model, config: { dryRun: false } });
    unwired.extractor = null;
    const notWired = await runL1({ runtime: unwired, bucket: 'ws-10', now: NOW + 90 });
    assert.equal(notWired.skipped, 'no-model');
    assert.equal(notWired.reason, 'model-not-wired');
    assert.equal(unwired.budget.snapshot().used.total, 0, '没接线不该扣预算');

    /* ── 10. 抽取成功但没有值得记的结论 → 不消费、不写盘 ── */
    seedRows({ bucket: 'ws-11', sessionId: 'session-k', count: 6 });
    const nothingRuntime = makeRuntime({ store, model: fakeModel({ extraction: '{"memories":[]}' }), config: { dryRun: false } });
    const nothing = await runL1({ runtime: nothingRuntime, bucket: 'ws-11', now: NOW + 100 });
    assert.equal(nothing.skipped, 'no-candidates');
    assert.equal(nothing.calls, 1);
    assert.equal(readUnconsumed({ pendingDir: nothingRuntime.pendingDir, bucket: 'ws-11' }).length, 6);
    /* ── 11. 影子档（mode: observe）：管线真跑 + 与 auto 同样的记账，但 FACT / MEMORY / JOURNAL 一字不动 ── */
    seedRows({ bucket: 'ws-12', sessionId: 'session-l', count: 6, cwd: projectDir });
    const observeRuntime = makeRuntime({
        store,
        model: fakeModel({ extraction: JSON.stringify({ memories: [{ scope: 'global', content: '影子档里这条本来会被写进 FACT', confidence: 'high' }] }) }),
        config: { dryRun: false, mode: 'observe' },
    });
    const factShaShadow = sha256(store.factPath());
    const memoryShaShadow = sha256(join(projectDir, 'MEMORY.md'));
    const journalShaShadow = sha256(store.journalPath());
    const observed = await runL1({ runtime: observeRuntime, bucket: { workspaceId: 'ws-12', path: projectDir }, now: NOW + 110 });

    assert.equal(observed.status, 'OBSERVED', '影子运行不能记成 OK（否则统计里就变成「真实写入成功」）');
    assert.equal(observed.observe, true);
    assert.equal(observed.counts.written, 0, '影子档不算写成功');
    assert.equal(observed.counts.observed, 1, '影子里本来会写 1 条');
    assert.equal(sha256(store.factPath()), factShaShadow, 'FACT.md 的 SHA256 必须不变');
    assert.equal(sha256(join(projectDir, 'MEMORY.md')), memoryShaShadow, 'MEMORY.md 的 SHA256 必须不变');
    assert.equal(sha256(store.journalPath()), journalShaShadow, 'JOURNAL.jsonl 的 SHA256 必须不变');
    /* 内部记账与 auto 一致：行要消费、游标要推进（否则同一批素材被反复采样、反复烧 LLM） */
    assert.equal(readUnconsumed({ pendingDir: observeRuntime.pendingDir, bucket: 'ws-12' }).length, 0, '影子档按 auto 口径消费暂存行');
    assert.equal(observed.marked.marked, 6, '6 行都要标记已消费');
    assert.equal(readCursor(observeRuntime.cursorFile).sessions['ws-12:session-l'].turn, 6, 'L1 游标推进到本次消费的最大回合');
    assert.ok(existsSync(join(observeRuntime.backupsDir, observed.runId)) === false, '影子档不建记忆文件快照');
    assert.equal(observed.snapshot, '', '影子档不建快照');
    assert.equal(readLastRun({ file: observeRuntime.runLog.path }).status, 'OBSERVED', 'runlog 要记 OBSERVED');
    assert.ok(typeof observed.wouldWrite?.file === 'string' && observed.wouldWrite.file !== '', '影子文件路径要能拿到');
    const shadowLines = readFileSync(observed.wouldWrite.file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(shadowLines.some((line) => line.content === '影子档里这条本来会被写进 FACT'), '影子文件要含本来会写的正文');
    assert.ok(shadowLines.every((line) => String(line.status).startsWith('would-')));

    /* ── 12. 路径优先：未分组桶里的行按 cwd 找到工作区，项目记忆照写 ── */
    const projectPath = join(home, 'proj-path');
    mkdirSync(projectPath, { recursive: true });
    const pathStore = memoryStore({ home, projectDir: projectPath, factText: FACT_SEED, memoryText: MEMORY_SEED });
    const pathRuntime = makeRuntime({
        store: pathStore,
        model: fakeModel({ extraction: JSON.stringify({ memories: [{ scope: 'project', content: '项目记忆按工作目录归属', confidence: 'high' }] }) }),
        config: { dryRun: false },
        registry: { workspaces: { 'ws-path': { path: projectPath, title: '路径项目', sessionIds: [] } } },
    });
    seedRows({ bucket: '_unassigned', sessionId: 'session-path', count: 6, cwd: join(projectPath, 'sub') });
    const byPath = await runL1({ runtime: pathRuntime, bucket: { workspaceId: '_unassigned', title: '', path: '' }, now: NOW + 120 });
    assert.equal(byPath.status, 'OK');
    assert.equal(byPath.projectWorkspaceId, 'ws-path', '未分组行要按路径解析出真实工作区');
    assert.equal(byPath.counts.written, 1, 'project 条目应写进项目记忆，而不是降级 JOURNAL');
    assert.ok(readFileSync(join(projectPath, 'MEMORY.md'), 'utf8').includes('项目记忆按工作目录归属'));
    assert.equal(readUnconsumed({ pendingDir: pathRuntime.pendingDir, bucket: '_unassigned' }).length, 0, '桶身份仍按原桶消费（行不搬家）');
    assert.equal(readCursor(pathRuntime.cursorFile).sessions['_unassigned:session-path'].turn, 6, '游标仍记在原桶键上');

    /* ── 13. 确定性闸口：坏结论被拦下，但**计数可见**（不能静默丢） ── */
    seedRows({ bucket: 'ws-gate', sessionId: 'session-gate', count: 6, cwd: projectDir });
    const gateRuntime = makeRuntime({
        store,
        model: fakeModel({
            extraction: JSON.stringify({
                memories: [
                    { scope: 'global', content: '暂无' },
                    { scope: 'global', content: '太短' },
                    { scope: 'global', content: '闸口放行的这条结论必须真的写进 FACT', confidence: 'high' },
                    { scope: 'global', content: '闸口放行的这条结论必须真的写进 FACT', confidence: 'high' },
                ],
            }),
        }),
        config: { dryRun: false },
    });
    const gated = await runL1({ runtime: gateRuntime, bucket: { workspaceId: 'ws-gate', path: projectDir }, now: NOW + 130 });
    assert.equal(gated.status, 'OK', `闸口放行后应成功：${gated.status} / ${gated.reason}`);
    assert.equal(gated.candidates, 1, '4 条候选只留 1 条');
    assert.deepEqual(
        { total: gated.gate.total, kept: gated.gate.kept, dropped: gated.gate.dropped },
        { total: 4, kept: 1, dropped: 3 },
    );
    assert.equal(gated.gate.placeholder, 1);
    assert.equal(gated.gate['too-short'], 1);
    assert.equal(gated.gate.duplicate, 1);
    const gateLogged = readLastRun({ file: gateRuntime.runLog.path });
    assert.deepEqual(
        { total: gateLogged.gate.total, dropped: gateLogged.gate.dropped },
        { total: 4, dropped: 3 },
        'runlog 必须落 gate 分类计数（被过滤项不能静默消失）',
    );
    const gateFact = readFileSync(store.factPath(), 'utf8');
    assert.ok(gateFact.includes('闸口放行的这条结论必须真的写进 FACT'));
    assert.ok(!gateFact.includes('暂无'), '空壳不许写进 FACT');
    assert.equal(readUnconsumed({ pendingDir: gateRuntime.pendingDir, bucket: 'ws-gate' }).length, 0, '有写成功就消费');

    /* ── 14. 闸口全丢：状态 NOOP + reason=gate-dropped + 不消费 ── */
    seedRows({ bucket: 'ws-gate-all', sessionId: 'session-gate-all', count: 6 });
    const allDroppedRuntime = makeRuntime({
        store,
        model: fakeModel({ extraction: JSON.stringify({ memories: [{ scope: 'global', content: '暂无' }, { scope: 'global', content: '我先看了一下配置' }] }) }),
        config: { dryRun: false },
    });
    const allDropped = await runL1({ runtime: allDroppedRuntime, bucket: 'ws-gate-all', now: NOW + 140 });
    assert.equal(allDropped.status, 'NOOP');
    assert.equal(allDropped.skipped, 'no-candidates');
    assert.equal(allDropped.reason, 'gate-dropped', '丢光时 reason 要说清是闸口干的');
    assert.equal(readLastRun({ file: allDroppedRuntime.runLog.path }).reason, 'gate-dropped');
    assert.equal(readUnconsumed({ pendingDir: allDroppedRuntime.pendingDir, bucket: 'ws-gate-all' }).length, 6, '没写成不消费');

    /* ── 15. finish.failure.code='' ⇒ runlog 必须带 :LLM_FINISHED_ABORTED 与 detail（本机故障复现） ── */
    const emptyCodeModel = createCallModel({
        getLlm: () => ({
            stream() {
                return (async function* replay() {
                    yield { type: 'finish', reason: { kind: 'error', failure: { code: '' } } };
                })();
            },
        }),
        config: { provider: 'p', model: 'm' },
    });
    seedRows({ bucket: 'ws-empty-code', sessionId: 'session-empty-code', count: 6 });
    const emptyCodeRuntime = makeRuntime({ store, model: emptyCodeModel, config: { dryRun: false } });
    const emptyCode = await runL1({ runtime: emptyCodeRuntime, bucket: 'ws-empty-code', now: NOW + 150 });
    assert.equal(emptyCode.status, 'FAIL');
    assert.equal(emptyCode.skipped, 'extract-failed');
    const emptyCodeLogged = readLastRun({ file: emptyCodeRuntime.runLog.path });
    assert.equal(
        emptyCodeLogged.reason,
        'extract-model-error:LLM_FINISHED_ABORTED',
        '空 code 不许吞成裸 extract-model-error（本机 35/35 的现场）',
    );
    assert.ok(typeof emptyCodeLogged.detail === 'string' && emptyCodeLogged.detail.length > 0, 'detail 必须非空');
    assert.ok(emptyCodeLogged.detail.includes("failure.code=''"), `detail 要原样带 finish 形状：${emptyCodeLogged.detail}`);
    assert.ok(emptyCodeLogged.detail.includes('模型调用未正常结束'), 'detail 要含真实错误消息');
    assert.equal(Number.isFinite(emptyCodeLogged.durationMs), true, 'FAIL 记录要带真实耗时 durationMs');
    assert.ok(emptyCodeLogged.durationMs >= 0);
    assert.equal(readUnconsumed({ pendingDir: emptyCodeRuntime.pendingDir, bucket: 'ws-empty-code' }).length, 6, '失败不消费');

    /* ── 16. store 判 demoted:'journal' ⇒ 写 JOURNAL 且**行被消费**（P0-2） ── */
    const demoteStore = fakeStore({
        async insertEntry(scope, entry) {
            demoteStore.calls.push({ name: 'insertEntry', args: [scope, entry] });
            return { written: false, demoted: 'journal', reason: '问句（请改写成陈述句）' };
        },
    });
    const stringDemoteRuntime = makeRuntime({
        store: demoteStore.store,
        model: fakeModel({ extraction: JSON.stringify({ memories: [{ scope: 'global', content: '这条会被 store 判成降级', confidence: 'high' }] }) }),
        config: { dryRun: false },
    });
    /* 归属兜底上线后（P0-A）：cwd 未知时 global 候选会先被改判 JOURNAL、根本走不到 store
     * 的降级路径。这条用例验的是 store 的 `demoted:'journal'` 落账，所以给真实 cwd。 */
    seedRows({ bucket: 'ws-demote-string', sessionId: 'session-demote-string', count: 6, cwd: projectDir });
    const stringDemoted = await runL1({ runtime: stringDemoteRuntime, bucket: { workspaceId: 'ws-demote-string', path: projectDir }, now: NOW + 160 });
    assert.equal(stringDemoted.counts.demoted, 1, '字符串 journal 也是降级');
    assert.equal(stringDemoted.counts.failed, 0);
    assert.equal(stringDemoted.counts.written, 0);
    assert.ok(demoteStore.calls.some((call) => call.name === 'appendJournal'), '要真的写一次 JOURNAL');
    assert.equal(readUnconsumed({ pendingDir: stringDemoteRuntime.pendingDir, bucket: 'ws-demote-string' }).length, 0, '降级属于写成，行要消费掉');
    /* ── 17. gateEnabled=false：整批放行，且 runlog **不写** gate 字段（一键关闸口） ── */
    seedRows({ bucket: 'ws-gate-off', sessionId: 'session-gate-off', count: 6 });
    const gateOffRuntime = makeRuntime({
        store,
        model: fakeModel({ extraction: JSON.stringify({ memories: [{ scope: 'global', content: '闸口短句', confidence: 'high' }] }) }),
        config: { dryRun: false, gateEnabled: false },
    });
    const gateOff = await runL1({ runtime: gateOffRuntime, bucket: { workspaceId: 'ws-gate-off', path: projectDir }, now: NOW + 170 });
    assert.equal(gateOff.status, 'OK', `关闭闸口后应成功：${gateOff.status} / ${gateOff.reason}`);
    assert.equal(gateOff.candidates, 1, '太短的结论在关闭闸口后照常进管线');
    assert.equal(gateOff.counts.written, 1, '闸口关了就真的写进去（误杀一键回滚）');
    assert.equal(gateOff.gate, undefined, '关闭时返回值里没有 gate 计数');
    assert.ok(readFileSync(store.factPath(), 'utf8').includes('闸口短句'), '太短的结论要落进 FACT');
    const gateOffLogged = readLastRun({ file: gateOffRuntime.runLog.path });
    assert.equal(gateOffLogged.status, 'OK');
    assert.equal(
        Object.prototype.hasOwnProperty.call(gateOffLogged, 'gate'),
        false,
        '关闭时 runlog 不写 gate（「没启用」与「启用了没拦」是两件事）',
    );
    assert.equal(readUnconsumed({ pendingDir: gateOffRuntime.pendingDir, bucket: 'ws-gate-off' }).length, 0, '写成功就消费');
    /* ── 18. failure.code='UNKNOWN' + 真实 message ⇒ reason 带 :UNKNOWN，detail 带 401 原文 ── */
    const unknownCodeModel = createCallModel({
        getLlm: () => ({
            stream() {
                return (async function* replay() {
                    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: '401 invalid api key' } } };
                })();
            },
        }),
        config: { provider: 'p', model: 'm' },
    });
    seedRows({ bucket: 'ws-unknown-code', sessionId: 'session-unknown-code', count: 6 });
    const unknownCodeRuntime = makeRuntime({ store, model: unknownCodeModel, config: { dryRun: false } });
    const unknownCode = await runL1({ runtime: unknownCodeRuntime, bucket: 'ws-unknown-code', now: NOW + 180 });
    assert.equal(unknownCode.status, 'FAIL');
    const unknownLogged = readLastRun({ file: unknownCodeRuntime.runLog.path });
    assert.equal(unknownLogged.reason, 'extract-model-error:UNKNOWN', '宿主归一后的 UNKNOWN 要落进 reason');
    assert.ok(String(unknownLogged.detail).includes('401 invalid api key'), `detail 要含真实 HTTP 消息：${unknownLogged.detail}`);
    assert.ok(String(unknownLogged.detail).includes("failure.code='UNKNOWN'"), unknownLogged.detail);
    assert.equal(Number.isFinite(unknownLogged.durationMs), true, 'UNKNOWN 失败也要带耗时');

    /* ══════════ DESIGN §5：跨池近重复闸口（归并前拦 NOOP，ADJUDICATE 放行） ══════════ */

    /* 19. 三条候选：exact 重复被拦（计入 gate）；0.75 的 ADJUDICATE 放行并裁决为 UPDATE；全新条目 ADD */
    const crossDir = join(home, 'proj-cross');
    mkdirSync(crossDir, { recursive: true });
    const CROSS_OLD = '依赖用 tarball 装，不用 pnpm install';
    const crossStore = memoryStore({ home, projectDir: crossDir, factText: `## 约定\n\n- ${CROSS_OLD}\n` });
    const crossRuntime = makeRuntime({
        store: crossStore,
        model: fakeModel({
            extraction: JSON.stringify({
                memories: [
                    // ① 与 FACT 完全相同 ⇒ 跨池拦掉（旧行为：归并里也会 NOOP，但报告看不见）
                    { scope: 'global', content: CROSS_OLD, confidence: 'high' },
                    // ② 相似度约 0.75 ⇒ ADJUDICATE，必须放行（宁可漏杀不可误杀）
                    { scope: 'global', content: '依赖用 tarball 装，不要用 pnpm install', confidence: 'high' },
                    // ③ 全新结论 ⇒ ADD
                    { scope: 'global', content: '跨池闸口放行的全新结论应该写进 FACT', confidence: 'high' },
                ],
            }),
            adjudication: adjudicate,
        }),
        config: { dryRun: false },
    });
    seedRows({ bucket: 'ws-cross', sessionId: 'session-cross', count: 6, cwd: crossDir });
    const crossed = await runL1({
        runtime: crossRuntime,
        bucket: { workspaceId: 'ws-cross', path: crossDir },
        now: NOW + 190,
    });

    assert.equal(crossed.status, 'OK', `跨池闸口后应成功：${crossed.status} / ${crossed.reason}`);
    assert.equal(crossed.candidates, 2, '3 条候选按跨池拦住 1 条，其余 2 条进归并');
    assert.equal(crossed.calls, 2, '抽取 1 次 + ADJUDICATE 裁决 1 次（被拦的那条不该再花钱）');
    assert.deepEqual(
        { total: crossed.gate.total, kept: crossed.gate.kept, dropped: crossed.gate.dropped },
        { total: 3, kept: 2, dropped: 1 },
        'gate 计数要平：kept + dropped = total',
    );
    assert.equal(crossed.gate['near-duplicate'], 1, '跨池拦截计入新原因 near-duplicate');
    assert.equal(crossed.counts.written, 1, '全新结论 1 条 ADD');
    assert.equal(crossed.counts.replaced, 1, 'ADJUDICATE 那条裁决为 UPDATE');
    const crossLogged = readLastRun({ file: crossRuntime.runLog.path });
    assert.equal(crossLogged.gate['near-duplicate'], 1, 'runlog 必须能看见跨池拦了多少（不能静默）');
    const crossFactText = readFileSync(crossStore.factPath(), 'utf8');
    assert.ok(crossFactText.includes('跨池闸口放行的全新结论应该写进 FACT'));
    assert.ok(crossFactText.includes('依赖用 tarball 装，不要用 pnpm install'), 'ADJUDICATE 的改写结果要落盘');
    assert.ok(!crossFactText.includes(CROSS_OLD), '被裁决为 UPDATE 的旧正文应被替换');
    assert.equal(crossFactText.split(CROSS_OLD).length - 1, 0, 'exact 重复不许再写一份');
    assert.equal(readUnconsumed({ pendingDir: crossRuntime.pendingDir, bucket: 'ws-cross' }).length, 0, '有写成功就消费');

    /* 20. `crossPoolDedup:false` ⇒ 跨池不拦；归并层照旧判 NOOP（同批/池内判定保留） */
    const offDir = join(home, 'proj-cross-off');
    mkdirSync(offDir, { recursive: true });
    const offStore = memoryStore({ home, projectDir: offDir, factText: `## 约定\n\n- ${CROSS_OLD}\n` });
    const offRuntime = makeRuntime({
        store: offStore,
        model: fakeModel({ extraction: JSON.stringify({ memories: [{ scope: 'global', content: CROSS_OLD, confidence: 'high' }] }) }),
        config: { dryRun: false, crossPoolDedup: false },
    });
    seedRows({ bucket: 'ws-cross-off', sessionId: 'session-cross-off', count: 6, cwd: offDir });
    const offSha = sha256(offStore.factPath());
    const offResult = await runL1({ runtime: offRuntime, bucket: { workspaceId: 'ws-cross-off', path: offDir }, now: NOW + 200 });
    assert.equal(offResult.candidates, 1, '开关关掉后候选不被跨池拦（照常进归并）');
    assert.equal(offResult.gate['near-duplicate'], 0, '关掉后 near-duplicate 恒 0');
    assert.equal(offResult.counts.written, 0);
    assert.equal(offResult.counts.noop, 1, '归并层仍然把它判成 NOOP（池内判定没被一起关掉）');
    assert.equal(sha256(offStore.factPath()), offSha, '没有真的写重复条目');

    /* 20b. `gateEnabled:false` ⇒ 整层确定性过滤关掉，跨池也不跑（一键整批放行） */
    const gateOffCrossStore = memoryStore({ home, projectDir: offDir, factText: `## 约定\n\n- ${CROSS_OLD}\n` });
    const gateOffCrossRuntime = makeRuntime({
        store: gateOffCrossStore,
        model: fakeModel({ extraction: JSON.stringify({ memories: [{ scope: 'global', content: CROSS_OLD, confidence: 'high' }] }) }),
        config: { dryRun: false, gateEnabled: false },
    });
    seedRows({ bucket: 'ws-cross-gateoff', sessionId: 'session-cross-gateoff', count: 6, cwd: offDir });
    const gateOffCross = await runL1({ runtime: gateOffCrossRuntime, bucket: { workspaceId: 'ws-cross-gateoff', path: offDir }, now: NOW + 205 });
    assert.equal(gateOffCross.candidates, 1, '闸口关掉时跨池也停（否则「整批放行」名不副实）');
    assert.equal(gateOffCross.gate, undefined, '关闭时 runlog / 返回值都没有 gate 计数');

    /* 21. 池为空（FACT 与项目记忆都没有条目）⇒ 放行，一个候选都不许丢 */
    const emptyDir = join(home, 'proj-empty-pool');
    mkdirSync(emptyDir, { recursive: true });
    const emptyPoolStore = memoryStore({ home, projectDir: emptyDir, factText: '' });
    const emptyPoolRuntime = makeRuntime({
        store: emptyPoolStore,
        model: fakeModel({ extraction: JSON.stringify({ memories: [{ scope: 'global', content: '池为空时闸口必须放行这条结论', confidence: 'high' }] }) }),
        config: { dryRun: false },
    });
    seedRows({ bucket: 'ws-empty-pool', sessionId: 'session-empty-pool', count: 6, cwd: emptyDir });
    const emptyPool = await runL1({ runtime: emptyPoolRuntime, bucket: { workspaceId: 'ws-empty-pool', path: emptyDir }, now: NOW + 210 });
    assert.equal(emptyPool.status, 'OK');
    assert.equal(emptyPool.candidates, 1);
    assert.equal(emptyPool.gate['near-duplicate'], 0);
    assert.equal(emptyPool.counts.written, 1);
    assert.ok(readFileSync(emptyPoolStore.factPath(), 'utf8').includes('池为空时闸口必须放行这条结论'));

    /* 21b. 池构建异常（store.entryId 抛错）⇒ 空池放行、写入照常，降级原因进 runlog.detail */
    const poolErrDir = join(home, 'proj-pool-error');
    mkdirSync(poolErrDir, { recursive: true });
    const poolErrStore = memoryStore({ home, projectDir: poolErrDir, factText: `## 约定\n\n- ${CROSS_OLD}\n` });
    poolErrStore.entryId = () => {
        const error = new Error('池构建挂了');
        error.code = 'POOL_BOOT_FAILED';
        throw error;
    };
    const poolErrRuntime = makeRuntime({
        store: poolErrStore,
        model: fakeModel({ extraction: JSON.stringify({ memories: [{ scope: 'global', content: '池构建失败时这条结论也必须写进去', confidence: 'high' }] }) }),
        config: { dryRun: false },
    });
    seedRows({ bucket: 'ws-pool-error', sessionId: 'session-pool-error', count: 6, cwd: poolErrDir });
    const poolErrRun = await runL1({ runtime: poolErrRuntime, bucket: { workspaceId: 'ws-pool-error', path: poolErrDir }, now: NOW + 215 });
    assert.equal(poolErrRun.status, 'OK', '池构建异常不能阻断写入');
    assert.equal(poolErrRun.counts.written, 1);
    assert.equal(poolErrRun.gate['near-duplicate'], 0, '空池 ⇒ 一个都不拦');
    assert.ok(readFileSync(poolErrStore.factPath(), 'utf8').includes('池构建失败时这条结论也必须写进去'));
    const poolErrLogged = readLastRun({ file: poolErrRuntime.runLog.path });
    assert.ok(String(poolErrLogged.detail).includes('gate:POOL_BOOT_FAILED'), `降级原因要留痕：${poolErrLogged.detail}`);

    /* 22. `screenCrossPool()` 纯函数：拦截 / 放行 / 空池 / 关闭 / 打分异常降级 */
    const unitPool = [{ id: 'a', text: CROSS_OLD }];
    const intercepted = screenCrossPool([{ content: CROSS_OLD }], unitPool);
    assert.equal(intercepted.kept.length, 0, 'exact 重复要拦');
    assert.equal(intercepted.dropped[0].reason, 'near-duplicate', '原因用稳定的 near-duplicate');
    assert.equal(intercepted.dropped[0].preReason, 'exact');
    assert.equal(intercepted.checked, 1);

    const released = screenCrossPool([{ content: '依赖用 tarball 装，不要用 pnpm install' }], unitPool);
    assert.equal(released.kept.length, 1, 'ADJUDICATE（0.75）必须放行');
    assert.equal(released.dropped.length, 0);

    assert.equal(screenCrossPool([{ content: CROSS_OLD }], []).kept.length, 1, '池为空 ⇒ 放行');
    assert.equal(screenCrossPool([{ content: CROSS_OLD }], unitPool, { enabled: false }).kept.length, 1, '开关关 ⇒ 放行');

    /* 打分异常（池条目 text 取值就抛）⇒ 放行 + 返回错误码，绝不阻断写入 */
    const doomedPool = [
        { id: 'x', get text() { throw new Error('boom'); } },
        { id: 'y', text: '另一条正常条目' },
    ];
    const degraded = screenCrossPool([{ content: CROSS_OLD }, { content: '第二条候选' }], doomedPool);
    assert.equal(degraded.kept.length, 2, '打分异常必须整批放行');
    assert.equal(degraded.dropped.length, 0);
    assert.equal(degraded.error?.code, 'cross-pool-error', '异常要带错误码（调用方写进 runlog.detail）');
    assert.equal(degraded.error?.index, 0);

    /* ══════════ DESIGN §6：UPDATE 走两段式失效（先新增，成功后才标记旧的） ══════════ */

    /* 23. 成功路径：insertEntry 先于 supersedeEntry；旧条目只加注释、字节只增不减 */
    const supDir = join(home, 'proj-supersede');
    mkdirSync(supDir, { recursive: true });
    const supFactBefore = `## 约定\n\n- ${CROSS_OLD}\n`;
    const supStore = memoryStore({ home, projectDir: supDir, factText: supFactBefore, supersede: true });
    const supRuntime = makeRuntime({
        store: supStore,
        model: fakeModel({
            extraction: JSON.stringify({ memories: [{ scope: 'global', content: '依赖用 tarball 装，不要用 pnpm install', confidence: 'high' }] }),
            adjudication: adjudicate,
        }),
        config: { dryRun: false },
    });
    seedRows({ bucket: 'ws-supersede', sessionId: 'session-supersede', count: 6, cwd: supDir });
    const supRun = await runL1({ runtime: supRuntime, bucket: { workspaceId: 'ws-supersede', path: supDir }, now: NOW + 220 });

    assert.equal(supRun.status, 'OK', `两段式后应成功：${supRun.status} / ${supRun.reason}`);
    assert.equal(supRun.counts.replaced, 1, '两段式仍记 replaced（语义是「被取代」）');
    assert.equal(supRun.counts.written, 0, '没有独立的新增条目');
    assert.equal(supRun.counts.failed, 0);
    const insertCall = supStore.calls.find((call) => call.name === 'insertEntry');
    const supersedeCall = supStore.calls.find((call) => call.name === 'supersedeEntry');
    assert.ok(insertCall !== undefined, '第一步必须写新正文');
    assert.ok(supersedeCall !== undefined, '第二步必须标记旧条目失效');
    assert.ok(
        supStore.calls.indexOf(insertCall) < supStore.calls.indexOf(supersedeCall),
        '顺序必须是「先写新的，再标记旧的」（反过来就是不可恢复的数据丢失）',
    );
    assert.equal(supersedeCall.args[0], 'fact');
    assert.deepEqual(supersedeCall.args[1], { id: supStore.entryId('', CROSS_OLD) }, 'target 是旧条目 id');
    assert.ok(/^[0-9a-f]{10}$/u.test(String(supersedeCall.args[2]?.by)), `by 必须是新条目 contentId：${supersedeCall.args[2]?.by}`);

    const supFactAfter = readFileSync(supStore.factPath(), 'utf8');
    assert.ok(supFactAfter.includes('依赖用 tarball 装，不要用 pnpm install'), '新正文要落盘');
    assert.ok(
        supFactAfter.includes(`${CROSS_OLD} <!-- memory-state: status=superseded by=`),
        `旧条目只加行尾状态注释（失效不删除）：${supFactAfter}`,
    );
    assert.ok(
        Buffer.byteLength(supFactAfter, 'utf8') > Buffer.byteLength(supFactBefore, 'utf8'),
        '失效标记只会加字节，绝不删行',
    );

    /* 24. 新条目没写成 ⇒ 回退替换，且绝不标记旧条目失效（旧条目保持可用） */
    const fallbackDir = join(home, 'proj-supersede-fallback');
    mkdirSync(fallbackDir, { recursive: true });
    const fbStore = memoryStore({ home, projectDir: fallbackDir, factText: `## 约定\n\n- ${CROSS_OLD}\n`, supersede: true });
    fbStore.insertEntry = async (scope, entry, context) => {
        fbStore.calls.push({ name: 'insertEntry', args: [scope, entry, context] });
        return { written: false, reason: 'template-rejected' };
    };
    const fbRuntime = makeRuntime({
        store: fbStore,
        model: fakeModel({
            extraction: JSON.stringify({ memories: [{ scope: 'global', content: '依赖用 tarball 装，不要用 pnpm install', confidence: 'high' }] }),
            adjudication: adjudicate,
        }),
        config: { dryRun: false },
    });
    seedRows({ bucket: 'ws-supersede-fb', sessionId: 'session-supersede-fb', count: 6, cwd: fallbackDir });
    const fbRun = await runL1({ runtime: fbRuntime, bucket: { workspaceId: 'ws-supersede-fb', path: fallbackDir }, now: NOW + 230 });
    assert.equal(fbRun.status, 'OK');
    assert.equal(fbRun.counts.replaced, 1, '回退原子替换成功');
    assert.equal(fbRun.counts.failed, 0);
    assert.ok(fbStore.calls.some((call) => call.name === 'replaceEntry'), '写不进新条目 ⇒ 回退 replaceEntry');
    assert.ok(!fbStore.calls.some((call) => call.name === 'supersedeEntry'), '写不进新条目时绝不许标记旧的失效');
    const fbFact = readFileSync(fbStore.factPath(), 'utf8');
    assert.ok(fbFact.includes('依赖用 tarball 装，不要用 pnpm install'), '回退后新正文要落盘');
    assert.ok(!fbFact.includes(`${CROSS_OLD} <!-- memory-state`), '没写成新条目就不许出现失效标记');

    /* ══════════ DESIGN v3 §14：结论/细节分层 + importance + layers 观测 ══════════ */

    /* 25. `routeByGranularity()` 纯函数：改判、不丢弃、journal 原样、未知 scope 不动 */
    const granularInput = [
        { scope: 'global', content: 'rAF 合并触摸写入', kind: 'detail', importance: 5 },
        { scope: 'project', content: 'importance 2 也算细节', kind: 'conclusion', importance: 2 },
        { scope: 'journal', content: '本来就是 JOURNAL 的一次性事件', kind: 'detail', importance: 1 },
        { scope: 'global', content: '普通结论照旧进 FACT', kind: 'conclusion', importance: 3 },
        { scope: 'project', content: '两边都踩的低档结论', kind: 'detail', importance: 2 },
        { scope: 'global', content: '一次性小事', kind: 'conclusion', importance: 1 },
    ];
    const granularRouted = routeByGranularity(granularInput);
    assert.equal(granularRouted.candidates.length, granularInput.length, '分层只改判，绝不丢弃');
    assert.equal(granularRouted.rerouted, 4, 'detail / importance≤2 各算改判');
    assert.deepEqual(
        granularRouted.candidates.map((item) => item.scope),
        ['journal', 'journal', 'journal', 'global', 'journal', 'journal'],
    );
    assert.equal(granularInput[0].scope, 'global', '纯函数不许改入参');
    assert.equal(granularRouted.candidates[2], granularInput[2], '已判 journal 的原样通过（同一个对象）');
    assert.equal(granularRouted.candidates[3], granularInput[3], '不用改判的也原样通过');
    assert.equal(routeByGranularity([{ scope: 'nonsense', kind: 'detail', importance: 1 }]).rerouted, 0, '未知 scope 不动');
    assert.equal(routeByGranularity([{ scope: 'global', kind: 'detail' }]).rerouted, 1, '缺 importance 但 kind=detail 照样改判');
    assert.deepEqual(routeByGranularity(), { candidates: [], rerouted: 0 });
    assert.deepEqual(routeByGranularity(null), { candidates: [], rerouted: 0 });

    /* 26. `attachImportance()`：按 content 回匹配；改写过的正文匹配不上 ⇒ 缺省 3 */
    const attached = attachImportance(
        [
            { op: 'ADD', content: 'A 结论' },
            { op: 'ADD', content: '模型改写过的正文' },
            { op: 'UPDATE', content: 'B 结论' },
        ],
        [
            { content: 'A 结论', importance: 5 },
            { content: 'B 结论', importance: 2 },
            { content: 'A 结论', importance: 1 }, // 同一正文重复出现：先到先得
        ],
    );
    assert.deepEqual(attached.map((op) => op.importance), [5, 3, 2]);
    assert.equal(attached[1].content, '模型改写过的正文', '正文一个字都不许改');

    /* 26b. E4：归并算子带候选下标，正文被改写也能回填 importance（不再掉到缺省 3） */
    const mergedForIndex = await mergeCandidates({
        candidates: [
            { content: '结论甲', scope: 'global', ts: NOW },
            { content: '结论乙', scope: 'global', ts: NOW },
        ],
        pool: [],
    });
    assert.equal(mergedForIndex.ok, true);
    assert.deepEqual(mergedForIndex.ops.map((op) => op.sourceIndex), [0, 1], 'ADD 算子必须带候选下标');
    const indexAttached = attachImportance(
        [
            { op: 'ADD', content: '结论甲（被模型改写过）', sourceIndex: 0 },
            { op: 'ADD', content: '结论乙（也被改写过）', sourceIndex: 1 },
            { op: 'ADD', content: '结论乙' },
            { op: 'ADD', content: '表里没有的正文', sourceIndex: 9 },
        ],
        [
            { content: '结论甲', importance: 5 },
            { content: '结论乙', importance: 2 },
        ],
    );
    assert.deepEqual(indexAttached.map((op) => op.importance), [5, 2, 2, 3], '下标优先 / 正文匹配兜底 / 都没有用缺省 3');
    assert.equal(indexAttached[0].content, '结论甲（被模型改写过）', '回填只补 importance，正文一字不改');

    /* 27. 端到端：detail / 低重要性被改判进 JOURNAL，结论照写 FACT，layers 落 runlog */
    const layerDir = join(home, 'proj-layers');
    mkdirSync(layerDir, { recursive: true });
    const layerStore = memoryStore({ home, projectDir: layerDir, factText: '' });
    const layerRuntime = makeRuntime({
        store: layerStore,
        model: fakeModel({
            extraction: JSON.stringify({
                memories: [
                    { scope: 'project', content: 'rAF 合并触摸写入，一帧最多一次', confidence: 'high', kind: 'detail', importance: 5 },
                    { scope: 'global', content: '跨轮记忆写入必须走同一把写锁', confidence: 'high', kind: 'conclusion', importance: 4 },
                    { scope: 'global', content: '临时调试时改过一次缓存目录', confidence: 'medium', kind: 'conclusion', importance: 1 },
                ],
            }),
        }),
        config: { dryRun: false },
    });
    seedRows({ bucket: 'ws-layers', sessionId: 'session-layers', count: 6, cwd: layerDir });
    const layered = await runL1({ runtime: layerRuntime, bucket: { workspaceId: 'ws-layers', path: layerDir }, now: NOW + 240 });

    assert.equal(layered.status, 'OK', `分层后应成功：${layered.status} / ${layered.reason}`);
    assert.equal(layered.candidates, 3, '改判不是丢弃：3 条候选都进归并');
    assert.deepEqual(layered.layers, { conclusion: 2, detail: 1, rerouted: 2 }, 'layers 按最终 kind 计数 + 改判条数');
    assert.equal(layered.calls, 1, '分层是纯函数，不该多花调用');
    const layerFact = readFileSync(layerStore.factPath(), 'utf8');
    assert.ok(layerFact.includes('跨轮记忆写入必须走同一把写锁'), '结论照写 FACT');
    assert.ok(!layerFact.includes('rAF 合并触摸写入'), '实现细节不许占静态槽');
    assert.ok(!layerFact.includes('临时调试时改过一次缓存目录'), 'importance≤2 不许占静态槽');
    const layerJournal = readFileSync(layerStore.journalPath(), 'utf8');
    assert.ok(layerJournal.includes('rAF 合并触摸写入'), '改判的细节必须落 JOURNAL（不丢）');
    assert.ok(layerJournal.includes('临时调试时改过一次缓存目录'), '低重要性条目也落 JOURNAL');
    assert.equal(layered.counts.written, 3, '2 条改判 JOURNAL + 1 条 FACT 都算写成（改判不是丢弃）');
    const layerInsert = layerStore.calls.find((call) => call.name === 'insertEntry').args[1];
    assert.equal(layerInsert.importance, 70, 'importance 4 ⇒ 70，要交给 store.insertEntry');
    assert.equal(layerInsert.content, undefined, 'entry 里不许出现 content');
    const layerLogged = readLastRun({ file: layerRuntime.runLog.path });
    assert.deepEqual(layerLogged.layers, { conclusion: 2, detail: 1, rerouted: 2 }, 'layers 必须进 runlog（§14.2 只做观测）');
    assert.equal(layerLogged.calls, 1);

    /* 28. 抽取器的真实调用次数要记账：`calls:2`（截断重试）⇒ runlog 与预算都是 2 */
    const callDir = join(home, 'proj-calls');
    mkdirSync(callDir, { recursive: true });
    const callStore = memoryStore({ home, projectDir: callDir, factText: '' });
    const callRuntime = makeRuntime({
        store: callStore,
        model: fakeModel({}),
        config: { dryRun: false },
    });
    // 单独替换抽取器：模拟「抢救失败 → 降推理等级重试成功」的那一次（calls=2）。
    callRuntime.extractor = {
        async extract() {
            return {
                ok: true,
                reason: 'ok',
                memories: [{ scope: 'global', content: '重试成功这条结论必须落进 FACT', confidence: 'high', kind: 'conclusion', importance: 3 }],
                ops: [],
                rejects: [],
                prompt: '',
                truncated: true,
                retry: 'max-tokens',
                calls: 2,
            };
        },
    };
    seedRows({ bucket: 'ws-calls', sessionId: 'session-calls', count: 6, cwd: callDir });
    const counted = await runL1({ runtime: callRuntime, bucket: { workspaceId: 'ws-calls', path: callDir }, now: NOW + 250 });
    assert.equal(counted.status, 'OK');
    assert.equal(counted.calls, 2, 'calls 必须来自抽取器的真实记账（不能再写死 1）');
    assert.equal(callRuntime.budget.snapshot().used.total, 2, '预算要按真实调用数扣：占锁 1 次 + 补扣 1 次');
    const countedLogged = readLastRun({ file: callRuntime.runLog.path });
    assert.equal(countedLogged.calls, 2);
    assert.equal(countedLogged.detail, 'retry:max-tokens', '重试救回来要记 retry:，不能和补括号抢救混为一谈');
    assert.ok(readFileSync(callStore.factPath(), 'utf8').includes('重试成功这条结论必须落进 FACT'));

    /* 28b. 抢救成功（salvage）与重试（retry）在 detail 里必须能分辨 */
    const salvageDir = join(home, 'proj-salvage');
    mkdirSync(salvageDir, { recursive: true });
    const salvageStore = memoryStore({ home, projectDir: salvageDir, factText: '' });
    const salvageRuntime = makeRuntime({ store: salvageStore, model: fakeModel({}), config: { dryRun: false } });
    salvageRuntime.extractor = {
        async extract() {
            return {
                ok: true,
                reason: 'ok',
                memories: [{ scope: 'global', content: '补括号救回来的这条结论也要落盘', confidence: 'high', kind: 'conclusion', importance: 3 }],
                ops: [],
                rejects: [],
                prompt: '',
                truncated: true,
                salvage: 'max-tokens',
                calls: 1,
            };
        },
    };
    seedRows({ bucket: 'ws-salvage', sessionId: 'session-salvage', count: 6, cwd: salvageDir });
    const salvagedRun = await runL1({ runtime: salvageRuntime, bucket: { workspaceId: 'ws-salvage', path: salvageDir }, now: NOW + 255 });
    assert.equal(salvagedRun.calls, 1);
    assert.equal(readLastRun({ file: salvageRuntime.runLog.path }).detail, 'salvage:max-tokens', 'salvage 与 retry 要能分辨');

    /* 29. 抽取失败但已经调了 2 次（重试仍失败）⇒ FAIL 也要按 2 次扣预算 */
    const retryFailDir = join(home, 'proj-retry-fail');
    mkdirSync(retryFailDir, { recursive: true });
    const retryFailStore = memoryStore({ home, projectDir: retryFailDir, factText: '' });
    const retryFailRuntime = makeRuntime({ store: retryFailStore, model: fakeModel({}), config: { dryRun: false } });
    retryFailRuntime.extractor = {
        async extract() {
            return {
                ok: false,
                reason: 'model-error',
                code: LLM_TRUNCATED,
                detail: "Error: 模型输出被 max-tokens 截断 · finish.kind=max-tokens · retry:LLM_TRUNCATED",
                memories: [],
                ops: [],
                rejects: [],
                prompt: '',
                calls: 2,
            };
        },
    };
    seedRows({ bucket: 'ws-retry-fail', sessionId: 'session-retry-fail', count: 6, cwd: retryFailDir });
    const retryFailed = await runL1({ runtime: retryFailRuntime, bucket: { workspaceId: 'ws-retry-fail', path: retryFailDir }, now: NOW + 260 });
    assert.equal(retryFailed.status, 'FAIL');
    assert.equal(retryFailed.calls, 2, '失败路径也要认账（重试是真花了钱）');
    assert.equal(retryFailRuntime.budget.snapshot().used.total, 2, 'FAIL 路径的补扣 budget.charge 必须发生');
    assert.equal(readLastRun({ file: retryFailRuntime.runLog.path }).calls, 2);
    assert.equal(readUnconsumed({ pendingDir: retryFailRuntime.pendingDir, bucket: 'ws-retry-fail' }).length, 6, '失败不消费');

} finally {
    cleanup();
}

console.log('✓ pipeline.test.mjs 全部通过');
