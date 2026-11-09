/**
 * 确定性写入闸口（`lib/gate.js`）：零 LLM、纯函数、同输入同输出。
 *
 * 钉住的六类拦截与三条纪律（A-npm-leaders 第 6、7 条）：
 *  1. 空壳 / 占位变体（「暂无」「见上」「同上」「无」…）；
 *  2. 过程叙述开头（「我先」「接下来我」「然后我」「排查了」…）；
 *  3. 长度 < 8 字符；
 *  4. 同批精确重复（归一化后相同，保序留第一条）；
 *  5. 状态断言缺时点（「目前进度是…」但无日期 / 版本锚点）；
 *  6. **绝不静默丢**：每条被丢的都有 reason，计数按原因分类。
 *
 * 跑法：node test/gate.test.mjs
 */

import assert from 'node:assert/strict';
import {
    GATE_REASON,
    GATE_REASONS,
    MIN_POINT_CHARS,
    emptyGateCounts,
    gateBatch,
    gatePoint,
    normalizePoint,
} from '../lib/gate.js';

/* ── 1. 空壳 / 占位变体 ── */
for (const text of ['暂无', '暂无。', '- 无', '同上', '见上', 'N/A', 'nothing', '`nil`', '…', '—']) {
    const verdict = gatePoint(text);
    assert.equal(verdict.ok, false, `空壳必须在闸口被拦：${text}`);
    assert.ok(
        [GATE_REASON.EMPTY, GATE_REASON.PLACEHOLDER].includes(verdict.reason),
        `空壳的原因应是 empty/placeholder：${text} → ${verdict.reason}`,
    );
}

/* ── 2. 过程叙述开头（只落结论，不落过程） ── */
for (const text of ['我先看了一下配置，然后改了 lib', '接下来我把 writer 的判定改成字符串也认', '然后我把配置改好了', '排查了一圈发现是 store 没装上']) {
    assert.equal(gatePoint(text).reason, GATE_REASON.PROCESS, `过程叙述必须在闸口被拦：${text}`);
}
// 结论句（第三人称陈述）不许误杀
for (const text of ['依赖用 tarball 装，不要用 pnpm install', '改完 lib 下的文件必须重启 DSH 引擎', '结论：设置页的 provider 覆盖只在下一轮生效']) {
    assert.equal(gatePoint(text).ok, true, `结论不该被误杀：${text}`);
}

/* ── 3. 长度 < 8 ── */
assert.equal(MIN_POINT_CHARS, 8);
assert.equal(gatePoint('改好了').reason, GATE_REASON.TOO_SHORT);
assert.equal(gatePoint('依赖用 tarball 装').ok, true, '8 字符以上放行');

/* ── 4. 同批精确重复：留第一条，后面的记 duplicate ── */
const duplicated = gateBatch([
    { content: '依赖用 tarball 装，不要用 pnpm install', scope: 'global' },
    { content: '依赖用 tarball 装，不要用 pnpm install。', scope: 'global' },
    { content: '改完 lib 下的文件必须重启 DSH 引擎', scope: 'global' },
]);
assert.equal(duplicated.kept.length, 2, '重复项只留一条');
assert.equal(duplicated.dropped.length, 1);
assert.equal(duplicated.dropped[0].reason, GATE_REASON.DUPLICATE);
assert.equal(duplicated.dropped[0].index, 1, '留的是先出现的那条');
assert.equal(duplicated.counts.duplicate, 1);
assert.equal(duplicated.counts.kept, 2);
assert.equal(duplicated.counts.dropped, 1);
assert.equal(duplicated.counts.total, 3);

/* ── 5. 状态断言必须带时点 / 版本锚点 ── */
assert.equal(gatePoint('目前进度是快改完了，马上就能用').reason, GATE_REASON.UNTIMED_STATE);
assert.equal(gatePoint('现在是 0.2.0 版本').ok, true, '带版本号的状态断言放行（版本锚点）');
assert.equal(gatePoint('截至 2026-11-09，目前进度是闸口已经接进管线').ok, true, '带日期锚点放行');
assert.equal(gatePoint('上周现在是旧版本，已经升级到 0.2.0').ok, true, '带相对日 + 版本放行');

/* ── 6. 绝不静默丢：原因分类计数 + 空计数形状 ── */
const mixed = gateBatch([
    '暂无',
    '我先把 store 接上',
    '太短',
    '依赖用 tarball 装，不要用 pnpm install',
    '依赖用 tarball 装，不要用 pnpm install',
    '目前进度是快改完了',
]);
assert.deepEqual(mixed.counts, {
    total: 6,
    kept: 1,
    dropped: 5,
    [GATE_REASON.EMPTY]: 0,
    [GATE_REASON.PLACEHOLDER]: 1,
    [GATE_REASON.PROCESS]: 1,
    [GATE_REASON.TOO_SHORT]: 1,
    [GATE_REASON.UNTIMED_STATE]: 1,
    [GATE_REASON.DUPLICATE]: 1,
    [GATE_REASON.NEAR_DUPLICATE]: 0,
    [GATE_REASON.META_ASSISTANT]: 0,
});
assert.equal(mixed.counts.kept + mixed.counts.dropped, mixed.counts.total, '账必须对得上');
assert.deepEqual(
    Object.keys(emptyGateCounts()).sort(),
    ['dropped', 'duplicate', 'empty', 'kept', 'meta-assistant', 'near-duplicate', 'placeholder', 'process', 'too-short', 'total', 'untimed-state'].sort(),
    '空计数形状固定（runlog 白名单按它落盘）',
);
/* 新原因只能追加在末尾：runlog 按键顺序落盘，插中间会让新旧日志 diff 全是噪音。 */
assert.deepEqual(GATE_REASONS, [
    'empty', 'placeholder', 'process', 'too-short', 'untimed-state', 'duplicate', 'near-duplicate',
    'meta-assistant',
]);
assert.equal(GATE_REASON.NEAR_DUPLICATE, 'near-duplicate', '跨池近重复的原因字符串稳定（runlog 用它做键）');
assert.deepEqual(gateBatch([]), { kept: [], dropped: [], counts: emptyGateCounts(), total: 0 });
assert.deepEqual(gateBatch(undefined).total, 0, '坏输入不许抛');

/* ── 7. 纯函数：同输入同输出 + 归一化只用于判等 ── */
assert.equal(JSON.stringify(gateBatch(['暂无', '依赖用 tarball 装，不要用 pnpm install'])), JSON.stringify(gateBatch(['暂无', '依赖用 tarball 装，不要用 pnpm install'])));
assert.equal(normalizePoint('  - **依赖用 tarball 装**。 '), '依赖用 tarball 装');
assert.equal(normalizePoint('暂无。'), '暂无');
assert.equal(gatePoint({ content: '依赖用 tarball 装，不要用 pnpm install' }).ok, true, '接受 {content} 形状');

/* ── 9. 一键关闭（config.gateEnabled=false）：整批放行，且不填分类计数 ── */
const bypassed = gateBatch(['太短', '暂无', '我先看一下配置'], { enabled: false });
assert.equal(bypassed.disabled, true, '关闭时要明确标 disabled（调用方据此不写 runlog.gate）');
assert.equal(bypassed.kept.length, 3, '关闭后连「太短」都放行');
assert.deepEqual(bypassed.dropped, []);
assert.equal(bypassed.counts.total, 3);
assert.equal(bypassed.counts.kept, 3);
assert.equal(bypassed.counts.dropped, 0);
assert.equal(bypassed.counts[GATE_REASON.TOO_SHORT], 0, '关闭时不许再填分类计数（「没启用」≠「启用了没拦」）');
assert.equal(bypassed.counts[GATE_REASON.PLACEHOLDER], 0);

const originalBypass = { content: '太短' };
assert.equal(gateBatch([originalBypass], { enabled: false }).kept[0], originalBypass, '关闭时原样放行（不改写、不重建）');
assert.equal(gateBatch([originalBypass], { enabled: true }).kept.length, 0, '显式 enabled:true 仍然过滤');
assert.equal(gateBatch([originalBypass]).kept.length, 0, '不传 enabled 时默认过滤（行为与改造前一致）');
assert.equal(gateBatch([], { enabled: false }).total, 0);

/* ── 8. 保留原始对象（不改写正文） ── */
const original = { content: '依赖用 tarball 装，不要用 pnpm install', scope: 'project', confidence: 'high' };
const kept = gateBatch([original]).kept[0];
assert.equal(kept, original, '必须原样返回，闸口不重建对象');
assert.equal(kept.confidence, 'high');

/* ── 10. 助手自身的「能不能做」声明：拦（本机 FACT.md 里真实出现过的两条） ── */
assert.equal(gatePoint('该助手不代用户登录游戏账号。').reason, GATE_REASON.META_ASSISTANT);
assert.equal(gatePoint('该助手可帮用户查询无需实时交互的奇遇清单及各自挂机时长。').reason, GATE_REASON.META_ASSISTANT);
assert.equal(gatePoint('助手只支持读写当前工作区内的文件。').reason, GATE_REASON.META_ASSISTANT);
assert.equal(gatePoint('本助手不会主动联网。').reason, GATE_REASON.META_ASSISTANT);
assert.equal(gatePoint('- 此助手无法访问手机相册。').reason, GATE_REASON.META_ASSISTANT);

/* 但「该助手运行在 X 环境」这类环境事实必须放行：按「该助手」开头一律拦会误杀真结论 */
assert.equal(gatePoint('该助手运行在 Android 手机的 Ubuntu 24.04 环境里，没有可用的沙箱后端。').ok, true);
assert.equal(gatePoint('该助手使用 proot 运行，默认工作目录是 /root/workspace。').ok, true);
assert.equal(gatePoint('该助手的记忆文件存在 /root/.dsh/memory 下。').ok, true);
/* 不带「助手」主语、也没有能力动词的普通结论不受影响 */
assert.equal(gatePoint('用户偏好先给结论再解释。').ok, true);

/* 批量里也只丢这一类，其他照旧保留，账对得上 */
const metaBatch = gateBatch([
    '该助手不代用户登录游戏账号。',
    '依赖用 tarball 装，不要用 pnpm install',
]);
assert.equal(metaBatch.counts[GATE_REASON.META_ASSISTANT], 1);
assert.equal(metaBatch.kept.length, 1);
assert.equal(metaBatch.kept[0], '依赖用 tarball 装，不要用 pnpm install');
assert.equal(metaBatch.counts.kept + metaBatch.counts.dropped, metaBatch.counts.total);

console.log('✓ gate.test.mjs 全部通过');
