/**
 * 运行档位：`off` / `observe` / `auto`（设置页「运行档位」）。
 *
 * 为什么单开一个模块而不是塞进 `settings.js`：`trigger.js` 是纯函数模块（不 import
 * 任何带 fs 的东西，测试直接拿它写真值表），而档位判定要被 writer / pipeline /
 * trigger / autotrigger 同时用到。放这里 ⇒ 谁都能 import，且它自己零依赖。
 *
 * **优先级（唯一口径，别在别处再写一套）**：
 *  1. `mode` 是**显式档位**：`off` ⇒ 完全静默（连 L0 都不写、命令也不许正式写入）；
 *     `observe` ⇒ 真跑管线但只落 would-write 影子文件，不碰 FACT / MEMORY / JOURNAL；
 *  2. `mode` 为 `auto`（默认）或没设置/非法 ⇒ **跟随 `enabled` 开关**：`enabled=false`
 *     等价 `off`，其余是 `auto`。这是改造前唯一有的语义，必须逐字保持不变。
 *
 * 也就是说：显式档位压过 `enabled`。有人把 `enabled` 关了又选 `observe`，得到的是
 * 影子运行而不是静默——这是故意的：`observe` 本身就不写正式记忆，要停就选 `off`。
 *
 * **observe = auto 的触发与记账 + 换掉「写入」这一步**（拍板口径，别再改回去）：
 *  - 触发条件完全一样：`decideConsume` 门槛、兜底扫描、跨会话日跑都照跑，LLM 花销 ≈ auto；
 *  - 判定 op / 打码 / 校验 / `assertEntry` 闸口预演照旧，只是 writer 把「写入」替换成
 *    would-write 落盘（FACT / MEMORY / JOURNAL 一个字节都不写）；
 *  - **内部记账也与 auto 一致**：暂存行 `markConsumed` + 归档、L1 游标推进、L2 跨会话游标推进。
 *    否则同一批素材会被反复采样、反复烧 LLM，切到 auto 时还会把观察期的陈旧结论一次性灌进
 *    FACT（backlog 炸弹）。
 *  - **已知取舍**：观察期被消费的素材，切到 auto 后**不会补写**。要补就先 `/memory-consolidate dry`
 *    看一遍再决定（README「影子模式」一节也写了这条）。
 *  - 唯一不做的副作用是「记忆文件写前快照」：没写就没得回滚，建了只会堆垃圾。
 */

/** 档位取值（字符串稳定：会写进 settings.json 与 runlog）。 */
export const MODE = {
    OFF: 'off',
    OBSERVE: 'observe',
    AUTO: 'auto',
};

/** 白名单（设置项 select 的取值顺序 = 页面展示顺序）。 */
export const MODES = [MODE.OFF, MODE.OBSERVE, MODE.AUTO];

/**
 * 把一个原始值收成合法档位。
 *
 * @param {unknown} raw
 * @returns {string | null} 合法就返回白名单里的值，否则 null（调用方自己决定回落）
 */
export function normalizeMode(raw) {
    const value = String(raw ?? '').trim().toLowerCase();
    return MODES.includes(value) ? value : null;
}

/**
 * 生效档位（`off` / `observe` / `auto`）。
 *
 * @param {{ mode?: unknown, enabled?: unknown }} [config]
 * @returns {string}
 */
export function resolveMode(config = {}) {
    const explicit = normalizeMode(config?.mode);
    // 显式档位压过 enabled：见文件头的优先级说明。
    if (explicit === MODE.OFF || explicit === MODE.OBSERVE) return explicit;
    // auto / 没设置 / 非法值：回落到改造前唯一的开关语义。
    return config?.enabled === false ? MODE.OFF : MODE.AUTO;
}

/** 该不该干活（`off` 档等价于 `enabled=false`）。 */
export function isConsolidationEnabled(config = {}) {
    return resolveMode(config) !== MODE.OFF;
}
