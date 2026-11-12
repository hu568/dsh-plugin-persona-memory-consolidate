/**
 * @dsh-external/dsh-persona-memory-consolidate — 宿主机半（HOST PLANE）。
 *
 * 给只写**被动**记忆的 DSH 补上**写侧**：回合结束时把对话压成暂存行（L0，不花 LLM），
 * 攒够 6 轮 / 8000 字符后一次抽取成结论式条目，经主插件 `./store` 的校验与闸口写进
 * `JOURNAL.jsonl` / `FACT.md` / `MEMORY.md`；撞限只降级 JOURNAL，**绝不自己压缩**。
 *
 * 数据落点全部在 `$DSH_HOME/memory/consolidate/`（02 §7.7），项目目录里最多改
 * `MEMORY.md`（由主插件写）。
 *
 * **M2 现状**（自动触发已接线）：
 *  - 主触发：`ctx.on('session/event', (session, event) => …)` 里的 `turn/end` →
 *    同步写一行 L0（`pending.appendRow`）→ 门槛达标就在**微任务**里跑 `runL1`
 *    （实现在 `lib/autotrigger.js`，本文件只负责装配）；
 *  - 补漏：`agent/status`（`idle` / `maintenance`）补写事件路径漏掉的回合，
 *    `agent/disposed` 最多 3s 收尾，`config.idleScanMinutes` 兜底扫描 + 过期清理；
 *  - 手动闭环照旧：`/memory-consolidate run|dry|rollback` 读暂存、调 LLM、经 store
 *    写盘、能回滚（`lib/pipeline.js`）；
 *  - `AUTO_TRIGGER_READY === true`（`lib/milestone.js`），回退时翻回 false 即可。
 *
 * 三条硬规矩（02 §6.5）的接线纪律：
 *  1. **不订阅 `agent/pre-step`**：沉淀绝不允许拖慢用户请求（事件处理器里零 await、
 *     零 LLM 调用，真正干活一律在微任务/定时器里）；
 *  2. 中断回合直接丢（`autotrigger.onSessionEvent` 里判 `event.data.reason.kind`）；
 *  3. 单飞 + 全局并发 1（`budget.createBudget`；`autotrigger` 不重复加锁）。
 */

import z from 'schemastery';
import { createAutoTrigger } from './autotrigger.js';
import { DEFAULT_CALL_TIMEOUT_MS, createBudget } from './budget.js';
import { decodeCommand } from './command.js';
import { createCommands } from './commands.js';
import { decideCross, readCrossCursor, DEFAULT_UNASSIGNED_BUCKET } from './crosssession.js';
import { backupsDir, consolidateDir, crossCursorPath, cursorPath, pendingDir } from './cursor.js';
import { createExtractor } from './extractor.js';
import { createCallModel, readDefaultModelRoute, DEFAULT_REASONING_EFFORT } from './llm.js';
import { AUTO_TRIGGER_READY } from './milestone.js';
import { MODE, resolveMode } from './mode.js';
import { createRunLog, supersededPath } from './runlog.js';
import {
    SETTINGS_GROUP,
    applyConsolidateOverrides,
    coerceSetting,
    createSettingItems,
    readConsolidateOverrides,
    writeConsolidateOverrides,
} from './settings.js';
import { createJournalSource, createFilesSource, createServiceSource, createSourceChain, DEFAULT_PER_ENTRY_CHARS } from './sources.js';
import { createStoreResolver, createValidator } from './validate.js';
import { defaultRegistryPath, loadRegistry } from './workspace.js';
import { createWriter } from './writer.js';

/** Cordis 插件名（与 package.json 的 name 一致）。 */
export const name = '@dsh-external/dsh-persona-memory-consolidate';

/** 必需服务：命令注册表（宿主组合里恒在）。 */
export const inject = ['commands'];

/** 命令名（不带斜杠）。 */
export const COMMAND_NAME = 'memory-consolidate';
/** 稳定定义标识（与每次执行的 commandId 无关）。 */
export const COMMAND_DEFINITION_ID = '@dsh-external/dsh-persona-memory-consolidate/memory-consolidate';
/** discovery 界面里的一句话说明。 */
export const COMMAND_DESCRIPTION = '自动沉淀记忆：查看状态 / 干跑 / 立即沉淀 / 跨会话整理 / 回滚';

/**
 * 自动触发是否已接线。
 *
 * M2 起为 true：`session/event` 的 `turn/end` / `agent/status` / `agent/disposed` /
 * 兜底 `setInterval` 全部真干活（`lib/autotrigger.js`）。翻回 false 就退回 M1 的
 * 「只交付手动命令闭环」状态。
 */
export { AUTO_TRIGGER_READY };

/** 配置 schema：键与默认值全部取自 02 §8。 */
export const Config = z.object({
    enabled: z.boolean().default(true),
    /**
     * 运行档位（P1）：`off` / `observe` / `auto`，默认 `auto`。
     *
     * 优先级见 `lib/mode.js`：显式 `off` / `observe` 压过 `enabled`；`auto`（默认）才跟随
     * `enabled`。默认 `auto` ⇒ 没改过设置的人行为与改造前**完全一致**。
     */
    mode: z.string().default('auto'),
    /** 干跑：只出报告不落盘。默认关闭（成品行为）；需要一次性演练时用 `/memory-consolidate dry`。 */
    dryRun: z.boolean().default(false),
    /**
     * 确定性写入闸口（0.2.0）：抽取结果落盘前过滤空壳/过程叙述/太短/同批重复/缺时点。
     *
     * 规则再保守也是启发式，线上误杀时要能**一键关掉**（不用改代码、不用等发版）：
     * `false` ⇒ 整批放行，runlog 也**不写** `gate` 字段（「没有闸口」与「闸口没拦任何东西」
     * 是两件事，不靠 `dropped:0` 猜）。
     */
    gateEnabled: z.boolean().default(true),
    /**
     * 跨池近重复拦截（DESIGN §5）：落盘前与现有 FACT / 项目记忆条目比对，
     * 完全相同或相似度 ≥ 0.95 的 ADD 候选直接丢弃（计入闸口 `near-duplicate`）；
     * 0.45–0.95 交给归并裁决（放行），池为空或打分异常也放行。
     */
    crossPoolDedup: z.boolean().default(true),
    /**
     * 改写走失效标记（DESIGN §6）：UPDATE 时先写新正文，成功后才把旧条目标记为
     * `superseded`（只加注释、保留原文可审计）；任一环节不成立退回原子替换，
     * **绝不**出现「旧的已失效、新的没写进」。
     */
    supersedeOnUpdate: z.boolean().default(true),
    /**
     * 截断重试（DESIGN v3 §13）：`LLM_TRUNCATED` 且抢救不出可用结论时，同 prompt 再调一次，
     * 并请调用侧把推理等级压到模型支持的最低档（`max_tokens` 是「推理 + 正文」的总预算，
     * 第一次的额度往往是被思考吃光的）。只重试一次，仍失败按原逻辑整次 FAIL。
     */
    retryOnTruncate: z.boolean().default(true),
    /** `journal` 只写 JOURNAL；`both` 也写 FACT / MEMORY。 */
    scope: z.string().default('both'),
    /** 消费门槛（先到先算）。 */
    minTurns: z.number().min(1).default(6),
    minChars: z.number().min(100).default(8000),
    /** 单回合结论截断。 */
    perTurnCap: z.number().min(100).default(1200),
    /** 单次沉淀输入上限（字符）。 */
    maxSampleChars: z.number().min(500).default(8000),
    /** 暂存/消费/归档按 workspaceId 分桶。 */
    workspaceIsolation: z.boolean().default(true),
    /** 空 = `$DSH_HOME/storages/workspace.json`。 */
    workspaceRegistry: z.string().default(''),
    unassignedBucket: z.string().default('_unassigned'),
    /** 暂存与兜底。 */
    pendingMaxRows: z.number().min(1).default(200),
    pendingMaxAgeDays: z.number().min(1).default(30),
    archiveRetentionDays: z.number().min(1).default(90),
    idleScanMinutes: z.number().min(1).default(30),
    /** 预算与调用。 */
    dailyLlmBudget: z.number().min(1).default(60),
    maxTurnsPerCall: z.number().min(1).default(6),
    /**
     * 单次调用的输出上限（0.2.1）：显式传给宿主 `prepareCall`，**不指望**宿主的
     * `defaultMaxTokens`（它可能不存在 ⇒ 等于不限 ⇒ 截断/超长行为不可控）。
     */
    maxOutputTokens: z.number().min(256).default(8192),
    /**
     * 沉淀调用的推理等级（0.3.2）：默认 `low`。
     *
     * 宿主对推理模型默认给 `high`（本机 DeepSeek 即如此），沉淀这种机械抽取会把
     * 输出预算的大半花在思考上，真实后果就是 `finish.kind=max-tokens` ⇒
     * `LLM_TRUNCATED` ⇒ 一个字都不写。`low` 保留一点点理解力，又把预算留给正文。
     * 取值 `off|low|high|max`，或 `auto`（不传，交回宿主默认）；模型不支持推理时
     * 调用侧会自动丢弃这个键，不会因此失败。
     */
    reasoningEffort: z.string().default(DEFAULT_REASONING_EFFORT),
    /**
     * 单次调用超时（0.2.2）：默认 120s。
     *
     * 20s 对 `custom-commandcode` 这类中转（长上下文 + 推理模型）明显不够——真实验收里
     * 「请求真的发出去了、卡在 20000ms 超时」。超时后 `llm.js` 会 **abort** 底层请求，
     * 不是只在我们这边不等了。
     */
    callTimeoutMs: z.number().min(5000).default(120000),
    /** 预留：中断回合是否留 partial（默认关）。 */
    partialKeep: z.boolean().default(false),
    provider: z.string().default(''),
    model: z.string().default(''),
    subagent: z.boolean().default(false),
    redact: z.boolean().default(true),
    /** 跨会话（L2）。 */
    crossEnabled: z.boolean().default(true),
    crossSource: z.string().default('auto'),
    crossIntervalHours: z.number().min(1).default(24),
    crossMinEntries: z.number().min(1).default(20),
    crossScanEntries: z.number().min(1).default(200),
    crossPromoteHits: z.number().min(1).default(2),
    crossMaxSessions: z.number().min(1).default(20),
    crossLookbackDays: z.number().min(1).default(7),
});

/** 路径辅助再导出（`pendingDir` / `backupsDir` 的实现落在 cursor.js，避免两处写路径）。 */
export { pendingDir, backupsDir };

/**
 * 造运行时：config + 所有模块实例。**独立导出**，单测可以拿假 ctx 之前先验一堆东西。
 *
 * `extractor` / `callModel` 默认是 null：真实模型调用**只在命令执行时**接线
 * （`apply()` 里的 `prepare`），没人敲命令就一个字节都不花（M1 纪律）。
 *
 * @param {Record<string, any>} rawConfig
 * @param {{
 *   runLog?: any,
 *   resolveStore?: () => Promise<any | null>,
 *   budget?: any,
 *   now?: number,
 *   extractor?: any,
 *   callModel?: any,
 *   registry?: any,
 *   registryFile?: string,
 *   getSessionQuery?: () => any,
 *   sessionsDir?: string,
 * }} [options]
 * @returns {Record<string, any>}
 */
export function createRuntime(rawConfig, options = {}) {
    const config = Config(rawConfig ?? {});
    // 覆盖层：只覆盖用户显式改过的键，其余仍取组合配置。
    applyConsolidateOverrides(config, readConsolidateOverrides());

    const runLog = options.runLog ?? createRunLog();
    const resolveStore = options.resolveStore ?? createStoreResolver();
    const budget = options.budget ?? createBudget({
        dailyLlmBudget: config.dailyLlmBudget,
        now: Number.isFinite(options.now) ? options.now : Date.now(),
    });
    const validator = createValidator({ resolveStore, redactEnabled: config.redact !== false });
    // `resolveMode` 现取（不是快照）：设置页切档后下一次运行立刻生效，不必重启。
    const writer = createWriter({
        resolveStore,
        supersededFile: supersededPath(),
        resolveMode: () => resolveMode(config),
        resolveSupersedeOnUpdate: () => config.supersedeOnUpdate !== false,
    });

    /* ── 第二层数据源三档（02 §3.1 / M0 §3） ──
       `service` 走宿主平面那份 `sessionQuery`（`openAt: never` 也能精确读），
       `files` 硬限 cwd + 回溯天数 + 会话数，`journal` 永远兜底。
       `auto` 的降级链是 service → journal，**不含 files**（见 sources.js 文件头）。 */
    const journal = createJournalSource({ getStore: resolveStore });
    const service = createServiceSource({
        getSessionQuery: options.getSessionQuery,
        maxSessions: config.crossMaxSessions,
        perEntryChars: DEFAULT_PER_ENTRY_CHARS,
        maxChars: config.maxSampleChars,
    });
    const files = createFilesSource({
        sessionsDir: options.sessionsDir,
        lookbackDays: config.crossLookbackDays,
        maxSessions: config.crossMaxSessions,
        perEntryChars: DEFAULT_PER_ENTRY_CHARS,
        maxChars: config.maxSampleChars,
    });
    const sources = createSourceChain({
        preferred: config.crossSource,
        sources: { journal, service, files },
    });

    // 注册表只在建 runtime 时读一次：工作区归属是「回合结束时查一次」的低频操作，
    // 每次 run 重读反而会让一个半写的工作区目录看到不一致的画面。
    const registryFile = typeof config.workspaceRegistry === 'string' && config.workspaceRegistry.trim() !== ''
        ? config.workspaceRegistry.trim()
        : defaultRegistryPath();

    return {
        config,
        runLog,
        resolveStore,
        budget,
        validator,
        writer,
        sources,
        /** L2 的降级链（`crosssession.readMaterial` 读它；`sources` 是同一对象，留别名便于阅读）。 */
        crossChain: sources,
        /** 三档数据源本体（面板/诊断用；正常调用一律走 `crossChain`）。 */
        crossSources: { journal, service, files },
        /** 抽取器（含 callModel）；null = 还没接线（命令触发时由 `prepare` 装上）。 */
        extractor: options.extractor ?? null,
        /** 真实 `callModel`（`lib/llm.js`），归并裁决复用它。 */
        callModel: options.callModel ?? null,
        /**
         * 最近一次真实请求用过的 route（`{provider, model}`）。
         * `autotrigger` 在每个会话事件里刷新它；`callModel` 在调用时才读
         * ⇒ 用户切模型后**下一轮沉淀**就跟着换，不用重启也不用改配置。
         */
        lastRoute: options.lastRoute ?? null,
        /** 主插件 `store.templates()` 的缓存，`runL1` 每次运行前刷新。 */
        templatesCache: null,
        cursorFile: cursorPath(),
        crossCursorFile: crossCursorPath(),
        pendingDir: pendingDir(),
        backupsDir: backupsDir(),
        consolidateDir: consolidateDir(),
        supersededFile: supersededPath(),
        registryFile,
        registry: options.registry ?? loadRegistry(registryFile),
        cross: readCrossCursor(),
    };
}

/**
 * 把本插件的设置项注册到主插件的「设置 → 记忆」页。
 *
 * 与 recall 同款：父插件不一定已就绪（loader 并行启动），也不一定装了；先用裸
 * `ctx.get()` 快速判定，拿不到就用作用域 `ctx.inject(['personaMemory'], …)` 等服务
 * 出现后补注册。两者都没有时静默跳过——沉淀本身照常工作，只是没有页面开关。
 *
 * @param {any} ctx
 * @param {Record<string, any>} runtime
 * @param {(key: string, raw: unknown) => Promise<void>} onChange
 */
export function registerSettings(ctx, runtime, onChange) {
    const items = createSettingItems({
        config: runtime.config,
        pendingDir: runtime.pendingDir,
        cursorFile: runtime.cursorFile,
        onChange,
    });

    const attach = (scope) => {
        const service = scope?.get?.('personaMemory');
        if (service === undefined || typeof service?.settings?.register !== 'function') return;

        const handles = [];
        for (const item of items) {
            try {
                handles.push(service.settings.register(item));
            } catch (error) {
                ctx.logger?.warn?.(`[persona-memory-consolidate] 设置项 ${item.id} 注册失败：${String(error?.message ?? error)}`);
            }
        }
        if (handles.length === 0) return;

        const disposeAll = () => {
            for (const handle of handles.splice(0)) {
                try {
                    handle.dispose();
                } catch {
                    /* 父插件可能已先卸载 */
                }
            }
        };
        if (typeof scope.effect === 'function') scope.effect(() => disposeAll);
        else if (typeof ctx.effect === 'function') ctx.effect(() => disposeAll);

        ctx.logger?.info?.(`[persona-memory-consolidate] 已注册 ${handles.length} 个设置项到「${SETTINGS_GROUP}」分组`);
    };

    if (typeof ctx.get === 'function' && ctx.get('personaMemory') !== undefined) {
        attach(ctx);
        return;
    }
    if (typeof ctx.inject === 'function') {
        ctx.inject(['personaMemory'], attach);
    }
}

/** 宿主入口。 */
export function apply(ctx, rawConfig) {
    /**
     * `ctx.get('sessionQuery')` 只在**读素材时**才取（`openAt: never` 的实例在第一次精确
     * 读时才开库，提前摸它没有意义）；取不到就是 null，`service` 档自然降级到 `journal`。
     */
    const getSessionQuery = () => {
        try {
            return typeof ctx.get === 'function' ? (ctx.get('sessionQuery') ?? null) : null;
        } catch {
            return null;
        }
    };
    const runtime = createRuntime(rawConfig, { getSessionQuery });
    const { config } = runtime;

    /**
     * 诊断探针（只读、不花钱、不缓存）：
     *  - `probeLlm`：宿主 `llm` 服务在不在（`missing` / `no-stream` / `ok`）；
     *  - `readDefaultRoute`：宿主设置页的默认模型（`agentDefaultModel`），拿不到就是 null。
     *
     * `/memory-consolidate status` 的「抽取路线」只用这两个真实来源，**绝不猜**。
     */
    runtime.probeLlm = () => {
        try {
            const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
            if (llm === undefined || llm === null) return 'missing';
            return typeof llm.stream === 'function' ? 'ok' : 'no-stream';
        } catch {
            return 'unknown';
        }
    };
    runtime.readDefaultRoute = () => readDefaultModelRoute(ctx);

    /** 页面回写：先校验、再落盘、最后才改运行时 config。任一步失败都抛错。 */
    const changeSetting = async (key, raw) => {
        const value = coerceSetting(key, raw);
        const overrides = readConsolidateOverrides();
        const next = { ...overrides, [key]: value };
        writeConsolidateOverrides(next);
        config[key] = value;
        if (key === 'dailyLlmBudget') {
            // 预算器在创建时就固定了配额；改了就重建（空转状态，重建无副作用）。
            runtime.budget = createBudget({ dailyLlmBudget: config.dailyLlmBudget });
        }
        ctx.logger?.info?.(`[persona-memory-consolidate] 设置已更新：${key} = ${String(value)}`);
    };

    /* ── 命令：所有子命令都在这里，装配到宿主平面 ⇒ 对所有预设可用 ── */
    /**
     * 模型接线（**只在命令执行时**发生）。
     *
     * 为什么不在 `apply()` 里建：`callModel` 只是把 `() => ctx.get('llm')` 存起来，
     * 真正的流要等命令触发；而 `extractor` 里那个 `templates` 槽位要等拿到 store
     * 才有内容。放在这里 ⇒ 插件加载期零副作用、零开销（02 §6.5 规矩 1 的同款理由）。
     */
    const prepare = () => {
        if (typeof runtime.extractor?.extract === 'function') return;
        const callModel = createCallModel({
            getLlm: () => (typeof ctx.get === 'function' ? ctx.get('llm') : undefined),
            config: runtime.config,
            logger: ctx.logger,
            // 0.2.2：超时用可配置值（默认 120s）；`DEFAULT_CALL_TIMEOUT_MS` 只作回退。
            timeoutMs: Number.isFinite(runtime.config.callTimeoutMs) ? runtime.config.callTimeoutMs : DEFAULT_CALL_TIMEOUT_MS,
            // 路线优先级（调用时现读，改了就下一轮生效）：
            //   1. 设置页显式 provider/model（resolveRoute 里 config 优先，这里不重复）；
            //   2. 最近一次真实请求的 route（autotrigger 从 session.requestHeader 记下）；
            //   3. 宿主默认模型（agentDefaultModel）。
            // 以前这一项根本没接 ⇒ 两处都空时 resolveRoute 必回 null，每次抽取都
            // 直接 NO_ROUTE，被上层吞成 `extract-model-error`（本机 25/25 次失败）。
            defaults: () => runtime.lastRoute ?? runtime.readDefaultRoute(),
        });
        runtime.callModel = callModel;
        runtime.extractor = createExtractor({
            callModel,
            // provider / model 一律留给 callModel 在**调用时**解析：设置页改完下一轮就能生效。
            maxChars: runtime.config.maxSampleChars,
            // 目标格式来自主插件 store.templates()，runL1 每次跑前刷新这个槽位。
            templates: () => runtime.templatesCache ?? null,
            // 截断重试（DESIGN §13）：现取，设置页关掉下一轮立刻生效。
            resolveRetryOnTruncate: () => runtime.config.retryOnTruncate !== false,
        });
    };

    const commands = createCommands(runtime, { logger: ctx.logger, prepare });
    ctx.inject(['commands'], (commandCtx) => {
        commandCtx.commands.register({
            definitionId: COMMAND_DEFINITION_ID,
            name: COMMAND_NAME,
            description: COMMAND_DESCRIPTION,
            input: { hint: '[status|dry|run|cross [dry]|rollback <runId|last>]' },
            // handler 是 async：宿主会 `await withAbort(Promise.resolve(handler(invocation)), signal)`。
            handler: (invocation) => commands.handle(invocation),
        });
    });

    /* ── 设置页扩展点 ── */
    registerSettings(ctx, runtime, changeSetting);

    /* ── 自动触发（M2）：`turn/end` 写 L0，门槛到了才花钱 ── */
    /**
     * 实现全在 `lib/autotrigger.js`，`index.js` 只装配：
     *  - `session/event` 的 `turn/end`：同步写一行 L0（零 await、零 LLM），门槛达标才在
     *    微任务里跑 `runL1`；
     *  - `agent/status`（`idle` / `maintenance`）与 `agent/disposed`（≤3s 收尾）只补漏；
     *  - `config.idleScanMinutes` 兜底扫描（定时器**无条件**注册，开关在每个 tick 里读，
     *    修掉 A0「启动时 enabled=false ⇒ 以后打开也没有定时器」的缺陷）。
     *
     * `prepare` 传给自动触发：后台消费也要把真实模型接上（命令之外没有别的接线点）。
     */
    if (AUTO_TRIGGER_READY) {
        // `crossAuto: true`：把 L2（跨会话整理）接进自动调度（0.6.1 C3）。
        // 触发点有两处：L1 消费成功之后、每次兜底扫描；门槛仍由 decideCross 判（24h /
        // 新增 20 条），所以这里只是「允许问」，不是「每轮都跑」。
        const autoTrigger = createAutoTrigger({ runtime, ctx, logger: ctx.logger, prepare, crossAuto: true });
        autoTrigger.start();
        // 监听与定时器都归本插件的作用域：卸载时一起摘掉（绝不留悬挂的 30 分钟定时器）。
        ctx.effect(() => () => autoTrigger.dispose());
        runtime.autoTrigger = autoTrigger;
    }

    const crossVerdict = decideCross({ lastRunAt: runtime.cross.lastRunAt, config, manual: false });
    const mode = resolveMode(config);
    ctx.logger?.info?.(
        `[persona-memory-consolidate] 就绪：暂存 ${runtime.pendingDir}，`
        + `门槛 ${config.minTurns} 轮 / ${config.minChars} 字符，`
        + `档位 ${mode}（${mode === MODE.OBSERVE ? '影子：只写 would-write' : (mode === MODE.OFF ? '完全静默' : (config.dryRun ? '干跑中（不落盘）' : '已放开写入'))}），`
        + `${AUTO_TRIGGER_READY ? `自动触发已接线（兜底扫描 ${config.idleScanMinutes} 分钟）` : '自动触发未接线'}`
        + `，跨会话下次判定：${crossVerdict.reason}`,
    );
}

/** 主插件超时（导出给 M1 接线用，避免两处写死）。 */
export { DEFAULT_CALL_TIMEOUT_MS };
/** 命令解析（纯函数，测试直接用）。 */
export { decodeCommand };
/** `_unassigned` 桶名（与 config 默认值一致）。 */
export const UNASSIGNED_BUCKET = DEFAULT_UNASSIGNED_BUCKET;
