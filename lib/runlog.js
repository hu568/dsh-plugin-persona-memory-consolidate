/**
 * 运行日志：`$DSH_HOME/memory/consolidate/runs.jsonl`（一行一次运行/一个阶段）。
 *
 * 三条约束（02 §4.3「绝不落盘的三处」+ §7.4）：
 *  1. **只写结构化摘要**：`{runId, ts, phase, status, counts, reason, watermarks}` 等；
 *     条目正文一个字都不进 runlog（正文在 pending / FACT / JOURNAL 里）；
 *  2. **永不含密文**：所有字符串字段仍然过一遍 `validate.redact()`，命中就整段换成
 *     占位符——这一层是「上游已经打过码」之后的保险，不是主防线；
 *  3. **体积安全**：追加前看文件大小，超过上限就滚动成 `.1` / `.2`（保留 maxFiles 份），
 *     免得三周后 runs.jsonl 变成几百 MB。
 *
 * 写日志失败**永不抛**：观测手段不能反过来把主流程弄挂。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renameWithRetry } from './atomic.js';
import { consolidateDir } from './cursor.js';
import { redact } from './validate.js';

/** 运行状态（写进 runlog，字符串稳定）。 */
export const STATUS = {
    OK: 'OK',
    DRY: 'DRY',
    SKIPPED: 'SKIPPED',
    NOOP: 'NOOP',
    DEMOTED: 'DEMOTED',
    DROPPED: 'DROPPED',
    REDACTED: 'REDACTED',
    FAIL: 'FAIL',
    TIMEOUT: 'TIMEOUT',
};

/** 允许落盘的字段（白名单：不在表里的键直接丢，防止有人顺手把 entry 塞进来）。 */
export const RECORD_FIELDS = [
    'runId', 'ts', 'phase', 'status', 'reason', 'counts', 'watermarks',
    'source', 'workspaceId', 'bucket', 'turns', 'chars', 'durationMs', 'hits', 'calls',
    // L2 只落 **id**（`supersededIds`）：被失效的条目正文一个字都不进 runlog（02 §7.6）。
    'supersededIds',
];
/** `counts` 的子键白名单。 */
export const COUNT_FIELDS = [
    'candidates', 'ops', 'written', 'replaced', 'deleted', 'demoted', 'dropped', 'noop', 'failed', 'redacted',
    // L2（M4）新增：升格 / 失效 / 跳过，全部是计数，不含内容。
    'promoted', 'superseded', 'skipped',
];

/** `watermarks` 的子键白名单（`store.watermark()` 的形状）。 */
export const WATERMARK_FIELDS = ['fact', 'memory'];

/** 单文件上限 4 MB；保留 3 份（≈ 12 MB 上限，个人使用几个月不用管）。 */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 3;

/** runs.jsonl 路径。 */
export function runsPath(home) {
    return join(consolidateDir(home), 'runs.jsonl');
}

/** `superseded.jsonl` 路径（被覆盖的旧值，只审计、不进任何检索）。 */
export function supersededPath(home) {
    return join(consolidateDir(home), 'superseded.jsonl');
}

/** 字符串字段的统一处理：打码 → 截断。 */
function cleanString(value, maxChars = 200) {
    const text = String(value ?? '');
    const masked = redact(text);
    const out = masked.drop ? '[redacted]' : masked.text;
    return out.length > maxChars ? `${out.slice(0, maxChars)}…` : out;
}

/**
 * 归一化一条记录：白名单 + 打码 + 只留标量。
 *
 * @param {Record<string, any>} record
 * @param {number} [now]
 * @returns {Record<string, any>}
 */
export function sanitizeRecord(record = {}, now = Date.now()) {
    const out = {};
    for (const key of RECORD_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
        const value = record[key];
        if (value === undefined || value === null) continue;
        if (key === 'counts') {
            const counts = {};
            for (const field of COUNT_FIELDS) {
                if (Number.isFinite(value?.[field])) counts[field] = Number(value[field]);
            }
            if (Object.keys(counts).length > 0) out.counts = counts;
            continue;
        }
        if (key === 'watermarks') {
            const watermarks = {};
            for (const field of WATERMARK_FIELDS) {
                const mark = value?.[field];
                if (mark === undefined || mark === null) continue;
                watermarks[field] = {
                    lines: Number.isFinite(mark.lines) ? Number(mark.lines) : 0,
                    bytes: Number.isFinite(mark.bytes) ? Number(mark.bytes) : 0,
                    chars: Number.isFinite(mark.chars) ? Number(mark.chars) : 0,
                    limit: Number.isFinite(mark.limit) ? Number(mark.limit) : 0,
                };
            }
            if (Object.keys(watermarks).length > 0) out.watermarks = watermarks;
            continue;
        }
        if (typeof value === 'number') {
            if (Number.isFinite(value)) out[key] = value;
            continue;
        }
        if (typeof value === 'boolean') {
            out[key] = value;
            continue;
        }
        if (Array.isArray(value)) {
            // 数组只可能是 `supersededIds` 这类短 id 列表：每项过一遍打码再截到 40 字符，
            // 上限放宽到 24 项是为了让「每次最多失效 20 条」的 id 能完整落盘。
            out[key] = value
                .filter((item) => typeof item === 'string' || typeof item === 'number')
                .slice(0, 24)
                .map((item) => (typeof item === 'string' ? cleanString(item, 40) : item));
            continue;
        }
        out[key] = cleanString(value, key === 'reason' ? 120 : 200);
    }
    if (!Number.isFinite(out.ts)) out.ts = now;
    return out;
}

/**
 * 造一个 runlog 写入器。
 *
 * @param {{ file?: string, maxBytes?: number, maxFiles?: number }} [options]
 * @returns {{ append: (record: Record<string, any>, now?: number) => boolean, path: string, rotate: () => boolean }}
 */
export function createRunLog(options = {}) {
    const file = options.file ?? runsPath();
    const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES;
    const maxFiles = Number.isFinite(options.maxFiles) ? Number(options.maxFiles) : DEFAULT_MAX_FILES;

    /** 滚动：`runs.jsonl` → `.1` → `.2` …，最旧的一份删掉。 */
    const rotate = () => {
        try {
            for (let index = maxFiles - 1; index >= 1; index -= 1) {
                const from = index === 1 ? file : `${file}.${index - 1}`;
                const to = `${file}.${index}`;
                if (!existsSync(from)) continue;
                if (existsSync(to)) rmSync(to, { force: true });
                renameWithRetry(from, to);
            }
            return true;
        } catch {
            return false;
        }
    };

    return {
        path: file,
        rotate,
        /**
         * 追加一行（JSONL）。**不抛**；返回是否写成。
         *
         * @param {Record<string, any>} record
         * @param {number} [now]
         * @returns {boolean}
         */
        append(record, now = Date.now()) {
            const line = `${JSON.stringify(sanitizeRecord(record, now))}\n`;
            try {
                mkdirSync(dirname(file), { recursive: true });
                let size = 0;
                try {
                    size = statSync(file).size;
                } catch {
                    size = 0;
                }
                if (size + Buffer.byteLength(line) > maxBytes) rotate();
                appendFileSync(file, line, 'utf8');
                return true;
            } catch {
                return false;
            }
        },
    };
}

/**
 * 便利函数：直接往默认 runs.jsonl 追加一条。**不抛**。
 *
 * @param {Record<string, any>} record
 * @param {{ file?: string, now?: number, maxBytes?: number, maxFiles?: number }} [options]
 * @returns {boolean}
 */
export function appendRun(record, options = {}) {
    const log = createRunLog({ file: options.file, maxBytes: options.maxBytes, maxFiles: options.maxFiles });
    return log.append(record, Number.isFinite(options.now) ? options.now : Date.now());
}

/**
 * 读最后一条运行记录（`/memory-consolidate status` 显示「上次运行」用）。
 *
 * 从尾部往前找第一条能解析的行：滚动/半截追加都可能留下坏尾行，但那不该让
 * 「上次运行」这块信息整块消失。**永不抛**，读不到就返回 null。
 *
 * @param {{ file?: string, maxScanLines?: number }} [options]
 * @returns {Record<string, any> | null}
 */
export function readLastRun(options = {}) {
    const file = options.file ?? runsPath();
    const maxScan = Number.isFinite(options.maxScanLines) ? Math.max(1, Math.trunc(options.maxScanLines)) : 50;
    let raw;
    try {
        raw = readFileSync(file, 'utf8');
    } catch {
        return null;
    }
    const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
    const tail = lines.slice(-maxScan);
    for (let index = tail.length - 1; index >= 0; index -= 1) {
        try {
            const parsed = JSON.parse(tail[index]);
            if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed) === false) return parsed;
        } catch {
            /* 坏行跳过 */
        }
    }
    return null;
}

/** 汇总默认窗口（天）：`/status` 看「最近一周」够用了（02 §9 M5）。 */
export const DEFAULT_SUMMARY_DAYS = 7;

/**
 * 读 runs.jsonl 全部记录（含滚动的 `.1` / `.2` / `.3`；坏行跳过）。**不抛**。
 *
 * 为什么要读滚动文件：一次跨会话整理一天就能写十几条，7 天窗口很容易横跨一次滚动，
 * 只看主文件会让「近 7 天」凭空变少。
 *
 * @param {string} file
 * @returns {Record<string, any>[]}
 */
export function readRunRecords(file = runsPath()) {
    const files = [];
    for (let index = DEFAULT_MAX_FILES - 1; index >= 1; index -= 1) files.push(`${file}.${index}`);
    files.push(file);
    const records = [];
    for (const target of files) {
        let raw;
        try {
            raw = readFileSync(target, 'utf8');
        } catch {
            continue;
        }
        for (const line of raw.split(/\r?\n/)) {
            if (line.trim() === '') continue;
            try {
                const parsed = JSON.parse(line);
                if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed) === false) records.push(parsed);
            } catch {
                /* 坏行跳过（半截追加是常态） */
            }
        }
    }
    return records;
}

/** 比值保留三位小数（面板与断言里都不想要 0.3333333333333333）。 */
function ratio3(numerator, denominator) {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
    return Math.round((numerator / denominator) * 1000) / 1000;
}

/** 一次调用次数：记录里的 `calls`（缺省 0）。 */
function callsOf(record) {
    return Number.isFinite(record?.calls) ? Number(record.calls) : 0;
}

/**
 * runlog 汇总（02 §9 M5「次数 / 成功率 / 字符 / NOOP 比例」）。
 *
 * 口径说明（写在这里，免得以后两次统计对不上）：
 *  - `runs` = 窗口内的记录条数（一次运行可能有多行：每桶一行 + 每段一行，L1/L2 都如此）；
 *  - `ok` = `status === 'OK'`，`dry` = `'DRY'`，`fail` = `'FAIL'` / `'TIMEOUT'`，两者都不进 `ok`；
 *  - `noopRatio` = (`NOOP` + `SKIPPED`) / `runs`：对「花了钱什么也没改」的观测来说，
 *    「跳过」和「无变化」是同一件事，分两个字段只会让人自己加错；
 *  - `characters` = 窗口内 `chars` 之和（L1 的输入字符；L2 记录不带 `chars`，不参与）；
 *  - `demoted` / `dropped` = `counts.demoted` / `counts.dropped` 之和（撞限降级、敏感串丢弃）；
 *  - `avgCalls` 保留两位小数；`lastRunAt` 是窗口内最新 `ts`（窗口内无记录 ⇒ 0）。
 *
 * @param {{ file?: string, days?: number, now?: number }} [options]
 * @returns {{
 *   runs: number, ok: number, fail: number, dry: number, characters: number,
 *   noopRatio: number, demoted: number, dropped: number, avgCalls: number,
 *   lastRunAt: number, byWorkspace: Record<string, { runs: number, ok: number, fail: number, dry: number, characters: number, demoted: number }>,
 * }}
 */
export function summarize(options = {}) {
    const file = options.file ?? runsPath();
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    const days = Number.isFinite(options.days) ? Number(options.days) : DEFAULT_SUMMARY_DAYS;
    const cutoff = days > 0 ? now - days * 86_400_000 : Number.NEGATIVE_INFINITY;

    const records = readRunRecords(file).filter((record) => {
        if (!Number.isFinite(record?.ts)) return false;
        return days > 0 ? record.ts >= cutoff && record.ts <= now : true;
    });

    const summary = {
        runs: records.length,
        ok: 0,
        fail: 0,
        dry: 0,
        characters: 0,
        noopRatio: 0,
        demoted: 0,
        dropped: 0,
        avgCalls: 0,
        lastRunAt: 0,
        byWorkspace: {},
    };

    let noop = 0;
    let calls = 0;
    for (const record of records) {
        const status = String(record?.status ?? '');
        if (status === STATUS.OK) summary.ok += 1;
        else if (status === STATUS.DRY) summary.dry += 1;
        else if (status === STATUS.FAIL || status === STATUS.TIMEOUT) summary.fail += 1;
        else if (status === STATUS.NOOP || status === STATUS.SKIPPED) noop += 1;

        if (Number.isFinite(record?.chars)) summary.characters += Number(record.chars);
        if (Number.isFinite(record?.counts?.demoted)) summary.demoted += Number(record.counts.demoted);
        if (Number.isFinite(record?.counts?.dropped)) summary.dropped += Number(record.counts.dropped);
        calls += callsOf(record);
        if (Number.isFinite(record?.ts) && record.ts > summary.lastRunAt) summary.lastRunAt = Number(record.ts);

        const workspaceId = String(record?.workspaceId ?? '');
        if (workspaceId !== '') {
            const bucket = summary.byWorkspace[workspaceId] ?? { runs: 0, ok: 0, fail: 0, dry: 0, characters: 0, demoted: 0 };
            bucket.runs += 1;
            if (status === STATUS.OK) bucket.ok += 1;
            else if (status === STATUS.DRY) bucket.dry += 1;
            else if (status === STATUS.FAIL || status === STATUS.TIMEOUT) bucket.fail += 1;
            if (Number.isFinite(record?.chars)) bucket.characters += Number(record.chars);
            if (Number.isFinite(record?.counts?.demoted)) bucket.demoted += Number(record.counts.demoted);
            summary.byWorkspace[workspaceId] = bucket;
        }
    }

    summary.noopRatio = ratio3(noop, summary.runs);
    summary.avgCalls = summary.runs === 0 ? 0 : Math.round((calls / summary.runs) * 100) / 100;
    return summary;
}

/** 成功率（0–1，三位小数；`runs === 0` ⇒ 0）。面板与命令回显共用。 */
export function successRate(summary) {
    const runs = Number(summary?.runs ?? 0);
    if (!Number.isFinite(runs) || runs <= 0) return 0;
    return ratio3(Number(summary?.ok ?? 0), runs);
}

