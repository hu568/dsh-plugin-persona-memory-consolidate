/**
 * 宿主半的类型声明。运行时是纯 JavaScript（ESM），这里只给编辑器/调用方看。
 *
 * 包的 `exports` 只暴露入口 `.`（`lib/index.js`），所以这里**只声明入口真正导出
 * 的东西**：插件元信息、`Config`、`apply` 以及装配期会用到的几个工厂函数。
 * `lib/` 下的其余模块（trigger / sampler / merger / writer …）不经包入口导出，
 * 需要时请在同一仓库内直接 `import '../lib/xxx.js'`，不在这里重复声明。
 *
 * 注：`lib/index.js` 没有 `export default`——Cordis 认的是命名导出
 * （`name` / `inject` / `Config` / `apply`），本文件与之保持一致。
 */

import z from 'schemastery';
import type { Context } from 'cordis';

/** Cordis 插件名（与 package.json 的 name 一致）。 */
export declare const name: string;
/** 必需服务：命令注册表（宿主组合里恒在，用于 `/memory-consolidate`）。 */
export declare const inject: string[];

/** 命令名（不带斜杠）。 */
export declare const COMMAND_NAME: string;
/** 稳定定义标识（与每次执行的 commandId 无关）。 */
export declare const COMMAND_DEFINITION_ID: string;
/** discovery 界面里的一句话说明。 */
export declare const COMMAND_DESCRIPTION: string;

/**
 * 自动触发是否已接线。
 *
 * M2 起恒为 `true`：`session/event` 的 `turn/end` 写 L0 + 门槛微任务消费，
 * `agent/status` / `agent/disposed` / 兜底 `setInterval` 只做补漏（`lib/autotrigger.js`）。
 * 翻回 `false` 就退回 M1 的「只有手动命令闭环」。
 */
export declare const AUTO_TRIGGER_READY: boolean;

/** `_unassigned` 桶名（与 `Config.unassignedBucket` 的默认值一致）。 */
export declare const UNASSIGNED_BUCKET: string;

/** 主插件调用超时（毫秒，默认 20000；导出给接线用，避免两处写死）。 */
export declare const DEFAULT_CALL_TIMEOUT_MS: number;

/**
 * 写入范围。
 *
 * schema 里是 `z.string()`（不枚举），但实现只认这两个值，设置页的 `select`
 * 也只给这两项。
 */
export type ConsolidateScope = 'journal' | 'both';

/** 第二层（跨会话整理）的数据源；`auto` 按 服务 → 文件 → JOURNAL 降级。 */
export type CrossSource = 'auto' | 'journal' | 'service' | 'files';

/**
 * 插件配置（键与默认值取自设计文档 02 §8）。
 *
 * 全部键都可以在 `cordis.patch.yml` 里覆盖；其中 16 个还进了设置页
 * （见 `SettingItem`），页面回写只存用户显式改过的键。
 */
export interface Config {
    /** 总开关；关掉即完全静默（L0 也不写）。 */
    enabled: boolean;
    /** 干跑：只出报告不落盘。观察期默认开启。 */
    dryRun: boolean;
    /** `journal` 只写 JOURNAL；`both` 也写 FACT / MEMORY（仍受主插件闸口约束）。 */
    scope: ConsolidateScope;
    /** 消费门槛 · 回合数（与 `minChars` 先到先算）。 */
    minTurns: number;
    /** 消费门槛 · 字符数（与 `minTurns` 先到先算）。 */
    minChars: number;
    /** 单回合结论截断。 */
    perTurnCap: number;
    /** 单次沉淀输入上限（字符）。 */
    maxSampleChars: number;
    /** 暂存/消费/归档按 workspaceId 分桶。 */
    workspaceIsolation: boolean;
    /** 工作区注册表路径；空 = `$DSH_HOME/storages/workspace.json`。 */
    workspaceRegistry: string;
    /** 未分组会话的桶名（`_unassigned` 不产出 project 记忆）。 */
    unassignedBucket: string;
    /** 单桶暂存行数上限。 */
    pendingMaxRows: number;
    /** 暂存最长保留天数（超期丢弃并记 runlog）。 */
    pendingMaxAgeDays: number;
    /** 归档保留天数。 */
    archiveRetentionDays: number;
    /** 兜底扫描间隔（分钟）。 */
    idleScanMinutes: number;
    /** 每日 LLM 调用总量（第一层 50 / 第二层 10 由实现按阶段扣减）。 */
    dailyLlmBudget: number;
    /** 单次沉淀最多几轮。 */
    maxTurnsPerCall: number;
    /** 预留：中断回合是否留 partial（默认关）。 */
    partialKeep: boolean;
    /** LLM provider 覆盖；空 = 沿用会话最近一次 route。 */
    provider: string;
    /** LLM model 覆盖；空 = 沿用会话最近一次 route。 */
    model: string;
    /** 子代理会话是否也沉淀。 */
    subagent: boolean;
    /** 写入前按正则给密钥/手机号/身份证/卡号打码。 */
    redact: boolean;
    /** 第二层（跨会话整理）总开关。 */
    crossEnabled: boolean;
    /** 第二层数据源。 */
    crossSource: CrossSource;
    /** 两次第二层之间的最小间隔（小时）。 */
    crossIntervalHours: number;
    /** 新增素材达到该条数也可触发第二层。 */
    crossMinEntries: number;
    /** 第二层最多扫多少条素材。 */
    crossScanEntries: number;
    /** 同一结论出现 ≥ 该次数才升格为稳定事实。 */
    crossPromoteHits: number;
    /** `files` 档：最多读几个会话。 */
    crossMaxSessions: number;
    /** `files` 档：回溯几天。 */
    crossLookbackDays: number;
}

/** schemastery schema（`Config(rawConfig)` 即补默认值并校验）。 */
export declare const Config: z<Config>;

/* ── 命令 ── */

/** 已知子命令。 */
export type Subcommand = 'status' | 'dry' | 'run' | 'cross' | 'rollback';

/** `/memory-consolidate <原文>` 的解析结果（纯函数产物）。 */
export interface DecodedCommand {
    /** 小写子命令；空输入回落 `'status'`。 */
    subcommand: string;
    args: string[];
    /** 是否在 `['status','dry','run','cross','rollback']` 里。 */
    known: boolean;
    raw: string;
}

/** 解析命令输入（不读盘、不碰 ctx）。 */
export declare function decodeCommand(rawInput?: string): DecodedCommand;

/** 宿主 `CommandDefinition.handler` 只认这两种形状（同步返回）。 */
export interface CommandResult {
    kind: 'success' | 'error';
    text: string;
}

/** 宿主传进来的 invocation。 */
export interface CommandInvocation {
    rawInput?: string;
    agent?: unknown;
}

/** `createCommands()` 的产物：命令表 + 宿主入口。 */
export interface ConsolidateCommands {
    status(): CommandResult;
    dry(): CommandResult;
    run(): CommandResult;
    cross(): CommandResult;
    rollback(args?: string[]): CommandResult;
    handle(invocation?: CommandInvocation): CommandResult;
}

/* ── 运行时装配 ── */

/** 预算判定输入。 */
export interface BudgetInput {
    /** `${workspaceId}:${sessionId}`；给了就做同会话互斥。 */
    sessionKey?: string;
    /** `layer1` = 第一层沉淀，`layer2` = 跨会话整理。 */
    phase?: 'layer1' | 'layer2';
    now?: number;
}

/** `canStart()` / `tryStart()` 的判定结果。 */
export interface BudgetVerdict {
    ok: boolean;
    /** `ok` / `session-busy` / `concurrency-limit` / `cooldown` / `daily-budget` / `phase-budget`。 */
    reason: string;
    retryAt?: number;
    /** 只有 `tryStart()` 成功时才有；必须用 `settle(token, …)` 收尾。 */
    token?: string;
}

/** 预算器诊断快照。 */
export interface BudgetSnapshot {
    /** `YYYY-MM-DD`（本地时区）。 */
    day: string;
    used: { total: number; layer1: number; layer2: number };
    remaining: number;
    failures: number;
    cooldownUntil: number;
    busy: number;
    /** 在跑的调用：`phase:now:序数`。 */
    inflight: string[];
}

/** 进程内预算器（单飞 + 每日配额 + 连续失败退避）。 */
export interface Budget {
    readonly day: string;
    readonly busyCount: number;
    canStart(input?: BudgetInput): BudgetVerdict;
    tryStart(input?: BudgetInput): BudgetVerdict;
    settle(token: string, result?: { ok?: boolean; now?: number }): { failures: number; cooldownUntil: number };
    /**
     * 直接记一次失败（`settle` 之外的入口：自动触发里「连管线的 try/finally 都没跑到」的情况）。
     * 已经 `settle({ok:false})` 过的失败别再调它，否则连续失败会被数两遍。
     */
    noteFailure(now?: number): { failures: number; cooldownUntil: number };
    cooldownUntil(): number;
    snapshot(now?: number): BudgetSnapshot;
}

/** 运行日志写入器（`$DSH_HOME/memory/consolidate/runs.jsonl`）。 */
export interface RunLog {
    path: string;
    rotate(): boolean;
    /** 追加一行（白名单字段 + 打码）；**不抛**，返回是否写成。 */
    append(record: Record<string, unknown>, now?: number): boolean;
}

/** `pending/<workspaceId>/` 的一个桶。 */
export interface PendingBucket {
    workspaceId: string;
    sessions: string[];
}

/** 降级链里一个源被截断后的素材形状。 */
export interface SourceEntry {
    id: string;
    ts: string;
    text: string;
    tags: string[];
}

/** 一个数据源的产出。 */
export interface SourceResult {
    ok: boolean;
    /** `journal` / `service` / `files` / `none`。 */
    source: string;
    entries: SourceEntry[];
    reason: string;
}

/** 按降级链取素材：第一个 `ok:true` 的源赢。 */
export interface SourceChain {
    list(input?: { limit?: number }): Promise<SourceResult & {
        attempts: { source: string; ok: boolean; reason: string }[];
    }>;
}

/** 打码结果。 */
export interface RedactResult {
    text: string;
    hits: string[];
    /** 命中「密文本身」时整条丢。 */
    drop: boolean;
}

/** 校验上下文。 */
export interface ValidateContext {
    cwd?: string;
    workspaceId?: string;
    bucket?: string;
    unassignedBucket?: string;
}

/** 主插件 `./store` 校验后的去向。 */
export interface ValidateVerdict {
    /** `ok` | `journal`（降级）| `drop`。 */
    decision: 'ok' | 'journal' | 'drop';
    reason: string;
    text: string;
    hits: string[];
    entry: { content: string; [key: string]: unknown };
}

/** 条目校验器（打码 + 桶一致性 + 主插件闸口）。 */
export interface Validator {
    redact(text: string): RedactResult;
    validate(scope: string, entry: { content?: string; [key: string]: unknown }, context?: ValidateContext): Promise<ValidateVerdict>;
}

/** 归并后的一条算子（`merger.buildOp()` 的形状）。 */
export interface MergeOp {
    op: 'ADD' | 'UPDATE' | 'NOOP' | 'DELETE';
    /** UPDATE / DELETE 要替换的既有条目 id；其余为空串。 */
    target: string;
    content: string;
    /** `global` → FACT.md；`project` → 项目 MEMORY.md；`journal` → JOURNAL.jsonl。 */
    scope?: 'global' | 'project' | 'journal';
    confidence?: string;
    ts?: number;
    reason?: string;
    /** 1 = 第一层，2 = 第二层。 */
    layer?: 1 | 2;
}

/** 写盘上下文。 */
export interface WriteContext {
    cwd?: string;
    workspaceId?: string;
    dryRun?: boolean;
    layer?: number;
    now?: number;
}

/** 一条算子的执行结果。 */
export interface WriteResult {
    op: string;
    target: string;
    scope: string;
    status: string;
    reason: string;
    content: string;
    [key: string]: unknown;
}

/** 写盘器（撞限只降级 JOURNAL，绝不自己压缩 FACT/MEMORY）。 */
export interface Writer {
    apply(ops: MergeOp[], context?: WriteContext): Promise<{
        results: WriteResult[];
        counts: Record<string, number>;
        watermarks: Record<string, unknown>;
    }>;
}

/** 第二层游标（`cross-cursor.json`）。 */
export interface CrossCursor {
    lastRunAt: number;
    lastCount: number;
    lastRunId: string;
}

/** `createRuntime()` 的产物：config + 所有模块实例。 */
export interface ConsolidateRuntime {
    config: Config;
    runLog: RunLog;
    resolveStore: () => Promise<unknown | null>;
    budget: Budget;
    validator: Validator;
    writer: Writer;
    sources: SourceChain;
    /** `$DSH_HOME/memory/consolidate/cursor.json`。 */
    cursorFile: string;
    /** `$DSH_HOME/memory/consolidate/pending`。 */
    pendingDir: string;
    /** `$DSH_HOME/memory/consolidate/superseded.jsonl`。 */
    supersededFile: string;
    cross: CrossCursor;
}

/** `createRuntime()` 的可注入项（单测用）。 */
export interface CreateRuntimeOptions {
    runLog?: RunLog;
    resolveStore?: () => Promise<unknown | null>;
    budget?: Budget;
    now?: number;
}

/** 造运行时（不碰 ctx）。 */
export declare function createRuntime(rawConfig?: unknown, options?: CreateRuntimeOptions): ConsolidateRuntime;

/* ── 设置页 ── */

/** 宿主设置页支持的控件种类。 */
export type SettingKind = 'toggle' | 'select' | 'text' | 'readonly';

/** `kind=select` 的候选项。 */
export interface SettingOption {
    value: string;
    label: string;
}

/** 注册到主插件「设置 → 记忆」页的一项（id 形如 `consolidate.<key>`）。 */
export interface SettingItem {
    id: string;
    /** 分组标题：「自动沉淀」/「自动沉淀 · 高级」。 */
    group: string;
    title: string;
    description: string;
    kind: SettingKind;
    options?: SettingOption[];
    order: number;
    value: boolean | string | number;
    onChange?(value: boolean | string | number): void | Promise<void>;
}

/**
 * 把设置项注册到主插件的「设置 → 记忆」页。
 *
 * 父插件未装或尚未就绪时静默跳过（沉淀本身照常工作，只是没有页面开关）。
 */
export declare function registerSettings(
    ctx: Context,
    runtime: ConsolidateRuntime,
    onChange: (key: string, raw: unknown) => void | Promise<void>,
): void;

/* ── 路径（数据全部落在 $DSH_HOME/memory/consolidate/ 下） ── */

/** L0 暂存目录：`<home>/memory/consolidate/pending`。 */
export declare function pendingDir(home?: string): string;
/** 快照目录（按 runId 分，回滚用）：`<home>/memory/consolidate/backups`。 */
export declare function backupsDir(home?: string): string;

/** 宿主入口：注册命令、设置项，并装配自动触发（M2）。 */
export declare function apply(ctx: Context, rawConfig: unknown): void;
