/**
 * runlog：结构白名单、脱敏、滚动、写不进去也不抛（02 §4.3 / §7.4）。
 *
 * 跑法：node test/runlog.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendRun, createRunLog, readRunRecords, runsPath, sanitizeRecord, successRate, summarize, supersededPath } from '../lib/runlog.js';
import { makeHome } from './_helpers.mjs';

const { home, cleanup } = makeHome('pmc-runlog');
try {
    const file = runsPath();
    assert.ok(file.endsWith(join('memory', 'consolidate', 'runs.jsonl')), `实际路径：${file}`);
    assert.ok(supersededPath().endsWith(join('consolidate', 'superseded.jsonl')));

    /* 一条正常记录 */
    const log = createRunLog({ file });
    assert.equal(log.append({
        runId: 'run-1',
        phase: 'layer1',
        status: 'OK',
        reason: 'min-turns',
        counts: { candidates: 3, ops: 2, written: 1, demoted: 1 },
        watermarks: { fact: { lines: 45, bytes: 4261, chars: 4261, limit: 8000 } },
        durationMs: 1234,
    }, 1_800_000_000_000), true);

    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.runId, 'run-1');
    assert.equal(record.ts, 1_800_000_000_000);
    assert.equal(record.counts.candidates, 3);
    assert.equal(record.watermarks.fact.bytes, 4261);
    assert.equal(record.durationMs, 1234);

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
        demoted: 0, dropped: 0, avgCalls: 0, lastRunAt: 0, byWorkspace: {},
    });
    assert.equal(successRate(emptySummary), 0, '没有运行 ⇒ 成功率 0（不除以 0）');

    /* 坏行 / 半截追加：跳过，不影响其余统计 */
    const brokenFile = join(home, 'consolidate', 'broken.jsonl');
    writeFileSync(brokenFile, `${JSON.stringify({ ts: T, status: 'OK', calls: 1 })}\n{"half":\n`, 'utf8');
    assert.equal(summarize({ file: brokenFile, days: 7, now: T }).ok, 1);
    assert.equal(readRunRecords(brokenFile).length, 1);
} finally {
    cleanup();
}

console.log('✓ runlog.test.mjs 全部通过');
