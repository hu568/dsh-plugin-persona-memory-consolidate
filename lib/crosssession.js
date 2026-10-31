/**
 * 第二层（L2）跨会话整理：什么时候跑、跑哪些桶、哪些结论够格升格、哪些 JOURNAL 条目该失效。
 *
 * 拍板（02 §7.6 / §7.3.4）：
 *  - **逐 workspace 桶执行**，绝不跨桶聚合出一份「项目记忆」；
 *  - **跨桶只允许产出 `global`**（FACT），不产出 `project`；
 *  - `_unassigned` 桶不参与 project 归并，只贡献 journal / global；
 *  - 频次升格门槛 `crossPromoteHits`（默认 2）：出现 ≥2 次才算稳定事实；
 *  - JOURNAL 失效**只交 id 与理由**给主插件的 `supersedeJournal`，每次最多 20 条。
 *
 * 一次运行只有**一次 LLM 调用**，它同时回答三件事（02 §7.6 + §7.3.4）：
 *
 *   promote   → 在素材里出现 ≥ minHits 次的结论 → 稳定事实（走 merger + writer，layer:2）
 *   supersede → 与现行 FACT/MEMORY **直接矛盾**的 JOURNAL 条目 id（交主插件归档）
 *   retire    → 现行 FACT/MEMORY 里已被证明错误的条目 id（第二层才允许 DELETE）
 *
 * 为什么把裁决也塞进这一次调用：`mergeCandidates` 在归一化相似度 `[0.45,0.95)` 时还要
 * 一次裁决调用，而 L2 的预算只有「每天 10 次第二层调用」（02 §7.5）。所以 L2 的升格
 * 只走**确定性预筛**（`merger.topNeighbors` + `merger.preScreen`）：完全相同 / ≥0.95 判
 * NOOP，其余按 ADD——「出现过 ≥2 次」的结论偏向记下来，真重复会在下一轮预筛变成 NOOP。
 * 这是本节唯一一处对「一次调用」的硬解释，写在这里免得以后有人以为漏了裁决。
 *
 * 失败语义（02 §9 M4「回滚后 SHA256 一致」与「失败重试」）：
 *  - 解析不了 JSON / 调模型失败 / 素材源全挂 ⇒ **不动游标**，下次重跑；
 *  - `dryRun` ⇒ 素材照读、prompt 照发、算子照算，只是 writer 记 DRY、不 supersede、不建快照、不推游标。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PHASE_LAYER2 } from './budget.js';
import { crossCursorPath, pendingDir as defaultPendingDir, readJsonSafe, writeJsonAtomic } from './cursor.js';
import { parseModelJson } from './extractor.js';
import { PRE_SCREEN, entryId, normalizeText, parseFactEntries, parseMemoryEntries, preScreen, topNeighbors } from './merger.js';
import { makeRunId, resolveDryRun, snapshotFiles } from './pipeline.js';
import { STATUS } from './runlog.js';
import { DEFAULT_SCAN_ENTRIES, SOURCE, createJournalSource, listPendingBuckets } from './sources.js';
import { assertProjectScope, bucketInfo, loadRegistry } from './workspace.js';

/** 02 §8 默认值。 */
export const DEFAULT_CROSS_INTERVAL_HOURS = 24;
export const DEFAULT_CROSS_MIN_ENTRIES = 20;
export const DEFAULT_PROMOTE_HITS = 2;
export const DEFAULT_UNASSIGNED_BUCKET = '_unassigned';

/** 02 §7.6：每次最多失效 20 条。 */
export const MAX_SUPERSEDE = 20;
/** 02 §7.6：`demoted` 条目只在目标文件水位 < 85% 时才允许升格。 */
export const WATERMARK_GATE = 0.85;
/** 交给主插件的失效理由（固定串，落 runlog 也只写这个，不写正文）。 */
export const SUPERSEDE_REASON = 'contradicted-by-fact';

/** 升格 + 归档 + retire 合计的算子上限（§7.3.6 单批 ≤ 8）。 */
export const MAX_CROSS_OPS = 8;

/** 判定原因（runlog 用）。 */
export const CROSS_REASON = {
    OK: 'ok',
    DISABLED: 'disabled',
    MANUAL: 'manual',
    INTERVAL: 'interval',
    MIN_ENTRIES: 'min-entries',
    FIRST_RUN: 'first-run',
    BUDGET: 'budget',
    TOO_SOON: 'too-soon',
};

/**
 * L2 触发判定（§6.4）。
 *
 * 结构：`①`（距上次 ≥ interval，或手动）**或** `②`（新增素材 ≥ minEntries）任一成立，
 * 且 `③` 当日预算未耗尽、`④` 拿得到全局锁（并发由 budget.js 给，这里只读结果）。
 *
 * 判断点：§6.4 把 ①②③④ 列成四条，没写清 ① 与 ② 是「且」还是「或」。这里取「或」，
 * 理由是 ② 的存在意义就是「素材积够了一次性整理掉」，如果还要等满 24h，长会话密集的
 * 一天里 JOURNAL 会堆到第二天才升格，而 ① 单独成立时又不受 ② 限制——「或」更符合两
 * 条同时存在的动机。③④ 是硬门槛，任何情况下都不能绕。
 *
 * @param {{
 *   lastRunAt?: number,
 *   newEntries?: number,
 *   manual?: boolean,
 *   budgetOk?: boolean,
 *   locked?: boolean,
 *   now?: number,
 *   config?: Record<string, any>,
 * }} [input]
 * @returns {{ run: boolean, reason: string, nextAt?: number }}
 */
export function decideCross(input = {}) {
    const config = input.config ?? {};
    if (config.crossEnabled === false) return { run: false, reason: CROSS_REASON.DISABLED };

    const now = Number.isFinite(input.now) ? input.now : Date.now();
    const intervalHours = Number.isFinite(config.crossIntervalHours) ? config.crossIntervalHours : DEFAULT_CROSS_INTERVAL_HOURS;
    const minEntries = Number.isFinite(config.crossMinEntries) ? config.crossMinEntries : DEFAULT_CROSS_MIN_ENTRIES;
    const lastRunAt = Number.isFinite(input.lastRunAt) ? input.lastRunAt : 0;
    const newEntries = Number.isFinite(input.newEntries) ? input.newEntries : 0;

    const gate = () => {
        if (input.budgetOk === false) return { run: false, reason: CROSS_REASON.BUDGET };
        if (input.locked === false) return { run: false, reason: 'locked' };
        return null;
    };

    const blocked = gate();
    if (blocked !== null) return blocked;

    if (input.manual === true) return { run: true, reason: CROSS_REASON.MANUAL };
    if (lastRunAt === 0) return { run: true, reason: CROSS_REASON.FIRST_RUN };

    const elapsed = now - lastRunAt;
    if (elapsed >= intervalHours * 3_600_000) return { run: true, reason: CROSS_REASON.INTERVAL };
    if (newEntries >= minEntries) return { run: true, reason: CROSS_REASON.MIN_ENTRIES };
    return { run: false, reason: CROSS_REASON.TOO_SOON, nextAt: lastRunAt + intervalHours * 3_600_000 };
}

/**
 * 频次升格：同一结论出现 ≥ `minHits` 次才算稳定事实（§3 L2 / §7.6）。
 *
 * 归一化用 `merger.normalizeText`——与第一层判重同一套口径，避免「同一句话在两层
 * 被判成两条」。
 *
 * @param {{ text: string, workspaceId?: string, ts?: number, confidence?: string }[]} entries
 * @param {{ minHits?: number }} [options]
 * @returns {{ key: string, content: string, hits: number, workspaces: string[], confidence: string }[]}
 */
export function frequencyPromotion(entries = [], options = {}) {
    const minHits = Number.isFinite(options.minHits) ? options.minHits : DEFAULT_PROMOTE_HITS;
    const groups = new Map();

    for (const entry of entries) {
        const text = String(entry?.text ?? '').trim();
        if (text === '') continue;
        const key = normalizeText(text);
        if (key === '') continue;
        let group = groups.get(key);
        if (group === undefined) {
            group = { key, content: text, hits: 0, workspaces: new Set(), confidence: 'medium' };
            groups.set(key, group);
        }
        group.hits += 1;
        if (text.length < group.content.length) group.content = text;
        const workspaceId = String(entry?.workspaceId ?? '');
        if (workspaceId !== '') group.workspaces.add(workspaceId);
        if (entry?.confidence === 'high') group.confidence = 'high';
    }

    return [...groups.values()]
        .filter((group) => group.hits >= minHits)
        .sort((left, right) => right.hits - left.hits || left.key.localeCompare(right.key))
        .map((group) => ({
            key: group.key,
            content: group.content,
            hits: group.hits,
            workspaces: [...group.workspaces].sort(),
            confidence: group.confidence,
        }));
}

/**
 * 造 L2 计划：逐桶算 project 候选，跨桶只算 global（**纯函数**，单测与面板都能用）。
 *
 * @param {{
 *   entries?: { text: string, workspaceId?: string, ts?: number, confidence?: string }[],
 *   buckets?: { workspaceId: string }[],
 *   config?: Record<string, any>,
 * }} [input]
 * @returns {{
 *   perBucket: { workspaceId: string, candidates: any[] }[],
 *   global: any[],
 *   counts: { buckets: number, project: number, global: number, entries: number, unassignedSkipped: number },
 * }}
 */
export function planCrossRun(input = {}) {
    const config = input.config ?? {};
    const unassigned = typeof config.unassignedBucket === 'string' && config.unassignedBucket !== ''
        ? config.unassignedBucket
        : DEFAULT_UNASSIGNED_BUCKET;
    const minHits = Number.isFinite(config.crossPromoteHits) ? config.crossPromoteHits : DEFAULT_PROMOTE_HITS;
    const entries = Array.isArray(input.entries) ? input.entries : [];

    const byBucket = new Map();
    for (const bucket of Array.isArray(input.buckets) ? input.buckets : []) {
        byBucket.set(String(bucket.workspaceId), []);
    }
    for (const entry of entries) {
        const workspaceId = String(entry?.workspaceId ?? '') || unassigned;
        if (!byBucket.has(workspaceId)) byBucket.set(workspaceId, []);
        byBucket.get(workspaceId).push(entry);
    }

    const perBucket = [];
    let projectCount = 0;
    let unassignedSkipped = 0;
    for (const [workspaceId, bucketEntries] of [...byBucket.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
        // `_unassigned` 桶不参与 project 归并（02 §7.0 写入断言）。
        if (workspaceId === unassigned) {
            unassignedSkipped += bucketEntries.length;
            perBucket.push({ workspaceId, candidates: [] });
            continue;
        }
        const candidates = frequencyPromotion(bucketEntries, { minHits }).map((item) => ({
            content: item.content,
            scope: 'project',
            confidence: item.confidence,
            hits: item.hits,
            workspaceId,
            id: entryId(item.content),
        }));
        projectCount += candidates.length;
        perBucket.push({ workspaceId, candidates });
    }

    // 跨桶只产出 global（FACT）：不产出 project，避免把两个工作区的结论混成一份。
    const global = frequencyPromotion(entries, { minHits }).map((item) => ({
        content: item.content,
        scope: 'global',
        confidence: item.confidence,
        hits: item.hits,
        workspaces: item.workspaces,
        id: entryId(item.content),
    }));

    return {
        perBucket,
        global,
        counts: {
            buckets: perBucket.length,
            project: projectCount,
            global: global.length,
            entries: entries.length,
            unassignedSkipped,
        },
    };
}

/**
 * 读 L2 游标（`cross-cursor.json`）。坏文件当空，**不抛**。
 *
 * @param {string} [file]
 * @returns {{ lastRunAt: number, lastCount: number, lastRunId: string }}
 */
export function readCrossCursor(file = crossCursorPath()) {
    const raw = readJsonSafe(file);
    return {
        lastRunAt: Number.isFinite(raw?.lastRunAt) ? Number(raw.lastRunAt) : 0,
        lastCount: Number.isFinite(raw?.lastCount) ? Number(raw.lastCount) : 0,
        lastRunId: typeof raw?.lastRunId === 'string' ? raw.lastRunId : '',
    };
}

/**
 * 写 L2 游标。**不抛**，返回是否写成。
 *
 * @param {{ lastRunAt?: number, lastCount?: number, lastRunId?: string }} state
 * @param {string} [file]
 * @returns {boolean}
 */
export function writeCrossCursor(state, file = crossCursorPath()) {
    return writeJsonAtomic(file, {
        version: 1,
        lastRunAt: Number.isFinite(state?.lastRunAt) ? Number(state.lastRunAt) : Date.now(),
        lastCount: Number.isFinite(state?.lastCount) ? Number(state.lastCount) : 0,
        lastRunId: typeof state?.lastRunId === 'string' ? state.lastRunId : '',
    });
}

/* ─────────────────────────── 已消费素材计数（触发条件 ②） ─────────────────────────── */

/** 数一个文件的行（`onlyConsumed` 时只数 `consumed: true` 的行）。读不到 ⇒ 0。 */
function countLines(file, onlyConsumed) {
    let raw;
    try {
        raw = readFileSync(file, 'utf8');
    } catch {
        return 0;
    }
    const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
    if (onlyConsumed !== true) return lines.length;
    let count = 0;
    for (const line of lines) {
        try {
            if (JSON.parse(line)?.consumed === true) count += 1;
        } catch {
            // 坏行不计（与 pending 的容忍度一致）。
        }
    }
    return count;
}

/**
 * 「已消费素材」条数（02 §6.4 ②「已消费素材自上次新增 ≥ 20 条」）。
 *
 * 口径刻意粗：活文件里 `consumed: true` 的行 + `pending/archive/**` 的行。两者会重叠
 * （标记消费时同时写归档），所以这不是精确计数，只是一个**单调增量的近似**——它只用来
 * 判「够不够 20 条」，判早了会多跑一次整理（幂等），判晚了还有 24h 间隔兜底。
 *
 * @param {string} [pendingDir]
 * @returns {number}
 */
export function countConsumedEntries(pendingDir = defaultPendingDir()) {
    let total = 0;
    for (const bucket of listPendingBuckets(pendingDir)) {
        for (const name of bucket.sessions) {
            total += countLines(join(pendingDir, bucket.workspaceId, name), true);
        }
    }
    const archive = join(pendingDir, 'archive');
    let buckets = [];
    try {
        buckets = readdirSync(archive, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
        buckets = [];
    }
    for (const bucket of buckets) {
        let names = [];
        try {
            names = readdirSync(join(archive, bucket.name)).filter((name) => name.endsWith('.jsonl'));
        } catch {
            names = [];
        }
        for (const name of names) total += countLines(join(archive, bucket.name, name), false);
    }
    return total;
}

/* ─────────────────────────────── prompt ─────────────────────────────── */

/** 一次请求里允许出现的 promote 条数（与 writer 的单批上限对齐）。 */
export const MAX_PROMOTE = 8;

/**
 * 造 L2 的**唯一一次**提示词（02 §7.6 / §7.3.3）。
 *
 * 必须带的三样：现行 FACT 正文、现行 MEMORY 正文、带 id 的编号素材（supersede 只能按 id 说话）。
 *
 * @param {{
 *   factText?: string, memoryText?: string,
 *   material?: { id?: string, text?: string, origin?: string, workspaceId?: string }[],
 *   scopes?: string[], minHits?: number, maxSupersede?: number, maxChars?: number,
 * }} [input]
 * @returns {string}
 */
export function buildCrossPrompt(input = {}) {
    const minHits = Number.isFinite(input.minHits) ? input.minHits : DEFAULT_PROMOTE_HITS;
    const scopes = Array.isArray(input.scopes) && input.scopes.length > 0 ? input.scopes : ['global'];
    const maxSupersede = Number.isFinite(input.maxSupersede) ? input.maxSupersede : MAX_SUPERSEDE;
    const maxChars = Number.isFinite(input.maxChars) ? input.maxChars : 8000;
    const factText = String(input.factText ?? '').trim();
    const memoryText = String(input.memoryText ?? '').trim();
    const material = Array.isArray(input.material) ? input.material : [];

    // 素材预算从尾部往前取（最近的素材优先），并且**不再硬截断 prompt 本身**：
    // 把「输出 JSON 形状」的说明截掉等于让模型自由发挥，那比少几条素材危险得多。
    const budget = Math.max(1200, maxChars - factText.length - memoryText.length - 1600);
    const picked = [];
    let used = 0;
    for (let index = material.length - 1; index >= 0; index -= 1) {
        const entry = material[index];
        const text = String(entry?.text ?? '').trim();
        if (text === '') continue;
        const head = [];
        if (entry?.id !== undefined && entry.id !== '') head.push(`id=${entry.id}`);
        if (entry?.origin !== undefined && entry.origin !== '') head.push(`来源=${entry.origin}`);
        if (entry?.workspaceId !== undefined && entry.workspaceId !== '') head.push(`桶=${entry.workspaceId}`);
        const line = `${head.length > 0 ? `${head.join(' ')} ` : ''}${text}`;
        if (used + line.length > budget) break;
        used += line.length;
        picked.unshift(line);
    }

    const numbered = picked.length === 0
        ? '（空）'
        : picked.map((line, index) => `[${index + 1}] ${line}`).join('\n');

    return [
        '你是记忆整理器。下面是现行 FACT（全局事实）、现行 MEMORY（本项目结论），以及最近的素材（带 id 的编号行）。',
        '',
        '任务（在一次回答里都做）：',
        `A. promote：找出在素材里出现 ≥ ${minHits} 次的结论 → 稳定事实。本次允许的 scope：${scopes.join(' / ')}。`,
        `B. supersede：找出与现行 FACT/MEMORY **直接矛盾**的素材条目，给出它的 id（最多 ${maxSupersede} 条）。`,
        '   判定从保守出发：直接矛盾才失效；同一主题的补充、不矛盾、拿不准的一律保留。',
        'C. retire（可选）：现行 FACT/MEMORY 里已被证明错误的条目 id；没有就给空数组。',
        '',
        '规则：一条一个结论，第三人称陈述句；只写结论，不写原因、不写过程；'
            + '不写密钥/密码/token/手机号/身份证/卡号，必须提到时一律写成 ⟨redacted⟩。',
        '',
        '现行 FACT：',
        factText === '' ? '（空）' : factText,
        '',
        '现行 MEMORY：',
        memoryText === '' ? '（空）' : memoryText,
        '',
        '素材：',
        numbered,
        '',
        '输出 JSON（不要解释，不要代码块围栏）：',
        '{"promote":[{"scope":"global|project|journal","content":"...","hits":2,"confidence":"high|medium|low"}],'
            + '"supersede":[{"id":"...","reason":"contradicted-by-fact"}],'
            + '"retire":[{"id":"...","reason":"..."}]}',
    ].join('\n');
}

/** 把 `supersede` / `retire` 项归一成 `{id, reason}`（模型可能只给 id 字符串）。 */
function normalizeRefList(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
        if (typeof item === 'string') {
            const id = item.trim();
            if (id !== '') out.push({ id, reason: SUPERSEDE_REASON });
            continue;
        }
        if (item === null || typeof item !== 'object') continue;
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (id === '') continue;
        out.push({ id, reason: String(item.reason ?? SUPERSEDE_REASON).slice(0, 60) });
    }
    return out;
}

/**
 * 解析 L2 响应。非法 JSON ⇒ `{ok:false}`（整次放弃、不重试、游标不动）。
 *
 * @param {string} text
 * @returns {{ ok: boolean, reason: string, promote: any[], supersede: {id: string, reason: string}[], retire: {id: string, reason: string}[] }}
 */
export function parseCrossResponse(text) {
    const parsed = parseModelJson(text);
    if (parsed.ok !== true) return { ok: false, reason: parsed.reason, promote: [], supersede: [], retire: [] };
    const value = parsed.value;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, reason: 'bad-shape', promote: [], supersede: [], retire: [] };
    }
    const promote = (Array.isArray(value.promote) ? value.promote : [])
        .filter((item) => item !== null && typeof item === 'object' && typeof item.content === 'string' && item.content.trim() !== '')
        .slice(0, MAX_PROMOTE)
        .map((item) => ({
            scope: String(item.scope ?? '').trim().toLowerCase(),
            content: String(item.content).trim(),
            hits: Number.isFinite(item.hits) ? Math.trunc(item.hits) : 0,
            confidence: ['high', 'medium', 'low'].includes(String(item.confidence ?? '').toLowerCase())
                ? String(item.confidence).toLowerCase()
                : 'medium',
        }));
    return {
        ok: true,
        reason: 'ok',
        promote,
        supersede: normalizeRefList(value.supersede),
        retire: normalizeRefList(value.retire),
    };
}

/** 反向包含匹配的最低长度（太短的素材当证据会误判）。 */
const MIN_MATCH_CHARS = 8;

/**
 * 一条结论在素材里「出现过几次」（按**去重后的会话/桶**计，02 §7.6「出现 ≥2 次」）。
 *
 * 匹配口径：归一化后的包含关系（任一侧包含另一侧）。这样模型把两条素材合并成
 * 一句更完整的结论时仍能数到次数，而完全无关的两句话不会误命中。
 *
 * @param {string} content
 * @param {{ id?: string, text?: string, session?: string, workspaceId?: string, tags?: string[] }[]} material
 * @returns {{ hits: number, ids: string[], demotedOnly: boolean }}
 */
export function countOccurrences(content, material = []) {
    const key = normalizeText(content);
    if (key === '') return { hits: 0, ids: [], demotedOnly: false };
    const groups = new Set();
    const ids = [];
    let demoted = 0;
    for (const entry of Array.isArray(material) ? material : []) {
        const text = normalizeText(entry?.text ?? '');
        if (text === '') continue;
        const matched = text.includes(key) || (key.length >= MIN_MATCH_CHARS && key.includes(text));
        if (!matched) continue;
        ids.push(String(entry?.id ?? ''));
        groups.add(String(entry?.session || entry?.workspaceId || entry?.id || ids.length));
        if (Array.isArray(entry?.tags) && entry.tags.includes('demoted')) demoted += 1;
    }
    return { hits: groups.size, ids, demotedOnly: ids.length > 0 && demoted === ids.length };
}

/* ─────────────────────────── 水位 / store 读取 ─────────────────────────── */

/** 水位占用比（与主插件 `watermarkRatio` 同口径：取三个维度里最高的那个）。 */
export function watermarkRatio(mark) {
    const limit = mark?.limit ?? {};
    const ratios = [];
    if (Number.isFinite(limit.bytes) && limit.bytes > 0) ratios.push((mark.bytes ?? 0) / limit.bytes);
    if (Number.isFinite(limit.lines) && limit.lines > 0) ratios.push((mark.lines ?? 0) / limit.lines);
    if (Number.isFinite(limit.chars) && limit.chars > 0) ratios.push((mark.chars ?? 0) / limit.chars);
    return ratios.length === 0 ? 0 : Math.max(...ratios);
}

/** 读水位（不支持 / 抛错 ⇒ null）。 */
async function readWatermark(store, scope, cwd) {
    if (typeof store?.watermark !== 'function') return null;
    try {
        const mark = await store.watermark(scope, { cwd });
        return mark !== null && typeof mark === 'object' ? mark : null;
    } catch {
        return null;
    }
}

/** store 上的路径（拿不到 ⇒ 空串）。 */
function pathOf(store, method) {
    if (typeof store?.[method] !== 'function') return '';
    try {
        const value = store[method]();
        return typeof value === 'string' ? value : '';
    } catch {
        return '';
    }
}

/** store 视角读文件（不存在 ⇒ 空串）。 */
function textOf(store, file) {
    if (file === '' || typeof store?.readText !== 'function') return '';
    try {
        const value = store.readText(file);
        return typeof value === 'string' ? value : '';
    } catch {
        return '';
    }
}

/** 项目 `MEMORY.md`（两种口径都试；拿不到 ⇒ 空串）。 */
function projectMemoryPathOf(store, cwd) {
    if (typeof store?.findProjectMemory === 'function') {
        try {
            const found = store.findProjectMemory(cwd);
            if (found !== null && typeof found?.path === 'string' && found.path !== '') return found.path;
        } catch {
            /* 落到下一种口径 */
        }
    }
    if (typeof store?.watermark === 'function') {
        try {
            const mark = store.watermark('memory', { cwd });
            if (typeof mark?.path === 'string' && mark.path !== '') return mark.path;
        } catch {
            /* 没有水位接口就只读 FACT */
        }
    }
    return '';
}

/** 归并池：FACT + MEMORY 条目，id 优先用 store 的口径（否则 DELETE / UPDATE 的 target 对不上）。 */
function buildCrossPool(store, factText, memoryText) {
    const withStoreId = (entry) => ({
        ...entry,
        id: typeof store?.entryId === 'function' ? store.entryId('', entry.text) : entry.id,
    });
    return [...parseFactEntries(factText).map(withStoreId), ...parseMemoryEntries(memoryText).map(withStoreId)];
}

/* ─────────────────────────────── 升格算子 ─────────────────────────────── */

/**
 * 升格候选 → 算子（**确定性预筛**，不再调模型；理由见文件头）。
 *
 * @param {{
 *   candidates: { content: string, scope: string, confidence?: string, ts?: number, hits?: number }[],
 *   pool?: { id: string, text: string, scope?: string }[],
 *   layer?: number,
 *   maxOps?: number,
 * }} [input]
 * @returns {{ ops: any[], skipped: { content: string, reason: string }[], counts: { candidates: number, added: number, noop: number } }}
 */
export function mergePromotions(input = {}) {
    const pool = Array.isArray(input.pool) ? input.pool : [];
    const maxOps = Number.isFinite(input.maxOps) ? Math.max(1, Math.trunc(input.maxOps)) : MAX_CROSS_OPS;
    const layer = input.layer === 2 ? 2 : 1;
    const candidates = Array.isArray(input.candidates) ? input.candidates : [];

    const ops = [];
    const skipped = [];
    const counts = { candidates: candidates.length, added: 0, noop: 0 };

    for (const candidate of candidates) {
        const content = String(candidate?.content ?? '').trim();
        if (content === '') {
            skipped.push({ content, reason: 'empty-content' });
            continue;
        }
        if (ops.length >= maxOps) {
            skipped.push({ content, reason: 'over-limit' });
            continue;
        }
        const neighbors = topNeighbors(content, pool, { topK: 3 });
        const pre = preScreen(content, neighbors);
        if (pre.decision === PRE_SCREEN.NOOP) {
            counts.noop += 1;
            ops.push({
                op: 'NOOP',
                target: String(neighbors[0]?.entry?.id ?? ''),
                content,
                scope: candidate.scope,
                confidence: candidate.confidence ?? 'medium',
                ts: candidate.ts,
                layer,
                reason: pre.reason,
            });
            continue;
        }
        counts.added += 1;
        ops.push({
            op: 'ADD',
            target: '',
            content,
            scope: candidate.scope,
            confidence: candidate.confidence ?? 'medium',
            ts: candidate.ts,
            layer,
            reason: pre.decision === PRE_SCREEN.ADJUDICATE ? 'adjudicate-as-add' : pre.reason,
        });
    }

    return { ops, skipped, counts };
}

/* ─────────────────────────── 素材读取 ─────────────────────────── */

/**
 * 读素材（走 `runtime.crossChain` 的降级链）。
 *
 * @param {{
 *   runtime: Record<string, any>, cwd?: string, bucket?: string, now?: number,
 * }} input
 * @returns {Promise<{ ok: boolean, source: string, reason: string, entries: any[], attempts: any[], attributed: boolean }>}
 */
export async function readMaterial(input = {}) {
    const runtime = input.runtime ?? {};
    const config = runtime.config ?? {};
    const limit = Number.isFinite(config.crossScanEntries) ? Math.max(1, Math.trunc(config.crossScanEntries)) : DEFAULT_SCAN_ENTRIES;
    const chain = runtime.crossChain ?? runtime.sources ?? null;
    let listed;
    try {
        if (chain !== null && typeof chain.list === 'function') {
            listed = await chain.list({ limit, cwd: String(input.cwd ?? ''), now: input.now });
        } else {
            // 没装降级链就退回**默认档 journal**（02 §3.1 的默认数据源），
            // 免得「接线漏了一处」变成「跨会话整理静默不干活」。
            listed = await createJournalSource({
                getStore: () => (typeof runtime.resolveStore === 'function'
                    ? runtime.resolveStore()
                    : Promise.resolve(runtime.store ?? null)),
                tail: limit,
            }).list({ limit });
        }
    } catch {
        return { ok: false, source: 'none', reason: 'source-error', entries: [], attempts: [], attributed: false };
    }

    const bucket = String(input.bucket ?? '');
    const all = (Array.isArray(listed?.entries) ? listed.entries : [])
        .filter((entry) => typeof entry?.text === 'string' && entry.text.trim() !== '');

    // 逐桶运行只认「能归属到本桶」的素材（journal 条目没有桶归属 ⇒ 只参与 global/journal，
    // 不参与 project，02 §7.6「跨桶只允许 global」的反向约束）。
    let entries = all;
    let attributed = false;
    if (bucket !== '') {
        const owned = all.filter((entry) => String(entry?.workspaceId ?? '') === bucket);
        attributed = owned.length > 0;
        entries = all.filter((entry) => {
            const owner = String(entry?.workspaceId ?? '');
            return owner === '' || owner === bucket;
        });
    } else {
        attributed = all.some((entry) => String(entry?.workspaceId ?? '') !== '');
    }

    return {
        ok: listed?.ok === true,
        source: String(listed?.source ?? 'none'),
        reason: String(listed?.reason ?? 'unknown'),
        entries,
        attempts: Array.isArray(listed?.attempts) ? listed.attempts : [],
        attributed,
    };
}

/**
 * 某次运行允许产出的 scope（02 §7.6 的三条约束压在一处）。
 *
 * - 跨桶运行（`bucket === ''`）：**只允许 global**；
 * - `_unassigned`：只允许 journal / global（绝不 project）；
 * - 普通桶：素材能归属到本桶时允许 project，否则只能 journal（拿不准归属就不写项目记忆）。
 *
 * @param {string} bucket
 * @param {{ unassigned?: string, attributed?: boolean }} [options]
 * @returns {string[]}
 */
export function allowedScopes(bucket, options = {}) {
    const unassigned = typeof options.unassigned === 'string' && options.unassigned !== ''
        ? options.unassigned
        : DEFAULT_UNASSIGNED_BUCKET;
    const id = String(bucket ?? '');
    if (id === '') return ['global'];
    if (id === unassigned) return ['journal', 'global'];
    return options.attributed === true ? ['project', 'journal'] : ['journal'];
}

/* ─────────────────────────── 一次 L2 pass ─────────────────────────── */

/** 空计数（返回值与 runlog 共用的形状）。 */
export function emptyCrossCounts() {
    return {
        candidates: 0, ops: 0, promoted: 0, superseded: 0, skipped: 0,
        written: 0, replaced: 0, deleted: 0, demoted: 0, dropped: 0, noop: 0, dry: 0, failed: 0,
    };
}

/** 预算器上「还能发几次某阶段的调用」（拿不到预算器 ⇒ 不限制）。 */
function budgetRemaining(runtime, phase, now) {
    if (typeof runtime?.budget?.remaining === 'function') {
        try {
            // `now` 必须跟 `tryStart` 用同一个：否则跨日滚动会在循环中途把已用次数清零。
            const left = runtime.budget.remaining(phase, now);
            return {
                total: Number.isFinite(left?.total) ? Number(left.total) : Number.POSITIVE_INFINITY,
                phase: Number.isFinite(left?.phase) ? Number(left.phase) : Number.POSITIVE_INFINITY,
            };
        } catch {
            return { total: Number.POSITIVE_INFINITY, phase: Number.POSITIVE_INFINITY };
        }
    }
    return { total: Number.POSITIVE_INFINITY, phase: Number.POSITIVE_INFINITY };
}

/**
 * 跑一个桶（或跨桶）的 L2 pass。**内部函数**：预算与锁由 `runL2` / `runL2All` 负责。
 *
 * @param {{
 *   runtime: Record<string, any>, store: any, config: Record<string, any>,
 *   registry: any, runId: string, bucket: string, now: number, dryRun: boolean,
 * }} context
 * @returns {Promise<Record<string, any>>}
 */
async function executePass(context) {
    const { runtime, store, config, registry, runId, bucket, now, dryRun } = context;
    const unassigned = typeof config.unassignedBucket === 'string' && config.unassignedBucket !== ''
        ? config.unassignedBucket
        : DEFAULT_UNASSIGNED_BUCKET;
    const info = bucket === '' ? { workspaceId: '', title: '', path: '' } : bucketInfo(registry, bucket, { unassigned });
    const cwd = typeof info.path === 'string' ? info.path : '';
    const counts = emptyCrossCounts();
    const base = { runId, layer: 2, bucket, bucketTitle: info.title, dryRun, counts, calls: 0, supersededIds: [], snapshot: '' };

    /* ① 素材 */
    const material = await readMaterial({ runtime, config, cwd, bucket, now });
    if (material.ok !== true) {
        runtime.runLog?.append({ runId, phase: 'layer2', status: STATUS.FAIL, reason: `source-${material.reason}`, workspaceId: bucket || 'global', counts }, now);
        return { ...base, status: STATUS.FAIL, skipped: 'source-failed', reason: material.reason, attempts: material.attempts };
    }

    /* ② 现行 FACT / MEMORY + 归并池 */
    const factText = textOf(store, pathOf(store, 'factPath'));
    const memoryText = textOf(store, projectMemoryPathOf(store, cwd));
    const pool = buildCrossPool(store, factText, memoryText);
    const scopes = allowedScopes(bucket, { unassigned, attributed: material.attributed });
    const minHits = Number.isFinite(config.crossPromoteHits) ? config.crossPromoteHits : DEFAULT_PROMOTE_HITS;

    /* ③ 唯一一次调用 */
    const prompt = buildCrossPrompt({
        factText,
        memoryText,
        material: material.entries,
        scopes,
        minHits,
        maxSupersede: MAX_SUPERSEDE,
        maxChars: Number.isFinite(config.maxSampleChars) ? config.maxSampleChars : 8000,
    });
    if (typeof runtime.callModel !== 'function') {
        runtime.runLog?.append({ runId, phase: 'layer2', status: STATUS.FAIL, reason: 'no-model', workspaceId: bucket || 'global', counts }, now);
        return { ...base, status: STATUS.FAIL, skipped: 'no-model', reason: 'model-not-wired', prompt };
    }

    let response;
    try {
        response = await runtime.callModel({ prompt, provider: config.provider ?? '', model: config.model ?? '' });
    } catch (error) {
        const code = String(error?.code ?? 'model-error');
        runtime.runLog?.append({ runId, phase: 'layer2', status: STATUS.FAIL, reason: code, workspaceId: bucket || 'global', counts, calls: 1 }, now);
        return { ...base, status: STATUS.FAIL, skipped: 'model-error', reason: code, calls: 1, prompt };
    }
    const text = typeof response === 'string' ? response : (typeof response?.text === 'string' ? response.text : '');
    const parsed = parseCrossResponse(text);
    if (parsed.ok !== true) {
        runtime.runLog?.append({ runId, phase: 'layer2', status: STATUS.FAIL, reason: `parse-${parsed.reason}`, workspaceId: bucket || 'global', counts, calls: 1 }, now);
        return { ...base, status: STATUS.FAIL, skipped: 'parse-failed', reason: parsed.reason, calls: 1, prompt };
    }

    /* ④ 升格候选 → 作用域 / 频次 / demoted 水位 三道闸 */
    const candidates = [];
    const skipped = [];
    for (const item of parsed.promote) {
        const scope = String(item.scope ?? '');
        if (!scopes.includes(scope)) {
            counts.skipped += 1;
            skipped.push({ content: item.content, reason: `scope-not-allowed:${scope === '' ? '?' : scope}` });
            continue;
        }
        if (scope === 'project') {
            const check = assertProjectScope('project', bucket, { unassigned });
            if (check.ok !== true) {
                counts.skipped += 1;
                skipped.push({ content: item.content, reason: check.reason });
                continue;
            }
        }
        const seen = countOccurrences(item.content, material.entries);
        const claimed = Number.isFinite(item.hits) ? item.hits : 0;
        const hits = Math.max(claimed, seen.hits);
        // 频次门槛：素材里真的数够，或者「模型坚称 ≥minHits 且素材里至少命中一次」（允许改写）。
        if (seen.hits < minHits && !(claimed >= minHits && seen.hits >= 1)) {
            counts.skipped += 1;
            skipped.push({ content: item.content, reason: 'below-min-hits' });
            continue;
        }
        if (seen.demotedOnly) {
            // 02 §7.6：demoted 条目只在目标文件水位 < 85% 时允许升格（否则「满→降级→永不升格」）。
            const mark = await readWatermark(store, scope === 'project' ? 'memory' : 'fact', cwd);
            if (watermarkRatio(mark) >= WATERMARK_GATE) {
                counts.skipped += 1;
                skipped.push({ content: item.content, reason: 'demoted-watermark-gate' });
                continue;
            }
        }
        candidates.push({ content: item.content, scope, confidence: item.confidence, ts: now, hits });
    }
    counts.candidates = candidates.length;

    const merged = mergePromotions({ candidates, pool, layer: 2, maxOps: MAX_CROSS_OPS });
    for (const item of merged.skipped) {
        counts.skipped += 1;
        skipped.push(item);
    }

    /* ⑤ retire：现行 FACT/MEMORY 里已被证明错误的条目（第二层才允许 DELETE） */
    const poolById = new Map(pool.map((entry) => [String(entry.id), entry]));
    const ops = [...merged.ops];
    for (const ref of parsed.retire) {
        if (ops.length >= MAX_CROSS_OPS) {
            counts.skipped += 1;
            skipped.push({ content: '', reason: 'retire-over-limit' });
            continue;
        }
        const entry = poolById.get(ref.id);
        if (entry === undefined) {
            // target 不在本次给出的 id 集合里 ⇒ 不删（§7.3.5 硬约束）。
            counts.skipped += 1;
            skipped.push({ content: '', reason: 'retire-bad-target' });
            continue;
        }
        ops.push({
            op: 'DELETE',
            target: ref.id,
            content: '',
            scope: entry.scope === 'memory' ? 'project' : 'global',
            layer: 2,
            reason: 'retire',
            superseded: { id: entry.id, text: entry.text },
        });
    }

    /* ⑥ 写前快照（dryRun 不建）→ 执行算子 */
    const snapshot = snapshotFiles({ runId, store, cwd, dryRun, now });
    const write = await runtime.writer.apply(ops, { cwd, workspaceId: bucket, dryRun, layer: 2, now });
    Object.assign(counts, write.counts);
    counts.candidates = candidates.length;
    counts.ops = ops.length;
    counts.promoted = countPromoted(ops);

    /* ⑦ JOURNAL 失效：只交 id 与理由，最多 20 条 */
    const journalIds = new Set(material.entries
        .filter((entry) => String(entry?.origin ?? '') === SOURCE.JOURNAL)
        .map((entry) => String(entry?.id ?? ''))
        .filter((id) => id !== ''));
    const wanted = [];
    for (const ref of parsed.supersede) {
        if (!journalIds.has(ref.id)) {
            counts.skipped += 1;
            skipped.push({ content: '', reason: 'supersede-bad-target' });
            continue;
        }
        if (wanted.includes(ref.id)) continue;
        if (wanted.length >= MAX_SUPERSEDE) {
            counts.skipped += 1;
            skipped.push({ content: '', reason: 'supersede-over-limit' });
            continue;
        }
        wanted.push(ref.id);
    }

    let supersededIds = [];
    let supersedeReason = 'none';
    if (wanted.length > 0) {
        if (dryRun === true) {
            supersedeReason = 'dry-run';
            counts.superseded = wanted.length;
        } else if (typeof store?.supersedeJournal !== 'function') {
            supersedeReason = 'no-supersede-api';
            counts.failed += 1;
        } else {
            try {
                const result = await store.supersedeJournal(wanted, { reason: SUPERSEDE_REASON });
                supersededIds = wanted;
                counts.superseded = Number.isFinite(result?.moved) ? Number(result.moved) : wanted.length;
                supersedeReason = SUPERSEDE_REASON;
            } catch {
                supersedeReason = 'supersede-failed';
                counts.failed += 1;
            }
        }
    }

    const succeeded = counts.failed === 0;
    let status = STATUS.OK;
    if (succeeded !== true) status = STATUS.FAIL;
    else if (dryRun === true) status = STATUS.DRY;
    else if (counts.promoted === 0 && counts.superseded === 0 && counts.deleted === 0) status = STATUS.NOOP;

    /* ⑧ 成功才推游标（失败留原样 ⇒ 下次重试） */
    if (dryRun !== true && succeeded === true) {
        const cursorFile = runtime.crossCursorFile ?? crossCursorPath();
        writeCrossCursor({ lastRunAt: now, lastCount: countConsumedEntries(runtime.pendingDir ?? defaultPendingDir()), lastRunId: runId }, cursorFile);
        runtime.cross = readCrossCursor(cursorFile);
    }

    /* ⑨ runlog：只写结构化摘要 + 短 id（正文一个字都不进） */
    const reasonBits = [];
    if (skipped.length > 0) reasonBits.push(`skipped:${skipped.map((item) => item.reason).slice(0, 4).join('|')}`);
    if (supersedeReason !== 'none') reasonBits.push(`supersede:${supersedeReason}`);
    runtime.runLog?.append({
        runId,
        phase: 'layer2',
        status,
        reason: reasonBits.length > 0 ? reasonBits.join(' ') : (dryRun === true ? 'dry-run' : 'ok'),
        workspaceId: bucket || 'global',
        bucket: info.title === '' ? (bucket || 'global') : info.title,
        calls: 1,
        counts,
        watermarks: write.watermarks,
        supersededIds: wanted,
    }, now);

    return {
        ...base,
        status,
        reason: supersedeReason,
        counts,
        calls: 1,
        supersededIds,
        snapshot: snapshot.dir,
        watermarks: write.watermarks,
        prompt,
        skippedDetail: skipped,
        source: material.source,
    };
}

/** 算子里的升格条数（ADD / UPDATE 都算「进记忆」，DELETE 单独计）。 */
function countPromoted(ops) {
    let promoted = 0;
    for (const op of ops) {
        if (op?.op === 'ADD' || op?.op === 'UPDATE') promoted += 1;
    }
    return promoted;
}

/* ─────────────────────────── 对外入口 ─────────────────────────── */

/** 解析 store（失败 ⇒ null）。 */
async function resolveStoreSafe(runtime) {
    try {
        if (typeof runtime.resolveStore === 'function') return (await runtime.resolveStore()) ?? null;
        return runtime.store ?? null;
    } catch {
        return null;
    }
}

/** 预算器「现在能不能开一次 L2」（拿不到预算器 ⇒ 允许）。 */
function canStartLayer2(runtime, now) {
    if (typeof runtime?.budget?.canStart !== 'function') return { ok: true, reason: 'ok' };
    try {
        return runtime.budget.canStart({ phase: PHASE_LAYER2, now });
    } catch {
        return { ok: true, reason: 'ok' };
    }
}

/**
 * 跑一次 L2（单桶或跨桶）。**永远不抛**：失败只体现在返回值的 `status: FAIL`。
 *
 * @param {{
 *   runtime: Record<string, any>,
 *   bucket?: string | { workspaceId: string },
 *   now?: number,
 *   dryRun?: boolean,
 *   manual?: boolean,
 *   runId?: string,
 * }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function runL2(input = {}) {
    const runtime = input.runtime ?? {};
    const config = runtime.config ?? {};
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    const dryRun = resolveDryRun(input.dryRun, config);
    const runId = typeof input.runId === 'string' && input.runId !== '' ? input.runId : makeRunId(now);
    const bucket = input.bucket === undefined || input.bucket === null
        ? ''
        : String(typeof input.bucket === 'string' ? input.bucket : (input.bucket.workspaceId ?? ''));
    const base = { runId, layer: 2, bucket, dryRun, counts: emptyCrossCounts(), calls: 0, supersededIds: [], snapshot: '' };

    const cursorFile = runtime.crossCursorFile ?? crossCursorPath();
    const cursor = readCrossCursor(cursorFile);
    const decision = decideCross({
        lastRunAt: cursor.lastRunAt,
        newEntries: Math.max(0, countConsumedEntries(runtime.pendingDir ?? defaultPendingDir()) - cursor.lastCount),
        manual: input.manual === true,
        budgetOk: canStartLayer2(runtime, now).ok,
        config,
        now,
    });
    if (decision.run !== true) {
        runtime.runLog?.append({ runId, phase: 'layer2', status: STATUS.SKIPPED, reason: decision.reason, workspaceId: bucket || 'global' }, now);
        return { ...base, status: STATUS.SKIPPED, skipped: 'trigger', reason: decision.reason };
    }

    const started = typeof runtime.budget?.tryStart === 'function'
        ? runtime.budget.tryStart({ phase: PHASE_LAYER2, now })
        : { ok: true, token: '' };
    if (started.ok !== true) {
        runtime.runLog?.append({ runId, phase: 'layer2', status: STATUS.SKIPPED, reason: started.reason ?? 'budget', workspaceId: bucket || 'global' }, now);
        return { ...base, status: STATUS.SKIPPED, skipped: 'budget', reason: started.reason ?? 'budget' };
    }

    let ok = false;
    try {
        const store = await resolveStoreSafe(runtime);
        if (store === null || store === undefined) {
            runtime.runLog?.append({ runId, phase: 'layer2', status: STATUS.FAIL, reason: 'store-unavailable', workspaceId: bucket || 'global' }, now);
            return { ...base, status: STATUS.FAIL, skipped: 'store-unavailable', reason: 'store-unavailable' };
        }
        const registry = runtime.registry ?? loadRegistry(runtime.registryFile);
        const pass = await executePass({ runtime, store, config, registry, runId, bucket, now, dryRun });
        ok = pass.status !== STATUS.FAIL;
        return pass;
    } catch (error) {
        const reason = String(error?.code ?? 'cross-error');
        runtime.runLog?.append({ runId, phase: 'layer2', status: STATUS.FAIL, reason, workspaceId: bucket || 'global' }, now);
        return { ...base, status: STATUS.FAIL, skipped: 'error', reason };
    } finally {
        if (typeof started.token === 'string' && started.token !== '') runtime.budget?.settle?.(started.token, { ok, now });
    }
}

/**
 * 跑全套 L2：**先跨桶一遍（只产出 global + JOURNAL 失效）**，再逐桶一遍（project / journal）。
 *
 * 为什么分两段：`global` 是「跨桶统计出来的稳定事实」，如果逐桶各跑一次，同一条事实会被
 * 写 3 次（除第一次外都被预筛成 NOOP，白花调用）。所以跨桶那段只允许 global，逐桶那段
 * 只允许 project / journal（`allowedScopes`）。预算按**真实调用次数**扣（每段 1 次）。
 *
 * @param {{
 *   runtime: Record<string, any>, dryRun?: boolean, now?: number,
 *   manual?: boolean, runId?: string,
 * }} input
 * @returns {Promise<{
 *   runId: string, dryRun: boolean, runs: any[], status?: string,
 *   skipped?: string, reason?: string, counts?: Record<string, number>, calls?: number,
 * }>}
 */
export async function runL2All(input = {}) {
    const runtime = input.runtime ?? {};
    const config = runtime.config ?? {};
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    const dryRun = resolveDryRun(input.dryRun, config);
    const runId = typeof input.runId === 'string' && input.runId !== '' ? input.runId : makeRunId(now);

    const cursorFile = runtime.crossCursorFile ?? crossCursorPath();
    const cursor = readCrossCursor(cursorFile);
    const decision = decideCross({
        lastRunAt: cursor.lastRunAt,
        newEntries: Math.max(0, countConsumedEntries(runtime.pendingDir ?? defaultPendingDir()) - cursor.lastCount),
        manual: input.manual === true,
        budgetOk: canStartLayer2(runtime, now).ok,
        config,
        now,
    });
    if (decision.run !== true) {
        runtime.runLog?.append({ runId, phase: 'layer2', status: STATUS.SKIPPED, reason: decision.reason, workspaceId: 'global' }, now);
        return { runId, dryRun, runs: [], status: STATUS.SKIPPED, skipped: 'trigger', reason: decision.reason };
    }

    const started = typeof runtime.budget?.tryStart === 'function'
        ? runtime.budget.tryStart({ phase: PHASE_LAYER2, now })
        : { ok: true, token: '' };
    if (started.ok !== true) {
        runtime.runLog?.append({ runId, phase: 'layer2', status: STATUS.SKIPPED, reason: started.reason ?? 'budget', workspaceId: 'global' }, now);
        return { runId, dryRun, runs: [], status: STATUS.SKIPPED, skipped: 'budget', reason: started.reason ?? 'budget' };
    }

    const runs = [];
    let ok = false;
    try {
        const store = await resolveStoreSafe(runtime);
        if (store === null || store === undefined) {
            runtime.runLog?.append({ runId, phase: 'layer2', status: STATUS.FAIL, reason: 'store-unavailable', workspaceId: 'global' }, now);
            return { runId, dryRun, runs: [], status: STATUS.FAIL, skipped: 'store-unavailable', reason: 'store-unavailable' };
        }
        const registry = runtime.registry ?? loadRegistry(runtime.registryFile);
        const buckets = listPendingBuckets(runtime.pendingDir ?? defaultPendingDir()).map((bucket) => bucket.workspaceId);
        const passes = ['', ...buckets];

        let stopped = '';
        for (let index = 0; index < passes.length; index += 1) {
            if (index > 0) {
                const left = budgetRemaining(runtime, PHASE_LAYER2, now);
                if (left.total <= 0 || left.phase <= 0) {
                    stopped = 'budget';
                    break;
                }
                // 第 2 次起补扣（锁只占一次；预算按调用次数算，与 runAllBuckets 同款口径）。
                runtime.budget?.charge?.(PHASE_LAYER2, 1, now);
            }
            runs.push(await executePass({ runtime, store, config, registry, runId, bucket: passes[index], now, dryRun }));
        }

        ok = runs.every((run) => run.status !== STATUS.FAIL);
        const counted = summarizeCrossRuns(runs);
        return { runId, dryRun, runs, counts: counted.counts, calls: counted.calls, status: counted.status, reason: stopped === '' ? 'ok' : stopped };
    } catch (error) {
        const reason = String(error?.code ?? 'cross-error');
        runtime.runLog?.append({ runId, phase: 'layer2', status: STATUS.FAIL, reason, workspaceId: 'global' }, now);
        return { runId, dryRun, runs, status: STATUS.FAIL, skipped: 'error', reason };
    } finally {
        if (typeof started.token === 'string' && started.token !== '') runtime.budget?.settle?.(started.token, { ok, now });
    }
}

/**
 * 把多段结果折成一个总状态与总计数（命令回显与 runlog 都能用）。
 *
 * @param {any[]} runs
 * @returns {{ counts: Record<string, number>, calls: number, status: string }}
 */
export function summarizeCrossRuns(runs = []) {
    const counts = emptyCrossCounts();
    let calls = 0;
    let failed = false;
    for (const run of Array.isArray(runs) ? runs : []) {
        calls += Number.isFinite(run?.calls) ? run.calls : 0;
        if (run?.status === STATUS.FAIL) failed = true;
        for (const key of Object.keys(counts)) {
            if (Number.isFinite(run?.counts?.[key])) counts[key] += Number(run.counts[key]);
        }
    }
    const ran = Array.isArray(runs) ? runs.filter((run) => run?.skipped === undefined || run?.skipped === null) : [];
    let status = STATUS.OK;
    if (failed) status = STATUS.FAIL;
    else if (ran.length > 0 && ran.every((run) => run.status === STATUS.DRY)) status = STATUS.DRY;
    else if (counts.promoted === 0 && counts.superseded === 0 && counts.deleted === 0) status = STATUS.NOOP;
    return { counts, calls, status };
}
