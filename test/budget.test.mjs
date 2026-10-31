/**
 * 预算：单飞锁、全局并发 1、每日配额与日期滚动、连续失败退避 5/10/20 分钟、超时。
 *
 * 跑法：node test/budget.test.mjs
 */

import assert from 'node:assert/strict';
import {
    BACKOFF_MINUTES,
    BUDGET_REASON,
    PHASE_LAYER1,
    PHASE_LAYER2,
    backoffMinutes,
    createBudget,
    dayKey,
    withTimeout,
} from '../lib/budget.js';

/* 退避曲线：连续失败 2 次起 5/10/20 分钟 */
assert.equal(backoffMinutes(0), 0);
assert.equal(backoffMinutes(1), 0, '单次失败不冷却（一次抖动不该停 5 分钟）');
assert.equal(backoffMinutes(2), 5);
assert.equal(backoffMinutes(3), 10);
assert.equal(backoffMinutes(4), 20);
assert.equal(backoffMinutes(9), 20, '继续失败用最后一个值封顶');
assert.deepEqual(BACKOFF_MINUTES, [5, 10, 20]);

/* 本地日期键 */
assert.match(dayKey(new Date(2026, 9, 31, 12).getTime()), /^2026-10-31$/);

/* 单飞锁 + 全局并发 1 */
const NOW = new Date(2026, 9, 31, 9, 0, 0).getTime();
const budget = createBudget({ first: undefined, dailyLlmBudget: 3, layer1Limit: 2, layer2Limit: 1, now: NOW });
const first = budget.tryStart({ sessionKey: 'ws:a', phase: PHASE_LAYER1, now: NOW });
assert.equal(first.ok, true);
assert.equal(first.reason, BUDGET_REASON.OK);

const secondSession = budget.tryStart({ sessionKey: 'ws:b', phase: PHASE_LAYER1, now: NOW });
assert.equal(secondSession.ok, false);
assert.equal(secondSession.reason, BUDGET_REASON.CONCURRENCY_LIMIT, '全局并发 1：别的会话也不能同时开跑');

budget.settle(first.token, { ok: true, now: NOW });
assert.equal(budget.busyCount, 0);

const sameSession = budget.tryStart({ sessionKey: 'ws:a', phase: PHASE_LAYER1, now: NOW });
assert.equal(sameSession.ok, true);
const again = budget.tryStart({ sessionKey: 'ws:a', phase: PHASE_LAYER1, now: NOW });
assert.equal(again.ok, false);
assert.equal(again.reason, BUDGET_REASON.SESSION_BUSY, '同会话互斥');
budget.settle(sameSession.token, { ok: true, now: NOW });

/* 阶段配额：第一层 2 次 */
const layer1a = budget.tryStart({ sessionKey: 's1', phase: PHASE_LAYER1, now: NOW });
budget.settle(layer1a.token, { ok: true, now: NOW });
const layer1b = budget.tryStart({ sessionKey: 's2', phase: PHASE_LAYER1, now: NOW });
budget.settle(layer1b.token, { ok: true, now: NOW });
const layer1c = budget.tryStart({ sessionKey: 's3', phase: PHASE_LAYER1, now: NOW });
assert.equal(layer1c.ok, false);
assert.equal(layer1c.reason, BUDGET_REASON.PHASE_BUDGET, '第一层配额用完');

/* 第二层有自己的配额 */
const layer2 = budget.tryStart({ sessionKey: 's4', phase: PHASE_LAYER2, now: NOW });
assert.equal(layer2.ok, true);
budget.settle(layer2.token, { ok: true, now: NOW });

/* 每日总量 */
assert.equal(budget.snapshot(NOW).used.total, 3);
const daily = budget.tryStart({ sessionKey: 's5', phase: PHASE_LAYER1, now: NOW });
assert.equal(daily.ok, false);
assert.equal(daily.reason, BUDGET_REASON.DAILY_BUDGET);

/* 日期滚动：第二天归零 */
const tomorrow = new Date(2026, 10, 1, 9, 0, 0).getTime();
const nextDay = budget.tryStart({ sessionKey: 's6', phase: PHASE_LAYER1, now: tomorrow });
assert.equal(nextDay.ok, true, '跨日应归零');
assert.equal(budget.snapshot(tomorrow).used.total, 1);
budget.settle(nextDay.token, { ok: true, now: tomorrow });

/* 连续失败 → 退避；冷却期一律拒绝 */
const failing = createBudget({ dailyLlmBudget: 10, now: NOW });
const tryFail = (at) => {
    const started = failing.tryStart({ sessionKey: `f:${at}`, phase: PHASE_LAYER1, now: at });
    assert.equal(started.ok, true);
    return failing.settle(started.token, { ok: false, now: at });
};
const afterFirst = tryFail(NOW);
assert.equal(afterFirst.failures, 1);
assert.equal(afterFirst.cooldownUntil, 0, '第一次失败不冷却');

const afterSecond = tryFail(NOW + 1_000);
assert.equal(afterSecond.failures, 2);
assert.equal(afterSecond.cooldownUntil, NOW + 1_000 + 5 * 60_000, '第二次失败退避 5 分钟');
assert.equal(failing.cooldownUntil(), NOW + 1_000 + 5 * 60_000);
assert.equal(failing.canStart({ now: NOW + 2_000 }).reason, BUDGET_REASON.COOLDOWN);
assert.equal(failing.canStart({ now: NOW + 1_000 + 5 * 60_000 + 1 }).ok, true, '冷却结束后恢复');

const afterThird = tryFail(NOW + 400_000);
assert.equal(afterThird.cooldownUntil, NOW + 400_000 + 10 * 60_000, '第三次退避 10 分钟');
const afterFourth = tryFail(NOW + 1_200_000);
assert.equal(afterFourth.cooldownUntil, NOW + 1_200_000 + 20 * 60_000, '第四次退避 20 分钟');

/* 成功即清零连续失败 */
const recover = createBudget({ now: NOW });
const t1 = recover.tryStart({ sessionKey: 'r', now: NOW });
recover.settle(t1.token, { ok: false, now: NOW });
const t2 = recover.tryStart({ sessionKey: 'r', now: NOW + 1 });
recover.settle(t2.token, { ok: true, now: NOW + 1 });
assert.equal(recover.cooldownUntil(), 0, '成功一次就清掉冷却');
assert.equal(recover.snapshot(NOW).failures, 0);

/* 超时：超时 / 正常 / 抛错 三种都不炸 */
const slow = await withTimeout(() => new Promise((resolve) => setTimeout(() => resolve('done'), 200)), 10);
assert.equal(slow.ok, false);
assert.equal(slow.reason, 'timeout');

const fast = await withTimeout(async () => 'value', 1_000);
assert.equal(fast.ok, true);
assert.equal(fast.value, 'value');

const boom = await withTimeout(async () => {
    throw new Error('上游炸了');
}, 1_000);
assert.equal(boom.ok, false);
assert.equal(boom.reason, 'error');

const noTimeout = await withTimeout(async () => 42, 0);
assert.equal(noTimeout.ok, true);
assert.equal(noTimeout.value, 42);

console.log('✓ budget.test.mjs 全部通过');
