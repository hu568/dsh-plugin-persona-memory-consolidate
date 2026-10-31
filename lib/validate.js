/**
 * 校验与脱敏：本插件**不定义** FACT / MEMORY 的条目格式，一律问主插件
 * （00 §4.1 + 02 §4.2「模板与硬校验归主插件」）。本模块只做三件事：
 *
 *  1. 按 02 §4.3 的正则先扫一遍敏感串（打码 / 整条丢弃）；
 *  2. 懒加载 `@dsh-external/dsh-persona-memory/store`，调 `validateEntry(scope, entry, {cwd})`；
 *  3. 把结果折成三个出口：`ok` / `journal` / `drop`（02 §7.4 决策表的左列）。
 *
 * **可注入**：`createValidator({ resolveStore })` 的依赖是注入的，所以单测完全不
 * 需要装主插件包。真机的 `resolveStore` 是 `import()`，而且**懒**——只有在真的要
 * 校验时才解析一次，解析失败返回 null（插件照常加载，写入阶段判「store 不可用」）。
 *
 * 为什么敏感串命中后**绝不降级 JOURNAL**（02 §4.3 审计结论）：JOURNAL 是 recall
 * 每轮会注入提示词的那一层，把打码失败的条目丢进去等于把密钥送到模型面前。
 */

/** 统一占位符（00 §9 审计：`<redacted>` / `<已隐藏>` 两套已收敛成这一套）。 */
export const REDACTED = '⟨redacted⟩';

/** 打码后仍要满足的下限（02 §4.3）：≥ 8 字**且** ≥ 原长度 40%。 */
export const MIN_RESIDUAL_CHARS = 8;
export const MIN_RESIDUAL_RATIO = 0.4;

/**
 * 敏感串正则表（02 §4.3 的示意表，顺序即执行顺序）。
 *
 * `action: 'drop'` 表示命中即整条丢弃，其它是打码。私钥整块匹配 + 「只有 BEGIN
 * 没有 END」两条都在：只匹配完整的 BEGIN…END 会漏掉被截断的片段，而截断的私钥
 * 一样是密钥。
 */
export const SECRET_PATTERNS = [
    // 私钥整块（BEGIN 到 END，不只看头）。
    { id: 'private-key', pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, action: 'drop' },
    // 被截断的私钥头。
    { id: 'private-key-unterminated', pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----/g, action: 'drop' },
    // OpenAI 风格 key。
    { id: 'openai-key', pattern: /sk-[A-Za-z0-9_-]{16,}/g },
    // Bearer 头。
    { id: 'bearer', pattern: /Bearer\s+[A-Za-z0-9._-]{20,}/g },
    // 通用凭证赋值。
    { id: 'credential', pattern: /(api[_-]?key|token|password|passwd|secret)\s*[:=]\s*\S{6,}/gi },
    // 身份证（先于银行卡，否则 18 位会被银行卡规则先吃掉一半）。
    { id: 'id-card', pattern: /\b\d{17}[\dXx]\b/g },
    // 手机号（中国）。
    { id: 'phone-cn', pattern: /\b1[3-9]\d{9}\b/g },
    // 银行卡。
    { id: 'bank-card', pattern: /\b\d{16,19}\b/g },
];

/**
 * 打码（纯函数）。
 *
 * 返回的 `hits` 只有**命中类型**，从不含密文本身——runlog / superseded 都靠它落盘。
 *
 * @param {string} text 待打码正文。
 * @returns {{ text: string, hits: string[], drop: boolean }}
 */
export function redact(text) {
    const source = String(text ?? '');
    if (source === '') return { text: '', hits: [], drop: false };

    let out = source;
    const hits = [];
    let drop = false;

    for (const spec of SECRET_PATTERNS) {
        spec.pattern.lastIndex = 0;
        if (!spec.pattern.test(out)) continue;
        spec.pattern.lastIndex = 0;
        hits.push(spec.id);
        if (spec.action === 'drop') drop = true;
        out = out.replace(spec.pattern, REDACTED);
    }

    // 「打码后剩余正文 ≥ 8 字 且 ≥ 原长度 40%」只在**真的打码过**时才判：
    // 一条本来就很短的结论（如「重启 DSH」）不该被这条规则误杀。
    if (hits.length > 0) {
        const residual = out.trim().length;
        const original = source.trim().length;
        if (residual < MIN_RESIDUAL_CHARS || residual < original * MIN_RESIDUAL_RATIO) drop = true;
    }

    return { text: out, hits, drop };
}

/** 校验出口（02 §7.4）。 */
export const DECISION = { OK: 'ok', JOURNAL: 'journal', DROP: 'drop' };

/** 主插件 `./store` 子路径（0.7.0 起提供）。 */
export const STORE_SPECIFIER = '@dsh-external/dsh-persona-memory/store';

/** scope 白名单（02 §4.1 第 4 条）。 */
export const SCOPES = ['global', 'project', 'journal'];

/**
 * 本插件词汇 → store 词汇。
 *
 * ⚠️ 判断点（A0 唯一一处「口径只能先猜」的地方）：02 §4.1 的提示词用
 * `global|project|journal`，而 01 §3.4 的 `store.validateEntry(scope, …)` 没写死取值，
 * §3.3 的表里 FACT / MEMORY 是两种条目形态。这里按「global→FACT.md、
 * project→项目 MEMORY.md、journal→JOURNAL.jsonl」映射，并且**做成可注入**：
 * M1 与主插件联调时若要改口径，只改这一张表，调用方一行不动。
 */
export const STORE_SCOPE_MAP = { global: 'fact', project: 'memory', journal: 'journal' };

/** 映射到 store 词汇；未知 scope 返回空串。 */
export function toStoreScope(scope, map = STORE_SCOPE_MAP) {
    return map?.[String(scope ?? '').trim().toLowerCase()] ?? '';
}

/**
 * 造一个**懒** store 解析器。
 *
 * 解析失败（包没装 / 版本没有 `./store`）⇒ 永久返回 null，不反复重试、不抛错。
 * 这正是本插件「主插件 0.7.0 未就绪也能加载」的根据。
 *
 * @param {{ specifier?: string, importer?: (name: string) => Promise<any> }} [options]
 * @returns {() => Promise<any | null>}
 */
export function createStoreResolver(options = {}) {
    const specifier = options.specifier ?? STORE_SPECIFIER;
    const importer = options.importer ?? ((name) => import(name));
    let cached;
    let pending;

    return function resolveStore() {
        if (cached !== undefined) return Promise.resolve(cached);
        if (pending !== undefined) return pending;
        pending = Promise.resolve()
            .then(() => importer(specifier))
            .then((module) => {
                const store = module?.validateEntry !== undefined || module?.insertEntry !== undefined
                    ? module
                    : (module?.default ?? null);
                cached = store ?? null;
                return cached;
            })
            .catch(() => {
                cached = null;
                return null;
            });
        return pending;
    };
}

/**
 * 桶 × scope 的一致性（02 §7.0「写入断言」）。
 *
 * - `scope=project` ⇒ 必须有 workspaceId，且不能是 `_unassigned` 桶
 *   （实测注册表只登记了少数 sessionId，未分组会话很多，混成一个「项目」等于造假）；
 * - `_unassigned` 桶只允许 `journal` / `global`。
 *
 * @param {string} scope
 * @param {{ workspaceId?: string, bucket?: string, unassignedBucket?: string }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkBucketScope(scope, input = {}) {
    if (!SCOPES.includes(scope)) return { ok: false, reason: 'bad-scope' };
    const unassigned = input.unassignedBucket ?? '_unassigned';
    const bucket = input.bucket ?? input.workspaceId ?? '';
    if (scope !== 'project') return { ok: true, reason: 'ok' };
    if (bucket === '' || bucket === undefined || bucket === null) return { ok: false, reason: 'project-without-workspace' };
    if (bucket === unassigned) return { ok: false, reason: 'project-in-unassigned' };
    return { ok: true, reason: 'ok' };
}

/**
 * 造校验器。
 *
 * @param {{
 *   resolveStore?: (() => Promise<any | null>) | any | null,
 *   redactEnabled?: boolean,
 * }} [options]
 * @returns {{
 *   redact: (text: string) => { text: string, hits: string[], drop: boolean },
 *   validate: (scope: string, entry: any, context?: { cwd?: string, workspaceId?: string, bucket?: string, unassignedBucket?: string }) => Promise<{
 *     decision: string, reason: string, text: string, hits: string[], entry: any,
 *   }>,
 * }}
 */
export function createValidator(options = {}) {
    const redactEnabled = options.redactEnabled !== false;
    const scopeMap = options.storeScopeMap ?? STORE_SCOPE_MAP;
    const injected = options.resolveStore;
    const resolveStore = typeof injected === 'function'
        ? injected
        : (injected !== undefined && injected !== null
            ? () => Promise.resolve(injected)
            : createStoreResolver());

    const validate = async (scope, entry, context = {}) => {
        const content = typeof entry?.content === 'string' ? entry.content : '';
        const masked = redactEnabled ? redact(content) : { text: content, hits: [], drop: false };
        const base = { text: masked.text, hits: masked.hits, entry: { ...entry, content: masked.text } };

        if (masked.drop) return { ...base, decision: DECISION.DROP, reason: 'secret' };
        if (masked.text.trim() === '') return { ...base, decision: DECISION.DROP, reason: 'empty' };

        const bucket = checkBucketScope(scope, context);
        if (!bucket.ok) {
            // project 类对不上桶 ⇒ 降级 journal（§3.3「主体对不上当前项目根」同款口径）。
            return { ...base, decision: DECISION.JOURNAL, reason: bucket.reason };
        }

        let store;
        try {
            store = await resolveStore();
        } catch {
            store = null;
        }
        if (store === null || store === undefined) {
            // 未装主插件 0.7.0：写入阶段本来就无路可走，判 drop 并留原因，别假装 ok。
            return { ...base, decision: DECISION.DROP, reason: 'store-unavailable' };
        }
        if (typeof store.validateEntry !== 'function') {
            return { ...base, decision: DECISION.DROP, reason: 'store-no-validate' };
        }

        let verdict;
        try {
            verdict = await store.validateEntry(toStoreScope(scope, scopeMap), base.entry, { cwd: context.cwd });
        } catch (error) {
            if (error?.code === 'MEMORY_BUDGET_EXCEEDED') {
                return { ...base, decision: DECISION.JOURNAL, reason: 'budget-exceeded' };
            }
            return { ...base, decision: DECISION.DROP, reason: 'validate-error' };
        }

        if (verdict === undefined || verdict === null) {
            return { ...base, decision: DECISION.DROP, reason: 'validate-empty' };
        }
        if (verdict.ok === true) return { ...base, decision: DECISION.OK, reason: 'ok' };
        if (verdict.demote === DECISION.JOURNAL) {
            return { ...base, decision: DECISION.JOURNAL, reason: String(verdict.reason ?? 'demote-journal') };
        }
        // `demote: 'drop'` 与「没说 demote」都按丢处理：拿不准时不写正式记忆。
        return { ...base, decision: DECISION.DROP, reason: String(verdict.reason ?? 'rejected') };
    };

    return { redact, validate };
}
