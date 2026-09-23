# ADR-035: goal 模式——beforeComplete 接缝、独立 judge 与 goal 专属压缩梯度

> Status: Active
> Date: 2026-09-14
> Context: v0.41。长程任务（DeepSWE 式评测、"把这两个文件都写出来"）需要
> harness 在模型自称"做完了"之后**自己核实一遍**，没做完就继续。三家参考
> 实现（MiMoCode/opencode 的 `goalGate()` + 独立 judge、KimiCode 的
> `TurnFlow.driveGoal` + 主模型自判 `UpdateGoal`、atomcode 的独立 evaluator
> + `goal_continuation_message`）都指向同一个结构分歧：**谁来判**。本 ADR
> 记录我们的选择及其连带产生的压缩问题。
>
> 计划全文（含 23 项逐条拍板记录 D1–D23）：
> `docs/plans/v0.41-goal-mode.md`。
>
> **编号约定**：本 ADR 各节标题用自有编号 §1–§11；正文中出现的 `D#` **一律指
> 计划文档的拍板编号 D1–D23**，两套编号不通用（代码注释里的"计划 D11"同理指
> 计划编号，不是本文 §11）。

---

## Context

### 三个既有事实（[已验证]）

1. **轮次结束只有一个判定点**：`loop.ts` 的 `if (finalResult.toolCalls.length === 0)
   return { reason: 'completed' }`——模型不再发工具调用即视为完成，harness
   不参与判断。这是"最小接入口径"的唯一可用接缝。
2. **现有 5 个 hook 无一可用**：HOOK 1 在每轮开头（无法阻止上一轮已 return）；
   HOOK 2b 的 `syntheticResult` 是替换 assistant 输出（靠伪造 tool_calls 续跑
   会在 canonical 里留下假工具回合，轨迹说谎）；HOOK 3 只有 `forceTerminate`
   且跑在 `finalizeRound` 之前；HOOK 4/5 只在 `toolCalls.length > 0` 时可达。
3. **压缩是跨越驱动的**：M1 每跨一次 200K/500K/900K 阈值派发一个块，M2 派发
   已下线（§6.1），只有 M3 sustained 每 tick 压。200K–900K 之间实际是死区。

### 由 goal 模式产生的新问题

续跑回合由 **harness 而非用户**生成。这打破两个隐含假设：

- **块边界假设**：`findNextTaskBlock` 以 user→next-user 切块。续跑提醒若是
  user 回合，就会把一个 goal 轮切成两半；若不是 user 回合，块就没有结束边界。
- **压缩触发假设**：跨越驱动依赖"上下文缓慢增长"。goal 模式下一次大输入分析
  可能瞬间从 0 冲到 500K，跨越点被跳过，而 200K–900K 死区里没有任何机制在跑。

---

## Decisions

### §1 — 新 hook `beforeComplete`，不复用现有接缝

`loop.ts:1001` 的 `[HOOK 6]` 位于既有 `toolCalls.length === 0` 分支**内部**、
`return { reason: 'completed' }` **之前**。hook 返回 `continueWith` 时，harness
追加一个 user 回合并 `continue`；返回 undefined 时逐字节走原路径。

**这是 goal 模式对状态机的全部改动。** 不加 `IMLoopOptions.goal` 字段、不加
新终止原因、不改 guard、不改 `finalizeRound` 与 `fireDriveCoordinator` 的相对
位置（两者仍在 hook 之前跑完，所以 judge 看到的是本轮已完全落定的 canonical）。

**理由**：用户拍板"压缩语义也变化值得一个 hook 了"。语义上 `beforeComplete`
回答的是"这一轮真的可以收尾吗"，与既有 5 个 hook 的问题域都不重叠；复用任何
一个都会把两件事耦在一处。

### §2 — 独立 judge，看全量 canonical，用当前激活 provider

判定者是**独立单发调用**（`src/im/goal/judge.ts`）：`toolRefs: []`、无压缩、
严格 JSON 契约（`verdict ∈ {met, not_met, impossible}` + 非空 `reason`）。不给
主模型 `update_goal` 工具。

- **为什么不让主模型自判**（KimiCode 路线）：被测场景里主模型有偷懒动机——
  它正是那个想早点收工的主体。
- **为什么看全量**：与工作代理同视野、零截断。代价已知并接受：每 goal 轮一次
  全上下文调用，总成本 = `maxRounds × 全上下文`。
- **为什么不换模型**："独立"由独立调用 + 无工具 + 只判不做工的提示词保证，
  不靠换模型；`resolveLlm()` 每轮热解析当前激活 provider（D18），零新配置面，
  且跟随 `/provider` 热切换。
- **为什么不装压缩**（对计划的刻意偏离）：装了压缩，judge 审计的就是交接笔记
  而非证据本身——判定者的视野被自己人的压缩污染。单轮超大时 judge 诚实失败
  （见 §6），下一轮 G1 压完自愈。

### §3 — `goal-` 回合是**正常块边界**，`findNextTaskBlock` 零改动

续跑提醒以 `goal-<uuid>` 前缀的 user 回合落进 canonical。曾考虑像 `mem-`
信封那样把它标为非边界，**核实为致命**：`endIndexExclusive` 会永远停在 -1，
`no-eligible-block` 永久成立，上下文无界增长直到撞 1M guard。

正确解法是承认语义：**一个 goal 轮 = 一个连贯任务块**（用户提问 → 模型工作 →
模型收尾 → judge 裁决 → harness 追问）。于是块边界天然存在，切块逻辑一行不改。

配对安全性由构造保证：提醒只在 `toolCalls.length === 0` 时注入，此时
`finalizeRound` 已追加无工具调用的 assistant 回合、所有工具结果也已落定，
不存在半块。

### §4 — goal 专属压缩梯度 G0/G1/G2/G3

| 档 | 触发 | 机制 | 成本 |
|---|---|---|---|
| **G0** | 块 < 80K 且上下文 < `m1MinTokens` | 不动（热窗口） | 0 |
| **G1** | **A**：块 ≥ 80K token；**B**：上下文 ≥ `m1MinTokens`（默认 200K，复用既有常量） | **确定性本地合并**，不调 LLM | 0 |
| **G2** | 连续 `mem-` 信封 ≥ 4 个且合计 ≥ 40K token | LLM **保守合并** N→1 | 一次调用 |
| **G3** | 既有 M3 sustained | 既有归档路径，未改 | 不变 |

**G1 为什么可以是纯算法**（`src/im/goal/block-merge.ts`）：它产出
CuratedMemory 11 字段，但三个 `working_state` 数组留空、`status_hint` 恒为
`PENDING`——因为 goal 轮的定义就是"还没做完"。`conclusion` 取最后一条非空
assistant 文本**逐字全量**，`causal_steps` 用箭头记法，`evidence_fragments`
只收真实 user 回合的头部锚点（`goal-` 提醒不产证据）。

**G1 完全不设字数上限**（D9，用户拍板）。压缩率只来自"丢弃输入材料"：80K
材料的块约 25:1，长回答块 1:1。后者交给 G2 兜底。

**G2 的 N→1 提供与块形状无关的压缩率下界**——这是 D9 能成立的前提，两者是
**因果关系不是并列**（D13）：G1 保真 → G2 压的是高保真信封 → 单次损失而非
复利损失。所以 G2 的输入是**信封原文**而不是 raw-archive 原文。

### §5 — goal 激活时与既有块压缩**互斥**，M3 归档与 `lastLayer` 记账保留

`drive-coordinator.ts:815` 的守卫放在 M3 归档驱动**之后**：

```ts
if (deps.goalModeActive?.() === true) {
  log.debug('tick: block compression handed to goal path', { ... })
  lastLayer = layer
  return
}
```

`goalModeActive` 是 getter（`() => assets.goal.current !== undefined`），因为
`/goal` 可以在运行中开关。

**为什么必须互斥而非并存**（[已验证]）：两条路径共用 `inFlightBlockKey` 与同
一个 canonical 数组，并存会争抢；更关键的是既有路径产出的是**带字数上限的**
compressor 块，goal 路径产出的是**无上限的** G1 块——同一个块被两种口径压，
损失不可分析。

### §6 — 失败一律 fail-open，且**如实说失败**

- **judge 失败**（D15，用户否决了主代理推荐的 fail-closed）：续跑，提醒的
  `#JUDGE_REASON` 写 `judge 调用失败：<err>`，**不得编造未达成理由**——否则
  工作代理会照着假理由改方向。同时 `round` 事件的 `verdict` 字段带着
  `judge_failed` 与错误文本（不单发一个 judge_failed 事件——那会用两个事件描述
  同一次裁决），让"这次判定不可信"对 CLI/前端可见。提醒里的 `#NOTE` 用独立文案
  明确区分"判定没跑成"与"判定你没做完"。
- **G2 失败**（D16）：降级为不折叠，`log.warn` + `distill_failed` 事件，下轮
  再试。G2 是比例优化不是正确性要求（G1 已保证上下文有界），不引入 mailbox
  上报链路。
- **`maxRounds` 耗尽**（D17，默认 24）：**不调 judge**直接短路，发
  `rounds_exhausted`，loop 的 `reason` 仍是 `completed`（约束 4：不新增终止
  原因）。`maxRounds` 计的是**分歧循环次数**而非 LLM 轮数——一个 goal 轮内部
  可以有任意多 LLM 轮。

### §7 — 删除 M1 compressor 的字数上限

`src/im/prompts/compressor-agent.md` 的三处上限（2000 字符块上限、200 字符
证据片段上限、两句结论上限）与 `causal_steps`/`evidence_fragments` 的
`minItems: 1` 全部删除，换成一条规则：**压缩来自结构化，不来自删减事实**，
并列出必留清单（含**被否决的方案**——它们是"不要再试一次"的唯一记录）。

**理由**（用户原话）："字数限制毫无意义本质也是截断信息，填字表本身就能压缩，
因为信息传递效率高。"这与工作区铁律"不准截断信息"同源：字数上限就是一种
静默截断，而 11 字段结构化本身已经提供压缩。

代码侧只加**可观测**（D12）：产出块 > 原块 50% 时 `log.warn` 带 stamp 与两个
token 数。不加 cap、不拒绝、不重试——压缩率是测出来的，不是限出来的。

### §8 — G2 块标 `'M1'`，不动 `selectStateLineBlocks`，留【恢复点】注释

G2 产出的是"多个 M1 块合并成的块"，语义上接近 M2。但 M2 派发已下线、其标签
块在投影里有可见性缝隙（`selectStateLineBlocks` 的 M1 层只查 M1 块）。所以
G2 块标 `'M1'`，并在 `distillEnvelopes` 内留下 4 步【恢复点】注释，说明 M2
形态上线后如何迁移（`drive-coordinator.ts:895` 与 `:915` 附近）。

### §9 — 协议层出站转写，由 provider 能力开关门控，不做 400 自愈

goal 块合并后角色序列会出现 `[envelope-user, next-user]` 连续 user（工作区
AGENTS.md §6.27 ④ 已预言）。OpenAI 兼容栈接受，**Anthropic 严格交替会 400**。

- 规则在 `src/protocol/messages.ts` 的 `normalizeStrictAlternation`：**只合并
  相邻 user 消息**（tool/assistant/system 刻意排除，各有理由并写在注释里），
  无损 `\n\n` 拼接，空段跳过，处理 ContentPart。
- 唯一应用点在 `src/shell/call.ts:87`，由 `ShellDeps.strictAlternation` 门控。
- 开关来源 = `ModelCapabilities.strictAlternation`（`providers.json`），**缺省
  false = 不转写**，所以既有 OpenAI 兼容会话的 wire 形状逐字节不变。
- 经 `IMLoopOptions.strictAlternation`（`loop.ts:185`）→ `SessionLoopBase`
  （`session/types.ts:167`）→ `buildLoopOptions` 条件展开透传，装配层逐轮热
  解析（跟随 provider 热切换）。
- `lastRequestTokens` 的文本回退口径同步改用 `wireMessages`（`call.ts:165`），
  否则估算的是没发出去的那个形状。

**不做 400 自愈**（用户拍板"只要开关，不加自愈"）。代价已知：未声明该能力的
严格 provider 会持续 400 直到手动声明。与 v0.32 的 reasoning 400 自愈不同——
那个自愈剔除的是**可选增强字段**，这里的转写改变的是**消息结构**，静默改写
结构比报错更难排查。

### §10 — 专用 `goal.changed` 出站信号 + `goal.set/clear/get` 入站命令

`GateSignal` 加 `goal.changed { sessionId, event: GoalEvent }`，`GateCommand`
加三个 goal 命令，`SignalGateHandlers.goal` 走 optional-handler 模式（provider
先例）：未提供时命令抛干净错误。状态持有者是宿主装配层（`GoalSessionState`），
gate 保持纯路由——`permission.full → permission.changed` 同模式。

`GoalEvent` 9 个成员承载不变量：**一次裁决恰好产出一个事件**。

`webapp` 本期只做保持 tsc 绿的最小改动（`timelineEntry` 与 `reduceSignal` 各
一个 case）。**这是约束不是遗漏**：`TimelineEntry.detail: string` 必填且
switch 无 default，不加 case 则 `session-store.ts` 编译失败。待同步清单见
计划 §9（7 项），随验收报告交付。

### §11 — 提醒不喂料

续跑提醒只带"继续 + judge 理由"（`src/im/goal/reminder.ts` 的
`#GOAL_CONTINUATION / #OBJECTIVE / #ROUND n/N / #VERDICT / #JUDGE_REASON /
#NOTE / #END_GOAL`）。**不切块喂材料**——材料切块是基准驱动（headless
`-p --resume` 或首条 prompt）的职责，agent-shell 不新增材料存储、切片器、
进度游标。

`#OBJECTIVE` 每轮逐字重述（D23）：goal 条件通常一两句，24 轮重述成本可忽略，
而它是"原始 user 块被逐出后 goal 仍然活着"的唯一保证。

`stripMarkerLines` 只从 **judge 的 reason** 里剥信封标记（宿主应用
`stripBlockMarkers` 先例），绝不碰用户的 goal 条件原文。

---

## Consequence

- **状态机改动面 = 一个 hook 调用点**（`loop.ts:1001-1035`）。goal 未激活
  且 `strictAlternation` 未声明时，行为逐字节不变——既有全部测试零修改通过，
  这是"最小接入口径"的硬判据。
- **压缩语义分叉**：drive-coordinator 现在有两个块产出路径（跨越驱动 /
  goal 驱动），由 `goalModeActive` 互斥。M2 形态上线时需要同时处理两条路径的
  zone 语义（【恢复点】注释已记）。
- **成本模型**：goal 模式的额外开销 = 每 goal 轮一次全上下文 judge 调用 +
  G1 零成本 + 偶发 G2 调用。`maxRounds=24` 是上限而非预期值。
- **新增模块**：`src/im/goal/`（types / reminder / judge / block-merge /
  distill / hooks / index）+ `src/protocol/messages.ts` + 两个提示词
  （`judge-agent.md` / `distill-agent.md`）。
- **验证**：见 `docs/v0.41-验收报告.md`。

---

## Amendment (2026-09-15) — v0.41 后续补丁

> 计划：`docs/plans/v0.41-followup-compression-and-dedupe.md`
> Commit：`8edd56f`

### A1 — G1 watermark 线加 floor=10K 前置门

**问题**：探针实测 17 tok 块 → G1 信封 187 tok（净增 170，比例 0.09x）。watermark 触发选最旧已关闭块，可能恰好是小块，合并反而膨胀上下文。

**决策**：`shouldMergeGoalBlock`（`block-merge.ts:194`）watermark 分支加 `blockTokens >= floorTokens`（DEFAULT=10_000）前置门。size 分支（80K）不动。

**数据支撑**：floor 梯度实验（2026-09-15）——5K 纯回答 ratio=0.84x（膨胀），5K 结论主导 ratio=0.96x（膨胀），10K 输入主导 ratio=3.11x（压缩）。floor=10K 过滤掉所有膨胀块。

### A2 — G2 位置触发 400K+≥2块

**问题**：结论主导块 G1 ratio≈0.97-1.24x 压不动，只有 G2 的 N→1 有与形状无关的下界。现状 4块/40K 双门槛在上下文 400K 时仍不触发（块数不够），只能等 1M guard。

**决策**：`findDistillRun`（`distill.ts:76`）入参改阈值对象；`hooks.ts:151` 按压力选档：`ctx.lastRequestTokens >= 400_000 ? { minBlocks: 2, minTokens: 0 } : { minBlocks: 4, minTokens: 40_000 }`。

**用户拍板**：400K + ≥2块（2026-09-15）。

### A3 — 切块与 goal 互斥

**问题**：切块把大文本拆成多个独立回合（chunk1 立即启动，chunk2+ 排队等 turn.end），goal 假设一个 prompt = 一个完整任务（runIMLoop 续跑多轮直到 met/exhausted 才发 turn.end）。同时启用时 judge 只看 chunk1，chunk2+ 被阻塞直到 goal 完成，语义矛盾。

**决策**：`goal.set` 时检查切块启用 → 拒绝（`gate.ts:414-420`）；`chunk.set` 启用时检查 goal 激活 → 拒绝（`gate.ts:439-445`）。

**用户拍板**：互斥，不能同时启用（2026-09-15）。

### A4 — (b) userTemplate 幽灵重注入：已修

**问题**：`omitUserTemplatePart` 内容扫描判据（`turns.some(content === userTemplate)`）在 u1 被 G1 逐出后失效，每轮尾部重新注入全文（幻影）。探针实测确认 BUG（`examples/usertemplate-dedupe-probe.ts`：G1 逐出 u1 后续跑轮 lastUser 仍含 MARKER）。

**决策（2026-09-15 用户拍板修复）**：判据从内容扫描改为**构造性事实** `userTemplate !== ''`（`loop.ts:290`）。入口 append 无条件（`loop.ts:693`），故"userTemplate 非空" ≡ "本轮用户文本已落 canonical"——不需运行时重推导。u1 逐出后**不复活**：模型视野 = canonical = 信封 `evidence_fragments` 头锚（`inputKeepTokens` 默认 1K），u1 全文在 raw-archive 经 `state_query({stamps})` 按戳召回。

**为什么不是信息损失**：① 幻影是 live-only（恢复/resume 从 canonical 重建，幻影消失，现状本身在 live 与 resumed 间不一致，修复消除它）；② 重注入抵消压缩（G1 逐出 u1 省下的上下文每轮被塞回）；③ 1K 锚点 + raw-archive 召回是压缩机制的设计可见性，"压缩就是压缩，召回是另一回事"。`inputKeepTokens` 保持 1K 不动（探针实测扩到 5K/∞ 会让 G1 压缩率从 3.11x 塌到 1.39x/0.98x，不可取）。

**测试**：`tests/im/replay/goal-continuation.replay.test.ts` 测试 E（模拟 G1 逐出 u1 → 断言续跑轮请求不含 'TEMPLATE'）。已验证非假绿：临时回退判据为 `return false` 时测试 E 变红。既有测试 D（续跑轮恰好一次）+ `loop.test.ts` v0.27（multi-round exactly once）零修改通过（u1 未被逐出时行为不变）。

### A5 — 前端同步 7 项全落地

**改动**：GoalControl 🎯 composer 控件 / SessionView.goal 忠实投影 / GoalMarker 续跑分隔条 / ProviderPanel strictAlternation 开关 / CLI 状态栏 🎯 n/N。真浏览器 E2E 验证全链闭环。

**接线点**：见 `docs/v0.41-验收报告.md` §6（已更新为"全部消费"）。
