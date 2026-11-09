/**
 * 接线：插件形状、Config 默认值（02 §8）、命令路由、设置页注册钩子、事件空转。
 *
 * 依赖说明：`lib/index.js` 需要 `schemastery`（与兄弟插件一致，装配后由 profile 提供）。
 * 本机没装它时退化为 `node --check` 语法校验并打印 SKIP —— 不是失败，但也绝不假装通过。
 *
 * 跑法：node test/wiring.test.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHome } from './_helpers.mjs';

const libDir = fileURLToPath(new URL('../lib/', import.meta.url));

/** 退路：对每个 lib 文件做语法检查（`node --check` 只解析不执行）。 */
function syntaxCheckAll() {
    const files = readdirSync(libDir).filter((name) => name.endsWith('.js'));
    for (const name of files) {
        execFileSync(process.execPath, ['--check', `${libDir}${name}`], { stdio: 'pipe' });
    }
    return files.length;
}

let mod;
try {
    mod = await import('../lib/index.js');
} catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes('schemastery')) {
        const count = syntaxCheckAll();
        console.log(`SKIP wiring.test.mjs：本机未安装 schemastery（装配后由 profile 提供）；已用 node --check 校验 ${count} 个 lib 文件的语法`);
        process.exit(0);
    }
    throw error;
}

const {
    AUTO_TRIGGER_READY,
    COMMAND_DEFINITION_ID,
    COMMAND_NAME,
    Config,
    apply,
    backupsDir,
    createRuntime,
    inject,
    name,
    pendingDir,
} = mod;
const { createCommands } = await import('../lib/commands.js');
const { decodeCommand } = await import('../lib/command.js');
const { coerceSetting } = await import('../lib/settings.js');

/* 插件形状：与 package.json / cordis.patch.yml 对得上 */
assert.equal(name, '@dsh-external/dsh-persona-memory-consolidate');
assert.deepEqual(inject, ['commands']);
assert.equal(COMMAND_NAME, 'memory-consolidate');
assert.equal(COMMAND_DEFINITION_ID, '@dsh-external/dsh-persona-memory-consolidate/memory-consolidate');
assert.equal(AUTO_TRIGGER_READY, true, 'M2 起自动触发已接线（主触发 = session/event 的 turn/end）');
assert.equal((await import('../lib/milestone.js')).MILESTONE, 'M5');

/* Config：02 §8 的键与默认值 */
const defaults = Config({});
const EXPECTED = {
    enabled: true,
    // P1 运行档位：默认 auto ⇒ 没改过设置的人行为与改造前完全一致
    mode: 'auto',
    dryRun: false,
    gateEnabled: true,
    crossPoolDedup: true,
    supersedeOnUpdate: true,
    scope: 'both',
    minTurns: 6,
    minChars: 8000,
    perTurnCap: 1200,
    maxSampleChars: 8000,
    workspaceIsolation: true,
    unassignedBucket: '_unassigned',
    pendingMaxRows: 200,
    pendingMaxAgeDays: 30,
    archiveRetentionDays: 90,
    idleScanMinutes: 30,
    dailyLlmBudget: 60,
    maxTurnsPerCall: 6,
    maxOutputTokens: 8192,
    callTimeoutMs: 120000,
    partialKeep: false,
    provider: '',
    model: '',
    subagent: false,
    redact: true,
    crossEnabled: true,
    crossSource: 'auto',
    crossIntervalHours: 24,
    crossMinEntries: 20,
    crossScanEntries: 200,
    crossPromoteHits: 2,
    crossMaxSessions: 20,
    crossLookbackDays: 7,
};
for (const [key, value] of Object.entries(EXPECTED)) {
    assert.deepEqual(defaults[key], value, `配置默认值不一致：${key}`);
}
assert.equal(defaults.workspaceRegistry, '', 'workspaceRegistry 默认空串（= 宿主注册表）');

/* 命令解析 */
assert.deepEqual(decodeCommand(''), { subcommand: 'status', args: [], known: true, raw: '' });
assert.equal(decodeCommand('dry').subcommand, 'dry');
assert.equal(decodeCommand('  RUN  ').subcommand, 'run');
assert.deepEqual(decodeCommand('rollback run-123').args, ['run-123']);
assert.equal(decodeCommand('乱写').known, false);

/* 设置项校验：不合法必须抛（页面保留旧值） */
assert.equal(coerceSetting('enabled', true), true);
assert.equal(coerceSetting('minTurns', '8'), 8);
assert.equal(coerceSetting('crossSource', 'journal'), 'journal');
assert.equal(coerceSetting('provider', ''), '');
// A0 缺陷（M1 修掉）：字符串项曾一律当数字解析 ⇒ provider / model 永远写不进去
assert.equal(coerceSetting('provider', 'workbuddy-cn'), 'workbuddy-cn');
assert.equal(coerceSetting('model', 'deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
assert.throws(() => coerceSetting('enabled', 'yes'), /只接受开\/关/);
assert.throws(() => coerceSetting('minTurns', '1.5'), /整数/);
assert.throws(() => coerceSetting('minTurns', '0'), /不能小于/);
assert.throws(() => coerceSetting('crossSource', 'nope'), /不接受/);
assert.throws(() => coerceSetting('未知键', 1), /未知的设置项/);

/* 运行时：路径全部落在临时 DSH_HOME 下 */
const { home, cleanup } = makeHome('pmc-wiring');
try {
    // 显式屏蔽主插件 store：本用例考的是「store 不可用时诚实降级」，
    // 不能因为本机恰好装了主插件（link 安装后能解析 ./store）就变成 success。
    const runtime = createRuntime({}, { resolveStore: async () => null });
    assert.equal(runtime.config.minTurns, 6);
    assert.ok(pendingDir().startsWith(home), `pendingDir 应在 DSH_HOME 内：${pendingDir()}`);
    assert.ok(backupsDir().startsWith(home));
    assert.ok(runtime.cursorFile.startsWith(home));
    assert.equal(typeof runtime.budget.tryStart, 'function');
    assert.equal(typeof runtime.validator.validate, 'function');
    assert.equal(typeof runtime.writer.apply, 'function');
    assert.equal(typeof runtime.sources.list, 'function');
    assert.equal(typeof runtime.runLog.append, 'function');

    /* 运行时：M1 起多了 extractor / callModel 槽位与 backupsDir / registry */
    assert.equal(runtime.extractor, null, '模型只在命令执行时接线');
    assert.equal(runtime.callModel, null);
    assert.ok(runtime.backupsDir.startsWith(home));
    assert.ok(runtime.consolidateDir.startsWith(home));
    assert.ok(runtime.registryFile.startsWith(home));
    assert.deepEqual(runtime.registry, { workspaces: {} }, '没装宿主注册表 ⇒ 空表（全部会话会落 _unassigned）');

    /* 命令（M1：处理器是 async，宿主会 await 它） */
    const commands = createCommands(runtime);
    const status = await commands.handle({ rawInput: '' });
    assert.equal(status.kind, 'success');
    assert.ok(status.text.includes('自动沉淀'));
    assert.ok(status.text.includes('消费门槛'));
    assert.ok(status.text.includes('自动触发：'), '状态里要显示自动触发是否接线');
    assert.ok(status.text.includes('上次运行：从未'));

    // 没有暂存行时：dry / run 都成功，但报告「没有待沉淀」
    const dry = await commands.handle({ rawInput: 'dry' });
    assert.equal(dry.kind, 'success');
    assert.ok(dry.text.includes('干跑'));
    assert.ok(dry.text.includes('没有待沉淀'));

    const run = await commands.handle({ rawInput: 'run' });
    assert.equal(run.kind, 'success');
    assert.ok(run.text.includes('没有待沉淀'), '默认 dryRun:true 且没有暂存行，不该报错');

    // 本用例没有注入 store（本机未安装主插件 0.7.0）⇒ L2 必须诚实降级，
    // 不能假装成功。带假 store 的成功路径由 crosssession.test.mjs 覆盖。
    const cross = await commands.handle({ rawInput: 'cross' });
    assert.equal(cross.kind, 'error', `store 不可用时 cross 必须降级：${cross.text}`);
    assert.ok(cross.text.includes('store 不可用'), cross.text);

    assert.equal((await commands.handle({ rawInput: 'rollback' })).kind, 'error');
    const noSnapshot = await commands.handle({ rawInput: 'rollback run-1' });
    assert.equal(noSnapshot.kind, 'error');
    assert.ok(noSnapshot.text.includes('run-1'));

    const unknown = await commands.handle({ rawInput: '删除所有记忆' });
    assert.equal(unknown.kind, 'error');
    assert.ok(unknown.text.includes('未知子命令'));

    /* apply()：注册命令、设置项、事件空转；绝不订阅 pre-step */
    const registrations = [];
    const settings = [];
    const listeners = new Map();
    const effects = [];
    const injected = [];
    const services = {
        commands: {
            register(definition) {
                registrations.push(definition);
                return { dispose() {} };
            },
        },
        personaMemory: {
            settings: {
                register(item) {
                    settings.push(item);
                    return { dispose() {} };
                },
            },
        },
    };
    const ctx = {
        logger: { info() {}, warn() {} },
        get: (service) => services[service],
        inject(names, callback) {
            injected.push(names);
            // 真实 cordis 的作用域 ctx 上，服务是**属性**（`commandCtx.commands`）。
            callback({
                get: (service) => services[service],
                commands: services.commands,
                personaMemory: services.personaMemory,
                effect: (fn) => effects.push(fn),
            });
        },
        on(type, handler) {
            listeners.set(type, [...(listeners.get(type) ?? []), handler]);
        },
        effect(fn) {
            effects.push(fn);
        },
    };

    apply(ctx, {});

    assert.equal(registrations.length, 1, '应注册一个命令');
    assert.equal(registrations[0].name, 'memory-consolidate');
    assert.equal(registrations[0].definitionId, COMMAND_DEFINITION_ID);
    assert.equal(typeof registrations[0].handler, 'function');
    assert.deepEqual(registrations[0].input, { hint: '[status|dry|run|cross [dry]|rollback <runId|last>]' });
    // M1 起 handler 是 async（宿主 `await withAbort(Promise.resolve(handler(…)), signal)`），
    // 所以这里必须 await；A0 那句「只接受同步返回」是错的。
    const handlerResult = await registrations[0].handler({ rawInput: 'status' });
    assert.equal(handlerResult.kind, 'success');

    assert.ok(settings.length >= 10, `设置项应注册到「记忆」页，实得 ${settings.length}`);
    assert.ok(settings.some((item) => item.id === 'consolidate.enabled'));
    // 成品不暴露干跑开关：默认就是写盘，演练走 `/memory-consolidate dry`
    assert.ok(!settings.some((item) => item.id === 'consolidate.dryRun'));
    assert.ok(settings.some((item) => item.id === 'consolidate.crossSource' && item.kind === 'select'));
    assert.ok(settings.some((item) => item.kind === 'readonly' && item.id === 'consolidate.pendingDir'));
    for (const item of settings) {
        assert.ok(['toggle', 'select', 'text', 'readonly'].includes(item.kind), `主机不支持的控件种类：${item.kind}`);
    }

    assert.ok(listeners.has('session/event'), 'M2 主触发走 session/event 的 turn/end');
    assert.ok(listeners.has('agent/status'), '状态兜底（补漏）');
    assert.ok(listeners.has('agent/disposed'), '销毁前最多 3s 收尾');
    assert.ok(!listeners.has('agent/pre-step'), '铁律：绝不在 pre-step 里 await 沉淀');

    /* 事件处理器必须是不抛的安全入口：拿不到会话/事件时什么都不做，不做 IO */
    for (const [type, handlers] of listeners) {
        for (const handler of handlers) {
            const before = process.cwd();
            const value = handler({ agent: { id: 'session-1', session: { header: { delegationLevel: 0 } } }, status: 'idle' });
            assert.equal(value, undefined, `${type} 处理器不该有返回值`);
            assert.equal(process.cwd(), before, `${type} 处理器不该切目录`);
        }
    }

    /* 事件处理器里不该有惊人的副作用：pending 目录都没被创建 */
    assert.equal(existsSync(join(pendingDir(), 'ws-1')), false);

    /* M2：`apply` 真的接上了 `turn/end` → L0（拿 ctx 上的处理器走一遍完整链路）。
       临时 DSH_HOME 里没有工作区注册表 ⇒ 会话落 `_unassigned` 桶。 */
    const wiredTurn = [
        { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
        {
            type: 'user/message',
            seq: 2,
            time: 2,
            data: { message: { role: 'user', content: [{ type: 'text', text: '接线用的提问' }], source: { kind: 'user' } } },
        },
        {
            type: 'assistant/message',
            seq: 3,
            time: 3,
            data: {
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: '接线用的结论：回合结束只写一行 L0，不调模型。'.repeat(4) }],
                },
            },
        },
        { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ];
    listeners.get('session/event')[0](
        { id: 'session-wired', header: { cwd: '' }, events: wiredTurn },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    );
    const { readRows } = await import('../lib/pending.js');
    const wiredRows = readRows({ pendingDir: pendingDir(), bucket: '_unassigned', sessionId: 'session-wired' });
    assert.equal(wiredRows.length, 1, 'M2：turn/end 要正好写一行 L0');
    assert.equal(wiredRows[0].row.turn, 1);
    assert.equal(wiredRows[0].row.consumed, false);
    assert.ok(wiredRows[0].row.chars > 0);

    /* 启动期注入作用域：commands 必须注入；personaMemory 有两条合法路径 ——
       服务已经在了就直接注册（`ctx.get`），还没出现就作用域注入等它。 */
    const injectedScopes = injected.map((names) => names.join(','));
    assert.ok(injectedScopes.includes('commands'), '启动期就注入 commands 作用域');
    assert.ok(
        injectedScopes.includes('personaMemory') || settings.length >= 10,
        'personaMemory 要么直接注册成功，要么走作用域注入',
    );
} finally {
    cleanup();
}

console.log('✓ wiring.test.mjs 全部通过');
