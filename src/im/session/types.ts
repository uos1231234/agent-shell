// v0.17 session layer: multi-session window + history recovery.
//
// A Session is the aggregation of every mechanism that follows one session
// UUID: ConversationMemory (canonical turns), Databus (tool-only projection),
// StateLine (compressed gradient M1/M2/M3 + raw archive), the sub-agent
// databus tree, and the security router's per-session approval state.
//
// SessionId here is THE SAME UUID string SecurityRouter uses as its SessionId
// (minted once by SessionManager, threaded through ToolContext.sessionId).
// The session mechanism and the security mechanism intentionally share only
// that string value — never objects or classes. SessionBusRegistry mirrors
// SecurityRouter's lifecycle shape (Map<SessionId, ...> + getOrCreate/delete)
// but does not import it (decoupling rationale in v0.17 plan).
//
// Snapshot TTL: conversation.jsonl + databus.jsonl are a *reconstructable
// copy* of the live ConversationMemory/Databus for same-session resume, kept
// only a short window (default 3 days) so snapshots never accumulate unbounded
// user storage. StateLine (compressed gradient) is durable and is NEVER pruned
// by the snapshot TTL.

import type { ConversationMemory, ConversationTurn } from '../conversation-memory.js'
import type { Databus } from '../databus.js'
import type { StateLine } from '../state-line/types.js'
import type { SubAgentRegistry } from '../sub-agent/index.js'
import type { DriveCoordinator } from '../system-agents/drive-coordinator.js'
import type { IMLoopOptions } from '../loop.js'
import type { TokenCounter } from '../../shared/token-counter.js'
import type { MemoryLayer } from '../memory-layers.js'
import type { Mailbox } from '../mailbox/index.js'
import type { SystemAgents } from '../loop.js'
import type { LoopHooks } from '../loop-hooks.js'
import type { HookSystem } from '../hooks/hook-system.js'
import type { ContextInjector } from '../hooks/context-injection.js'
import type { DynamicToolSource } from '../dynamic-tool-context.js'
import type { OpenAITool } from '../../protocol/types.js'
import type { SubAgentToolPolicy } from '../sub-agent/policy.js'
import type { PromptLayer, PromptMode } from '../prompt/types.js'
import type { RenderingSignalBus } from '../../rendering/signal-bus.js'
import type { RenderingBase } from '../../rendering/base.js'
import { ArtifactStore } from '../tools/artifact-store.js'

/** The session UUID. Identical string value as SecurityRouter's SessionId. */
export type SessionId = string

/** Snapshot retention. conversation.jsonl + databus.jsonl live for `ttlDays`. */
export type SessionSnapshotConfig = {
  /** Retention window for the reconstructable snapshot, in days. Default 3. */
  ttlDays?: number
}

/** Buses owned by one session (working agent's own + root family bus). */
export type SessionBuses = {
  /** Working agent's private projection bus (= AgentTree root.ownDatabus). */
  own: Databus
  /** Root's family bus (handed to sub-agents as their ownDatabus). */
  family: Databus
}

/** Durable metadata for one session, written to <sessionDir>/session.json. */
export type SessionInfo = {
  id: SessionId
  title: string
  workingAgentId: string
  createdAt: number
  lastActiveAt: number
  /** Total canonical turns appended across the snapshot lifetime. */
  turnCount: number
  /** Current memory layer at last write (M0/M1/M2/M3). */
  layer: MemoryLayer
  /** Whether the conversation/databus snapshot has been pruned by TTL. */
  snapshotExpired: boolean
  /**
   * v0.20: 用户工作文件夹（前端/宿主创建会话时传入）。
   * 上下文注入源（MEMORY.md / ARCHITECTURE.md）据此根目录读取。
   * 不是 process.cwd()——进程 cwd 可能是宿主目录，不是用户工作文件夹。
   */
  workDir?: string
}

/**
 * The session-scoped runtime objects. The caller passes these into
 * createMinimalIM / runIMLoop. `persistTurn` is the write hook that loop.ts
 * calls after every canonical append — SessionManager wires it to append the
 * turn to both conversation.jsonl and databus.jsonl.
 */
export type SessionRuntime = {
  sessionId: SessionId
  conversationMemory: ConversationMemory
  databus: Databus
  stateLine: StateLine
  subAgentRegistry: SubAgentRegistry
  driveCoordinator: DriveCoordinator
  /** Append a canonical turn to the durable session snapshot. */
  persistTurn: (turn: ConversationTurn, databusTurn?: import('../databus.js').ToolTurn) => Promise<void>
  /**
   * 会话快照原子重写（2026-09-13 用户拍板）：把传入的内存 canonical（含压缩
   * 信封替代块）+ databus 全量重写到磁盘快照——磁盘 ≡ 模型所见，跨重启信封
   * 不消失。内部走与会话 persistTurn 相同的写串行队列（append 与 rewrite 不
   * 交错），调用方（drive-coordinator 的 rewriteSnapshot）无需自行加锁。
   */
  enqueueSnapshotWrite: (conversation: ConversationMemory, databus: Databus) => Promise<void>
}

/**
 * A live session handle returned by createSession/openSession.
 * `buildLoopOptions` merges the session's runtime objects into a caller-supplied
 * base of infrastructure (registry/streamChat/config/url/model/systemPrompt...).
 */
export type SessionHandle = {
  info: SessionInfo
  runtime: SessionRuntime
  /** Build IMLoopOptions for this session from caller-supplied infra. */
  buildLoopOptions(
    base: SessionLoopBase,
  ): IMLoopOptions
  /** Persist an info patch (title/lastActiveAt/turnCount/layer) to session.json. */
  saveInfo(patch: Partial<SessionInfo>): Promise<void>
  /** Flush + close state-line, unregister from bus registry. */
  close(): Promise<void>
}

/**
 * Caller-supplied infrastructure for a session's loop. The session owns the
 * session-scoped fields (memory/databus/state-line/sub-agent tree/sessionId);
 * the caller owns the shared infrastructure (registry/LLM transport/config).
 *
 * v0.20 hook repair: 补齐与 IMLoopOptions 的字段漂移（hooks/hookSystem/
 * contextInjector/dynamicSchemas/toolPolicy/promptLayers/promptMode/signal/
 * compressZone/injectTextSkills/archiveSourceStamps/archiveRawArchiveIds）。
 * 缺失这些字段会导致走 SessionManager 的会话静默丢失对应能力。
 */
export type SessionLoopBase = {
  config: IMLoopOptions['config']
  registry: IMLoopOptions['registry']
  streamChat: IMLoopOptions['streamChat']
  url: string
  model: string
  systemPrompt: string
  userTemplate: string
  systemToolRefs?: string[]
  mcpRefs?: IMLoopOptions['mcpRefs']
  skillRefs?: string[]
  mailbox?: Mailbox
  systemAgents?: SystemAgents
  ctxDatabus?: Databus | readonly Databus[]
  subAgentDepth?: number
  initialMetrics?: IMLoopOptions['initialMetrics']
  memoryConfig?: IMLoopOptions['memoryConfig']
  logger?: IMLoopOptions['logger']
  requestHandler?: IMLoopOptions['requestHandler']
  isWikiAgent?: boolean
  // v0.20: 用户工作文件夹——上下文注入源（MEMORY.md / ARCHITECTURE.md）据此读取。
  workDir?: string
  // v0.20: control-flow hooks (per-loop intervention points).
  hooks?: LoopHooks
  // v0.21: 流式增量旁路（信号关 delta-bridge 接入口）。经 buildLoopOptions
  // 透传给 IMLoopOptions.onStreamChunk；loop 以每轮 mint 的唯一 turnId
  // 调用。纯观察，默认 undefined 零行为变化。
  onStreamChunk?: IMLoopOptions['onStreamChunk']
  // 思维链落盘门控（2026-09-12 用户拍板，赋值面 = 落盘面）：true 仅限有持久
  // 化归宿的会话（工作代理 persistTurn / warehouse 持久会话）。缺省 false——
  // 子代理与无落盘系统智能体不把聚合 reasoning 赋进 canonical 回合。
  persistReasoning?: boolean
  // v0.41 D19：严格角色交替 provider 的出站转写开关（provider 客观属性，
  // 事实源 providers.json 的 capabilities.strictAlternation）。经
  // buildLoopOptions 透传给 IMLoopOptions.strictAlternation → ShellDeps。
  // 缺省 undefined = 不转写 = wire 形状零变化。
  strictAlternation?: boolean
  tokenCounter?: TokenCounter
  largeRecall?: IMLoopOptions['largeRecall']
  directRecallLedger?: IMLoopOptions['directRecallLedger']
  directRecallLimitTokens?: IMLoopOptions['directRecallLimitTokens']
  // v0.20: general-purpose event hooks for tool execution lifecycle.
  hookSystem?: HookSystem
  // v0.20: dynamic context injection sources (memory/architecture/…).
  contextInjector?: ContextInjector
  // v0.20: per-session 渲染基座（bus + base + store 三件套）。
  // 多会话隔离：每个会话独立的 bus/base/store，避免跨会话 artifact 泄漏。
  rendering?: {
    bus: RenderingSignalBus
    base: RenderingBase
    store: ArtifactStore
  }
  // v0.20: progressive tool disclosure — accumulated dynamic tool schemas.
  dynamicSchemas?: Array<{ source: DynamicToolSource; tools: OpenAITool[] }>
  // v0.20: sub-agent tool policy.
  toolPolicy?: SubAgentToolPolicy
  // v0.20: layered prompt configuration.
  promptLayers?: PromptLayer[]
  // v0.20: prompt mode (full / minimal / none).
  promptMode?: PromptMode
  // v0.20: optional abort signal for turn cancellation.
  signal?: AbortSignal
  // v0.20: compression zone for system agents.
  compressZone?: 'M1' | 'M2'
  // v0.20: whether to inject text skills.
  injectTextSkills?: boolean
  // v0.20: source stamps for M3 archive.
  archiveSourceStamps?: string[]
  // v0.20: raw archive ids for M3 archive.
  archiveRawArchiveIds?: string[]
}

export type SessionManagerOptions = {
  /** Root dir under which <sessionId>/ subdirs live. Default ~/.databus/sessions. */
  basePath?: string
  /** Snapshot retention config (TTL). Default { ttlDays: 3 }. */
  snapshot?: SessionSnapshotConfig
}

export type SessionManager = {
  /**
   * 创建会话。`workDir` = 用户工作文件夹（前端传入）——
   * 上下文注入源（MEMORY.md / ARCHITECTURE.md）据此读取。
   */
  createSession(opts?: { title?: string; workingAgentId?: string; workDir?: string }): Promise<SessionHandle>
  /**
   * v0.29 Wave B2（/fork，对标 KimiCode fork 不切换）：把一个会话分叉为全新
   * UUID 的副本——conversation.jsonl + databus.jsonl 全量字节复制，info 复制
   * （title 加 " (fork)" 后缀、createdAt/lastActiveAt = now、turnCount 继承），
   * state/ 压缩梯度不复制（fork 的上下文仍全量在 canonical，梯度从零）。
   * 不自动 open（不注册 bus、宿主不接入信号关）——返回的 handle 携带按副本
   * 快照重建的 runtime，调用方按需自行 open/attach。
   */
  forkSession(id: SessionId, opts?: { title?: string }): Promise<SessionHandle>
  listSessions(): Promise<SessionInfo[]>
  openSession(id: SessionId): Promise<SessionHandle>
  closeSession(id: SessionId): Promise<void>
  deleteSession(id: SessionId): Promise<void>
  /** Prune snapshots older than ttlDays. Returns number of sessions pruned. */
  pruneExpiredSnapshots(): Promise<number>
}
