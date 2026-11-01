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
import { readCursor } from '../lib/cursor.js';
import { archivePath, readRows, readUnconsumed } from '../lib/pending.js';
import { latestRunId, rollbackRun, runAllBuckets, runL1, snapshotFiles } from '../lib/pipeline.js';
import { readLastRun } from '../lib/runlog.js';
import { NOW, fakeModel, makeHome, makeRuntime, memoryStore, seedRows, sha256 } from './_helpers.mjs';

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
    seedRows({ pendingDir: allDir, bucket: 'ws-7', sessionId: 'session-g', count: 6 });
    seedRows({ pendingDir: allDir, bucket: 'ws-8', sessionId: 'session-h', count: 6 });
    const replies = ['逐桶运行的第一条新结论', '逐桶运行的第二条新结论'];
    let replyIndex = 0;
    const perBucket = makeRuntime({
        store,
        model: async () => JSON.stringify({ memories: [{ scope: 'global', content: replies[replyIndex] ?? replies[0] }] }),
        config: { dryRun: false },
        registry: { workspaces: { 'ws-7': { path: '', title: '工作区七', sessionIds: ['session-g'] } } },
    });
    perBucket.pendingDir = allDir;
    // 每次调用换一条正文（内容是常量的话，第二个桶会因「已存在」被判 NOOP，掩盖「两个桶都真跑了」）
    const originalCall = perBucket.callModel;
    perBucket.callModel = async (request) => {
        const reply = await originalCall(request);
        replyIndex += 1;
        return reply;
    };

    const all = await runAllBuckets({ runtime: perBucket, dryRun: false, now: NOW + 60 });
    assert.equal(all.skipped, undefined);
    assert.equal(all.runs.length, 2, '两个非空桶都要跑');
    assert.deepEqual(all.runs.map((run) => run.bucket).sort(), ['ws-7', 'ws-8']);
    assert.ok(all.runs.every((run) => run.status === 'OK'));
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
} finally {
    cleanup();
}

console.log('✓ pipeline.test.mjs 全部通过');
