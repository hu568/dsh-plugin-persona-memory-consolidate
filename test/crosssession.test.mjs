/**
 * 第二层（L2）跨会话整理（M4）：一次 LLM 调用同时产出升格 + JOURNAL 失效。
 *
 * 钉住的十一条（02 §7.6 / §7.3.4 / §9 M4）：
 *  1. 频次升格：同一结论出现在两个会话 → **一条** FACT 条目；
 *  2. 矛盾 ⇒ `supersedeJournal` 只收到 **id 与理由**，一个正文字都没有；
 *  3. 逐桶运行的 `project` 只能落在**本桶**（cwd = 该工作区路径）；
 *  4. 跨桶运行只产出 `global`（`project` 一律跳过）；
 *  5. `_unassigned` 桶绝不产出 `project`；
 *  6. 每次最多失效 **20 条**，超出的留到下一轮；
 *  7. `demoted` 条目只在目标文件水位 < 85% 时才允许升格；
 *  8. `dryRun` 一个字节都不写、游标不动；
 *  9. 调用失败 / 非法 JSON ⇒ 游标不动（下次重跑）；
 * 10. 预算走 `layer2` 阶段（每天 10 次），额度用尽就 SKIPPED；
 * 11. prompt 必须带现行 FACT、现行 MEMORY、带 id 的编号素材。
 *
 * 全部用例：临时 `DSH_HOME` + 注入的假 store / 假素材源 / 假模型，不触网。
 *
 * 跑法：node test/crosssession.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createBudget } from '../lib/budget.js';
import {
    MAX_SUPERSEDE,
    allowedScopes,
    buildCrossPrompt,
    countConsumedEntries,
    countOccurrences,
    mergePromotions,
    parseCrossResponse,
    promotionConflict,
    readCrossCursor,
    runL2,
    runL2All,
    watermarkRatio,
    writeCrossCursor,
} from '../lib/crosssession.js';
import { consolidateDir } from '../lib/cursor.js';
import { appendRow } from '../lib/pending.js';
import { wouldWritePath } from '../lib/runlog.js';
import { NOW, fakeStore, makeHome, makeRuntime, memoryStore, sha256 } from './_helpers.mjs';

const { home, cleanup } = makeHome('pmc-cross-run');

/** 假模型：记下每次 prompt，按给定 JSON 回答。 */
function crossModel(reply) {
    const calls = [];
    const model = async (request) => {
        calls.push(String(request?.prompt ?? ''));
        return typeof reply === 'function' ? reply(request, calls.length) : reply;
    };
    model.calls = calls;
    return model;
}

/** 造一个只走「假素材源」的 runtime（素材直接给，不读盘）。 */
let runtimeSeq = 0;
function crossRuntime({ store, model, entries = [], config = {}, registry = { workspaces: {} }, budget } = {}) {
    const runtime = makeRuntime({ store, model, config, registry, budget });
    runtimeSeq += 1;
    // 每个用例一份独立的 L2 游标：否则前一个用例推进的 `lastRunAt` 会把后面
    // 「干跑不推游标」「失败不推游标」两条断言搅乱。
    runtime.crossCursorFile = join(home, `cross-cursor-${runtimeSeq}.json`);
    runtime.crossChain = {
        chain: ['journal'],
        async list() {
            return { ok: true, source: 'journal', reason: 'ok', entries, attempts: [{ source: 'journal', ok: true, reason: 'ok' }] };
        },
    };
    return runtime;
}

/** JSON 应答：只有升格。 */
function promoteReply(items) {
    return JSON.stringify({ promote: items, supersede: [], retire: [] });
}

/** JSON 应答：只有失效。 */
function supersedeReply(ids) {
    return JSON.stringify({ promote: [], supersede: ids.map((id) => ({ id, reason: 'contradicted-by-fact' })), retire: [] });
}

try {
    /* ══════════════════════ 0. 纯函数：作用域 / 频次 / 解析 ══════════════════════ */
    assert.deepEqual(allowedScopes(''), ['global'], '跨桶运行只允许 global');
    assert.deepEqual(allowedScopes('_unassigned', {}), ['journal', 'global'], '_unassigned 只允许 journal / global');
    assert.deepEqual(allowedScopes('ws-1', { attributed: true }), ['project', 'journal']);
    assert.deepEqual(allowedScopes('ws-1', { attributed: false }), ['journal'], '素材归属不明 ⇒ 不写项目记忆');

    const occurrences = countOccurrences('依赖用 tarball 装', [
        { id: 'a', text: '依赖用 tarball 装，不用 pnpm install', session: 's1' },
        { id: 'b', text: '结论：依赖用 tarball 装', session: 's2' },
        { id: 'c', text: '毫无关系的另一句话', session: 's3' },
    ]);
    // P1-7：包含匹配要求长度差 ≤ 20%。'依赖用 tarball 装'（12）对 24 字那条差 50% ⇒ 不算命中；
    // 对 '结论：依赖用 tarball 装'（15）差 20% ⇒ 算命中。旧口径会把两条都算上。
    assert.equal(occurrences.hits, 1, '短句不再命中明显更长的素材（长度差 > 20%）');
    assert.deepEqual(occurrences.ids, ['b']);
    assert.equal(occurrences.demotedOnly, false);
    assert.equal(countOccurrences('', []).hits, 0);
    assert.equal(countOccurrences('依赖用 tarball 装', [{ id: 'a', text: '依赖用 tarball 装', tags: ['demoted'] }]).demotedOnly, true);
    // 归一化相等永远算命中；20% 以内的改写也算
    assert.equal(countOccurrences('结论：依赖用 tarball 装', [{ id: 'x', text: '依赖用 tarball 装', session: 's1' }]).hits, 1);
    assert.equal(
        countOccurrences('依赖用 tarball 装依赖', [{ id: 'x', text: '依赖用 tarball 装依赖呀', session: 's1' }]).hits,
        1,
        '长度差 ≤ 20% 的包含仍算同一句',
    );
    assert.equal(
        countOccurrences('重启', [{ id: 'x', text: '重启 DSH 引擎后插件才生效', session: 's1' }]).hits,
        0,
        '过短的句子只接受完全相同（否则「重启」能落进任何一句里）',
    );
    // P1-6 的纯函数口径：单独一个桶内就够 minHits ⇒ projectBuckets 非空（不许再升格 global）
    const conflict = promotionConflict('项目专属的结论', [
        { id: '1', text: '项目专属的结论', session: 's1', workspaceId: 'ws-1' },
        { id: '2', text: '项目专属的结论', session: 's2', workspaceId: 'ws-1' },
        { id: '3', text: '项目专属的结论', session: 's3', workspaceId: 'ws-2' },
    ], { minHits: 2 });
    assert.deepEqual(conflict.projectBuckets, ['ws-1'], 'ws-1 桶内自己就够 2 次');
    assert.equal(conflict.hits, 3);
    assert.deepEqual(conflict.buckets, ['ws-1', 'ws-2']);
    assert.deepEqual(
        promotionConflict('跨桶结论', [
            { id: '1', text: '跨桶结论', session: 's1', workspaceId: 'ws-1' },
            { id: '2', text: '跨桶结论', session: 's2', workspaceId: 'ws-2' },
        ], { minHits: 2 }).projectBuckets,
        [],
        '每个桶只有一次 ⇒ 是跨桶事实，可以进 global',
    );

    assert.equal(watermarkRatio({ lines: 45, bytes: 4261, limit: { lines: 100, bytes: 8000 } }), 4261 / 8000, '取最高维度');
    assert.equal(watermarkRatio({ lines: 90, bytes: 100, limit: { lines: 100, bytes: 8000 } }), 0.9, '行数超 85% 也算高水位');
    assert.equal(watermarkRatio(null), 0);

    const parsedBad = parseCrossResponse('这不是 JSON');
    assert.equal(parsedBad.ok, false);
    assert.equal(parseCrossResponse('{"promote":[{"scope":"global","content":"x"}],"supersede":["j1"],"retire":[]}').supersede[0].id, 'j1', '字符串 id 也认');

    /* prompt：必须带现行 FACT / MEMORY / 带 id 的素材 */
    const prompt = buildCrossPrompt({
        factText: '## 约定\n\n- 依赖用 tarball 装',
        memoryText: '1. 改完 lib 要重启 DSH',
        material: [
            { id: 'j1', text: '旧的结论：依赖用 pnpm install', origin: 'journal', workspaceId: 'ws-1' },
            { id: 'j2', text: '另一条素材', origin: 'journal' },
        ],
        scopes: ['global'],
        minHits: 2,
    });
    assert.ok(prompt.includes('依赖用 tarball 装'), 'prompt 要带现行 FACT');
    assert.ok(prompt.includes('改完 lib 要重启 DSH'), 'prompt 要带现行 MEMORY');
    assert.ok(prompt.includes('id=j1'), '素材要带 id（supersede 只能按 id 说话）');
    assert.ok(prompt.includes('[1]') && prompt.includes('[2]'), '素材要编号');
    assert.ok(prompt.includes('本次允许的 scope：global'));
    assert.ok(prompt.includes('≥ 2 次'));

    /* ══════════════════════ 1. 频次升格：两个会话各一次 → 一条 FACT ══════════════════════ */
    {
        const projectDir = join(home, 'proj-freq');
        mkdirSync(projectDir, { recursive: true });
        const store = memoryStore({ home, projectDir, factText: '## 约定\n\n- 已有的结论\n' });
        const entries = [
            { id: 'j1', text: '依赖用 tarball 装，不用 pnpm install', origin: 'journal', session: 'session-1', workspaceId: 'ws-1' },
            { id: 'j2', text: '依赖用 tarball 装，不用 pnpm install', origin: 'journal', session: 'session-2', workspaceId: 'ws-2' },
        ];
        const model = crossModel(promoteReply([{ scope: 'global', content: '依赖用 tarball 装，不用 pnpm install', hits: 2, confidence: 'high' }]));
        const runtime = crossRuntime({ store, model, entries });

        const result = await runL2({ runtime, manual: true, now: NOW, dryRun: false });
        assert.equal(result.status, 'OK', `应成功：${result.status} / ${result.reason}`);
        assert.equal(result.counts.promoted, 1);
        assert.equal(result.calls, 1, '一次运行只有一次调用');
        assert.equal(model.calls.length, 1);

        const inserts = store.calls.filter((call) => call.name === 'insertEntry');
        assert.equal(inserts.length, 1, '同一结论只写一条（频次升格后合并）');
        assert.equal(inserts[0].args[0], 'fact', 'global → FACT');
        assert.ok(inserts[0].args[1].text.includes('tarball'));

        const fact = readFileSync(store.factPath(), 'utf8');
        assert.equal(fact.split('依赖用 tarball 装').length - 1, 1, 'FACT 里只有一条');
        assert.equal(readCrossCursor(runtime.crossCursorFile).lastRunAt, NOW, '成功后推进 L2 游标');
        assert.ok(result.snapshot !== '' && existsSync(result.snapshot), '写前建了快照');
    }

    /* ══════════════════════ 2. 矛盾 ⇒ 只交 id 与理由 ══════════════════════ */
    {
        const store = memoryStore({ home, projectDir: join(home, 'proj-sup'), factText: '## 约定\n\n- 依赖用 tarball 装\n' });
        const hiddenText = '旧的结论：依赖用 pnpm install 装依赖，别再用了';
        const entries = [
            { id: 'j1', text: hiddenText, origin: 'journal' },
            { id: 'j2', text: '无关的一条日志', origin: 'journal' },
        ];
        const model = crossModel(supersedeReply(['j1', 'j-not-in-material']));
        const runtime = crossRuntime({ store, model, entries });

        const superseded = [];
        store.supersedeJournal = async (ids, reason) => {
            superseded.push({ ids, reason });
            return { moved: ids.length, archived: 3 };
        };

        const result = await runL2({ runtime, manual: true, now: NOW, dryRun: false });
        assert.equal(result.status, 'OK');
        assert.equal(superseded.length, 1, 'supersedeJournal 只调一次');
        assert.deepEqual(superseded[0].ids, ['j1'], '只有素材里真实存在的 journal id 才会交出去');
        assert.deepEqual(superseded[0].reason, { reason: 'contradicted-by-fact' }, '理由按 02 §7.6 固定');
        assert.equal(result.counts.superseded, 1);
        assert.equal(result.counts.skipped >= 1, true, '不存在的 id 记 skipped');

        /* runlog：只有 id，没有正文 */
        const runs = readFileSync(runtime.runLog.path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        const layer2 = runs.filter((record) => record.phase === 'layer2');
        assert.ok(layer2.length >= 1, 'runlog 要有 layer2 记录');
        const last = layer2[layer2.length - 1];
        assert.deepEqual(last.supersededIds, ['j1']);
        assert.equal(last.counts.superseded, 1);
        assert.ok(!JSON.stringify(last).includes('pnpm install'), 'runlog 里不能出现被失效条目的正文');
    }

    /* ══════════════════════ 3. 逐桶 project：只落在本桶 ══════════════════════ */
    {
        const projectDir = join(home, 'proj-ws1');
        mkdirSync(projectDir, { recursive: true });
        const store = memoryStore({ home, projectDir, memoryText: '## 结论\n\n1. 项目记忆\n' });
        const entries = [
            { id: 's1', text: '这个项目的测试要用 pwsh -File test/run-all.ps1', origin: 'service', session: 'session-1', workspaceId: 'ws-1' },
            { id: 's2', text: '这个项目的测试要用 pwsh -File test/run-all.ps1', origin: 'service', session: 'session-2', workspaceId: 'ws-1' },
        ];
        const model = crossModel(promoteReply([{ scope: 'project', content: '这个项目的测试要用 pwsh -File test/run-all.ps1', hits: 2 }]));
        const runtime = crossRuntime({
            store,
            model,
            entries,
            registry: { workspaces: { 'ws-1': { path: projectDir, title: '工作区一', sessionIds: [] } } },
        });

        const result = await runL2({ runtime, bucket: 'ws-1', manual: true, now: NOW, dryRun: false });
        assert.equal(result.status, 'OK', `${result.status} / ${result.reason}`);
        const inserts = store.calls.filter((call) => call.name === 'insertEntry');
        assert.equal(inserts.length, 1);
        assert.equal(inserts[0].args[0], 'memory', 'project → 项目 MEMORY.md');
        assert.equal(inserts[0].args[2].cwd, projectDir, 'cwd 必须是本桶的工作区路径');
        assert.ok(readFileSync(join(projectDir, 'MEMORY.md'), 'utf8').includes('run-all.ps1'));
    }

    /* ══════════════════════ 4. 跨桶运行只产出 global ══════════════════════ */
    {
        const store = memoryStore({ home, projectDir: join(home, 'proj-cross'), factText: '## 约定\n\n- 已有的结论\n' });
        const entries = [
            { id: 's1', text: '跨桶的结论', origin: 'service', session: 'session-1', workspaceId: 'ws-1' },
            { id: 's2', text: '跨桶的结论', origin: 'service', session: 'session-2', workspaceId: 'ws-2' },
        ];
        const model = crossModel(promoteReply([{ scope: 'project', content: '跨桶的结论', hits: 2 }]));
        const runtime = crossRuntime({ store, model, entries });

        const result = await runL2({ runtime, manual: true, now: NOW, dryRun: false });
        assert.equal(store.calls.filter((call) => call.name === 'insertEntry').length, 0, '跨桶运行不许产出 project');
        assert.equal(result.counts.promoted, 0);
        assert.equal(result.counts.skipped, 1);
        assert.ok(result.prompt.includes('本次允许的 scope：global'));
    }

    /* ══════════════════════ 5. `_unassigned` 绝不产出 project ══════════════════════ */
    {
        const store = memoryStore({ home, projectDir: join(home, 'proj-unassigned') });
        const entries = [
            { id: 's1', text: '未分组里出现两次的结论', origin: 'service', session: 'session-1', workspaceId: '_unassigned' },
            { id: 's2', text: '未分组里出现两次的结论', origin: 'service', session: 'session-2', workspaceId: '_unassigned' },
        ];
        const model = crossModel(JSON.stringify({
            promote: [
                { scope: 'project', content: '未分组里出现两次的结论', hits: 2 },
                { scope: 'journal', content: '未分组里出现两次的结论', hits: 2 },
            ],
            supersede: [],
            retire: [],
        }));
        const runtime = crossRuntime({ store, model, entries });

        const result = await runL2({ runtime, bucket: '_unassigned', manual: true, now: NOW, dryRun: false });
        assert.equal(store.calls.filter((call) => call.name === 'insertEntry').length, 0, '_unassigned 绝不 project');
        const journals = store.calls.filter((call) => call.name === 'appendJournal');
        assert.equal(journals.length, 1, 'journal 类是允许的');
        assert.equal(result.counts.skipped, 1, 'project 那条被跳过');
        assert.ok(result.prompt.includes('本次允许的 scope：journal / global'));
    }

    /* ══════════════════════ 6. 20 条上限 ══════════════════════ */
    {
        const store = memoryStore({ home, projectDir: join(home, 'proj-cap') });
        const entries = Array.from({ length: 25 }, (_, index) => ({ id: `j${index}`, text: `日志第 ${index} 条`, origin: 'journal' }));
        const model = crossModel(supersedeReply(entries.map((entry) => entry.id)));
        const runtime = crossRuntime({ store, model, entries });
        const calls = [];
        store.supersedeJournal = async (ids, reason) => {
            calls.push({ ids, reason });
            return { moved: ids.length };
        };

        const result = await runL2({ runtime, manual: true, now: NOW, dryRun: false });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].ids.length, MAX_SUPERSEDE, '每次最多 20 条');
        assert.equal(MAX_SUPERSEDE, 20);
        assert.equal(calls[0].ids[0], 'j0');
        assert.equal(calls[0].ids[19], 'j19');
        assert.equal(result.counts.skipped >= 5, true, '超出的记 skipped，留给下一轮');
    }

    /* ══════════════════════ 7. demoted 条目的水位闸（< 85%） ══════════════════════ */
    {
        const highMark = { lines: 95, bytes: 9000, chars: 9000, limit: { lines: 100, bytes: 8000 } };
        const lowMark = { lines: 20, bytes: 1000, chars: 1000, limit: { lines: 100, bytes: 8000 } };
        const demotedEntries = [
            { id: 'd1', text: '降级过的结论：依赖用 tarball 装', origin: 'journal', session: 'session-1', tags: ['demoted'] },
            { id: 'd2', text: '降级过的结论：依赖用 tarball 装', origin: 'journal', session: 'session-2', tags: ['demoted'] },
        ];
        const reply = promoteReply([{ scope: 'global', content: '降级过的结论：依赖用 tarball 装', hits: 2 }]);

        const blockedStore = fakeStore({ watermark: async () => highMark }).store;
        const blockedRuntime = crossRuntime({ store: blockedStore, model: crossModel(reply), entries: demotedEntries });
        const blocked = await runL2({ runtime: blockedRuntime, manual: true, now: NOW, dryRun: false });
        const blockedInserts = blockedStore.calls.filter((call) => call.name === 'insertEntry');
        assert.equal(blockedInserts.length, 0, '水位 ≥ 85% 时 demoted 条目不升格');
        assert.equal(blocked.counts.skipped, 1);
        assert.equal(blocked.counts.promoted, 0);

        const openStore = fakeStore({ watermark: async () => lowMark }).store;
        const openRuntime = crossRuntime({ store: openStore, model: crossModel(reply), entries: demotedEntries });
        const opened = await runL2({ runtime: openRuntime, manual: true, now: NOW, dryRun: false });
        assert.equal(openStore.calls.filter((call) => call.name === 'insertEntry').length, 1, '水位 < 85% 时允许升格');
        assert.equal(opened.counts.promoted, 1);
    }

    /* ══════════════════════ 8. dryRun：一个字节都不写 ══════════════════════ */
    {
        const store = memoryStore({ home, projectDir: join(home, 'proj-dry'), factText: '## 约定\n\n- 已有的结论\n' });
        const entries = [
            { id: 'j1', text: '依赖用 tarball 装', origin: 'journal', session: 's1' },
            { id: 'j2', text: '依赖用 tarball 装', origin: 'journal', session: 's2' },
        ];
        const model = crossModel(JSON.stringify({
            promote: [{ scope: 'global', content: '依赖用 tarball 装', hits: 2 }],
            supersede: [{ id: 'j1', reason: 'contradicted-by-fact' }],
            retire: [],
        }));
        const runtime = crossRuntime({ store, model, entries });
        const superseded = [];
        store.supersedeJournal = async (ids) => {
            superseded.push(ids);
            return { moved: ids.length };
        };
        const factBefore = readFileSync(store.factPath(), 'utf8');

        const result = await runL2({ runtime, manual: true, now: NOW, dryRun: true });
        assert.equal(result.status, 'DRY');
        assert.equal(result.counts.promoted, 1, '干跑也算出「本该升格几条」');
        assert.equal(result.counts.superseded, 1, '干跑也算出「本该失效几条」');
        assert.equal(readFileSync(store.factPath(), 'utf8'), factBefore, '干跑不许写盘');
        assert.equal(superseded.length, 0, '干跑不许调 supersedeJournal');
        assert.equal(store.calls.filter((call) => call.name === 'insertEntry').length, 0);
        assert.equal(readCrossCursor(runtime.crossCursorFile).lastRunAt, 0, '干跑不推游标');
        assert.equal(result.snapshot, '', '干跑不返回快照目录');
        assert.equal(existsSync(join(consolidateDir(), 'backups', result.runId)), false, '干跑不建快照');
    }

    /* ══════════════════════ 9. 失败：游标不动 ══════════════════════ */
    {
        const store = memoryStore({ home, projectDir: join(home, 'proj-fail') });
        const entries = [{ id: 'j1', text: '随便一条', origin: 'journal' }];

        const boom = crossRuntime({ store, model: crossModel(() => { throw new Error('llm 502'); }), entries });
        const failed = await runL2({ runtime: boom, manual: true, now: NOW, dryRun: false });
        assert.equal(failed.status, 'FAIL');
        assert.equal(failed.skipped, 'model-error');
        assert.equal(readCrossCursor(boom.crossCursorFile).lastRunAt, 0, '失败后游标不动（下次重跑）');
        assert.equal(store.calls.filter((call) => call.name === 'insertEntry').length, 0);
        // L2 失败也要带 detail（模型消息，不是裸错误码）
        const boomLast = readFileSync(boom.runLog.path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
            .filter((record) => record.phase === 'layer2').pop();
        assert.equal(boomLast.reason, 'model-error');
        assert.ok(String(boomLast.detail).includes('llm 502'), `L2 detail 要含真实错误消息：${boomLast.detail}`);

        const invalid = crossRuntime({ store, model: crossModel('我不知道该写什么'), entries });
        const badJson = await runL2({ runtime: invalid, manual: true, now: NOW, dryRun: false });
        assert.equal(badJson.status, 'FAIL');
        assert.equal(badJson.skipped, 'parse-failed');
        assert.equal(readCrossCursor(invalid.crossCursorFile).lastRunAt, 0);

        /* 模型没接线（命令之外没 prepare） */
        const noModel = crossRuntime({ store, model: null, entries });
        noModel.callModel = null;
        const notWired = await runL2({ runtime: noModel, manual: true, now: NOW, dryRun: false });
        assert.equal(notWired.status, 'FAIL');
        assert.equal(notWired.skipped, 'no-model');

        /* 素材源全挂 */
        const noSource = crossRuntime({ store, model: crossModel('{}'), entries });
        noSource.crossChain = { async list() { return { ok: false, source: 'none', reason: 'all-sources-failed', entries: [], attempts: [] }; } };
        const sourceFailed = await runL2({ runtime: noSource, manual: true, now: NOW, dryRun: false });
        assert.equal(sourceFailed.status, 'FAIL');
        assert.equal(sourceFailed.skipped, 'source-failed');
        assert.equal(readCrossCursor(noSource.crossCursorFile).lastRunAt, 0);
    }

    /* ══════════════════════ 10. 预算走 layer2 ══════════════════════ */
    {
        const store = memoryStore({ home, projectDir: join(home, 'proj-budget') });
        const entries = [{ id: 'j1', text: '随便一条', origin: 'journal' }];
        const tight = createBudget({ dailyLlmBudget: 60, layer2Limit: 0 });
        const runtime = crossRuntime({ store, model: crossModel(promoteReply([])), entries, budget: tight });
        const blocked = await runL2({ runtime, manual: true, now: NOW, dryRun: false });
        assert.equal(blocked.status, 'SKIPPED', `额度 0 时不该跑：${blocked.status}`);
        assert.equal(blocked.reason, 'budget');
        assert.equal(blocked.calls, 0);
        assert.equal(tight.snapshot(NOW).used.layer2, 0, '被拒绝的运行不扣预算');

        const normal = createBudget({ dailyLlmBudget: 60 });
        const okRuntime = crossRuntime({ store, model: crossModel(promoteReply([])), entries, budget: normal });
        await runL2({ runtime: okRuntime, manual: true, now: NOW, dryRun: false });
        assert.equal(normal.snapshot(NOW).used.layer2, 1, 'L2 的花费记在 layer2');
        assert.equal(normal.snapshot(NOW).used.layer1, 0, '不许记到 layer1');
    }

    /* ══════════════════════ 11. runL2All：跨桶一遍 + 逐桶各一遍 ══════════════════════ */
    {
        const ws1 = join(home, 'proj-all-1');
        const ws2 = join(home, 'proj-all-2');
        mkdirSync(ws1, { recursive: true });
        mkdirSync(ws2, { recursive: true });
        // 两个桶各有「已消费」行 ⇒ listPendingBuckets 能看到它们（跨会话整理逐桶迭代的依据）。
        appendRow({
            pendingDir: join(consolidateDir(), 'pending'),
            bucket: 'ws-a',
            sessionId: 'session-a',
            now: NOW,
            row: { turn: 1, endedAt: NOW, chars: 10, session: 'session-a', consumed: true },
        });
        appendRow({
            pendingDir: join(consolidateDir(), 'pending'),
            bucket: 'ws-b',
            sessionId: 'session-b',
            now: NOW,
            row: { turn: 1, endedAt: NOW, chars: 10, session: 'session-b', consumed: true },
        });
        assert.equal(countConsumedEntries(join(consolidateDir(), 'pending')), 2, '已消费素材计数（触发条件 ②）');

        const store = memoryStore({ home, projectDir: ws1 });
        const entries = [
            { id: 's1', text: '同一个结论', origin: 'service', session: 'session-a', workspaceId: 'ws-a' },
            { id: 's2', text: '同一个结论', origin: 'service', session: 'session-b', workspaceId: 'ws-b' },
        ];
        const runtime = crossRuntime({
            store,
            model: crossModel(promoteReply([{ scope: 'global', content: '同一个结论', hits: 2 }])),
            entries,
            registry: { workspaces: { 'ws-a': { path: ws1, title: 'A', sessionIds: [] }, 'ws-b': { path: ws2, title: 'B', sessionIds: [] } } },
        });

        const all = await runL2All({ runtime, manual: true, now: NOW, dryRun: false });
        assert.equal(all.runs.length, 3, '跨桶 1 段 + 两个桶各 1 段');
        assert.equal(all.runs[0].bucket, '', '第一段是跨桶');
        assert.deepEqual(all.runs.slice(1).map((run) => run.bucket), ['ws-a', 'ws-b']);
        assert.equal(all.calls, 3, '每段一次真实调用');
        assert.equal(all.status, 'OK');
        assert.equal(runtime.budget.snapshot(NOW).used.layer2, 3, '预算按调用次数扣');
    }

    /* ══════════════════════ 12. 触发判定（不手动就不跑） ══════════════════════ */
    {
        const store = memoryStore({ home, projectDir: join(home, 'proj-trigger') });
        const runtime = crossRuntime({ store, model: crossModel(promoteReply([])), entries: [], config: { crossIntervalHours: 24 } });
        writeCrossCursor({ lastRunAt: NOW - 3_600_000, lastCount: 0, lastRunId: 'r0' }, runtime.crossCursorFile);

        const skipped = await runL2({ runtime, now: NOW, dryRun: false });
        assert.equal(skipped.status, 'SKIPPED');
        assert.equal(skipped.skipped, 'trigger');
        assert.equal(skipped.reason, 'too-soon');

        const manual = await runL2({ runtime, now: NOW, dryRun: false, manual: true });
        assert.equal(manual.status, 'NOOP', `手动触发绕过时间门槛：${manual.status}`);
    }

    /* ══════════════════════ 13. mergePromotions：确定性预筛（不额外调模型） ══════════════════════ */
    {
        const pool = [{ id: 'f1', text: '依赖用 tarball 装', scope: 'fact' }];
        const merged = mergePromotions({
            candidates: [
                { content: '依赖用 tarball 装', scope: 'global' },
                { content: '完全新的一条结论', scope: 'global' },
            ],
            pool,
            layer: 2,
        });
        assert.equal(merged.ops.length, 2);
        assert.equal(merged.ops[0].op, 'NOOP', '完全相同 ⇒ NOOP');
        assert.equal(merged.ops[0].target, 'f1');
        assert.equal(merged.ops[1].op, 'ADD');
        assert.equal(merged.ops[1].layer, 2, 'L2 的算子带 layer:2（DELETE 才被允许）');
        assert.equal(merged.counts.noop, 1);
        assert.equal(merged.counts.added, 1);
    }
    /* ══════════════════════ 14. 影子档（mode: observe）：L2 真跑，但一个字节都不写 ══════════════════════ */
    {
        const projectDir = join(home, 'proj-observe');
        mkdirSync(projectDir, { recursive: true });
        const store = memoryStore({
            home,
            projectDir,
            factText: '## 约定\n\n- 已有的结论\n',
            memoryText: '## 结论\n\n1. 项目记忆\n',
        });
        // 素材：两条同义（跨两个桶凑够 crossPromoteHits=2；同桶内够 2 次属于项目专属，
        // P1-6 不许再升格 global）+ 一条要被试失效的 JOURNAL 条目
        const entries = [
            { id: 's1', text: '跨会话的稳定结论：先看 would-write 再开 auto', origin: 'service', session: 'session-1', workspaceId: 'ws-obs-a' },
            { id: 's2', text: '跨会话的稳定结论：先看 would-write 再开 auto', origin: 'service', session: 'session-2', workspaceId: 'ws-obs-b' },
            { id: 'j1', text: '旧的 JOURNAL 结论：依赖用 pnpm install', origin: 'journal', session: 'session-3' },
        ];
        const reply = JSON.stringify({
            promote: [{ scope: 'global', content: '跨会话的稳定结论：先看 would-write 再开 auto', hits: 2 }],
            supersede: [{ id: 'j1', reason: 'contradicted-by-fact' }],
            retire: [],
        });
        const runtime = crossRuntime({ store, model: crossModel(reply), entries, config: { mode: 'observe', dryRun: false } });

        let supersedeCalls = 0;
        store.supersedeJournal = async () => {
            supersedeCalls += 1;
            return { moved: 1, archived: 1 };
        };
        const supersededBefore = existsSync(runtime.supersededFile)
            ? readFileSync(runtime.supersededFile, 'utf8').trim().split('\n').length
            : 0;
        const factSha = sha256(store.factPath());
        const memorySha = sha256(join(projectDir, 'MEMORY.md'));
        const journalSha = sha256(store.journalPath());

        const result = await runL2({ runtime, manual: true, now: NOW, dryRun: false });

        assert.equal(result.status, 'OBSERVED', `L2 影子档要记 OBSERVED：${result.status} / ${result.reason}`);
        assert.equal(result.observe, true);
        assert.equal(supersedeCalls, 0, '影子档绝不调 supersedeJournal（那是真写 JOURNAL）');
        assert.equal(sha256(store.factPath()), factSha, 'FACT.md 的 SHA256 必须不变');
        assert.equal(sha256(join(projectDir, 'MEMORY.md')), memorySha, 'MEMORY.md 的 SHA256 必须不变');
        assert.equal(sha256(store.journalPath()), journalSha, 'JOURNAL.jsonl 的 SHA256 必须不变');
        assert.equal(
            existsSync(runtime.supersededFile) ? readFileSync(runtime.supersededFile, 'utf8').trim().split('\n').length : 0,
            supersededBefore,
            '影子档不写 superseded.jsonl',
        );
        assert.ok(!store.calls.some((call) => ['insertEntry', 'replaceEntry', 'deleteEntry', 'appendJournal'].includes(call.name)), '影子档一个写入方法都不调');
        assert.equal(result.counts.written, 0, '影子结果不算真实写入');
        assert.equal(result.counts.superseded, 1, '本来会失效 1 条（只记预览条数）');
        assert.equal(result.snapshot, '', '影子档不建记忆文件快照');

        /* runlog：OBSERVED + 正文一个字都不进 */
        const runs = readFileSync(runtime.runLog.path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        const layer2 = runs.filter((record) => record.phase === 'layer2');
        assert.equal(layer2[layer2.length - 1].status, 'OBSERVED');
        assert.ok(!JSON.stringify(layer2[layer2.length - 1]).includes('先看 would-write 再开 auto'), 'runlog 里不能出现条目正文');

        /* 内部记账与 auto 一致：跨会话游标照常推进 */
        assert.equal(readCrossCursor(runtime.crossCursorFile).lastRunAt, NOW, '影子档也要推跨会话游标（否则同一批素材每天重跑）');

        /* would-write 有 L2 行 */
        assert.ok(typeof result.wouldWrite?.file === 'string' && result.wouldWrite.file !== '', 'L2 也要产出影子文件路径');
        assert.ok(existsSync(wouldWritePath(NOW)), `影子文件必须落盘：${wouldWritePath(NOW)}`);
        const shadowLines = readFileSync(wouldWritePath(NOW), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        const layer2Lines = shadowLines.filter((line) => line.layer === 2);
        assert.ok(layer2Lines.length >= 1, 'would-write 里要有 layer 2 的算子');
        assert.ok(layer2Lines.some((line) => line.status === 'would-written' && line.content.includes('先看 would-write')), 'L2 的升格候选要落成 would-written');
        assert.ok(layer2Lines.every((line) => String(line.status).startsWith('would-')));
    }
    /* ══════════════════════ 15. P1-7：模型自报的 hits 不许绕过频次门槛 ══════════════════════ */
    {
        const store = memoryStore({ home, projectDir: join(home, 'proj-claimed'), factText: '## 约定\n\n- 已有的结论\n' });
        // 素材里这句**只出现过一次**，模型却坚称 hits=5。
        const entries = [
            { id: 'j1', text: '只出现过一次的偶然结论', origin: 'journal', session: 'session-1' },
        ];
        const model = crossModel(promoteReply([{ scope: 'global', content: '只出现过一次的偶然结论', hits: 5 }]));
        const runtime = crossRuntime({ store, model, entries });

        const result = await runL2({ runtime, manual: true, now: NOW, dryRun: false });
        assert.equal(store.calls.filter((call) => call.name === 'insertEntry').length, 0, '自报 hits 不许升格');
        assert.equal(result.counts.promoted, 0);
        assert.equal(result.counts.skipped >= 1, true);
        assert.ok(!readFileSync(store.factPath(), 'utf8').includes('偶然结论'), 'FACT 一个字都不许加');
    }

    /* ══════════════════════ 16. P1-6：项目专属结论不许同时升格 global ══════════════════════ */
    {
        const store = memoryStore({ home, projectDir: join(home, 'proj-double'), factText: '## 约定\n\n- 已有的结论\n' });
        // 同一句在 ws-1 桶里两个会话各出现一次 ⇒ 对本桶来说已经是稳定事实（project 候选）。
        const entries = [
            { id: 's1', text: '项目专属结论不许写进全局事实', origin: 'service', session: 'session-1', workspaceId: 'ws-1' },
            { id: 's2', text: '项目专属结论不许写进全局事实', origin: 'service', session: 'session-2', workspaceId: 'ws-1' },
        ];
        const model = crossModel(promoteReply([{ scope: 'global', content: '项目专属结论不许写进全局事实', hits: 2 }]));
        const runtime = crossRuntime({ store, model, entries });

        const result = await runL2({ runtime, manual: true, now: NOW, dryRun: false });
        assert.equal(store.calls.filter((call) => call.name === 'insertEntry').length, 0, '项目专属结论不许写 FACT');
        assert.equal(result.counts.promoted, 0);
        assert.ok(
            (result.skippedDetail ?? []).some((item) => String(item.reason).startsWith('also-project-candidate:ws-1')),
            `跳过原因要说明是项目候选：${JSON.stringify(result.skippedDetail)}`,
        );
        assert.ok(!readFileSync(store.factPath(), 'utf8').includes('项目专属结论'), 'FACT 不许出现这句');
    }

    /* ══════════════════════ 17. P1-6 端到端：runL2All 里同一句只写一处（MEMORY） ══════════════════════ */
    {
        const projectDir = join(home, 'proj-local');
        mkdirSync(projectDir, { recursive: true });
        const store = memoryStore({ home, projectDir, factText: '## 约定\n\n- 已有的结论\n', memoryText: '## 结论\n\n1. 项目记忆\n' });
        appendRow({
            pendingDir: join(consolidateDir(), 'pending'),
            bucket: 'ws-local',
            sessionId: 'session-l1',
            now: NOW,
            row: { turn: 1, endedAt: NOW, chars: 10, session: 'session-l1', consumed: true },
        });
        const entries = [
            { id: 's1', text: '只属于这个项目的结论', origin: 'service', session: 'session-l1', workspaceId: 'ws-local' },
            { id: 's2', text: '只属于这个项目的结论', origin: 'service', session: 'session-l2', workspaceId: 'ws-local' },
        ];
        // 跨桶那一段给的 scope 只有 global；逐桶那一段才允许 project —— 同一句会被模型各答一次。
        const model = crossModel((request) => (String(request?.prompt ?? '').includes('本次允许的 scope：global')
            ? promoteReply([{ scope: 'global', content: '只属于这个项目的结论', hits: 2 }])
            : promoteReply([{ scope: 'project', content: '只属于这个项目的结论', hits: 2 }])));
        const runtime = crossRuntime({
            store,
            model,
            entries,
            registry: { workspaces: { 'ws-local': { path: projectDir, title: '本地', sessionIds: [] } } },
        });

        const all = await runL2All({ runtime, manual: true, now: NOW, dryRun: false });
        const cross = all.runs.find((run) => run.bucket === '');
        const bucket = all.runs.find((run) => run.bucket === 'ws-local');
        assert.equal(cross.counts.promoted, 0, '跨桶段不许把它升格成 global');
        assert.equal(bucket.counts.promoted, 1, '逐桶段写进项目记忆');
        const fact = readFileSync(store.factPath(), 'utf8');
        const memory = readFileSync(join(projectDir, 'MEMORY.md'), 'utf8');
        assert.ok(!fact.includes('只属于这个项目的结论'), 'FACT 里不许出现项目专属结论');
        assert.ok(memory.includes('只属于这个项目的结论'), '项目 MEMORY 里要有一条');
        assert.equal(store.calls.filter((call) => call.name === 'insertEntry').length, 1, '同一句只写一次');
    }
} finally {
    cleanup();
}

console.log('✓ crosssession.test.mjs 全部通过');
