/**
 * 拒绝降级 + 批次消费（P0-B）。
 *
 * 真实故障：主插件 assertEntry 抛 MEMORY_ENTRY_REJECTED（details={demote:'journal'|'drop',
 * reason}），旧 writer 因为 error.code 非空永远取不到 details.reason ⇒ 本来该降级 JOURNAL
 * 的条目记成 FAILED 且一个字没写；pipeline 又见 failed>0 就不 markConsumed ⇒ 同一批
 * 9 行 / 5323 字符重跑 13 次、25 次调用。
 *
 * 本文件钉住四件事：
 *   1. demote=journal ⇒ 补写 JOURNAL，记 demoted（不是失败）；
 *   2. demote=drop ⇒ 记 FAILED 且带 details.reason，并标 retryable:false（不阻塞消费）；
 *   3. 临时失败（LLM / 超时 / 写盘 IO）⇒ 照旧阻塞消费，下轮重试；
 *   4. pipeline 的消费判定只看可重试失败。
 *
 * 跑法：node test/reject-consume.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readUnconsumed } from '../lib/pending.js';
import { runL1 } from '../lib/pipeline.js';
import { readLastRun } from '../lib/runlog.js';
import { ENTRY_REJECTED, WRITE_STATUS, createWriter, isRetryableFailure, rejectionOf } from '../lib/writer.js';
import { NOW, fakeModel, fakeStore, makeHome, makeRuntime, memoryStore, seedRows } from './_helpers.mjs';

/** 造一个主插件形状的条目拒绝（code + details）。 */
function entryRejected(demote, reason) {
    const error = new Error('MEMORY_ENTRY_REJECTED: ' + reason);
    error.code = ENTRY_REJECTED;
    error.details = { demote, reason };
    return error;
}

function addOp(content) {
    return { op: 'ADD', scope: 'global', content, confidence: 'high' };
}

/* ══════════ 1. 纯函数：rejectionOf / isRetryableFailure ══════════ */

assert.equal(rejectionOf(null), null, 'null 不是拒绝');
assert.equal(rejectionOf(new Error('boom')), null, '普通错误不是条目拒绝');
assert.deepEqual(rejectionOf(entryRejected('journal', '问句（请改写成陈述句）')), { demote: 'journal', reason: '问句（请改写成陈述句）' });
assert.deepEqual(rejectionOf(entryRejected('drop', '永久拒绝')), { demote: 'drop', reason: '永久拒绝' });
assert.deepEqual(rejectionOf(entryRejected(undefined, '没说方向')), { demote: 'drop', reason: '没说方向' }, '没说 demote ⇒ 按丢处理（拿不准不写正式记忆）');
assert.deepEqual(rejectionOf(entryRejected('', '空方向')), { demote: 'drop', reason: '空方向' });
const byName = new Error('MEMORY_ENTRY_REJECTED: 只有 name');
byName.name = ENTRY_REJECTED;
assert.deepEqual(rejectionOf(byName), { demote: 'drop', reason: 'entry-rejected' }, '只有 name / 没有 details 也要认');

assert.equal(isRetryableFailure({ status: 'failed' }), true, '没标 retryable 的失败默认可重试（老行为不变）');
assert.equal(isRetryableFailure({ status: 'failed', retryable: true }), true);
assert.equal(isRetryableFailure({ status: 'failed', retryable: false }), false, '永久拒绝不阻塞消费');
assert.equal(isRetryableFailure({ status: 'demoted' }), false, '降级 JOURNAL 不是失败');
assert.equal(isRetryableFailure({ status: 'written' }), false);
assert.equal(isRetryableFailure(null), false);

/* ══════════ 2. writer：assertEntry 的三种拒绝落点 ══════════ */

const { home, cleanup } = makeHome('pmc-reject');
try {
    /** 造一个「指定正文被 assertEntry 拒掉」的假 store，并记下 insertEntry / appendJournal。 */
    function rejectingStore(content, demote, reason) {
        const journaled = [];
        const inserted = [];
        const { store } = fakeStore({
            async assertEntry(scope, text) {
                if (String(text) === content) throw entryRejected(demote, reason);
            },
            async insertEntry(scope, entry) {
                inserted.push(String(entry?.text ?? ''));
                return { written: true, target: scope + ':1' };
            },
            async appendJournal(text, tags) {
                journaled.push({ text: String(text), tags: tags ?? [] });
                return { id: 'j1', ts: NOW };
            },
        });
        return { store, journaled, inserted };
    }

    /* 2a. demote=journal ⇒ 补写 JOURNAL，记 demoted，不算失败 */
    const journalCase = rejectingStore('被判定为问句的结论', 'journal', '问句（请改写成陈述句）');
    const journalWriter = createWriter({ store: journalCase.store });
    const journalResult = await journalWriter.apply([addOp('被判定为问句的结论')], { cwd: '/proj', now: NOW });
    const journalItem = journalResult.results[0];
    assert.equal(journalResult.counts.demoted, 1);
    assert.equal(journalResult.counts.failed, 0, '降级 JOURNAL 不是失败（行可以消费）');
    assert.equal(journalItem.status, WRITE_STATUS.DEMOTED);
    assert.equal(journalItem.reason, 'store-rejected:问句（请改写成陈述句）', '拒绝原因必须落进 reason（旧实现只剩错误码）');
    assert.deepEqual(journalCase.inserted, [], '拒绝的条目不该再尝试 insertEntry');
    assert.equal(journalCase.journaled.length, 1, '必须真的补写一次 JOURNAL');
    assert.equal(journalCase.journaled[0].text, '被判定为问句的结论');
    assert.ok(journalCase.journaled[0].tags.includes('consolidate'), '降级标记照旧');
    assert.equal(isRetryableFailure(journalItem), false);

    /* 2b. demote=drop ⇒ 记 FAILED 且带 details.reason，标 retryable:false */
    const dropCase = rejectingStore('永久毒行', 'drop', '项目条目缺少工作目录（cwd）');
    const dropWriter = createWriter({ store: dropCase.store });
    const dropResult = await dropWriter.apply([addOp('永久毒行')], { cwd: '/proj', now: NOW });
    const dropItem = dropResult.results[0];
    assert.equal(dropResult.counts.failed, 1);
    assert.equal(dropItem.status, WRITE_STATUS.FAILED);
    assert.equal(dropItem.reason, 'store-rejected:项目条目缺少工作目录（cwd）', 'details.reason 不许被 error.code 吞掉');
    assert.equal(dropItem.retryable, false, '永久拒绝必须标 retryable:false');
    assert.equal(dropCase.journaled.length, 0, 'drop 方向一个字都不写');
    assert.deepEqual(dropCase.inserted, []);

    /* 2c. 没说 demote 的拒绝 ⇒ 同样按 drop 落账（不写正式记忆） */
    const bareCase = rejectingStore('没说方向的拒绝', undefined, '空条目');
    const bareWriter = createWriter({ store: bareCase.store });
    const bareResult = await bareWriter.apply([addOp('没说方向的拒绝')], { cwd: '/proj', now: NOW });
    assert.equal(bareResult.results[0].status, WRITE_STATUS.FAILED);
    assert.equal(bareResult.results[0].reason, 'store-rejected:空条目');
    assert.equal(bareResult.results[0].retryable, false);
    assert.equal(bareCase.journaled.length, 0);

    /* 2d. 临时失败（写盘 IO）⇒ FAILED 但默认可重试 */
    const { store: tempStore } = fakeStore({
        async insertEntry() {
            const error = new Error('EIO: 磁盘暂时不可写');
            error.code = 'EIO';
            throw error;
        },
    });
    const tempWriter = createWriter({ store: tempStore });
    const tempResult = await tempWriter.apply([addOp('临时写盘失败的结论')], { cwd: '/proj', now: NOW });
    assert.equal(tempResult.counts.failed, 1);
    assert.equal(tempResult.results[0].status, WRITE_STATUS.FAILED);
    assert.equal(tempResult.results[0].reason, 'EIO');
    assert.equal(isRetryableFailure(tempResult.results[0]), true, 'IO 失败必须阻塞消费，下轮重试');

    /* 2e. store 返回 demoted:'drop'（结果式拒绝，不是抛错）⇒ 同样永久 */
    const { store: resultDropStore } = fakeStore({
        async insertEntry() {
            return { written: false, demoted: 'drop', reason: '问句（请改写成陈述句）' };
        },
    });
    const resultDropWriter = createWriter({ store: resultDropStore });
    const resultDrop = await resultDropWriter.apply([addOp('结果式拒绝的结论')], { cwd: '/proj', now: NOW });
    assert.equal(resultDrop.results[0].status, WRITE_STATUS.FAILED);
    assert.equal(resultDrop.results[0].reason, 'store-rejected:问句（请改写成陈述句）');
    assert.equal(resultDrop.results[0].retryable, false, '结果式 drop 也是永久拒绝，不能挡消费');

    /* 2f. 干跑：连 assertEntry 都不预演，只记 DRY，一个字节都不写 */
    const dryCase = rejectingStore('干跑里被拒的结论', 'journal', '问句');
    const dryWriter = createWriter({ store: dryCase.store });
    const dryResult = await dryWriter.apply([addOp('干跑里被拒的结论')], { cwd: '/proj', now: NOW, dryRun: true });
    assert.equal(dryResult.results[0].status, WRITE_STATUS.DRY);
    assert.equal(dryResult.results[0].reason, 'would-add', '干跑只记账，不预演闸口');
    assert.equal(dryCase.journaled.length, 0, '干跑不许写 JOURNAL');
    assert.deepEqual(dryCase.inserted, [], '干跑不许写正式记忆');

    /* 2g. 没有 assertEntry、但 insertEntry 直接抛拒绝 ⇒ 外层 catch 也要按同一套规则落账 */
    const { calls: throwCalls, store: throwStore } = fakeStore({
        async insertEntry() {
            throw entryRejected('journal', '问句（请改写成陈述句）');
        },
    });
    throwStore.assertEntry = undefined;
    const throwWriter = createWriter({ store: throwStore });
    const throwResult = await throwWriter.apply([addOp('插入时才被拒的结论')], { cwd: '/proj', now: NOW });
    assert.equal(throwResult.results[0].status, WRITE_STATUS.DEMOTED, '外层 catch 也必须认拒绝、不能只记错误码');
    assert.equal(throwResult.results[0].reason, 'store-rejected:问句（请改写成陈述句）');
    assert.ok(throwCalls.some((call) => call.name === 'appendJournal'), '外层 catch 也要真的补写 JOURNAL');

    /* ══════════ 3. 端到端：三种拒绝的消费判定 ══════════ */

    const factSeed = '## 约定\n\n- 依赖用 tarball 装，不用 pnpm install\n';
    const memorySeed = '## 结论\n\n1. 项目里已有的一条结论\n';

    /** 把 memoryStore 的 assertEntry 换成「命中规则就拒绝」。 */
    function storeRejecting(projectDir, rules) {
        const store = memoryStore({ home, projectDir, factText: factSeed, memoryText: memorySeed });
        const original = store.assertEntry.bind(store);
        store.assertEntry = (scope, text, context) => {
            const hit = rules.find((rule) => rule.text === String(text));
            if (hit !== undefined) throw entryRejected(hit.demote, hit.reason);
            return original(scope, text, context);
        };
        return store;
    }

    function makeDir(name) {
        const dir = join(home, name);
        mkdirSync(dir, { recursive: true });
        return dir;
    }

    function runOnce(store, dir, bucket, memories, now) {
        const runtime = makeRuntime({
            store,
            model: fakeModel({ extraction: JSON.stringify({ memories }) }),
            config: { dryRun: false },
        });
        seedRows({ bucket, sessionId: bucket + '-session', count: 6, cwd: dir });
        return { runtime, run: runL1({ runtime, bucket: { workspaceId: bucket, path: dir }, now }) };
    }

    /* 3a. journal 拒绝：内容进 JOURNAL、行被消费、状态 OK、runlog 带原因 */
    const journalDir = makeDir('proj-rej-journal');
    const journalStore = storeRejecting(journalDir, [{ text: '被判定为问句的结论', demote: 'journal', reason: '问句（请改写成陈述句）' }]);
    const jc = runOnce(journalStore, journalDir, 'ws-rej-journal', [
        { scope: 'global', content: '被判定为问句的结论', confidence: 'high', kind: 'conclusion', importance: 5 },
    ], NOW + 10);
    const journalRun = await jc.run;
    assert.equal(journalRun.status, 'OK', '降级 JOURNAL 算写成：' + journalRun.reason);
    assert.equal(journalRun.counts.demoted, 1);
    assert.equal(journalRun.counts.failed, 0);
    assert.ok(readFileSync(journalStore.journalPath(), 'utf8').includes('被判定为问句的结论'), '被拒条目要真的补写进 JOURNAL');
    assert.ok(!readFileSync(journalStore.factPath(), 'utf8').includes('被判定为问句的结论'), '被拒条目不许进 FACT');
    assert.equal(readUnconsumed({ pendingDir: jc.runtime.pendingDir, bucket: 'ws-rej-journal' }).length, 0, '写成即消费');
    assert.equal(journalRun.marked.marked, 6);
    const journalLogged = readLastRun({ file: jc.runtime.runLog.path });
    assert.equal(journalLogged.status, 'OK');
    assert.equal(journalLogged.detail, 'demoted:store-rejected:问句（请改写成陈述句）', 'runlog 必须带降级原因');

    /* 3b. drop 拒绝：记 FAILED 带原因，但**不阻塞消费**（否则永久毒行） */
    const dropDir = makeDir('proj-rej-drop');
    const dropStore = storeRejecting(dropDir, [{ text: '被永久拒绝的结论', demote: 'drop', reason: '项目条目缺少工作目录（cwd）' }]);
    const dc = runOnce(dropStore, dropDir, 'ws-rej-drop', [
        { scope: 'global', content: '被永久拒绝的结论', confidence: 'high', kind: 'conclusion', importance: 5 },
    ], NOW + 20);
    const dropRun = await dc.run;
    assert.equal(dropRun.status, 'FAIL', '内容确实少写了一条，不许假装成功');
    assert.equal(dropRun.counts.failed, 1);
    assert.equal(readUnconsumed({ pendingDir: dc.runtime.pendingDir, bucket: 'ws-rej-drop' }).length, 0, '永久拒绝绝不阻塞消费（P0 的核心）');
    assert.equal(dropRun.marked.marked, 6, '6 行都要标记已消费，否则同一批会被无限重跑');
    const dropLogged = readLastRun({ file: dc.runtime.runLog.path });
    assert.equal(dropLogged.status, 'FAIL');
    assert.equal(dropLogged.counts.failed, 1);
    assert.ok(String(dropLogged.detail).includes('writer:store-rejected:项目条目缺少工作目录（cwd）'), 'runlog 必须带 details.reason：' + dropLogged.detail);

    /* 3c. 临时 IO 失败：照旧阻塞消费，下轮重试 */
    const ioDir = makeDir('proj-rej-io');
    const ioStore = memoryStore({ home, projectDir: ioDir, factText: factSeed, memoryText: memorySeed });
    ioStore.insertEntry = async () => {
        const error = new Error('EIO: 磁盘暂时不可写');
        error.code = 'EIO';
        throw error;
    };
    const ic = runOnce(ioStore, ioDir, 'ws-rej-io', [
        { scope: 'global', content: '临时写盘失败的结论要下轮重试', confidence: 'high', kind: 'conclusion', importance: 5 },
    ], NOW + 30);
    const ioRun = await ic.run;
    assert.equal(ioRun.status, 'FAIL');
    assert.equal(ioRun.counts.failed, 1);
    assert.equal(readUnconsumed({ pendingDir: ic.runtime.pendingDir, bucket: 'ws-rej-io' }).length, 6, '临时失败必须挡住消费（下轮重试才有意义）');
    assert.equal(ioRun.marked.marked, 0);
    assert.ok(String(readLastRun({ file: ic.runtime.runLog.path }).detail).includes('writer:EIO'), '临时失败原因也要留痕');

    /* 3d. 混合批次：一条写成 + 一条永久拒绝 ⇒ 消费掉，状态 FAIL（不许假装全成功） */
    const mixDir = makeDir('proj-rej-mix');
    const mixStore = storeRejecting(mixDir, [{ text: '永久毒行不该挡住整批消费', demote: 'drop', reason: '永久拒绝' }]);
    const mc = runOnce(mixStore, mixDir, 'ws-rej-mix', [
        { scope: 'global', content: '交付流程要求先跑一遍三包测试再打包', confidence: 'high', kind: 'conclusion', importance: 4 },
        { scope: 'global', content: '永久毒行不该挡住整批消费', confidence: 'high', kind: 'conclusion', importance: 4 },
    ], NOW + 40);
    const mixRun = await mc.run;
    assert.equal(mixRun.counts.written, 1);
    assert.equal(mixRun.counts.failed, 1);
    assert.equal(mixRun.status, 'FAIL');
    assert.ok(readFileSync(mixStore.factPath(), 'utf8').includes('交付流程要求先跑一遍三包测试再打包'), '正常那条要真的落盘');
    assert.equal(readUnconsumed({ pendingDir: mc.runtime.pendingDir, bucket: 'ws-rej-mix' }).length, 0, '整批照常消费（永久拒绝不拖累其它条目）');
    assert.equal(mixRun.marked.marked, 6);
} finally {
    cleanup();
}

console.log('✓ reject-consume.test.mjs 全部通过');
