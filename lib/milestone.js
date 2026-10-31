/**
 * 里程碑开关。
 *
 * `AUTO_TRIGGER_READY` 是**唯一**决定「事件订阅与兜底定时器要不要真干活」的开关：
 *  - `false`（M1 历史状态）：`agent/status` / `agent/disposed` / `setInterval` 都注册了，
 *    但只空转，交付的是**手动命令闭环**（`run` / `dry` / `rollback`）；
 *  - `true`（M2 现状）：真正的自动触发——`session/event` 的 `turn/end` → 写 L0 →
 *    门槛判定 → 微任务里跑 `runL1`（实现在 `lib/autotrigger.js`）。
 *
 * 留着这个开关而不是删掉：M4 回退、观察期临时停用都靠它，而且 `status` 命令要
 * 把「自动触发是否已接线」显示给用户。
 *
 * 单独一个文件是为了断开 `index.js ⇄ commands.js` 的循环 import。
 */

/** 自动触发是否已接线（M2 起恒为 true）。 */
export const AUTO_TRIGGER_READY = true;

/** 当前里程碑名（写进 runlog / 命令回显，便于对账）。 */
export const MILESTONE = 'M5';
