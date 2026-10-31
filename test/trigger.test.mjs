/**
 * 触发真值表（02 §6.1 / §6.2 / §6.5）。
 *
 * 跑法：node test/trigger.test.mjs
 */

import assert from 'node:assert/strict';
import {
    REASON,
    decide,
    decideConsume,
    decideL0Write,
    unconsumedTurns,
} from '../lib/trigger.js';

const CONFIG = { enabled: true, subagent: false, partialKeep: false, minTurns: 6, minChars: 8000 };
const NOW = 1_800_000_000_000;

/** 真值表：每条 `[标题, 输入, 期望 writeL0/reason]`。 */
const WRITE_CASES = [
    ['正常回合写 L0', { lastTurn: 12, cursorTurn: 11, reasonKind: 'completed', delegationDepth: 0 }, true, REASON.OK],
    ['总开关关闭', { lastTurn: 12, cursorTurn: 11, reasonKind: 'completed', config: { enabled: false } }, false, REASON.DISABLED],
    ['子代理会话跳过', { lastTurn: 12, cursorTurn: 11, reasonKind: 'completed', delegationDepth: 1 }, false, REASON.SUBAGENT],
    ['子代理但 subagent=true 放行', { lastTurn: 12, cursorTurn: 11, reasonKind: 'completed', delegationDepth: 1, config: { subagent: true } }, true, REASON.OK],
    ['父会话（delegationDepth=0）不跳', { lastTurn: 3, cursorTurn: 2, reasonKind: 'completed', delegationDepth: 0 }, true, REASON.OK],
    ['用户中断回合丢弃（aborted）', { lastTurn: 5, cursorTurn: 4, reasonKind: 'aborted' }, false, REASON.INTERRUPTED],
    ['报错回合丢弃（error）', { lastTurn: 5, cursorTurn: 4, reasonKind: 'error' }, false, REASON.INTERRUPTED],
    ['超长截断回合丢弃（max-tokens）', { lastTurn: 5, cursorTurn: 4, reasonKind: 'max-tokens' }, false, REASON.INTERRUPTED],
    ['没有 turn/end（reason 缺失）', { lastTurn: 5, cursorTurn: 4 }, false, REASON.NO_TURN_END],
    ['reason 为空串', { lastTurn: 5, cursorTurn: 4, reasonKind: '' }, false, REASON.NO_TURN_END],
    ['宿主没给 lastTurn', { cursorTurn: 4, reasonKind: 'completed' }, false, REASON.NO_TURN_SIGNAL],
    ['游标已追上（无新回合）', { lastTurn: 7, cursorTurn: 7, reasonKind: 'completed' }, false, REASON.NO_NEW_TURN],
    ['游标超前（重启回退）', { lastTurn: 6, cursorTurn: 9, reasonKind: 'completed' }, false, REASON.NO_NEW_TURN],
    ['多回合一次补上', { lastTurn: 9, cursorTurn: 6, reasonKind: 'completed' }, true, REASON.OK],
];

let checked = 0;
for (const [title, input, expectedWrite, expectedReason] of WRITE_CASES) {
    const verdict = decideL0Write({ config: CONFIG, ...input });
    assert.equal(verdict.writeL0, expectedWrite, `${title}：writeL0`);
    assert.equal(verdict.reason, expectedReason, `${title}：reason`);
    checked += 1;
}

/* 回合数计算 */
assert.equal(unconsumedTurns(12, 11), 1);
assert.equal(unconsumedTurns(12, 20), 0, '游标超前不能是负数');
assert.equal(unconsumedTurns(undefined, 3), 0);
assert.equal(unconsumedTurns(9, undefined), 9, '没有游标 = 从 0 算');
assert.equal(decideL0Write({ config: CONFIG, lastTurn: 9, cursorTurn: 6, reasonKind: 'completed' }).turns, 3);

/* partialKeep 只是「预留」，不允许中断回合写 L0 */
const partialOff = decideL0Write({ config: CONFIG, lastTurn: 5, cursorTurn: 4, reasonKind: 'aborted' });
assert.equal(partialOff.writeL0, false);
assert.equal(partialOff.partialEligible, false, 'partialKeep 关闭时不该标记 partial');
const partialOn = decideL0Write({ config: { ...CONFIG, partialKeep: true }, lastTurn: 5, cursorTurn: 4, reasonKind: 'aborted' });
assert.equal(partialOn.writeL0, false, '拍板：中断回合绝不写 L0（partialKeep 只影响未来的 partial 通道）');
assert.equal(partialOn.partialEligible, true, 'partialKeep 开启时标记为可 partial，供 M2 之后的通道用');

/* 消费真值表 */
const CONSUME_CASES = [
    ['正好 6 轮', { pendingTurns: 6, pendingChars: 100 }, true, REASON.MIN_TURNS, ['turns']],
    ['超过 6 轮', { pendingTurns: 9, pendingChars: 100 }, true, REASON.MIN_TURNS, ['turns']],
    ['5 轮但 8000 字符', { pendingTurns: 5, pendingChars: 8000 }, true, REASON.MIN_CHARS, ['chars']],
    ['两项同时达标', { pendingTurns: 6, pendingChars: 9000 }, true, REASON.MIN_TURNS, ['turns', 'chars']],
    ['两项都不够（先到先算的「且」是错的）', { pendingTurns: 5, pendingChars: 7999 }, false, REASON.BELOW_THRESHOLD, []],
    ['零待消费', { pendingTurns: 0, pendingChars: 0 }, false, REASON.BELOW_THRESHOLD, []],
    ['冷却中', { pendingTurns: 9, pendingChars: 9000, cooldownUntil: NOW + 60_000 }, false, REASON.COOLDOWN, []],
    ['冷却已过', { pendingTurns: 9, pendingChars: 9000, cooldownUntil: NOW - 1 }, true, REASON.MIN_TURNS, ['turns', 'chars']],
    ['总开关关闭', { pendingTurns: 9, pendingChars: 9000, config: { enabled: false } }, false, REASON.DISABLED, []],
    ['自定义门槛', { pendingTurns: 2, pendingChars: 500, config: { minTurns: 2, minChars: 500 } }, true, REASON.MIN_TURNS, ['turns', 'chars']],
];

for (const [title, input, expected, expectedReason, expectedWhich] of CONSUME_CASES) {
    const verdict = decideConsume({ config: CONFIG, now: NOW, ...input });
    assert.equal(verdict.consume, expected, `${title}：consume`);
    assert.equal(verdict.reason, expectedReason, `${title}：reason`);
    assert.deepEqual(verdict.which, expectedWhich, `${title}：which`);
    checked += 1;
}

/* 默认门槛（config 缺键时用 §8 的 6 / 8000） */
assert.equal(decideConsume({ pendingTurns: 6, pendingChars: 0, now: NOW }).consume, true);
assert.equal(decideConsume({ pendingTurns: 5, pendingChars: 7999, now: NOW }).consume, false);

/* 组合入口 */
const both = decide({ config: CONFIG, now: NOW, lastTurn: 8, cursorTurn: 2, reasonKind: 'completed', pendingTurns: 6, pendingChars: 0 });
assert.equal(both.write.writeL0, true);
assert.equal(both.consume.consume, true);
assert.equal(both.write.turns, 6);

console.log(`✓ trigger.test.mjs 全部通过（真值表 ${checked} 条 + 边界断言）`);
