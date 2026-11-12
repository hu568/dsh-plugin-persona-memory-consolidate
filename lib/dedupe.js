/**
 * 近重复**模型裁决**（0.7.0）：把「已有条目的近义改写」在写入前判成 NOOP。
 *
 * 为什么不再用统计阈值（真实数据已证伪，别再试第二次）：
 *  - 字符 2-gram Dice：实测 6 条重复 vs 已有条目最高 0.131，而真正的新结论 0.261 —— 排序**完全反着来**；
 *  - BM25 归一化（说明见 `merger.normalizedSimilarity`）：重复条 0.074–0.203，新结论 0.059–0.505，
 *    区间重叠到没法划线；
 *  - 现有 `preScreen` 的 [0.45, 0.95) 一律放行，而近义改写压根到不了 0.45。
 * 结论：语义等价不是字面重合的函数，只能让模型看一眼。宁可多花**一次**小调用（12 条候选一起判），
 * 也不要再靠阈值猜——猜错的方向恰好是「把新的当旧的」或「把旧的当新的」，两种都是静默数据损坏。
 *
 * 三条纪律：
 *  1. **不阻塞**：没接线 / 抛错 / 超时 / 返回非 JSON ⇒ 全部原样放行 + 记原因码，整轮照跑；
 *  2. **不自己造阈值**：近邻按 BM25 取 top-2 只是「喂给模型看什么」，判定权在模型；
 *  3. **只判静态槽**：`scope=journal` 的候选是事件流，本来就允许同义反复，判它没有收益还多花 token。
 *
 * 提示词放这里而不是 `extractor.js`：那份 prompt 是「抽取 + 归并」同一调用，语义完全不同；
 * 混在一起会让「改抽取提示词」与「改判重口径」互相牵连。
 */

import { parseModelJson } from './extractor.js';
import { codeOf } from './llm.js';
import { topNeighbors } from './merger.js';

/** 判重结论的稳定 reason：writer / runlog / 测试都按这个字符串认。 */
export const DEDUPE_REASON = 'model-near-duplicate';

/** 单次裁决的候选上限（一次调用判完；再多就该拆批，但 L1 一批通常只有几条）。 */
export const MAX_DEDUPE_CANDIDATES = 12;
/** 每条候选带几个近邻进 prompt。**2 个而不是 5 个**：多了模型会分心，把「同主题」当「同事实」。 */
export const DEDUPE_NEIGHBORS = 2;
/** 进 prompt 的近邻正文截断（一条结论通常 ≤100 字，160 足够认出改写）。 */
export const DEDUPE_NEIGHBOR_CHARS = 160;

/**
 * 判重调用的推理等级：**最低档**。
 *
 * 这只是「两句话是不是同一个事实」的短文本判断，不需要推理链；而 `max_tokens` 是
 * 「推理 + 正文」的总预算（本机 2026-11-09 的真实教训：high 档把 8192 全喂了思考，
 * finish=max-tokens，一个字没写）。这里写 `off`；模型若没有 `off` 档，
 * `llm.pickSupportedReasoningEffort()` 会退到它支持的最低档，绝不盲传一个非法值。
 */
export const DEDUPE_REASONING_EFFORT = 'off';
/** 判重调用的输出上限：一句 JSON 而已，512 绰绰有余（也给模型留点余量防截断）。 */
export const DEDUPE_MAX_OUTPUT_TOKENS = 512;

/**
 * 判重规则（中文，逐字进 prompt）。
 *
 * 为什么要显式列「不算重复」：只说「判重复」时模型偏爱把同主题条目也算进去，
 * 而真实现场（项目 MEMORY）里「依赖用 tarball 装」和「装完要重启引擎」是同主题、
 * 两条都该留的独立结论。宁可漏杀不可误杀——这条纪律与统计阈值时代一致，
 * 只是执行者从阈值换成了模型。
 */
export const NEAR_DUPLICATE_RULES = `下面是一批「本次新抽出的结论」，每条都附了它最相近的已有记忆条目。
请判断每条新结论是不是某个已有条目的**近义改写**（也就是已经记过了）。

算重复（任一成立即算）：
1. 同一事实换了说法：同义词替换、语序调整、主被动互换；
2. 同一条目加了修饰、限定或轻微补充，但信息量没有实质变化；
3. 上下位关系：新的更笼统或更具体，说的还是同一个事实。

不算重复（必须保留）：
1. 只是同主题的不同结论（讲的是同一件事的不同侧面）；
2. 新旧之间有冲突或更新（那是改写已有条目，不是重复）；
3. 只在措辞上共享术语，说的事实不同。

只根据给出的文字判断，不要猜上下文，不要补充理由段落。
只输出一个 JSON 对象，不要代码块围栏、不要解释：
{"duplicates":[{"index":0,"of":0,"why":"一句话"}]}
index = 候选方括号里的数字；of = 该候选近邻的序号（从 0 起）；why = 一句话说明为何算重复。
不在 duplicates 数组里的候选就是「新结论」。判断不了就不要放进数组。`;

/**
 * 造判重 prompt。
 *
 * @param {{ index: number, content: string, neighbors: { id?: string, text: string }[] }[]} items
 * @returns {string}
 */
export function buildDedupePrompt(items = []) {
    const blocks = [];
    for (const item of Array.isArray(items) ? items : []) {
        const neighbors = (Array.isArray(item?.neighbors) ? item.neighbors : [])
            .map((neighbor, order) => `   近邻 ${order}: ${String(neighbor?.text ?? '').trim()}`)
            .join('\n');
        blocks.push(`[${item?.index}] ${String(item?.content ?? '').trim()}${neighbors === '' ? '' : `\n${neighbors}`}`);
    }
    return [NEAR_DUPLICATE_RULES, '', '候选与近邻：', blocks.join('\n\n')].join('\n');
}

/**
 * 解析判重结果。
 *
 * 宽容的部分（模型经常这么干）：外面套 ```json 围栏、前后带一句寒暄——
 * 这两件事由 `extractor.parseModelJson()` 处理（它已经是全包唯一的 JSON 出口）。
 * **不容忍**的部分：形状不对（不是对象 / 没有 duplicates 数组）。这时候返回失败，
 * 上层按「全部放行」兜底——判重宁可漏杀，也不能因为模型胡写就把候选静默扔掉。
 *
 * @param {string} text
 * @returns {{ ok: boolean, duplicates: any[], reason: string }}
 */
export function parseDedupeVerdict(text) {
    const parsed = parseModelJson(text);
    if (parsed.ok !== true) return { ok: false, duplicates: [], reason: parsed.reason };
    const value = parsed.value;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, duplicates: [], reason: 'bad-shape' };
    }
    if (!Array.isArray(value.duplicates)) return { ok: false, duplicates: [], reason: 'bad-shape' };
    return { ok: true, duplicates: value.duplicates, reason: 'ok' };
}

/**
 * 近重复模型裁决：给每条候选找 top-2 近邻，**一次调用**判完，返回该改判 NOOP 的候选。
 *
 * 调用方（`pipeline.runL1`）负责把 `duplicates` 变成 NOOP 算子、把 `checked` / `duplicates.length`
 * 记进 runlog——这里只做「问 + 解析」，不做 IO、不写盘。
 *
 * @param {{
 *   candidates?: any[],
 *   pool?: { id?: string, text?: string }[],
 *   callModel?: (request: any) => any,
 *   provider?: string,
 *   model?: string,
 *   enabled?: boolean,
 *   maxCandidates?: number,
 * }} [options]
 * @returns {Promise<{
 *   kept: any[],
 *   duplicates: { index: number, of: number | null, why: string, content: string }[],
 *   checked: number,
 *   error: null | string,
 * }>}
 */
export async function adjudicateNearDuplicates(options = {}) {
    const candidates = Array.isArray(options.candidates) ? options.candidates : [];
    const pool = Array.isArray(options.pool) ? options.pool : [];
    const result = { kept: [...candidates], duplicates: [], checked: 0, error: null };
    // 一键退回 0.6.1 行为：完全不花这次调用（设置页 `dedupeModel`）。
    if (options.enabled === false) return result;
    if (candidates.length === 0 || pool.length === 0) return result;
    if (typeof options.callModel !== 'function') {
        result.error = 'no-model';
        return result;
    }

    const limit = Number.isFinite(options.maxCandidates)
        ? Math.max(1, Math.trunc(options.maxCandidates))
        : MAX_DEDUPE_CANDIDATES;
    const items = [];
    for (let index = 0; index < candidates.length && items.length < limit; index += 1) {
        const candidate = candidates[index];
        const scope = String(candidate?.scope ?? '').trim().toLowerCase();
        // journal 是事件流，同义反复是它的正常形态；只判会进静态槽的两类。
        if (scope !== 'global' && scope !== 'project') continue;
        const content = typeof candidate?.content === 'string' ? candidate.content.trim() : '';
        if (content === '') continue;
        let neighbors;
        try {
            neighbors = topNeighbors(content, pool, { topK: DEDUPE_NEIGHBORS });
        } catch (error) {
            // 打分（池 / 分词）坏了：整批放行，别把「打分器坏了」演成「全是新结论」。
            result.error = codeOf(error, 'score-error');
            return result;
        }
        if (neighbors.length === 0) continue;
        items.push({
            index,
            content,
            neighbors: neighbors.map((neighbor) => ({
                id: String(neighbor?.entry?.id ?? ''),
                text: String(neighbor?.entry?.text ?? '').slice(0, DEDUPE_NEIGHBOR_CHARS),
            })),
        });
    }
    // 没有可比对象（池为空 / 全是 journal）：一次调用都不花。
    if (items.length === 0) return result;
    result.checked = items.length;

    let response;
    try {
        response = await options.callModel({
            prompt: buildDedupePrompt(items),
            provider: options.provider ?? '',
            model: options.model ?? '',
            // 两个意图：压到最低推理档、把输出上限钉死在 512（均在 llm.js 里按模型能力降级）。
            overrides: { reasoningEffort: DEDUPE_REASONING_EFFORT },
            maxOutputTokens: DEDUPE_MAX_OUTPUT_TOKENS,
        });
    } catch (error) {
        // 超时 / 路由失败 / 宿主报错：全部放行，原因码交给 runlog。
        result.error = codeOf(error, 'model-error');
        return result;
    }

    const text = typeof response === 'string' ? response : (typeof response?.text === 'string' ? response.text : '');
    const parsed = parseDedupeVerdict(text);
    if (parsed.ok !== true) {
        result.error = parsed.reason;
        return result;
    }

    const valid = new Map(items.map((item) => [item.index, item]));
    const seen = new Set();
    for (const entry of parsed.duplicates) {
        const index = Number(entry?.index);
        // 只认真的送进 prompt 的下标：模型编出来的下标（幻觉 / 串号）一律忽略，
        // 否则一次胡写就可能把一条真正的新结论静默判死。
        if (!Number.isInteger(index) || !valid.has(index) || seen.has(index)) continue;
        seen.add(index);
        const ofRaw = Number(entry?.of);
        result.duplicates.push({
            index,
            of: Number.isInteger(ofRaw) ? ofRaw : null,
            why: String(entry?.why ?? '').slice(0, 120),
            content: valid.get(index).content,
        });
    }
    result.kept = candidates.filter((_, index) => !seen.has(index));
    return result;
}
