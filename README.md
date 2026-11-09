# @dsh-external/dsh-persona-memory-consolidate

`@dsh-external/dsh-persona-memory` 的**附属插件**（写侧）：补上「自动沉淀」——回合结束后
只把对话压成 L0 暂存行（**不花 LLM**），攒够 **6 轮 / 8000 字符**（先到先算）才花一次模型
调用抽成结论式条目，先过**确定性写入闸口**（`lib/gate.js`），再交给主插件
`@dsh-external/dsh-persona-memory/store` 的校验与闸口，写进 `JOURNAL.jsonl` / `FACT.md` / 项目
`MEMORY.md`。**撞限只降级 JOURNAL，本插件绝不自己压缩 FACT / MEMORY**；默认直接写盘，需要演练时用
`/memory-consolidate dry`（只出报告），或用设置页的**运行档位 `observe`**：真跑整条管线，
但「写入」换成影子文件。

| | |
|---|---|
| 版本 | `0.4.0`（0.4.0：结论/细节分层 + 重要性、截断重试、访问回写；0.3.2：沉淀调用降推理等级 + 截断抢救 + 助手元描述闸口；0.3.1：设置页补上 `maxOutputTokens`；0.3.0：跨池近重复预筛、UPDATE 两段式失效、runlog 水位上限修复） |
| 许可证 | MIT，见 [LICENSE](./LICENSE) |
| 依赖 | peer：`@dsh-external/dsh-persona-memory >=0.7.0 <0.12.0`（只调它的 `./store`）、`cordis >=4.0.0-rc <5` |
| 运行依赖 | `schemastery`（别名安装 `npm:@deepseek-ai/schemastery@3.18.2`） |
| 平面 | **宿主组合**（`cordis.patch.yml` 插一行，`/memory-consolidate` 对所有预设是全局命令） |
| 设置页 | 「设置 → 记忆 → 自动沉淀 / 自动沉淀 · 高级」 |
| 数据落点 | `$DSH_HOME/memory/consolidate/`（**不进项目目录**；项目目录里只有主插件写 `MEMORY.md`） |
| 确定性 | 第一层（L0 采样、门槛判定、预算、打码、**闸口**、校验、写盘）全部纯逻辑 + 单测；只有抽取/裁决两步用 LLM |

## 它补的是哪个缺口

主插件把长期记忆设计成**被动**的：`memory action=append` 靠模型自己想起来写，JOURNAL 只增不缩；
`recall` 附属插件补的是**读侧**（每轮自动召回），但**没人负责把对话沉淀成结论**——
于是 JOURNAL 只会越来越长，`FACT.md` 只能靠人工维护。

本插件补**写侧**，并且刻意做成两段式以控制成本与风险：

```
回合结束（status → idle）
  → L0：把这一轮压成一行 JSONL（`chars` / `consumed` / 正文）
        追加进 pending/<workspaceId>/<sessionId>.jsonl
        （纯本地写，< 1ms，不调用模型，不碰主插件）
  → 门槛：未消费回合 ≥ minTurns(6) 或 未消费字符 ≥ minChars(8000)（先到先算）
  → L1：一次 LLM 抽取（结论式条目，最多 8 条）
        → **确定性闸口**（gate）：空壳/占位、过程叙述、<8 字、同批重复、状态断言缺时点、
          「助手能/不能做什么」这类服务边界（0.3.2） → 丢
        → **结论/细节分层**（0.4.0）：kind=detail 或 importance≤2 → **改判 scope=journal**（不丢弃）
        → **跨池近重复预筛**（0.3.0）：与 FACT+MEMORY 条目池比对，exact / ≥0.95 → 丢；其余放行
        → 预筛（BM25 近邻相似度）：完全相同或 ≥0.95 直接 NOOP，<0.45 直接 ADD，中间才裁决
        → 需要裁决的才第二次调用
        → 每条都要过 redact（打码）+ 桶一致性 + 主插件 store 闸口
        → 通过 → FACT / MEMORY；撞限或主体对不上 → **降级 JOURNAL**
        → store 明确 `demoted:'drop'` ⇒ 记 FAILED（一个字没写）；`demoted:'journal'` ⇒ 补写 JOURNAL
  → 游标只在成功后推进（崩溃语义：重跑而不是漏沉淀）
  → L2（跨会话，日跑）：频次只按真实素材数，项目专属结论不再双写 global
```

三条硬规矩（写在代码注释里，也用测试钉住）：

1. **不订阅 `agent/pre-step`** —— 沉淀绝不允许拖慢用户请求（`wiring.test.mjs` 断言监听表里没有 `pre-step`）；
2. **中断回合直接丢**（默认 `partialKeep: false`）；
3. **单飞 + 全局并发 1** + 每日预算 `dailyLlmBudget`（默认 60，第一层 50 / 第二层 10）。

## 现状（0.4.0）：哪些是真的

下表只写**已经接线并有测试**的能力；没接线的会明确标出来，不假装成功。

| 能力 | 状态 |
|---|---|
| 采样 / 门槛 / 游标 / 预算 / 打码 / 校验 / 归并 / 写盘 / 降级 / runlog / 跨会话计划 | ✅ 代码 + 单测就位 |
| **确定性写入闸口**（`lib/gate.js`） | ✅ 抽取结果落盘前过滤空壳 / 过程叙述 / 太短 / 同批重复 / 缺时点 / 助手元描述（0.3.2）；丢了几条按原因进 runlog `gate` 与命令报告 |
| **沉淀调用降推理等级**（0.3.2） | ✅ 默认 `reasoningEffort: low`（宿主默认是 `high`，思考会吃光 `maxOutputTokens`）；按模型 `reasoning.efforts` 自动降级，非推理模型一个键都不传 |
| **截断抢救**（0.3.2） | ✅ `max-tokens` 时把已收到的正文按**元素边界**补括号解析：完整的那几条照样写入、半条绝不写；救回来的那次 runlog `detail` 记 `salvage:max-tokens` |
| **截断重试**（0.4.0） | ✅ 抢救不回来时**同 prompt 再调一次**，并请调用侧把推理等级压到模型支持的最低档（`overrides.reasoningEffort`，`llm.js` 按 `model.reasoning.efforts` 校验，绝不盲传）；成功记 `retry:max-tokens`，仍失败按原逻辑 FAIL；开关 `retryOnTruncate`（默认开） |
| **结论/细节分层 + 重要性**（0.4.0） | ✅ 抽取输出带 `kind` / `importance`；`routeByGranularity()` 把 `kind=detail` 或 `importance≤2` 的候选**改判** `scope=journal`（不丢弃）；`importance` 1–5 映射成 20/35/50/70/90 交给主插件侧车索引；runlog 记 `layers:{conclusion,detail,rerouted}` |
| **访问回写**（0.4.0） | ✅ `NOOP`（有 target）与成功的 `UPDATE` 调 `store.touchEntries([{scope,id}])`（只写索引）；`typeof` 探测主插件有没有这个 API，没有就跳过、失败静默，绝不把本轮判 FAIL |
| **跨池近重复预筛**（`screenCrossPool`） | ✅ 0.3.0：归并前与 FACT+MEMORY 条目池比对，只拦 `exact` / `near-duplicate`（≥0.95），`ADJUDICATE` 放行；池空或异常放行，`near-duplicate` 进 runlog `gate` |
| **UPDATE 两段式失效** | ✅ 0.3.0：先写新条目，成功后才给旧条目标 `superseded`（`by` = 新条目 contentId）；任一步失败回退 `replaceEntry` |
| **runlog 水位上限** | ✅ 0.3.0：`watermarks.*.limit` 按 `{lines,bytes,chars}` 对象形状透传，不再恒 0 |
| `/memory-consolidate status` / `dry` | ✅ **真读盘**：桶数、会话数、未消费行数、字符数、预算、跨会话判定、**抽取路线**、**上次失败**、分桶分裂告警 |
| 自动触发 | ✅ `session/event` 的 `turn/end` → 同步写一行 L0 → 门槛达标在**微任务**里跑 `runL1`；`agent/status`（`idle`/`maintenance`）补漏、`agent/disposed` ≤3s 收尾、`idleScanMinutes` 兜底扫描 + 过期清理（`lib/autotrigger.js`） |
| `/memory-consolidate run` / `rollback` | ✅ 真读暂存、真调 LLM、真经 store 写盘、能按 runId 回滚 |
| `/memory-consolidate cross [dry]` | ✅ L2 全套（跨桶一遍 + 逐桶一遍）；升格只认真实频次，项目专属结论不再同时写 global |
| `/memory-consolidate migrate [dry]` | ✅ 历史 `_unassigned` 暂存回填（行文件 + 行内 `workspaceId` + 游标） |
| 设置页分组与回写 | ✅ 已注册（父插件在时） |

`lib/milestone.js` 的 `AUTO_TRIGGER_READY` 仍是**唯一**总闸：翻回 `false` 就退回「只交付手动命令闭环」
（事件与定时器都不再注册），`enable: false` 则是运行期开关（每个事件/每个 tick 现读）。

**`gateEnabled` 是一键关闸**（0.2.0）：`Config` 默认 `true`；设为 `false` 时
`gateBatch(..., { enabled: false })` **整批放行**，并且 runlog **不写 `gate` 字段**——
「闸口没启用」与「启用了但一条都没拦」是两件事，不靠 `dropped:0` 猜。线上误杀时改设置即可，不必改代码。

0.3.2 新增一类闸口原因 `meta-assistant`：`该助手不代用户登录账号` 这种「助手自身能不能做」的
**当次服务边界**说明，读起来是陈述句、实际换个话题就不成立，却会被糊进 FACT 静态槽每轮注入。
判定刻意做窄（只认「助手 + 能力/权限动词」）：`该助手运行在 Android 手机的 Ubuntu 环境里` 这类
环境事实必须放行，不能按「该助手」开头一律拦。

0.3.0 起**跨池近重复预筛也随它一起停**：`gateEnabled: false` 意味着整层确定性过滤整批放行
（否则「一键放行」名不副实，而且 runlog 不写 `gate` 就看不见被跨池丢掉的条目）。只想单独关
跨池去重、保留同批去重与空壳过滤时，用 `crossPoolDedup: false`。

## 写入门控（0.4.0）：结论/细节分层、重要性、截断重试、访问回写

契约：`DESIGN-memory-lifecycle.md` v3 §10–§15。三件事各自独立、都能单独关，默认全开。
三个包各自实现同一套格式，本插件**不 import 主插件源码**，主插件的新 API 一律用
`typeof store.touchEntries === 'function'` 这类探测，老 store 上行为与 0.3.x 完全一致。

### 抽取输出格式（§14.1）

规则新增 7、8 两条，输出 JSON 每条多两个字段：

```json
{"memories":[{"scope":"global|project|journal","content":"...","confidence":"high|medium|low","kind":"conclusion|detail","importance":3}]}
```

- `kind`：`conclusion`（结论/约定/红线）| `detail`（实现细节、一次性发现）；非法 ⇒ `conclusion`；
- `importance`：1–5（5=核心约定或踩坑红线，4=重要结论，3=一般结论，2=细节，1=一次性小事）；
  非法 ⇒ 3，越界收敛到 1–5（数字字符串也认）。**两个字段都不参与淘汰**：条目照收，只做路由与排序。

### 结论/细节分层：`routeByGranularity()`

`runL1` 在 `gateBatch()` **之后**、跨池预筛**之前**调用（纯函数、零 LLM、零 IO）：

- `scope ∈ {global, project}` 且（`kind === 'detail'` 或 `importance <= 2`）⇒ **改判** `scope='journal'`；
- **不丢弃**、不计闸口丢弃：内容照样写，只是不占每轮全量注入的静态槽；
- 已判 `journal` 的原样通过（不重复计数）；未知 scope 不动（合法性由抽取侧与写入侧各自负责）；
- 返回 `{ candidates, rerouted }`；runlog 新增 `layers: {conclusion, detail, rerouted}`（只做观测）。
  `rerouted` 是改判那一步的计数，之后还可能被跨池预筛拦下，所以**不要求与 candidates 相加平账**
  （要求平账的是闸口的 `kept + dropped = total`）。

### 重要性写入（§14.3）

`writer.entryOf(op)` 增加 `importance`：1–5 → **20 / 35 / 50 / 70 / 90**（非法 ⇒ 50），与
`{text, confidence}` 一起交给 `store.insertEntry` / `replaceEntry`。主插件 0.11+ 把它写进
`$DSH_HOME/memory/index.json` 侧车索引（0–100，缺省 50），用于淘汰评分与面板；**老主插件忽略该字段**
（不报错、不写入），所以正文格式零变化。归并可能改写正文，因此 `importance` 在归并**之后**
按 `content` 回匹配候选（`attachImportance()`），匹配不上（正文被模型改写）用缺省 3。

### 访问回写（§11）

静态注入是全量的，所以「注入」不构成区分度；真正的「用过」信号来自写入侧：

- `NOOP`（有 `target`）：模型明确说「旧条目已经表达了同样的意思」⇒ 旧条目被重新确认；
- 成功的 `UPDATE`（两段式或原子替换）：旧条目被引用为改写目标。

两种情况都调 `store.touchEntries([{ scope: 'fact'|'memory', id }])`（scope 用 `toStoreScope` 映射后的
store 词汇）。**只写索引**：不改正文、不占写锁、`dryRun` 不写；没有 `touchEntries`（主插件 < 0.11）
就跳过；调用抛错**静默吞掉**，绝不影响本轮结果（索引回写失败绝不能让整批素材不被消费）。

## 截断重试（0.4.0）

`LLM_TRUNCATED` ⇒ 先按元素边界抢救（0.3.2）⇒ 救不回来（或只救出空结果）时：

1. 用**同一份 prompt** 再调一次 `callModel`，请求带 `overrides: { reasoningEffort: 'off' }`；
2. `llm.js` 在 `prepareCall` 的能力回调里校验：在 `model.reasoning.efforts` 里才用，不在就退
   `efforts[0]`，连 `efforts` 都没有就**一个键都不传**（绝不盲传 ⇒ 不会 `UNSUPPORTED_REASONING_EFFORT`）；
3. 成功 ⇒ 正常返回，`truncated=true`、`retry='max-tokens'`、`calls=2`，runlog `detail` 记 `retry:max-tokens`；
4. 仍失败 ⇒ 按原逻辑 `extract-model-error` FAIL（`detail` 保留**第一次**的 finish 摘要，重试错误码附在末尾）；
5. 只重试一次；`callTimeoutMs` 每次调用独立计时。

`calls` 现在是**真实调用次数**（正常 1、重试 2、没接线 0）：`pipeline` 的 `calls` 与预算补扣
（`budget.charge`）都按它记账，不再写死 1——失败路径也一样认账。
开关 `retryOnTruncate`（默认 `true`，设置页「截断后降推理等级重试」）。

## 写入门控（0.3.0）：跨池去重 + 两段式失效

0.2.x 的闸口只管「同批」噪声；0.3.0 补上「跨批」与「改写」两条链路，并修掉一个观测 bug。
前两项各有独立开关、默认全开，出问题时可以单独关（不必改代码、不必等发版）；水位上限是纯修复，没有开关。

### 跨池近重复：`screenCrossPool()`

- **位置**：`pipeline.runL1` 在 `gateBatch()` 之后、归并之前（`lib/pipeline.js`）。池 =
  本次运行的 **FACT 条目 + 项目 MEMORY 条目**，一次运行**只读一次盘**（归并裁决共用同一份池）；
- **判定**：复用 `merger.topNeighbors()` + `merger.preScreen()`，阈值**沿用** merger 的
  `SIM_ADD = 0.45` / `SIM_NOOP = 0.95`，不另造一套；
- **只拦 `NOOP`**（`exact` / `near-duplicate`）：丢掉并计入 gate 新原因 `near-duplicate`
  （`kept + dropped === total` 始终成立，runlog `gate` 与 `/run` 报告里都看得见，
  报告显示为「跨池近重复」）；
- **`ADJUDICATE`（0.45–0.95）一律放行**：那个区间是「改写 / 补充」而不是重复，交归并层去问模型；
  在这里抢先丢掉就是误杀（宁可漏杀不可误杀）；
- **降级**：池为空、池构建异常（如 `store.entryId` 抛错）、打分异常 ⇒ **放行**，绝不阻断写入；
  错误码写进 runlog `detail`（`gate:POOL_BOOT_FAILED` / `gate:cross-pool-error`），不静默；
- **开关** `crossPoolDedup`（默认 `true`）；`gateEnabled: false` 时跨池一并停（见上节）。

为什么放在归并之前而不是 writer 之前：归并层自己也会把 NOOP 消化掉，但那样不计入 gate、
报告里也看不见「为什么没写」；而只有 ADJUDICATE 才可能被模型改成 ADD，那类又必须放行。

### UPDATE 两段式失效

`writer` 处理 `UPDATE` 时，若 `store.supersedeEntry` 存在**且新旧正文不同**：

1. 先按 `ADD` 把新正文写进去（同一 scope、同一套闸口 / 降级口径）；
2. **成功后才** `supersedeEntry(旧条目)`：旧行只加行尾
   `<!-- memory-state: status=superseded by=… since=… -->` 注释（**不删行、不改正文**，
   原文保留可审计、可 `restoreEntry` 恢复），`by` = 新条目的 contentId；
3. 任一步失败 ⇒ 回退旧的原子替换 `replaceEntry`：**绝不**出现「旧条目被标记失效、新条目没写进去」。
   第二步失败时先替换成功、再尽力删掉刚多写的那条（宁可重复一条，不丢内容）。

写不进新条目（预算 / 模板拒绝）时**绝不标记旧条目失效**；`demoted:'journal'` 不再走替换
（内容已经进 JOURNAL，替换会写第二遍），`demoted:'drop'` 才回退替换。
开关 `supersedeOnUpdate`（默认 `true`）；主插件低于支持 `supersedeEntry` 的版本时自动走原子替换，
行为与 0.2.x 一致。

### runlog 水位上限修复

`watermarks.*.limit` 过去恒为 `0`：`store.watermark()` 给的是**对象**（FACT `{lines, bytes}`、
项目 MEMORY `{chars}`），而旧代码用 `Number.isFinite(mark.limit)` 判，对象永远不是有限数。
现在按形状透传 `{lines, bytes, chars}`（未给的维度不补 0、未知键丢弃），标量输入仍原样保留
（向后兼容）。**纯显示口径**，不影响裁剪行为。

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
peer 范围是 `>=0.7.0 <0.12.0`：覆盖主插件 **0.7.x–0.11.x**。0.10.0 起主插件才有
`store.supersedeEntry`（UPDATE 两段式失效靠它）、0.11.0 起才有 `store.touchEntries`（访问回写靠它）
与 `insertEntry` 的 `importance` 字段；本插件全部用特性检测接入：老版本没有这些能力时
自动回落（原子替换 / 跳过回写 / 忽略 importance），不会报错。

## 命令：`/memory-consolidate`

装配在**宿主平面**，所以对所有预设都是全局命令。宿主里的用法提示与 `lib/command.js` 的
`USAGE` 一致：

```
用法：/memory-consolidate [status|dry|run|cross [dry]|migrate [dry]|rollback <runId|last>]
```

| 子命令 | 状态 | 干什么 |
|---|---|---|
| （不带参数） | ✅ | 等同 `status` |
| `status` | ✅ | 真读盘报告：开关/档位/干跑、暂存目录、桶数/会话数/未消费行数/字符数、消费门槛、今日 LLM 调用、跨会话判定、自动触发是否已接线、**抽取路线（provider/model + 来源）**、**上次失败（reason + detail + 人话提示）**、分桶分裂告警 |
| `dry` | ✅ | 干跑：打印管线就位状态 + `status` 全量报告，不改任何记忆文件（也不推游标） |
| `run` | ✅ | 立即对所有桶跑 L1：真读暂存、真调 LLM、真过闸口、真经 store 写盘；`off` 档拒绝正式写入 |
| `cross [dry]` | ✅ | L2 全套（跨桶一遍 + 逐桶一遍）；手动触发绕过 24 小时 / 20 条门槛，但绕不过预算与单飞锁 |
| `migrate [dry]` | ✅ | 历史 `_unassigned` 暂存回填：按路径优先把会话搬回正确桶（行文件 + 行内 `workspaceId` + 游标）；`dry` 只出计划 |
| `rollback <runId\|last>` | ✅ | 按 runId（或最近一份快照）回滚；快照目录 `<数据目录>/backups/<runId>/`，保留 10 份。不带 runId 直接报用法错误 |

命令解析是纯函数（`lib/command.js`）：大小写不敏感、多余空白忽略、未知子命令回用法提示，
处理器**同步**返回 `{kind:'success'|'error', text}`（宿主 `CommandDefinition.handler` 的合同），
异常一律在处理器内兜住，绝不穿透到宿主。

## 配置

`cordis.patch.yml` 里那一行就是默认值。`Config` 共 **37 个键**：组合补丁写了其中 **30 个**，
`gateEnabled` / `crossPoolDedup` / `supersedeOnUpdate` / `retryOnTruncate` / `maxOutputTokens` /
`callTimeoutMs` 只走 schema 默认值（`test/wiring.test.mjs` 逐个比对 `Config` 默认值）：

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | 总开关；只在 `auto` 档生效（`off` / `observe` 档以档位为准） |
| `mode` | `'auto'` | 运行档位：`off`（完全静默，等价 `enabled=false`）/ `observe`（影子：真跑管线但只写 would-write）/ `auto`（正式写入） |
| `dryRun` | `false` | 干跑：只出报告不落盘。默认关闭；一次性演练用 `/memory-consolidate dry` |
| `gateEnabled` | `true` | 确定性写入闸口总开关；`false` = 整批放行，runlog 不写 `gate` 计数（线上误杀时的一键开关）。0.3.0 起跨池近重复也随它一起停 |
| `crossPoolDedup` | `true` | **0.3.0**：跨池近重复预筛。`false` = 只关这一道（同批去重 / 空壳过滤照旧），归并层自己的池内预筛不受影响 |
| `supersedeOnUpdate` | `true` | **0.3.0**：UPDATE 先写新条目、成功后才标记旧条目失效；`false` = 只走原子替换。主插件无 `supersedeEntry` 时自动回落替换 |
| `retryOnTruncate` | `true` | **0.4.0**：截断重试。`LLM_TRUNCATED` 且补括号抢救不回来时，同 prompt 再调一次并把推理等级压到模型支持的最低档；只重试一次，仍失败按原逻辑整次 FAIL |
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
| `maxOutputTokens` | `8192` | 单次抽取的输出上限（≥256）；0.2.1 起显式传给宿主，不再吃默认值 |
| `reasoningEffort` | `'low'` | **0.3.2**：沉淀调用的推理等级（`off`/`low`/`high`/`max`，或 `auto`）。宿主对推理模型默认 `high`，会把 `maxOutputTokens` 大半花在思考上 ⇒ `finish=max-tokens` ⇒ `LLM_TRUNCATED`。模型不支持推理时自动丢弃该键，不会失败 |
| `callTimeoutMs` | `120000` | 单次模型调用超时（≥5000，毫秒）；0.2.2 起超时会真正 abort 底层请求 |
| `provider` | `''` | LLM provider 覆盖；空 = 沿用会话最近一次 route |
| `model` | `''` | LLM model 覆盖；空 = 沿用会话最近一次 route |
| `subagent` | `false` | 子代理会话是否也沉淀 |
| `redact` | `true` | 写入前按正则给密钥/手机号/身份证/卡号打码 |
| `crossEnabled` | `true` | 第二层（跨会话整理）总开关 |
| `crossSource` | `'auto'` | `auto` \| `journal` \| `service` \| `files`；`auto` 的降级链是「服务 → JOURNAL」（**不会自动退到 files**，全量会话文件 284.7 MB，自动扫会拖垮一次后台整理），最后一定落到 JOURNAL |
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
注册声明式设置项（页面只渲染与回写，值存哪里由本插件决定）。两组：
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
| `consolidate.maxOutputTokens` | 高级 | 文本 | `8192` | 单次输出上限（≥256，整数） |
| `consolidate.callTimeoutMs` | 高级 | 文本 | `120000` | 单次调用超时（≥5000，毫秒） |
| `consolidate.dailyLlmBudget` | 高级 | 文本 | `60` | 每日调用上限（≥1，整数；改了立即重建预算器） |
| `consolidate.subagent` | 高级 | 开关 | 关 | 子代理也沉淀 |
| `consolidate.redact` | 高级 | 开关 | 开 | 敏感串打码 |
| `consolidate.gateEnabled` | 高级 | 开关 | 开 | 结论质量闸口。关掉即整批放行（跨池近重复也停），runlog 也不再记 `gate` 分类计数 |
| `consolidate.crossPoolDedup` | 高级 | 开关 | 开 | **0.3.0**：跨池近重复拦截。完全相同或相似度 ≥95% 的结论直接丢弃并计入闸口「跨池近重复」；45%–95% 交给模型裁决；池空或打分异常放行 |
| `consolidate.supersedeOnUpdate` | 高级 | 开关 | 开 | **0.3.0**：改写走失效标记。先写新正文，成功后才把旧条目标为失效（原文保留可审计、可恢复）；任一步失败回退原子替换 |
| `consolidate.retryOnTruncate` | 高级 | 开关 | 开 | **0.4.0**：截断后降推理等级重试。输出被 max-tokens 截断且抢救不回来时，用同一份 prompt 再调一次（推理等级压到模型支持的最低档）；只重试一次，仍失败则本次一个字都不写 |
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
| `pending/<workspaceId>/<sessionId>.jsonl` | L0 暂存：一行一回合（JSONL）。实写字段：`turn` / `endedAt` / `seqFrom` / `user` / `assistant` / `chars` / `session` / `cwd` / `workspaceId` / `workspaceTitle` / `consumed`。`status` 依赖 `chars` 与 `consumed`；`cwd` 供路径优先归属与 L1 兜底 |
| `pending/archive/` | 归档桶：`listPendingBuckets()` 明确跳过它，不算工作区桶 |
| `cursor.json` | 消费游标，按 `${workspaceId}:${sessionId}` 记 `{turn, at, chars}`，**只单调前进**，只在 L1 成功后推进 |
| `runs.jsonl` | 运行日志：一行一次运行/阶段，字段白名单 + 打码，条目正文一个字都不进；4 MB 滚动、保留 3 份（`.1` / `.2`）。0.2.0 起白名单多了 `detail`（真实错误消息 / finish 形状，≤200 字符）与 `gate`（闸口分类计数），并新增 `WARN` 状态（如「会话已在别的桶，沿用旧桶」）；0.3.0 起 `watermarks.*.limit` 按真实对象形状（`{lines,bytes,chars}`）透传，不再恒 0 |
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
| **不压缩 FACT / MEMORY** | 本插件只产出「新增 / 替换 / 删除某一条」的算子，交主插件 `store` 执行。主插件回「超限」时本插件**不做任何合并、截断、改写**，而是把该条**降级成 JOURNAL 追加**，并在 runlog 记 `DEMOTED` |
| **store 的降级要被读懂（0.2.0）** | 主插件返回 `{written:false, demoted:'journal'\|'drop', reason}` 或老契约 `demoted:true`。`'journal'` ⇒ 真的补写一次 JOURNAL（算写成，行可消费）；`'drop'` ⇒ 一个字没写，记 `FAILED` 并带 store 的 `reason`。绝不把 `'drop'` 记成 `written`（否则回合被消费、结论却不存在） |
| **确定性闸口先丢噪音（0.2.0）** | `lib/gate.js`：空壳 / 占位、过程叙述、<8 字、同批精确重复、状态断言缺时点 → 丢，且**按原因计数**写进 runlog `gate` 与命令报告；只丢不改写，拿不准一律放行 |
| **唯一写入通道是主插件** | 自己不 `fs` 写 FACT.md / MEMORY.md / JOURNAL.jsonl；条目模板、校验、闸口、备份、原子写、锁全部在主插件的 `./store` |
| **主插件缺失就认输** | store 解析不到 ⇒ 全部算子 `store-unavailable`（丢弃 + 记原因），**不假装成功** |
| **拿不准就不写正式记忆** | 模型裁决 JSON 非法 ⇒ 整次放弃不重试；`UPDATE` 的 target 不在候选集 ⇒ 降级 `ADD`；`DELETE` 只在第二层允许，第一层降级 `NOOP` |
| **正文不上日志** | runlog 只留结构化摘要（counts / reason / watermarks / detail / gate），字符串统一过 `redact()` 再落盘 |
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

**回滚某次运行**（已接线）：

```
/memory-consolidate rollback <runId>
/memory-consolidate rollback last
```

快照在 `$DSH_HOME/memory/consolidate/backups/<runId>/`（保留 10 份），runlog 里能查到每次运行的 runId。
回滚只恢复**这次运行改过的记忆文件**（快照覆盖 FACT / MEMORY / JOURNAL）；`dry` 与 `observe` 档不建快照，
`last` 找不到快照时直接报错，不会假装回滚成功。订阅 `agent/pre-step` 的插件（recall）看到的是
JOURNAL 回滚后的版本，无需额外通知。

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

```bash
# 一条命令跑全量（Windows / Linux / Android 通用，逐个跑 test/*.test.mjs）
# 开跑前会自动补齐依赖链接（test/ensure-deps.mjs，缺才补、失败只警告）
node test/run-all.mjs

# 也可以单独跑
node test/trigger.test.mjs      # L0/消费门槛、中断回合、子代理、总开关
node test/sampler.test.mjs      # 逐轮窗口、逐回合截断、图片占位、最小字符
node test/cursor.test.mjs       # 双键游标、只前进、坏文件回落空游标、原子写
node test/pending.test.mjs      # 桶路径、行读写、滚动压实、resolveBucket 桶黏性、分桶分裂检测
node test/workspace.test.mjs    # 路径优先归属、最长前缀、sessionIds 兜底、整批同工作区才认
node test/gate.test.mjs         # 空壳/过程/太短/缺时点/同批重复、near-duplicate 键序，只丢不改写，计数口径
node test/budget.test.mjs       # 单飞/并发 1/日配额/阶段配额/退避/withTimeout
node test/redact.test.mjs       # 密钥/手机号/身份证/卡号打码与 drop
node test/bm25-parity.test.mjs  # 与 recall 真实实现逐位一致（11 条语料 / 8 条查询）
node test/merger.test.mjs       # 预筛阈值、sanitizeOps 降级、冲突规则
node test/extractor.test.mjs    # 提示词构造（含规则 7/8）、JSON 解析、候选归一（kind/importance）、截断抢救与重试
node test/llm.test.mjs          # 宿主 finish 形状、route 继承、codeOf 空码、max-tokens 截断、推理等级能力校验（含 overrides）
node test/writer.test.mjs       # 降级 JOURNAL、demoted 字符串、dryRun、store 缺失、水位、observe 影子、UPDATE 两段式失效与回退、importance 映射、访问回写（有/无 touchEntries）
node test/settings.test.mjs     # 数字/字符串项回写、mode 白名单与优先级、crossPoolDedup/supersedeOnUpdate 开关、覆盖层坏值
node test/sources.test.mjs      # 三档数据源与降级链、pending 桶列举
node test/runlog.test.mjs       # 字段白名单、打码、滚动、detail/gate/layers、watermarks.limit 对象形状、影子运行不进真实写入统计
node test/commands.test.mjs     # status/dry/run/cross/migrate/rollback 文案、抽取路线、上次失败、分桶分裂、跨池近重复标签
node test/autotrigger.test.mjs  # turn/end 写 L0、门槛微任务消费、状态兜底、销毁收尾、兜底扫描、退避、桶黏性
node test/pipeline.test.mjs     # L1 闭环：happy path、闸口、跨池近重复、撞限降级、快照回滚、observe、分层路由/layers、importance、按真实 calls 记账
node test/crosssession.test.mjs # L2：只认真实频次、项目专属不双写 global、只交 id 失效、逐桶、预算、observe
node test/migrate.test.mjs      # 历史暂存回填：行文件合并、workspaceId 改写、游标取 max
node test/wiring.test.mjs       # 插件形状、Config 默认值（含 0.4.0 的 retryOnTruncate）、命令路由、设置项、turn/end 真的写 L0
```

不需要 Harness、不需要 profile：全部用例是纯 node，每个用例自带临时 `DSH_HOME`，
**绝不会写到真实的 `~/.dsh/memory`**。`wiring.test.mjs` 需要 `schemastery`（装配后由 profile 提供），
本机没有时退化成对 `lib/*.js` 逐个 `node --check` 并打印 **SKIP**（不算失败，也绝不假装通过）；
`bm25-parity.test.mjs` 需要兄弟仓库 `dsh-plugin-persona-memory-recall` 的源码，装进 profile 后同样打印 SKIP。

## 变更（0.1.2）：写侧为什么一直「静默失败」

本机 `runs.jsonl` 曾连续 **25 次** `layer1 / FAIL / extract-model-error`（后续在其他会话复现到
**35/35**）—— 抽取一次都没成功，JOURNAL 与 FACT 因此一直是空的。根因有两层，都已修：

1. **模型路线没有回落**：`createCallModel` 建的时候没传 `defaults`，而
   `config.provider` / `config.model` 默认都是空串 ⇒ `resolveRoute()` 必回
   `null` ⇒ 抛 `NO_ROUTE`，被 `extractor` 吞成 `model-error`。
   现在按「设置页显式值 → **最近一次真实请求的 route** → 宿主默认模型
   (`agentDefaultModel`)」解析，且**调用时才读**：用户切模型，下一轮沉淀
   就跟着换。最近 route 来自 `session.requestHeader()?.config`，读不到时
   退回事件流里的 `request/header`（`lib/autotrigger.js` 的 `rememberRoute`）。
2. **finish 块形状对不上宿主**：宿主是 `{ type:'finish', reason:{ kind, failure } }`，
   旧代码读 `chunk.kind === 'end'` ⇒ 即使路线通了也会判失败。
   现在 `finishOf()` 两种形状都认；`stop` / `tool-calls` 算成功，
   `max-tokens` 判 `LLM_TRUNCATED`（半截 JSON 不许当结论）。

0.2.0 补上第三层（也是 35/35 那次真正的盲点）：**错误码是空串时被 `??` 原样传下去**，
`reason` 只剩裸的 `extract-model-error`。现在 `codeOf()` 把空串当缺失并回退，
`detailOfError()` 把 `error.name/message` 与 finish 摘要（`finish.kind=… failure.code=''…`）写进
runlog 的 `detail`；`/status` 的「上次失败」直接显示它，并给一句人话提示（路线没接上 / 宿主结束块异常 /
超时 / 截断）。

配套的可观测性：

- `extractor` 失败时把真实错误码带出来，`runlog` 记成
  `extract-model-error:<CODE>`（`NO_ROUTE` / `NO_ADAPTER` / `AUTH` / `LLM_TIMEOUT` / `LLM_TRUNCATED` …）；
- `/memory-consolidate status` 多两行：**抽取路线**（provider/model + 来源：设置页 / 会话 route / 宿主默认，
  llm 服务是否在位）与**上次失败**（reason + detail + 提示）；「上次运行」也补 `原因 <CODE>`；
- `llm.test.mjs` 覆盖宿主 finish 形状、会话 route 继承、默认模型回落、空错误码；
  `autotrigger.test.mjs` 覆盖 `requestHeader` 与 `request/header` 两条取 route 的路。

## 变更（0.1.3）：归属改为路径优先 + 历史暂存回填

**为什么改**：本机实测 6 个 pending 桶里 5 个是 `_unassigned`，而 `workspace.json` 里
这些会话其实都有归属——因为 L0 写入时按 `sessionIds` 反查，而会话常常先于登记写入。
未分组桶不产出项目记忆，所以项目 `MEMORY.md` 一直长不出来。

现在的归属口径（`lib/workspace.js`）：

1. **cwd 路径匹配**（最长前缀优先）——会话没登记、登记晚了、恢复出来的会话都能归对桶；
2. `sessionIds` 反查（会话被手动挪过工作区时仍然以名单为准的兜底）；
3. 都没有 ⇒ `_unassigned`。

配套还有三层：

- **L0 分桶**走路径优先（`autotrigger` 把会话 `cwd` 传给 `bucketForSession`）；
- **L1 消费兜底**：桶本身没 cwd 时，从行里的 `cwd` 反查工作区；只有**整批行指向同一个
  工作区**才写项目记忆（混桶不猜，宁可不写也不造假）；
- **`/memory-consolidate migrate [dry]`**：把历史 `_unassigned` 暂存真正搬回正确桶——
  行文件按 turn 去重合并、行内 `workspaceId` 改写、游标从旧键迁到新键（取 max，不回退）。
  `migrate dry` 只出计划；失败逐条回报，绝不假装成功。

`runlog` 同时多了 `projectWorkspaceId`：桶身份与「实际写到哪个项目」不一致时能直接看出来。

## 变更（0.2.0）：先过闸口，再认 store 的降级

- **确定性写入闸口 `lib/gate.js`**：抽取是模型说了算，它会把「暂无」「见上」「我先看了一下配置」
  「目前进度是快改完了」当结论交上来；写进 FACT / MEMORY 就是永久噪音，还会被 recall 每轮召回、
  被 L2 当成稳定事实升格。闸口在落盘前过滤五类：**空壳/占位**（含纯标点）、**过程叙述**
  （「我先」「然后」「排查了」…）、**太短**（< 8 字）、**同批精确重复**、**状态断言缺时点**
  （「目前进度是…」但没有日期/版本锚点）。它**只丢不改写**，拿不准一律放行，每一条被丢的都有
  `reason`，分类计数进 runlog `gate` 与命令报告（`/run` 会打「闸口丢弃 N 条（占位/空壳 2 / 太短 1）」）。
- **writer 认清主插件返回的字符串 `demoted`**：主插件 0.7+ 的拒绝形状是
  `{written:false, demoted:'journal'|'drop', reason}`。旧实现只认布尔 `demoted:true`，于是
  `'drop'` 被当成「没写成但也没降级」、`'journal'` 在 UPDATE 路径被误判成 not-found ⇒ 降级 ADD ⇒
  再被闸口拒一次 ⇒ 那批行永远不消费。现在 `'journal'` 真的补写一次 JOURNAL（记 `DEMOTED`），
  `'drop'` 记 `FAILED` 并带原因，**绝不把 `drop` 记成 `written`**。
- **桶黏性（会话唯一桶）**：`pending.resolveBucket()` / `bucketsForSession()` 发现同一会话已经在别的桶里，
  就**沿用旧桶**（取未消费行最多的那个），并记 `WARN` + `reason: bucket-split-adopted`。
  否则同一对话被拆到两个桶：两边各跑一次 L1（结论重复写）、游标双键分裂、任一侧都可能凑不够门槛。
  `status` 在真的存在分裂时多一行「分桶分裂：…（历史可用 migrate 搬）」。
- **L2 不再双写升格**：`promotionConflict()`（纯函数，计划与执行共用）——同一句结论如果**单独一个桶内**
  就已经够 `crossPromoteHits`，它就是项目专属结论，只留 project 候选，从 global 里剔除
  （跳过原因 `also-project-candidate:<bucket>`）。否则同一句会同时写进 FACT 与项目 MEMORY，
  改一处忘一处就开始互相矛盾。
- **删掉模型自报 `hits`**：L1 抽取 JSON 不再要 `hits`；L2 提示词明确「出现次数由宿主自己数，不要填」，
  `parseCrossResponse()` 直接忽略该字段；频次只由 `countOccurrences()` 按去重后的会话/桶真实数。
  同时收紧匹配口径：归一化后**相等**，或**包含且长度差 ≤ 20%**；短于 8 字只认完全相同。
  旧口径「任一侧包含另一侧」会让 12 字短句命中 200 字素材，把只出现一次的偶然结论数成「出现 ≥2 次」。
- **可观测性**：`runlog` 白名单加 `detail`（真实错误消息 + finish 摘要，≤200 字符）与 `gate`
  （闸口分类计数），并新增 `WARN` 状态；`/status` 多「抽取路线」「上次失败」两行，
  「上次运行」补 `原因 <CODE>`；写入失败的 reason 不再是裸 `error`，而是 `store-rejected:<原因>` /
  `store-not-written:<原因>`。
- **`gateEnabled` 可一键关闸**：设为 `false` 时整批放行，runlog 不写 `gate` 字段（与「启用了但没拦到」区分）；
  设置页「结论质量闸口」就是它。

## 变更（0.3.0）：跨池去重、两段式失效、水位上限修复

- **跨池近重复（`screenCrossPool`）**：同批重复管不到「上个月写过的同一条结论换个说法再交上来」。
  `runL1` 在闸口之后、归并之前，用本次运行的 FACT+MEMORY 条目池做 BM25 预筛，只拦
  `exact` / `near-duplicate`（阈值沿用 merger 的 `0.95`），`ADJUDICATE` 放行；池为空 /
  池构建或打分异常一律放行，错误码进 runlog `detail`。gate 新增原因 `near-duplicate`
  （追加在 `GATE_REASONS` **末尾**，旧日志的键顺序不变），`/run` 报告显示为「跨池近重复」。
- **UPDATE 两段式失效**：与主插件 0.10.0 的 `store.supersedeEntry` 对接——先写新条目，
  成功后才把旧条目标 `status=superseded`（只加注释、不删行，`by` = 新条目 contentId）；
  任一步失败回退 `replaceEntry`，**写不进新条目时绝不标记旧条目失效**。
- **runlog 水位上限修复**：`watermarks.*.limit` 不再恒 `0`，按 `store.watermark()` 的真实形状
  （`{lines, bytes, chars}` 对象）透传；标量输入仍然兼容。纯显示口径，不影响裁剪行为。
- **测试**：gate / pipeline / writer / runlog / commands / settings / wiring 全部扩了用例
  （跨池拦截与放行、异常降级、两段式成功与回退、开关关闭、limit 对象形状）；
  `test/_helpers.mjs` 的假 store 新增**可选** `supersedeEntry`（默认不挂，老用例仍走替换）。
  仍不新增运行时依赖。

## 变更（0.3.1）：设置页补上「单次抽取输出上限」

- **问题**：`maxOutputTokens` 从 0.2.1 起就是 `Config` 字段、也一直写在本文的设置页表里，
  但它**没进** `SETTINGS_SPECS` —— 页面从不渲染它，等于「文档说能调、实际调不了」。
- **修复**：`lib/settings.js` 的「自动沉淀 · 高级」组补上该项（数字项，`min: 256`，`order: 134`），
  默认 `8192`。改完下一轮生效（`createCallModel` 每次调用现读 `config.maxOutputTokens`）。
- **为什么默认不调**：8192 已实测够 6 轮 / 1.6 万字符的桶；调小会让 `finish` 落在 `max-tokens`，
  本次抽取判 `LLM_TRUNCATED` 且一个字都不写——这比「写半截」安全，但丢了一次抽取。
- **测试**：`test/settings.test.mjs` 的数字项样例表补上该键；22 组用例全绿。

## 变更（0.4.0）：分层、重要性、截断重试、访问回写

- **结论/细节分层**（DESIGN §14）：抽取规则加 7、8 两条；JSON 增加 `kind` / `importance`；
  `normalizeMemories()` 归一（非法 kind ⇒ `conclusion`、非法 importance ⇒ 3、越界收敛 1–5）；
  `pipeline.routeByGranularity()` 在闸口之后、跨池预筛之前把 `detail` / `importance≤2` **改判**进 JOURNAL。
- **重要性**（DESIGN §10/§14.3）：`writer.entryOf()` 带 `importance`（1–5 → 20/35/50/70/90）；
  `pipeline.attachImportance()` 在归并之后按 content 回填（改写过的正文用缺省 3）。
- **截断重试**（DESIGN §13）：`LLM_TRUNCATED` 且抢救失败 ⇒ 同 prompt 重试一次、`overrides.reasoningEffort`
  由 `llm.js` 按模型能力校验；抽取器返回真实 `calls`，预算与 runlog 按它记账（失败路径也补扣）。
- **访问回写**（DESIGN §11）：`NOOP` / 成功 `UPDATE` 调 `store.touchEntries`（feature-detect、失败静默）。
- **观测**：runlog 新增 `layers`（`RECORD_FIELDS` 白名单 + `sanitizeRecord` 只留三个数字，未知键漏不进去）；
  `detail` 能区分 `salvage:max-tokens`（补括号救回来）与 `retry:max-tokens`（重试成功）。
- **兼容**：主插件没有新字段 / 新方法时写入与 0.3.2 完全一样；peer 上界升到 `<0.12.0`（主插件 0.11.0）。
  不新增运行时依赖，正文格式（FACT / MEMORY）零变化。

## 已知边界（0.3.0）

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
- **跨会话数据源各有硬前提**：`service` 依赖 `ctx.sessionQuery`（组外可能拿不到，按降级链退 JOURNAL，绝不搜 `searchSessions`）；`files` 需要 node 22 的 `zstdDecompressSync`、只读配置的 cwd + 近 `crossLookbackDays` 天 + 最多 `crossMaxSessions` 个会话，坏帧 > 5% 整档降级。`auto` 不会自动退到 files。
- **JOURNAL 只能看到本插件写进去的摘要**：第二层的频次升格因此只对本插件写过的结论有效，
  不覆盖用户手工 `memory action=append` 的历史正文。
- **日预算在内存里**：重启后从 0 重算（不跨重启精确），换来的好处是磁盘上一个小计数器写坏也不会把沉淀锁死。
- **闸口是启发式，但可以一键关**：`gateEnabled: false` 会整批放行（runlog 也不写 `gate`）。规则只覆盖
  「明显是空壳 / 明显是过程 / 明显缺时点」，误杀概率低但不为零；被丢的条目只在 runlog `gate`
  与命令报告里留计数，**正文不进日志**，所以想找回被误杀的结论只能从 pending 原始回合重跑。
- **桶黏性优先于现算归属**：同一会话已经落在某个桶，后续即使 cwd 变化也沿用旧桶（取未消费最多的那个）。
  要纠正归属得先 `/memory-consolidate migrate` 搬历史；黏性只保证「不再分裂」，不负责搬家。
- **L2 的 `hits` 只认真实计数**：模型自报的次数被忽略；一句结论若在素材里只出现一次，就会被
  `crossPromoteHits` 拦下（哪怕模型坚持 ≥2）。短于 8 字的结论只接受与素材完全相同才算命中。
- **`status` 的「上次失败」取最近一条 FAIL/TIMEOUT**：不一定是「上次运行」（成功运行会把上一条失败顶掉，
  所以单独查）；`detail` 是 0.2.0 起才有的字段，老记录会显示「没有 detail」。
- **peer 范围是 `>=0.7.0 <0.11.0`**：覆盖主插件 0.7.x–0.10.x。`supersedeEntry` 是 0.10.0 起才有的导出，
  本插件用特性检测接入（没有就回退原子替换）；再往上的主插件大版本需要重新核对 `./store` 的导出。
- **跨池去重只挡确定性重复**：完全相同或 BM25 归一化相似度 ≥0.95 才会被拦；「换一套词说同一件事」
  这类纯语义同义改写仍交给归并裁决（模型判断），不保证 100% 拦住——这是「宁可漏杀不可误杀」的取舍。

## 仓库结构

| 路径 | 角色 |
|------|------|
| `lib/index.js` | 宿主入口：`Config`、`createRuntime`、命令注册、设置页注册、自动触发装配 |
| `lib/autotrigger.js` | 自动触发：`turn/end` 写 L0 + 门槛微任务消费 + 桶黏性 + 状态/销毁/定时兜底 |
| `lib/command.js` | `/memory-consolidate <子命令>` 的纯解析 + 用法文案 |
| `lib/commands.js` | 命令处理器（`status`/`dry`/`run`/`cross`/`migrate`/`rollback` 全部真实现）+ `scanPending`、抽取路线、上次失败、分桶分裂文案 |
| `lib/trigger.js` | L0 写入与消费门槛判定（纯函数） |
| `lib/sampler.js` | 逐轮窗口与逐回合采样（截断、图片占位、最小字符） |
| `lib/cursor.js` | 路径、游标读写（坏文件当空）、原子写 JSON |
| `lib/budget.js` | 单飞 + 并发 1 + 日配额 + 退避 + `withTimeout` |
| `lib/validate.js` | 打码、桶一致性、主插件 store 懒解析与闸口封装 |
| `lib/writer.js` | 算子执行：写 FACT/MEMORY 或**降级 JOURNAL**；认 store 的字符串 `demoted`（`journal` 补写 / `drop` 记 FAILED）；`dryRun` 只记 DRY；`observe` 只写 `would-write/` |
| `lib/mode.js` | 运行档位 `off` / `observe` / `auto` 的唯一口径（含与 `enabled` 的优先级） |
| `lib/extractor.js` | 抽取/裁决提示词与模型 JSON 解析 |
| `lib/merger.js` | 预筛（BM25 近邻）、算子校验、冲突规则 |
| `lib/gate.js` | 确定性写入闸口：空壳/过程/太短/缺时点/同批重复，只丢不改写 |
| `lib/migrate.js` | 历史暂存回填：计划、行文件合并、`workspaceId` 改写、游标迁移 |
| `lib/pending.js` | L0 暂存行读写、滚动压实、`resolveBucket()` 桶黏性、`findBucketSplits()` |
| `lib/workspace.js` | 工作区注册表、路径优先归属、整批行同工作区判定 |
| `lib/llm.js` | 宿主 `llm` 调用、route 解析与来源、`codeOf()` / `detailOfError()` |
| `lib/atomic.js` | 原子重命名（含 Windows 重试） |
| `lib/sources.js` | 第二层三档数据源 + 降级链 + pending 桶列举 |
| `lib/crosssession.js` | 第二层触发判定、真实频次升格、`promotionConflict()`（不双写 global）、逐桶计划 |
| `lib/runlog.js` | `runs.jsonl` 写入（字段白名单 + 打码 + 滚动）、7 天汇总、影子文件路径 |
| `lib/settings.js` | 设置页声明式设置项 + 覆盖层持久化与校验 |
| `lib/milestone.js` | `AUTO_TRIGGER_READY` / `MILESTONE` 里程碑开关（断开 `index ⇄ commands` 循环 import） |
| `lib/tokenize.js` / `lib/bm25.js` | 分词与 BM25（与 recall 实现逐位一致） |
| `lib/types/index.d.ts` | 类型声明（只声明包入口真正导出的东西） |
| `cordis.patch.yml` | 组合包层：把 `persona-memory-consolidate` 一行插进宿主组合 |
| `test/*.test.mjs` | 22 组回归测试；`npm test` = `node test/run-all.mjs`（`run-all.ps1` 仅留作旧入口） |

`lib/` 下的 JS **就是源码**，纯 ESM，无构建链。

## 协议

MIT License，全文见 [LICENSE](./LICENSE)。
