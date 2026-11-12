/**
 * 归并：决定用哪个算子（ADD / UPDATE / DELETE / NOOP），**不负责写盘**。
 *
 * 为什么归并留在这里而不是主插件（02 §7.3 边界）：算子选择是语义判断，需要
 * 「BM25 近邻 + 一次 LLM 裁决」；主插件的 store 只执行**已决定的 op**，不做语义归并。
 *
 * 四步（§7.3.1–§7.3.5）：
 *  ① 检索：BM25 打分取 top 3（**复制** recall 的实现，`test/bm25-parity.test.mjs` 钉住同源）；
 *  ② 确定性预筛：完全相同 / 归一化相似度 ≥ 0.95 → NOOP；< 0.45 → ADD；其余才花钱；
 *  ③ 裁决：与抽取**同一次调用**（`callModel` 注入），结果按 target 白名单过一遍；
 *  ④ 冲突：时间 > 置信度；旧条目不物理删，旧值交给 writer 写 `superseded.jsonl`。
 *
 * ⚠️ 归一化相似度的口径（§9 审计 P0 第 5 条）：recall 的 BM25 是**绝对分（无上界）**，
 * 0.45 / 0.95 这两个阈值必须定义在 0–1 的**归一化**分上。这里取
 * `norm = score(候选词, 旧条目) ÷ score(候选词, 候选自身)`：分子分母用同一套 BM25、
 * 同一份下标，所以完全相同的两句话恒等于 1，毫不相关的两句话趋近 0。
 * 这正是 §7.3.2 说的「score ÷ 理论上界」的一个可算实现（初版口径，M1 用真实数据标定）。
 */

import { createHash } from 'node:crypto';
import { buildIndex, scoreIndex } from './bm25.js';
import { buildAdjudicationBlock, parseModelJson } from './extractor.js';
import { normalize as nfkc, tokenize } from './tokenize.js';

/** 预筛结论。 */
export const PRE_SCREEN = { NOOP: 'NOOP', ADD: 'ADD', ADJUDICATE: 'ADJUDICATE' };
/** 四算子。 */
export const OPS = ['ADD', 'UPDATE', 'NOOP', 'DELETE'];
/** 阈值（§7.3.2）。 */
export const SIM_NOOP = 0.95;
export const SIM_ADD = 0.45;
/** 单批上限（§7.3.6）。 */
export const MAX_NEIGHBORS = 3;
export const MAX_OPS = 8;
export const MAX_CONTEXT_CHARS = 2000;

/**
 * 归一化正文（用于「完全相同」判定与稳定 id）。
 *
 * 去首尾空白、NFKC、小写、空白折叠，并剥掉列表前缀与句末标点——「- 依赖用 tarball 装。」
 * 与「依赖用 tarball 装」应判为同一条。
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
    return nfkc(text)
        .replace(/^\s*(?:[-*+]|\d+[.)、])\s*/u, '')
        .replace(/\s+/gu, ' ')
        .replace(/[。．.；;，,、\s]+$/u, '')
        .trim();
}

/**
 * 条目 id：`sha1(归一化文本).slice(0,10)`（§7.3 定位方式初版）。
 *
 * 抗行号漂移；被人工改过的条目会匹配失败 → 调用方降级 ADD 并记 runlog（不硬改）。
 *
 * @param {string} text
 * @returns {string}
 */
export function entryId(text) {
    return createHash('sha1').update(normalizeText(text)).digest('hex').slice(0, 10);
}

/**
 * 从 FACT.md 切条目（`- ` 行，保留所属 `##` 分组）。
 *
 * @param {string} text
 * @returns {{ id: string, scope: 'fact', section: string, text: string }[]}
 */
export function parseFactEntries(text) {
    const entries = [];
    let section = '';
    for (const rawLine of String(text ?? '').split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        const heading = line.match(/^##\s+(.*)$/u);
        if (heading !== null) {
            section = heading[1].trim();
            continue;
        }
        const item = line.match(/^\s*-\s+(.*)$/u);
        if (item === null) continue;
        const entryText = item[1].trim();
        if (entryText === '') continue;
        entries.push({ id: entryId(entryText), scope: 'fact', section, text: entryText });
    }
    return entries;
}

/**
 * 从 MEMORY.md 切条目（`数字. ` 行；子项不单独成条，归并只看首行）。
 *
 * @param {string} text
 * @returns {{ id: string, scope: 'memory', text: string }[]}
 */
export function parseMemoryEntries(text) {
    const entries = [];
    for (const rawLine of String(text ?? '').split(/\r?\n/)) {
        const item = rawLine.match(/^\s*(\d+)[.、]\s+(.*)$/u);
        if (item === null) continue;
        const entryText = item[2].trim();
        if (entryText === '') continue;
        entries.push({ id: entryId(entryText), scope: 'memory', text: entryText });
    }
    return entries;
}

/**
 * 造候选池（FACT + MEMORY 条目）。JOURNAL 只做辅助证据，**不进池**
 * （§7.3.1：它不作 target）。
 *
 * @param {{ factText?: string, memoryText?: string }} [input]
 * @returns {{ id: string, scope: string, section?: string, text: string }[]}
 */
export function buildPool(input = {}) {
    const pool = [];
    const fact = parseFactEntries(input.factText ?? '');
    const memory = parseMemoryEntries(input.memoryText ?? '');
    for (const entry of fact) pool.push(entry);
    for (const entry of memory) pool.push(entry);
    return pool;
}

/** 候选当查询、单个旧条目当语料时的 BM25 绝对分。 */
function scorePair(queryTokens, docTokens) {
    if (queryTokens.length === 0 || docTokens.length === 0) return 0;
    const scored = scoreIndex(buildIndex([docTokens]), queryTokens);
    return scored.length > 0 ? scored[0].score : 0;
}

/**
 * 归一化相似度（0–1，见文件头口径说明）。
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function normalizedSimilarity(left, right) {
    const a = tokenize(left);
    const b = tokenize(right);
    if (a.length === 0 || b.length === 0) return 0;
    const ceiling = scorePair(a, a);
    if (ceiling <= 0) return 0;
    return Math.min(1, Math.max(0, scorePair(a, b) / ceiling));
}

/**
 * BM25 top-K 近邻。
 *
 * 排序用**池内** BM25 绝对分（和 recall 同一份实现、同一套分词），阈值用归一化分。
 *
 * @param {string} text 候选正文。
 * @param {{ id: string, text: string, scope?: string }[]} pool
 * @param {{ topK?: number }} [options]
 * @returns {{ entry: any, score: number, similarity: number }[]}
 */
export function topNeighbors(text, pool, options = {}) {
    const topK = Number.isFinite(options.topK) ? options.topK : MAX_NEIGHBORS;
    const entries = Array.isArray(pool) ? pool.filter((entry) => typeof entry?.text === 'string' && entry.text.trim() !== '') : [];
    if (entries.length === 0) return [];

    const index = buildIndex(entries.map((entry) => tokenize(entry.text)));
    const scored = scoreIndex(index, tokenize(text));
    return scored
        .map((hit) => ({
            entry: entries[hit.index],
            score: hit.score,
            similarity: normalizedSimilarity(text, entries[hit.index].text),
        }))
        .sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id))
        .slice(0, Math.max(1, topK));
}

/**
 * 确定性预筛（§7.3.2 四档）。
 *
 * @param {string} content 新结论。
 * @param {{ entry: any, score: number, similarity: number }[]} neighbors
 * @returns {{ decision: string, reason: string, top1: number }}
 */
export function preScreen(content, neighbors = []) {
    const key = normalizeText(content);
    for (const neighbor of neighbors) {
        if (normalizeText(neighbor.entry.text) === key) {
            return { decision: PRE_SCREEN.NOOP, reason: 'exact', top1: neighbor.similarity };
        }
    }
    if (neighbors.length === 0) return { decision: PRE_SCREEN.ADD, reason: 'no-neighbor', top1: 0 };

    const top1 = neighbors[0].similarity;
    if (top1 >= SIM_NOOP) return { decision: PRE_SCREEN.NOOP, reason: 'near-duplicate', top1 };
    if (top1 < SIM_ADD) return { decision: PRE_SCREEN.ADD, reason: 'low-similarity', top1 };
    return { decision: PRE_SCREEN.ADJUDICATE, reason: 'needs-adjudication', top1 };
}

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

/**
 * 冲突裁决：时间 > 置信度，仍打平保留旧的（§7.3.4）。
 *
 * @param {{ ts?: number, confidence?: string }} oldEntry
 * @param {{ ts?: number, confidence?: string }} newEntry
 * @returns {'new' | 'old'}
 */
export function resolveConflict(oldEntry = {}, newEntry = {}) {
    const oldTs = Number(oldEntry.ts);
    const newTs = Number(newEntry.ts);
    if (Number.isFinite(oldTs) && Number.isFinite(newTs) && oldTs !== newTs) {
        return newTs > oldTs ? 'new' : 'old';
    }
    const oldRank = CONFIDENCE_RANK[String(oldEntry.confidence ?? '')] ?? 0;
    const newRank = CONFIDENCE_RANK[String(newEntry.confidence ?? '')] ?? 0;
    if (oldRank !== newRank) return newRank > oldRank ? 'new' : 'old';
    // 时间未知且置信度打平：保守，不轻易改。
    return 'old';
}

/**
 * 硬约束过滤（§7.3.5）。**纯函数**，越界的一律降级而不是让整轮失败。
 *
 * @param {any[]} rawOps
 * @param {{ allowedTargets: Set<string> | string[], layer?: number, maxOps?: number, fallbackContent?: (index: number) => string }} options
 * @returns {{ ops: any[], rejects: { index: number, reason: string }[] }}
 */
export function sanitizeOps(rawOps = [], options = {}) {
    const allowed = options.allowedTargets instanceof Set ? options.allowedTargets : new Set(options.allowedTargets ?? []);
    const layer = options.layer === 2 ? 2 : 1;
    const maxOps = Number.isFinite(options.maxOps) ? options.maxOps : MAX_OPS;
    const ops = [];
    const rejects = [];

    rawOps.forEach((raw, index) => {
        if (ops.length >= maxOps) {
            rejects.push({ index, reason: 'over-limit' });
            return;
        }
        if (raw === null || typeof raw !== 'object') {
            rejects.push({ index, reason: 'not-object' });
            return;
        }
        const name = String(raw.op ?? '').trim().toUpperCase();
        if (!OPS.includes(name)) {
            rejects.push({ index, reason: 'bad-op' });
            return;
        }
        const target = typeof raw.target === 'string' ? raw.target.trim() : '';
        let content = typeof raw.content === 'string' ? raw.content.trim() : '';
        if (content === '' && typeof options.fallbackContent === 'function') {
            content = options.fallbackContent(index) ?? '';
        }

        if (name === 'NOOP') {
            ops.push({ op: 'NOOP', target, content, reason: 'model-noop' });
            return;
        }
        if (name === 'DELETE') {
            // 删除只允许第二层；第一层降级 NOOP（§7.3.5）。
            if (layer !== 2) {
                ops.push({ op: 'NOOP', target, content, reason: 'layer1-delete' });
                return;
            }
            if (target === '' || !allowed.has(target)) {
                ops.push({ op: 'NOOP', target, content, reason: 'bad-target' });
                return;
            }
            ops.push({ op: 'DELETE', target, content, reason: 'ok' });
            return;
        }
        if (name === 'UPDATE') {
            if (content === '') {
                ops.push({ op: 'NOOP', target, content, reason: 'empty-content' });
                return;
            }
            if (target === '' || !allowed.has(target)) {
                // target 不在本次给出的 id 集合里 ⇒ 降级 ADD（§7.3.5）。
                ops.push({ op: 'ADD', target: '', content, reason: 'bad-target' });
                return;
            }
            ops.push({ op: 'UPDATE', target, content, reason: 'ok' });
            return;
        }
        if (content === '') {
            ops.push({ op: 'NOOP', target: '', content, reason: 'empty-content' });
            return;
        }
        ops.push({ op: 'ADD', target: '', content, reason: 'ok' });
    });

    return { ops, rejects };
}

/**
 * 归并一批新结论。
 *
 * @param {{
 *   candidates: { content: string, scope?: string, confidence?: string, ts?: number }[],
 *   pool?: { id: string, text: string, scope?: string, ts?: number, confidence?: string }[],
 *   layer?: number,
 *   callModel?: (request: { prompt: string, provider: string, model: string }) => any,
 *   provider?: string,
 *   model?: string,
 *   maxOps?: number,
 *   rawOps?: any[],
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   reason: string,
 *   ops: any[],
 *   decisions: any[],
 *   counts: Record<string, number>,
 * }>}
 */
export async function mergeCandidates(options = {}) {
    const maxOps = Number.isFinite(options.maxOps) ? options.maxOps : MAX_OPS;
    const layer = options.layer === 2 ? 2 : 1;
    const pool = Array.isArray(options.pool) ? options.pool : [];
    const candidates = Array.isArray(options.candidates) ? options.candidates.slice(0, maxOps) : [];
    const poolById = new Map(pool.map((entry) => [entry.id, entry]));

    const decisions = candidates.map((candidate, index) => {
        const content = typeof candidate?.content === 'string' ? candidate.content.trim() : '';
        const neighbors = content === '' ? [] : topNeighbors(content, pool, { topK: MAX_NEIGHBORS });
        const pre = content === '' ? { decision: PRE_SCREEN.ADD, reason: 'empty-content', top1: 0 } : preScreen(content, neighbors);
        return {
            content,
            scope: candidate?.scope,
            /*
             * 候选在**本次抽取候选数组**里的下标（E4）。归并裁决可能把正文整段改写，
             * 改写后按正文回匹配 importance 必然掉档；下标是唯一稳定的锚点。
             * 注意：调用方传进来的 candidates 已按 maxOps 从头截断，所以下标与
             * 原数组一一对应（不做排序、不做过滤），attachImportance 可以安全回查。
             */
            sourceIndex: index,
            confidence: candidate?.confidence ?? 'medium',
            ts: candidate?.ts,
            neighbors,
            op: pre.decision === PRE_SCREEN.ADJUDICATE ? null : pre.decision,
            target: pre.decision === PRE_SCREEN.NOOP ? String(neighbors[0]?.entry.id ?? '') : '',
            reason: pre.reason,
            top1: pre.top1,
        };
    });

    const pending = decisions.map((decision, index) => (decision.op === null ? index : -1)).filter((index) => index >= 0);

    if (pending.length > 0) {
        if (typeof options.callModel !== 'function') {
            return { ok: false, reason: 'no-model', ops: [], decisions, counts: countOf(decisions) };
        }
        const items = pending.map((index) => ({
            content: decisions[index].content,
            neighbors: decisions[index].neighbors.map((neighbor) => ({ id: String(neighbor.entry.id), text: String(neighbor.entry.text) })),
        }));
        const prompt = truncateContext(buildAdjudicationBlock(items), MAX_CONTEXT_CHARS + 2000);
        let response;
        try {
            response = await options.callModel({ prompt, provider: options.provider ?? '', model: options.model ?? '' });
        } catch {
            return { ok: false, reason: 'model-error', ops: [], decisions, counts: countOf(decisions) };
        }
        const text = typeof response === 'string' ? response : (typeof response?.text === 'string' ? response.text : '');
        const parsed = parseModelJson(text);
        if (!parsed.ok) {
            // 非法 JSON ⇒ 整次放弃，不重试（§7.3.5）。
            return { ok: false, reason: parsed.reason, ops: [], decisions, counts: countOf(decisions) };
        }
        const value = parsed.value;
        const rawOps = Array.isArray(value?.ops) ? value.ops : (Array.isArray(value) ? value : null);
        if (rawOps === null) return { ok: false, reason: 'bad-shape', ops: [], decisions, counts: countOf(decisions) };

        const allowed = new Set();
        for (const item of items) for (const neighbor of item.neighbors) allowed.add(neighbor.id);
        const { ops: adjudicated } = sanitizeOps(rawOps, {
            allowedTargets: allowed,
            layer,
            maxOps: pending.length,
            fallbackContent: (index) => decisions[pending[index]]?.content ?? '',
        });

        pending.forEach((decisionIndex, order) => {
            const op = adjudicated[order];
            if (op === undefined) return;
            decisions[decisionIndex].op = op.op;
            decisions[decisionIndex].target = op.target;
            decisions[decisionIndex].reason = op.reason;
            if (op.content !== '') decisions[decisionIndex].content = op.content;
            decisions[decisionIndex].adjudicated = true;
        });
    }

    const ops = [];
    for (const decision of decisions) {
        if (decision.op === null) decision.op = PRE_SCREEN.NOOP; // 裁决没给这一条 ⇒ 保守 NOOP
        const op = buildOp(decision, poolById, layer);
        if (op !== null) ops.push(op);
    }

    return { ok: true, reason: 'ok', ops, decisions, counts: countOf(decisions) };
}

/** 把一条决策折成最终 op，并在这里应用冲突规则。 */
function buildOp(decision, poolById, layer) {
    const base = {
        op: decision.op,
        target: decision.target ?? '',
        content: decision.content,
        scope: decision.scope,
        confidence: decision.confidence,
        ts: decision.ts,
        reason: decision.reason,
        layer,
        // 候选下标（E4）：importance 按它回查，正文被改写也不会掉档。
        sourceIndex: Number.isInteger(decision.sourceIndex) ? decision.sourceIndex : undefined,
    };

    if (decision.op === 'UPDATE') {
        const old = poolById.get(decision.target);
        if (old === undefined) {
            // 目标消失（池里没有 / 被人工改过）⇒ 降级 ADD（§7.3 定位方式初版）。
            return { ...base, op: 'ADD', target: '', reason: 'target-vanished' };
        }
        const winner = resolveConflict({ ts: old.ts, confidence: old.confidence }, { ts: decision.ts, confidence: decision.confidence });
        if (winner === 'old') {
            return { ...base, op: 'NOOP', reason: 'conflict-keep-old' };
        }
        return { ...base, superseded: { id: old.id, text: old.text } };
    }

    if (decision.op === 'DELETE') {
        const old = poolById.get(decision.target);
        if (old === undefined) return { ...base, op: 'NOOP', reason: 'target-vanished' };
        return { ...base, superseded: { id: old.id, text: old.text } };
    }

    return base;
}

/** 计数（runlog 用）。 */
function countOf(decisions) {
    const counts = { candidates: decisions.length, added: 0, updated: 0, deleted: 0, noop: 0, adjudicated: 0 };
    for (const decision of decisions) {
        if (decision.adjudicated === true) counts.adjudicated += 1;
        if (decision.op === 'ADD') counts.added += 1;
        else if (decision.op === 'UPDATE') counts.updated += 1;
        else if (decision.op === 'DELETE') counts.deleted += 1;
        else counts.noop += 1;
    }
    return counts;
}

/** 截断超长的旧条目上下文（§7.3.6「旧条目上下文 ≤ 2,000 字符」）。 */
function truncateContext(text, maxChars) {
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（旧条目上下文已截断）` : text;
}
