/**
 * runlog：结构白名单、脱敏、滚动、写不进去也不抛（02 §4.3 / §7.4）。
 *
 * 跑法：node test/runlog.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    LAYER_FIELDS,
    RECORD_FIELDS,
    appendRun,
    createRunLog,
    normalizeWatermarkLimit,
    readLastFailure,
    readRunRecords,
    summarizeDay,
    runsPath,
    sanitizeRecord,
    successRate,
    summarize,
    supersededPath,
} from '../lib/runlog.js';
import { makeHome } from './_helpers.mjs';

const { home, cleanup } = makeHome('pmc-runlog');
try {
    const file = runsPath();
    assert.ok(file.endsWith(join('memory', 'consolidate', 'runs.jsonl')), `实际路径：${file}`);
    assert.ok(supersededPath().endsWith(join('consolidate', 'superseded.jsonl')));

    /* 一条正常记录：`limit` 按 `store.watermark()` 的真实形状（对象）喂 */
    const log = createRunLog({ file });
    assert.equal(log.append({
        runId: 'run-1',
        phase: 'layer1',
        status: 'OK',
        reason: 'min-turns',
        counts: { candidates: 3, ops: 2, written: 1, demoted: 1 },
        watermarks: { fact: { lines: 45, bytes: 4261, chars: 4261, limit: { lines: 100, bytes: 8000 } } },
        durationMs: 1234,
    }, 1_800_000_000_000), true);

    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.runId, 'run-1');
    assert.equal(record.ts, 1_800_000_000_000);
    assert.equal(record.counts.candidates, 3);
    assert.equal(record.watermarks.fact.bytes, 4261);
    /* 真实形状是对象（FACT `{lines, bytes}`、项目 MEMORY `{chars}`）——旧代码用
       `Number.isFinite(limit)` 判，对象恒不是有限数 ⇒ 落盘恒 0。 */
    assert.equal(record.watermarks.fact.limit.lines, 100, 'limit.lines 要透传（不能恒 0）');
    assert.equal(record.watermarks.fact.limit.bytes, 8000, 'limit.bytes 要透传（不能恒 0）');
    assert.equal(record.watermarks.fact.limit.chars, undefined, '没给的维度不许凭空补 0');
    assert.equal(record.durationMs, 1234);

    /* 旧调用方喂标量（数字）仍要能用：原样保留，不因修复变成 0 或怪对象 */
    const numericLimit = sanitizeRecord({ watermarks: { memory: { lines: 1, limit: 8000 } } }).watermarks.memory.limit;
    assert.equal(numericLimit, 8000, '标量 limit 原样保留（向后兼容）');
    assert.equal(normalizeWatermarkLimit({ lines: 5, 未知键: 99 }).未知键, undefined, '对象 limit 只透传已知维度');
    assert.equal(normalizeWatermarkLimit(undefined), 0);
    assert.equal(normalizeWatermarkLimit('abc'), 0, '不认识的值不许抛');

    /* 白名单：正文类字段一律丢掉（runlog 只存摘要） */
    const sanitized = sanitizeRecord({
        runId: 'run-2',
        content: '依赖用 tarball 装，这句正文不该进 runlog',
        entry: { content: '也不该' },
        memories: [{ content: '更不该' }],
        counts: { candidates: 1, 未知字段: 99 },
        ts: 1,
    });
    assert.equal(sanitized.content, undefined, '正文不许落 runlog');
    assert.equal(sanitized.entry, undefined);
    assert.equal(sanitized.memories, undefined);
    assert.deepEqual(sanitized.counts, { candidates: 1 }, 'counts 只保留白名单子键');
    assert.equal(sanitized.ts, 1);

    /* ── DESIGN §14.2：`layers` 结构化分层计数（只留数字，未知键不漏进去） ── */
    assert.ok(RECORD_FIELDS.includes('layers'), 'layers 必须在记录白名单里（否则写了也会被丢掉）');
    assert.deepEqual(LAYER_FIELDS, ['conclusion', 'detail', 'rerouted', 'reroutedNoOwner', 'reroutedLong']);
    const layered = sanitizeRecord({
        runId: 'run-layers',
        layers: { conclusion: 3, detail: 2, rerouted: 1, 未知键: 9, content: '正文不该借道进来' },
    });
    assert.deepEqual(layered.layers, { conclusion: 3, detail: 2, rerouted: 1 }, 'layers 只留已知数字键（没给的键不补）');
    assert.deepEqual(
        sanitizeRecord({ layers: { conclusion: 3, reroutedLong: 2 } }).layers,
        { conclusion: 3, reroutedLong: 2 },
        'reroutedLong（0.5.0 长度门）必须也在白名单里，否则写了也会被静默丢掉',
    );
    assert.equal(sanitizeRecord({ layers: {} }).layers, undefined, '空 layers 不落盘');
    assert.equal(sanitizeRecord({ layers: { conclusion: '3' } }).layers, undefined, '字符串不算数字');
    assert.equal(sanitizeRecord({ layers: { 未知键: 3 } }).layers, undefined, '全是未知键 ⇒ 整块丢掉');
    assert.equal(sanitizeRecord({ layers: 5 }).layers, undefined, 'layers 不是对象 ⇒ 丢掉（不许把标量当成分层）');

    // 真写一行，确认落盘结果是可消费的形状
    log.append({ runId: 'run-layers-2', status: 'OK', layers: { conclusion: 4, detail: 1, rerouted: 1 } }, 1_800_000_000_001);
    const layersLine = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').pop());
    assert.deepEqual(layersLine.layers, { conclusion: 4, detail: 1, rerouted: 1 });

    /* 脱敏：reason 里混了密钥也不许原样落盘 */
    log.append({ runId: 'run-3', reason: 'api_key: abcdef123456 读取失败', status: 'FAIL' });
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes('abcdef123456'), 'runlog 里不能出现密文');
    assert.ok(raw.includes('⟨redacted⟩'));

    /* 超长字符串截断 */
    const clipped = sanitizeRecord({ reason: 'x'.repeat(500) });
    assert.ok(clipped.reason.length <= 121, 'reason 截断到 120 字符');

    /* 滚动：maxBytes 很小 → 出现 runs.jsonl.1 */
    const rotFile = join(home, 'consolidate', 'rot.jsonl');
    const rotLog = createRunLog({ file: rotFile, maxBytes: 200, maxFiles: 2 });
    for (let index = 0; index < 12; index += 1) {
        rotLog.append({ runId: `r${index}`, status: 'OK', reason: 'padding-'.repeat(3) });
    }
    assert.ok(existsSync(rotFile), '当前文件仍在');
    assert.ok(existsSync(`${rotFile}.1`), '超限后应滚动出 .1');
    assert.ok(!existsSync(`${rotFile}.3`), 'maxFiles=2 只留两份');

    /* 写不进去（父路径是文件）→ false，不抛 */
    const blocker = join(home, 'blocker');
    writeFileSync(blocker, 'x', 'utf8');
    const broken = createRunLog({ file: join(blocker, 'runs.jsonl') });
    assert.equal(broken.append({ runId: 'nope' }), false);

    /* 便利函数 */
    assert.equal(appendRun({ runId: 'run-4', status: 'DRY' }, { file: join(home, 'consolidate', 'other.jsonl') }), true);
    assert.equal(appendRun({ runId: 'run-5' }, { file: join(blocker, 'x.jsonl') }), false);

    /* ── M5：汇总的算术（次数 / 成功率 / 字符 / NOOP 比例 / DEMOTED / 平均调用） ── */
    const summaryFile = join(home, 'consolidate', 'summary.jsonl');
    const summaryLog = createRunLog({ file: summaryFile });
    const DAY = 86_400_000;
    const T = 1_800_000_000_000;
    summaryLog.append({ runId: 's1', phase: 'layer1', status: 'OK', workspaceId: 'ws-a', chars: 1000, calls: 1, counts: { written: 2, demoted: 1 } }, T - 1 * DAY);
    summaryLog.append({ runId: 's2', phase: 'layer1', status: 'DRY', workspaceId: 'ws-a', chars: 500, calls: 2, counts: { demoted: 1 } }, T - 2 * DAY);
    summaryLog.append({ runId: 's3', phase: 'layer1', status: 'NOOP', workspaceId: 'ws-b', chars: 0, calls: 1, counts: {} }, T - 3 * DAY);
    summaryLog.append({ runId: 's4', phase: 'layer1', status: 'SKIPPED', workspaceId: 'ws-b', calls: 0, counts: {} }, T - 4 * DAY);
    summaryLog.append({ runId: 's5', phase: 'layer1', status: 'FAIL', workspaceId: 'ws-b', chars: 200, calls: 1, counts: { dropped: 2 } }, T - 5 * DAY);
    // 窗口外（8 天前）：不参与 7 天汇总
    summaryLog.append({ runId: 'old', phase: 'layer1', status: 'OK', workspaceId: 'ws-a', chars: 9999, calls: 9 }, T - 8 * DAY);

    const summary = summarize({ file: summaryFile, days: 7, now: T });
    assert.equal(summary.runs, 5, '窗口内 5 条（8 天前那条不算）');
    assert.equal(summary.ok, 1, 'OK 只有 1 条（DRY 不算成功）');
    assert.equal(summary.dry, 1);
    assert.equal(summary.fail, 1);
    assert.equal(summary.characters, 1000 + 500 + 0 + 200, '只累加窗口内的 chars');
    assert.equal(summary.noopRatio, 0.4, '(NOOP 1 + SKIPPED 1) / 5');
    assert.equal(summary.demoted, 2, 'counts.demoted 之和');
    assert.equal(summary.dropped, 2);
    assert.equal(summary.avgCalls, 1, '(1+2+1+0+1)/5 = 1');
    assert.equal(summary.lastRunAt, T - 1 * DAY, '最新一条的时间戳');
    assert.equal(successRate(summary), 0.2, '成功 1 / 5');
    assert.deepEqual(Object.keys(summary.byWorkspace).sort(), ['ws-a', 'ws-b']);
    assert.equal(summary.byWorkspace['ws-a'].runs, 2);
    assert.equal(summary.byWorkspace['ws-a'].ok, 1);
    assert.equal(summary.byWorkspace['ws-a'].dry, 1);
    assert.equal(summary.byWorkspace['ws-a'].characters, 1500);
    assert.equal(summary.byWorkspace['ws-a'].demoted, 2);
    assert.equal(summary.byWorkspace['ws-b'].runs, 3);
    assert.equal(summary.byWorkspace['ws-b'].fail, 1);

    /* 全窗口（days=0）与空文件：都不抛 */
    assert.equal(summarize({ file: summaryFile, days: 0, now: T }).runs, 6, 'days=0 ⇒ 不限窗口（含滚动文件）');
    const emptySummary = summarize({ file: join(home, 'consolidate', 'no-such.jsonl'), days: 7, now: T });
    assert.deepEqual(emptySummary, {
        runs: 0, ok: 0, fail: 0, dry: 0, characters: 0, noopRatio: 0,
        demoted: 0, dropped: 0, avgCalls: 0, lastRunAt: 0, observed: 0, wouldWrite: 0, byWorkspace: {},
    });
    assert.equal(successRate(emptySummary), 0, '没有运行 ⇒ 成功率 0（不除以 0）');

    /* ── 影子运行（OBSERVED）不进真实写入统计，只单独计数 ── */
    const shadowCounts = { written: 0, demoted: 0, dropped: 0, observed: 3 };
    summaryLog.append({ runId: 's6', phase: 'layer1', status: 'OBSERVED', workspaceId: 'ws-a', chars: 400, calls: 1, counts: shadowCounts }, T - 6 * 60 * 60 * 1000);
    const withShadow = summarize({ file: summaryFile, days: 7, now: T });
    assert.equal(withShadow.runs, 5, 'OBSERVED 不计入 runs（否则成功率/NOOP 比例会被稀释）');
    assert.equal(withShadow.ok, 1);
    assert.equal(withShadow.observed, 1, '影子运行单独计次');
    assert.equal(withShadow.wouldWrite, 3, '影子运行本来会写的算子数单独汇总');
    assert.equal(withShadow.characters, 1000 + 500 + 0 + 200, '影子运行的 chars 也不进真实统计');
    assert.equal(Object.keys(withShadow.byWorkspace).includes('ws-a'), true);
    assert.equal(withShadow.byWorkspace['ws-a'].runs, 2, '影子运行不进 byWorkspace');

    /* 坏行 / 半截追加：跳过，不影响其余统计 */
    const brokenFile = join(home, 'consolidate', 'broken.jsonl');
    writeFileSync(brokenFile, `${JSON.stringify({ ts: T, status: 'OK', calls: 1 })}\n{"half":\n`, 'utf8');
    assert.equal(summarize({ file: brokenFile, days: 7, now: T }).ok, 1);
    assert.equal(readRunRecords(brokenFile).length, 1);

    /* ── 失败可诊断性：detail / gate 都在白名单里（否则会被静默丢掉） ── */
    assert.ok(RECORD_FIELDS.includes('detail'), 'detail 必须在白名单里');
    assert.ok(RECORD_FIELDS.includes('gate'), 'gate 必须在白名单里');

    const diagnoseLog = createRunLog({ file: join(home, 'consolidate', 'diag.jsonl') });
    diagnoseLog.append({
        runId: 'run-diag',
        phase: 'layer1',
        status: 'FAIL',
        reason: 'extract-model-error:LLM_FINISHED_ABORTED',
        detail: `Error: 模型调用未正常结束（error） · finish.kind=error failure.code='' · token: sk-abcdefghijklmnopqrstuvwxyz0123 · ${'长'.repeat(300)}`,
        gate: { total: 4, kept: 1, dropped: 3, placeholder: 1, 'too-short': 1, duplicate: 1, '未知键': 9, content: 1 },
        counts: { candidates: 1 },
    }, T);

    const diag = readLastFailure({ file: join(home, 'consolidate', 'diag.jsonl') });
    assert.equal(diag.reason, 'extract-model-error:LLM_FINISHED_ABORTED', '失败原因要原样读回');
    assert.ok(diag.detail.startsWith('Error: 模型调用未正常结束'), `detail 要含 name: message：${diag.detail}`);
    assert.ok(diag.detail.includes("failure.code=''"), 'detail 要原样带 finish 形状');
    assert.ok(diag.detail.length <= 201, `detail 要截断到 200 字符：${diag.detail.length}`);
    assert.ok(diag.detail.endsWith('…'), '截断要有省略号（看得见被截了）');
    assert.ok(!diag.detail.includes('sk-abcdefghijklmnopqrstuvwxyz0123'), 'detail 必须脱敏');

    const sanitizedGate = sanitizeRecord({ gate: { total: 4, kept: 1, dropped: 3, placeholder: 1, '未知键': 9, content: 1 } }).gate;
    assert.deepEqual(sanitizedGate, { total: 4, kept: 1, dropped: 3, placeholder: 1 }, 'gate 只保留已知原因键（绝不带正文）');

    /* readLastFailure：只挑最近一条 FAIL / TIMEOUT，成功记录不会把它顶掉 */
    const mixedFile = join(home, 'consolidate', 'mixed.jsonl');
    const mixedLog = createRunLog({ file: mixedFile });
    mixedLog.append({ runId: 'm1', status: 'FAIL', reason: 'first-fail', detail: 'first', phase: 'layer1' }, T);
    mixedLog.append({ runId: 'm2', status: 'OK', reason: 'ok', phase: 'layer1' }, T + 1);
    assert.deepEqual(
        (() => { const hit = readLastFailure({ file: mixedFile }); return [hit.reason, hit.detail, hit.runId]; })(),
        ['first-fail', 'first', 'm1'],
        '成功运行不许把上一条失败顶掉',
    );
    mixedLog.append({ runId: 'm3', status: 'TIMEOUT', reason: 'LLM_TIMEOUT', detail: 'second' }, T + 2);
    assert.equal(readLastFailure({ file: mixedFile }).runId, 'm3', 'TIMEOUT 也算失败');
    assert.equal(readLastFailure({ file: join(home, 'consolidate', 'no-such.jsonl') }), null);
    /* ── 当天真实调用统计（跨重启仍然对）：发起次数 / 成功条数 / 昨天不算 ── */
    const dayFile = join(home, 'consolidate', 'day.jsonl');
    const dayLog = createRunLog({ file: dayFile });
    const DAY_NOW = new Date(2026, 10, 9, 12, 0, 0).getTime(); // 本地 2026-11-09 12:00
    const YESTERDAY = DAY_NOW - 24 * 60 * 60 * 1000;
    dayLog.append({ runId: 'd1', phase: 'layer1', status: 'FAIL', reason: 'extract-model-error:LLM_TIMEOUT', calls: 1, durationMs: 20_000 }, DAY_NOW - 3_600_000);
    dayLog.append({ runId: 'd2', phase: 'layer1', status: 'OK', calls: 2, chars: 900 }, DAY_NOW - 60_000);
    dayLog.append({ runId: 'd3', phase: 'layer2', status: 'NOOP', calls: 1 }, DAY_NOW - 30_000);
    dayLog.append({ runId: 'd4', phase: 'layer1', status: 'FAIL', reason: 'old', calls: 5 }, YESTERDAY);

    const day = summarizeDay({ file: dayFile, now: DAY_NOW });
    assert.equal(day.runs, 3, '昨天那条不计入今天');
    assert.equal(day.calls, 4, '发起次数 = 当天 calls 之和（失败也算）');
    assert.equal(day.ok, 1, '成功条数');
    assert.equal(day.fail, 1, '失败条数');
    assert.equal(day.characters, 900);
    assert.ok(day.since <= DAY_NOW && day.since > YESTERDAY);

    const timeoutFailure = readLastFailure({ file: dayFile, now: DAY_NOW });
    assert.equal(timeoutFailure.reason, 'extract-model-error:LLM_TIMEOUT');
    assert.equal(timeoutFailure.durationMs, 20_000, '耗时必须能读回来（判断超时够不够）');
    const legacyFailure = readLastFailure({ file: mixedFile });
    assert.equal(legacyFailure.durationMs, null, '旧记录没有 durationMs ⇒ null（不编造 0）');
} finally {
    cleanup();
}

console.log('✓ runlog.test.mjs 全部通过');
