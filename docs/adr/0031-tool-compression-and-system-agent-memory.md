# ADR-031: 工具级压缩 + 交接笔记压缩 + warehouse 持久会话

- **Status**: Accepted
- **Date**: 2026-09-09
- **Related**: ADR-016（信息流架构）、ADR-017（子代理 Databus 边界）、ADR-028（args 落盘）、v0.30 计划（`docs/plans/v0.30-compression-and-system-agent-memory.md`）
- **决策者**：用户逐项拍板（2026-09-09），主代理按铁律先列状态机触点清单、逐点获准后实施

## Context

v0.29 验收发现三组问题，根因与方案在验收报告 + 主代理调研中确认：

1. **压缩触发时机**：driveCoordinator 只在工具轮末 fire、completed 路径不 fire、块判定要求 ≥1 工具轮——纯文本会话永远无法压缩，会话收尾无法压缩。
2. **工具级膨胀无即时处置**：单轮工具结果可引入数十万 token（实测 P99 单条 72K、最大 4 条占总量 88%）；M 层压缩（200K/500K/900K）是"事后块级"处理，tools 堆积到跨越之前没有算法级缓解；历史工具表算法级压缩（reason + tool_name + result 前 100 token）实测压缩率 34x–510x、大文件单条 3873x。
3. **子代理/系统智能体无压缩**：`run_subagent → createSystemAgent → runIMLoop` 全链无 driveCoordinator 也无 memoryConfig；长任务超阈值 = guard-tripped 丢工作。系统智能体为单发 fresh（每次 run 新建 ConversationMemory），warehouse 无法跨唤醒保持邮件对话上下文。

对标：KimiCode 是唯一有完整 TUI/压缩参考的实现——压缩嵌在 Agent 构造器（主/子代理同构天然覆盖），**自由文本第一人称交接笔记**（非 JSON schema），0.85 窗口触发，用户消息逐字保留（head 2K + tail 18K），摘要请求带溢出裁剪与 droppedCount 如实盲区上报。agent-shell 的 11 字段 CuratedMemory schema 是块级（M 层）格式，与交接笔记分工：**块级压缩删旧存新（上下文看不见）**；**笔记压缩折叠留痕（上下文看得见，模型以笔记继续）**。

## Decisions

### D1. 压缩调度统一每轮一次（B1/B2/B3）
- `loop.ts`：fire 从"工具轮末 + block-continue"两处收敛为 **finalizeRound 之后一处**，覆盖全部轮型（工具轮 / completed / synthetic）。
- tick 喂值 = **本轮协议层真实 usage**（`metrics.lastRequestTokens = usage.promptTokens`），轮初估算仅作 fallback。
- 同一改动修复既有估算盲区：`estimateContextTokens` 把 createMetrics 的 0 当已知值，导致无 lastMetrics 的新 run 首轮估算恒为 0、文本 fallback 永不触达——0 现在视为未知。
- **不引入新 guard/metric/config 字段**（ADR-015 纪律）——fire 点与喂值是调度时机，非守卫。

### D2. 块判定放宽（B4）
- `findNextTaskBlock`：**user→next-user 跨度本身就是块**，去掉"≥1 工具轮"硬条件——纯对话会话可以被压缩、会话收尾（completed fire）真正有意义。
- `validatePairing` 保留：含工具轮的块仍须防半块；纯对话块无配对对象自然通过。`toolTurnIds` 允许为空（evict 路径已对空集安全）。

### D3. 历史工具表（工具级算法压缩，D 机制）
- 触发：canonical 工具回合数超过热窗口 **20**（最近 20 条热区原样保留）后，窗口外 **result > 100 token**（CJK 感知口径）的批次折叠。
- 格式：一条 user-role turn，markdown 表格 `| reason | tool | result |`，reason 取 `args.reason`（运行时 canonical 保留 args；落盘剥离不影响——折叠发生在会话进行中），result 截断前 100 token。
- **纯算法，不调 LLM**；**databus 不动**——原始工具事件保留供关键字召回（用户拍板：召回兜底依赖 databus）。
- 正确性核心：折叠范围扩展为**完整批次**（声明 toolCalls 的 assistant + 其全部 tool 回合）——只删 tool 回合会造成孤儿 tool_call，下一轮 provider 400。相邻不重叠批次独立折叠；孤儿（找不到声明方）保守跳过。
- 执行点：**HOOK 5 afterToolExecution**（工具执行后、本轮 append 前）；`AfterToolExecutionContext` 增加可选的 `conversationMemory`/`databus` 引用（既有 hook 零影响）。**不放 driveCoordinator**——用户判断工具级压缩混入块级调度会让压缩机制过复杂。
- 压缩率（真实会话数据实测）：全量 34x、仅大块 47x、超大 4 条 510x、大文件 read 单条 3873x；token 高度集中（4 条占 88%），小结果（<100 token）进表反而膨胀——所以只压大块。

### D4. 交接笔记压缩（子代理 + warehouse + recall）
- **KimiCode 式**：`shouldCompact`（`promptTokens > triggerRatio × config.maxTokens`，默认 0.85）→ 序列化 assistant/tool 时间线 → LLM 生成第一人称交接笔记 → `replaceRange(0, len, 保留的 user turns + 笔记 turn)` 原位折叠。
- 用户消息逐字保留（`keepUserMessageTokens` 默认 20K，head 2K + tail 18K，中间丢弃计数并如实告知 LLM）。
- 摘要请求自身 bounded：transcript 预算 300K token，超限从最老行丢弃并注明盲区（对齐 KimiCode droppedCount 语义）——触发时上下文已 ~0.85×窗口，不裁剪摘要请求自身就会溢出。
- 装配点：`createSystemAgent` 的 `opts.compaction`——beforeShellCall hook（在 composePrompt 之前，折叠对本轮立即生效）；与转发 hooks 显式合并（压缩先跑、转发 hook 后跑，**不复用 mergeLoopHooks**——它会丢弃转发的 beforeShellCall）。
- 覆盖面：**run-subagent（子代理）、warehouse、recall**；compressor 单发固定输入**不装**。
- 摘要格式 = 交接笔记（**不并存** 11 字段 schema；用户明确"用交接笔记即可"）。

### D5. warehouse 持久会话
- `createSystemAgent` 加 `persistent?: boolean`：true 时 conversationMemory/databus 跨 run() 保留——warehouse 被多次唤醒（每次 M3 归档）时在上一轮状态上继续，邮件往来（读询问 → 回复）有上下文。
- 落盘：JSONL 全量快照，每次 run 结束原子重写（tmp → rename，旧文件留 .bak），工厂构造时读回（容忍截断尾行）。路径 = **`<dataDir>/<sessionId>/state/warehouse-session.jsonl`**，由宿主装配层用 `sessionStore.stateDir` 计算；落盘位置按用户要求在 `system-agent-persistence.ts` 顶部注释向所有人明示。
- 跨 run usage：工厂闭包维护 `lastKnownRequestTokens`，经 `initialMetrics.lastRequestTokens` 传给下一 run 的轮初估算——否则持久会话每次唤醒的压缩触发退化到文本估算（对中文低估 3-6x）。
- 本期**不做落盘会话的跨进程恢复**（重建成本低，state-line 才是 warehouse 的持久记忆主源）。
- 只 warehouse 开 persistent；compressor/recall/子代理保持单发 fresh（默认行为零变化）。

### D6. 状态机铁律的遵守方式
- 全部状态机触点（fire 时机、completed 路径、喂值、块判定、HOOK 5 canonical 修改权、beforeShellCall 折叠）**逐项列入请示清单，用户逐点批准后实施**；未超出批准范围。

## Consequences

- 纯对话会话（无工具）现在会被压缩（B4 + B2）——M 层压缩从"工具驱动"变为"对话驱动"。
- 工具表折叠把上下文中的工具历史变成可检索摘要；细节 100% 可从 databus 关键字召回（databus 是权威，表是索引）。
- 子代理长任务不再以 guard-tripped 丢工作：0.85 触发 → 折叠 → 继续。
- warehouse 成为有记忆的仓库管理员；落盘文件是它的跨进程记忆载体（本次仅进程内 + 落盘，恢复读回已支持）。
- 测试面：+6 个测试文件（replaceRange / compaction-engine / history-tool-table / system-agent-persistence / loop B3 语义 / drive-coordinator B4）→ 全库 2207 tests 绿，tsc 0 错，逐 commit 验证编译。
- 已知限制：① 工具表折叠只装配在工作代理 loop（子代理有交接笔记兜底）；② warehouse 落盘是会话级文件，不参与会话删除的孤儿清理（与 state/ 目录同生命周期）；③ 交接笔记是 LLM 摘要，失败静默重试（下一轮 beforeShellCall 再试）。

## 验证摘要

- 单元/集成：6 个新测试文件 + 3 个既有测试文件语义更新。
- e2e 探针（真实 host assembly + mock）：M3 归档唤醒 warehouse → 持久会话落盘（2 turns：归档 digest + 回复）`[已验证]`；headless --mock --yolo 全链路（write/审批/完成）`[已验证]`。
- 大文件 read 场景压缩率（真实会话数据外推）3873x `[已验证，脚本事前算过]`。
## 修订（v2，2026-09-09 用户第二轮拍板）

### D7. 工具表折叠统一装配面
`createSystemAgent` 的 `opts.compaction` 同时装配 afterToolExecution 工具表折叠——子代理与 warehouse/recall 获得与工作代理一致的工具级保护。工厂是子代理与系统智能体的唯一构造点（核实 [已验证]：只有 `system-agents/index.ts` 与 `run-subagent.ts` 两个消费方），一处装配全覆盖，无接线层零散注入。

### D8. 系统智能体私有 databus 完整落盘
用户拍板："warehouse 等系统智能体的私有 databus 也要完整落盘，因为他们的信息其实才是最宝贵的"。落盘文件 = `<state>/warehouse-session-databus.jsonl`（persistPath 去 `.jsonl` + `-databus.jsonl`），与 conversation 同策略（原子重写 + .bak + 容错加载）。外部注入的 databus（子代理共享 bus）不落盘——属于父会话。核实 [已验证]：系统智能体的 `databus_query` 读的是私有 bus（无 sharedDatabus），主会话工具事件不可见——私有 bus 是它们唯一的工具活动记录，落盘价值由此而来。

### D9. mailbox 修法 A：系统智能体注册进 agentTree
用户拍板。现状核实 [已验证]：mailbox 带树时 `verifyRoute` 对未知发送方 fail-closed（`tree.ts:132-136`），而 warehouse/compressor/recall 从未注册节点——**系统智能体的 LLM-facing mailbox_send 全被拒绝**（只有 drive-coordinator 的 systemSend 单向通知可达），"回复邮件"在完整装配下不存在。修法 A：`attachHandle` 里 `registerChild(workingAgentId, 'warehouse'|'compressor'|'recall')`——与 root 成 parent-child、系统智能体互成 sibling（协作邮件恢复）、与子代理成 sibling（可通信）。per-session tree 保证并发会话隔离（用户关切"一组系统智能体只为一个会话服务"——核实 [已验证]：createSystemAgents/Mailbox/driveCoordinator 全部在 attachHandle 内 per-session 创建，openHandles 幂等去重，无模块级单例；并发了并发 create + M3 归档探针验证各自落盘互不串扰）。

### D10. 压缩失败重试 + 分级上报
用户拍板：压缩失败 → 自动重试 3 次、间隔 15 秒（`compaction.retryLimit`/`retryDelayMs` 可配，测试注入小值）→ 仍失败：
- 系统智能体（warehouse/recall）：mailbox systemSend 通知工作代理"应用程序错误"（呈现通道依赖 D9 修复后的 mailbox 通路）；
- 子代理：通知调用者（`workingAgentId` = run-subagent 传入的父 ctx.agentId），让主代理自行接管——子代理输出通道本就通，此报错走 mailbox 双通道。
重试预算每 run 独立；上报失败静默（mailbox 不可达不阻断）。

### 验证（v2）
单测 +8（databus 落盘/注入不落盘、重试 3 次上报、子代理上报、mailbox tree 5 例：注册前拒绝/注册后可发/sibling/子代理↔系统智能体/per-session 隔离）；探针 [已验证]：两会话并发 attach + 各自 M3 归档 → 各自 `warehouse-session.jsonl`（2 lines）+ `-databus.jsonl`（1 line）落盘。全库 2215 tests 绿 / 190 文件 / tsc 0 错。探针调试中发现：mock streamChat 的 write 剧本全局只出现一次（callCount 闭包跨会话共享）——真实 LLM 无此特性，属 mock 剧本限制，非架构缺陷。
