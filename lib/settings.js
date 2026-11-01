/**
 * 设置页「设置 → 记忆 → 自动沉淀」的声明式设置项 + 覆盖层持久化。
 *
 * 与兄弟插件 `dsh-persona-memory-recall/lib/settings.js` 同一套做法：
 * 值存 `$DSH_HOME/memory/consolidate/settings.json`，只存用户**显式改过**的键；
 * 覆盖层优先，没设过的键回落到组合配置（`cordis.patch.yml`）。
 *
 * 为什么页面只暴露一部分键（02 §8 最后一行）：`enabled / crossEnabled /
 * crossSource` 与阈值是日常要调的东西；`dryRun`、`workspaceRegistry`、`partialKeep` 这类是
 * 现场排查或预留开关，放进页面只会增加误解规模。
 *
 * P1 起页面多一个 `mode`（运行档位）：`enabled` 只能表达「开/关」，而「真跑管线但先看
 * 本来会写什么」这个中间态（影子模式）必须单独一档，否则只能靠改代码里的 `dryRun` —
 * 那个开关连报告都不出正文，看不见「本来会写什么」。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renameWithRetry } from './atomic.js';
import { consolidateDir } from './cursor.js';
import { MODE } from './mode.js';

/** 覆盖层文件名。 */
const SETTINGS_FILE = 'settings.json';

/** 分组。 */
export const SETTINGS_GROUP = '自动沉淀';
export const SETTINGS_ADVANCED_GROUP = '自动沉淀 · 高级';

/** 覆盖层路径。 */
export function consolidateOverridesPath(home) {
    return join(consolidateDir(home), SETTINGS_FILE);
}

/**
 * 页面可改的键。
 *
 * `text` 控件里混着两类值：数字项（`minTurns` / `minChars` …）与字符串项
 * （`provider` / `model`）。宿主没有 number 控件，回写一律是字符串，靠
 * `coerceSetting()` 按 spec 上的 `numeric` / `integer` / `min` / `max` 区分：
 * 数字项解析成数字（不合法抛错，页面保留旧值），字符串项去空白后原样返回。
 */
export const SETTINGS_SPECS = [
    {
        key: 'mode',
        kind: 'select',
        lowercase: true,
        options: [
            { value: MODE.AUTO, label: '正式写入（auto）' },
            { value: MODE.OBSERVE, label: '影子模式（observe，真跑但只记 would-write）' },
            { value: MODE.OFF, label: '关闭（off，完全静默）' },
        ],
        title: '运行档位',
        description: 'off = 完全静默（等价关掉下面的开关）；observe = 和 auto 一样自动跑（同门槛、同兜底扫描、'
            + '同跨会话日跑，LLM 花销 ≈ auto），但「写入」换成只落 memory/consolidate/would-write/<日期>.jsonl，'
            + '不碰 FACT / MEMORY / JOURNAL；auto = 正式写入。'
            + '优先级：显式切到 off / observe 时以本档为准（不看下面的开关）；只有 auto 才跟随下面的开关。'
            + '注意：observe 下素材照 auto 口径被消费/推进游标，切到 auto 后不会补写。',
        order: 20,
    },
    {
        key: 'enabled',
        kind: 'toggle',
        title: '自动沉淀',
        description: '回合结束只写 L0 暂存；攒够门槛才花一次 LLM。关掉即完全静默。'
            + '注意：上面的「运行档位」切到 off / observe 时以档位为准，本开关只在 auto 档生效。',
        order: 10,
    },
    {
        key: 'crossEnabled',
        kind: 'toggle',
        title: '跨会话整理',
        description: '每天一次或在素材够多时整理；出现 ≥2 次的结论升格为稳定事实。',
        order: 30,
    },
    {
        key: 'crossSource',
        kind: 'select',
        options: [
            { value: 'auto', label: '自动（服务 → 文件 → JOURNAL）' },
            { value: 'journal', label: 'JOURNAL（默认，零依赖）' },
            { value: 'service', label: '会话检索服务（实验性）' },
            { value: 'files', label: '会话文件（v4 私有格式）' },
        ],
        title: '跨会话数据源',
        description: 'JOURNAL 只能看到我们自己写进去的摘要；服务与文件档要宿主开启对应组件。',
        order: 40,
    },
    {
        key: 'scope',
        kind: 'select',
        options: [
            { value: 'both', label: 'JOURNAL + FACT/MEMORY' },
            { value: 'journal', label: '只写 JOURNAL' },
        ],
        title: '写入范围',
        description: '「只写 JOURNAL」适合先观察结论质量，再放开正式记忆。',
        order: 50,
    },
    {
        key: 'minTurns',
        kind: 'text',
        group: SETTINGS_ADVANCED_GROUP,
        title: '消费门槛 · 回合数',
        description: '未消费回合达到该值就沉淀（与字符门槛先到先算）。',
        min: 1,
        numeric: true,
        integer: true,
        order: 60,
    },
    {
        key: 'minChars',
        kind: 'text',
        group: SETTINGS_ADVANCED_GROUP,
        title: '消费门槛 · 字符数',
        description: '未消费字符达到该值就沉淀。',
        min: 100,
        numeric: true,
        integer: true,
        order: 70,
    },
    {
        key: 'perTurnCap',
        kind: 'text',
        group: SETTINGS_ADVANCED_GROUP,
        title: '单回合截断',
        description: '每回合结论最多取多少字符（防一轮几千字撑爆预算）。',
        min: 100,
        numeric: true,
        integer: true,
        order: 80,
    },
    {
        key: 'maxSampleChars',
        kind: 'text',
        group: SETTINGS_ADVANCED_GROUP,
        title: '单次输入上限',
        description: '一次沉淀最多喂多少字符给模型。',
        min: 500,
        numeric: true,
        integer: true,
        order: 90,
    },
    {
        key: 'dailyLlmBudget',
        kind: 'text',
        group: SETTINGS_ADVANCED_GROUP,
        title: '每日调用上限',
        description: '第一层与第二层共用；超了停到次日。',
        min: 1,
        numeric: true,
        integer: true,
        order: 100,
    },
    {
        key: 'subagent',
        kind: 'toggle',
        group: SETTINGS_ADVANCED_GROUP,
        title: '子代理也沉淀',
        description: '默认关闭：子代理的对话是父任务的过程，写进记忆只会污染。',
        order: 110,
    },
    {
        key: 'redact',
        kind: 'toggle',
        group: SETTINGS_ADVANCED_GROUP,
        title: '敏感串打码',
        description: '写入前按正则扫描密钥/手机号/身份证/卡号；关掉不建议（主插件闸口仍会兜底）。',
        order: 120,
    },
    {
        key: 'pendingMaxAgeDays',
        kind: 'text',
        group: SETTINGS_ADVANCED_GROUP,
        title: '暂存最长保留天数',
        description: '超过该天数仍未消费的回合直接丢弃并记 runlog（防死信堆积）。',
        min: 1,
        numeric: true,
        integer: true,
        order: 130,
    },
    {
        key: 'idleScanMinutes',
        kind: 'text',
        group: SETTINGS_ADVANCED_GROUP,
        title: '兜底扫描间隔（分钟）',
        description: '补漏事件、补重启后的未消费回合。',
        min: 1,
        numeric: true,
        integer: true,
        order: 140,
    },
    {
        key: 'provider',
        kind: 'text',
        group: SETTINGS_ADVANCED_GROUP,
        title: 'provider 覆盖',
        description: '留空 = 沿用会话最近一次 route。',
        order: 150,
    },
    {
        key: 'model',
        kind: 'text',
        group: SETTINGS_ADVANCED_GROUP,
        title: 'model 覆盖',
        description: '留空 = 沿用会话最近一次 route。',
        order: 160,
    },
];

const SPEC_BY_KEY = new Map(SETTINGS_SPECS.map((spec) => [spec.key, spec]));

/**
 * 这一项是不是**数字项**。
 *
 * A0 的缺陷（M1 修掉）：`text` 分支把任何非空值都当数字解析，于是设置页给
 * `provider` 填 `workbuddy-cn` 会抛「需要一个数字」，`provider` / `model` 永远写不进去。
 *
 * 判据用「声明式元数据」而不是硬编码键名：数字项一定带 `min` / `integer` / `numeric`
 * 之一；三个都读一遍是为了**漏标也不至于把数字项当字符串存**（那样 `minTurns`
 * 会变成字符串 `'6'`，`Number.isFinite` 判断的地方全都要炸）。
 */
function isNumericSpec(spec) {
    return spec.numeric === true || spec.integer === true || spec.min !== undefined || spec.max !== undefined;
}

/**
 * 把页面原始值转成合法值。不合法**抛错**（页面保留旧值并显示原因）。
 *
 * @param {string} key
 * @param {unknown} raw
 * @returns {boolean | number | string}
 */
export function coerceSetting(key, raw) {
    const spec = SPEC_BY_KEY.get(key);
    if (spec === undefined) throw new Error(`未知的设置项：${key}`);

    if (spec.kind === 'toggle') {
        if (typeof raw !== 'boolean') throw new Error(`「${spec.title}」只接受开/关`);
        return raw;
    }
    if (spec.kind === 'select') {
        const trimmed = String(raw ?? '').trim();
        // `lowercase: true` 的项（档位）容忍大小写：手改 settings.json 写成 "Observe"
        // 也不该被当成坏值丢掉（丢掉会静默回落 auto，那和「保持影子」恰好相反）。
        const value = spec.lowercase === true ? trimmed.toLowerCase() : trimmed;
        if (!spec.options.some((option) => option.value === value)) throw new Error(`「${spec.title}」不接受「${value}」`);
        return value;
    }

    // 字符串项（`provider` / `model`）：留空是合法的（= 沿用会话 route），其余原样去空白。
    if (!isNumericSpec(spec)) {
        if (raw === null || raw === undefined) return '';
        if (typeof raw === 'boolean') throw new Error(`「${spec.title}」需要一个字符串`);
        return String(raw).trim();
    }

    // 数字项：留空也合法（清空覆盖），否则必须是非负数字/整数且在 [min, max] 内。
    if (typeof raw === 'string' && raw.trim() === '') return '';
    let value;
    if (typeof raw === 'number') value = raw;
    else if (typeof raw === 'string') value = Number(raw.trim());
    else throw new Error(`「${spec.title}」需要一个数字`);
    if (!Number.isFinite(value)) throw new Error(`「${spec.title}」需要一个数字`);
    if (spec.integer === true && !Number.isInteger(value)) throw new Error(`「${spec.title}」必须是整数`);
    if (spec.min !== undefined && value < spec.min) throw new Error(`「${spec.title}」不能小于 ${spec.min}`);
    if (spec.max !== undefined && value > spec.max) throw new Error(`「${spec.title}」不能大于 ${spec.max}`);
    return value;
}

/**
 * 读覆盖层；坏文件 / 坏值都当「没设过」（一次手改不该让插件炸掉）。
 *
 * @param {string} [file]
 * @returns {Record<string, boolean | number | string>}
 */
export function readConsolidateOverrides(file = consolidateOverridesPath()) {
    let raw;
    try {
        raw = readFileSync(file, 'utf8');
    } catch {
        return {};
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const out = {};
    for (const spec of SETTINGS_SPECS) {
        if (!Object.prototype.hasOwnProperty.call(parsed, spec.key)) continue;
        try {
            out[spec.key] = coerceSetting(spec.key, parsed[spec.key]);
        } catch {
            /* 坏值跳过 */
        }
    }
    return out;
}

/**
 * 整份原子写入覆盖层。
 *
 * @param {Record<string, any>} overrides
 * @param {string} [file]
 */
export function writeConsolidateOverrides(overrides, file = consolidateOverridesPath()) {
    mkdirSync(consolidateDir(), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');
    renameWithRetry(tmp, file);
}

/**
 * 把覆盖层合并进运行时 config（原地改，监听器持有同一对象引用）。
 *
 * @param {Record<string, any>} config
 * @param {Record<string, any>} overrides
 * @returns {Record<string, any>}
 */
export function applyConsolidateOverrides(config, overrides) {
    for (const [key, value] of Object.entries(overrides ?? {})) {
        if (!SPEC_BY_KEY.has(key)) continue;
        config[key] = value;
    }
    return config;
}

/**
 * 造设置项（值从运行时 config 现取）。
 *
 * @param {{
 *   config: Record<string, any>,
 *   pendingDir: string,
 *   cursorFile: string,
 *   onChange: (key: string, value: unknown) => void | Promise<void>,
 * }} options
 * @returns {Array<Record<string, any>>}
 */
export function createSettingItems(options) {
    const { config, pendingDir, cursorFile, onChange } = options;

    const items = SETTINGS_SPECS.map((spec) => ({
        id: `consolidate.${spec.key}`,
        group: spec.group ?? SETTINGS_GROUP,
        title: spec.title,
        description: spec.description,
        kind: spec.kind,
        options: spec.options,
        order: spec.order,
        value: spec.kind === 'toggle'
            ? config[spec.key] === true
            : String(config[spec.key] ?? ''),
        onChange: (value) => onChange(spec.key, value),
    }));

    items.push({
        id: 'consolidate.pendingDir',
        group: SETTINGS_GROUP,
        title: '暂存目录',
        description: '只读：L0 暂存与游标都在这里，不进项目目录。',
        kind: 'readonly',
        order: 200,
        value: pendingDir,
    });
    items.push({
        id: 'consolidate.cursorFile',
        group: SETTINGS_GROUP,
        title: '游标文件',
        description: '只读：按「工作区:会话」记已消费回合。',
        kind: 'readonly',
        order: 210,
        value: cursorFile,
    });

    return items;
}
