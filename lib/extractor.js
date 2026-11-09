/**
 * 抽取：**一次 LLM 调用** + JSON 校验（02 §4.1 / §7.2 / §7.3.3）。
 *
 * 本模块里没有真实的模型调用：`callModel` 是注入的依赖（`({prompt, provider, model}) => string`），
 * 所以 A0 阶段可以整套跑通、单测也不需要宿主或网络。真正接线留给 M1
 * （在 `agent/pre-step` 里「借用户请求顺带沉淀」或在空闲后调宿主 llm 服务）。
 *
 * 三条拍板：
 *  1. 提示词**只有这一份**，约 15 行（§4.1「为什么这么短」：目标是**不污染**，
 *     规则越少越不会补理由）；
 *  2. 输出非法 JSON ⇒ **整次放弃**，不重试、pending 保留（§7.3.5）；
 *  3. 归并裁决**不新增调用**，在同一份 prompt 末尾追加 §7.3.3 那一段。
 *
 * 提示词里**不硬编码** FACT / MEMORY 的条目格式：格式由主插件
 * `store.templates()` 给（00 §4.1 拍板），这里只负责把 `promptFragment` 贴进去。
 */

import { codeOf, detailOfError } from './llm.js';
import { SCOPES } from './validate.js';

/**
 * 抽取规则正文（02 §4.1 原文，逐字保留）。
 *
 * ⚠️ 改这段等于改产品行为：`test/extractor.test.mjs` 对它有逐字断言。
 */
export const EXTRACTION_RULES = `从下面的对话里，抽出值得长期记住的结论。

规则：
1. 一条一个结论，第三人称陈述句。
2. 只写结论，不写原因、不写过程、不写评价。
3. 没有值得记的就返回空数组。
4. scope：global=任何项目都成立的；project=只跟当前目录有关的；journal=一次性事件。
5. 不写密钥、密码、token、手机号、身份证、卡号；必须提到时一律写成 ⟨redacted⟩。

输出 JSON（不要解释，不要代码块围栏）：
{"memories":[{"scope":"global|project|journal","content":"...","confidence":"high|medium|low"}]}`;

/** 归并裁决段（02 §7.3.3 原文骨架）。 */
export const ADJUDICATION_RULES = `下面是已存在的记忆条目（[id] 内容）与本次新结论。
对每条新结论，选择操作：
  ADD    = 全新的信息
  UPDATE = 与某条旧条目冲突或更完整，写 target=该条 id
  NOOP   = 旧条目已经表达了同样的意思
  DELETE = 旧条目已被证明错误（仅跨会话整理时可用）
规则：只写结论，不写原因；target 只能从给出的 id 里选。`;

/** 允许的 confidence（§4.1 输出格式）。 */
export const CONFIDENCES = ['high', 'medium', 'low'];

/** 一次调用里最多允许几条 memories（§7.3.6 `newCandidates ≤ 8`）。 */
export const MAX_CANDIDATES = 8;

/**
 * 把几轮对话渲染成 prompt 里的「对话」段。
 *
 * @param {{ turn?: number, user?: string, assistant?: string }[]} turns
 * @returns {string}
 */
export function buildConversation(turns = []) {
    const blocks = [];
    turns.forEach((sample, index) => {
        const turn = Number.isFinite(sample?.turn) ? sample.turn : index + 1;
        const user = typeof sample?.user === 'string' ? sample.user.trim() : '';
        const assistant = typeof sample?.assistant === 'string' ? sample.assistant.trim() : '';
        if (user === '' && assistant === '') return;
        blocks.push(`### 第 ${turn} 轮\n用户：${user}\n助手：${assistant}`);
    });
    return blocks.join('\n\n');
}

/**
 * 造抽取提示词（不含裁决段时就是 02 §4.1 那一份）。
 *
 * @param {{
 *   turns?: { turn?: number, user?: string, assistant?: string }[],
 *   conversation?: string,
 *   templates?: { promptFragment?: string } | null,
 *   scope?: string,
 *   adjudication?: { content: string, neighbors: { id: string, text: string }[] }[] | null,
 *   maxChars?: number,
 * }} [input]
 * @returns {string}
 */
export function buildExtractionPrompt(input = {}) {
    const scope = input.scope === 'journal' ? 'journal' : 'both';
    const parts = [EXTRACTION_RULES];

    if (scope === 'journal') {
        // `scope: journal` 的部署只写 JOURNAL（02 §8 的 `scope` 键），提示词里直接收窄。
        parts.push('本次限制：只允许 scope=journal（一次性事件），不要输出 global / project。');
    }

    const fragment = typeof input.templates?.promptFragment === 'string' ? input.templates.promptFragment.trim() : '';
    if (fragment !== '') {
        parts.push(`目标格式（由主插件提供，写 FACT / MEMORY 时遵守）：\n${fragment}`);
    }

    const conversation = typeof input.conversation === 'string'
        ? input.conversation
        : buildConversation(input.turns ?? []);
    const maxChars = Number.isFinite(input.maxChars) ? input.maxChars : 8000;
    // 超预算从**尾部**截断（02 §7.1「通用」）：最近的对话才是这轮沉淀的目标。
    const clipped = conversation.length > maxChars ? `…（前段已截断）\n${conversation.slice(-maxChars)}` : conversation;
    parts.push(clipped === '' ? '对话：\n（空）' : `对话：\n${clipped}`);

    if (Array.isArray(input.adjudication) && input.adjudication.length > 0) {
        parts.push(buildAdjudicationBlock(input.adjudication));
    }

    return parts.join('\n\n');
}

/**
 * 造 §7.3.3 的裁决段（同一份 prompt 的末尾）。
 *
 * @param {{ content: string, neighbors: { id: string, text: string }[] }[]} items
 * @returns {string}
 */
export function buildAdjudicationBlock(items = []) {
    const old = [];
    const fresh = [];
    for (const item of items) {
        for (const neighbor of item?.neighbors ?? []) {
            const id = String(neighbor?.id ?? '');
            const text = String(neighbor?.text ?? '').trim();
            if (id === '' || text === '') continue;
            if (!old.some((line) => line.id === id)) old.push({ id, text });
        }
        const content = String(item?.content ?? '').trim();
        if (content !== '') fresh.push(content);
    }

    return [
        ADJUDICATION_RULES,
        '',
        '旧条目：',
        old.length === 0 ? '（无）' : old.map((line) => `[${line.id}] ${line.text}`).join('\n'),
        '',
        '新结论：',
        fresh.length === 0 ? '（无）' : fresh.map((line) => `- ${line}`).join('\n'),
        '',
        '输出 JSON：',
        '{"ops":[{"op":"ADD|UPDATE|NOOP|DELETE","target":"id 或空","content":"最终写入的结论"}]}',
    ].join('\n');
}

/**
 * 从模型输出里取 JSON。
 *
 * 只容忍两件「不是错」的事：外面套了代码块围栏、前后有寒暄。**JSON 本身坏了
 * 就返回失败**，由上层整次放弃（§7.3.5「输出非法 JSON ⇒ 整次放弃，不重试」）。
 *
 * @param {string} text
 * @returns {{ ok: boolean, value?: any, reason: string }}
 */
export function parseModelJson(text) {
    let raw = String(text ?? '').trim();
    if (raw === '') return { ok: false, reason: 'empty-response' };

    const fenced = raw.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/);
    if (fenced !== null) raw = fenced[1].trim();

    const attempt = (candidate) => {
        try {
            return { ok: true, value: JSON.parse(candidate), reason: 'ok' };
        } catch {
            return null;
        }
    };

    const direct = attempt(raw);
    if (direct !== null) return direct;

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
        const inner = attempt(raw.slice(start, end + 1));
        if (inner !== null) return inner;
    }
    return { ok: false, reason: 'invalid-json' };
}

/** `scope` 归一（模型偶尔写 `Global` / `PROJECT`）。 */
function normalizeScope(scope) {
    const value = String(scope ?? '').trim().toLowerCase();
    return SCOPES.includes(value) ? value : '';
}

/** `confidence` 归一；缺省按 `medium`（§4.1 允许 low/medium/high）。 */
function normalizeConfidence(confidence) {
    const value = String(confidence ?? '').trim().toLowerCase();
    return CONFIDENCES.includes(value) ? value : 'medium';
}

/**
 * 校验 memories 数组：逐条判，一条坏不影响整次沉淀（§3.3「逐条判定」）。
 *
 * @param {any} raw
 * @returns {{ memories: { scope: string, content: string, confidence: string }[], rejects: { index: number, reason: string }[] }}
 */
export function normalizeMemories(raw) {
    const memories = [];
    const rejects = [];
    if (!Array.isArray(raw)) return { memories, rejects: [{ index: -1, reason: 'not-array' }] };

    raw.slice(0, MAX_CANDIDATES).forEach((item, index) => {
        if (item === null || typeof item !== 'object') {
            rejects.push({ index, reason: 'not-object' });
            return;
        }
        const content = typeof item.content === 'string' ? item.content.trim() : '';
        if (content === '') {
            rejects.push({ index, reason: 'empty-content' });
            return;
        }
        const scope = normalizeScope(item.scope);
        if (scope === '') {
            rejects.push({ index, reason: 'bad-scope' });
            return;
        }
        memories.push({ scope, content, confidence: normalizeConfidence(item.confidence) });
    });

    if (raw.length > MAX_CANDIDATES) {
        rejects.push({ index: MAX_CANDIDATES, reason: 'over-limit' });
    }
    return { memories, rejects };
}

/**
 * 解析抽取结果（`{"memories":[...]}`，可同时带 `ops`：裁决与抽取是同一次调用）。
 *
 * @param {string} text
 * @returns {{ ok: boolean, memories: any[], ops: any[], rejects: any[], reason: string }}
 */
export function parseExtractionResponse(text) {
    const parsed = parseModelJson(text);
    if (!parsed.ok) return { ok: false, memories: [], ops: [], rejects: [], reason: parsed.reason };
    const value = parsed.value;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, memories: [], ops: [], rejects: [], reason: 'bad-shape' };
    }
    const { memories, rejects } = normalizeMemories(value.memories);
    const ops = Array.isArray(value.ops) ? value.ops : [];
    return { ok: true, memories, ops, rejects, reason: 'ok' };
}

/**
 * 造抽取器。`callModel` 是唯一的外部依赖（A0 阶段注入假实现）。
 *
 * @param {{
 *   callModel?: (request: { prompt: string, provider: string, model: string }) => any,
 *   templates?: () => any,
 *   provider?: string,
 *   model?: string,
 *   maxChars?: number,
 * }} [options]
 * @returns {{
 *   extract: (input: {
 *     turns?: { turn?: number, user?: string, assistant?: string }[],
 *     conversation?: string,
 *     scope?: string,
 *     adjudication?: any[],
 *   }) => Promise<{
 *     ok: boolean, reason: string, memories: any[], ops: any[], rejects: any[], prompt: string,
 *   }>,
 * }}
 */
export function createExtractor(options = {}) {
    const callModel = options.callModel;
    const provider = typeof options.provider === 'string' ? options.provider : '';
    const model = typeof options.model === 'string' ? options.model : '';

    const extract = async (input = {}) => {
        let templates = null;
        try {
            const loaded = typeof options.templates === 'function' ? options.templates() : options.templates;
            templates = loaded ?? null;
        } catch {
            templates = null;
        }

        const prompt = buildExtractionPrompt({
            turns: input.turns,
            conversation: input.conversation,
            templates,
            scope: input.scope,
            adjudication: input.adjudication,
            maxChars: options.maxChars,
        });

        if (typeof callModel !== 'function') {
            return { ok: false, reason: 'no-model', memories: [], ops: [], rejects: [], prompt };
        }

        let response;
        try {
            // `sessionId` 只用于宿主归因/日志（不影响结论），有就带上、没有就不带。
            const callRequest = { prompt, provider, model };
            const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
            if (sessionId !== '') callRequest.sessionId = sessionId;
            response = await callModel(callRequest);
        } catch (error) {
            // 把真实错误码（NO_ROUTE / NO_ADAPTER / AUTH / LLM_TIMEOUT …）带上去：
            // 上层 runlog 只记 `extract-model-error` 时，故障排查等于盲人摸象
            // （本机 35 次连续失败，日志里看不出是路线没接上）。
            //
            // ⚠️ `String(error?.code ?? 'model-error')` 会把**空字符串**错误码原样传上去，
            // 于是 reason 只剩裸的 `extract-model-error`。空串一律当缺失（`codeOf`）。
            return {
                ok: false,
                reason: 'model-error',
                code: codeOf(error, 'model-error'),
                detail: detailOfError(error),
                memories: [],
                ops: [],
                rejects: [],
                prompt,
            };
        }
        const text = typeof response === 'string' ? response : (typeof response?.text === 'string' ? response.text : '');
        const result = parseExtractionResponse(text);
        return { ...result, prompt };
    };

    return { extract };
}
