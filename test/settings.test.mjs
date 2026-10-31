/**
 * 设置页回写（M1 修的第二个缺陷）：`text` 控件里混着数字项与**字符串项**。
 *
 * A0 的 `coerceSetting()` 把任何非空值都当数字解析，于是设置页给 `provider` 填
 * `workbuddy-cn` 会抛「需要一个数字」，`provider` / `model` **永远写不进去**（实测缺陷）。
 * 现在按 spec 元数据区分：数字项解析成数字，字符串项去空白后原样返回。
 *
 * 单独一个文件而不是塞进 `wiring.test.mjs`：后者要 import `lib/index.js`（需要 schemastery），
 * 本机没装就整组 SKIP；这两个键的回归必须**永远跑**。
 *
 * 跑法：node test/settings.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    SETTINGS_SPECS,
    applyConsolidateOverrides,
    coerceSetting,
    consolidateOverridesPath,
    createSettingItems,
    readConsolidateOverrides,
    writeConsolidateOverrides,
} from '../lib/settings.js';
import { makeHome } from './_helpers.mjs';

/* ── 1. 字符串项：provider / model 现在写得进去 ── */
assert.equal(coerceSetting('provider', 'workbuddy-cn'), 'workbuddy-cn');
assert.equal(coerceSetting('model', 'deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
assert.equal(coerceSetting('provider', '  workbuddy-cn  '), 'workbuddy-cn', '去首尾空白');
assert.equal(coerceSetting('model', 'qianfan/deepseek-v4.1-flash-1017'), 'qianfan/deepseek-v4.1-flash-1017');
assert.equal(coerceSetting('provider', ''), '', '空 = 沿用会话 route，必须合法');
assert.equal(coerceSetting('provider', '   '), '');
assert.equal(coerceSetting('provider', 42), '42', '数字也能当字符串收下');
assert.throws(() => coerceSetting('provider', true), /需要一个字符串/);

/* ── 2. 数字项：仍然是数字，且不合法时仍然抛 ── */
// 每个数字项各自的最小值不同（minChars ≥100、maxSampleChars ≥500），所以逐项给合法值。
const NUMERIC_INPUTS = {
    minTurns: '12',
    minChars: '9000',
    perTurnCap: '1500',
    maxSampleChars: '9000',
    dailyLlmBudget: '12',
    pendingMaxAgeDays: '12',
    idleScanMinutes: '12',
};
for (const [key, raw] of Object.entries(NUMERIC_INPUTS)) {
    const value = coerceSetting(key, raw);
    assert.equal(typeof value, 'number', `${key} 必须解析成数字`);
    assert.equal(value, Number(raw));
}
assert.equal(coerceSetting('minTurns', 8), 8);
assert.throws(() => coerceSetting('minTurns', '1.5'), /整数/);
assert.throws(() => coerceSetting('minTurns', '0'), /不能小于/);
assert.throws(() => coerceSetting('minChars', '10'), /不能小于/);
assert.throws(() => coerceSetting('minTurns', 'abc'), /需要一个数字/);
assert.throws(() => coerceSetting('minTurns', true), /需要一个数字/);

/* ── 3. 开关 / 选择项行为不变 ── */
assert.equal(coerceSetting('enabled', false), false);
assert.throws(() => coerceSetting('enabled', 'yes'), /只接受开\/关/);
assert.equal(coerceSetting('crossSource', 'journal'), 'journal');
assert.throws(() => coerceSetting('crossSource', 'nope'), /不接受/);
assert.throws(() => coerceSetting('没有这个键', 1), /未知的设置项/);

/* ── 4. spec 元数据自洽：数字项带 numeric，字符串项不带 ── */
for (const spec of SETTINGS_SPECS) {
    if (spec.kind !== 'text') continue;
    const isStringItem = spec.key === 'provider' || spec.key === 'model';
    const sample = isStringItem ? 'workbuddy-cn' : NUMERIC_INPUTS[spec.key];
    assert.equal(typeof coerceSetting(spec.key, sample), isStringItem ? 'string' : 'number', `${spec.key} 的类型判错了`);
    if (!isStringItem) assert.equal(spec.numeric, true, `${spec.key} 应显式标注 numeric: true`);
}

/* ── 5. 覆盖层：provider / model 能落盘且能读回；坏值当没设过 ── */
const { home, cleanup } = makeHome('pmc-settings');
try {
    const file = consolidateOverridesPath();
    assert.equal(file, join(home, 'memory', 'consolidate', 'settings.json'));

    writeConsolidateOverrides({
        provider: 'workbuddy-cn',
        model: 'deepseek-v4.1-flash',
        minTurns: 10,
        enabled: false,
        // 坏值：读回时应该被丢掉，而不是让整个文件失效
        minChars: '不是数字',
    }, file);

    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(onDisk.provider, 'workbuddy-cn', 'provider 必须原样落盘');
    assert.equal(onDisk.model, 'deepseek-v4.1-flash');

    const overrides = readConsolidateOverrides(file);
    assert.equal(overrides.provider, 'workbuddy-cn');
    assert.equal(overrides.model, 'deepseek-v4.1-flash');
    assert.equal(overrides.minTurns, 10);
    assert.equal(overrides.enabled, false);
    assert.equal(Object.prototype.hasOwnProperty.call(overrides, 'minChars'), false, '坏值跳过，不当成 0 或 NaN');

    /* 合并进 config：只覆盖设置页管的键 */
    const config = { provider: '', model: '', minTurns: 6, 不认识的键: 1 };
    applyConsolidateOverrides(config, overrides);
    assert.equal(config.provider, 'workbuddy-cn');
    assert.equal(config.model, 'deepseek-v4.1-flash');
    assert.equal(config.minTurns, 10);
    assert.equal(config.不认识的键, 1, '不认识的键不该被动');

    /* 坏文件 / 不存在文件 ⇒ 空覆盖层，不抛 */
    writeFileSync(file, '{坏掉的 json', 'utf8');
    assert.deepEqual(readConsolidateOverrides(file), {});
    assert.deepEqual(readConsolidateOverrides(join(home, '没有这个文件.json')), {});

    /* 设置项渲染：provider 项的值是字符串 */
    const items = createSettingItems({ config, pendingDir: join(home, 'pending'), cursorFile: join(home, 'cursor.json'), onChange() {} });
    const providerItem = items.find((item) => item.id === 'consolidate.provider');
    assert.equal(providerItem.kind, 'text');
    assert.equal(providerItem.value, 'workbuddy-cn');
    assert.equal(items.find((item) => item.id === 'consolidate.model').value, 'deepseek-v4.1-flash');
    assert.equal(items.find((item) => item.id === 'consolidate.minTurns').value, '10');
    assert.ok(items.every((item) => ['toggle', 'select', 'text', 'readonly'].includes(item.kind)));
} finally {
    cleanup();
}

console.log('✓ settings.test.mjs 全部通过');
