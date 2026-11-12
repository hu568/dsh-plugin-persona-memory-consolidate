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

import { LLM_TRUNCATED, codeOf, detailOfError } from './llm.js';
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
6. 不写「助手能 / 不能做什么」这类服务边界（例如「该助手不代用户登录账号」）：那只说明当次对话，不是长期事实。
7. 只写换个话题仍然成立、以后还会反复用到的结论；毫秒/像素等数值、函数名、文件路径、局部变量、调试过程属于实现细节，不进 FACT / MEMORY，写成 scope=journal。
8. 每条标 kind 与 importance：kind=conclusion（结论/约定/红线）| detail（实现细节、一次性发现）；importance 取 1–5（5=核心约定或踩坑红线，4=重要结论，3=一般结论，2=细节，1=一次性小事）；kind=detail 或 importance≤2 的 scope 必须写 journal。

输出 JSON（不要解释，不要代码块围栏）：
{"memories":[{"scope":"global|project|journal","content":"...","confidence":"high|medium|low","kind":"conclusion|detail","importance":3}]}`;

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

/**
 * 结论 / 细节分层（DESIGN v3 §14.1）。
 *
 * `detail` 不是「更短的结论」，而是**不该占静态槽的实现细节**：它会由
 * `pipeline.routeByGranularity()` 改判进 JOURNAL（不丢弃），因此这个字段直接决定
 * 一条结论进不进 FACT / MEMORY。
 */
export const KINDS = ['conclusion', 'detail'];
/** `kind` 非法时的缺省值（契约 §14.2）。 */
export const DEFAULT_KIND = 'conclusion';
/** `importance` 的取值区间与缺省值（1–5，缺省 3）。 */
export const MIN_IMPORTANCE = 1;
export const MAX_IMPORTANCE = 5;
export const DEFAULT_IMPORTANCE = 3;

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
 *   cwd?: string,
 *   adjudication?: { content: string, neighbors: { id: string, text: string }[] }[] | null,
 *   maxChars?: number,
 * }} [input]
 *   `cwd`：本次素材的真实工作目录。**空串 = 未归属**（`_unassigned` 桶 / 注册表查不到），
 *   这时提示词明确要求一律写 `scope=journal`——未归属批次的「通用结论」不能再进全局 FACT。
 * @returns {string}
 */
export function buildExtractionPrompt(input = {}) {
    const scope = input.scope === 'journal' ? 'journal' : 'both';
    const parts = [EXTRACTION_RULES];

    /*
     * 归属（P0-A）：规则 4 只说「project=只跟当前目录有关」，但**没给目录值**——未归属
     * 批次里模型只能靠猜，于是把通用结论写成 global（本机 FACT 里 15 行英语语法污染就是
     * 这么来的）。这里把真实目录贴出来；拿不到（空串）就明确收窄成 journal。
     */
    const cwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
    parts.push(cwd === ''
        ? '当前工作目录：未知（这批素材没有归属到任何项目）。这种批次一律写 scope=journal，不要写 global / project。'
        : `当前工作目录：${cwd}\n（project = 只属于这个目录；与目录无关的通用事实 = global；拿不准 = journal）`);

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

/**
 * 扫描一段（可能残缺的）JSON，返回「补全它还缺哪些闭括号」。
 *
 * 只做括号配平，不理解语义。三条安全边界：
 *  - 括号不配对 / 字符串没闭合 ⇒ 返回 `null`（这个截断点不可救，别硬拼）；
 *  - 不认识转义就直接跳过下一字符（`\"` 不该让字符串提前结束）；
 *  - 结果只含 `}` / `]`，永远不往正文里塞内容。
 *
 * @param {string} text
 * @returns {string | null} 例如 `']}'`；已经平衡 ⇒ `''`
 */
function missingClosers(text) {
    const stack = [];
    let inString = false;
    let escaped = false;
    for (const ch of text) {
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') stack.push('}');
        else if (ch === '[') stack.push(']');
        else if (ch === '}' || ch === ']') {
            if (stack.length === 0 || stack[stack.length - 1] !== ch) return null;
            stack.pop();
        }
    }
    if (inString) return null;
    return stack.reverse().join('');
}

/**
 * 抢救被 `max-tokens` 截断的抽取结果。
 *
 * **为什么值得做**：`max_tokens` 是「推理 + 正文」的总预算，额度在上游就被思考吃掉时，
 * 正文往往是「前几条结论完整、最后一条写了一半」。旧行为是整次作废（`LLM_TRUNCATED`
 * 一个字都不写），等于前面的钱和白花的 token 全扔了。这里按**元素边界**往回退：
 *
 *  1. 先直接解析（截断可能正好落在完整 JSON 之后）；
 *  2. 不行就从后往前找每个 `}` / `]`，截到那里并补齐缺的闭括号再解析——
 *     因为按边界截断，能解析出来的对象**必然是完整的**，不会写进半条结论；
 *  3. 仍不行返回 `null`，调用方按「真失败」处理（宁可这轮不算，也不许写半截）。
 *
 * 末尾悬空的逗号（`...,`）单独再试一次：那是截断最常见的形态。
 *
 * @param {string} text 模型已经吐出来的正文
 * @returns {{ ok: true, value: any } | null}
 */
export function salvageTruncatedResponse(text) {
    const raw = String(text ?? '').trim();
    if (raw === '') return null;

    const direct = parseModelJson(raw);
    if (direct.ok) return { ok: true, value: direct.value };

    const start = raw.indexOf('{');
    if (start === -1) return null;
    const body = raw.slice(start);

    /** 在 `end`（含）处截断，补闭括号，尝试解析。 */
    const attemptAt = (end) => {
        const prefix = body.slice(0, end);
        const closers = missingClosers(prefix);
        if (closers === null) return null;
        const candidate = parseModelJson(prefix + closers);
        return candidate.ok ? { ok: true, value: candidate.value } : null;
    };

    const cutPoints = [];
    for (let index = 0; index < body.length; index += 1) {
        const ch = body[index];
        if (ch === '}' || ch === ']') cutPoints.push(index + 1);
    }
    // 从最靠后的边界往回退：先救「尽量多的结论」，救不出来才继续扔。
    for (let cursor = cutPoints.length - 1; cursor >= 0; cursor -= 1) {
        const end = cutPoints[cursor];
        const hit = attemptAt(end);
        if (hit !== null) return hit;
        // 悬空逗号 / 空白：退一格再试（`{"memories":[{...},` 的常见形态）。
        let trimmed = end;
        while (trimmed > 0 && /[,\s]/.test(body[trimmed - 1])) trimmed -= 1;
        if (trimmed !== end) {
            const hitTrimmed = attemptAt(trimmed);
            if (hitTrimmed !== null) return hitTrimmed;
        }
    }
    return null;
}

/** `scope` 归一（模型偶尔写 `Global` / `PROJECT`）。 */function normalizeScope(scope) {
    const value = String(scope ?? '').trim().toLowerCase();
    return SCOPES.includes(value) ? value : '';
}

/** `confidence` 归一；缺省按 `medium`（§4.1 允许 low/medium/high）。 */
function normalizeConfidence(confidence) {
    const value = String(confidence ?? '').trim().toLowerCase();
    return CONFIDENCES.includes(value) ? value : 'medium';
}

/**
 * `kind` 归一（DESIGN §14.2）：只认 `conclusion` / `detail`，其余一律 `conclusion`。
 *
 * 为什么不把非法值当 `detail` 丢掉：分层是**观测 + 路由**手段，判错方向要把
 * 「本该进 FACT 的结论」判进 JOURNAL（更难发现），所以默认值走保守的一侧。
 *
 * @param {unknown} kind
 * @returns {string}
 */
export function normalizeKind(kind) {
    const value = String(kind ?? '').trim().toLowerCase();
    return KINDS.includes(value) ? value : DEFAULT_KIND;
}

/**
 * `importance` 归一（DESIGN §14.2）：非法 ⇒ 3；越界收敛到 1–5。
 *
 * 数字字符串也认（模型经常把 3 写成 `"3"`）：这不是「非法」，归一成整数即可。
 * 非有限数（`NaN` / `Infinity` / 缺失 / `''` / 对象）才回落到缺省值。
 *
 * @param {unknown} importance
 * @returns {number} 1–5 的整数
 */
export function normalizeImportance(importance) {
    let value = Number.NaN;
    if (typeof importance === 'number') value = importance;
    else if (typeof importance === 'string' && importance.trim() !== '') value = Number(importance.trim());
    if (!Number.isFinite(value)) return DEFAULT_IMPORTANCE;
    const rounded = Math.round(value);
    return Math.min(MAX_IMPORTANCE, Math.max(MIN_IMPORTANCE, rounded));
}

/**
 * 校验 memories 数组：逐条判，一条坏不影响整次沉淀（§3.3「逐条判定」）。
 *
 * @param {any} raw
 * @returns {{
 *   memories: { scope: string, content: string, confidence: string, kind: string, importance: number }[],
 *   rejects: { index: number, reason: string }[],
 * }}
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
        // `kind` / `importance` **不参与淘汰**：即使模型给得乱七八糟，条目也照收，
        // 只把两个字段归一到契约允许的取值（分层判错的代价由 routeByGranularity 兜）。
        memories.push({
            scope,
            content,
            confidence: normalizeConfidence(item.confidence),
            kind: normalizeKind(item.kind),
            importance: normalizeImportance(item.importance),
        });
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
 * 截断重试时强制压到的最低推理等级（DESIGN §13.2）。
 *
 * 只作为 `request.overrides.reasoningEffort` 的**意图**传给 `llm.js`：真正生不生效由
 * `prepareCall` 回调里的模型能力校验决定（不在 `model.reasoning.efforts` 里就退到
 * `efforts[0]`，连 `efforts` 都没有就一个键都不传）。这里绝不保证「一定传了 off」。
 */
export const TRUNCATE_RETRY_REASONING_EFFORT = 'off';

/**
 * 造抽取器。`callModel` 是唯一的外部依赖（A0 阶段注入假实现）。
 *
 * @param {{
 *   callModel?: (request: { prompt: string, provider: string, model: string, overrides?: { reasoningEffort?: string } }) => any,
 *   templates?: () => any,
 *   provider?: string,
 *   model?: string,
 *   maxChars?: number,
 *   retryOnTruncate?: boolean,
 *   resolveRetryOnTruncate?: () => boolean,
 * }} [options]
 *   `retryOnTruncate`（默认 true，DESIGN §13）：`LLM_TRUNCATED` 且抢救不出可用结果时，
 *   同 prompt 再调一次，`overrides.reasoningEffort` 请调用侧压到最低档。
 *   `resolveRetryOnTruncate` 给运行时用（设置页改完下一轮就生效）；两者都没有 ⇒ 开。
 * @returns {{
 *   extract: (input: {
 *     turns?: { turn?: number, user?: string, assistant?: string }[],
 *     conversation?: string,
 *     scope?: string,
 *     cwd?: string,
 *     adjudication?: any[],
 *   }) => Promise<{
 *     ok: boolean, reason: string, memories: any[], ops: any[], rejects: any[], prompt: string,
 *     calls?: number, truncated?: boolean, salvage?: string, retry?: string,
 *   }>,
 * }}
 */
export function createExtractor(options = {}) {
    const callModel = options.callModel;
    const provider = typeof options.provider === 'string' ? options.provider : '';
    const model = typeof options.model === 'string' ? options.model : '';

    /** 截断重试开关（现取：设置页关掉下一轮生效）。 */
    const retryEnabled = () => {
        if (typeof options.resolveRetryOnTruncate === 'function') {
            try {
                return options.resolveRetryOnTruncate() !== false;
            } catch {
                /* 取开关炸了：按默认开走（重试最坏情况是多花一次调用，比整次 FAIL 划算） */
            }
        }
        return options.retryOnTruncate !== false;
    };

    /** callModel 的返回可能是裸字符串，也可能是宿主适配器包的一层 `{text}`。 */
    const textOf = (response) => (typeof response === 'string'
        ? response
        : (typeof response?.text === 'string' ? response.text : ''));

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
            // 归属（P0-A）：真实工作目录跟着进提示词；未归属（空串）时抽取侧收窄成 journal。
            cwd: input.cwd,
            adjudication: input.adjudication,
            maxChars: options.maxChars,
        });

        if (typeof callModel !== 'function') {
            return { ok: false, reason: 'no-model', memories: [], ops: [], rejects: [], prompt, calls: 0 };
        }

        // `sessionId` 只用于宿主归因/日志（不影响结论），有就带上、没有就不带。
        const callRequest = { prompt, provider, model };
        const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
        if (sessionId !== '') callRequest.sessionId = sessionId;

        /** 真实发出的调用次数（预算与 runlog 的 `calls` 按它记账，绝不写死 1）。 */
        let attempts = 1;

        let response;
        try {
            response = await callModel(callRequest);
        } catch (error) {
            const code = codeOf(error, '');
            let retryCode = '';
            if (code === LLM_TRUNCATED) {
                // 截断抢救：`max_tokens` 吃光了额度，但正文可能已经完整（或只差一个闭括号）。
                // 只有 `LLM_TRUNCATED` 才走这条路——别的错误（401 / 超时 / 空流）没有可救的正文。
                const salvaged = salvageTruncatedResponse(error?.text ?? '');
                if (salvaged !== null) {
                    const parsed = parseExtractionResponse(JSON.stringify(salvaged.value));
                    if (parsed.ok && (parsed.memories.length > 0 || parsed.ops.length > 0)) {
                        // `truncated` 是给上层的观测信号（runlog 能看出这轮是「救回来的」），
                        // 不改变写入语义：救出来的每条都经过与正常路径完全相同的校验。
                        return { ...parsed, prompt, truncated: true, salvage: 'max-tokens', calls: attempts };
                    }
                }
                /*
                 * 抢救失败 / 只救出空结果 ⇒ **同 prompt 重试一次**（DESIGN §13）。
                 *
                 * 为什么值得多花一次调用：真实故障（本机 2026-11-09 12:39）是截断落在第一条
                 * 结论中间，抢救也救不回来，于是整次沉淀一个字没写。重试时把推理等级压到最低档
                 * ——`max_tokens` 是「推理 + 正文」的总预算，第一次的额度往往就是被思考吃光的。
                 *
                 * 只重试一次；`callTimeoutMs` 每次调用独立计时；重试仍失败按原逻辑 FAIL，
                 * `detail` 保留**第一次**的 finish 摘要（那是根因，重试只是补救）。
                 */
                if (retryEnabled()) {
                    attempts = 2;
                    const retryRequest = {
                        ...callRequest,
                        overrides: { reasoningEffort: TRUNCATE_RETRY_REASONING_EFFORT },
                    };
                    try {
                        const retried = await callModel(retryRequest);
                        const retriedParsed = parseExtractionResponse(textOf(retried));
                        if (retriedParsed.ok) {
                            return {
                                ...retriedParsed,
                                prompt,
                                truncated: true,
                                retry: 'max-tokens',
                                calls: attempts,
                            };
                        }
                        retryCode = String(retriedParsed.reason ?? 'invalid-json');
                    } catch (retryError) {
                        retryCode = codeOf(retryError, 'model-error');
                    }
                }
            }
            // 把真实错误码（NO_ROUTE / NO_ADAPTER / AUTH / LLM_TIMEOUT …）带上去：
            // 上层 runlog 只记 `extract-model-error` 时，故障排查等于盲人摸象
            // （本机 35 次连续失败，日志里看不出是路线没接上）。
            //
            // ⚠️ `String(error?.code ?? 'model-error')` 会把**空字符串**错误码原样传上去，
            // 于是 reason 只剩裸的 `extract-model-error`。空串一律当缺失（`codeOf`）。
            const detail = detailOfError(error);
            return {
                ok: false,
                reason: 'model-error',
                code: codeOf(error, 'model-error'),
                // 重试失败时把重试的错误码接在第一次摘要后面（前 200 字符仍是根因）。
                detail: retryCode === '' ? detail : `${detail} · retry:${retryCode}`,
                memories: [],
                ops: [],
                rejects: [],
                prompt,
                calls: attempts,
            };
        }
        const result = parseExtractionResponse(textOf(response));
        return { ...result, prompt, calls: attempts };
    };

    return { extract };
}
