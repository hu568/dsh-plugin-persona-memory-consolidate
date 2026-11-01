/**
 * 命令处理器：`/memory-consolidate status|dry|run|cross|rollback`。
 *
 * M4 定稿的行为：
 *  - `status`：真读盘摘要 + **上次运行**（runlog 尾行）+ **近 7 天 runlog 汇总** +
 *    水位 + **上次跨会话整理**（`cross-cursor.json`）+ **当前运行档位**；
 *  - `dry`：**强制干跑**——不管 config 里 `dryRun` 是不是 false，`dry` 一律只出报告不落盘；
 *  - `run`：立即跑一次 L1（`config.dryRun` 默认 false ⇒ 默认会写盘）；`mode=observe` 时
 *    走影子（只写 would-write），`mode=off` 时直接拒绝（要正式写先切档）；
 *  - `cross [dry]`：跑 L2（跨桶一遍 + 逐桶各一遍）。不带 `dry` 时跟随 `config.dryRun`
 *    （默认会写盘）与运行档位，带 `dry` 就强制干跑；
 *  - `rollback <runId|last>`：从 `consolidate/backups/<runId>/` 恢复 FACT / JOURNAL / MEMORY。
 *
 * ⚠️ **命令处理器可以是 async**（M1 修正 A0 的错误注释）：宿主对 handler 的调用是
 *
 *     await withAbort(Promise.resolve(handler(invocation)), signal)
 *
 * 所以这里返回 Promise 是合法的，宿主会等它。A0 那句「只接受同步返回」是错的，
 * 而且它逼着 `run` / `rollback` 只能假装成功——M1 起按真实异步实现。
 *
 * 契约不变：**永远返回 `{kind:'success'|'error', text}`，异常绝不穿透到宿主**。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCommand, USAGE } from './command.js';
import { decideCross, readCrossCursor, runL2All, watermarkRatio } from './crosssession.js';
import { backupsDir, crossCursorPath, readCursor } from './cursor.js';
import { AUTO_TRIGGER_READY } from './milestone.js';
import { MODE, resolveMode } from './mode.js';
import { latestRunId, rollbackRun, runAllBuckets } from './pipeline.js';
import { STATUS, readLastRun, successRate, summarize, wouldWritePath } from './runlog.js';
import { listPendingBuckets } from './sources.js';

/** 单文件读多少行就够统计（防止有人在 pending 里塞了巨型文件把命令卡住）。 */
const MAX_ROWS_SCANNED = 5000;

/** 计数 → 中文标签（回显用；没有对应数字就不显示）。 */
const COUNT_LABEL = {
    written: '新增',
    replaced: '替换',
    deleted: '删除',
    demoted: '降级 JOURNAL',
    dropped: '丢弃',
    noop: '无变化',
    dry: '干跑未写',
    failed: '失败',
    // 影子档：本来会写的算子数（不是真实写入，绝不混进「新增」）。
    observed: '影子预览',
};

/** 这些跳过原因意味着「本该干活但没干成」，命令要报 error 而不是 success。 */
const FAILED_SKIPS = ['extract-failed', 'merge-failed', 'store-unavailable', 'no-model', 'error'];

/**
 * 统计一个 pending 桶：会话数 / 未消费行数 / 字符数。
 *
 * @param {string} dir pending 目录。
 * @param {{ workspaceId: string, sessions: string[] }[]} buckets
 * @returns {{ sessions: number, rows: number, chars: number, orphan: number }}
 */
export function scanPending(dir, buckets = []) {
    let sessions = 0;
    let rows = 0;
    let chars = 0;
    for (const bucket of buckets) {
        for (const session of bucket.sessions) {
            sessions += 1;
            let raw = '';
            try {
                raw = readFileSync(join(dir, bucket.workspaceId, session), 'utf8');
            } catch {
                continue;
            }
            const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-MAX_ROWS_SCANNED);
            for (const line of lines) {
                rows += 1;
                try {
                    const record = JSON.parse(line);
                    if (record?.consumed === true) continue;
                    if (Number.isFinite(record?.chars)) chars += Number(record.chars);
                } catch {
                    /* 坏行只计数，不算字符 */
                }
            }
        }
    }
    const cursor = readCursor();
    const orphan = buckets.filter((bucket) => !Object.keys(cursor.sessions ?? {}).some((key) => key.startsWith(`${bucket.workspaceId}:`))).length;
    return { sessions, rows, chars, orphan };
}

/** 一行「上次运行」（runlog 尾行，读不到就说从未）。 */
export function renderLastRun(runtime) {
    const last = readLastRun({ file: runtime.runLog?.path });
    if (last === null) return '上次运行：从未（本机还没有 runlog 记录）';
    const at = Number.isFinite(last.ts) ? new Date(last.ts).toLocaleString() : '时间未知';
    const counts = last.counts ?? {};
    const detail = Object.entries(COUNT_LABEL)
        .filter(([key]) => Number.isFinite(counts[key]) && counts[key] > 0)
        .map(([key, label]) => `${label} ${counts[key]}`)
        .join(' / ');
    const parts = [
        `上次运行：${at} · ${last.status ?? '?'} · ${last.bucket ?? last.workspaceId ?? '—'}`,
        `${last.turns ?? 0} 轮 / ${last.chars ?? 0} 字符`,
        `${last.calls ?? 0} 次调用`,
    ];
    if (detail !== '') parts.push(detail);
    parts.push(`runId ${last.runId ?? '—'}`);
    return parts.join(' · ');
}

/** 百分比（0–1 → `53%`）。 */
function percent(ratio) {
    const value = Number.isFinite(ratio) ? Math.round(ratio * 100) : 0;
    return `${value}%`;
}

/** 一行水位：`FACT 45 行 / 4261 B（53%）`（拿不到水位就不显示）。 */
export function renderWatermarkLine(store) {
    if (store === null || store === undefined || typeof store.watermark !== 'function') return '';
    const parts = [];
    for (const [name, scope] of [['FACT', 'fact'], ['MEMORY', 'memory']]) {
        let mark;
        try {
            mark = store.watermark(scope, {});
        } catch {
            mark = null;
        }
        if (mark === null || typeof mark !== 'object') continue;
        const size = Number.isFinite(mark.chars) && mark.chars > 0
            ? `${mark.chars} 字符`
            : `${Number.isFinite(mark.bytes) ? mark.bytes : 0} B`;
        const lines = Number.isFinite(mark.lines) ? `${mark.lines} 行 / ` : '';
        parts.push(`${name} ${lines}${size}（${percent(watermarkRatio(mark))}）`);
    }
    return parts.length === 0 ? '' : `水位：${parts.join(' · ')}`;
}

/** 一行「近 7 天 runlog 汇总」（M5）：次数 / 成功率 / NOOP 比例 / 降级 / 丢弃 / 平均调用。 */
export function renderRunlogSummary(runtime) {
    const summary = summarize({ file: runtime.runLog?.path, days: 7 });
    if (summary.runs === 0 && summary.observed === 0) return '近 7 天：没有运行记录';
    const parts = [];
    if (summary.runs > 0) {
        parts.push(`${summary.runs} 次 / 成功 ${percent(successRate(summary))} / NOOP ${percent(summary.noopRatio)}`
            + ` / 降级 ${summary.demoted} / 丢弃 ${summary.dropped} / 平均 ${summary.avgCalls} 次调用`
            + ` / ${summary.characters} 字符`);
    }
    // 影子运行单独报：它一个字节都没写，混进上面的成功率会把真实写入质量稀释成假象。
    if (summary.observed > 0) parts.push(`影子 ${summary.observed} 次（本来会写 ${summary.wouldWrite} 条）`);
    return `近 7 天：${parts.join('；')}`;
}

/** 档位的中文标签（status 与命令回显共用）。 */
export function renderModeLabel(mode) {
    if (mode === MODE.OFF) return '关闭（off，完全静默）';
    if (mode === MODE.OBSERVE) return '影子模式（observe，真跑但只记 would-write）';
    return '正式写入（auto）';
}

/** 一行「今天的影子文件有多少行」（跑过影子才有，没跑过不显示）。 */
export function renderWouldWriteLine(now = Date.now()) {
    const file = wouldWritePath(now);
    let lines = 0;
    try {
        lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '').length;
    } catch {
        return '';
    }
    return `影子文件：${file}（今天 ${lines} 行）`;
}

/** 一行「上次跨会话整理」（`cross-cursor.json`）。 */
export function renderLastCross(runtime) {
    const cursor = readCrossCursor(runtime.crossCursorFile ?? crossCursorPath());
    if (cursor.lastRunAt === 0) return '上次跨会话整理：从未';
    const at = new Date(cursor.lastRunAt).toLocaleString();
    return `上次跨会话整理：${at} · runId ${cursor.lastRunId === '' ? '—' : cursor.lastRunId}`;
}

/**
 * 状态报告（纯文本，给命令回显与人工排查）。**控制在 25 行以内**（M5 的可读性要求）。
 *
 * @param {Record<string, any>} runtime
 * @param {{ store?: any }} [extras] `store` 只用来显示水位（拿不到就不显示那一行）。
 * @returns {string}
 */
export function renderStatus(runtime, extras = {}) {
    const { config } = runtime;
    const buckets = listPendingBuckets(runtime.pendingDir);
    const stats = scanPending(runtime.pendingDir, buckets);
    const budget = runtime.budget.snapshot();
    const crossVerdict = decideCross({
        lastRunAt: runtime.cross.lastRunAt,
        newEntries: runtime.cross.lastCount,
        config,
        manual: false,
    });
    const lines = [
        `运行档位：${renderModeLabel(resolveMode(config))} / 自动沉淀开关：${config.enabled === false ? '关' : '开'}`
            + `${config.dryRun ? ' · 干跑中（不落盘）' : ''}`,
        `暂存：${runtime.pendingDir}`,
        `桶 ${buckets.length} 个 / 会话 ${stats.sessions} 个 / 未消费 ${stats.rows} 行 / 约 ${stats.chars} 字符`,
        `消费门槛：${config.minTurns} 轮 或 ${config.minChars} 字符（先到先算）`,
        `今日 LLM 调用：${budget.used.total}/${budget.used.total + budget.remaining}（第一层 ${budget.used.layer1}，第二层 ${budget.used.layer2}）`,
        `跨会话：${config.crossEnabled ? `开启（源 ${config.crossSource}），上次 ${runtime.cross.lastRunAt === 0 ? '从未' : new Date(runtime.cross.lastRunAt).toLocaleString()}，判定 ${crossVerdict.reason}` : '关闭'}`,
        `自动触发：${AUTO_TRIGGER_READY ? '已接线' : '未接线（M1：事件只空转，等 M2）'}`,
        `模型接线：${typeof runtime.extractor?.extract === 'function' ? '已接（命令触发时创建）' : '命令执行时创建'}`,
        renderRunlogSummary(runtime),
        renderLastCross(runtime),
    ];
    const shadowLine = renderWouldWriteLine();
    if (shadowLine !== '') lines.push(shadowLine);
    const watermark = renderWatermarkLine(extras.store);
    if (watermark !== '') lines.push(watermark);
    lines.push(renderLastRun(runtime));
    return lines.join('\n');
}

/**
 * 一次 L1 运行的文本报告。
 *
 * @param {Record<string, any>} result `runAllBuckets()` 的返回。
 * @param {boolean} dryRun
 * @param {{ observe?: boolean }} [options] 影子档：报告头与结尾都换成「只记 would-write」。
 */
export function renderRunResult(result, dryRun, options = {}) {
    const observe = options.observe === true || result?.observe === true;
    const lines = [dryRun
        ? '干跑（不落盘）：管线照跑，写入只记 DRY'
        : (observe
            ? '影子模式（observe，不落盘）：管线真跑（真调 LLM / 真打码 / 真校验），本来会写什么见 would-write'
            : '立即沉淀（会写盘）：成功才标记消费')];

    if (result.skipped === 'empty') {
        lines.push('没有待沉淀的暂存行（pending 里没有未消费回合）。');
        return lines.join('\n');
    }
    if (result.skipped === 'budget') {
        lines.push(`预算/单飞拒绝：${result.reason}（今日额度用完、已有运行在跑，或正在退避冷却）。`);
        return lines.join('\n');
    }

    for (const run of result.runs ?? []) {
        const name = run.title === '' ? run.bucket : `${run.bucket}「${run.title}」`;
        if (run.skipped !== undefined && run.skipped !== null) {
            lines.push(`- ${name}：跳过（${run.skipped}${run.reason ? ` · ${run.reason}` : ''}）`);
            continue;
        }
        lines.push(`- ${name}：${run.turns} 轮 / ${run.chars} 字符 → ${run.candidates} 条候选 → ${run.ops} 个算子（${run.calls} 次调用）`);
        const detail = Object.entries(COUNT_LABEL)
            .filter(([key]) => Number.isFinite(run.counts?.[key]) && run.counts[key] > 0)
            .map(([key, label]) => `${label} ${run.counts[key]}`);
        if (detail.length > 0) lines.push(`  写入结果：${detail.join(' / ')}`);
        if (typeof run.snapshot === 'string' && run.snapshot !== '') lines.push(`  快照：${run.snapshot}`);
        if (observe && typeof run.wouldWrite?.file === 'string' && run.wouldWrite.file !== '') {
            lines.push(`  影子文件：${run.wouldWrite.file}（${run.wouldWrite.lines} 行）`);
        }
    }

    const runs = result.runs ?? [];
    const totalCalls = runs.reduce((sum, run) => sum + (Number(run.calls) || 0), 0);
    lines.push('');
    lines.push(`runId=${result.runId} · ${runs.length} 个桶 / ${totalCalls} 次调用`);
    if (dryRun) lines.push('（干跑：暂存行仍是未消费，关掉 dryRun 后再跑一次才会真正落盘）');
    else if (observe) lines.push('（影子：FACT / MEMORY / JOURNAL 一个字节都没写；素材已按 auto 口径消费并推进游标，切到 auto 后不会补写这批）');
    lines.push('细则见 /memory-consolidate status');
    return lines.join('\n');
}

/** 运行结果该报 success 还是 error（失败绝不包装成成功）。 */
export function verdictOf(result) {
    if (result?.skipped === 'budget') return 'error';
    const runs = Array.isArray(result?.runs) ? result.runs : [];
    if (runs.some((run) => FAILED_SKIPS.includes(run?.skipped) || run?.status === 'FAIL')) return 'error';
    return 'success';
}

/** 一次 L2 运行的文本报告（`/memory-consolidate cross [dry]`）。 */
export function renderCrossResult(result, dryRun, options = {}) {
    const observe = options.observe === true || result?.observe === true;
    const lines = [dryRun
        ? '跨会话整理（干跑，不落盘）：素材照读、prompt 照发，写入只记 DRY'
        : (observe
            ? '跨会话整理（observe，不落盘）：素材照读、prompt 照发，本来会写什么见 would-write'
            : '跨会话整理（会写盘）：成功才推进跨会话游标')];

    if (result?.skipped !== undefined && result?.skipped !== null) {
        const reason = String(result.reason ?? '');
        if (result.skipped === 'trigger') {
            lines.push(`本次不跑：${reason}（关掉 crossEnabled、或距上次不到 ${result?.interval ?? '24'} 小时且新增素材没到门槛）`);
        } else if (result.skipped === 'budget') {
            lines.push(`预算/单飞拒绝：${reason}（今天的第二层额度用完，或已有运行在跑）`);
        } else if (result.skipped === 'store-unavailable') {
            lines.push('跳过：主插件 store 不可用（没装 0.7.0 的 ./store 子路径）。');
        } else {
            lines.push(`跳过（${result.skipped}）${reason === '' ? '' : `：${reason}`}`);
        }
        lines.push('细则见 /memory-consolidate status');
        return lines.join('\n');
    }

    const runs = Array.isArray(result?.runs) ? result.runs : [];
    if (runs.length === 0) {
        lines.push('没有可整理的桶（pending 里还没有已消费素材）。');
        lines.push('细则见 /memory-consolidate status');
        return lines.join('\n');
    }

    for (const run of runs) {
        const name = run.bucket === '' ? '跨桶（只产出 global）' : (run.bucketTitle === '' ? run.bucket : `${run.bucket}「${run.bucketTitle}」`);
        if (run.skipped !== undefined && run.skipped !== null) {
            lines.push(`- ${name}：跳过（${run.skipped}${run.reason ? ` · ${run.reason}` : ''}）`);
            continue;
        }
        const counts = run.counts ?? {};
        lines.push(`- ${name}：升格 ${counts.promoted ?? 0} 条 / 失效 ${counts.superseded ?? 0} 条 / 跳过 ${counts.skipped ?? 0} 条`
            + ` → ${run.status ?? '?'}（${run.calls ?? 0} 次调用）`);
        const detail = Object.entries(COUNT_LABEL)
            .filter(([key]) => Number.isFinite(counts[key]) && counts[key] > 0)
            .map(([key, label]) => `${label} ${counts[key]}`);
        if (detail.length > 0) lines.push(`  写入结果：${detail.join(' / ')}`);
        if (Array.isArray(run.supersededIds) && run.supersededIds.length > 0) {
            // 只回显 id：被失效的条目正文不进命令回显（02 §7.6）。
            lines.push(`  失效 id：${run.supersededIds.slice(0, 6).join(', ')}${run.supersededIds.length > 6 ? ' …' : ''}`);
        }
        if (typeof run.snapshot === 'string' && run.snapshot !== '') lines.push(`  快照：${run.snapshot}`);
        if (observe && typeof run.wouldWrite?.file === 'string' && run.wouldWrite.file !== '') {
            lines.push(`  影子文件：${run.wouldWrite.file}（${run.wouldWrite.lines} 行）`);
        }
    }

    const totalCalls = runs.reduce((sum, run) => sum + (Number(run.calls) || 0), 0);
    lines.push('');
    lines.push(`runId=${result.runId} · ${runs.length} 段 / ${totalCalls} 次调用 · 总状态 ${result.status ?? '?'}`);
    if (dryRun) lines.push('（干跑：跨会话游标没有推进，关掉 dryRun 后再跑一次才会真正落盘）');
    else if (observe) lines.push('（影子：没写 FACT / MEMORY / JOURNAL；跨会话游标已按 auto 口径推进，切到 auto 后不会重跑这批）');
    lines.push('细则见 /memory-consolidate status');
    return lines.join('\n');
}

/** L2 运行结果该报 success 还是 error。 */
export function crossVerdictOf(result) {
    if (result?.status === STATUS.FAIL) return 'error';
    if (result?.skipped === 'budget' || result?.skipped === 'error' || result?.skipped === 'store-unavailable') return 'error';
    const runs = Array.isArray(result?.runs) ? result.runs : [];
    if (runs.some((run) => run?.status === STATUS.FAIL)) return 'error';
    return 'success';
}

/**
 * 造命令处理器。
 *
 * @param {Record<string, any>} runtime `index.createRuntime()` 的产物。
 * @param {{ logger?: any, prepare?: () => void | Promise<void> }} [options]
 *   `prepare`：命令执行**前**的接线动作（`index.js` 用它把真实 `callModel` / `extractor`
 *   装进 runtime）。放在这里而不是启动期，是为了「没人在用命令时零开销」。
 * @returns {{
 *   handle: (invocation?: { rawInput?: string }) => Promise<{ kind: 'success' | 'error', text: string }>,
 *   status: () => Promise<any>, dry: () => Promise<any>, run: () => Promise<any>,
 *   cross: () => Promise<any>, rollback: (args?: string[]) => Promise<any>,
 * }}
 */
export function createCommands(runtime, options = {}) {
    const logger = options.logger;
    const prepare = options.prepare;

    const status = async () => {
        // 水位要 store 才读得到：拿不到就是没有那一行，绝不让 status 因此失败。
        let store = null;
        try {
            store = typeof runtime.resolveStore === 'function' ? await runtime.resolveStore() : (runtime.store ?? null);
        } catch {
            store = null;
        }
        return { kind: 'success', text: renderStatus(runtime, { store }) };
    };

    /** `run` / `dry` 共用的执行体。`forceDry === true` 时无视 config 强制干跑。 */
    const execute = async (forceDry) => {
        const mode = resolveMode(runtime.config ?? {});
        // `off` 档 = 完全静默（等价 enabled=false）：手动 `run` 也不许正式写入，
        // 否则「关掉了却还在写 FACT」比不提供开关更糟。`dry` 仍然可用（只读）。
        if (forceDry !== true && mode === MODE.OFF) {
            return {
                kind: 'error',
                text: `当前运行档位是 off（完全静默），拒绝正式写入。\n`
                    + `要写入请先把「设置 → 记忆 → 自动沉淀 → 运行档位」切到 auto（或 observe 先看影子）。\n`
                    + `只看报告不改文件可以用 /memory-consolidate dry。`,
            };
        }
        if (typeof prepare === 'function') {
            try {
                await prepare();
            } catch (error) {
                return { kind: 'error', text: `模型接线失败：${String(error?.message ?? error)}` };
            }
        }
        const dryRun = forceDry === true || runtime.config?.dryRun !== false;
        const result = await runAllBuckets({ runtime, dryRun });
        const observe = dryRun !== true && mode === MODE.OBSERVE;
        return { kind: verdictOf(result), text: renderRunResult(result, dryRun, { observe }) };
    };

    const dry = async () => execute(true);
    const run = async () => execute(false);

    /**
     * `cross [dry]`：L2 全套（跨桶一遍 + 逐桶一遍）。
     *
     * 手动触发 ⇒ `manual: true`（绕过 24h / 20 条门槛），但**绕不过**预算与单飞锁。
     */
    const cross = async (args = []) => {
        if (runtime.config?.crossEnabled === false) {
            return { kind: 'error', text: `跨会话整理已关闭（crossEnabled=false）。\n${USAGE}` };
        }
        const forceDry = (Array.isArray(args) ? args : []).some((arg) => String(arg).toLowerCase() === 'dry');
        const mode = resolveMode(runtime.config ?? {});
        // 与 `run` 同口径：off 档不许正式写入（`cross dry` 仍然可用）。
        if (!forceDry && mode === MODE.OFF) {
            return {
                kind: 'error',
                text: `当前运行档位是 off（完全静默），拒绝正式写入。\n`
                    + `要看 L2 会写什么请切到 observe，或用 /memory-consolidate cross dry（只读报告）。`,
            };
        }
        if (typeof prepare === 'function') {
            try {
                await prepare();
            } catch (error) {
                return { kind: 'error', text: `模型接线失败：${String(error?.message ?? error)}` };
            }
        }
        const dryRun = forceDry || runtime.config?.dryRun !== false;
        const result = await runL2All({ runtime, dryRun, manual: true });
        const observe = dryRun !== true && mode === MODE.OBSERVE;
        return { kind: crossVerdictOf(result), text: renderCrossResult(result, dryRun, { observe }) };
    };

    const rollback = async (args = []) => {
        let runId = String(args[0] ?? '').trim();
        if (runId === '') {
            return { kind: 'error', text: `回滚需要 runId 或 last。\n${USAGE}` };
        }
        if (runId === 'last') {
            const latest = latestRunId({ dir: runtime.backupsDir ?? backupsDir() });
            if (latest === '') {
                return { kind: 'error', text: `没有可回滚的快照：${runtime.backupsDir ?? backupsDir()} 为空（干跑不建快照）。` };
            }
            runId = latest;
        }

        const result = rollbackRun({ runId, runtime });
        if (result.error !== undefined) {
            const skipped = Array.isArray(result.skipped) && result.skipped.length > 0
                ? `\n${result.skipped.map((item) => `- 跳过 ${item.target}（${item.reason}）`).join('\n')}`
                : '';
            return { kind: 'error', text: `回滚失败（${result.error}）：runId=${runId}${skipped}` };
        }

        const skipped = result.skipped.length > 0
            ? `\n${result.skipped.map((item) => `- 跳过 ${item.target}（${item.reason}）`).join('\n')}`
            : '';
        return {
            kind: 'success',
            text: `已回滚 ${result.restored.length} 个文件（runId=${runId}）：\n${result.restored.map((file) => `- ${file}`).join('\n')}${skipped}`,
        };
    };

    const table = { status, dry, run, cross, rollback };

    return {
        status,
        dry,
        run,
        cross,
        rollback,
        /**
         * 宿主 entry point（async：宿主 `await withAbort(Promise.resolve(handler(...)), signal)`）。
         *
         * @param {{ rawInput?: string, agent?: any }} [invocation]
         * @returns {Promise<{ kind: 'success' | 'error', text: string }>}
         */
        async handle(invocation) {
            const parsed = decodeCommand(invocation?.rawInput);
            if (!parsed.known) {
                return { kind: 'error', text: `未知子命令「${parsed.subcommand}」。\n${USAGE}` };
            }
            try {
                const result = await table[parsed.subcommand](parsed.args);
                logger?.info?.(`[persona-memory-consolidate] 命令 ${parsed.subcommand} → ${result.kind}`);
                return result;
            } catch (error) {
                // 命令失败只回显，绝不让异常穿透到宿主。
                logger?.warn?.(`[persona-memory-consolidate] 命令 ${parsed.subcommand} 抛错：${String(error?.message ?? error)}`);
                return { kind: 'error', text: `命令执行失败：${String(error?.message ?? error)}` };
            }
        },
    };
}
