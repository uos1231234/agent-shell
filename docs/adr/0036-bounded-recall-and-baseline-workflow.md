# ADR-036: 有界工具投影、超大召回转交与阶段式 Baseline

- **Status**: Accepted; baseline/report compatibility and workspace-gate portions implemented on 2026-09-19; D1 (20K tool-result projection), D2 (Databus token range/cursor), D3 (200K direct-recall ledger) and D4 (large-recall delegation) implemented on 2026-09-19 (commit 083a05b) at the protocol-conversion layer instead of loop.ts; D5 (structured recall report) implemented on 2026-09-20 (commit f50fdfd). See the 2026-09-20 implementation update, which corrects the 2026-09-19 entry's "design-only" claim.
- **Date**: 2026-09-19
- **Related**: ADR-016（canonical / Databus / StateLine 信息流）、ADR-017（子代理 Databus 边界）、ADR-031（工具级压缩与系统智能体记忆）、ADR-035（Goal 模式）、v0.42/v0.43 计划
- **Decision owner**: 用户拍板设计方向；核心 loop、工具结果投影和响应协议的具体实现需再次逐点批准

## Context

长代码任务中，工具结果和 Databus 召回有两个不同的风险：

1. 一次大工具结果可能直接把主代理上下文推到不可控范围。
2. 即使单次结果不大，模型也可以连续召回同一工具字段，把许多小结果累积成一次超大上下文。

当前实现已经具备工具 stamp、Databus 原文保存、历史工具回合折叠和 recall system agent，但边界仍不完整：

- **[已验证]** `history-tool-table.ts` 的旧结果折叠默认以约 2000 token 处理热窗口外结果，不能保护当前轮一次超大工具结果。
- **[已验证]** `databus-query.ts` 当前按 stamp/toolName/keyword/sourceAgentIds/time range 过滤，`limit` 是回合数量，不是 token 数，没有 token range、cursor 或直接召回累计预算。
- **[已验证]** `state-query.ts` 的 raw archive 分支可以读取完整原始消息，但同样没有模型可见 token 预算。
- **[已验证]** 子代理和 recall 的 handoff compaction 由自身 `maxTokens` 驱动，默认触发比例是 0.85，摘要 transcript 默认 300K；900K 是 M3 记忆层阈值，不是子代理摘要默认值。
- **[已验证]** Baseline 当前是三个 scout 并行的一次性 run；报告解析主要接受纯 JSON 或字符串开头的 fenced JSON，解释文字包围的 fenced JSON 会落成 `invalid-report`。

因此需要把“完整存储”和“有限投影”分开，并把“主代理直接读”与“召回代理代读”分开。

## Decisions

### D1. 所有模型可见工具结果采用 20K token-equivalent 投影上限

20K 是默认的单个模型可见工具结果上限，包含 marker。超过上限时：

- 完整结果仍写入 Databus/raw archive/ArtifactStore；
- 模型只收到保头、保尾和显式 marker；
- marker 写明原始 token 数、当前可见 token 数、被省略范围、stamp 和下一步读取方法；
- marker 不得暗示当前内容是全文；
- 召回工具的返回结果也必须经过同一投影器，不能因为它来自 recall 就绕过上限。

这是一个用户明确要求并且可审计的“有界投影”，不是静默丢弃。它与此前被禁止的无说明截断不同，因为原文保留、范围可追踪、恢复路径可见。

### D2. Databus 增加 token range 和 cursor，但保留既有时间 range 语义

`databus_query` 增加独立的 token range 和 cursor。时间范围继续表示事件时间，不与内容 token 范围复用同一个字段。

每个分页结果必须告诉模型：

- 当前返回的 token range；
- 原始总 token 数；
- 是否存在下一页及 cursor；
- 对应的 stamp 和 source agent；
- 返回模式是 `direct` 还是 `delegated`。

分页按 agent-shell 的统一 token counter 切分。第一版采用现有 `estimateTokens` 的 token-equivalent，并在日志和报告中标注该口径；provider usage 只做对照统计。

### D3. 200K 是主代理对同一内容的直接召回预算

一次 token range 超过 200K，或同一 stamp 的连续/重叠分页累计交付超过 200K，运行时都必须切换到 delegated 模式。

预算由服务端 ledger 统计已交付的非重叠范围。模型不能通过把 250K 拆成很多小请求绕过该规则。不同 stamp 的独立查询分别记账，避免把互不相关的证据错误合并成一个无法解释的预算。

超过预算时，主代理得到的是明确的路由结果和临时 recall agent 的摘要，不得到超过 200K 的原文。

### D4. 大召回复用 recall system agent，但使用调用级最小只读权限

不新增一个永久系统智能体类型。大召回复用现有 `createSystemAgent` 执行内核和 AgentTree 身份，但临时调用必须显式收窄到：

- `databus_query`；
- 必要时的 `state_query` raw/archive 读取；
- 其他只读证据工具（仅在确有现有存储需要时加入）。

临时代理不得使用 write/edit/search_replace/bash/powershell/run_subagent/network/mailbox。权限由运行时 `toolRefs`、`SubAgentToolPolicy`、`resolveCallerToolRefs`、SecurityRouter/SecurityDoor 和 workDir 边界共同强制，不能只写在 prompt。

### D5. 临时召回代理的摘要也必须有界且可审计

临时代理分页阅读完整 raw 内容，但每次工具结果最多 20K 可见 token。它使用自己的 handoff compaction：触发比例默认 `0.85 * self.config.maxTokens`，摘要 transcript 默认 300K；不使用 900K 作为摘要触发点。

临时代理最终返回：

- `facts`：事实和结论；
- `evidenceStamps`：原文证据戳；
- `coveredRanges`：实际阅读范围；
- `uncoveredRanges`：未覆盖范围；
- `confidence` 与 `openQuestions`；
- raw output 的落盘路径。

主代理看到的是这个结构化摘要的 20K 投影，而不是被阅读的全文。

### D6. Baseline 改成可恢复的三阶段工作流

每个 scout 按以下顺序推进：

1. `inventory`：读取 manifest、入口、边界和待读文件范围；
2. `evidence`：分页读取具体文件，写入 evidence ledger 和 raw JSONL；
3. `synthesis`：只消费 ledger、证据戳和必要范围，产出结构化报告。

三个 scout 仍可以并行，但每个 role 的阶段状态独立落盘。进程中断后，已完成阶段不重复读，未完成阶段从 checkpoint 继续。`baseline.json` 汇总返回值和审计位置，不能替代中间 checkpoint。

### D7. Baseline 报告解析采用“宽入口、严核心字段”

解析器支持纯 JSON、说明文字包围的 JSON、任意位置的 fenced JSON、`json` 或无语言 fenced block，以及已知字段别名。缺失非核心字段生成 warning；核心字段缺失、类型错误或 role 不匹配才返回 `invalid-report`。

无论解析成功还是失败，都保留 raw output。报告必须记录 `extractionMode`、`warnings`、原始路径和证据戳，避免把模型格式问题误判为代码探索失败。

### D8. 四个阈值不能混用

| 阈值 | 语义 |
|---:|---|
| 20K | 单个模型可见工具结果上限 |
| 200K | 同一内容由主代理直接召回的预算 |
| 300K | handoff compaction 摘要时间线预算 |
| 900K | 主会话 M3/context memory layer 阈值 |

它们属于四个不同的控制面。任何提示词、配置或代码注释把“子代理默认 900K 摘要”当作事实都视为错误。

### D9. 不改变 Goal judge 和现有安全门禁

本 ADR 不改变 Goal judge 读取完整 canonical 的当前语义，不改变 `DEFAULT_CONFIG`、guard、loop 的终止语义，不增加前端专属后端阈值，不启动后台 daemon。工作流和召回状态按 session 隔离；关闭工作流后普通模式和 Goal 模式继续使用同一历史。

### D10. 核心实现必须先过用户的逐点代码批准

以下实现点不能从本 ADR 自动推导为“已经获准修改”：

1. 在 `loop.ts` 工具执行后的信息流处分离完整 raw result 与 20K canonical/model-visible projection；
2. 将 `databus_query` 的裸数组响应改为带分页元数据的响应对象；
3. 在 system agent 工厂增加调用级 toolRefs/policy 收窄入口；
4. 改写 Baseline workflow 的 stage/checkpoint/store 接线。

这些是本 ADR 的实施候选点，写代码前必须向用户说明文件、函数、行为变化和测试范围，再得到直接“改”批准。

## Consequences

### 正面影响

- 单个异常大工具结果不会无提示地撑爆主代理上下文。
- 主代理无法通过重复小分页无限累积同一字段；超过 200K 后由专门只读代理承担阅读和压缩。
- 完整证据仍可通过 stamp、token range、raw archive 和 cursor 追溯。
- recall agent 的摘要不会因为 900K 误判而失去 compaction；它使用自己的 0.85/300K handoff 机制。
- Baseline 从一次性会话变成可恢复工作流，适合断网、进程中断和长代码任务审计。
- 20K/200K/300K/900K 四个指标可以直接进入长程实验报告，分别衡量投影、主代理召回、系统智能体压缩和 M3 归档。

### 代价与风险

- canonical 的工具结果可见形态会从“可能是完整原文”变成“有界投影”，需要同步 system prompt、工具描述和现有 fixture。
- 召回代理引入额外一次或多次 LLM 调用，延迟和 token 成本会上升；这是用隔离换主代理上下文可控性的明确取舍。
- 如果 token-equivalent 与 provider tokenizer 偏差较大，范围边界可能不是 provider 的精确 token 边界；因此必须在报告中同时记录两种 usage，后续再决定是否接入 provider-specific counter。
- 召回 ledger 需要可靠的 session/agent 键和恢复语义，否则重启后可能重复直接读取；第一版应把 ledger 落盘并在恢复时 fail closed 到 delegated 路径，而不是重置为零。

## Non-goals

- 不在本 ADR 中实现新的 M2 摘要形态。
- 不把 Databus 全量内容自动复制进主代理 prompt。
- 不为前端单独放宽时间 guard 或上下文 guard。
- 不创建新的独立 Benchmark UI、后台 daemon 或永久 large-recall agent。
- 不用 Mailbox、AgentTree 或 Databus 取代 `SystemAgent.run()` 返回值作为最终报告权威来源。

## Implementation update (2026-09-19)

本次只落地不触碰核心 loop/guard 的工作流边界修复，未把 D1-D5 的工具结果投影和大召回路由提前实现：

- src/host/workflow/report.ts 将 openQuestions 规范化为兼容的 string[]，同时保留对象形式的 verifyPath；finding 级 tools/commands/evidence、coveredRanges、uncoveredRanges 作为可选信息保存。
- 解析入口继续接受旧报告、字段别名、纯 JSON、fenced JSON 和说明文字包围的 JSON。旧格式不因缺少新字段失败；混合数组产生 warning；只有显式错误的 schemaVersion/kind、核心字段错误或明确的阶段冲突才进入 invalid-report。raw output 始终保留。
- `coveredRanges` / `uncoveredRanges` 保留行号范围和模型提供的字符串 `range`；三阶段 checkpoint 额外保存去掉 raw 文本后的结构化阶段报告，因此恢复不必重新解析唯一的 raw 文件。
- src/host/workflow/prompts.ts 让 inventory/evidence/synthesis 使用同一个外层报告形状，差异只由 stage 表达。它统一的是 scout 工作流协议，不替换 Goal judge、CuratedMemory、Mailbox 或普通工作代理自然语言协议。
- src/host/workflow/workspace.ts 在 baseline 启动前检查工作区存在、可读、为目录且非空；没有强制 package.json 等 manifest，只给 task-specific workspace warning。
- src/host/assembly.ts 在 workflow 开启且 baseline 未完成时拒绝正式 user.prompt。workflow 关闭后不改变普通模式或 Goal 模式，也不绕过原有权限门。
- 评测运行目录 的 runner 负责复制并确认 fixture，phase runner 在 baseline 失败时不再启动主模型。

已验证：`npm run typecheck` 通过；工作流/基线定向测试 `14/14` 通过；全量 Vitest `256` 个测试文件、`3026` 个测试通过，`1` 个 skipped、`1` 个 todo。覆盖旧格式、对象/混合 openQuestions、范围和证据兼容、阶段 checkpoint、空工作区阻断、disable no-op、三阶段恢复。没有修改 `src/im/loop.ts`、`src/shell/guards.ts` 或上下文组装顺序。

## Implementation update (2026-09-20, correcting the 2026-09-19 entry)

**[已验证] 上一条 update 中 "D1-D5 remain design-only / 未实现" 的表述与代码不符，在此更正。** D1-D4 的实现与 baseline 工作流同在 commit `083a05b`（2026-09-19 20:45）落地，生产接线测试在 `tests/host/v044-bounded-recall-wiring.test.ts`：

- **D1（20K 投影）已实现，落点是 `turn.ts` 而非 `loop.ts`**：`turnToMessageWithCounter`（`src/im/turn.ts:68-79`）在 Turn → ChatMessage 的唯一转换处对每个 tool 回合调用 `projectToolResult`（`src/im/tools/result-budget.ts`）：保头/保尾 + 显式 marker（原始/可见 token 数、省略范围、stamp、`databus_query` 继续读取参数），marker 计入 20K 预算（`MARKER_RESERVE` + 递归收缩正文）；canonical 与 Databus 仍存全文，恢复与精确召回无损。`appendToolResultWithProjection` 提供带投影的追加路径。**仍未修改 `loop.ts`、guard 或上下文组装顺序**——投影发生在协议出站层，D10 第 1 条（loop.ts 分流）以另一种接线方式达成同一目的。
- **D2（token range + cursor）已实现**：`databus_query`（`src/im/tools/databus-query.ts`）新增 `tokenRange`/`cursor` 参数；带范围或超页的查询返回 envelope（`records`/`returnedRange`/`totalTokens`/`nextCursor`/`mode`/`evidenceStamps`），小查询保留旧数组形状以兼容现有 fixture 与调用方；cursor 格式 `record:<index>:<tokenOffset>`；每页 ≤ 20K（`PAGE_RESPONSE_RESERVE_TOKENS` 预留响应开销）。
- **D3（200K 直接召回 ledger）已实现**：`createDirectRecallLedger`（`src/im/tools/databus-recall.ts`）以 stamp 或查询指纹为键，`mergeRanges` 合并已交付区间，`wouldExceed` 在交付前判定；把 250K 拆成多个小请求不能绕过累计预算。不同 stamp 独立记账，不合并成不可解释的全局阈值。
- **D4（大召回转交）已实现（assembly.ts 内联，未建独立模块）**：超限时 `ctx.largeRecall` 复用 `systemAgents.recall.run`，以 `toolRefsOverride: ['databus_query','state_query']` + default-deny `toolPolicyOverride` 收窄为调用级只读，快照 Databus 副本作为 `contextDatabus`，`directRecallLimitTokens: Infinity` 避免临时代理再被 ledger 阻挡。接线测试断言临时代理工具面恰好这两个、不含 write/bash。
- **D5 已实现（2026-09-20，commit `f50fdfd`）**：转交结果作为 tool 回合回到主代理，经同一 `turn.ts` 投影路径受限（≤ 20K）；新模块 `src/im/system-agents/large-recall.ts` 定义并强制结构化报告——`facts`（claim + evidenceStamps + coveredRanges + confidence）非空是硬要求（"找到了"不算命中），`uncoveredRanges`/`openQuestions` 记录盲区与验证路径，`rawOutputPath` 指向落盘的原始输出（`<stateDir>/large-recall/`）；解析宽入口（plain/fenced/embedded JSON + 字段别名）严核心，`guard-tripped` 与 `invalid-report` 同样保留 raw 可审计。计划 §5.3 的 `LargeRecallReport` 形状由此在运行时生效（与计划的差异：报告由解析器强制而非代理自觉遵守，且 `mode: 'delegated'` 与直接召回的 envelope 对齐）。
- **实战回放验证（2026-09-20）**：用当前解析器回放 09-19 `workflow-nongoal` 运行时被旧解析器全部判 `invalid-report` 的三份 scout 原始输出，全部解析为 `completed`（structure 12 findings / verification 8 / risk 11，`extractionMode=fenced-json`），仅模型写的 `startLine:0` 记 warning 后丢弃。

**[已验证]** `npm run typecheck` 通过；定向测试全绿——`tests/host/workflow.test.ts` 11 + `tests/host/v044-bounded-recall-wiring.test.ts` 4（投影上界、临时代理工具面、结构化转交报告与 raw 落盘、三阶段 checkpoint 与恢复不重跑）+ `tests/im/large-recall.test.ts` 8（解析宽入口/严核心/guard-tripped 落盘）；全量 Vitest `257` 个测试文件、`3035` 个测试通过，`1` 个 skipped、`1` 个 todo。

## Review triggers

满足以下任一条件时，需要新增或修订 ADR，而不是在实现中悄悄改变本决策：

- 需要让 Goal judge 直接读取 raw archive 而不是当前 canonical；
- 需要改变 20K、200K、300K 或 900K 的语义，而不仅是调整默认数值；
- 需要让临时召回代理写文件、运行 shell 或递归派代理；
- 需要把多个 session 的 recall ledger 合并；
- 需要把完整工具结果从 Databus/raw archive 删除，而只保存摘要。
