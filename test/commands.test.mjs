/**
 * 命令层（M1）：`status` / `dry` / `run` / `rollback` 的真实行为与「绝不抛」契约。
 *
 * 三条要钉住的：
 *  1. `dry` **强制干跑**（哪怕 config 里 `dryRun: false`）；`run` 才看 config；
 *  2. 命令永远返回 `{kind:'success'|'error', text}`，异常一律在 `handle` 里兜住；
 *  3. `rollback last` 真的能按最近一次快照恢复（不是「未接线」）。
 *
 * 本文件不 import `lib/index.js`（它需要 schemastery），所以用 `_helpers.makeRuntime()`
 * 手工拼一个同形状的 runtime；`prepare` 的作用与 `index.js` 里的模型接线一致。
 *
 * 跑法：node test/commands.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCommands, renderRunResult, verdictOf } from '../lib/commands.js';
import { createExtractor } from '../lib/extractor.js';
import { readUnconsumed } from '../lib/pending.js';
import { NOW, fakeModel, makeHome, makeRuntime, memoryStore, seedRows, sha256 } from './_helpers.mjs';

const EXTRACTION = JSON.stringify({
    memories: [{ scope: 'global', content: '命令层跑通后这条要落进 FACT', confidence: 'high' }],
});

const { home, cleanup } = makeHome('pmc-commands');

try {
    const projectDir = join(home, 'proj');
    mkdirSync(projectDir, { recursive: true });
    const store = memoryStore({ home, projectDir, factText: '## 约定\n\n- 已有的结论\n', memoryText: '## 结论\n\n1. 项目记忆\n' });
    const model = fakeModel({ extraction: EXTRACTION });

    let prepared = 0;
    const runtime = makeRuntime({ store, model, config: { dryRun: false } });
    const commands = createCommands(runtime, {
        logger: { info() {}, warn() {} },
        // 与 index.js 的 prepare 同形：命令执行时才把模型接进 runtime。
        prepare() {
            prepared += 1;
            runtime.callModel = model;
            runtime.extractor = createExtractor({ callModel: model, templates: () => runtime.templatesCache });
        },
    });
    runtime.pendingDir = join(home, 'pending-cmd');
    seedRows({ pendingDir: runtime.pendingDir, bucket: 'ws-cmd', sessionId: 'session-cmd', count: 6, cwd: projectDir });
    // L2 的素材源：本文件不测数据源（那是 sources.test.mjs 的事），直接喂空素材，
    // 于是 cross 走「读到素材、模型给空 promote」的 NOOP 路径。
    runtime.crossChain = {
        chain: ['journal'],
        async list() {
            return { ok: true, source: 'journal', reason: 'ok', entries: [], attempts: [{ source: 'journal', ok: true, reason: 'ok' }] };
        },
    };

    /* ── status：真读盘 + 上次运行 + 自动触发状态 ── */
    const status = await commands.handle({ rawInput: '' });
    assert.equal(status.kind, 'success');
    assert.ok(status.text.includes('自动沉淀'));
    assert.ok(status.text.includes('未消费 6 行'));
    assert.ok(status.text.includes('自动触发：已接线'), 'M2 起自动触发已接线（status 要如实说）');
    assert.ok(status.text.includes('上次运行：从未'));

    /* ── dry：强制干跑（config.dryRun 是 false 也一样） ── */
    const factBefore = sha256(store.factPath());
    const dry = await commands.handle({ rawInput: 'dry' });
    assert.equal(dry.kind, 'success', `dry 应成功：${dry.text}`);
    assert.ok(dry.text.includes('干跑（不落盘）'), 'dry 必须报告自己在干跑');
    assert.ok(dry.text.includes('ws-cmd'), '报告要指明桶');
    assert.ok(dry.text.includes('1 次调用'), '报告要写调用次数');
    assert.equal(sha256(store.factPath()), factBefore, 'dry 不许写盘');
    assert.equal(readUnconsumed({ pendingDir: runtime.pendingDir, bucket: 'ws-cmd' }).length, 6, 'dry 不许消费行');
    assert.equal(prepared, 1, '命令执行前要接线模型');

    /* ── run（config.dryRun=false）：真写盘 ── */
    const run = await commands.handle({ rawInput: 'run' });
    assert.equal(run.kind, 'success', `run 应成功：${run.text}`);
    assert.ok(run.text.includes('立即沉淀（会写盘）'));
    assert.ok(run.text.includes('新增 1'));
    assert.ok(run.text.includes('runId='));
    assert.ok(readFileSync(store.factPath(), 'utf8').includes('命令层跑通后这条要落进 FACT'));
    assert.equal(readUnconsumed({ pendingDir: runtime.pendingDir, bucket: 'ws-cmd' }).length, 0, 'write 成功后才消费');
    assert.equal(prepared, 2);

    /* ── status 现在能显示上次运行 + 近 7 天汇总 + 上次跨会话 ── */
    const after = await commands.handle({ rawInput: 'status' });
    assert.ok(after.text.includes('上次运行：'));
    assert.ok(after.text.includes('OK'));
    assert.ok(/runId run-/u.test(after.text), `上次运行要带 runId：${after.text}`);
    assert.ok(after.text.includes('近 7 天：'), 'M5：status 要带 runlog 汇总');
    assert.ok(after.text.includes('成功'), '汇总里要有成功率');
    assert.ok(after.text.includes('NOOP'), '汇总里要有 NOOP 比例');
    assert.ok(after.text.includes('降级'), '汇总里要有 DEMOTED 计数');
    assert.ok(after.text.includes('水位：'), '有 store 时要显示水位');
    assert.ok(after.text.includes('上次跨会话整理：'), 'M4：status 要显示上次跨会话整理');
    assert.ok(after.text.split('\n').length <= 25, `status 要保持在 25 行内：${after.text.split('\n').length} 行`);

    /* ── rollback last：按最近一次快照恢复 ── */
    writeFileSync(store.factPath(), '## 手改\n\n- 全被改掉了\n', 'utf8');
    const rollbackLast = await commands.handle({ rawInput: 'rollback last' });
    assert.equal(rollbackLast.kind, 'success', `rollback last 应成功：${rollbackLast.text}`);
    assert.ok(rollbackLast.text.includes('已回滚'));
    assert.equal(readFileSync(store.factPath(), 'utf8'), '## 约定\n\n- 已有的结论\n', '回滚到快照内容');

    /* ── rollback 的各种失败都要回 error 文本，不抛 ── */
    const missing = await commands.handle({ rawInput: 'rollback run-不存在' });
    assert.equal(missing.kind, 'error');
    assert.ok(missing.text.includes('回滚失败'));
    const noArg = await commands.handle({ rawInput: 'rollback' });
    assert.equal(noArg.kind, 'error');
    assert.ok(noArg.text.includes('用法'));

    /* ── 未知子命令 / 多余空白 / 大小写 ── */
    const unknown = await commands.handle({ rawInput: '删除所有记忆' });
    assert.equal(unknown.kind, 'error');
    assert.ok(unknown.text.includes('未知子命令'));
    assert.equal((await commands.handle({ rawInput: '  STATUS  ' })).kind, 'success');
    assert.equal((await commands.handle({ rawInput: undefined })).kind, 'success', '不带参数等同 status');

    /* ── cross：M4 起真跑 L2（跨桶 + 逐桶），永远回 `{kind,text}` 不抛 ── */
    const cross = await commands.handle({ rawInput: 'cross' });
    assert.equal(cross.kind, 'success', `cross 应成功：${cross.text}`);
    assert.ok(cross.text.includes('跨会话整理'), 'cross 要报告自己在做跨会话整理');
    assert.ok(cross.text.includes('升格'), 'cross 报告要写升格条数');
    assert.ok(cross.text.includes('runId='));

    /* cross dry：强制干跑（config.dryRun 已经是 false） */
    const crossDry = await commands.handle({ rawInput: 'cross dry' });
    assert.equal(crossDry.kind, 'success', `cross dry 应成功：${crossDry.text}`);
    assert.ok(crossDry.text.includes('干跑'), 'cross dry 必须报告自己在干跑');

    /* crossEnabled=false ⇒ 明确拒绝，不假装跑过 */
    const offRuntime = makeRuntime({ store, model, config: { dryRun: false, crossEnabled: false } });
    const offCross = await createCommands(offRuntime).handle({ rawInput: 'cross' });
    assert.equal(offCross.kind, 'error');
    assert.ok(offCross.text.includes('crossEnabled'));

    /* ── 永不抛：管线内部抛错/写入抛错都要变成 error 文本 ── */
    const broken = makeRuntime({ store, model, config: { dryRun: false } });
    broken.pendingDir = runtime.pendingDir;
    broken.writer = {
        async apply() {
            throw new Error('磁盘只读');
        },
    };
    seedRows({ pendingDir: runtime.pendingDir, bucket: 'ws-broken', sessionId: 'session-broken', count: 6 });
    const brokenCommands = createCommands(broken);
    const brokenResult = await brokenCommands.handle({ rawInput: 'run' });
    assert.equal(brokenResult.kind, 'error', '管线炸了要报 error');
    assert.ok(brokenResult.text.includes('FAIL') || brokenResult.text.includes('pipeline-error'), `实得：${brokenResult.text}`);
    assert.equal(readUnconsumed({ pendingDir: broken.pendingDir, bucket: 'ws-broken' }).length, 6, '炸了不许消费行');

    /* prepare 自己抛错也要被兜住 */
    const prepareFail = createCommands(makeRuntime({ store, model }), {
        prepare() {
            throw new Error('llm 服务不可用');
        },
    });
    const prepareFailed = await prepareFail.handle({ rawInput: 'run' });
    assert.equal(prepareFailed.kind, 'error');
    assert.ok(prepareFailed.text.includes('模型接线失败'));

    /* ── 运行档位（P1）：status 要显示档位；off 档拒绝正式写入；observe 跑影子 ── */
    assert.ok(status.text.includes('运行档位：正式写入（auto）'), `status 要显示当前档位：${status.text}`);

    const offModeRuntime = makeRuntime({ store, model, config: { dryRun: false, mode: 'off' } });
    offModeRuntime.pendingDir = runtime.pendingDir;
    const offModeCommands = createCommands(offModeRuntime);
    const offStatus = await offModeCommands.handle({ rawInput: 'status' });
    assert.ok(offStatus.text.includes('关闭（off'), `off 档 status 要如实说：${offStatus.text}`);
    const offRun = await offModeCommands.handle({ rawInput: 'run' });
    assert.equal(offRun.kind, 'error', 'off 档不许正式写入');
    assert.ok(offRun.text.includes('off'), `拒绝文案要说出档位：${offRun.text}`);
    // `dry` 仍然可用（只读报告），不然排查时连报告都拿不到
    const offDry = await offModeCommands.handle({ rawInput: 'dry' });
    assert.equal(offDry.kind, 'success', `off 档 dry 应该仍能跑：${offDry.text}`);

    /* observe 档：真跑管线、FACT/MEMORY 的 SHA256 不变、报告指向 would-write */
    const observeRuntime = makeRuntime({
        store,
        model: fakeModel({ extraction: JSON.stringify({ memories: [{ scope: 'global', content: '命令层影子档的这条不该落盘', confidence: 'high' }] }) }),
        config: { dryRun: false, mode: 'observe' },
    });
    observeRuntime.pendingDir = join(home, 'pending-observe');
    seedRows({ pendingDir: observeRuntime.pendingDir, bucket: 'ws-obs', sessionId: 'session-obs', count: 6, cwd: projectDir });
    const factShaObserve = sha256(store.factPath());
    const memoryShaObserve = sha256(join(projectDir, 'MEMORY.md'));
    const observeCommands = createCommands(observeRuntime);
    const observeRun = await observeCommands.handle({ rawInput: 'run' });
    assert.equal(observeRun.kind, 'success', `observe 档 run 应成功：${observeRun.text}`);
    assert.ok(observeRun.text.includes('影子模式（observe，不落盘）'), `报告头要说明是影子：${observeRun.text}`);
    assert.ok(observeRun.text.includes('would-write') || observeRun.text.includes('影子文件：'), '报告要指向影子文件');
    assert.equal(sha256(store.factPath()), factShaObserve, 'observe 档 FACT.md 的 SHA256 不变');
    assert.equal(sha256(join(projectDir, 'MEMORY.md')), memoryShaObserve, 'observe 档 MEMORY.md 的 SHA256 不变');
    assert.equal(readUnconsumed({ pendingDir: observeRuntime.pendingDir, bucket: 'ws-obs' }).length, 0, 'observe 档与 auto 同口径消费暂存行');
    assert.ok(observeRun.text.includes('切到 auto 后不会补写'), '报尾要点明「观察期消费的素材不会补写」这个取舍');

    /* ── 纯函数：verdictOf / renderRunResult ── */
    assert.equal(verdictOf({ skipped: 'empty', runs: [] }), 'success');
    assert.equal(verdictOf({ skipped: 'budget', reason: 'daily-budget', runs: [] }), 'error');
    assert.equal(verdictOf({ runs: [{ skipped: 'extract-failed', status: 'FAIL' }] }), 'error');
    assert.equal(verdictOf({ runs: [{ skipped: 'below-threshold' }] }), 'success');
    assert.equal(verdictOf({ runs: [{ status: 'OK' }] }), 'success');
    assert.ok(renderRunResult({ runId: 'r1', dryRun: true, skipped: 'empty', runs: [] }, true).includes('没有待沉淀'));

    /* ── 冒烟：命令不会悄悄把 pending 目录建到别处 ── */
    assert.ok(runtime.pendingDir.startsWith(home));
} finally {
    cleanup();
}

console.log('✓ commands.test.mjs 全部通过');
