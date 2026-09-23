// v0.21 Signal Gate — 信号类型定义（P0 核心）。
//
// Signal Gate 是 agent-shell 的对外信号基础设施：把 loop / session / 审批 /
// 提问 / 渲染产物 / 日志等内部事件收敛为三种通道，供宿主前端（宿主应用
// webview / 浏览器桥）消费。实现见 gate.ts；本文件零运行时依赖。
//
// 三种通道（信息流方向不同，绝不混用）：
//   1. 出站事件 GateSignal   — 后端 → 前端，fire-and-forget（emit/on）。
//   2. 请求-应答 GateRequest — 后端挂起等前端回包（request/resolve），
//      超时 fail-closed（默认 300s，与 approval-hook 的超时语义对齐）。
//   3. 入站命令 GateCommand  — 前端 → 后端，command() 路由到宿主注入的
//      handlers，返回 Promise 作为回执。
//
// 依赖纪律：
//   - 全部 import type —— 不引入任何运行时依赖。
//   - 只引用真实源码类型（IMLoopResult / ToolTurn / ApprovalRequest /
//     ArtifactHandle / LogLevel / SessionHandle / SessionInfo），不自造平行类型。

import type { ArtifactHandle } from '../rendering/base.js'
import type { ToolTurn } from '../im/databus.js'
import type { IMLoopResult } from '../im/loop.js'
import type { ConversationTurn } from '../im/conversation-memory.js'
import type { ApprovalRequest } from '../im/tools/security/approval-store.js'
import type { RequestUserInputQuestion } from '../im/tools/request-user-input.js'
import type { LogLevel, LogFields } from '../shared/logger.js'
import type { SessionHandle, SessionInfo } from '../im/session/types.js'
import type { ProviderCatalog, ProviderConfig, ProviderListResult, WriteResult } from '../config/types.js'
// v0.25 Wave B: mcp/subagent/settings/extensions 命令引用的真实源类型
// （全部 import type——零运行时依赖纪律不变）。
import type { McpServerConfig } from '../mcp/config.js'
import type { McpListResult, McpWriteResult } from '../mcp/write.js'
import type { SubAgentConfig } from '../im/sub-agent/config.js'
import type { DatabusSettings } from '../config/databus-settings.js'
// v0.41 goal 模式：GoalEvent 是出站信号 goal.changed 的载荷，GoalState 是
// goal.get 的回执形状。两者的事实源在 src/im/goal/types.ts（阈值与语义都在那）。
import type { GoalEvent, GoalState } from '../im/goal/types.js'
import type { BaselineRunResult, WorkflowRunEvent, WorkflowState } from '../host/workflow/index.js'

/**
 * 提问问题的真实类型是 request-user-input.ts 的 RequestUserInputQuestion；
 * 这里以协议层的名字导出，供前端桥使用。
 */
export type AskQuestion = RequestUserInputQuestion

// ============================================================================
// 1. 出站事件（后端 → 前端，fire-and-forget）
// ============================================================================

/**
 * 出站信号联合类型。字段来源（真实类型映射）：
 *   - assistant.delta / thinking.delta ← StreamChunk('content_delta').text
 *   - tool.result ← ToolTurn（databus 的 canonical 工具结果投影）
 *   - artifact ← ArtifactHandle（渲染基座 handle）
 *   - turn.end ← IMLoopResult（runIMLoop 的完整返回）
 *   - log ← Logger 的 LogRecord 语义（level/msg/fields/ts）
 */
export type GateSignal =
  | { kind: 'assistant.delta'; sessionId: string; turnId: string; text: string }
  | { kind: 'thinking.delta'; sessionId: string; turnId: string; text: string }
  | { kind: 'tool.started'; sessionId: string; turnId: string; toolName: string; callId: string; args: unknown }
  | { kind: 'tool.result'; sessionId: string; turnId: string; toolName: string; callId: string; result: ToolTurn }
  | { kind: 'artifact'; sessionId: string; handle: ArtifactHandle }
  | { kind: 'turn.end'; sessionId: string; result: IMLoopResult }
  // v0.34 C1（用户拍板 2026-09-10，D9）：该会话**排队中**的用户消息条数变更。
  // 排队的是用户自己的消息，必须让前端看得见。这是**权威状态广播**（单一真相源）
  // ——前端镜像 pending 即可，不自己推算：入队 / 出队 / 取消丢弃 / 会话关闭
  // 都会发一条，前端因此不会因漏掉某条转移而显示错状态。
  | { kind: 'turn.queue'; sessionId: string; pending: number }
  // session.event 是自由事件通道，保留 event 名（system.prompt / tools）。
  | { kind: 'session.event'; sessionId: string; event: string; data?: unknown }
  | { kind: 'memory.activity'; sessionId: string; activity: string; detail?: unknown }
  // per-session 权限状态推送（宿主在 session.open/create 与 permission.full
  // 生效后发射）——UI 是信号的忠实投影，前端不再本地乐观猜状态。
  | { kind: 'permission.changed'; sessionId: string; full: boolean }
  // v0.32：服务商/模型/档位目录快照广播（宿主在 provider.* 写命令成功后
  // 发射）——多客户端同步，permission.changed 同模式；catalog 由宿主解析好
  // 有效思考能力，前端零推导。
  | { kind: 'provider.changed'; catalog: ProviderCatalog }
  // v0.33b：知识卡片库变更广播（wiki.addCard 成功后发射）——无 sessionId
  // （全局单库不属于任何会话），前端知识卡片面板据此刷新列表。
  | { kind: 'wiki.changed' }
  // v0.33b 第二轮：wiki 生成任务状态推送（started/completed/failed，宿主侧
  // 单任务互斥）——前端面板显示进度与结果。
  | { kind: 'wiki.generateStatus'; status: WikiGenerateStatus }
  // v0.41 D20：goal 模式状态推送（宿主在 goal.set/clear 生效、每次 judge 裁决、
  // 每次 G1/G2 压缩后发射）。permission.changed 同模式——前端是信号的忠实投影，
  // 不本地乐观猜状态。一次裁决恰好一个事件（不变量见 src/im/goal/types.ts）。
  | { kind: 'goal.changed'; sessionId: string; event: GoalEvent }
  | { kind: 'workflow.changed'; sessionId: string; state: WorkflowState }
  | { kind: 'workflow.run'; sessionId: string; event: WorkflowRunEvent }
  // v0.42 大输入切块状态推送（gate 在 chunk.set 生效后发射）——前端是信号的
  // 忠实投影，不本地乐观猜。permission.changed / goal.changed 同模式。
  | { kind: 'chunk.changed'; sessionId: string; enabled: boolean; chunkTokens?: number }
  | { kind: 'log'; level: LogLevel; msg: string; fields?: LogFields | undefined; ts: number; component?: string | undefined }

// ============================================================================
// 2. 请求-应答（后端挂起等前端回包，超时 fail-closed）
// ============================================================================

/**
 * 广播形态的请求：request() 生成 requestId 后广播给订阅者，前端据此弹出
 * 审批 / 提问 UI，再通过 command('approval.decision' / 'ask_user.answer') 回包。
 * sessionId 可选：审批 handler 在 registry 层是跨会话共享的（per-session 的
 * 是 ApprovalStore grant 缓存），wiring 层经 session provider 尽力标注归属；
 * 未标注时前端按当前活跃会话处理。
 */
export type GateRequest =
  | { kind: 'approval'; requestId: string; payload: ApprovalRequest; sessionId?: string | undefined }
  | { kind: 'ask_user'; requestId: string; payload: { questions: AskQuestion[] }; sessionId?: string | undefined }

/**
 * request() 的入参形态：不含 requestId（由 gate 生成）。
 */
export type GateRequestInput =
  | { kind: 'approval'; payload: ApprovalRequest; sessionId?: string | undefined }
  | { kind: 'ask_user'; payload: { questions: AskQuestion[] }; sessionId?: string | undefined }

// ============================================================================
// 3. 入站命令（前端 → 后端，带回执）
// ============================================================================
//
// v0.34 C1（用户拍板 2026-09-10）：gate 的定位由「纯路由」升级为
// 「纯路由 + **会话级并发控制**」——并发防线坐在 gate 是因为它是唯一的前后端
// 中转站，一处设防全端受益。受影响的三条命令：
//   - `user.prompt`：经会话排队器（src/signals/session-queue.ts）。同会话已有回合
//     在途时**排队**（不丢弃、不顶替），并回 `{ queued, position }` 回执。
//   - `turn.cancel`：顺带丢弃该会话排队中的消息（在途回合不受影响）。
//   - `session.close` / `session.delete`：忘记该会话的队列状态。
// 其余命令仍是纯路由：校验与执行都在宿主 handler 内完成。

export type GateCommand =
  | { kind: 'user.prompt'; sessionId: string; text: string }
  | { kind: 'session.create'; payload: { title?: string | undefined; workDir?: string | undefined; workingAgentId?: string | undefined } }
  | { kind: 'session.open'; sessionId: string }
  | { kind: 'session.close'; sessionId: string }
  | { kind: 'session.delete'; sessionId: string }
  | { kind: 'session.list' }
  | { kind: 'session.history'; sessionId: string }
  // v0.26 Wave A（/title）：会话改名。title 校验（非空、≤200 字符）与落盘
  // （session.json）都在宿主 handler 内完成；gate 对该命令只做路由（v0.34 C1 的
  // 会话排队只作用于 user.prompt / turn.cancel / session.close|delete）。
  | { kind: 'session.rename'; sessionId: string; title: string }
  // v0.29 Wave B2：手动按需压缩 / 会话分叉 / 撤回任务块（对标 KimiCode
  // /compact /fork /undo）。校验与执行都在宿主 handler 内完成；gate 纯路由。
  // 【/compact 已注释下线（用户拍板 2026-09-08，双压缩模式拍板后恢复）】
  // | { kind: 'session.compact'; sessionId: string }
  | { kind: 'session.fork'; sessionId: string }
  | { kind: 'session.undo'; sessionId: string; blocks: number }
  // v0.36（/rewind）：把 AI 改过的**文件**还原到改动之前——与 session.undo 正交
  // （那个撤对话、这个撤文件），两者可单独或组合使用。范围校验与执行都在宿主
  // handler（快照层见 src/im/tools/file-history.ts）；gate 纯路由。
  | { kind: 'session.rewind'; sessionId: string; entries: number | 'last-turn' }
  | { kind: 'provider.list' }
  | { kind: 'provider.upsert'; name: string; provider: ProviderConfig }
  | { kind: 'provider.delete'; name: string }
  | { kind: 'provider.activate'; name: string }
  // v0.32：模型/思考档位选择（dsh selectModel 语义）——provider/model/effort
  // 任意组合一次写盘；写盘成功后宿主 emit provider.changed 广播新目录。
  // provider 缺省 = active；model 切换清 effort（跟随新模型默认）；effort
  // 缺省 = 清除（跟随模型 defaultEffort）。校验在写路径（config/write.ts）。
  | { kind: 'provider.select'; provider?: string; model?: string; effort?: ProviderConfig['thinking'] }
  // v0.25 Wave B: 设置面板的 MCP / 子代理 / 宿主设置 / 扩展清单命令。
  // 设计收敛（对计划 §B3 的最终裁定）：子代理向下开关不单设 nesting 命令——
  // 统一走 settings.get/set，一个文件一个命令对。
  // mcp.upsert 的 server 原样透传 validateMcpServerConfig（unknown → 强校验）。
  | { kind: 'mcp.list' }
  | { kind: 'mcp.upsert'; server: unknown }
  | { kind: 'mcp.delete'; name: string }
  | { kind: 'subagent.list' }
  | { kind: 'subagent.upsert'; agent: SubAgentConfig }
  | { kind: 'subagent.delete'; name: string }
  | { kind: 'settings.get' }
  | { kind: 'settings.set'; patch: Partial<DatabusSettings> }
  | { kind: 'extensions.info' }
  | { kind: 'turn.cancel'; sessionId: string }
  | { kind: 'approval.decision'; requestId: string; decision: 'approved' | 'rejected' }
  | { kind: 'ask_user.answer'; requestId: string; answers: unknown; cancelled?: boolean | undefined }
  // per-session 权限切换（用户拍板 2026-09-07：全局广播已删除——每个会话的
  // 权限独立，切换只作用于目标会话；生效后宿主 emit permission.changed）。
  | { kind: 'permission.full'; sessionId: string; enabled: boolean }
  | { kind: 'artifact.get'; artifactId: string }
  | { kind: 'workspace.read'; sessionId: string; path: string }
  // v0.33b：知识卡片（全局单库 wiki，用户拍板 2026-09-10）。数据面在宿主侧
  // wiki-mcp 子进程（wiki-pool.ts），前端不直接触 wiki 协议；卡片创建成功后
  // 宿主 emit wiki.changed 广播（permission.changed 同模式）。workspace 只是
  // 卡片上的元数据标签（tags），不按工作区分库。
  | { kind: 'wiki.listCards' }
  | { kind: 'wiki.addCard'; card: WikiCardInput }
  | { kind: 'wiki.renderCard'; cardId: string }
  // v0.33b 第二轮（用户指定）：选择现有工作区 → wiki agent 阅读工作区文档与
  // 代码后生成知识卡片。宿主异步跑生成任务，进度经 wiki.generateStatus 推送；
  // 宿主侧互斥（wiki server 单进程，并发写竞态）。
  | { kind: 'wiki.generate'; workDir: string }
  // v0.41 goal 模式（D20）：会话级停止条件的开关与查询。set 之后每次轮次本应
  // 以 completed 结束时先由独立 judge 裁决；clear 是用户显式关闭（裁决终止
  // met/impossible/rounds_exhausted 由 hook 自己清空状态，不走 clear）。
  // maxRounds 缺省用 DEFAULT_GOAL_MAX_ROUNDS（事实源 src/im/goal/types.ts）。
  | { kind: 'goal.set'; sessionId: string; condition: string; maxRounds?: number }
  | { kind: 'goal.clear'; sessionId: string }
  | { kind: 'goal.get'; sessionId: string }
  | { kind: 'workflow.enable'; sessionId: string }
  | { kind: 'workflow.disable'; sessionId: string }
  | { kind: 'workflow.status'; sessionId: string }
  | { kind: 'workflow.baseline'; sessionId: string }
  // v0.42 大输入切块（用户拍板 2026-09-15：手动开启，进切块模式才切）。
  // gate 自身持状态（chunk-mode.ts，与 session-queue.ts 同先例），不依赖宿主
  // handler——chunk.set 由 gate 直接消费，不入 handlers。chunkTokens 缺省用
  // DEFAULT_CHUNK_TOKENS（src/signals/chunk.ts:29）。
  | { kind: 'chunk.set'; sessionId: string; enabled: boolean; chunkTokens?: number }
  | { kind: 'chunk.get'; sessionId: string }

// ============================================================================
// Gate 接口 + 宿主 handlers + 快照
// ============================================================================

/** on() 可订阅的 kind：任意出站信号 kind、请求 kind，或 '*' 通配全部。 */
export type GateSubscriptionKind = (GateSignal | GateRequest)['kind'] | '*'

/** on() 的回调签名（跟随 RenderingSignalBus.onSignal 的联合形态，消费方自行收窄）。 */
export type GateSubscriber = (sig: GateSignal | GateRequest) => void

/**
 * Gate 快照——只报告 gate 自己拥有的状态，不猜测 session 的真实生命周期：
 *   - sessions：emit/command 流中"观察到"的 sessionId 集合（观察即计入，
 *     session.close / session.delete 命令后移除）；"活跃 session 数"即
 *     sessions.length。
 *   - pendingRequests：挂起（未 resolve / 未超时）的请求数。
 *   - subscribers：当前订阅回调总数（各 kind 求和，含 '*'）。
 *   - emitted：已发射的出站信号数（emit() 调用数；request 广播不计入）。
 */
export type GateSnapshot = {
  sessions: readonly string[]
  pendingRequests: number
  subscribers: number
  emitted: number
}

/**
 * v0.24: workspace.read 的回执——工作区内一个文件（只读内容）或一个目录
 * （条目列表）。前端内嵌只读查看器的数据契约。
 */
export type WorkspaceReadResult = {
  /** 相对会话 workDir 的规范路径（'.' 表示根目录）。 */
  path: string
  kind: 'file' | 'dir'
  /** kind==='file'：utf8 文本内容（超出上限已截断）。 */
  content?: string
  /** kind==='file'：内容因超过上限被截断时为 true。 */
  truncated?: boolean
  /** kind==='file'：原始字节大小。 */
  size?: number
  /** kind==='dir'：目录条目（目录在前，按名排序，≤500 条）。 */
  entries?: ReadonlyArray<{ name: string; kind: 'file' | 'dir' }>
}

/** v0.28: 会话工具清单项（name + description，纪律载体在 description）。 */
export type ToolInventoryEntry = { name: string; description: string }
/** v0.28: session.event 'tools' 事件的 data 契约。 */
export type SessionToolsPayload = { tools: readonly ToolInventoryEntry[] }

/**
 * v0.29 Wave B2: session.compact 的回执——一次手动按需压缩的结果摘要。
 * 直接复用 drive-coordinator 的 CompactSummary 形状（加 noop 标记透传），
 * CLI 据此生成状态行（"压缩完成" / "没有可压缩的完整任务块" / "压缩调度未接线"）。
 */
export type SessionCompactResult = {
  zone: 'M1' | 'M2'
  compressed: boolean
  reason?: string
  evicted: number
  archived: number
  noop?: boolean
}

/**
 * v0.29 Wave B2: session.undo 的回执——撤回 N 个任务块后的驱逐统计。
 */
export type SessionUndoResult = {
  /** 实际撤回的任务块数。 */
  blocks: number
  /** 被驱逐的 canonical 回合数（含 user/assistant/tool）。 */
  evicted: number
}

/**
 * v0.36: session.rewind 的回执——把 AI 改过的文件还原到改动之前的结果。
 *
 * 三个列表分开报，是为了**不假装成功**：unbacked 是当时超限（>2MB）没有内容
 * 副本的文件，它们撤不回来，必须如实上报，而不是混进 restored 里充数。
 */
export type SessionRewindResult = {
  /** 成功还原的文件（相对工作目录的路径）。 */
  restored: string[]
  /** 成功删除的文件（AI 当时新建、改动前本不存在的）。 */
  deleted: string[]
  /** 撤不回来的文件（改动前没做成备份：超限或读取失败）。 */
  unbacked: string[]
  /** 实际处理的快照记录条数。 */
  entries: number
}

/**
 * v0.25 Wave B: subagent.list 的回执——磁盘子代理目录 + 全部配置
 * （~/.databus/agents/*.json，磁盘为事实源，每次调用重读）。
 */
export type SubAgentListResult = { dir: string; agents: SubAgentConfig[] }

/**
 * v0.25 Wave B: extensions.info 的回执——宿主启动期已装配的扩展清单
 * （skills/servers 来自启动状态快照，重启/新会话才反映配置变更）。
 */
export type ExtensionsInfo = {
  skills: string[]
  textSkills: string[]
  servers: string[]
  skillsDir?: string
  textSkillsDir?: string
}

/**
 * v0.33b: 知识卡片契约（全局单库 wiki）。type 枚举 = wiki server 的代码领域
 * 6 类（module/interface/function/class/pattern/concept）；id 由宿主生成
 * （前端不填，wiki server 校验 id 格式）；workspace 标签由 UI 附加进 tags。
 */
export type WikiCardInput = {
  type: string
  title: string
  summary: string
  content: string
  tags?: string[]
}

export type WikiCardSummary = {
  id: string
  type: string
  title: string
  summary: string
  tags?: string[]
}

export type WikiListResult = { cards: WikiCardSummary[] }

/** wiki.renderCard 回执——宿主已把 markdown 渲染成 HTML（render-md 管线）。 */
export type WikiRenderResult = { cardId: string; title: string; html: string }

/**
 * v0.33b 第二轮：wiki 生成任务状态（wiki.generate 命令的异步进度流）。
 * completed.cardsCreated = 任务前后 list_cards 差值（wiki agent 经 MCP 直接
 * 写库，宿主无从逐卡感知，差值是诚实口径）。
 */
export type WikiGenerateStatus =
  | { status: 'started'; workDir: string }
  | { status: 'completed'; workDir: string; cardsCreated: number }
  | { status: 'failed'; workDir: string; error: string }

/**
 * 宿主注入的 handlers——SignalGate 的全部后端行为都从这里来，gate 自身
 * 不持有任何 session / loop 状态。session 子集的签名与 SessionManager
 * 一致，宿主可以直接把 SessionManager 传进来（结构化类型兼容）。
 */
export type SignalGateHandlers = {
  /** 运行一个用户回合（user.prompt 命令的路由目标）。 */
  runPrompt(sessionId: string, text: string): Promise<IMLoopResult>
  /** SessionManager 的方法子集。 */
  session: {
    create(opts?: { title?: string | undefined; workDir?: string | undefined; workingAgentId?: string | undefined }): Promise<SessionHandle>
    open(id: string): Promise<SessionHandle>
    list(): Promise<SessionInfo[]>
    close(id: string): Promise<void>
    delete(id: string): Promise<void>
    /**
     * v0.22：读会话的 canonical 消息历史（断线恢复的事实源）。实现方从
     * 活跃 handle 的 conversationMemory.turns() 取（未 open 的会话由实现方
     * 自行 open 后读取）。
     */
    history(id: string): Promise<readonly ConversationTurn[]>
    /**
     * v0.26 Wave A：会话改名（session.rename 的路由目标）。实现方校验
     * （非空、≤200 字符）后把 title 写进 session.json；会话不存在时抛干净
     * 错误。不产生出站信号——列表显示由调用方重新 session.list 刷新。
     * 可选成员（getArtifact/workspace.read 先例）：未提供时该命令抛干净错误
     * ——既有 handlers mock / 最小宿主不必跟着实现。
     */
    rename?(id: string, title: string): Promise<void>
    /**
    //  * v0.29 Wave B2：手动按需压缩（session.compact 的路由目标）。会话必须
//      * 已打开（compactNow 操作活跃 runtime）；构造 DriveSnapshot（contextTokens
//      * 用 wire-format 估算，与 loop 同口径）后委托 driveCoordinator.compactNow。
//      */
//     compact?(id: string): Promise<SessionCompactResult>
// 
    /**
     * v0.29 Wave B2：会话分叉（session.fork 的路由目标）。复制快照为全新
     * UUID，不自动 open/attach；返回新会话的 SessionInfo。
     */
    fork?(id: string): Promise<SessionInfo>
    /**
     * v0.29 Wave B2：撤回最近 blocks 个任务块（session.undo 的路由目标）。
     * 1 ≤ blocks ≤ 10；撤回范围含已压缩归档的回合时拒绝（干净错误）。
     */
    undo?(id: string, blocks: number): Promise<SessionUndoResult>
    /**
     * v0.36：把 AI 改过的文件还原到改动之前（session.rewind 的路由目标）。
     * 1 ≤ entries ≤ 50；entries 超过该会话实际记录数时抛干净错误。快照缺内容
     * 副本的文件（超限未备份）计入回执的 unbacked，不算还原成功。
     */
    rewind?(id: string, entries: number | 'last-turn'): Promise<SessionRewindResult>
  }
  /** 取消 session 的在途回合（turn.cancel 的路由目标）。 */
  cancel(sessionId: string): void
  /**
   * 切换**单个会话**的完全权限模式（permission.full 的路由目标）。每个会话
   * 的权限独立（用户拍板 2026-09-07，全局广播已删除）；会话未打开时实现方
   * 抛干净错误。生效后由实现方 emit permission.changed 推送新状态。
   */
  setFullPermission(sessionId: string, enabled: boolean): void
  /**
   * 可选：服务 artifact.get 命令。P0 的 gate 不内置 artifact store（渲染
   * 基座的 ArtifactStore 由宿主接线），未提供时 artifact.get 抛干净错误。
   */
  getArtifact?(artifactId: string): Promise<unknown>
  /** 可选：服务 workspace.read 命令（v0.24 前端内嵌只读查看器）。文件读取与目录
   *  列举都在宿主侧执行（工作区是权限边界，包含性检查在宿主完成），未提供时
   *  workspace.read 抛干净错误。 */
  readWorkspaceFile?(sessionId: string, path: string): Promise<WorkspaceReadResult>
  /**
   * 可选：服务 provider.* 命令（v0.23 设置菜单）。读写在宿主侧执行
   * （providers.json 的文件操作在宿主侧完成），未提供时 provider.* 命令
   * 抛干净错误。保存即写文件，生效时机 = 新会话（重启为兜底）。
   */
  provider?: {
    list(): Promise<ProviderListResult>
    upsert(name: string, provider: ProviderConfig): Promise<WriteResult>
    delete(name: string): Promise<WriteResult>
    activate(name: string): Promise<WriteResult>
    /** v0.32：模型/档位选择（dsh selectModel 语义，写路径在 config/write.ts）。 */
    select(cmd: { provider?: string; model?: string; effort?: ProviderConfig['thinking'] }): Promise<WriteResult>
  }
  /**
   * 可选：服务 mcp.* 命令（v0.25 设置面板）。mcp.json（~/.databus/mcp.json）
   * 读写都在宿主侧执行，server 原样透传给 validateMcpServerConfig，未提供时
   * mcp.* 命令抛干净错误。保存即写文件，重启 web-host 后生效（MCP 连接是
   * 启动期行为，ADR-018 D6）。
   */
  mcp?: {
    list(): Promise<McpListResult>
    upsert(server: unknown): Promise<McpWriteResult>
    delete(name: string): Promise<McpWriteResult>
  }
  /**
   * 可选：服务 subagent.* 命令（v0.25 设置面板）。~/.databus/agents/*.json
   * 读写都在宿主侧执行（upsert 经 validateSubAgentConfig 校验 toolRefs），
   * 未提供时 subagent.* 命令抛干净错误。子代理向下开关不在这里——统一走
   * settings.get/set（一个文件一个命令对）。
   */
  subagent?: {
    list(): Promise<SubAgentListResult>
    upsert(agent: SubAgentConfig): Promise<{ dir: string }>
    delete(name: string): Promise<{ dir: string }>
  }
  /**
   * 可选：服务 settings.* 命令（v0.25 设置面板）。~/.databus/settings.json
   * 读写都在宿主侧执行。patch 里的子代理向下开关对运行中会话不生效——
   * 新会话生效（用户拍板），提示由 UI 负责。
   */
  settings?: {
    get(): Promise<DatabusSettings>
    set(patch: Partial<DatabusSettings>): Promise<DatabusSettings>
  }
  /**
   * 可选：服务 extensions.info 命令（v0.25 设置面板）。返回宿主启动期已
   * 装配的扩展清单（skills/textSkills/servers + 目录配置），未提供时抛干净错误。
   */
  extensions?: {
    info(): Promise<ExtensionsInfo>
  }
  /**
   * 可选：服务 wiki.* 命令（v0.33b 知识卡片面板）。数据面在宿主侧全局单库
   * wiki-mcp 子进程（wiki-pool.ts）：listCards/addCard 经 MCP tools/call，
   * renderCard 经 render_md(card) + render-md 渲染成 HTML。未提供时 wiki.*
   * 命令抛干净错误。addCard 成功后宿主 emit wiki.changed。
   */
  wiki?: {
    listCards(): Promise<WikiListResult>
    addCard(card: WikiCardInput): Promise<{ id: string }>
    renderCard(cardId: string): Promise<WikiRenderResult>
    /** v0.33b 第二轮：启动工作区知识库生成任务（异步；进度走 wiki.generateStatus）。
     *  宿主侧单任务互斥——已有任务时抛干净错误。 */
    generate(workDir: string): Promise<void>
  }
  /**
   * 可选：服务 goal.* 命令（v0.41 goal 模式）。状态持有者是宿主装配层的
   * per-session GoalSessionState；gate 保持纯路由，set/clear 生效后由宿主
   * emit goal.changed（permission.full → permission.changed 同模式）。
   * 未提供时 goal.* 命令抛干净错误。
   */
  goal?: {
    set(sessionId: string, condition: string, maxRounds?: number): Promise<void>
    clear(sessionId: string): Promise<void>
    /** 未设置 goal 时返回 undefined（不是抛错——"没有目标"是正常状态）。 */
    get(sessionId: string): Promise<GoalState | undefined>
  }
  workflow?: {
    enable(sessionId: string): Promise<WorkflowState>
    disable(sessionId: string): Promise<WorkflowState>
    status(sessionId: string): Promise<WorkflowState>
    baseline(sessionId: string): Promise<BaselineRunResult>
  }
}

/**
 * Signal Gate 实例接口。
 *   - emit/on：kind 过滤的同步广播（fire-and-forget）。
 *   - request/resolve：请求-应答，超时 fail-closed。
 *   - command：入站命令路由，返回 Promise 回执。
 *   - snapshot：状态快照。
 */
export interface SignalGate {
  /** 广播出站信号给所有匹配 kind（或 '*'）的订阅者。 */
  emit(sig: GateSignal): void
  /** 注册订阅；返回 unsubscribe 函数。 */
  on(kind: GateSubscriptionKind, cb: GateSubscriber): () => void
  /**
   * 发起请求-应答：生成 requestId → 广播完整 GateRequest → 挂起 promise。
   * 超时（默认 300s）fail-closed：reject 并清理挂起表；迟到回包静默忽略。
   * opts.timeoutMs 可按次覆盖默认超时。
   */
  request(input: GateRequestInput, opts?: { timeoutMs?: number | undefined }): Promise<unknown>
  /** 解析挂起的请求（前端回包落点）。未知 requestId 静默忽略（迟到回包是预期时序）。 */
  resolve(requestId: string, payload: unknown): void
  /** 路由入站命令到 handlers；approval.decision / ask_user.answer 路由进 resolve。 */
  command(cmd: GateCommand): Promise<unknown>
  /** 当前 Gate 状态快照。 */
  snapshot(): GateSnapshot
}
