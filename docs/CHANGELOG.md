# 变更日志

本文件保存历史变更记录，新变更继续追加到此处；README 只保留最近一版摘要。

以下内容按版本从新到旧排列，正文保持旧 README 原文，仅调整标题层级。

---
### 变更（0.7.1）：近邻覆盖跨作用域 + 提示词补别名 / partial / 抽象层

- **审计现场（这条会直接决定门控有效性）**：`DEDUPE_NEIGHBORS=2` 只给「**整个池**的 BM25 top-2」，
  而真正要判的那条旧条目常常不在里面 —— F24 的 top1 是 F5（不相干）、M43 的 top1 是 M58。也就是说
  模型看到的近邻里根本没有重复对象，再聪明也判不出重复（判重层等于空转）。
- **改法（选 A，跨作用域保证 > 池内 top-4）**：新增 `pickNeighbors(content, candidateScope, pool)`，
  按候选 scope 映射池 scope（`global → fact` / `project → memory`），**同作用域 top-2 + 另一作用域
  top-2 = 最多 4 条**，正文去重（同一句话在两个作用域都存时只给一次，免得模型以为「有两处支持」）。
  这样跨作用域的同一事实（F8↔M44 那种）一定在眼前，而不是被同作用域的无关条目挤掉。
- **prompt 打作用域标签**：`buildDedupePrompt()` 用 `scopeLabel()` 给近邻标 `【FACT】` /
  `【MEMORY】`，并在规则段说明「同一事实可能分别躺在两个作用域里，两边都要看」。
- **提示词补 4 条判定口径**（对照原有 6 条去重后共 10 条）：
  ① **实体别名**：缩写 / 全称 / 俗称 / 中英文名指同一个东西时先归一再判（DSH 与 DeepSeek Harness）；
  ② **partial**：核心事实只重合一部分就算重复，**不要求整条等价**；
  ③ **抽象层**：现象（「它老是超时」）/ 原则（「别把 deadline 定太紧」）/ 取舍（「宁少勿多」）说同一件事算重复；
  ④ **上下位算重复，但同族不同数值 / 档位不算**（阈值 120 与 160、档位 2 与 4、topK 3 与 5 是两条结论）。
  「不算重复」仍保留：同主题不同结论 / 冲突或更新 / 只共享术语或实体。
- **截断不炸**（审计要求「越界截断不炸」）：候选正文切到 `DEDUPE_CANDIDATE_CHARS=200`、
  近邻切到 `DEDUPE_NEIGHBOR_CHARS=160`、每条最多 `DEDUPE_MAX_NEIGHBORS=4` 条；整份 prompt 还有
  `DEDUPE_MAX_PROMPT_CHARS=6000` 的总预算 —— 塞不下就少判几条（没列出的候选按「新结论」放行），
  prompt 末尾留「候选清单超出上下文预算，已截断」。判重不需要完整上下文，超长只会把调用拖成超时。
- **测试**：`test/dedupe.test.mjs` 追加 4 组 —— 同作用域 + 跨作用域近邻都进 prompt（两个方向各一条）、
  `scopeLabel` 生效、超过 4 条近邻时截断、超长正文 / 40 条候选越界截断不炸；另加一条端到端回归：
  「真重复只在项目 MEMORY 里」时判重 prompt 必须能看到它、且候选改判 NOOP 不写 FACT。
  全量 **26** 个用例通过。

---

### 变更（0.7.0）：近重复改由模型裁决 —— 统计阈值已证伪

- **问题现场**：自动沉淀一次运行往项目 MEMORY 塞了 **6 条既有条目的近义改写**。写进门控只挡
  「同批重复 / 字面完全重复」，管不到「上个月写过的结论换个说法又交上来」。
- **两条统计路都证伪**（Lead 用真实数据做的实验，别再试第三次）：
  - 字符 2-gram Dice：6 条重复 vs 已有条目最高只有 **0.131**，而真正的新结论反而 **0.261** —— 排序与人眼**完全反着来**；
  - BM25 归一化（`merger.normalizedSimilarity`）：重复条 **0.074–0.203**，新结论 **0.059–0.505**，区间重叠到没法划线。
  - 旧注释里「[0.45, 0.95) 的 ADJUDICATE 一律放行」在这件事上是空头承诺：近义改写连 0.45 都到不了。
- **新层** `lib/dedupe.js`（`adjudicateNearDuplicates`）：在跨池预筛**之后**、归并**之前**，
  给每条 `scope=global|project` 候选取 BM25 top-2 近邻（**不设阈值**，全部送），
  一批最多 12 条**一次调用**判完；判成重复的候选**改判 NOOP**（稳定 `reason=model-near-duplicate`），
  不是从数组里抹掉 —— 运行报告与 `counts.noop` 都看得见「这条为什么没写」。
- **提示词**（`NEAR_DUPLICATE_RULES`，中文）：显式列「算重复」（换说法 / 语序调整 / 加修饰 / 上下位）
  与「**不算**重复」（同主题不同结论 / 冲突更新 / 只共享术语）；只回一个 JSON 对象
  `{"duplicates":[{"index","of","why"}]}`，不要解释段落、不要代码块围栏；近邻只给 **2 条**
  （多了模型会把「同主题」当「同事实」）。
- **成本与记账**：判重调用走 `pipeline` 的 `countingModel` 同一条路径 ⇒ `calls` +1、
  `chargeExtra()` 按真实调用数补扣日配额（一次判重 = 一次调用，不许绕过 60 次/天）。
  两个运行参数按「短文本判重」定：`maxOutputTokens: 512`（`llm.js` 新增单次覆盖）+ 最低推理档
  `off`（不被支持时由 `pickSupportedReasoningEffort()` 退到模型最低档，绝不盲传）。
- **降级纪律（绝不阻塞写入）**：模型没接线 / 抛错 / 超时 / 返回不是合法 JSON（含代码块围栏与寒暄，
  靠 `parseModelJson()` 容错）/ 形状不对 ⇒ **全部原样放行** + 原因码进 runlog 的
  `detail`（`dedupe:checked=N,dup=M,model-error|invalid-json|bad-shape`）。模型编出来的下标一律忽略。
- **开关** `dedupeModel`（默认 `true`，设置页「自动沉淀 · 高级」）：`false` = 一次都不调用，
  行为回到 0.6.1（**不是**更好的去重，只是更便宜）。`scope=journal` 候选不送判（事件流本来就允许同义反复）。
- **测试**：**26** 个用例全绿（新增 `test/dedupe.test.mjs`：改判 NOOP / 抛错 / 垃圾返回 / 开关不调用 /
  journal 跳过 / 512 与最低推理档 / 预算补扣；`pipeline.test.mjs` 与 `reject-consume.test.mjs`
  按「多一次调用、detail 多一段」做了最小调整）。
- **peer**：仍为 `>=0.7.0 <0.14.0`（本轮不动契约，只加一层写前判定）。

---

### 变更（0.6.0）：格式门 —— 长条目不许进静态槽

- **长度门**（`pipeline.routeByLength()`，纯函数）：正文（trim 后按字符计）**超过 160 字**的
  `global` / `project` 候选一律改判 `journal` —— 内容一个字不动，只是不再占每轮静态注入。
  接在分层改判与归属兜底**之后**、跨池预筛**之前**；`layers` 只在真发生时加 `reroutedLong`。
- **为什么是 160**：主插件压缩器「合并结果 ≤120 字」「逐条精简 ≤200 字且合计必须更短、具体值
  不许丢」。596 字那种「一段版本演进史」两条路都过不去 ⇒ 水位只涨不降。真实体检：项目记忆
  49 条里 22 条 >120 字、17 条 >200 字、最长 596，整体 99.66%。
- **抽取规则 9 / 10**：每条只写一个结论、正文 ≤100 字（超了拆条）；版本演进史 / 实现过程 /
  调试记录 / 文件清单一律 `scope=journal`。前 8 条规则一字未改。
- **runlog**：`layers` 白名单扩到五个数字（`conclusion` / `detail` / `rerouted` /
  `reroutedNoOwner` / `reroutedLong`），仍然只在真发生时落键。

---

### 变更（0.5.0）：归属兜底 + 拒绝不再丢内容

- **归属兜底**（`pipeline.routeByOwnership()`）：工作区归因不到（`_unassigned` 桶 / 注册表查不到，
  即 `writeCwd === ''`）时，`global` 与 `project` 候选**一律改判 `journal`** —— 不丢弃、不占静态槽。
  以前这种批次能直接写全局 FACT（本机 FACT 里 15 行英语语法污染就是这条路径），`project` 则被主插件
  拒掉、又因为 `failed > 0` 挡住消费 ⇒ 同一批素材反复重跑。runlog `layers` 在真发生时才多一个
  `reroutedNoOwner`（老的三键形状不变）。
- **提示词带真实 cwd**（`extractor.buildExtractionPrompt`）：以前只说「project = 跟当前目录有关」却不给
  目录值，模型只能猜；现在贴真实路径，未知时明确要求「这种批次一律写 scope=journal，不要写 global / project」。
- **拒绝降级**（`writer.rejectionOf()` / `handleRejected()`）：主插件 `assertEntry` 抛
  `MEMORY_ENTRY_REJECTED` 时按 `details.demote` 分派 —— `journal` ⇒ 补写一次 JOURNAL（记 demoted，
  runlog 带 `demoted:store-rejected:<reason>`）；`drop` ⇒ 记 FAILED 且**带 `details.reason`**。
  旧实现的 `error.code ?? details.reason` 因为 code 非空，永远取不到 reason。
- **永久拒绝不挡消费**（`writer.isRetryableFailure()` / `pipeline` 的 `retryableFailures === 0`）：
  永久拒绝重试一万次还是同一个结果，拿它挡消费只会把同一批素材钉在暂存区（本机实测 9 行 / 5323 字符
  重跑 13 次、25 次调用）；临时失败（LLM / 超时 / 写盘 IO）照旧阻塞、下轮重试。批次状态仍按
  「有 failed 就 FAIL」记，消费判定与展示口径刻意分开（不假装成功）。
- **测试**：24 个用例全绿（新增 `test/ownership.test.mjs`、`test/reject-consume.test.mjs`）；
  3 个既有用例的 fixture 按「归属已知才写静态槽」的新语义做了最小调整。
- **peer**：`@dsh-external/dsh-persona-memory` 上界升到 `<0.14.0`（主插件 0.13.0）。

---

### 变更（0.4.0）：分层、重要性、截断重试、访问回写

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

---

### 写入门控（0.4.0）：结论/细节分层、重要性、截断重试、访问回写

契约：`DESIGN-memory-lifecycle.md` v3 §10–§15。三件事各自独立、都能单独关，默认全开。
三个包各自实现同一套格式，本插件**不 import 主插件源码**，主插件的新 API 一律用
`typeof store.touchEntries === 'function'` 这类探测，老 store 上行为与 0.3.x 完全一致。

#### 抽取输出格式（§14.1）

规则新增 7、8 两条，输出 JSON 每条多两个字段：

```json
{"memories":[{"scope":"global|project|journal","content":"...","confidence":"high|medium|low","kind":"conclusion|detail","importance":3}]}
```

- `kind`：`conclusion`（结论/约定/红线）| `detail`（实现细节、一次性发现）；非法 ⇒ `conclusion`；
- `importance`：1–5（5=核心约定或踩坑红线，4=重要结论，3=一般结论，2=细节，1=一次性小事）；
  非法 ⇒ 3，越界收敛到 1–5（数字字符串也认）。**两个字段都不参与淘汰**：条目照收，只做路由与排序。

#### 结论/细节分层：`routeByGranularity()`

`runL1` 在 `gateBatch()` **之后**、跨池预筛**之前**调用（纯函数、零 LLM、零 IO）：

- `scope ∈ {global, project}` 且（`kind === 'detail'` 或 `importance <= 2`）⇒ **改判** `scope='journal'`；
- **不丢弃**、不计闸口丢弃：内容照样写，只是不占每轮全量注入的静态槽；
- 已判 `journal` 的原样通过（不重复计数）；未知 scope 不动（合法性由抽取侧与写入侧各自负责）；
- 返回 `{ candidates, rerouted }`；runlog 新增 `layers: {conclusion, detail, rerouted}`（只做观测）。
  `rerouted` 是改判那一步的计数，之后还可能被跨池预筛拦下，所以**不要求与 candidates 相加平账**
  （要求平账的是闸口的 `kept + dropped = total`）。

#### 重要性写入（§14.3）

`writer.entryOf(op)` 增加 `importance`：1–5 → **20 / 35 / 50 / 70 / 90**（非法 ⇒ 50），与
`{text, confidence}` 一起交给 `store.insertEntry` / `replaceEntry`。主插件 0.11+ 把它写进
`$DSH_HOME/memory/index.json` 侧车索引（0–100，缺省 50），用于淘汰评分与面板；**老主插件忽略该字段**
（不报错、不写入），所以正文格式零变化。归并可能改写正文，因此 `importance` 在归并**之后**
按 `content` 回匹配候选（`attachImportance()`），匹配不上（正文被模型改写）用缺省 3。

#### 访问回写（§11）

静态注入是全量的，所以「注入」不构成区分度；真正的「用过」信号来自写入侧：

- `NOOP`（有 `target`）：模型明确说「旧条目已经表达了同样的意思」⇒ 旧条目被重新确认；
- 成功的 `UPDATE`（两段式或原子替换）：旧条目被引用为改写目标。

两种情况都调 `store.touchEntries([{ scope: 'fact'|'memory', id }])`（scope 用 `toStoreScope` 映射后的
store 词汇）。**只写索引**：不改正文、不占写锁、`dryRun` 不写；没有 `touchEntries`（主插件 < 0.11）
就跳过；调用抛错**静默吞掉**，绝不影响本轮结果（索引回写失败绝不能让整批素材不被消费）。

---

### 截断重试（0.4.0）

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

---

### 现状（0.4.0）：哪些是真的

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

---

### 变更（0.3.1）：设置页补上「单次抽取输出上限」

- **问题**：`maxOutputTokens` 从 0.2.1 起就是 `Config` 字段、也一直写在本文的设置页表里，
  但它**没进** `SETTINGS_SPECS` —— 页面从不渲染它，等于「文档说能调、实际调不了」。
- **修复**：`lib/settings.js` 的「自动沉淀 · 高级」组补上该项（数字项，`min: 256`，`order: 134`），
  默认 `8192`。改完下一轮生效（`createCallModel` 每次调用现读 `config.maxOutputTokens`）。
- **为什么默认不调**：8192 已实测够 6 轮 / 1.6 万字符的桶；调小会让 `finish` 落在 `max-tokens`，
  本次抽取判 `LLM_TRUNCATED` 且一个字都不写——这比「写半截」安全，但丢了一次抽取。
- **测试**：`test/settings.test.mjs` 的数字项样例表补上该键；22 组用例全绿。

---

### 变更（0.3.0）：跨池去重、两段式失效、水位上限修复

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

---

### 写入门控（0.3.0）：跨池去重 + 两段式失效

0.2.x 的闸口只管「同批」噪声；0.3.0 补上「跨批」与「改写」两条链路，并修掉一个观测 bug。
前两项各有独立开关、默认全开，出问题时可以单独关（不必改代码、不必等发版）；水位上限是纯修复，没有开关。

#### 跨池近重复：`screenCrossPool()`

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

#### UPDATE 两段式失效

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

#### runlog 水位上限修复

`watermarks.*.limit` 过去恒为 `0`：`store.watermark()` 给的是**对象**（FACT `{lines, bytes}`、
项目 MEMORY `{chars}`），而旧代码用 `Number.isFinite(mark.limit)` 判，对象永远不是有限数。
现在按形状透传 `{lines, bytes, chars}`（未给的维度不补 0、未知键丢弃），标量输入仍原样保留
（向后兼容）。**纯显示口径**，不影响裁剪行为。

---

### 变更（0.2.0）：先过闸口，再认 store 的降级

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

---

### 变更（0.1.3）：归属改为路径优先 + 历史暂存回填

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

---

### 变更（0.1.2）：写侧为什么一直「静默失败」

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

---

### 已知边界（0.3.0）

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
- **跨池去重只挡确定性重复**：完全相同或 BM25 归一化相似度 ≥0.95 才会被拦。0.7.0 起「换一套词
  说同一件事」交给 `dedupeModel` 的模型裁决，但仍**不保证 100%** 拦住（模型也会漏判）——
  这是「宁可漏杀不可误杀」的取舍：漏一条重复的代价，小于把一条真新结论静默判死。
