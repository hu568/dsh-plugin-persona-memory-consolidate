/**
 * L0 暂存层：一行一个回合，append-only（02 §7.0）。
 *
 * 为什么必须有这一层：触发时机（回合结束）与消费门槛（6 轮 / 8000 字符）不一致。
 * 没有暂存层就只能「每次触发都调模型」或「反复回读 zstd 日志」；有了它，
 * **触发是廉价的本地写，花钱只发生在门槛达标那一刻**，崩溃后还能从 pending 恢复。
 *
 * 布局（全部在 `$DSH_HOME/memory/consolidate/pending/` 下）：
 *
 *   pending/<bucket>/<sessionId>.jsonl             ← 活行（含已消费行，`consumed` 区分）
 *   pending/archive/<bucket>/<yyyy-mm>.jsonl       ← 已消费行的归档副本（月文件，只审计）
 *
 * 三条硬规矩：
 *  1. **绝不丢未消费的行**：滚动/压实只处理 `consumed: true` 的行，未消费的原地保留；
 *  2. **绝不重复消费**：`markConsumed` 先原子重写活文件、再追加归档；崩溃在中间时
 *     最多丢一份归档副本（活文件里的 `consumed: true` 仍在，下次滚动会补上），
 *     而**不会**出现「归档说消费了、活文件说没消费」⇒ 同一批回合被抽两次；
 *  3. **绝不因为一份脏文件停摆**：坏行跳过、坏文件当空，读路径一律不抛。
 *
 * 行形状（02 §7.0 原文 + M1 定稿）：
 *
 *   { turn, endedAt, seqFrom, user, assistant, chars, session, cwd,
 *     workspaceId, workspaceTitle, consumed }
 */

import {
    appendFileSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { renameWithRetry } from './atomic.js';

/** 单文件默认上限（02 §7.0「清理」）。 */
export const DEFAULT_MAX_ROWS = 200;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
/** 未消费行默认保留天数（超期丢弃，防死信堆积）。 */
export const DEFAULT_MAX_AGE_DAYS = 30;
/** 归档目录名（`sources.listPendingBuckets` 明确跳过它）。 */
export const ARCHIVE_DIR = 'archive';

/** 桶名归一：空桶名落到 `_unassigned`（与 workspace.js 同口径）。 */
function safeBucket(bucket) {
    const value = typeof bucket === 'string' ? bucket.trim() : '';
    return value === '' ? '_unassigned' : value;
}

/** 会话名归一：宿主 sessionId 不含路径分隔符，但手改/测试输入可能带，兜一下更安全。 */
function safeSession(sessionId) {
    const value = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (value === '') return 'unknown-session';
    return value.replace(/[\\/:*?"<>|]/g, '-');
}

/** 桶目录。 */
export function bucketDir(pendingDir, bucket) {
    return join(pendingDir, safeBucket(bucket));
}

/** 某会话的活文件。 */
export function sessionFile(pendingDir, bucket, sessionId) {
    return join(bucketDir(pendingDir, bucket), `${safeSession(sessionId)}.jsonl`);
}

/** 月键（本地时区，`YYYY-MM`）。 */
export function monthKey(now = Date.now()) {
    const date = new Date(now);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * 归档文件路径：`pending/archive/<bucket>/<yyyy-mm>.jsonl`。
 *
 * 按月分文件（不是按会话）：第二层要按「工作区 + 时间窗」扫已消费素材，
 * 月文件正好是它需要的粒度，也不会像按会话那样散出几百个小文件。
 *
 * @param {string} pendingDir
 * @param {string} bucket
 * @param {number} [now]
 * @returns {string}
 */
export function archivePath(pendingDir, bucket, now = Date.now()) {
    return join(pendingDir, ARCHIVE_DIR, safeBucket(bucket), `${monthKey(now)}.jsonl`);
}

/** 读文件的行（文件不存在 ⇒ []）。 */
function readLines(file) {
    let raw;
    try {
        raw = readFileSync(file, 'utf8');
    } catch {
        return [];
    }
    return raw.split(/\r?\n/).filter((line) => line.trim() !== '');
}

/** 解析一行；坏行 ⇒ null（只跳过这一行，不整份放弃）。 */
function parseRow(line) {
    try {
        const parsed = JSON.parse(line);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed;
    } catch {
        return null;
    }
}

/** 原子重写（临时文件 + rename）：读→写临时→换名，任何一刻中断都不会留下半截文件。 */
function writeLinesAtomic(file, lines) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8');
    renameWithRetry(tmp, file);
    return true;
}

/** 列某个桶里的会话文件（不含 archive）。 */
export function listSessions(pendingDir, bucket) {
    let names;
    try {
        names = readdirSync(bucketDir(pendingDir, bucket));
    } catch {
        return [];
    }
    return names.filter((name) => name.endsWith('.jsonl')).sort();
}

/** 列所有桶目录名（不含 archive）。 */
export function listBuckets(pendingDir) {
    let entries;
    try {
        entries = readdirSync(pendingDir, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter((entry) => entry.isDirectory() && entry.name !== ARCHIVE_DIR)
        .map((entry) => entry.name)
        .sort();
}

/** 一行的字节数（含换行）。 */
function lineBytes(line) {
    return Buffer.byteLength(line, 'utf8') + 1;
}

/* ─────────────────── 会话语义：唯一桶反查（P1-5） ─────────────────── */

/**
 * 某个会话**现在**落在哪些桶里（按行数/未消费数给证据）。
 *
 * 为什么需要这个反查：`bucketForSession()` 在**每个** `turn/end` 上现算一次归属，
 * 一旦中途 `header.cwd` 掉了、工作区被改名/重建，同一会话的后续回合就会落到
 * `_unassigned`。实测本机就是这么裂的：同一会话的 turn 1/2/3 在 `a842ae62…`，
 * turn 4/5/6/8/9/10 在 `_unassigned`，两边都按桶判门槛 ⇒ 同一对话可能被沉淀两次，
 * 或者两边永远都凑不够 `minTurns`。
 *
 * 只认**有内容的文件**：空文件（0 行）不算「这个桶里有这个会话」。
 *
 * @param {string} pendingDir
 * @param {string} sessionId
 * @returns {{ bucket: string, file: string, rows: number, unconsumed: number, lastTurn: number }[]}
 */
export function bucketsForSession(pendingDir, sessionId) {
    const wanted = safeSession(sessionId);
    const out = [];
    for (const bucket of listBuckets(pendingDir)) {
        const file = join(bucketDir(pendingDir, bucket), `${wanted}.jsonl`);
        const lines = readLines(file);
        if (lines.length === 0) continue;
        let rows = 0;
        let unconsumed = 0;
        let lastTurn = 0;
        for (const line of lines) {
            const row = parseRow(line);
            if (row === null) continue;
            rows += 1;
            if (row.consumed !== true) unconsumed += 1;
            const turn = Number.isFinite(row.turn) ? Math.trunc(row.turn) : 0;
            if (turn > lastTurn) lastTurn = turn;
        }
        out.push({ bucket, file, rows, unconsumed, lastTurn });
    }
    return out.sort((left, right) => left.bucket.localeCompare(right.bucket));
}

/**
 * 「会话唯一桶」：追加 L0 前先反查这个会话已经在哪个桶，命中就**沿用旧桶**。
 *
 * 选择顺序（确定性，不依赖 readdir 顺序）：
 *  1. 请求的桶里已经有这个会话 ⇒ 就写这里（无变化）；
 *  2. 否则在别的桶里：优先**未消费行最多**的那个（最需要接着消费），平手按桶名排序；
 *  3. 哪个桶都没有 ⇒ 用请求的桶（新会话）。
 *
 * @param {string} pendingDir
 * @param {string} bucket 请求的桶（现算归属的结果）
 * @param {string} sessionId
 * @returns {{ bucket: string, requested: string, adopted: boolean, buckets: string[] }}
 */
export function resolveBucket(pendingDir, bucket, sessionId) {
    const requested = safeBucket(bucket);
    const found = bucketsForSession(pendingDir, sessionId);
    const names = found.map((item) => item.bucket);
    if (found.length === 0 || names.includes(requested)) {
        return { bucket: requested, requested, adopted: false, buckets: names };
    }
    const chosen = [...found]
        .sort((left, right) => (right.unconsumed - left.unconsumed) || left.bucket.localeCompare(right.bucket))[0];
    return { bucket: chosen.bucket, requested, adopted: true, buckets: names };
}

/**
 * 找出「同一个会话被写进多个桶」的分裂现场（`/memory-consolidate status` 的告警行用它）。
 *
 * @param {string} pendingDir
 * @returns {{ session: string, buckets: string[] }[]}
 */
export function findBucketSplits(pendingDir) {
    const bySession = new Map();
    for (const bucket of listBuckets(pendingDir)) {
        for (const name of listSessions(pendingDir, bucket)) {
            const session = name.replace(/\.jsonl$/u, '');
            if (!bySession.has(session)) bySession.set(session, []);
            bySession.get(session).push(bucket);
        }
    }
    return [...bySession.entries()]
        .filter(([, buckets]) => buckets.length > 1)
        .map(([session, buckets]) => ({ session, buckets: [...buckets].sort() }))
        .sort((left, right) => left.session.localeCompare(right.session));
}

/**
 * 滚动/压实：行数或字节数将超上限时，把**已消费**的行搬进归档，活文件只留未消费行。
 *
 * 为什么不整份搬走：`readUnconsumed` 只读活文件，整份搬走等于把没消费的回合藏进归档
 * ⇒ 那些回合永远等不到消费（02 §7.0「崩溃语义」要求重启后还能继续）。
 * 所以这里只搬 `consumed: true` 的行；如果活文件全是未消费行，就**不滚**（
 * 让 `cleanup()` 的 30 天过期去收尾，宁可文件大一点也不丢数据）。
 *
 * @param {{ file: string, pendingDir: string, bucket: string, maxRows: number, maxBytes: number, incoming: string, now: number }} input
 * @returns {{ rolled: boolean, archived: number, kept: number, reason: string }}
 */
function rollIfNeeded(input) {
    const { file, pendingDir, bucket, maxRows, maxBytes, incoming, now } = input;
    const lines = readLines(file);
    const bytes = lines.reduce((sum, line) => sum + lineBytes(line), 0);
    if (lines.length < maxRows && bytes + lineBytes(incoming) <= maxBytes) {
        return { rolled: false, archived: 0, kept: lines.length, reason: 'within-limit' };
    }

    const consumed = [];
    const alive = [];
    for (const line of lines) {
        const row = parseRow(line);
        if (row?.consumed === true) consumed.push(line);
        else alive.push(line);
    }
    if (consumed.length === 0) {
        // 全是未消费行：不滚（见函数头）。
        return { rolled: false, archived: 0, kept: alive.length, reason: 'nothing-consumed' };
    }

    const archive = archivePath(pendingDir, bucket, now);
    mkdirSync(dirname(archive), { recursive: true });
    appendFileSync(archive, `${consumed.join('\n')}\n`, 'utf8');
    writeLinesAtomic(file, alive);
    return { rolled: true, archived: consumed.length, kept: alive.length, reason: 'rolled' };
}

/**
 * 追加一行（回合结束时的唯一写操作，纯本地、< 1ms、不调模型）。
 *
 * 写失败**不吞**：静默丢一行等于悄悄少沉淀一个回合，让调用方看见错误更好
 * （M2 的触发路径会在 try/catch 里记 debug 日志，绝不拖慢用户请求）。
 *
 * @param {{
 *   pendingDir: string,
 *   bucket: string,
 *   sessionId: string,
 *   row: Record<string, any>,
 *   maxRows?: number,
 *   maxBytes?: number,
 *   now?: number,
 *   sticky?: boolean,
 * }} input
 *   `sticky`：默认 true = **会话唯一桶**（同一个会话已经在别的桶里就沿用旧桶，P1-5）；
 *   传 `false` 才按 `bucket` 硬写（测试/迁移用）。
 * @returns {{
 *   file: string, bucket: string, requestedBucket: string, relocated: boolean,
 *   rolled: boolean, archived: number, rows: number,
 * }}
 */
export function appendRow(input) {
    const { pendingDir, sessionId, row } = input;
    const maxRows = Number.isFinite(input.maxRows) ? Math.max(1, Math.trunc(input.maxRows)) : DEFAULT_MAX_ROWS;
    const maxBytes = Number.isFinite(input.maxBytes) ? Math.max(1024, Math.trunc(input.maxBytes)) : DEFAULT_MAX_BYTES;
    const now = Number.isFinite(input.now) ? input.now : Date.now();

    // P1-5：会话唯一桶。同一个会话绝不再分裂到第二个桶（否则两边各跑一次 L1、
    // 结论重复写、游标双键分裂、任一侧都可能永远凑不够门槛）。
    const resolved = input.sticky === false
        ? { bucket: safeBucket(input.bucket), requested: safeBucket(input.bucket), adopted: false, buckets: [] }
        : resolveBucket(pendingDir, input.bucket, sessionId);
    const bucket = resolved.bucket;
    const file = sessionFile(pendingDir, bucket, sessionId);
    // `session` 由文件路径决定，行里再存一份是为了 archive 里也能独立读懂。
    const record = {
        ...row,
        session: typeof row?.session === 'string' && row.session !== '' ? row.session : safeSession(sessionId),
        consumed: row?.consumed === true,
    };
    const line = JSON.stringify(record);

    const roll = rollIfNeeded({ file, pendingDir, bucket, maxRows, maxBytes, incoming: line, now });
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${line}\n`, 'utf8');
    return {
        file,
        bucket,
        requestedBucket: resolved.requested,
        relocated: resolved.adopted === true,
        rolled: roll.rolled,
        archived: roll.archived,
        rows: roll.kept + 1,
    };
}

/**
 * 读一个桶（或某个会话）的全部行，**包含已消费的**（`{row, file, line}`，行号 1 基）。
 *
 * @param {{ pendingDir: string, bucket: string, sessionId?: string }} input
 * @returns {{ row: Record<string, any>, file: string, line: number }[]}
 */
export function readRows(input) {
    const { pendingDir, bucket, sessionId } = input;
    const files = sessionId === undefined || sessionId === null || sessionId === ''
        ? listSessions(pendingDir, bucket).map((name) => join(bucketDir(pendingDir, bucket), name))
        : [sessionFile(pendingDir, bucket, sessionId)];

    const out = [];
    for (const file of files) {
        const lines = readLines(file);
        lines.forEach((line, index) => {
            const row = parseRow(line);
            if (row !== null) out.push({ row, file, line: index + 1 });
        });
    }
    return out;
}

/**
 * 读一个桶里**未消费**的行，最老的在前。
 *
 * 返回的是**拍平**的行（`{...row, session, file, line}`）：调用方拿它直接喂
 * `extractor.buildConversation()`，不用再 `.row` 一层。
 * 排序键是 `endedAt`（回合结束时间）而不是文件顺序：同一工作区多会话合并消费时
 * 「谁先结束谁先被沉淀」，文件顺序只反映各自会话内的先后。
 *
 * @param {{ pendingDir: string, bucket: string }} input
 * @returns {Record<string, any>[]}
 */
export function readUnconsumed(input) {
    const { pendingDir, bucket } = input;
    const rows = readRows({ pendingDir, bucket })
        .filter((item) => item.row.consumed !== true)
        .map((item) => ({
            ...item.row,
            session: typeof item.row.session === 'string' && item.row.session !== ''
                ? item.row.session
                : String(item.file).split(/[\\/]/).pop().replace(/\.jsonl$/u, ''),
            file: item.file,
            line: item.line,
        }));

    return rows.sort((left, right) => {
        const leftAt = Number.isFinite(left.endedAt) ? left.endedAt : 0;
        const rightAt = Number.isFinite(right.endedAt) ? right.endedAt : 0;
        if (leftAt !== rightAt) return leftAt - rightAt;
        if (left.session !== right.session) return String(left.session).localeCompare(String(right.session));
        return (Number(left.turn) || 0) - (Number(right.turn) || 0);
    });
}

/**
 * 汇总未消费量（消费门槛判定用，02 §6.2）。
 *
 * `turns` 数的是「会话 + 回合」去重后的个数，不是行数：同一会话同一回合被重复写入
 * （重跑、手工补写）时不该把门槛顶高。
 *
 * @param {(Record<string, any> | { row: Record<string, any> })[]} rows
 * @returns {{ turns: number, chars: number }}
 */
export function summarize(rows) {
    const seen = new Set();
    let chars = 0;
    for (const item of rows ?? []) {
        const row = item?.row ?? item;
        if (row === null || typeof row !== 'object') continue;
        const session = String(row.session ?? item?.session ?? '');
        const turn = Number.isFinite(row.turn) ? Math.trunc(row.turn) : -1;
        seen.add(`${session}\u0000${turn}`);
        if (Number.isFinite(row.chars)) chars += Math.trunc(row.chars);
    }
    return { turns: seen.size, chars };
}

/**
 * 把 `turns` 归一成 `[{ session, turn }]`。
 *
 * 接受两种形状：数字（只按回合号匹配，**跨会话有歧义**，只给手工/测试用）与
 * `{session, turn}`（流水线一律用这种：同一工作区的两个会话都可能有第 3 回合）。
 *
 * @param {(number | { session?: string, turn?: number })[]} turns
 * @returns {{ session: string, turn: number }[]}
 */
export function normalizeTurns(turns) {
    const out = [];
    for (const item of Array.isArray(turns) ? turns : []) {
        if (typeof item === 'number' && Number.isFinite(item)) {
            out.push({ session: '', turn: Math.trunc(item) });
            continue;
        }
        if (item === null || typeof item !== 'object') continue;
        if (!Number.isFinite(item.turn)) continue;
        out.push({ session: typeof item.session === 'string' ? item.session.trim() : '', turn: Math.trunc(item.turn) });
    }
    return out;
}

/**
 * 标记已消费：重写受影响会话的活文件（`consumed: true`），并把消费副本追加进归档。
 *
 * **崩溃安全**：每个文件「读 → 写临时 → rename」；顺序是**先重写活文件、后追加归档**。
 * 反过来会制造最坏的时序（归档说消费了、活文件说没消费 ⇒ 同一批回合被抽两次）。
 *
 * **只标记真的写进记忆的行**：调用方（pipeline）只在写入成功后调它，且只传本次
 * 实际喂给抽取的那几行。
 *
 * @param {{
 *   pendingDir: string,
 *   bucket: string,
 *   turns: (number | { session?: string, turn?: number })[],
 *   now?: number,
 * }} input
 * @returns {{ marked: number, archived: number, files: number }}
 */
export function markConsumed(input) {
    const { pendingDir, bucket } = input;
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    const refs = normalizeTurns(input.turns);
    if (refs.length === 0) return { marked: 0, archived: 0, files: 0 };

    // 按会话分组：没有 session 的引用对全桶生效（歧义形状，见 normalizeTurns）。
    const bySession = new Map();
    for (const ref of refs) {
        const key = ref.session === '' ? '' : safeSession(ref.session);
        if (!bySession.has(key)) bySession.set(key, new Set());
        bySession.get(key).add(ref.turn);
    }

    const sessions = bySession.has('')
        ? listSessions(pendingDir, bucket).map((name) => name.replace(/\.jsonl$/u, ''))
        : [...bySession.keys()];

    let marked = 0;
    let files = 0;
    const archivedLines = [];

    for (const session of sessions) {
        const file = join(bucketDir(pendingDir, bucket), `${session}.jsonl`);
        const lines = readLines(file);
        if (lines.length === 0) continue;
        const wanted = bySession.get('') ?? bySession.get(session);
        if (wanted === undefined) continue;

        let changed = false;
        const next = lines.map((line) => {
            const row = parseRow(line);
            if (row === null || row.consumed === true) return line;
            if (!Number.isFinite(row.turn) || !wanted.has(Math.trunc(row.turn))) return line;
            const markedRow = { ...row, consumed: true, consumedAt: now };
            const text = JSON.stringify(markedRow);
            archivedLines.push(text);
            marked += 1;
            changed = true;
            return text;
        });
        if (!changed) continue;
        writeLinesAtomic(file, next);
        files += 1;
    }

    let archived = 0;
    if (archivedLines.length > 0) {
        const archive = archivePath(pendingDir, bucket, now);
        mkdirSync(dirname(archive), { recursive: true });
        appendFileSync(archive, `${archivedLines.join('\n')}\n`, 'utf8');
        archived = archivedLines.length;
    }

    return { marked, archived, files };
}

/**
 * 丢弃过期未消费行（02 §7.0「清理」：超过 `pendingMaxAgeDays` 未消费直接丢弃）。
 *
 * 只丢 `consumed !== true` 且 `endedAt` 早于截止时间的行；已消费行留给滚动/归档。
 * 时间戳缺失的行**不丢**：宁可多留一条脏数据，也别把一条不知道多老的有效回合删掉。
 *
 * @param {{ pendingDir: string, maxAgeDays?: number, now?: number }} input
 * @returns {{ dropped: number, files: number }}
 */
export function cleanup(input) {
    const { pendingDir } = input;
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    const days = Number.isFinite(input.maxAgeDays) ? Math.max(1, input.maxAgeDays) : DEFAULT_MAX_AGE_DAYS;
    const cutoff = now - days * 86_400_000;

    let dropped = 0;
    let files = 0;
    for (const bucket of listBuckets(pendingDir)) {
        for (const name of listSessions(pendingDir, bucket)) {
            const file = join(bucketDir(pendingDir, bucket), name);
            const lines = readLines(file);
            if (lines.length === 0) continue;
            let changed = false;
            const next = [];
            for (const line of lines) {
                const row = parseRow(line);
                if (row !== null && row.consumed !== true && Number.isFinite(row.endedAt) && row.endedAt < cutoff) {
                    dropped += 1;
                    changed = true;
                    continue;
                }
                next.push(line);
            }
            if (!changed) continue;
            writeLinesAtomic(file, next);
            files += 1;
        }
    }
    return { dropped, files };
}
