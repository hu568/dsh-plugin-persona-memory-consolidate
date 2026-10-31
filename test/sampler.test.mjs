/**
 * 取样（02 §7.1）：回合窗口配对、旁白过滤、纯图片占位、注入消息忽略、截断与预算。
 *
 * 跑法：node test/sampler.test.mjs
 */

import assert from 'node:assert/strict';
import { IMAGE_PLACEHOLDER, countTurns, sampleTurn, sampleTurns, turnWindows } from '../lib/sampler.js';
import { makeTurn } from './_helpers.mjs';

const counter = { seq: 0 };
const LONG = '结论：依赖用 tarball 装，改完 lib 要重启 DSH。'.repeat(4); // > 80 字符
const SHORT = '先跑一下测试：';

const events = [
    /* 回合 1：正常；助手先给一条短旁白，再给一条长结论 */
    ...makeTurn({ turn: 1, user: '第一轮的提问', assistant: [SHORT, LONG] }, counter),
    /* 回合 2：纯图片回合 */
    ...makeTurn({ turn: 2, images: true, assistant: [LONG] }, counter),
    /* 回合 3：用户被中断（取样不管 reason，丢弃由 trigger 负责） */
    ...makeTurn({ turn: 3, user: '第三轮提问', reason: 'aborted', assistant: [LONG] }, counter),
    /* 回合 4：注入类 user/message 在前，真实输入在后；结论取「最后一条 ≥80 字符」 */
    ...makeTurn({
        turn: 4,
        injected: ['这是 recall 注入的上下文', '这是时间上下文'],
        user: '第四轮真实提问',
        assistant: ['第一段很长的结论，'.repeat(10), '收尾的短旁白'],
    }, counter),
    /* 回合 5：未闭合（还没 turn/end） */
    ...makeTurn({ turn: 5, user: '还没结束', open: true, assistant: [LONG] }, counter),
    /* 回合 6：只有注入消息、没有真实用户输入、也没有图片 */
    ...makeTurn({ turn: 6, injected: ['只有注入内容'], assistant: [LONG] }, counter),
];

/* 回合窗口 */
const windows = turnWindows(events);
assert.equal(windows.length, 6, '六个 turn/start');
assert.equal(windows[4].end, -1, '第五个回合未闭合');
assert.equal(windows[0].reasonKind, 'completed');
assert.equal(windows[2].reasonKind, 'aborted');

/* 回合 1：用户问题 + 最后一条 ≥80 字符的 text（跳过「先跑一下测试：」） */
const first = sampleTurn(events, 1);
assert.equal(first.found, true);
assert.equal(first.user, '第一轮的提问');
assert.equal(first.assistant, LONG, '应取最后一条 ≥80 字符的 text，而不是最后的短旁白');
assert.equal(first.chars, first.user.length + first.assistant.length);
assert.equal(first.reason, 'ok');
assert.ok(first.seqFrom > 0 && first.seqTo >= first.seqFrom, 'seq 区间应有序');
assert.equal(first.reasonKind, 'completed');

/* 系统提示词 / reasoning / tool-call 一律不取样 */
assert.ok(!JSON.stringify(first).includes('系统提示词不该被取样'), 'system/message 不该进沉淀');
assert.ok(!JSON.stringify(first).includes('思维链不该被取样'), 'reasoning 块不该进沉淀');
assert.ok(!JSON.stringify(first).includes('tool-call'), 'tool-call 不该进沉淀');

/* 回合 2：纯图片 → [图片] 占位，不丢这一轮 */
const second = sampleTurn(events, 2);
assert.equal(second.user, IMAGE_PLACEHOLDER);
assert.equal(second.userSynthetic, true);
assert.equal(second.found, true, '纯图片回合也要保留');

/* 回合 3：取样本身不管中断（触发层负责丢），但窗口 reason 要如实带出 */
const third = sampleTurn(events, 3);
assert.equal(third.reasonKind, 'aborted');
assert.equal(third.user, '第三轮提问');

/* 回合 4：忽略注入类消息；结论取「最后一条 ≥80 字符」而不是最后一条 */
const fourth = sampleTurn(events, 4);
assert.equal(fourth.user, '第四轮真实提问', '应跳过 recall/时间注入的 user/message');
assert.equal(fourth.assistant, '第一段很长的结论，'.repeat(10).trim());
assert.ok(!fourth.assistant.includes('收尾的短旁白'));

/* 回合 5：未闭合不取 */
const fifth = sampleTurn(events, 5);
assert.equal(fifth.found, false);
assert.equal(fifth.reason, 'open-window');

/* 回合 6：本窗口没有真实输入 → 按规则 2 向前找一条不跨 turn/end 的真人消息
   （回合 5 还没 turn/end，所以它的提问是合法来源；这是 §7.1 规则 2 的定义行为） */
const sixth = sampleTurn(events, 6);
assert.equal(sixth.user, '还没结束', '规则 2：向前找一条不跨 turn/end 的真人输入');
assert.equal(sixth.found, true);
assert.equal(sixth.userSynthetic, false);

/* 连向前也找不到真人输入（会话第一轮就是注入消息）→ 用户段为空，不编造 */
const headless = [...makeTurn({ turn: 1, injected: ['只有注入内容'], assistant: [LONG] }, { seq: 0 })];
assert.equal(sampleTurn(headless, 1).user, '');
assert.equal(sampleTurn(headless, 1).userSynthetic, false, '没有图片就不该塞 [图片]');

/* 不存在的回合 */
const missing = sampleTurn(events, 99);
assert.equal(missing.found, false);
assert.equal(missing.reason, 'no-window');

/* 截断：perTurnCap */
const capped = sampleTurn(events, 1, { perTurnCap: 20 });
assert.equal(capped.truncated, true);
assert.equal(capped.assistant.length, 20);
assert.equal(capped.user, '第一轮的提问', '短的用户消息不受截断影响');

/* 旁白过滤下限可调：把下限拉到 10，短旁白就成了「合格结论」 */
const lowerBar = sampleTurn(events, 1, { minTextChars: 10 });
assert.equal(lowerBar.assistant, LONG, '最后一条合格 text 仍是长结论');
const onlyShort = sampleTurn(events, 1, { minTextChars: 500 });
assert.equal(onlyShort.assistant, LONG, '没有 ≥500 字符的 text 时退回最后一条 text');

/* 数回合（turnBoundary 读不到时的兜底） */
const turns = countTurns(events);
assert.equal(turns.total, 5, '五个 turn/end（回合 5 未闭合）');
assert.equal(turns.completed, 4, '其中四个 completed（回合 3 是 aborted）');
assert.equal(turns.lastTurn, 6, '最后一个闭合的回合是 6');

/* 批量取样：只取完成的回合、按 maxTurnsPerCall 截取尾部 */
const batch = sampleTurns(events, { maxTurnsPerCall: 2 });
assert.deepEqual(batch.turns, [4, 6], '尾部两个已完成回合（3 是 aborted，5 未闭合）');
assert.ok(batch.chars > 0);

/* 批量预算：预算只够一条时保住最新的那条 */
const tight = sampleTurns(events, { maxTurnsPerCall: 4, maxSampleChars: 300 });
assert.ok(tight.samples.length >= 1);
assert.equal(tight.turns[tight.turns.length - 1], 6, '预算紧张时先丢最早的');
assert.ok(tight.chars <= 300 || tight.samples.length === 1);

/* 显式回合列表 */
const explicit = sampleTurns(events, { turns: [1] });
assert.deepEqual(explicit.turns, [1]);

console.log('✓ sampler.test.mjs 全部通过');
