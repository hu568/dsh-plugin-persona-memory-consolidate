/**
 * 第二层（跨会话整理）的**数据源三档**：`journal`（默认）/ `service` / `files`。
 *
 * 依据 02 §3.1 / §7.1 的实测与拍板：
 *  - **C 档 journal 是默认**：自家文件、零依赖。跨会话的目标是「同一事实不要散落」，
 *    不是「读遍所有历史原文」——第一层已经把结论写进 JOURNAL，第二层读它就够做频次升格。
 *  - **A 档 service**：M0 §3 复核结论是「组外 `ctx.get('sessionQuery')` 不是 undefined」，
 *    宿主那份 `openAt: never` 的实例**精确读可用**（`listSessions` / `readSession`），
 *    只有 `searchSessions` / `searchEvents` 会抛 `SESSION_QUERY_SEARCH_DISABLED`。
 *    所以这一档只做精确读，不做排名检索（也不假装能做）。
 *  - **B 档 files**：`session.v4.jsonl.zstd` 是**多帧 zstd**（M0 §5：20/20 样本、3140 帧、
 *    0 帧失败）。按 magic `28 B5 2F FD` 切帧、逐帧解压；失败帧跳过并计数，
 *    失败率 > 5% 整档降级（02 §11 风险表）。
 *
 * 三档的共同契约：`available()` 说能不能用，`list()` 永远返回
 * `{ok, source, entries, reason}` 而不是抛错——**降级链靠返回值，不靠异常**。
 *
 * `auto` 的降级链是 `service → journal`：**绝不自动退到 files**（02 §7.1 的体量实测：
 * 全量 284.7 MB，自动扫描会拖垮一次后台整理）。`files` 只在你明确配置时才用。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { dshHome } from './cursor.js';
import { entryId } from './merger.js';

/** 数据源名（与 `config.crossSource` 同词表）。 */
export const SOURCE = { JOURNAL: 'journal', SERVICE: 'service', FILES: 'files', AUTO: 'auto' };

/** 02 §7.1：JOURNAL 只读最近 30 条、每条截断 200 字符（≈6,000 字符，与 8000 预算相容）。 */
export const DEFAULT_TAIL = 30;
export const DEFAULT_PER_ENTRY_CHARS = 200;
/** 02 §8：`crossScanEntries` 默认 200（尾部位置的上限，不是要全读）。 */
export const DEFAULT_SCAN_ENTRIES = 200;
/** 02 §8：`files` 档硬限（同一 cwd + 近 7 天 + 最多 20 个会话）。 */
export const DEFAULT_MAX_SESSIONS = 20;
export const DEFAULT_LOOKBACK_DAYS = 7;
/** 单次素材字符上限（与 `maxSampleChars` 同口径）。 */
export const DEFAULT_MAX_CHARS = 8000;
/** 一个会话文件最多读多少条事件（尾部保留；单会话实测 40–7000 条）。 */
export const DEFAULT_MAX_EVENTS = 400;
/** 失败帧容忍度（02 §11：成功率 < 95% 整档禁用）。 */
export const MAX_FRAME_FAILURE_RATE = 0.05;

/**
 * 降级链：首选失败就按这个顺序退，最后一定落到 journal。
 *
 * ⚠️ `auto` **不含 files**：见文件头。
 */
export const CHAIN = {
    journal: [SOURCE.JOURNAL],
    service: [SOURCE.SERVICE, SOURCE.JOURNAL],
    files: [SOURCE.FILES, SOURCE.JOURNAL],
    auto: [SOURCE.SERVICE, SOURCE.JOURNAL],
};

/**
 * 取降级链。
 *
 * @param {string} preferred `config.crossSource`
 * @returns {string[]}
 */
export function sourceChain(preferred) {
    const key = String(preferred ?? '').trim().toLowerCase();
    return CHAIN[key] ?? CHAIN[SOURCE.JOURNAL];
}

/** 截断一条素材（第二层只当索引看，不需要全文）。 */
export function truncateEntry(entry, perEntryChars = DEFAULT_PER_ENTRY_CHARS) {
    const text = String(entry?.text ?? '').trim();
    const clipped = text.length > perEntryChars ? `${text.slice(0, perEntryChars)}…` : text;
    return {
        id: String(entry?.id ?? ''),
        ts: typeof entry?.ts === 'string' || Number.isFinite(entry?.ts) ? entry.ts : '',
        text: clipped,
        tags: Array.isArray(entry?.tags) ? entry.tags.slice(0, 8).map(String) : [],
        /** 素材出处：`journal` | `service` | `files`（只有 journal 的 id 能交给 supersedeJournal）。 */
        origin: String(entry?.origin ?? ''),
        workspaceId: String(entry?.workspaceId ?? ''),
        session: String(entry?.session ?? ''),
    };
}

/* ────────────────────────────── C 档：JOURNAL ────────────────────────────── */

/**
 * C 档：JOURNAL 总线（默认）。
 *
 * @param {{ store?: any, getStore?: () => Promise<any | null>, tail?: number, perEntryChars?: number }} [options]
 */
export function createJournalSource(options = {}) {
    const tail = Number.isFinite(options.tail) ? options.tail : DEFAULT_TAIL;
    const perEntryChars = Number.isFinite(options.perEntryChars) ? options.perEntryChars : DEFAULT_PER_ENTRY_CHARS;
    // store 可能是懒解析的（主插件未装时永远拿不到），所以 available() 只看形状，
    // 真正取用放在 list() 里 await。
    const readStore = async () => {
        if (options.store !== undefined && options.store !== null) return options.store;
        if (typeof options.getStore === 'function') {
            try {
                return (await options.getStore()) ?? null;
            } catch {
                return null;
            }
        }
        return null;
    };

    return {
        kind: SOURCE.JOURNAL,
        available() {
            return true;
        },
        /**
         * @param {{ limit?: number }} [input]
         * @returns {Promise<{ ok: boolean, source: string, entries: any[], reason: string }>}
         */
        async list(input = {}) {
            const limit = Number.isFinite(input.limit) ? Math.max(1, Math.trunc(input.limit)) : tail;
            const store = await readStore();
            try {
                let raw;
                if (typeof store?.listJournal === 'function') {
                    raw = await store.listJournal({ tail: limit, includeArchived: false });
                } else if (typeof store?.readJournal === 'function') {
                    const read = await store.readJournal(limit);
                    raw = Array.isArray(read) ? read : (Array.isArray(read?.entries) ? read.entries : []);
                } else {
                    return { ok: false, source: SOURCE.JOURNAL, entries: [], reason: 'journal-api-missing' };
                }
                const list = Array.isArray(raw) ? raw.slice(-limit) : [];
                return {
                    ok: true,
                    source: SOURCE.JOURNAL,
                    entries: list.map((entry) => truncateEntry({ ...entry, origin: SOURCE.JOURNAL }, perEntryChars)),
                    reason: 'ok',
                };
            } catch {
                return { ok: false, source: SOURCE.JOURNAL, entries: [], reason: 'journal-read-failed' };
            }
        },
    };
}

/* ────────────────────────────── 事件 → 素材 ────────────────────────────── */

/**
 * 从会话事件流取正文素材（02 §7.1 取样表的**第二层口径**）。
 *
 * 与第一层的区别：第一层按回合配对（用户问题 + 本轮结论），第二层只想要「出现过的话」，
 * 所以逐条取 `user/message`（`source.kind === 'user'`）与 `assistant/message` 的 `text` 块，
 * 各成一条素材——「同一结论在两个会话各出现一次」就是两条同样的素材，频次升格才数得出来。
 *
 * 预算：单条截断 `perEntryChars`，总量到 `maxChars` 就从**尾部**（最近的素材）往回取，
 * 保证 8000 字符预算里装的是最新的话。
 *
 * @param {any[]} events
 * @param {{
 *   origin?: string, session?: string, workspaceId?: string,
 *   perEntryChars?: number, maxChars?: number,
 * }} [options]
 * @returns {{ id: string, ts: number | string, text: string, tags: string[], origin: string, workspaceId: string, session: string }[]}
 */
export function entriesFromEvents(events, options = {}) {
    const perEntryChars = Number.isFinite(options.perEntryChars) ? options.perEntryChars : DEFAULT_PER_ENTRY_CHARS;
    const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : DEFAULT_MAX_CHARS;
    const origin = String(options.origin ?? '');
    const session = String(options.session ?? '');
    const workspaceId = String(options.workspaceId ?? '');
    const list = Array.isArray(events) ? events : [];

    const collected = [];
    let used = 0;
    for (let index = list.length - 1; index >= 0; index -= 1) {
        const event = list[index];
        const type = String(event?.type ?? '');
        if (type !== 'user/message' && type !== 'assistant/message') continue;
        const message = event?.data?.message ?? event?.message ?? null;
        if (message === null || typeof message !== 'object') continue;
        if (type === 'user/message' && String(message?.source?.kind ?? 'user') !== 'user') continue;
        const content = Array.isArray(message?.content) ? message.content : [];
        const blocks = [];
        for (const block of content) {
            if (String(block?.type ?? '') !== 'text') continue;
            const text = String(block?.text ?? '').trim();
            if (text !== '') blocks.push(text);
        }
        if (blocks.length === 0) continue;
        const text = blocks.join('\n');
        const clipped = text.length > perEntryChars ? text.slice(0, perEntryChars) : text;
        if (used + clipped.length > maxChars) {
            // 预算已满：**第一条**（也就是最新的一条）哪怕超预算也要截一段留下，
            // 否则「预算 < 单条长度」时素材会整段为空，第二层就白跑了。
            if (collected.length === 0 && maxChars > 0) {
                const slice = clipped.slice(0, maxChars);
                collected.unshift({
                    id: entryId(slice),
                    ts: Number.isFinite(event?.time) ? Number(event.time) : (typeof event?.time === 'string' ? event.time : ''),
                    text: slice,
                    tags: type === 'user/message' ? ['user'] : ['assistant'],
                    origin,
                    workspaceId,
                    session,
                });
            }
            break;
        }
        used += clipped.length;
        collected.unshift({
            id: entryId(clipped),
            ts: Number.isFinite(event?.time) ? Number(event.time) : (typeof event?.time === 'string' ? event.time : ''),
            text: clipped,
            tags: type === 'user/message' ? ['user'] : ['assistant'],
            origin,
            workspaceId,
            session,
        });
    }
    return collected;
}

/** 事件里的 cwd（会话头里只有 cwd、没有 workspaceId；02 §7.0 注释）。 */
export function sessionCwdOf(events) {
    for (const event of Array.isArray(events) ? events : []) {
        const candidates = [
            event?.data?.cwd,
            event?.data?.header?.cwd,
            event?.header?.cwd,
            event?.data?.message?.cwd,
        ];
        for (const value of candidates) {
            if (typeof value === 'string' && value.trim() !== '') return value.trim();
        }
    }
    return '';
}

/** cwd 归一（Windows 大小写/分隔符都不敏感；空串 = 不过滤）。 */
export function normalizeCwd(cwd) {
    return String(cwd ?? '').trim().replace(/\//g, '\\').replace(/\\+$/u, '').toLowerCase();
}

/* ────────────────────────────── A 档：sessionQuery ────────────────────────────── */

/** 会话对象 → id（宿主可能给 `{id}` / `{sessionId}` / 裸字符串）。 */
function sessionIdOf(item) {
    if (typeof item === 'string') return item.trim();
    if (item === null || typeof item !== 'object') return '';
    for (const key of ['id', 'sessionId', 'session']) {
        const value = item[key];
        if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return '';
}

/** 会话对象 → 排序用的时间（拿不到就是 0）。 */
function sessionTimeOf(item) {
    if (item === null || typeof item !== 'object') return 0;
    for (const key of ['updatedAt', 'lastActivityAt', 'lastMessageAt', 'mtime', 'createdAt']) {
        const value = item[key];
        if (Number.isFinite(value)) return Number(value);
        if (typeof value === 'string' && value.trim() !== '') {
            const parsed = Date.parse(value);
            if (Number.isFinite(parsed)) return parsed;
        }
    }
    return 0;
}

/**
 * A 档：`ctx.sessionQuery` 的**精确读**（M0 §3：组外可用，`openAt: never` 也能读）。
 *
 * 只调 `listSessions()` / `readSession(id)`——**绝不调 `searchSessions` / `searchEvents`**
 * （那两个在 `openAt: never` 的实例上必抛 `SESSION_QUERY_SEARCH_DISABLED`）。
 *
 * @param {{
 *   sessionQuery?: any,
 *   getSessionQuery?: () => any,
 *   maxSessions?: number,
 *   perEntryChars?: number,
 *   maxChars?: number,
 *   now?: number,
 *   maxEvents?: number,
 * }} [options]
 */
export function createServiceSource(options = {}) {
    const maxSessions = Number.isFinite(options.maxSessions) ? Math.max(1, Math.trunc(options.maxSessions)) : DEFAULT_MAX_SESSIONS;
    const perEntryChars = Number.isFinite(options.perEntryChars) ? options.perEntryChars : DEFAULT_PER_ENTRY_CHARS;
    const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : DEFAULT_MAX_CHARS;

    /** 取服务（可能是懒注入；任何异常都当没有）。 */
    const resolveService = () => {
        if (options.sessionQuery !== undefined && options.sessionQuery !== null) return options.sessionQuery;
        if (typeof options.getSessionQuery === 'function') {
            try {
                return options.getSessionQuery() ?? null;
            } catch {
                return null;
            }
        }
        return null;
    };

    return {
        kind: SOURCE.SERVICE,
        available() {
            const service = resolveService();
            return service !== null && service !== undefined && typeof service.listSessions === 'function';
        },
        /**
         * @param {{ limit?: number, cwd?: string }} [input]
         * @returns {Promise<{ ok: boolean, source: string, entries: any[], reason: string, attempted?: number, failed?: number }>}
         */
        async list(input = {}) {
            const service = resolveService();
            if (service === null || service === undefined || typeof service.listSessions !== 'function') {
                return { ok: false, source: SOURCE.SERVICE, entries: [], reason: 'service-unavailable' };
            }

            let sessions;
            try {
                sessions = await service.listSessions();
            } catch {
                return { ok: false, source: SOURCE.SERVICE, entries: [], reason: 'service-list-failed' };
            }
            const rows = (Array.isArray(sessions) ? sessions : [])
                .map((item, index) => ({ id: sessionIdOf(item), at: sessionTimeOf(item), index }))
                .filter((row) => row.id !== '')
                // 最新的优先；时间全为 0 时保持宿主给的顺序。
                .sort((left, right) => right.at - left.at || left.index - right.index)
                .slice(0, maxSessions);

            const entries = [];
            let failed = 0;
            let used = 0;
            for (const row of rows) {
                if (typeof service.readSession !== 'function') {
                    failed += 1;
                    continue;
                }
                let read;
                try {
                    read = await service.readSession(row.id);
                } catch {
                    failed += 1;
                    continue;
                }
                const events = Array.isArray(read) ? read : (Array.isArray(read?.events) ? read.events : []);
                if (events.length === 0) continue;
                const cwd = sessionCwdOf(events);
                const wanted = normalizeCwd(input.cwd);
                if (wanted !== '' && normalizeCwd(cwd) !== wanted) continue;
                const room = Math.max(0, maxChars - used);
                if (room <= 0) break;
                const part = entriesFromEvents(events, {
                    origin: SOURCE.SERVICE,
                    session: row.id,
                    perEntryChars,
                    maxChars: room,
                });
                used += part.reduce((sum, entry) => sum + entry.text.length, 0);
                entries.push(...part);
            }

            if (entries.length === 0 && failed > 0) {
                return { ok: false, source: SOURCE.SERVICE, entries: [], reason: 'service-read-failed', attempted: rows.length, failed };
            }
            return { ok: true, source: SOURCE.SERVICE, entries, reason: 'ok', attempted: rows.length, failed };
        },
    };
}

/* ────────────────────────────── B 档：会话文件 ────────────────────────────── */

/** 多帧 zstd 的帧头 magic（M0 §5 实测：28 B5 2F FD）。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** zstd 解压是否可用（node 22 才有；没有就整档降级）。 */
export function hasZstd() {
    return typeof zlib.zstdDecompressSync === 'function';
}

/**
 * 按 magic 切帧。
 *
 * 启发式（02 §3.2 风险更正）：压缩数据内部理论上可能撞上同样 4 字节。实测 3140 帧 0 误判，
 * 而且逐帧解压 + CRC 自检会把误判暴露成「失败帧」——所以误判的后果是**被计数**，
 * 不是静默吞掉。
 *
 * @param {Buffer} buffer
 * @returns {{ frames: Buffer[], prefix: number }} `prefix` = 第一个 magic 之前的字节数。
 */
export function splitZstdFrames(buffer) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
    const starts = [];
    let at = buf.indexOf(ZSTD_MAGIC, 0);
    while (at !== -1) {
        starts.push(at);
        at = buf.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length);
    }
    const frames = [];
    for (let index = 0; index < starts.length; index += 1) {
        const end = index + 1 < starts.length ? starts[index + 1] : buf.length;
        frames.push(buf.subarray(starts[index], end));
    }
    return { frames, prefix: starts.length === 0 ? buf.length : starts[0] };
}

/**
 * 多帧解压（逐帧 `zstdDecompressSync`，失败帧跳过并计数）。
 *
 * @param {Buffer} buffer
 * @returns {{ text: string, frames: number, failed: number, failureRate: number }}
 */
export function decodeMultiFrame(buffer) {
    const { frames, prefix } = splitZstdFrames(buffer);
    const chunks = [];
    let failed = 0;
    if (prefix > 0) failed += 1; // magic 之前的残片也算一帧失败（宁可降级，不猜）
    for (const frame of frames) {
        try {
            chunks.push(zlib.zstdDecompressSync(frame));
        } catch {
            failed += 1;
        }
    }
    const total = frames.length + (prefix > 0 ? 1 : 0);
    return {
        text: Buffer.concat(chunks).toString('utf8'),
        frames: total,
        failed,
        failureRate: total === 0 ? 1 : failed / total,
    };
}

/**
 * 读一个 `session.v4.jsonl.zstd`（**纯函数式导出**：给定路径就有结果，不依赖闭包状态）。
 *
 * 失败帧容忍：失败率 > 5% ⇒ `{ok:false, reason:'decode-degraded'}`，调用方据此整档降级
 * （02 §11「成功率 < 95% 则整档禁用」）。
 *
 * @param {string} file
 * @param {{ maxEvents?: number }} [options] 只保留**尾部** maxEvents 条（最近的事件）。
 * @returns {{
 *   ok: boolean, reason: string, path: string, events: any[],
 *   frames: number, failed: number, failureRate: number, totalEvents: number, chars: number,
 * }}
 */
export function readSessionFile(file, options = {}) {
    const maxEvents = Number.isFinite(options.maxEvents) ? Math.max(1, Math.trunc(options.maxEvents)) : DEFAULT_MAX_EVENTS;
    const path = String(file ?? '');
    const empty = { path, events: [], frames: 0, failed: 0, failureRate: 1, totalEvents: 0, chars: 0 };

    if (!hasZstd()) return { ...empty, ok: false, reason: 'zstd-unavailable' };

    let buffer;
    try {
        buffer = readFileSync(path);
    } catch {
        return { ...empty, ok: false, reason: 'read-failed' };
    }

    const decoded = decodeMultiFrame(buffer);
    const meta = { path, frames: decoded.frames, failed: decoded.failed, failureRate: decoded.failureRate, chars: decoded.text.length };
    if (decoded.frames === 0) return { ...empty, ...meta, ok: false, reason: 'no-frame' };
    if (decoded.failureRate > MAX_FRAME_FAILURE_RATE) {
        return { ...empty, ...meta, ok: false, reason: 'decode-degraded' };
    }

    const events = [];
    for (const line of decoded.text.split(/\r?\n/)) {
        if (line.trim() === '') continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed !== null && typeof parsed === 'object') events.push(parsed);
        } catch {
            // 坏行只丢这一行（与 JOURNAL 同款容忍度）。
        }
    }
    return {
        ok: true,
        reason: 'ok',
        ...meta,
        events: events.slice(-maxEvents),
        totalEvents: events.length,
    };
}

/**
 * 列 `$DSH_HOME/sessions/<cwd编码>/<session-id>/session.v4.jsonl.zstd`。
 *
 * @param {string} sessionsDir
 * @returns {{ file: string, bucket: string, sessionId: string, mtime: number }[]}
 */
export function listSessionFiles(sessionsDir) {
    let buckets;
    try {
        buckets = readdirSync(sessionsDir, { withFileTypes: true });
    } catch {
        return [];
    }
    const out = [];
    for (const bucket of buckets) {
        if (!bucket.isDirectory()) continue;
        const dir = join(sessionsDir, bucket.name);
        let names;
        try {
            names = readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const name of names) {
            if (!name.isDirectory()) continue;
            const file = join(dir, name.name, 'session.v4.jsonl.zstd');
            if (!existsSync(file)) continue;
            let mtime = 0;
            try {
                mtime = statSync(file).mtimeMs;
            } catch {
                mtime = 0;
            }
            out.push({ file, bucket: bucket.name, sessionId: name.name, mtime });
        }
    }
    return out.sort((left, right) => right.mtime - left.mtime || left.file.localeCompare(right.file));
}

/**
 * B 档：直读会话文件（`session.v4.jsonl.zstd`，多帧）。
 *
 * 硬限（02 §7.1）：**同一 cwd + 近 `crossLookbackDays` 天 + 最多 `crossMaxSessions` 个会话**。
 * 「同一 cwd」靠解出来的 `session` 头比对（目录名是 cwd 的编码，编码方式没写进任何文档，
 * 不去猜它）；为了不把整个 sessions 目录解一遍，先按 mtime 筛窗口、再最多解
 * `maxSessions × 3` 个文件——这个上界就是「拖不垮」的全部保证。
 *
 * @param {{
 *   sessionsDir?: string, cwd?: string, lookbackDays?: number, maxSessions?: number,
 *   perEntryChars?: number, maxChars?: number, maxEvents?: number, now?: number,
 * }} [options]
 */
export function createFilesSource(options = {}) {
    const sessionsDir = typeof options.sessionsDir === 'string' && options.sessionsDir !== ''
        ? options.sessionsDir
        : join(dshHome(), 'sessions');
    const maxSessions = Number.isFinite(options.maxSessions) ? Math.max(1, Math.trunc(options.maxSessions)) : DEFAULT_MAX_SESSIONS;
    const lookbackDays = Number.isFinite(options.lookbackDays) ? Math.max(1, options.lookbackDays) : DEFAULT_LOOKBACK_DAYS;
    const perEntryChars = Number.isFinite(options.perEntryChars) ? options.perEntryChars : DEFAULT_PER_ENTRY_CHARS;
    const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : DEFAULT_MAX_CHARS;
    const cwd = typeof options.cwd === 'string' ? options.cwd : '';

    return {
        kind: SOURCE.FILES,
        limits: { maxSessions, lookbackDays, cwd },
        available() {
            return hasZstd() && existsSync(sessionsDir);
        },
        /**
         * @param {{ limit?: number, cwd?: string, now?: number }} [input]
         * @returns {Promise<{ ok: boolean, source: string, entries: any[], reason: string, attempted?: number, failed?: number, degraded?: boolean }>}
         */
        async list(input = {}) {
            if (!hasZstd()) return { ok: false, source: SOURCE.FILES, entries: [], reason: 'zstd-unavailable' };
            if (!existsSync(sessionsDir)) return { ok: false, source: SOURCE.FILES, entries: [], reason: 'sessions-dir-missing' };

            const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
            const cutoff = now - lookbackDays * 86_400_000;
            const wanted = normalizeCwd(typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : cwd);
            const candidates = listSessionFiles(sessionsDir)
                .filter((item) => !Number.isFinite(cutoff) || item.mtime >= cutoff)
                .slice(0, maxSessions * 3);

            const entries = [];
            let attempted = 0;
            let failed = 0;
            let frames = 0;
            let failedFrames = 0;
            let matched = 0;
            let used = 0;
            for (const item of candidates) {
                if (matched >= maxSessions) break;
                const room = Math.max(0, maxChars - used);
                if (room <= 0) break;
                attempted += 1;
                const read = readSessionFile(item.file, { maxEvents: options.maxEvents });
                // 逐帧统计：整档失败率按**帧**算（02 §11 说的是「成功率 < 95%」，不是「坏文件 < 5%」）。
                frames += Number.isFinite(read.frames) ? read.frames : 0;
                failedFrames += Number.isFinite(read.failed) ? read.failed : 0;
                if (read.ok !== true) {
                    failed += 1;
                    continue;
                }
                const sessionCwd = sessionCwdOf(read.events);
                if (wanted !== '' && normalizeCwd(sessionCwd) !== wanted) continue;
                const part = entriesFromEvents(read.events, {
                    origin: SOURCE.FILES,
                    session: item.sessionId,
                    perEntryChars,
                    maxChars: room,
                });
                if (part.length === 0) continue;
                matched += 1;
                used += part.reduce((sum, entry) => sum + entry.text.length, 0);
                entries.push(...part);
            }

            const failureRate = frames === 0 ? (attempted === 0 ? 0 : 1) : failedFrames / frames;
            const degraded = frames > 0 ? failureRate > MAX_FRAME_FAILURE_RATE : attempted > 0;
            if (degraded) {
                // 02 §11：「成功率 < 95% 则整档禁用」——宁可退到 JOURNAL，也不拿半截日志当证据。
                return {
                    ok: false, source: SOURCE.FILES, entries: [], reason: 'decode-degraded',
                    attempted, failed, frames, failedFrames, failureRate, degraded: true,
                };
            }
            return { ok: true, source: SOURCE.FILES, entries, reason: 'ok', attempted, failed, frames, failedFrames, failureRate, degraded: false };
        },
    };
}

/* ────────────────────────────── 降级链 ────────────────────────────── */

/**
 * 按降级链取素材：**第一个 `ok:true` 的源赢**，其余记进 `attempts`（runlog 用）。
 *
 * @param {{ preferred?: string, sources: Record<string, any> }} options
 * @returns {{ list: (input?: { limit?: number, cwd?: string, now?: number }) => Promise<{ ok: boolean, source: string, entries: any[], reason: string, attempts: { source: string, ok: boolean, reason: string }[] }> }}
 */
export function createSourceChain(options) {
    const sources = options.sources ?? {};
    const chain = sourceChain(options.preferred);

    return {
        chain,
        async list(input = {}) {
            const attempts = [];
            for (const kind of chain) {
                const source = sources[kind];
                if (source === undefined) {
                    attempts.push({ source: kind, ok: false, reason: 'unknown-source' });
                    continue;
                }
                if (typeof source.available === 'function' && !source.available()) {
                    attempts.push({ source: kind, ok: false, reason: 'unavailable' });
                    continue;
                }
                const result = await source.list(input);
                attempts.push({ source: kind, ok: result.ok === true, reason: result.reason });
                if (result.ok === true) {
                    return { ...result, attempts };
                }
            }
            return { ok: false, source: 'none', entries: [], reason: 'all-sources-failed', attempts };
        },
    };
}

/**
 * 列 `pending/<bucket>/` 的所有桶（逐 workspace 桶迭代，02 §7.0 / §7.6）。
 *
 * @param {string} pendingDir `$DSH_HOME/memory/consolidate/pending`
 * @returns {{ workspaceId: string, sessions: string[] }[]}
 */
export function listPendingBuckets(pendingDir) {
    let names;
    try {
        names = readdirSync(pendingDir, { withFileTypes: true });
    } catch {
        return [];
    }
    const buckets = [];
    for (const name of names) {
        if (!name.isDirectory()) continue;
        if (name.name === 'archive') continue;
        let sessions = [];
        try {
            sessions = readdirSync(join(pendingDir, name.name))
                .filter((file) => file.endsWith('.jsonl'))
                .sort();
        } catch {
            sessions = [];
        }
        buckets.push({ workspaceId: name.name, sessions });
    }
    return buckets.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
}
