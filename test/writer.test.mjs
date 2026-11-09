/**
 * 写入：只调 store、撞限只降级、旧值只进 superseded（00 §4.3 / 02 §7.4）。
 *
 * 跑法：node test/writer.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wouldWritePath } from '../lib/runlog.js';
import { appendSuperseded, createWriter, importanceOf, isBudgetExceeded, WRITE_STATUS } from '../lib/writer.js';
import { NOW, budgetError, fakeStore, makeHome, memoryStore, sha256 } from './_helpers.mjs';

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

    /* ── 15. 影子档（mode=observe）：真判定、真闸口预演，但 FACT/MEMORY/JOURNAL 一字不动 ── */
    const shadowProject = join(home, 'shadow-proj');
    mkdirSync(shadowProject, { recursive: true });
    const shadowStore = memoryStore({
        home,
        projectDir: shadowProject,
        factText: '## 约定\n\n- 旧结论一条\n',
        memoryText: '## 结论\n\n1. 项目旧结论\n',
    });
    const factShaBefore = sha256(shadowStore.factPath());
    const memoryShaBefore = sha256(join(shadowProject, 'MEMORY.md'));
    const journalShaBefore = sha256(shadowStore.journalPath());
    const supersededBefore = existsSync(supersededFile) ? readFileSync(supersededFile, 'utf8').trim().split('\n').length : 0;

    const observeOps = [
        { op: 'ADD', scope: 'global', content: '依赖用 tarball 装', confidence: 'high', ts: 1, layer: 1 },
        { op: 'ADD', scope: 'project', content: '项目里先看 would-write 再开 auto', ts: 2, layer: 1 },
        { op: 'ADD', scope: 'journal', content: '今天换了 node 版本', layer: 1 },
        { op: 'UPDATE', scope: 'global', target: 'abc1234567', content: '改写后的旧结论', ts: 3, layer: 1, superseded: { id: 'abc', text: '旧结论一条' } },
        { op: 'DELETE', scope: 'global', target: 'def4567890', content: '', layer: 2 },
        { op: 'NOOP', scope: 'global', content: '这条已经在记忆里', reason: 'exact' },
        { op: 'ADD', scope: '不认识的 scope', content: '作用域写错时不该写盘', layer: 1 },
    ];
    const shadowed = await createWriter({ store: shadowStore, supersededFile, mode: 'observe' }).apply(
        observeOps,
        { cwd: shadowProject, workspaceId: 'ws-shadow', runId: 'run-shadow-1', now: NOW },
    );

    assert.equal(sha256(shadowStore.factPath()), factShaBefore, 'observe 档 FACT.md 的 SHA256 必须不变');
    assert.equal(sha256(join(shadowProject, 'MEMORY.md')), memoryShaBefore, 'observe 档 MEMORY.md 的 SHA256 必须不变');
    assert.equal(sha256(shadowStore.journalPath()), journalShaBefore, 'observe 档不写真实 JOURNAL');
    assert.equal(shadowed.counts.written, 0, '影子结果绝不算成 written');
    assert.equal(shadowed.counts.replaced, 0);
    assert.equal(shadowed.counts.deleted, 0);
    assert.equal(shadowed.counts.demoted, 0);
    assert.equal(shadowed.counts.observed, observeOps.length, '每个算子都要留一条影子');
    assert.equal(shadowed.counts.failed, 0);
    assert.ok(!shadowStore.calls.some((call) => ['insertEntry', 'replaceEntry', 'deleteEntry', 'appendJournal', 'supersedeJournal'].includes(call.name)), '影子档一个写入方法都不能调');
    assert.ok(shadowStore.calls.some((call) => call.name === 'assertEntry'), 'ADD 必须走闸口预演（否则看不到「本来会撞限」）');
    assert.equal(
        existsSync(supersededFile) ? readFileSync(supersededFile, 'utf8').trim().split('\n').length : 0,
        supersededBefore,
        '影子档不写 superseded.jsonl',
    );

    const shadowFile = wouldWritePath(NOW);
    assert.equal(shadowed.wouldWrite.file, shadowFile);
    assert.equal(shadowed.wouldWrite.lines, observeOps.length);
    assert.equal(shadowed.wouldWrite.failed, 0);
    assert.ok(existsSync(shadowFile), `影子文件必须落盘：${shadowFile}`);
    const shadowLines = readFileSync(shadowFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(shadowLines.length, observeOps.length);
    for (const line of shadowLines) {
        assert.equal(typeof line.ts, 'number');
        assert.equal(line.runId, 'run-shadow-1');
        assert.equal(line.workspaceId, 'ws-shadow');
        assert.equal(typeof line.scope, 'string');
        assert.equal(typeof line.op, 'string');
        assert.equal(typeof line.content, 'string');
        assert.ok(String(line.status).startsWith('would-'), `status 必须是 would-*：${line.status}`);
        assert.equal(typeof line.budget, 'object', '每一行都要带预算预判（拿不到水位时 known:false）');
        assert.equal(typeof line.budget.known, 'boolean');
    }
    const byOp = (op) => shadowLines.find((line) => line.op === op);
    assert.ok(shadowLines.some((line) => line.content === '依赖用 tarball 装'), '影子文件必须含本来要写的正文');
    assert.equal(byOp('ADD').status, WRITE_STATUS.WOULD_WRITTEN);
    assert.equal(byOp('ADD').storeScope, 'fact');
    assert.equal(byOp('ADD').budget.exceeded, false);
    assert.ok(byOp('ADD').budget.predictedChars > 0);
    assert.equal(shadowLines.find((line) => line.scope === 'journal').status, WRITE_STATUS.WOULD_JOURNAL);
    assert.equal(byOp('UPDATE').status, WRITE_STATUS.WOULD_REPLACED);
    assert.equal(byOp('DELETE').status, WRITE_STATUS.WOULD_DELETED);
    assert.equal(byOp('NOOP').status, WRITE_STATUS.WOULD_NOOP);
    assert.equal(byOp('ADD').reason, 'ok');
    const badScope = shadowLines.find((line) => line.scope === '不认识的 scope');
    assert.equal(badScope.status, WRITE_STATUS.WOULD_DROPPED, '作用域不认识 ⇒ 本来就会被丢');
    assert.equal(badScope.reason, 'bad-scope');

    /* 16. 影子档 + 撞限：记 would-demoted（而不是 would-written），且不写 JOURNAL */
    const limitedShadow = memoryStore({ home, projectDir: shadowProject, factText: '## 约定\n\n- 一条\n' });
    limitedShadow.state.budgetExceeded.add('fact');
    const limitedSha = sha256(limitedShadow.factPath());
    const limitedResult = await createWriter({ store: limitedShadow, supersededFile, mode: 'observe' }).apply(
        [{ op: 'ADD', scope: 'global', content: '这条本来会撞限', layer: 1 }],
        { cwd: shadowProject, workspaceId: 'ws-shadow', now: NOW + 1_000 },
    );
    assert.equal(limitedResult.results[0].status, WRITE_STATUS.WOULD_DEMOTED);
    assert.equal(limitedResult.results[0].reason, 'budget-exceeded');
    assert.equal(limitedResult.results[0].budget.exceeded, true);
    assert.equal(sha256(limitedShadow.factPath()), limitedSha, '撞限预演也不能碰文件');
    assert.ok(!limitedShadow.calls.some((call) => call.name === 'appendJournal'), '影子档不降级写 JOURNAL');

    /* 17. 影子文件写不进去 ⇒ FAIL，绝不静默（pipeline 会据此把整次运行标 FAIL） */
    const blocker = join(home, 'blocker-file');
    writeFileSync(blocker, 'x', 'utf8');
    const brokenShadow = await createWriter({
        store: fakeStore().store,
        supersededFile,
        mode: 'observe',
        wouldWriteFile: join(blocker, 'wouldWrite.jsonl'),
    }).apply([OP_ADD], { cwd: 'D:\\proj', now: NOW });
    assert.equal(brokenShadow.results[0].status, WRITE_STATUS.FAILED);
    assert.equal(brokenShadow.results[0].reason, 'would-write-failed');
    assert.equal(brokenShadow.counts.failed, 1, '写不进去必须计入 failed');
    assert.equal(brokenShadow.counts.observed, 0);
    assert.equal(brokenShadow.wouldWrite.failed, 1);

    /* 18. auto 档（以及不传 mode）行为不变：照旧真写 */
    const autoStore = fakeStore();
    const autoResult = await createWriter({ store: autoStore.store, supersededFile, mode: 'auto' }).apply([OP_ADD], { cwd: 'D:\\proj' });
    assert.equal(autoResult.results[0].status, WRITE_STATUS.WRITTEN);
    assert.equal(autoResult.counts.written, 1);
    assert.equal(autoResult.wouldWrite, null, 'auto 档不产出影子');
    assert.ok(autoStore.calls.some((call) => call.name === 'insertEntry'));

    const defaultStore = fakeStore();
    const defaultResult = await createWriter({ store: defaultStore.store, supersededFile }).apply([OP_ADD], { cwd: 'D:\\proj' });
    assert.equal(defaultResult.results[0].status, WRITE_STATUS.WRITTEN, '不传 mode ⇒ 与改造前完全一致');

    /* 19. 显式 dryRun 压过 observe（`/memory-consolidate dry` 只出报告，不落影子文件） */
    const dryWinStore = fakeStore();
    const dryShadow = await createWriter({ store: dryWinStore.store, supersededFile, mode: 'observe' }).apply([OP_ADD], { dryRun: true, now: NOW });
    assert.equal(dryShadow.results[0].status, WRITE_STATUS.DRY, 'dryRun 优先于 observe');
    assert.equal(dryShadow.wouldWrite, null);

    /* ══════════ P0-2：store 的 demoted 是**字符串**，不能按 `=== true` 判 ══════════ */

    /* 20. `{written:false, demoted:'drop'}` ⇒ FAILED（带 store 的 reason），绝不算 written */
    const rejectStore = fakeStore({
        async insertEntry(scope, entry) {
            rejectStore.calls.push({ name: 'insertEntry', args: [scope, entry] });
            return { written: false, demoted: 'drop', reason: '行内代码 3 处（>2）' };
        },
    });
    const rejected = await createWriter({ store: rejectStore.store, supersededFile }).apply([OP_ADD], { cwd: 'D:\\proj' });
    assert.equal(rejected.results[0].status, WRITE_STATUS.FAILED, '被拒条目绝不许记成 written');
    assert.equal(rejected.counts.written, 0, 'counts.written 必须是 0（否则 pipeline 会消费掉回合）');
    assert.equal(rejected.counts.failed, 1);
    assert.ok(rejected.results[0].reason.includes('行内代码'), `reason 要带 store 给的原因：${rejected.results[0].reason}`);
    assert.ok(!rejectStore.calls.some((call) => call.name === 'appendJournal'), 'demoted:drop 不写 JOURNAL');

    /* 21. `{written:false, demoted:'journal'}` ⇒ 补写一次 JOURNAL、记 DEMOTED、不算 failed */
    const journalDemoteStore = fakeStore({
        async insertEntry(scope, entry) {
            journalDemoteStore.calls.push({ name: 'insertEntry', args: [scope, entry] });
            return { written: false, demoted: 'journal', reason: '问句（请改写成陈述句）' };
        },
    });
    const journalDemoted = await createWriter({ store: journalDemoteStore.store, supersededFile }).apply([OP_ADD], { cwd: 'D:\\proj' });
    assert.equal(journalDemoted.results[0].status, WRITE_STATUS.DEMOTED, '字符串 journal 也算降级');
    assert.equal(journalDemoted.counts.demoted, 1);
    assert.equal(journalDemoted.counts.failed, 0, '降级进 JOURNAL 属于写成了（行可以消费）');
    assert.equal(journalDemoted.counts.written, 0, '没进 FACT 就不许记 written');
    const journalCalls = journalDemoteStore.calls.filter((call) => call.name === 'appendJournal');
    assert.equal(journalCalls.length, 1, '字符串 journal 必须真的写一次 JOURNAL');
    assert.equal(journalCalls[0].args[0], OP_ADD.content, 'JOURNAL 里写的是本条正文');

    /* 22. `{written:false}` 且**没有** demoted 字段 ⇒ FAILED，reason 带 store 的 reason */
    const silentStore = fakeStore({
        async insertEntry(scope, entry) {
            silentStore.calls.push({ name: 'insertEntry', args: [scope, entry] });
            return { written: false, reason: 'no-project-memory' };
        },
    });
    const silent = await createWriter({ store: silentStore.store, supersededFile }).apply([OP_ADD], { cwd: 'D:\\proj' });
    assert.equal(silent.results[0].status, WRITE_STATUS.FAILED, '没写成就不是成功');
    assert.equal(silent.counts.written, 0);
    assert.equal(silent.results[0].reason, 'store-not-written:no-project-memory');

    /* 23. UPDATE 被降级成 journal：不再误判 not-found 降级 ADD（P0-2 分支 2） */
    const updateDemoted = fakeStore({
        async replaceEntry(scope, id, entry, options) {
            updateDemoted.calls.push({ name: 'replaceEntry', args: [scope, id, entry, options] });
            return { written: false, demoted: 'journal', reason: '过程词「然后」' };
        },
    });
    const updatedDemoted = await createWriter({ store: updateDemoted.store, supersededFile }).apply([OP_UPDATE], { cwd: 'D:\\proj' });
    assert.equal(updatedDemoted.results[0].status, WRITE_STATUS.DEMOTED);
    assert.ok(!updateDemoted.calls.some((call) => call.name === 'insertEntry'), '降级不是 not-found，绝不许再走 ADD');
    assert.equal(updateDemoted.calls.filter((call) => call.name === 'appendJournal').length, 1);
    assert.equal(updatedDemoted.counts.failed, 0);

    /* 24. 普通异常也要带真实原因（不再只有 'error'） */
    const codedStore = fakeStore({
        async insertEntry() {
            const error = new Error('锁超时');
            error.code = 'MEMORY_LOCK_TIMEOUT';
            throw error;
        },
    });
    const coded = await createWriter({ store: codedStore.store, supersededFile }).apply([OP_ADD], { cwd: 'D:\\proj' });
    assert.equal(coded.results[0].status, WRITE_STATUS.FAILED);
    assert.equal(coded.results[0].reason, 'MEMORY_LOCK_TIMEOUT', '错误码要落进 reason（排查靠它）');

    /* ══════════ DESIGN §6：UPDATE 两段式失效（先新增，成功后才标记旧的失效） ══════════ */

    /* 25. 成功路径：insertEntry 先于 supersedeEntry，by = 新条目 contentId */
    const twoPhase = fakeStore({
        // 主插件 `insertEntry` 回的是「带 firstSeen 的索引 id」，契约要的 `by` 是 contentId。
        entryId: (ts, text) => `content${String(text).length}`, // 故意与下面的 inserted.id 不同
        async insertEntry(scope, entry, options) {
            twoPhase.calls.push({ name: 'insertEntry', args: [scope, entry, options] });
            return { written: true, id: 'new1234567', target: 'D:\\fact' };
        },
        async supersedeEntry(scope, target, options) {
            twoPhase.calls.push({ name: 'supersedeEntry', args: [scope, target, options] });
            return { ok: true, path: 'D:\\fact', entry: { text: 'old' }, revision: 'r1' };
        },
    });
    const supersededCountBefore = existsSync(supersededFile) ? readFileSync(supersededFile, 'utf8').trim().split('\n').length : 0;
    const twoPhaseResult = await createWriter({ store: twoPhase.store, supersededFile, supersedeOnUpdate: true }).apply(
        [OP_UPDATE],
        { cwd: 'D:\\proj', workspaceId: 'ws-1', now: NOW + 5 },
    );
    assert.equal(twoPhaseResult.results[0].status, WRITE_STATUS.REPLACED, '两段式属于「已替换」语义');
    assert.equal(twoPhaseResult.results[0].reason, 'supersede');
    assert.equal(twoPhaseResult.counts.replaced, 1);
    assert.equal(twoPhaseResult.counts.written, 0);
    assert.equal(twoPhaseResult.counts.failed, 0);
    const insertIndex = twoPhase.calls.findIndex((call) => call.name === 'insertEntry');
    const supersedeIndex = twoPhase.calls.findIndex((call) => call.name === 'supersedeEntry');
    assert.ok(insertIndex >= 0 && supersedeIndex > insertIndex, '必须先写新条目，再给旧条目打失效标记');
    const supersedeCall = twoPhase.calls[supersedeIndex];
    assert.equal(supersedeCall.args[0], 'fact', 'scope 映射成 store 的 fact');
    assert.deepEqual(supersedeCall.args[1], { id: OP_UPDATE.target }, 'target 是旧条目 id（不猜）');
    assert.equal(supersedeCall.args[2].by, `content${OP_UPDATE.content.length}`, 'by 必须是新条目的 contentId（不是索引 id）');
    assert.equal(supersedeCall.args[2].at, NOW + 5, 'at 用本次写入时间');
    assert.equal(supersedeCall.args[2].cwd, 'D:\\proj');
    assert.ok(!twoPhase.calls.some((call) => call.name === 'replaceEntry'), '两段式成功就不该再原子替换');
    const supersededCountAfter = readFileSync(supersededFile, 'utf8').trim().split('\n').length;
    assert.ok(supersededCountAfter > supersededCountBefore, '旧值仍要进 superseded.jsonl（审计）');

    /* 26. 新旧正文相同 ⇒ 不值得「新增 + 失效」，走原子替换 */
    const sameText = fakeStore({
        async supersedeEntry(scope, target, options) {
            sameText.calls.push({ name: 'supersedeEntry', args: [scope, target, options] });
            return { ok: true };
        },
    });
    const sameResult = await createWriter({ store: sameText.store, supersededFile }).apply(
        [{ ...OP_UPDATE, content: OP_UPDATE.superseded.text }],
        { cwd: 'D:\\proj', now: NOW },
    );
    assert.equal(sameResult.results[0].status, WRITE_STATUS.REPLACED);
    assert.ok(sameText.calls.some((call) => call.name === 'replaceEntry'), '正文没变就只替换');
    assert.ok(!sameText.calls.some((call) => call.name === 'supersedeEntry'), '正文没变不该多写一条再失效一条');

    /* 27. 新条目没写成（written:false）⇒ 回退 replaceEntry，且绝不标记旧的失效 */
    const rejectedInsert = fakeStore({
        async insertEntry(scope, entry, options) {
            rejectedInsert.calls.push({ name: 'insertEntry', args: [scope, entry, options] });
            return { written: false, reason: 'template-rejected' };
        },
        async supersedeEntry(scope, target, options) {
            rejectedInsert.calls.push({ name: 'supersedeEntry', args: [scope, target, options] });
            return { ok: true };
        },
    });
    const fallbackResult = await createWriter({ store: rejectedInsert.store, supersededFile }).apply([OP_UPDATE], { cwd: 'D:\\proj' });
    assert.equal(fallbackResult.results[0].status, WRITE_STATUS.REPLACED, '回退替换成功 ⇒ 记 replaced');
    assert.equal(fallbackResult.counts.failed, 0);
    assert.ok(rejectedInsert.calls.some((call) => call.name === 'replaceEntry'), '写不进新条目 ⇒ 回退原子替换');
    assert.ok(!rejectedInsert.calls.some((call) => call.name === 'supersedeEntry'), '新条目没写进去，旧的绝不能标记失效');

    /* 28. 新条目被降级写 JOURNAL（demoted:'journal'）⇒ 记 DEMOTED，不再 replace（避免重复写 JOURNAL） */
    const journalInsert = fakeStore({
        async insertEntry(scope, entry, options) {
            journalInsert.calls.push({ name: 'insertEntry', args: [scope, entry, options] });
            return { written: false, demoted: 'journal', reason: '问句（请改写成陈述句）' };
        },
        async supersedeEntry(scope, target, options) {
            journalInsert.calls.push({ name: 'supersedeEntry', args: [scope, target, options] });
            return { ok: true };
        },
    });
    const journalInsertResult = await createWriter({ store: journalInsert.store, supersededFile }).apply([OP_UPDATE], { cwd: 'D:\\proj' });
    assert.equal(journalInsertResult.results[0].status, WRITE_STATUS.DEMOTED);
    assert.equal(journalInsertResult.counts.failed, 0);
    assert.equal(journalInsert.calls.filter((call) => call.name === 'appendJournal').length, 1, '只写一次 JOURNAL');
    assert.ok(!journalInsert.calls.some((call) => call.name === 'replaceEntry'), '已降级写 JOURNAL，再替换会重复写');
    assert.ok(!journalInsert.calls.some((call) => call.name === 'supersedeEntry'), '旧条目不许标记失效');

    /* 29. 第二步失败（supersede 返回 ok:false）⇒ 回退替换；刚多写的那条尽力撤掉 */
    const supersedeRefused = fakeStore({
        async insertEntry(scope, entry, options) {
            supersedeRefused.calls.push({ name: 'insertEntry', args: [scope, entry, options] });
            return { written: true, id: 'new9999999' };
        },
        async supersedeEntry(scope, target, options) {
            supersedeRefused.calls.push({ name: 'supersedeEntry', args: [scope, target, options] });
            return { ok: false, reason: 'not-found' };
        },
    });
    const refusedResult = await createWriter({ store: supersedeRefused.store, supersededFile }).apply([OP_UPDATE], { cwd: 'D:\\proj' });
    assert.equal(refusedResult.results[0].status, WRITE_STATUS.REPLACED, '回退替换成功 ⇒ 结果仍是 replaced');
    assert.equal(refusedResult.results[0].reason, 'supersede-fallback:not-found', '回退原因要能看见');
    assert.ok(supersedeRefused.calls.some((call) => call.name === 'replaceEntry'), '第二步失败必须回退原子替换');
    const cleanupCall = supersedeRefused.calls.find((call) => call.name === 'deleteEntry');
    assert.ok(cleanupCall !== undefined, '替换成功后要把多写的那条撤掉（尽力而为）');
    assert.deepEqual(cleanupCall.args, ['fact', 'new9999999']);

    /* 30. 两步都失败 ⇒ 记 FAILED，且仍不标记旧条目失效（内容已写进文件，不算丢） */
    const bothBroken = fakeStore({
        async insertEntry(scope, entry, options) {
            bothBroken.calls.push({ name: 'insertEntry', args: [scope, entry, options] });
            return { written: true, id: 'new0000000' };
        },
        async supersedeEntry() {
            const error = new Error('supersede 锁超时');
            error.code = 'MEMORY_LOCK_TIMEOUT';
            throw error;
        },
        async replaceEntry() {
            throw new Error('磁盘只读');
        },
    });
    const bothBrokenResult = await createWriter({ store: bothBroken.store, supersededFile }).apply([OP_UPDATE], { cwd: 'D:\\proj' });
    assert.equal(bothBrokenResult.results[0].status, WRITE_STATUS.FAILED);
    assert.ok(String(bothBrokenResult.results[0].reason).startsWith('supersede-failed:MEMORY_LOCK_TIMEOUT'), bothBrokenResult.results[0].reason);
    assert.equal(bothBrokenResult.counts.failed, 1);
    assert.ok(!bothBroken.calls.some((call) => call.name === 'deleteEntry'), '替换都没成功，不许先撤掉新条目');

    /* 31. 开关关掉（supersedeOnUpdate:false）⇒ 即便 store 支持也走原子替换 */
    const switchOff = fakeStore({
        async supersedeEntry(scope, target, options) {
            switchOff.calls.push({ name: 'supersedeEntry', args: [scope, target, options] });
            return { ok: true };
        },
    });
    const switchOffResult = await createWriter({ store: switchOff.store, supersededFile, supersedeOnUpdate: false }).apply([OP_UPDATE], { cwd: 'D:\\proj' });
    assert.equal(switchOffResult.results[0].status, WRITE_STATUS.REPLACED);
    assert.ok(switchOff.calls.some((call) => call.name === 'replaceEntry'));
    assert.ok(!switchOff.calls.some((call) => call.name === 'insertEntry'), '开关关掉不许走两段式');
    assert.ok(!switchOff.calls.some((call) => call.name === 'supersedeEntry'));

    /* 32. 拿不到旧正文（op.superseded 缺失）⇒ 不猜，走原子替换 */
    const noOldText = fakeStore({
        async supersedeEntry(scope, target, options) {
            noOldText.calls.push({ name: 'supersedeEntry', args: [scope, target, options] });
            return { ok: true };
        },
    });
    const noOldResult = await createWriter({ store: noOldText.store, supersededFile }).apply(
        [{ op: 'UPDATE', scope: 'global', target: 'abc1234567', content: '改写后的正文', ts: 1, layer: 1 }],
        { cwd: 'D:\\proj' },
    );
    assert.equal(noOldResult.results[0].status, WRITE_STATUS.REPLACED);
    assert.ok(noOldText.calls.some((call) => call.name === 'replaceEntry'), '无法证明新旧不同 ⇒ 保守替换');
    assert.ok(!noOldText.calls.some((call) => call.name === 'supersedeEntry'));

    /* 33. 闸口在第一步就撞限 ⇒ 降级 JOURNAL，insert / supersede / replace 一个都不试 */
    let supersedeInsertTried = 0;
    const limitedTwoPhase = fakeStore({
        async assertEntry() {
            throw budgetError();
        },
        async insertEntry() {
            supersedeInsertTried += 1;
        },
        async supersedeEntry(scope, target, options) {
            limitedTwoPhase.calls.push({ name: 'supersedeEntry', args: [scope, target, options] });
            return { ok: true };
        },
    });
    const limitedTwoPhaseResult = await createWriter({ store: limitedTwoPhase.store, supersededFile }).apply([OP_UPDATE], { cwd: 'D:\\proj' });
    assert.equal(limitedTwoPhaseResult.results[0].status, WRITE_STATUS.DEMOTED);
    assert.equal(supersedeInsertTried, 0, '闸口说满就别插');
    assert.ok(!limitedTwoPhase.calls.some((call) => call.name === 'supersedeEntry'), '撞限时旧条目绝不能标记失效');

    /* ══════════ DESIGN v3 §14.3：importance 交给主插件（老 store 忽略，行为不变） ══════════ */

    /* 34. 1–5 → 20/35/50/70/90 线性映射；非法 / 缺失 ⇒ 50 */
    assert.deepEqual([1, 2, 3, 4, 5].map((level) => importanceOf({ importance: level })), [20, 35, 50, 70, 90]);
    assert.equal(importanceOf({}), 50, '缺失 ⇒ 50（索引缺省档）');
    assert.equal(importanceOf(null), 50);
    assert.equal(importanceOf({ importance: '不是数字' }), 50);
    assert.equal(importanceOf({ importance: Number.NaN }), 50);
    assert.equal(importanceOf({ importance: 9 }), 90, '越界收敛到 5 档');
    assert.equal(importanceOf({ importance: 0 }), 20, '越界收敛到 1 档');
    assert.equal(importanceOf({ importance: '4' }), 70, '数字字符串也认');

    /* 35. ADD / UPDATE 都把 importance 写进 entry（且仍然不带 content 字段） */
    const importanceStore = fakeStore();
    const importanceWriter = createWriter({ store: importanceStore.store, supersededFile });
    const importanceResult = await importanceWriter.apply(
        [
            { op: 'ADD', scope: 'global', content: '核心约定：改 lib 后必须重启引擎', confidence: 'high', importance: 5, ts: 1, layer: 1 },
            { op: 'UPDATE', scope: 'project', target: 'abc1234567', content: '改写后的项目结论', confidence: 'medium', importance: 2, ts: 2, layer: 1, superseded: { id: 'abc1234567', text: '旧的项目结论' } },
        ],
        { cwd: 'D:\\proj' },
    );
    assert.equal(importanceResult.counts.written, 1);
    assert.equal(importanceResult.counts.replaced, 1);
    const importanceInsert = importanceStore.calls.find((call) => call.name === 'insertEntry').args[1];
    assert.equal(importanceInsert.importance, 90, 'ADD 的 importance 要交给 store.insertEntry');
    assert.equal(importanceInsert.content, undefined, 'entry 里不许出现 content（主插件只认 text）');
    const importanceReplace = importanceStore.calls.find((call) => call.name === 'replaceEntry').args[2];
    assert.equal(importanceReplace.importance, 35, 'UPDATE 的 importance 也要带过去');
    assert.equal(importanceReplace.text, '改写后的项目结论');

    /* 36. store 有 touchEntries：NOOP（有 target）与成功的 UPDATE 都要回写访问；失败静默 */
    const touchable = fakeStore({
        async touchEntries(targets, options) {
            touchable.calls.push({ name: 'touchEntries', args: [targets, options] });
            return { touched: targets.length };
        },
    });
    const touchWriter = createWriter({ store: touchable.store, supersededFile });
    const touched = await touchWriter.apply(
        [
            { op: 'NOOP', scope: 'global', target: 'noop123456', content: '已有结论', reason: 'exact' },
            { op: 'UPDATE', scope: 'global', target: 'upd1234567', content: '改写后的正文', confidence: 'high', ts: 1, layer: 1, superseded: { id: 'upd1234567', text: '旧正文' } },
            { op: 'ADD', scope: 'global', content: '全新结论一条', confidence: 'high', ts: 2, layer: 1 },
        ],
        { cwd: 'D:\\proj' },
    );
    assert.equal(touched.counts.noop, 1);
    assert.equal(touched.counts.replaced, 1);
    assert.equal(touched.counts.written, 1);
    assert.equal(touched.counts.failed, 0, '访问回写绝不影响本轮结果');
    const touchCalls = touchable.calls.filter((call) => call.name === 'touchEntries');
    assert.equal(touchCalls.length, 2, 'NOOP + UPDATE 各回写一次（ADD 不回写）');
    assert.deepEqual(touchCalls[0].args[0], [{ scope: 'fact', id: 'noop123456' }], 'scope 用 store 词汇，id 用 op.target');
    assert.deepEqual(touchCalls[1].args[0], [{ scope: 'fact', id: 'upd1234567' }]);

    /* 37. 回写抛错也静默：状态仍是 NOOP / REPLACED，绝不判 FAIL */
    const angryTouch = fakeStore({
        async touchEntries() {
            throw new Error('index.json 写不进去');
        },
    });
    const angryWriter = createWriter({ store: angryTouch.store, supersededFile });
    const angryResult = await angryWriter.apply(
        [
            { op: 'NOOP', scope: 'project', target: 'noop999999', content: '已有结论', reason: 'near-duplicate' },
            { op: 'UPDATE', scope: 'project', target: 'upd9999999', content: '改写后的正文', ts: 1, layer: 1, superseded: { id: 'upd9999999', text: '旧正文' } },
        ],
        { cwd: 'D:\\proj' },
    );
    assert.equal(angryResult.counts.failed, 0, '索引回写失败绝不能让整轮 FAIL');
    assert.equal(angryResult.counts.noop, 1);
    assert.equal(angryResult.counts.replaced, 1);

    /* 38. dryRun 不回写（干跑的承诺是一个字节都不落盘） */
    const dryTouch = fakeStore({
        async touchEntries(targets) {
            dryTouch.calls.push({ name: 'touchEntries', args: [targets] });
            return { touched: 1 };
        },
    });
    const dryTouchResult = await createWriter({ store: dryTouch.store, supersededFile }).apply(
        [{ op: 'NOOP', scope: 'global', target: 'noop123456', content: '已有结论', reason: 'exact' }],
        { dryRun: true },
    );
    assert.equal(dryTouchResult.counts.noop, 1);
    assert.ok(!dryTouch.calls.some((call) => call.name === 'touchEntries'), 'dryRun 下不回写索引');

    /* 39. 没有 target 的 NOOP（例如 empty-content）不回写、不炸 */
    const noTargetTouch = fakeStore({
        async touchEntries(targets) {
            noTargetTouch.calls.push({ name: 'touchEntries', args: [targets] });
            return { touched: 0 };
        },
    });
    const noTargetResult = await createWriter({ store: noTargetTouch.store, supersededFile }).apply(
        [{ op: 'NOOP', scope: 'global', content: '空正文', reason: 'empty-content' }],
        {},
    );
    assert.equal(noTargetResult.results[0].status, WRITE_STATUS.NOOP);
    assert.ok(!noTargetTouch.calls.some((call) => call.name === 'touchEntries'));

    /* 40. store 没有 touchEntries（主插件 < 0.11 / 老 store）⇒ 与升级前完全一样，不报错 */
    const legacy = fakeStore();
    const legacyResult = await createWriter({ store: legacy.store, supersededFile }).apply(
        [
            { op: 'NOOP', scope: 'global', target: 'noop123456', content: '已有结论', reason: 'exact' },
            { op: 'UPDATE', scope: 'global', target: 'upd1234567', content: '改写后的正文', ts: 1, layer: 1, superseded: { id: 'upd1234567', text: '旧正文' } },
        ],
        { cwd: 'D:\\proj' },
    );
    assert.equal(legacyResult.counts.noop, 1);
    assert.equal(legacyResult.counts.replaced, 1);
    assert.equal(legacyResult.counts.failed, 0);
    assert.ok(!legacyResult.results.some((item) => item.reason?.includes('touch')), '没有新 API 时不做任何额外动作');

} finally {
    cleanup();
}

console.log('✓ writer.test.mjs 全部通过');
