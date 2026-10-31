/**
 * 脱敏与校验映射（02 §4.3 + §7.4）。
 *
 * 跑法：node test/redact.test.mjs
 */

import assert from 'node:assert/strict';
import {
    DECISION,
    REDACTED,
    SECRET_PATTERNS,
    checkBucketScope,
    createValidator,
    redact,
    toStoreScope,
} from '../lib/validate.js';
import { budgetError, fakeStore } from './_helpers.mjs';

/* 占位符只有一个：⟨redacted⟩（00 §9 审计：两套已收敛） */
assert.equal(REDACTED, '⟨redacted⟩');

/* OpenAI 风格 key */
const openai = redact('配置里写了 sk-abcdefghijklmnopqrstuvwxyz0123 这句');
assert.equal(openai.drop, false);
assert.deepEqual(openai.hits, ['openai-key']);
assert.ok(openai.text.includes(REDACTED));
assert.ok(!openai.text.includes('sk-abcdefg'), '密文不能留在输出里');

/* Bearer 头 */
const bearer = redact('请求头 Authorization: Bearer abcdefghijklmnopqrstuvwxyz.012345');
assert.deepEqual(bearer.hits, ['bearer']);
assert.ok(bearer.text.includes(REDACTED));

/* 通用凭证赋值（忽略大小写） */
const credential = redact('DATABASE_PASSWORD: hunter2hunter2 已写进配置');
assert.deepEqual(credential.hits, ['credential']);
assert.ok(credential.text.includes(REDACTED));
assert.ok(!credential.text.includes('hunter2'));

/* 手机号 */
const phone = redact('联系电话 13800138000，随时可打');
assert.deepEqual(phone.hits, ['phone-cn']);
assert.ok(!phone.text.includes('13800138000'));

/* 身份证 */
const idCard = redact('身份证 110101199003072316 已核对');
assert.deepEqual(idCard.hits, ['id-card']);
assert.ok(!idCard.text.includes('110101199003072316'));

/* 银行卡 */
const bank = redact('卡号 6222021234567890123 不要外传');
assert.deepEqual(bank.hits, ['bank-card']);
assert.ok(!bank.text.includes('6222021234567890123'));

/* 私钥整块 → 整条丢弃（绝不降级 JOURNAL） */
const privateKey = redact([
    '部署时用的密钥是：',
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEA1234',
    '-----END RSA PRIVATE KEY-----',
].join('\n'));
assert.equal(privateKey.drop, true, '私钥整块必须整条丢弃');
assert.ok(privateKey.hits.includes('private-key'));
assert.ok(!privateKey.text.includes('MIIEowIBAAKCAQEA1234'));

/* 只有 BEGIN 没有 END 的截断私钥 → 照样丢 */
const truncatedKey = redact('-----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXk');
assert.equal(truncatedKey.drop, true);
assert.ok(truncatedKey.hits.includes('private-key-unterminated'));

/* 超长密钥打码后残留比例过低 → 丢弃（02 §4.3 的 40% 规则） */
const longKey = redact(`sk-${'a'.repeat(64)}`);
assert.equal(longKey.drop, true, `${longKey.hits.join(',')} 打码后残留不足 40% 应丢弃`);

/* 干净文本不动 */
const clean = redact('依赖用 tarball 装，改完 lib 要重启 DSH');
assert.equal(clean.text, '依赖用 tarball 装，改完 lib 要重启 DSH');
assert.deepEqual(clean.hits, []);
assert.equal(clean.drop, false);

/* 空文本 */
assert.deepEqual(redact(''), { text: '', hits: [], drop: false });
assert.deepEqual(redact(undefined), { text: '', hits: [], drop: false });

/* 正则表：每个 pattern 都是全局正则（`replace` 才能全替换），且都有 id */
for (const spec of SECRET_PATTERNS) {
    assert.equal(spec.pattern.global, true, `${spec.id} 缺 g 标志`);
    assert.equal(typeof spec.id, 'string');
}

/* 连续调用不能受 lastIndex 影响（全局正则的老坑） */
const again = redact('联系电话 13800138000');
assert.deepEqual(again.hits, ['phone-cn'], '第二次调用仍应命中');

/* scope 映射（本插件词汇 → store 词汇） */
assert.equal(toStoreScope('global'), 'fact');
assert.equal(toStoreScope('project'), 'memory');
assert.equal(toStoreScope('journal'), 'journal');
assert.equal(toStoreScope('nonsense'), '');

/* 桶 × scope 断言 */
assert.equal(checkBucketScope('project', { workspaceId: 'ws-1' }).ok, true);
assert.equal(checkBucketScope('project', { workspaceId: '_unassigned' }).reason, 'project-in-unassigned');
assert.equal(checkBucketScope('project', {}).reason, 'project-without-workspace');
assert.equal(checkBucketScope('journal', { workspaceId: '_unassigned' }).ok, true);
assert.equal(checkBucketScope('global', { workspaceId: '_unassigned' }).ok, true);
assert.equal(checkBucketScope('whatever', {}).reason, 'bad-scope');

/* 校验器：三条出口都被覆盖（store 是注入的假实现） */
const { store, calls } = fakeStore();
const okValidator = createValidator({ resolveStore: store });
const okResult = await okValidator.validate('global', { content: '依赖用 tarball 装', confidence: 'high' }, { cwd: 'D:\\proj' });
assert.equal(okResult.decision, DECISION.OK);
assert.equal(calls[0].name, 'validateEntry');
assert.equal(calls[0].args[0], 'fact', '应把 global 映射成 store 的 fact');
assert.deepEqual(calls[0].args[2], { cwd: 'D:\\proj' });

/* demote:journal */
const journalValidator = createValidator({
    resolveStore: { validateEntry: async () => ({ ok: false, reason: '过程叙述', demote: 'journal' }) },
});
const journalResult = await journalValidator.validate('project', { content: '先改成 A 然后发现不行' }, { cwd: 'D:\\proj', workspaceId: 'ws-1' });
assert.equal(journalResult.decision, DECISION.JOURNAL);
assert.equal(journalResult.reason, '过程叙述');

/* demote:drop（敏感串由主插件再扫一遍也会走到这里） */
const dropValidator = createValidator({
    resolveStore: { validateEntry: async () => ({ ok: false, reason: '原因词', demote: 'drop' }) },
});
assert.equal((await dropValidator.validate('global', { content: '因为……' })).decision, DECISION.DROP);

/* 没说 demote 的失败 → 保守丢弃 */
const vague = createValidator({ resolveStore: { validateEntry: async () => ({ ok: false }) } });
assert.equal((await vague.validate('global', { content: '随便' })).decision, DECISION.DROP);

/* 命中敏感串：连 store 都不该被调用 */
const secretStore = fakeStore();
const secretValidator = createValidator({ resolveStore: secretStore.store });
const secretResult = await secretValidator.validate('global', { content: '-----BEGIN RSA PRIVATE KEY-----\nabc' });
assert.equal(secretResult.decision, DECISION.DROP);
assert.equal(secretResult.reason, 'secret');
assert.equal(secretStore.calls.length, 0, '敏感串命中时不该再问 store');

/* 打码后照常走 store */
const masked = await okValidator.validate('global', { content: '联系人 13800138000 记录一下' });
assert.equal(masked.decision, DECISION.OK);
assert.deepEqual(masked.hits, ['phone-cn']);
assert.ok(masked.entry.content.includes(REDACTED));

/* store 不可用 → drop（不假装成功） */
const noneValidator = createValidator({ resolveStore: async () => null });
const noneResult = await noneValidator.validate('global', { content: '依赖用 tarball 装' });
assert.equal(noneResult.decision, DECISION.DROP);
assert.equal(noneResult.reason, 'store-unavailable');

/* store 抛超限错误 → 降级 journal */
const budgetValidator = createValidator({
    resolveStore: { validateEntry: async () => { throw budgetError(); } },
});
assert.equal((await budgetValidator.validate('global', { content: 'x' })).decision, DECISION.JOURNAL);

/* store 抛别的错 → drop */
const brokenValidator = createValidator({
    resolveStore: { validateEntry: async () => { throw new Error('磁盘炸了'); } },
});
assert.equal((await brokenValidator.validate('global', { content: 'x' })).decision, DECISION.DROP);

/* project 条目落 _unassigned 桶 → 降级 journal，且根本不调 store */
const orphanStore = fakeStore();
const orphanValidator = createValidator({ resolveStore: orphanStore.store });
const orphan = await orphanValidator.validate('project', { content: '这个项目用 pnpm' }, { workspaceId: '_unassigned' });
assert.equal(orphan.decision, DECISION.JOURNAL);
assert.equal(orphan.reason, 'project-in-unassigned');
assert.equal(orphanStore.calls.length, 0);

/* redact=false 时跳过正则层（配置给了才允许，主插件闸口仍兜底） */
const noRedact = createValidator({ resolveStore: fakeStore().store, redactEnabled: false });
const skipped = await noRedact.validate('global', { content: '联系电话 13800138000' });
assert.deepEqual(skipped.hits, []);

/* 空正文 → drop */
assert.equal((await okValidator.validate('global', { content: '   ' })).reason, 'empty');

console.log('✓ redact.test.mjs 全部通过');
