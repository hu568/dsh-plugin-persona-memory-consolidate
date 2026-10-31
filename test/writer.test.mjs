/**
 * 写入：只调 store、撞限只降级、旧值只进 superseded（00 §4.3 / 02 §7.4）。
 *
 * 跑法：node test/writer.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendSuperseded, createWriter, isBudgetExceeded, WRITE_STATUS } from '../lib/writer.js';
import { budgetError, fakeStore, makeHome } from './_helpers.mjs';

const { home, cleanup } = makeHome('pmc-writer');

try {
    const supersededFile = join(home, 'consolidate', 'superseded.jsonl');
    const OP_ADD = { op: 'ADD', scope: 'global', content: '依赖用 tarball 装', confidence: 'high', ts: 1_000, layer: 1 };
    const OP_UPDATE = {
        op: 'UPDATE',
        scope: 'global',
        target: 'abc1234567',
        content: '依赖用 tarball 装，不要 pnpm install',
        confidence: 'high',
        ts: 2_000,
        layer: 1,
        superseded: { id: 'abc1234567', text: '依赖用 tarball 装，不用 pnpm install' },
    };

    /* 1. ADD → insertEntry（scope 映射成 store 的 fact） */
    const add = fakeStore();
    const writer = createWriter({ store: add.store, supersededFile });
    const added = await writer.apply([OP_ADD], { cwd: 'D:\\proj', workspaceId: 'ws-1' });
    assert.equal(added.results[0].status, WRITE_STATUS.WRITTEN);
    assert.equal(added.counts.written, 1);
    const insertCall = add.calls.find((call) => call.name === 'insertEntry');
    assert.equal(insertCall.args[0], 'fact', 'global → fact');
    assert.equal(insertCall.args[1].text, '依赖用 tarball 装', 'store 只认 entry.text（A0 传的是 content ⇒ 写入静默落空）');
    assert.equal(typeof insertCall.args[1].text, 'string');
    assert.ok(insertCall.args[1].text.length > 0, 'text 不能是空串');
    assert.equal(insertCall.args[1].content, undefined, '不许再带 content 字段（防止两边继续各写一套）');
    assert.equal(insertCall.args[2].cwd, 'D:\\proj');
    assert.ok(add.calls.some((call) => call.name === 'assertEntry'), '应先用闸口薄包装探一下');
    assert.ok(added.watermarks.fact.lines > 0, '水位应被读出来');

    /* 2. UPDATE → replaceEntry + superseded 落盘 */
    const update = fakeStore();
    const updater = createWriter({ store: update.store, supersededFile });
    const updated = await updater.apply([OP_UPDATE], { cwd: 'D:\\proj', workspaceId: 'ws-1' });
    assert.equal(updated.results[0].status, WRITE_STATUS.REPLACED);
    assert.ok(update.calls.some((call) => call.name === 'replaceEntry'));
    assert.ok(existsSync(supersededFile), '被覆盖的旧值必须写 superseded.jsonl');
    const supersededLines = readFileSync(supersededFile, 'utf8').trim().split('\n');
    const superseded = JSON.parse(supersededLines[supersededLines.length - 1]);
    assert.equal(superseded.old, '依赖用 tarball 装，不用 pnpm install');
    assert.equal(superseded.new, '依赖用 tarball 装，不要 pnpm install');
    assert.equal(superseded.workspaceId, 'ws-1');
    assert.equal(superseded.reason, 'update');

    /* superseded 不该被当成 JOURNAL（不写 JOURNAL，也不进 recall 检索） */
    assert.ok(!update.calls.some((call) => call.name === 'appendJournal'), '旧值绝不降级写 JOURNAL');

    /* 3. UPDATE 目标没了 → 降级 ADD */
    const missing = fakeStore({
        async replaceEntry() {
            missing.calls.push({ name: 'replaceEntry', args: [] });
            return { written: false, reason: 'not-found' };
        },
    });
    const fallback = await createWriter({ store: missing.store, supersededFile }).apply([OP_UPDATE], { cwd: 'D:\\proj' });
    assert.equal(fallback.results[0].status, WRITE_STATUS.WRITTEN);
    assert.equal(fallback.results[0].reason, 'replace-not-found');
    assert.ok(missing.calls.some((call) => call.name === 'insertEntry'), '找不到就降级插入');

    /* 4. DELETE（第二层） */
    const del = fakeStore();
    const deleted = await createWriter({ store: del.store, supersededFile }).apply(
        [{ op: 'DELETE', scope: 'global', target: 'abc1234567', content: '', layer: 2, superseded: { id: 'abc', text: '旧条目' } }],
        { cwd: 'D:\\proj' },
    );
    assert.equal(deleted.results[0].status, WRITE_STATUS.DELETED);
    assert.ok(del.calls.some((call) => call.name === 'deleteEntry'));

    /* 5. 撞限：insertEntry 抛 MEMORY_BUDGET_EXCEEDED → 降级 JOURNAL，且不重试 */
    let insertAttempts = 0;
    const budgetLimited = fakeStore({
        async assertEntry() {
            /* 放行闸口，专测 insert 抛错的路径 */
        },
        async insertEntry() {
            insertAttempts += 1;
            throw budgetError();
        },
    });
    const demoted = await createWriter({ store: budgetLimited.store, supersededFile }).apply([OP_ADD], { cwd: 'D:\\proj' });
    assert.equal(demoted.results[0].status, WRITE_STATUS.DEMOTED);
    assert.equal(demoted.results[0].reason, 'budget-exceeded');
    assert.equal(insertAttempts, 1, '撞限不重试');
    assert.ok(budgetLimited.calls.some((call) => call.name === 'appendJournal'), '降级路径必须写 JOURNAL');
    const journalCall = budgetLimited.calls.find((call) => call.name === 'appendJournal');
    assert.deepEqual(journalCall.args[1], ['consolidate', 'demoted']);

    /* 6. 撞限在闸口就发生 → 连 insert 都不试 */
    let insertTried = 0;
    const gateLimited = fakeStore({
        async assertEntry() {
            throw budgetError();
        },
        async insertEntry() {
            insertTried += 1;
            return { written: true };
        },
    });
    const gateResult = await createWriter({ store: gateLimited.store, supersededFile }).apply([OP_ADD], { cwd: 'D:\\proj' });
    assert.equal(gateResult.results[0].status, WRITE_STATUS.DEMOTED);
    assert.equal(insertTried, 0, '闸口说满就别再插入');

    /* 7. store 不可用 → drop（不假装成功，也不自己 fs 写） */
    const dropped = await createWriter({ store: null, resolveStore: async () => null, supersededFile }).apply([OP_ADD], {});
    assert.equal(dropped.results[0].status, WRITE_STATUS.DROPPED);
    assert.equal(dropped.results[0].reason, 'store-unavailable');

    /* 8. dryRun：什么 store 方法都不该被调（水位除外） */
    const dryStore = fakeStore();
    const dry = await createWriter({ store: dryStore.store, supersededFile }).apply([OP_ADD, OP_UPDATE], { dryRun: true });
    assert.equal(dry.counts.dry, 2);
    assert.ok(!dryStore.calls.some((call) => ['insertEntry', 'replaceEntry', 'deleteEntry', 'appendJournal'].includes(call.name)));

    /* 9. NOOP 不碰 store */
    const noop = fakeStore();
    const noopResult = await createWriter({ store: noop.store, supersededFile }).apply([{ op: 'NOOP', scope: 'global', content: '已有结论', reason: 'exact' }], {});
    assert.equal(noopResult.results[0].status, WRITE_STATUS.NOOP);
    assert.equal(noop.calls.filter((call) => call.name !== 'watermark').length, 0);

    /* 10. journal scope 直接进 JOURNAL，不进 FACT/MEMORY */
    const journalScope = fakeStore();
    const journalResult = await createWriter({ store: journalScope.store, supersededFile }).apply(
        [{ op: 'ADD', scope: 'journal', content: '今天换了 node 版本', layer: 1 }],
        { cwd: 'D:\\proj' },
    );
    assert.equal(journalResult.results[0].status, WRITE_STATUS.WRITTEN);
    assert.equal(journalResult.results[0].reason, 'journal');
    assert.ok(!journalScope.calls.some((call) => call.name === 'insertEntry'));

    /* 11. 其它错误 → FAIL（交给预算层算退避，本模块不重试） */
    let brokenAttempts = 0;
    const broken = fakeStore({
        async insertEntry() {
            brokenAttempts += 1;
            throw new Error('磁盘只读');
        },
    });
    const failed = await createWriter({ store: broken.store, supersededFile }).apply([OP_ADD], {});
    assert.equal(failed.results[0].status, WRITE_STATUS.FAILED);
    assert.equal(brokenAttempts, 1);

    /* 12. 撞限识别（只认 code / name，不做模糊猜测，但兼容消息里带错误码） */
    assert.equal(isBudgetExceeded(budgetError()), true);
    assert.equal(isBudgetExceeded(Object.assign(new Error('x'), { code: 'OTHER' })), false);
    assert.equal(isBudgetExceeded(null), false);
    assert.equal(isBudgetExceeded(new Error('写入被 MEMORY_BUDGET_EXCEEDED 拒绝')), true);

    /* 13. superseded 永不含密文 */
    appendSuperseded({ old: 'api_key: abcdef123456', new: 'api_key: zzzzzz999999', scope: 'fact', reason: 'update' }, { file: supersededFile });
    const lastLine = readFileSync(supersededFile, 'utf8').trim().split('\n').pop();
    assert.ok(!lastLine.includes('abcdef123456'), '旧值里的密钥必须被打码');
    assert.ok(lastLine.includes('⟨redacted⟩'));

    /* 14. ADD 真的抵达 store 且带**非空 text**（主插件 `insertEntry` 只读 entry.text，
     *     A0 传 content 会被 `normalizeEntryInput` 当成空条目 ⇒ 写入静默落空） */
    const strictStore = fakeStore({
        async insertEntry(scope, entry) {
            strictStore.calls.push({ name: 'insertEntry', args: [scope, entry] });
            const text = typeof entry?.text === 'string' ? entry.text.trim() : '';
            // 与主插件 store.js 的 validateEntry 同款行为：空条目 ⇒ written:false + demoted:'drop'
            return text === '' ? { written: false, demoted: 'drop', reason: '条目为空' } : { written: true, id: 'i1' };
        },
    });
    const strictResult = await createWriter({ store: strictStore.store, supersededFile }).apply([OP_ADD], { cwd: 'D:\\proj' });
    assert.equal(strictResult.results[0].status, WRITE_STATUS.WRITTEN, 'ADD 必须真的写进去');
    assert.equal(strictResult.results[0].reason, 'ok');
    assert.equal(strictStore.calls.find((call) => call.name === 'insertEntry').args[1].text, '依赖用 tarball 装');
} finally {
    cleanup();
}

console.log('✓ writer.test.mjs 全部通过');
