/**
 * 工作区归属（02 §7.0 拍板 #13）：注册表解析、会话反查、未分组回落、project 断言。
 *
 * 依据 M0 §6 的**真实形状**：`$DSH_HOME/storages/workspace.json` →
 * `tables.workspaces[workspaceId] = {path,title,sessionIds[]}`（本机实测 9 个工作区 / 216 个 sessionId，
 * 而磁盘上有 463 个会话文件 ⇒ 「未分组」是常态，不是异常）。
 *
 * 跑法：node test/workspace.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
    UNASSIGNED_BUCKET,
    UNASSIGNED_TITLE,
    assertProjectScope,
    bucketForSession,
    bucketInfo,
    defaultRegistryPath,
    loadRegistry,
    workspaceForSession,
} from '../lib/workspace.js';
import { makeHome } from './_helpers.mjs';

const { home, cleanup } = makeHome('pmc-workspace');

try {
    /* ── 默认路径 = $DSH_HOME/storages/workspace.json ── */
    assert.equal(defaultRegistryPath(), join(home, 'storages', 'workspace.json'));

    /* ── 文件不存在 ⇒ 空注册表，不抛 ── */
    assert.deepEqual(loadRegistry(), { workspaces: {} });
    assert.deepEqual(loadRegistry(join(home, '没有这个文件.json')), { workspaces: {} });

    /* ── 宿主真实形状：tables.workspaces ── */
    const registryFile = defaultRegistryPath();
    mkdirSync(dirname(registryFile), { recursive: true });
    writeFileSync(registryFile, JSON.stringify({
        unit: 'v2',
        global: {},
        tables: {
            workspaces: {
                'aae899f6-a922-45a8-9f91-22caf132122b': {
                    path: 'D:\\CODE\\DSH插件装配站',
                    title: 'DSH插件装配站',
                    sessionIds: ['session-952b74aa', 'session-fdd8b1c6'],
                    createdAt: 1,
                    updatedAt: 2,
                },
                'b0000000-0000-0000-0000-000000000000': {
                    path: 'D:\\test1',
                    title: 'test1',
                    sessionIds: ['session-other'],
                },
                // 坏条目：不符合形状的必须逐条丢掉，不整份放弃
                'broken': { title: 42, sessionIds: 'not-an-array' },
                'nullish': null,
            },
        },
    }), 'utf8');

    const registry = loadRegistry();
    assert.deepEqual(Object.keys(registry.workspaces).sort(), ['aae899f6-a922-45a8-9f91-22caf132122b', 'b0000000-0000-0000-0000-000000000000', 'broken'].sort());
    assert.equal(registry.workspaces['aae899f6-a922-45a8-9f91-22caf132122b'].title, 'DSH插件装配站');
    assert.deepEqual(registry.workspaces['aae899f6-a922-45a8-9f91-22caf132122b'].sessionIds, ['session-952b74aa', 'session-fdd8b1c6']);
    assert.deepEqual(registry.workspaces.broken.sessionIds, [], '坏 sessionIds 当空数组');

    /* ── 反查 ── */
    assert.deepEqual(workspaceForSession(registry, 'session-fdd8b1c6'), {
        workspaceId: 'aae899f6-a922-45a8-9f91-22caf132122b',
        title: 'DSH插件装配站',
        path: 'D:\\CODE\\DSH插件装配站',
    });
    assert.equal(workspaceForSession(registry, 'session-未登记'), null);
    assert.equal(workspaceForSession(registry, ''), null);
    assert.equal(workspaceForSession(registry, undefined), null);
    assert.equal(workspaceForSession(null, 'session-fdd8b1c6'), null, '注册表为空也不抛');

    /* ── 桶回落：未登记 ⇒ _unassigned（这是常态，不是错误） ── */
    assert.deepEqual(bucketForSession(registry, 'session-未登记'), {
        workspaceId: UNASSIGNED_BUCKET,
        title: UNASSIGNED_TITLE,
        path: '',
    });
    assert.equal(UNASSIGNED_BUCKET, '_unassigned');
    assert.equal(UNASSIGNED_TITLE, '未分组');
    assert.deepEqual(bucketForSession(registry, 'session-other', { unassigned: '_orphan' }), {
        workspaceId: 'b0000000-0000-0000-0000-000000000000',
        title: 'test1',
        path: 'D:\\test1',
    });
    assert.equal(bucketForSession(registry, 'session-未登记', { unassigned: '_orphan' }).workspaceId, '_orphan', '桶名可配置');

    /* ── 注册表损坏 ⇒ 整体降级 _unassigned（02 §11 风险表） ── */
    writeFileSync(registryFile, '{这不是 JSON', 'utf8');
    assert.deepEqual(loadRegistry(), { workspaces: {} });
    assert.equal(bucketForSession(loadRegistry(), 'session-952b74aa').workspaceId, '_unassigned', '坏了就当未分组，不阻塞主流程');

    writeFileSync(registryFile, '"字符串不是对象"', 'utf8');
    assert.deepEqual(loadRegistry(), { workspaces: {} });

    writeFileSync(registryFile, JSON.stringify({ tables: { workspaces: [] } }), 'utf8');
    assert.deepEqual(loadRegistry(), { workspaces: {} }, 'workspaces 是数组也算坏形状');

    /* ── 拍平的 {workspaces} 形状也认（单测/未来版本用） ── */
    writeFileSync(registryFile, JSON.stringify({ workspaces: { 'ws-flat': { path: 'D:\\flat', title: '平的', sessionIds: ['session-flat'] } } }), 'utf8');
    assert.equal(bucketForSession(loadRegistry(), 'session-flat').workspaceId, 'ws-flat');

    /* ── bucketInfo：runAllBuckets 手里只有桶名 ── */
    const shaped = { workspaces: { 'ws-1': { path: 'D:\\p1', title: '项目一', sessionIds: [] } } };
    assert.deepEqual(bucketInfo(shaped, 'ws-1'), { workspaceId: 'ws-1', title: '项目一', path: 'D:\\p1' });
    assert.deepEqual(bucketInfo(shaped, '_unassigned'), { workspaceId: '_unassigned', title: UNASSIGNED_TITLE, path: '' });
    assert.deepEqual(bucketInfo(shaped, 'ws-已删除'), { workspaceId: 'ws-已删除', title: '', path: '' }, '注册表里没有 ⇒ 空 path（project 条目会被闸口拦下）');
    assert.deepEqual(bucketInfo(shaped, ''), { workspaceId: '_unassigned', title: UNASSIGNED_TITLE, path: '' });
    assert.deepEqual(bucketInfo(shaped, 'ws-1', { unassigned: '_orphan' }).title, '项目一');

    /* ── project 断言：`_unassigned` 不许产出 project 记忆 ── */
    assert.deepEqual(assertProjectScope('project', 'ws-1'), { ok: true, reason: 'ok' });
    assert.deepEqual(assertProjectScope('project', { workspaceId: 'ws-1' }), { ok: true, reason: 'ok' });
    assert.deepEqual(assertProjectScope('project', '_unassigned'), { ok: false, reason: 'project-in-unassigned' });
    assert.deepEqual(assertProjectScope('project', ''), { ok: false, reason: 'project-without-workspace' });
    assert.deepEqual(assertProjectScope('project', '_unassigned', { unassigned: '_orphan' }), { ok: true, reason: 'ok' }, '桶名可配置');
    assert.deepEqual(assertProjectScope('global', '_unassigned'), { ok: true, reason: 'ok' }, 'global 与 journal 不受限');
    assert.deepEqual(assertProjectScope('journal', ''), { ok: true, reason: 'ok' });
    assert.deepEqual(assertProjectScope('nonsense', 'ws-1'), { ok: false, reason: 'bad-scope' });
} finally {
    cleanup();
}

console.log('✓ workspace.test.mjs 全部通过');
