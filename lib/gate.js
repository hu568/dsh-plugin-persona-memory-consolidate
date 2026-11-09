/**
 * 写入闸口（**纯函数、零 IO、零 LLM、同输入同输出**）：抽取结果落盘前的确定性过滤。
 *
 * 为什么必须有这一层：抽取是模型说了算，模型会把「暂无」「见上」「我先看了一下配置」
 * 「目前进度是快改完了」这类东西当成结论交上来；一旦写进 FACT / MEMORY，它们就变成
 * 永久噪音，还会被 recall 每轮召回、被 L2 当成稳定事实升格。这些判定**不需要也不该**
 * 交给模型（像素级一致的判定是纯函数才能保证的），所以单独一层。
 *
 * 依据：`Memory-Plugin-Ref/reports/A-npm-leaders.md` 第 6、7 条
 * （`@a9i5k4/dsh-auto-memory` 的 `consolidate-filter.js`：空壳正则、过程叙述正则、
 * `MIN_POINT_CHARS`、同段精确去重；`dsh-prime-memory` 的「状态断言必须带时点」）。
 *
 * 三条纪律：
 *  1. **只丢，不改写**：本模块绝不修补正文（改写 = 又一处会腐烂的第二实现）；
 *  2. **绝不静默丢**：每一条被丢的都有 `reason`，`gateBatch()` 返回按原因分类的计数，
 *     调用方（`pipeline.runL1`）把它写进 runlog 的 `gate` 字段；
 *  3. **宁可漏杀不可误杀**：判定只用「明显是空壳 / 明显是过程 / 明显缺时点」三类，
 *     拿不准的一律放行（漏掉一条噪音的代价，远小于丢一条真结论）。
 */

/** 一条结论的最短长度（字符）。低于它的基本是「改好了」「无」这种碎片。 */
export const MIN_POINT_CHARS = 8;

/** 穿透原因（写进 gate 计数与 runlog，字符串稳定）。 */
export const GATE_REASON = {
    /** 空串 / 纯空白。 */
    EMPTY: 'empty',
    /** 空壳与占位变体（「暂无」「见上」「同上」「无」…）。 */
    PLACEHOLDER: 'placeholder',
    /** 过程叙述开头（「我先」「接下来我」「然后我」「排查了」…）。 */
    PROCESS: 'process',
    /** 太短（< `MIN_POINT_CHARS`）。 */
    TOO_SHORT: 'too-short',
    /** 状态断言缺时点（「目前进度是…」但没有任何日期 / 版本锚点）。 */
    UNTIMED_STATE: 'untimed-state',
    /** 同批精确重复（归一化后相同，保序留第一条）。 */
    DUPLICATE: 'duplicate',
    /**
     * 助手自身的「能不能做」声明（「该助手不代用户登录账号」「该助手可帮用户查询…」）。
     *
     * 为什么单独一类：这是**当次对话的服务边界说明**，换个话题就不成立，却因为读起来
     * 像陈述句而被糊进 FACT 静态槽——本机 2026-11-09 的 FACT.md 里就有两条这种
     * 「该助手…」条目，每轮全量注入、召回还优先命中，纯噪音。
     *
     * 判定刻意做窄：只认「助手 + 能力/权限动词」，**不**按「该助手」开头一律拦——
     * 「该助手运行在 Android 手机的 Ubuntu 环境里」这种环境事实是有价值的，必须放行。
     */
    META_ASSISTANT: 'meta-assistant',
    /**
     * 跨池近重复（与**已有** FACT / 项目记忆条目完全相同或相似度 ≥ `SIM_NOOP`）。
     *
     * 这一条不是 `gateBatch()` 判的（单批看不到已有文件），而是
     * `pipeline.screenCrossPool()` 在闸口之后补的一道：同批重复管不到「上个月写过的
     * 同一条结论换个说法再交上来」，这里补上（DESIGN §5）。
     * 只拦 NOOP（exact / near-duplicate），落在 `[SIM_ADD, SIM_NOOP)` 的一律放行。
     */
    NEAR_DUPLICATE: 'near-duplicate',
};

/**
 * 计数口径（runlog 白名单按这个顺序落盘；顺序稳定 = 日志好 diff）。
 *
 * ⚠️ 新原因只能**追加在末尾**：runlog 是按这个数组的顺序落键的，插在中间会让
 * 新旧日志的键顺序错位，diff 起来全是噪音，人肉排查时特别费眼。
 */
export const GATE_REASONS = [
    GATE_REASON.EMPTY,
    GATE_REASON.PLACEHOLDER,
    GATE_REASON.PROCESS,
    GATE_REASON.TOO_SHORT,
    GATE_REASON.UNTIMED_STATE,
    GATE_REASON.DUPLICATE,
    GATE_REASON.NEAR_DUPLICATE,
    GATE_REASON.META_ASSISTANT,
];

/**
 * 空壳 / 占位变体（整句就是这些词，**不是**包含这些词）。
 *
 * 覆盖中英文与标点变体：`暂无` / `暂无。` / `- 无` / `N/A` / `nothing`。
 */
const PLACEHOLDER_WORDS = new Set([
    '无', '沒有', '没有', '暂无', '暂无内容', '无内容', '空', '略', '从略',
    '见上', '见前', '如上', '同上', '同上所述', '不适用', '未提及', '待补充',
    '待定', '待确认', '未知', '不清楚', '不重要', '没关系',
    'nothing', 'none', 'n/a', 'na', 'nil', 'null', 'undefined', 'todo', 'tbd',
    'n.a.', 'not applicable', 'no content',
]);

/** 整句只有标点 / 符号也算空壳（`-`、`—`、`…`、`。`）。 */
const PUNCT_ONLY = /^[\s\-—–_=*+~～.。,…·;；:：!！?？'"“”‘’`()（）[\]【】<>《》/\\|]+$/u;

/** 过程叙述开头：这些是「怎么做的」，不是「结论是什么」。 */
const PROCESS_PREFIXES = [
    // 第一人称 + 动作/状态词（「我先」「我们查了」「我刚才试了」）
    /^(?:我|我们)(?:先|刚刚|刚才|现在|已经|也|又|再|还|就|想|看|查|试|跑|做|改|确认|发现|觉得|准备|开始|需要|应该|正在)/u,
    // 连接词开头（「然后我」「接下来」「于是」「首先」「最后」）
    /^(?:然后|接着|接下来|随后|于是|首先|其次|另外|还有|与此同时|由此|综上)/u,
    // 动作动词开头（「尝试…」「排查…」「分析…」）
    /^(?:尝试|检查|排查|分析|讨论|查看|搜索|思考|考虑|计划|试了|跑了|看了|查了|确认了|验证了|研究了|对比了)/u,
];

/** 状态断言（「目前进度是」「现在是 X 版本」「已经升级到」）。 */
const STATE_ASSERTION = /(现在是|目前是|目前进度|当前进度|当前是|进度是|状态是|版本是|现在用|正在用|已经升级到|已升级到|已经更新到|已更新到)/u;

/** 时点锚点：日期 / 相对日 / 「截至」这类明确的时间限定。 */
const TIME_ANCHOR = /(\d{4}\s*[-/.年]\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|今天|昨天|前天|本周|上周|本月|上个月|今年|去年|截至|截止|20\d{2}\s*年)/u;

/** 版本锚点：`0.2.0` / `v2` / `版本 3`。带版本号的状态断言不算「缺时点」。 */
const VERSION_ANCHOR = /(\d+\.\d+(?:\.\d+)*|版本\s*\d|version\s*\d)/iu;

/**
 * 助手自身的「能不能做」声明（见 {@link GATE_REASON.META_ASSISTANT}）。
 *
 * 只认「（该|本|此）助手 + 能力/权限动词」：`不代` / `可帮` / `不能` / `只支持`…
 * 有意**不**匹配「该助手运行在…」「该助手使用…」这类环境事实。
 */
const META_ASSISTANT = /^(?:该|本|此|这个)?助手(?:不可以|不能|不会|无法|不代|不提供|不支持|只支持|只负责|仅支持|仅负责|可以|能够|可|能|会|支持|负责)/u;

/**
 * 归一化：NFKC + 折叠空白 + 去 markdown 项目符号/强调壳 + 去尾部标点。
 *
 * 只用于**判等与判空**，不用于写盘（写盘始终是原始正文）。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function normalizePoint(text) {
    let value = String(text ?? '');
    try {
        value = value.normalize('NFKC');
    } catch {
        /* 老 node 或奇怪输入：不归一也比抛错强 */
    }
    return value
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, '')
        // 先削尾部标点与空白，再削 markdown 强调壳（`**结论**。` 两样都在边界上）。
        .replace(/[。．.；;，,、~～!:：!?？…·\s]+$/u, '')
        .replace(/^[\s`"'“”‘’*_~]+|[\s`"'“”‘’*_~]+$/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
}

/** 取正文（兼容字符串与 `{content}`；手写测试两种都用）。 */
function contentOf(point) {
    if (typeof point === 'string') return point;
    return String(point?.content ?? '');
}

/**
 * 判一条结论该不该被拦。
 *
 * 判定顺序固定（与 `GATE_REASONS` 一致）：空 → 空壳 → 过程 → 太短 → 缺时点。
 * 重复项由 `gateBatch()` 判（单条无法知道「同批」）。
 *
 * @param {string | { content?: string }} point
 * @returns {{ ok: boolean, reason: string, text: string }}
 */
export function gatePoint(point) {
    const raw = contentOf(point);
    const text = normalizePoint(raw);
    if (raw.trim() === '') return { ok: false, reason: GATE_REASON.EMPTY, text };
    // 归一化后什么都不剩（「…」「。」「-」）也算空壳。
    if (text === '' || PUNCT_ONLY.test(text)) return { ok: false, reason: GATE_REASON.EMPTY, text };
    if (PLACEHOLDER_WORDS.has(text.toLowerCase())) return { ok: false, reason: GATE_REASON.PLACEHOLDER, text };
    if (PROCESS_PREFIXES.some((pattern) => pattern.test(text))) return { ok: false, reason: GATE_REASON.PROCESS, text };
    if ([...text].length < MIN_POINT_CHARS) return { ok: false, reason: GATE_REASON.TOO_SHORT, text };
    if (STATE_ASSERTION.test(text) && !TIME_ANCHOR.test(text) && !VERSION_ANCHOR.test(text)) {
        return { ok: false, reason: GATE_REASON.UNTIMED_STATE, text };
    }
    if (META_ASSISTANT.test(text)) return { ok: false, reason: GATE_REASON.META_ASSISTANT, text };
    return { ok: true, reason: 'ok', text };
}

/** 空计数（每次 runL1 都从全 0 开始，绝不继承上一次）。 */
export function emptyGateCounts() {
    const counts = { total: 0, kept: 0, dropped: 0 };
    for (const reason of GATE_REASONS) counts[reason] = 0;
    return counts;
}

/**
 * 批量过闸：丢掉空壳 / 过程 / 太短 / 缺时点 / 同批重复，**保序保留其余**。
 *
 * 返回的 `kept` 是**原始对象**（不重建、不改写），调用方继续拿它的 scope / confidence。
 *
 * `options.enabled === false` 时**整批放行**（`disabled: true`，`dropped: []`）——
 * 线上误杀时可以一键关掉（`config.gateEnabled`），不必改代码。关闭时
 * `counts` 仍给 `total`/`kept`/`dropped:0`，但**不填分类计数**：
 * 「闸口没启用」和「启用了但没拦」是两件事，调用方（pipeline）据此决定
 * runlog 里**根本不写** `gate` 字段。
 *
 * 注意：跨池近重复（{@link GATE_REASON.NEAR_DUPLICATE}）不在本函数里判——同批看不到
 * 已有文件。`pipeline.screenCrossPool()` 会在本函数之后补一道，并把计数加进同一份
 * `counts`（`dropped` / `kept` / `near-duplicate` 同步调整，`kept + dropped === total` 恒成立）。
 *
 * @param {(string | { content?: string, scope?: string })[]} points
 * @param {{ enabled?: boolean }} [options]
 * @returns {{
 *   kept: any[], dropped: { index: number, reason: string, content: string }[],
 *   counts: Record<string, number>, total: number, disabled?: boolean,
 * }}
 */
export function gateBatch(points = [], options = {}) {
    const items = Array.isArray(points) ? points : [];
    const counts = emptyGateCounts();
    if (options.enabled === false) {
        counts.total = items.length;
        counts.kept = items.length;
        return { kept: [...items], dropped: [], counts, total: items.length, disabled: true };
    }
    const kept = [];
    const dropped = [];
    const seen = new Set();
    items.forEach((item, index) => {
        const verdict = gatePoint(item);
        if (verdict.ok !== true) {
            counts[verdict.reason] += 1;
            counts.dropped += 1;
            dropped.push({ index, reason: verdict.reason, content: contentOf(item) });
            return;
        }
        if (seen.has(verdict.text)) {
            counts[GATE_REASON.DUPLICATE] += 1;
            counts.dropped += 1;
            dropped.push({ index, reason: GATE_REASON.DUPLICATE, content: contentOf(item) });
            return;
        }
        seen.add(verdict.text);
        counts.kept += 1;
        kept.push(item);
    });
    counts.total = items.length;
    return { kept, dropped, counts, total: items.length };
}
