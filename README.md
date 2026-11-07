# @dsh-external/dsh-persona-memory-consolidate

`@dsh-external/dsh-persona-memory` 的**附属插件**（写侧）：补上「自动沉淀」——回合结束后
只把对话压成 L0 暂存行（**不花 LLM**），攒够 **6 轮 / 8000 字符**（先到先算）才花一次模型
调用抽成结论式条目，交给主插件 `@dsh-external/dsh-persona-memory/store` 的校验与闸口，
写进 `JOURNAL.jsonl` / `FACT.md` / 项目 `MEMORY.md`。**撞限只降级 JOURNAL，本插件绝不自己
压缩 FACT / MEMORY**；默认直接写盘，需要演练时用 `/memory-consolidate dry`（只出报告），
或用设置页的**运行档位 `observe`**：真跑整条管线，但「写入」换成影子文件。

| | |
|---|---|
| 版本 | `0.1.1`（M5 接线 + **运行档位 off / observe / auto** 与 `would-write` 影子文件） |
| 许可证 | MIT，见 [LICENSE](./LICENSE) |
| 依赖 | peer：`@dsh-external/dsh-persona-memory >=0.7.0 <0.9.0`（只调它的 `./store`）、`cordis >=4.0.0-rc <5` |
| 运行依赖 | `schemastery`（别名安装 `npm:@deepseek-ai/schemastery@3.18.2`） |
| 平面 | **宿主组合**（`cordis.patch.yml` 插一行，`/memory-consolidate` 对所有预设是全局命令） |
| 设置页 | 「设置 → 记忆 → 自动沉淀 / 自动沉淀 · 高级」 |
| 数据落点 | `$DSH_HOME/memory/consolidate/`（**不进项目目录**；项目目录里只有主插件写 `MEMORY.md`） |
| 确定性 | 第一层（L0 采样、门槛判定、预算、打码、校验、写盘）全部纯逻辑 + 单测；只有抽取/裁决两步用 LLM |

## 它补的是哪个缺口

主插件把长期记忆设计成**被动**的：`memory action=append` 靠模型自己想起来写，JOURNAL 只增不缩；
`recall` 附属插件补的是**读侧**（每轮自动召回），但**没人负责把对话沉淀成结论**——
于是 JOURNAL 只会越来越长，`FACT.md` 只能靠人工维护。

本插件补**写侧**，并且刻意做成两段式以控制成本与风险：

```
回合结束（status → idle）
  → L0：把这一轮压成一行 JSONL（`chars` / `consumed` / 正文，字段在 M2 定稿）
        追加进 pending/<workspaceId>/<sessionId>.jsonl
        （纯本地写，< 1ms，不调用模型，不碰主插件）
  → 门槛：未消费回合 ≥ minTurns(6) 或 未消费字符 ≥ minChars(8000)（先到先算）
  → L1：一次 LLM 抽取（结论式条目，最多 8 条）
        → 预筛（BM25 近邻相似度）：完全相同或 ≥0.95 直接 NOOP，<0.45 直接 ADD，中间才裁决
        → 需要裁决的才第二次调用
        → 每条都要过 redact（打码）+ 桶一致性 + 主插件 store 闸口
        → 通过 → FACT / MEMORY；撞限或主体对不上 → **降级 JOURNAL**
  → 游标只在成功后推进（崩溃语义：重跑而不是漏沉淀）
```

三条硬规矩（写在代码注释里，也用测试钉住）：

1. **不订阅 `agent/pre-step`** —— 沉淀绝不允许拖慢用户请求（`wiring.test.mjs` 断言监听表里没有 `pre-step`）；
2. **中断回合直接丢**（默认 `partialKeep: false`）；
3. **单飞 + 全局并发 1** + 每日预算 `dailyLlmBudget`（默认 60，第一层 50 / 第二层 10）。

## 现状（M2）：哪些是真的，哪些还没接线

诚实优先、绝不假装成功（下表仍在收 M1 的尾巴，M2 只改了「自动触发」这一行）：

| 能力 | 状态 |
|---|---|
| 采样 / 门槛 / 游标 / 预算 / 打码 / 校验 / 归并 / 写盘 / 降级 / runlog / 跨会话计划 | ✅ 代码 + 单测就位 |
| `/memory-consolidate status` / `dry` | ✅ **真读盘**：桶数、会话数、未消费行数、字符数、预算、跨会话判定 |
| 自动触发（M2） | ✅ `session/event` 的 `turn/end` → 同步写一行 L0 → 门槛达标在**微任务**里跑 `runL1`；`agent/status`（`idle`/`maintenance`）补漏、`agent/disposed` ≤3s 收尾、`idleScanMinutes` 兜底扫描 + 过期清理（`lib/autotrigger.js`） |
| `/memory-consolidate run` / `rollback` | ✅ 真读暂存、真调 LLM、真经 store 写盘、能按 runId 回滚（M1） |
| `/memory-consolidate cross` | ❌ 明确返回 `kind:'error'` +「未接线，等 M4」，**不假装跑过** |
| 设置页分组与回写 | ✅ 已注册（父插件在时） |

`lib/milestone.js` 的 `AUTO_TRIGGER_READY` 仍是**唯一**总闸：翻回 `false` 就退回「只交付手动命令闭环」
（事件与定时器都不再注册），`enable: false` 则是运行期开关（每个事件/每个 tick 现读）。

## 安装

插件直接从 Git 仓库安装，**不需要打 tgz**：

```powershell
# 插件管理器（创造模式）：
#   plugin_manager action=install_bundle target="github:hu568/dsh-plugin-persona-memory-consolidate"
# 或命令行（桌面端请用插件管理器或「设置 → 插件」）：
dsh plugin --profile <profile> add github:hu568/dsh-plugin-persona-memory-consolidate
dsh --profile <profile> --dump-config   # 验证：应出现本包的层与 persona-memory-consolidate 行

# 卸载
dsh plugin --profile <profile> remove @dsh-external/dsh-persona-memory-consolidate
```

**为什么必须重启**：这句话只针对**改源码**——改的是 `lib/*.js`，DSH 不监听 `node_modules`，且 ESM 有加载缓存；
只有 `cordis.patch.yml` 有可能热生效。**装包**不需要重启：`dsh plugin add` 写进 profile 的
`dsh.profile.bundles` 后，运行中的引擎经 HMR 重载该层（父插件 README「装完不用重启，改源码才要重启」，
DSH `0.2.2-rc.1` 实测）。pnpm 报的 `cordis` peer 缺失可忽略，运行时不解析它。
卸载不会删除 `$DSH_HOME/memory/consolidate/`。

**装它之前先装主插件 0.7.0+**：本插件不 import 主插件本体，只 `import('@dsh-external/dsh-persona-memory/store')`。
未装时插件**仍能加载**、命令仍可查状态，但写入阶段一律判 `store-unavailable`（丢，不假装成功）。

## 命令：`/memory-consolidate`

装配在**宿主平面**，所以对所有预设都是全局命令。宿主里的用法提示与 `lib/command.js` 的
`USAGE` 一致：

```
用法：/memory-consolidate [status|dry|run|cross|rollback <runId|last>]
```

| 子命令 | 状态 | 干什么 |
|---|---|---|
| （不带参数） | ✅ | 等同 `status` |
| `status` | ✅ | 真读盘报告：开关/干跑、暂存目录、桶数/会话数/未消费行数/字符数、消费门槛、今日 LLM 调用、跨会话判定、**自动触发是否已接线** |
| `dry` | ✅ | 干跑：打印管线就位状态 + `status` 全量报告（A0 不产生报告正文） |
| `run` | ❌ | 立即沉淀第一层（L1）——**未接线**，等 M1/M2，返回错误并说明缺哪一段 |
| `cross` | ❌ | 跨会话整理（L2）——**未接线**，等 M4；但会先跑一次触发判定并把 `reason` 回显（手动触发绕过时间/数量门槛） |
| `rollback <runId\|last>` | ❌ | 按 runId 回滚——**未接线**，等 M4；快照目录 `<数据目录>/backups/<runId>/`，保留 10 份。不带 runId 直接报用法错误 |

命令解析是纯函数（`lib/command.js`）：大小写不敏感、多余空白忽略、未知子命令回用法提示，
处理器**同步**返回 `{kind:'success'|'error', text}`（宿主 `CommandDefinition.handler` 的合同），
异常一律在处理器内兜住，绝不穿透到宿主。

## 配置

`cordis.patch.yml` 里那一行就是默认值，**30 个键全部与 `Config` schema 一致**
（`test/wiring.test.mjs` 逐个比对默认值）：

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | 总开关；只在 `auto` 档生效（`off` / `observe` 档以档位为准） |
| `mode` | `'auto'` | 运行档位：`off`（完全静默，等价 `enabled=false`）/ `observe`（影子：真跑管线但只写 would-write）/ `auto`（正式写入） |
| `dryRun` | `false` | 干跑：只出报告不落盘。默认关闭；一次性演练用 `/memory-consolidate dry` |
| `scope` | `'both'` | `journal` = 只写 JOURNAL；`both` = JOURNAL + FACT/MEMORY |
| `minTurns` | `6` | 消费门槛 · 回合数（与 `minChars` 先到先算） |
| `minChars` | `8000` | 消费门槛 · 字符数 |
| `perTurnCap` | `1200` | 单回合结论截断 |
| `maxSampleChars` | `8000` | 单次沉淀输入上限（字符） |
| `workspaceIsolation` | `true` | 暂存/消费/归档按 `workspaceId` 分桶 |
| `workspaceRegistry` | `''` | 空 = `$DSH_HOME/storages/workspace.json` |
| `unassignedBucket` | `'_unassigned'` | 未分组会话的桶名（该桶不产出 project 记忆） |
| `pendingMaxRows` | `200` | 单桶暂存行数上限 |
| `pendingMaxAgeDays` | `30` | 暂存最长保留天数（超期丢弃并记 runlog） |
| `archiveRetentionDays` | `90` | 归档保留天数 |
| `idleScanMinutes` | `30` | 兜底扫描间隔（分钟） |
| `dailyLlmBudget` | `60` | 每日 LLM 调用总量（第一层 50 / 第二层 10 按阶段扣减） |
| `maxTurnsPerCall` | `6` | 单次沉淀最多几轮 |
| `partialKeep` | `false` | 预留：中断回合是否留 partial |
| `provider` | `''` | LLM provider 覆盖；空 = 沿用会话最近一次 route |
| `model` | `''` | LLM model 覆盖；空 = 沿用会话最近一次 route |
| `subagent` | `false` | 子代理会话是否也沉淀 |
| `redact` | `true` | 写入前按正则给密钥/手机号/身份证/卡号打码 |
| `crossEnabled` | `true` | 第二层（跨会话整理）总开关 |
| `crossSource` | `'auto'` | `auto` \| `journal` \| `service` \| `files`；`auto` 按「服务 → 文件 → JOURNAL」降级，最后一定落到 JOURNAL |
| `crossIntervalHours` | `24` | 两次第二层之间的最小间隔 |
| `crossMinEntries` | `20` | 新增素材达到该条数也可触发（与间隔「或」关系） |
| `crossScanEntries` | `200` | 第二层最多扫多少条素材 |
| `crossPromoteHits` | `2` | 同一结论出现 ≥ 该次数才升格为稳定事实 |
| `crossMaxSessions` | `20` | 仅 `files` 档：最多读几个会话 |
| `crossLookbackDays` | `7` | 仅 `files` 档：回溯几天 |

覆盖例（只写要改的键）：

```yaml
- insert:
    - id: persona-memory-consolidate
      name: '@dsh-external/dsh-persona-memory-consolidate'
      config:
        minTurns: 10
        crossSource: journal
```

## 设置页：记忆 → 自动沉淀

父插件在「设置 → 记忆」页留了扩展点，本插件用 `ctx.personaMemory.settings.register()`
注册声明式设置项（页面只渲染与回写，值存哪里由本插件决定）。两组、18 项：
主组一眼看到是否开启，高级组在超过 3 项时按页面折叠规则默认收起。

| id | 分组 | 控件 | 默认 | 说明 |
|---|---|---|---|---|
| `consolidate.mode` | 自动沉淀 | 选择 | `auto` | 运行档位：`auto` 正式写入 / `observe` 影子（只写 would-write）/ `off` 完全静默。显式 `off` / `observe` 压过下面的开关，`auto` 才跟随它 |
| `consolidate.enabled` | 自动沉淀 | 开关 | 开 | 回合结束只写 L0；攒够门槛才花一次 LLM（只在 `auto` 档生效） |
| `consolidate.crossEnabled` | 自动沉淀 | 开关 | 开 | 跨会话整理 |
| `consolidate.crossSource` | 自动沉淀 | 选择 | `auto` | 自动 / JOURNAL / 会话检索服务 / 会话文件 |
| `consolidate.scope` | 自动沉淀 | 选择 | `both` | JOURNAL + FACT/MEMORY / 只写 JOURNAL |
| `consolidate.minTurns` | 高级 | 文本 | `6` | 消费门槛 · 回合数（≥1，整数） |
| `consolidate.minChars` | 高级 | 文本 | `8000` | 消费门槛 · 字符数（≥100，整数） |
| `consolidate.perTurnCap` | 高级 | 文本 | `1200` | 单回合截断（≥100，整数） |
| `consolidate.maxSampleChars` | 高级 | 文本 | `8000` | 单次输入上限（≥500，整数） |
| `consolidate.dailyLlmBudget` | 高级 | 文本 | `60` | 每日调用上限（≥1，整数；改了立即重建预算器） |
| `consolidate.subagent` | 高级 | 开关 | 关 | 子代理也沉淀 |
| `consolidate.redact` | 高级 | 开关 | 开 | 敏感串打码 |
| `consolidate.pendingMaxAgeDays` | 高级 | 文本 | `30` | 暂存最长保留天数（≥1，整数） |
| `consolidate.idleScanMinutes` | 高级 | 文本 | `30` | 兜底扫描间隔（≥1，整数） |
| `consolidate.provider` | 高级 | 文本 | 空 | provider 覆盖（留空 = 沿用会话 route） |
| `consolidate.model` | 高级 | 文本 | 空 | model 覆盖（留空 = 沿用会话 route） |
| `consolidate.pendingDir` | 自动沉淀 | 只读 | — | 当前暂存目录（不进项目目录） |
| `consolidate.cursorFile` | 自动沉淀 | 只读 | — | 当前游标文件 |

- 回写只存**用户显式改过**的键，落在 `$DSH_HOME/memory/consolidate/settings.json`；
  没设过的键仍取 `cordis.patch.yml` 的 config，删掉文件即恢复组合默认值。
- 覆盖层优先，坏文件 / 坏值一律当「没设过」（一次手改不该让插件炸掉）。
- 非法值（非数字、小数、越界、select 不在候选项里）**直接抛错**：页面保留旧值并显示原因，
  不会出现「页面显示一个数、实际生效另一个数」。
- `ctx.get('personaMemory')` 拿不到服务时走 `ctx.inject(['personaMemory'], …)` 等它就绪后补注册；
  两者都没有时静默跳过 —— 沉淀本身照常工作，只是没有页面开关。卸载时 `ctx.effect` 撤掉全部项。

## 数据落点：`$DSH_HOME/memory/consolidate/`

（`$DSH_HOME` 缺失时回落 `~/.dsh`，与主插件同口径。**全部数据在这里，不进项目目录**。）

| 路径 | 是什么 |
|---|---|
| `pending/<workspaceId>/<sessionId>.jsonl` | L0 暂存：一行一回合（JSONL）。`status` 依赖两个字段：`chars`（计入未消费字符数）与 `consumed`（`true` 即跳过）；完整字段在 M2 写入接线时定稿 |
| `pending/archive/` | 归档桶：`listPendingBuckets()` 明确跳过它，不算工作区桶 |
| `cursor.json` | 消费游标，按 `${workspaceId}:${sessionId}` 记 `{turn, at, chars}`，**只单调前进**，只在 L1 成功后推进 |
| `runs.jsonl` | 运行日志：一行一次运行/阶段，字段白名单 + 打码，条目正文一个字都不进；4 MB 滚动、保留 3 份（`.1` / `.2`） |
| `superseded.jsonl` | 被覆盖的旧值，只审计、不进任何检索 |
| `would-write/<yyyy-mm-dd>.jsonl` | **影子模式专用**：一行一个「本来会写什么」的算子，含正文与预算预判；按天分文件。`observe` 档不写 FACT / MEMORY / JOURNAL，只写它 |
| `backups/<runId>/` | 按 runId 分的快照（回滚用，保留 10 份） |
| `cross-cursor.json` | 第二层游标 `{lastRunAt, lastCount, lastRunId}` |
| `settings.json` | 设置页覆盖层（只存显式改过的键） |

读盘纪律：游标 / 跨会话游标 / 设置覆盖层**读坏文件一律当空**，绝不抛——一次手改或半截 rename
不该让沉淀整个停摆。所有 JSON 写入都是「临时文件 + rename」的原子替换。

## 硬边界：绝不压缩，只降级

| 边界 | 实现 |
|---|---|
| **不压缩 FACT / MEMORY** | 本插件只产出「新增 / 替换 / 删除某一条」的算子，交主插件 `store` 执行。主插件回「超限」时本插件**不做任何合并、截断、改写**，而是把该条**降级成 JOURNAL 追加**（`decision='journal'` → `store.appendJournal`），并在 runlog 记 `DEMOTED` |
| **唯一写入通道是主插件** | 自己不 `fs` 写 FACT.md / MEMORY.md / JOURNAL.jsonl；条目模板、校验、闸口、备份、原子写、锁全部在主插件 0.7.0 的 `./store` |
| **主插件缺失就认输** | store 解析不到 ⇒ 全部算子 `store-unavailable`（丢弃 + 记原因），**不假装成功** |
| **拿不准就不写正式记忆** | 模型裁决 JSON 非法 ⇒ 整次放弃不重试；`UPDATE` 的 target 不在候选集 ⇒ 降级 `ADD`；`DELETE` 只在第二层允许，第一层降级 `NOOP` |
| **正文不上日志** | runlog 只留结构化摘要（counts / reason / watermarks），字符串统一过 `redact()` 再落盘 |
| **不在请求路径上工作** | 不订阅 `agent/pre-step`；事件处理器只空转；单飞 + 全局并发 1 |

`/memory-consolidate dry`（或配置 `dryRun: true`）时：管线照跑（采样、门槛、预算、抽取、
裁决、校验都执行），但 writer 对每条只记 `DRY`（`would-journal` / `would-add` / `would-demote`），
**任何文件都不改**。默认是直接写盘；想先看结论质量，就跑一次 `dry`。

### 影子模式（`mode: observe`）：真跑管线，只把「本来会写什么」落盘

`dry` 是**一次性**的、且报告里看不到正文；想在切 `auto` 之前攒一份可翻看的证据，用档位
`observe`：

- 管线**一个字都不省**：真采样、真门槛、真调 LLM、真打码、真校验，`store.assertEntry`
  闸口预演也真跑 —— 所以「本来会撞限」「本来会被模板拒掉」都能提前看到；
- 但 `insertEntry` / `replaceEntry` / `deleteEntry` / `appendJournal` / `supersedeJournal`
  **一个都不调**，FACT.md / MEMORY.md / JOURNAL.jsonl 的 SHA256 不变；
- 结果逐算子写进 `would-write/<yyyy-mm-dd>.jsonl`：

```json
{"ts":1800000000000,"runId":"run-…","workspaceId":"ws-1","layer":1,"scope":"global",
 "storeScope":"fact","op":"ADD","target":"","content":"依赖用 tarball 装","status":"would-written",
 "reason":"ok","confidence":"high","budget":{"scope":"fact","known":true,"authoritative":true,
 "lines":45,"chars":4261,"bytes":4261,"limit":{"lines":100,"bytes":8000},"predictedLines":46,
 "predictedChars":4280,"predictedBytes":4280,"exceeded":false,"reason":"ok"}}
```

  `status` 取值：`would-written` / `would-replaced` / `would-deleted` / `would-journal` /
  `would-demoted`（撞限或模板判降级）/ `would-dropped` / `would-noop` / `would-failed`。
  UPDATE / DELETE 没有可预演的只读接口，`reason` 记 `unverified`（预算只是水位预判）。
- runlog 记 `status: OBSERVED`，**不进**「近 7 天」的成功率 / NOOP 比例 / 字符数 / 降级数，
  单独显示成「影子 N 次（本来会写 M 条）」；
- **触发与内部记账和 `auto` 完全一致**：`decideConsume` 门槛、兜底扫描、跨会话日跑都照跑，
  LLM 花销 ≈ `auto`；暂存行照常 `markConsumed` + 归档、L1 游标与 L2 跨会话游标照常推进；
- **只有「写入」被替换成 would-write**：`insertEntry` / `replaceEntry` / `deleteEntry` /
  `appendJournal` / `supersedeJournal` 一个都不调；`supersedeJournal` 只能记成预览条数
  （真调就是写 JOURNAL 了）；
- 唯一额外不做的副作用是**记忆文件写前快照**：没写记忆文件，建了只会堆垃圾、也没得回滚；
- `/memory-consolidate dry` 仍然优先于档位（只出报告，不写影子文件）。

#### 已知取舍：观察期消费的素材，切到 `auto` 后不会补写

影子档的记账与 `auto` 一致，所以同一批暂存行在观察期就被消费/归档、游标也推到了最新。
切到 `auto` 时，那些回合**不会**被重新抽取写进 FACT —— 这是有意的：

- 不这样做的代价更糟：同一批素材每天被反复采样、反复烧 LLM；切档那一刻还会把观察期攒下的
  陈旧结论一次性灌进 FACT（backlog 炸弹）；
- 想「补写」就先 `/memory-consolidate dry`（或 `cross dry`）看一眼结论质量，再决定要不要手工
  重跑；`dry` 不消费、不推游标，适合当「切 auto 之前的最后一道预览」。
- 同理，L2 在影子里「本来会失效」的旧 JOURNAL 条目，因游标已推进，切 `auto` 后也不会补失效。

`off` 档等价于 `enabled=false`：L0 不写、兜底扫描空转、手动 `run` / `cross` 会明确拒绝
（只读的 `status` / `dry` 仍可用）。

## 回滚 / 卸载

**回滚某次运行**（M4 接线后）：

```
/memory-consolidate rollback <runId>
/memory-consolidate rollback last
```

快照在 `$DSH_HOME/memory/consolidate/backups/<runId>/`（保留 10 份），runlog 里能查到每次运行的 runId。
**A0 阶段该命令明确返回「未接线」**，没有快照可回——不会假装回滚成功。

**卸载**：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
<应用自带 pnpm> remove @dsh-external/dsh-persona-memory-consolidate
# 从 profile package.json 的 dsh.profile.bundles 里去掉本包，然后重启 DSH
```

- 卸载**不删除** `$DSH_HOME/memory/consolidate/`，也不影响主插件、`FACT.md`、`JOURNAL.jsonl`；
- 想彻底清干净，手动删 `$DSH_HOME/memory/consolidate/` 整个目录即可（下一轮不会有残留状态）；
- 已经写进 FACT / MEMORY / JOURNAL 的条目**不会**被卸载回滚（要撤就手改，或用主插件的 `memory action=update`）。

## 回归测试

```powershell
# 仓库根：21 步 = 1 次 lib/*.js 语法检查 + 20 组单测
pwsh -File test/run-all.ps1

# 也可以单独跑
node test/trigger.test.mjs      # L0/消费门槛、中断回合、子代理、总开关
node test/sampler.test.mjs      # 逐轮窗口、逐回合截断、图片占位、最小字符
node test/cursor.test.mjs       # 双键游标、只前进、坏文件回落空游标、原子写
node test/budget.test.mjs       # 单飞/并发 1/日配额/阶段配额/退避/withTimeout
node test/redact.test.mjs       # 密钥/手机号/身份证/卡号打码与 drop
node test/bm25-parity.test.mjs  # 与 recall 真实实现逐位一致（11 条语料 / 8 条查询）
node test/merger.test.mjs       # 预筛阈值、sanitizeOps 降级、冲突规则
node test/extractor.test.mjs    # 提示词构造、JSON 解析、候选归一
node test/writer.test.mjs       # 降级 JOURNAL、dryRun、store 缺失、水位、observe 影子（SHA256 不变 + would-write 正文 + 落盘失败记 FAIL）
node test/settings.test.mjs     # 数字/字符串项回写、mode 白名单与优先级、覆盖层坏值
node test/sources.test.mjs      # 三档数据源与降级链、pending 桶列举
node test/runlog.test.mjs       # 字段白名单、打码、滚动、影子运行不进真实写入统计
node test/autotrigger.test.mjs  # M2：turn/end 写 L0、门槛微任务消费、状态兜底、销毁收尾、兜底扫描、退避、observe 与 auto 同口径触发
node test/pipeline.test.mjs     # L1 闭环：happy path、撞限降级、快照回滚、observe（SHA256 不变 + 记账与 auto 一致）
node test/crosssession.test.mjs # L2：升格 / 只交 id 失效 / 逐桶 / 预算 / observe（不写盘但推游标，would-write 有 layer 2 行）
node test/wiring.test.mjs       # 插件形状、Config 默认值、命令路由、设置项、turn/end 真的写 L0
```

不需要 Harness、不需要 profile：全部用例是纯 node，每个用例自带临时 `DSH_HOME`，
**绝不会写到真实的 `~/.dsh/memory`**。`wiring.test.mjs` 需要 `schemastery`（装配后由 profile 提供），
本机没有时退化成对 `lib/*.js` 逐个 `node --check` 并打印 **SKIP**（不算失败，也绝不假装通过）；
`bm25-parity.test.mjs` 需要兄弟仓库 `dsh-plugin-persona-memory-recall` 的源码，装进 profile 后同样打印 SKIP。

## 已知边界（M2）

- **自动触发已接线，但只写 L0 与「门槛达标才跑一次」**：`turn/end` 写进 pending 是纯本地追加；
  真正的抽取要等未消费回合 ≥ `minTurns` 或字符 ≥ `minChars`。门槛没到之前，pending 会一直攒着。
- **`dryRun` 不拦 L0**：干跑管的是「写不写记忆文件（FACT / MEMORY / JOURNAL）」，pending 是本插件
  自己的暂存区；要连 L0 都不写就关 `enabled`。
- **没有正文的回合也推进游标**：`completed` 但取不到正文（纯工具回合）不写行，但游标照样前进，
  否则兜底路径每 30 分钟会重试同一个回合。中断回合（`aborted` / `error` / `max-tokens`）连游标都不动。
- **`agent/status` 只补漏**：`turnBoundary.lastTurn`（读不到就数 `turn/end`）比游标大，才补写漏掉的回合；
  `running` 一律不碰。`maintenance` 按 idle 处理，但写入靠「行已存在」去重，不会写第二份。
- **`agent/disposed` 的收尾是「最多等 3s」**：超时就放弃（行留在 pending，下次兜底扫描还能捡），
  因为宿主不会等插件。
- **`status` 的统计是「尾部抽样」**：每个 pending 文件最多数最后 5000 行，防止有人在 pending 里塞巨型文件把命令卡住。
- **跨会话 `service` / `files` 两档只是适配器形状**：`ctx.sessionQuery` 实测被 `isolate` 锁在组内，
  会话文件是宿主私有格式，解析器留给 M4；两档拿不到就按降级链退到 JOURNAL。
- **JOURNAL 只能看到本插件写进去的摘要**：第二层的频次升格因此只对本插件写过的结论有效，
  不覆盖用户手工 `memory action=append` 的历史正文。
- **日预算在内存里**：重启后从 0 重算（不跨重启精确），换来的好处是磁盘上一个小计数器写坏也不会把沉淀锁死。

## 仓库结构

| 路径 | 角色 |
|------|------|
| `lib/index.js` | 宿主入口：`Config`、`createRuntime`、命令注册、设置页注册、自动触发装配 |
| `lib/autotrigger.js` | **M2 自动触发**：`turn/end` 写 L0 + 门槛微任务消费 + 状态/销毁/定时兜底 |
| `lib/command.js` | `/memory-consolidate <子命令>` 的纯解析 + 用法文案 |
| `lib/commands.js` | 命令处理器（`status`/`dry` 真读盘；其余诚实报未接线）+ `scanPending` |
| `lib/trigger.js` | L0 写入与消费门槛判定（纯函数） |
| `lib/sampler.js` | 逐轮窗口与逐回合采样（截断、图片占位、最小字符） |
| `lib/cursor.js` | 路径、游标读写（坏文件当空）、原子写 JSON |
| `lib/budget.js` | 单飞 + 并发 1 + 日配额 + 退避 + `withTimeout` |
| `lib/validate.js` | 打码、桶一致性、主插件 store 懒解析与闸口封装 |
| `lib/writer.js` | 算子执行：写 FACT/MEMORY 或**降级 JOURNAL**；`dryRun` 只记 DRY；`observe` 只写 `would-write/`（含闸口预演与预算预判） |
| `lib/mode.js` | 运行档位 `off` / `observe` / `auto` 的唯一口径（含与 `enabled` 的优先级） |
| `lib/extractor.js` | 抽取/裁决提示词与模型 JSON 解析 |
| `lib/merger.js` | 预筛（BM25 近邻）、算子校验、冲突规则 |
| `lib/sources.js` | 第二层三档数据源 + 降级链 + pending 桶列举 |
| `lib/crosssession.js` | 第二层触发判定、频次升格、逐桶计划 |
| `lib/runlog.js` | `runs.jsonl` 写入（字段白名单 + 打码 + 滚动）、7 天汇总、影子文件路径 |
| `lib/settings.js` | 设置页声明式设置项 + 覆盖层持久化与校验 |
| `lib/milestone.js` | `AUTO_TRIGGER_READY` / `MILESTONE` 里程碑开关（断开 `index ⇄ commands` 循环 import） |
| `lib/tokenize.js` / `lib/bm25.js` | 分词与 BM25（与 recall 实现逐位一致） |
| `lib/types/index.d.ts` | 类型声明（只声明包入口真正导出的东西） |
| `cordis.patch.yml` | 组合包层：把 `persona-memory-consolidate` 一行插进宿主组合 |
| `test/*.test.mjs` | 20 组回归测试 + `run-all.ps1` |

`lib/` 下的 JS **就是源码**，纯 ESM，无构建链。

## 协议

MIT License，全文见 [LICENSE](./LICENSE)。
