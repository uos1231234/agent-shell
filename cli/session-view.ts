// v0.26 Wave 2 — session-view reducer（cli）。
//
// 信号 → 会话视图的唯一渲染数据源（计划 §4.5）：实时信号（applySignal）与
// 历史恢复（hydrateHistory）产出**同构**的 ViewItem 序列，渲染层只认这一种
// 形状，不再有第二条渲染路径。
//
// 分片纪律（计划 §4.7 / G6）：视图内部按 sessionId 分片（Map），渲染只跟
// activeSessionId；setActiveSession 只切视图，绝不打断/改动其他分片的在途
// 回合——在途回合的信号继续落进各自的分片。hydrateHistory 同理只补历史、
// 不杀在途状态（shard.inFlightTurnIds 感知流式尾部，phase 不被重置）。
//
// 纯度：本文件零 I/O、零定时器、零运行时依赖——对 src/** 只 import type
// （GateSignal/GateRequest 是纯类型；不 import src/signals 的运行时）。
// 变更策略：原地变更内部结构并返回同一 view（mutable internal structure，
// 单测 headless 可跑）；调用方不得持有旧引用做比较。

import type {
  GateSignal,
  GateRequest,
  AskQuestion,
  ToolInventoryEntry,
} from '../src/signals/types.js'
import type { ConversationTurn } from '../src/im/conversation-memory.js'
import type { ContentPart } from '../src/protocol/types.js'
import type { ApprovalRequest } from '../src/im/tools/security/approval-store.js'
import type { ArtifactHandle } from '../src/rendering/base.js'
import type { LogLevel } from '../src/shared/logger.js'
// v0.41 goal 模式：ViewItem 的 goal 变体载荷 + SessionShard.goal 投影。
import type { GoalEvent, GoalState } from '../src/im/goal/types.js'
import type { WorkflowRunEvent, WorkflowState } from '../src/host/workflow/types.js'

// ============================================================================
// 视图类型
// ============================================================================

/**
 * 渲染层唯一认的条目形状——实时信号与 hydrateHistory 产出同构条目
 * （计划 §4.5 的一条渲染路径）。
 *
 *   - user：用户消息。实时路径没有 user.message 出站信号（v0.22 已知局限），
 *     由 app 在发送 user.prompt 时经 appendUserMessage 本地追加。
 *   - assistant：一轮 LLM 回合的流式文本 + 思考缓冲。turnId 粒度
 *     （delta-bridge 的 turnId = loop 每轮 mint 的唯一 id，同一次 runPrompt 内多轮
 *     LLM 往返各成一条）；streaming 标记是否仍在增长（turn.end 收口）。
 *   - tool：工具卡。tool.started 建卡（running），tool.result 收口
 *     （success/failure）；producedPath 从成功 write/edit/search_replace 的
 *     args.path 机械提取（v0.24 产物行纪律）。
 */
export type ViewItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; thinking: string; streaming: boolean }
  | {
      kind: 'tool'
      callId: string
      toolName: string
      status: 'running' | 'success' | 'failure'
      /** 流式阶段 args=null（参数未聚合完），完整 args 随 tool.result 的 ToolTurn 到达。 */
      args: unknown
      /** 工具结果文本（tool.result 的 ToolTurn.content）。 */
      result: string
      /** 成功的写文件类调用（write/edit/search_replace）从 args.path 提取的产物路径。 */
      producedPath?: string
    }
  | {
      /** 上下文压缩事件（v0.30 memory.activity 信号的可见化）：
       *  memory.compressed = M1/M2 curated 块写入（上下文已压缩）；
       *  memory.archived = M3 归档。**live-only**——session.history 不回放
       *  StateLine 写入，hydrateHistory 重建 items 时本项自然消失（见该函数
       *  注释），不做历史重建兜底。 */
      kind: 'memory'
      activity: 'memory.compressed' | 'memory.archived'
      layer: string
      taskGoal: string
    }
  | {
      /** goal 模式事件（v0.41 goal.changed 信号的可见化）：目标设置/裁决/终止
       *  与 G1/G2 压缩都经这一个变体，携带整个 GoalEvent，由 app.renderGoalLine
       *  按 status 分支渲染。**live-only**——与 memory 项同理，session.history
       *  不回放信号，hydrateHistory 重建 items 时本项自然消失。goal 条件与轮次
       *  的权威状态在 shard.goal（由 set/round 事件投影，/goal status 经
       *  goal.get 现拉）。 */
      kind: 'goal'
      event: GoalEvent
    }

/** 累积统计（turn.end 的 IMLoopResult 逐次累加）。 */
export type SessionStats = {
  /** runPrompt 完成次数（turn.end 信号数）。 */
  turnEnds: number
  /** IMLoopResult.turns 之和（LLM 往返轮数）。 */
  loopTurns: number
  /** tool.started 信号数。 */
  toolCalls: number
  /** Metrics.totalTokens 累积（src/shell/metrics.ts：prompt+completion 之和）。 */
  totalTokens: number
  /** Metrics.elapsedMs 累积。 */
  elapsedMs: number
  /** 最近一次 turn.end 的终止原因。 */
  lastReason?: 'completed' | 'guard-tripped' | 'protocol-error' | 'shell-terminated'
}

/** 审批 / 提问的挂起请求（GateRequest 的视图投影，按到达顺序排队）。 */
export type PendingRequest =
  | { kind: 'approval'; requestId: string; payload: ApprovalRequest }
  | { kind: 'ask_user'; requestId: string; payload: { questions: AskQuestion[] } }

/** 单会话分片：该 sessionId 的全部可渲染状态。 */
export type SessionShard = {
  sessionId: string
  items: ViewItem[]
  /** idle | streaming（streaming = user.prompt 发出到 turn.end；计划 §4.6）。 */
  phase: 'idle' | 'streaming'
  /** 是否已经 hydrateHistory（区分"从未加载历史"与"加载了但为空"）。 */
  hydrated: boolean
  /** session.event 'system.prompt' 的 data.text（装配层 emit，assembly.ts）。 */
  systemPrompt?: string
  /**
   * 在途回合感知（G6 /resume 修复）：已流出正文、但可能尚未落 canonical
   * 历史的 turnId。生命周期 = assistant/thinking delta 加入；tool.started /
   * tool.result 移除（轮次时序：loop 的 finalizeRound 先持久化该轮正文、
   * 再执行工具——工具信号到达即代表该轮正文已入历史）；turn.end 清空。
   * hydrateHistory 只保留集合内 turnId 的流式尾部，已完成轮次交由历史
   * 重建，不重复。
   */
  inFlightTurnIds: Set<string>
  /** session.event 各事件名的最近一次 data（如 'tools' → SessionToolsPayload）。 */
  events: Record<string, unknown>
  pendingRequests: PendingRequest[]
  artifacts: ArtifactHandle[]
  permissionFull: boolean
  /**
   * v0.41：该会话当前的 goal（`undefined` = 未激活）。goal.changed 的忠实投影
   * ——set 建立、round 更新 roundsUsed、终止型事件（met / impossible /
   * rounds_exhausted / cleared）清空，与后端 GoalSessionState.current 同步。
   * 不本地乐观：状态由信号驱动，刷新/多客户端天然一致。
   *
   * live-only 局限：`round` 事件不带 condition，所以中途接入的客户端只有轮次
   * 没有条件文本——权威状态经 `/goal status`（goal.get 命令）现拉。
   */
  goal?: GoalState | undefined
  /** LongHorizon workflow state mirrored from workflow.changed. */
  workflow?: WorkflowState
  /**
   * v0.34 C1：该会话**排队中**的用户消息条数（`turn.queue` 信号的投影）。
   * 0 = 无排队。注意它是「等待执行」的条数，不含正在跑的那一条——position 是该
   * 消息入队后的队列长度（1 起算），故直接等于排队总数。
   * turn.end 时递减：gate 已把队首提升为在途并紧接着执行它。
   */
  queuedCount: number
  stats: SessionStats
}

/** 状态行用的最近日志（log 信号无 sessionId，view 级保留，cap 20 条）。 */
export type StatusLog = { level: LogLevel; msg: string; ts: number }

// ============================================================================
// v0.41 goal 事件的纯文案（app.ts 的 renderGoalLine 与 headless.ts 的批处理
// 摘要共用——放本层是因为这里零 I/O、零运行时依赖，且两处文案必须一致）
// ============================================================================

/**
 * goal 事件 → 一行中文摘要。带 `never` 穷尽守卫：以后新增 GoalEvent status
 * 而未在此处理 = 编译错误，而不是静默漏渲染（gate.ts 的 GateCommand 守卫同款纪律）。
 *
 * judge_failed 的措辞刻意与 not_met 区分开：那是一次**没跑成**的判定（D15
 * fail-open），不是一次真实的"未达成"裁决——写成后者会让人以为模型真的没做完，
 * 而实际是判定通道坏了。
 */
export const goalEventLabel = (e: GoalEvent): string => {
  switch (e.status) {
    case 'set':
      return `🎯 目标已设置 · 上限 ${e.maxRounds} 轮 · ${e.condition}`
    case 'round':
      return e.verdict.verdict === 'judge_failed'
        ? `🎯 判定未跑成，按未达成续跑 · 第 ${e.round}/${e.maxRounds} 轮 · ${e.verdict.reason}`
        : `🎯 目标未达成 · 第 ${e.round}/${e.maxRounds} 轮 · ${e.verdict.reason}`
    case 'met':
      return `✅ 目标已达成 · 用了 ${e.roundsUsed} 轮`
    case 'impossible':
      return `⛔ 目标不可达 · ${e.reason}`
    case 'rounds_exhausted':
      return `⏹ 目标轮次用尽 · ${e.roundsUsed} 轮`
    case 'cleared':
      return '🎯 目标已关闭'
    case 'goal_block_merged':
      return `🗜 goal 块已合并（${e.trigger === 'size' ? '尺寸' : '水位'}触发）· ${e.blockTokens}→${e.envelopeTokens} tok · ${e.stamp}`
    case 'envelopes_distilled':
      return `🗜 信封已折叠 ${e.sourceStamps.length}→1 · ${e.beforeTokens}→${e.afterTokens} tok · ${e.stamp}`
    case 'distill_failed':
      return `🗜 信封折叠失败，保留原样下轮再试 · ${e.err}`
    default: {
      const _exhaustive: never = e
      return _exhaustive
    }
  }
}

/**
 * 全局视图：按 sessionId 分片（G6）+ 活跃会话指针 + 最近日志。
 * Map 保持插入序，listSessions 按首次出现顺序返回。
 */
export type SessionView = {
  shards: Map<string, SessionShard>
  activeSessionId: string | undefined
  recentLogs: StatusLog[]
}

const LOG_CAP = 20

/** 产物提取的工具白名单（v0.24 producedFilesOf 同款口径：成功才提取）。 */
const PRODUCING_TOOLS = new Set(['write', 'edit', 'search_replace'])

// ============================================================================
// shard / view 构造
// ============================================================================

const emptyStats = (): SessionStats => ({
  turnEnds: 0,
  loopTurns: 0,
  toolCalls: 0,
  totalTokens: 0,
  elapsedMs: 0,
})

const emptyShard = (sessionId: string): SessionShard => ({
  sessionId,
  items: [],
  phase: 'idle',
  hydrated: false,
  inFlightTurnIds: new Set(),
  events: {},
  pendingRequests: [],
  artifacts: [],
  permissionFull: false,
  queuedCount: 0,
  stats: emptyStats(),
})

export const createSessionView = (): SessionView => ({
  shards: new Map(),
  activeSessionId: undefined,
  recentLogs: [],
})

/** 取分片，不存在则建空分片（保证 applySignal 永不丢信号）。 */
const ensureShard = (view: SessionView, sessionId: string): SessionShard => {
  let shard = view.shards.get(sessionId)
  if (shard === undefined) {
    shard = emptyShard(sessionId)
    view.shards.set(sessionId, shard)
  }
  return shard
}

// ============================================================================
// applySignal —— 实时信号 → 分片视图
// ============================================================================

/**
 * 消费一条出站信号或请求。分片按 sig.sessionId 定位（G6：session A 的信号
 * 永不触碰 session B 的分片）。请求类（approval/ask_user）无 sessionId 时
 * 归入当前活跃会话（src/signals/types.ts 的 GateRequest 注释语义）；连活跃
 * 会话都没有时归入兜底分片 ''，不静默丢弃。
 */
export const applySignal = (view: SessionView, sig: GateSignal | GateRequest): SessionView => {
  switch (sig.kind) {
    case 'assistant.delta':
    case 'thinking.delta': {
      const shard = ensureShard(view, sig.sessionId)
      upsertAssistant(shard, sig.turnId, sig.kind === 'assistant.delta' ? sig.text : undefined, sig.kind === 'thinking.delta' ? sig.text : undefined)
      // 正文在流 → 该轮尚未持久化，标记为在途（hydrate 时保留流式尾部）。
      shard.inFlightTurnIds.add(sig.turnId)
      return view
    }
    case 'tool.started': {
      const shard = ensureShard(view, sig.sessionId)
      shard.items.push({
        kind: 'tool',
        callId: sig.callId,
        toolName: sig.toolName,
        status: 'running',
        args: sig.args,
        result: '',
      })
      shard.stats.toolCalls += 1
      // 工具信号到达 = 该轮正文已被 finalizeRound 持久化（先持久化后执行
      // 工具），不再是"历史覆盖不到"的在途正文。
      shard.inFlightTurnIds.delete(sig.turnId)
      return view
    }
    case 'tool.result': {
      const shard = ensureShard(view, sig.sessionId)
      settleToolCard(shard, sig.callId, sig.toolName, sig.result)
      shard.inFlightTurnIds.delete(sig.turnId)
      return view
    }
    case 'turn.queue': {
      // v0.34 C1 / D9：该会话排队中的用户消息条数变更——让用户看得见。
      // 权威广播：直接镜像 pending，不自己推算（入队/出队/取消丢弃/会话关闭
      // 都会来一条），因此不会因漏掉某条转移而显示错状态。
      const shard = ensureShard(view, sig.sessionId)
      shard.queuedCount = sig.pending
      return view
    }
    case 'turn.end': {
      const shard = ensureShard(view, sig.sessionId)
      // v0.34 C1：本回合结束。gate 在此刻出队——若排队数仍 > 0，说明队首已被提升
      // 为在途并紧接着执行，所以**不能置 idle**（否则 UI 显示空闲、实则回合在跑）。
      // 这里只定 phase；queuedCount 的新值由随后的 turn.queue 信号权威覆盖
      // （emit 顺序：turn.end 先 dispatch，再 advanceQueue 发 turn.queue）。
      shard.phase = shard.queuedCount > 0 ? 'streaming' : 'idle'
      shard.inFlightTurnIds.clear()
      for (const item of shard.items) {
        if (item.kind === 'assistant') item.streaming = false
      }
      const s = shard.stats
      s.turnEnds += 1
      s.loopTurns += sig.result.turns
      s.totalTokens += sig.result.metrics.totalTokens
      s.elapsedMs += sig.result.metrics.elapsedMs
      s.lastReason = sig.result.reason
      return view
    }
    case 'session.event': {
      const shard = ensureShard(view, sig.sessionId)
      if (sig.data !== undefined) shard.events[sig.event] = sig.data
      if (sig.event === 'system.prompt') {
        const text = (sig.data as { text?: unknown } | undefined)?.text
        if (typeof text === 'string') shard.systemPrompt = text
      }
      return view
    }
    case 'artifact': {
      const shard = ensureShard(view, sig.sessionId)
      shard.artifacts.push(sig.handle)
      return view
    }
    case 'permission.changed': {
      const shard = ensureShard(view, sig.sessionId)
      shard.permissionFull = sig.full
      return view
    }
    case 'log': {
      view.recentLogs.push({ level: sig.level, msg: sig.msg, ts: sig.ts })
      if (view.recentLogs.length > LOG_CAP) view.recentLogs.splice(0, view.recentLogs.length - LOG_CAP)
      return view
    }
    // memory.activity 压缩事件 → 对话流尾部 dim 分隔行（渲染见 app.renderMemoryLine）。
    case 'memory.activity': {
      const shard = ensureShard(view, sig.sessionId)
      if (
        (sig.activity === 'memory.compressed' || sig.activity === 'memory.archived') &&
        isMemoryDetail(sig.detail)
      ) {
        shard.items.push({ kind: 'memory', activity: sig.activity, layer: sig.detail.layer, taskGoal: sig.detail.taskGoal })
      }
      return view
    }
    // v0.41：goal.changed → 对话流一条 goal 项 + shard.goal 的忠实投影。
    // 投影规则与后端 GoalSessionState 同步：set 建立、round 只更新轮次、
    // 终止型事件清空（hook 在 met/impossible/rounds_exhausted 时把
    // state.current 置回 undefined，cleared 是用户显式 /goal off）。
    case 'goal.changed': {
      const shard = ensureShard(view, sig.sessionId)
      shard.items.push({ kind: 'goal', event: sig.event })
      const e = sig.event
      if (e.status === 'set') {
        shard.goal = { condition: e.condition, maxRounds: e.maxRounds, roundsUsed: 0 }
      } else if (e.status === 'round') {
        // round 事件不带 condition：中途接入的客户端保留已有条件，没有就留空
        // （权威状态经 /goal status 现拉，见 SessionShard.goal 的注释）。
        const prev = shard.goal
        shard.goal = {
          condition: prev?.condition ?? '',
          maxRounds: e.maxRounds,
          roundsUsed: e.round,
          lastVerdict: e.verdict,
        }
      } else if (e.status === 'met' || e.status === 'impossible' || e.status === 'rounds_exhausted' || e.status === 'cleared') {
        shard.goal = undefined
      }
      // goal_block_merged / envelopes_distilled / distill_failed 只进对话流。
      return view
    }
    case 'workflow.changed': {
      const shard = ensureShard(view, sig.sessionId)
      shard.workflow = sig.state
      return view
    }
    case 'workflow.run': {
      // Run progress is available to headless/Web consumers. TUI keeps the
      // state projection in workflow.changed and does not invent a second
      // timeline representation.
      const _event: WorkflowRunEvent = sig.event
      void _event
      return view
    }
    case 'approval':
    case 'ask_user': {
      const sessionId = sig.sessionId ?? view.activeSessionId ?? ''
      const shard = ensureShard(view, sessionId)
      shard.pendingRequests.push(
        sig.kind === 'approval'
          ? { kind: 'approval', requestId: sig.requestId, payload: sig.payload }
          : { kind: 'ask_user', requestId: sig.requestId, payload: sig.payload },
      )
      return view
    }
    // v0.32：provider.changed 是全局目录广播（无会话归属）——TUI 不渲染聊天
    // 流条目，模型/档位显示由 /model /effort 命令现拉 provider.list 承载。
    case 'provider.changed':
      return view
    // v0.33b：wiki.changed / wiki.generateStatus 是全局知识库广播（无会话
    // 归属）——TUI 暂无知识卡片界面，视图原样返回。
    case 'wiki.changed':
    case 'wiki.generateStatus':
      return view
    // v0.42：chunk.changed 是 gate 会话切块状态广播——TUI 的切块状态经
    // /chunk status 命令现拉（chunk.get 回执），此信号只保证多客户端基准，
    // 不渲染聊天流条目。视图原样返回。
    case 'chunk.changed':
      return view
  }
}

/**
 * memory.activity detail 的契约形态收窄：GateSignal 里 activity 是 string、
 * detail 是 unknown（src/signals/types.ts），唯一生产者是
 * src/signals/wiring/state-line.ts（layer 'M1/M2' | 'M3' + stamp + taskGoal）。
 * 只接受契约内形态，未知形态不渲染。activity 的两值收窄由调用点的相等判断完成。
 */
const isMemoryDetail = (detail: unknown): detail is { layer: 'M1/M2' | 'M3'; stamp: string; taskGoal: string } =>
  typeof detail === 'object' &&
  detail !== null &&
  ((detail as { layer?: unknown }).layer === 'M1/M2' || (detail as { layer?: unknown }).layer === 'M3') &&
  typeof (detail as { taskGoal?: unknown }).taskGoal === 'string'

/** 按 turnId 找到（或创建）assistant 条目，追加文本 / 思考缓冲。 */
const upsertAssistant = (shard: SessionShard, turnId: string, text: string | undefined, thinking: string | undefined): void => {
  let item = shard.items.find((it): it is Extract<ViewItem, { kind: 'assistant' }> => it.kind === 'assistant' && it.id === turnId)
  if (item === undefined) {
    item = { kind: 'assistant', id: turnId, text: '', thinking: '', streaming: true }
    shard.items.push(item)
  }
  if (text !== undefined) item.text += text
  if (thinking !== undefined) item.thinking += thinking
}

/** tool.result 收口工具卡：状态 + 结果文本 + args 回填 + 产物路径提取。 */
const settleToolCard = (
  shard: SessionShard,
  callId: string,
  fallbackToolName: string,
  result: { content: string; isError?: true; args?: unknown; toolName?: string },
): void => {
  let card = shard.items.find((it): it is Extract<ViewItem, { kind: 'tool' }> => it.kind === 'tool' && it.callId === callId)
  if (card === undefined) {
    // 无 started 卡（如订阅晚于 started）——补一张完成卡，不丢结果。
    card = { kind: 'tool', callId, toolName: fallbackToolName, status: 'running', args: undefined, result: '' }
    shard.items.push(card)
  }
  if (result.toolName !== undefined) card.toolName = result.toolName
  if (result.args !== undefined) card.args = result.args
  card.result = result.content
  card.status = result.isError === true ? 'failure' : 'success'
  const produced = extractProducedPath(card.toolName, card.args)
  if (produced !== undefined) card.producedPath = produced
}

const extractProducedPath = (toolName: string, args: unknown): string | undefined => {
  if (!PRODUCING_TOOLS.has(toolName)) return undefined
  const path = (args as { path?: unknown } | null | undefined)?.path
  return typeof path === 'string' ? path : undefined
}

// ============================================================================
// hydrateHistory —— canonical turns → 与实时路径同构的条目
// ============================================================================

/**
 * 用 canonical 消息历史（session.history 回执）重建一个分片。产出与
 * applySignal 回放等价信号序列**同构**的 items（计划 §4.5），完成后分片标记
 * hydrated。
 *
 * 在途回合（G6）：hydrate 只补历史，不杀在途状态——
 *   - phase：分片正处在 streaming（user.prompt 已发、turn.end 未到）时保持
 *     streaming，不被历史重置成 idle；turn.end 到达时自然收敛。无在途回合
 *     时行为与从前完全一致（整体重置为 idle）。
 *   - items：历史照常整体重建（在途回合**已完成轮次**的正文/工具卡已被
 *     finalizeRound 持久化进 canonical，重建即覆盖，保留 live 项会重复）；
 *     仅 inFlightTurnIds 里的流式尾部（正在增长、尚未持久化的部分正文）
 *     保留，追加在历史项之后——后续 delta 经 upsertAssistant 按 turnId
 *     继续落进同一 item，turn.end 收口。
 */
export const hydrateHistory = (view: SessionView, sessionId: string, turns: readonly ConversationTurn[]): SessionView => {
  const shard = ensureShard(view, sessionId)
  const wasStreaming = shard.phase === 'streaming'
  const inFlightItems = wasStreaming
    ? shard.items.filter((it): it is Extract<ViewItem, { kind: 'assistant' }> => it.kind === 'assistant' && shard.inFlightTurnIds.has(it.id))
    : []
  // memory 项是 live-only（v0.30）：session.history 只回放 canonical turns，
  // 不回放 StateLine 写入，所以这里整体重建 items 时压缩标记自然消失——
  // 属预期行为，不做历史重建兜底（也不为 compaction-note-/histtable- 等子代理
  // 私有会话 id 做防御渲染——它们不会出现在工作代理历史）。
  shard.items = []
  shard.stats = emptyStats()

  for (const turn of turns) {
    if (turn.role === 'user') {
      shard.items.push({ kind: 'user', id: turn.id, text: userText(turn.content) })
    } else if (turn.role === 'assistant') {
      shard.items.push({ kind: 'assistant', id: turn.id, text: turn.content ?? '', thinking: '', streaming: false })
      for (const call of turn.toolCalls ?? []) {
        shard.items.push({
          kind: 'tool',
          callId: call.id,
          toolName: call.function.name,
          status: 'running',
          args: parseToolArgs(call.function.arguments),
          result: '',
        })
      }
    } else {
      settleToolCard(shard, turn.toolCallId, turn.toolName ?? '', turn)
    }
  }

  shard.items.push(...inFlightItems)
  shard.phase = wasStreaming ? 'streaming' : 'idle'
  shard.hydrated = true
  return view
}

/** user content 的文本投影：string 直用；ContentPart[] 拼 text 部分。 */
const userText = (content: string | readonly ContentPart[]): string => {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is ContentPart & { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/** ToolCall.function.arguments 是 raw JSON string（src/protocol/types.ts）——按需解析，失败不猜。 */
const parseToolArgs = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

// ============================================================================
// 视图操作 + helpers
// ============================================================================

/**
 * 切活跃会话——只切视图指针，其他分片的在途回合不受任何影响（G6：后台
 * 信号继续落各自分片）。目标分片不存在则建空分片（渲染层立刻有东西可画）。
 */
export const setActiveSession = (view: SessionView, id: string): SessionView => {
  ensureShard(view, id)
  view.activeSessionId = id
  return view
}

/**
 * 本地追加用户消息并把分片置为 streaming。存在理由：协议层没有 user.message
 * 出站信号（v0.22 已知局限），user 条目只能由 app 在发送 user.prompt 时
 * 主动投影进视图——这是那个投影的唯一入口。
 */
export const appendUserMessage = (view: SessionView, sessionId: string, text: string): SessionView => {
  const shard = ensureShard(view, sessionId)
  shard.items.push({ kind: 'user', id: `local-${shard.items.length}`, text })
  shard.phase = 'streaming'
  return view
}

/**
 * 请求已应答（app 发出 approval.decision / ask_user.answer 回包后调用），
 * 从分片队列移除。未知 requestId 静默忽略（与 gate.resolve 的迟到回包语义
 * 对齐）。
 */
export const settleRequest = (view: SessionView, sessionId: string, requestId: string): SessionView => {
  const shard = view.shards.get(sessionId)
  if (shard === undefined) return view
  shard.pendingRequests = shard.pendingRequests.filter((r) => r.requestId !== requestId)
  return view
}

/** 全部分片 id（首次出现顺序）。 */
export const listSessions = (view: SessionView): string[] => [...view.shards.keys()]

/** 活跃分片（未设置活跃会话时 undefined）。 */
export const activeShard = (view: SessionView): SessionShard | undefined =>
  view.activeSessionId === undefined ? undefined : view.shards.get(view.activeSessionId)

/**
 * 挂起审批数。带 sessionId 只数该分片；缺省数全部（状态栏口径）。
 * 只数 approval——ask_user 是提问不是审批（输入态机两种浮层，计划 §4.6）。
 */
export const pendingApprovalCount = (view: SessionView, sessionId?: string): number => {
  const shards = sessionId === undefined ? [...view.shards.values()] : [view.shards.get(sessionId)].filter((s) => s !== undefined)
  return shards.reduce((n, s) => n + s.pendingRequests.filter((r) => r.kind === 'approval').length, 0)
}

/** 挂起提问数（与 pendingApprovalCount 对称）。 */
export const pendingAskCount = (view: SessionView, sessionId?: string): number => {
  const shards = sessionId === undefined ? [...view.shards.values()] : [view.shards.get(sessionId)].filter((s) => s !== undefined)
  return shards.reduce((n, s) => n + s.pendingRequests.filter((r) => r.kind === 'ask_user').length, 0)
}

/** 会话工具清单（session.event 'tools' 的投影，v0.28 契约；未收到时 undefined）。 */
export const toolInventory = (shard: SessionShard): readonly ToolInventoryEntry[] | undefined => {
  const data = shard.events['tools'] as { tools?: ToolInventoryEntry[] } | undefined
  return data?.tools
}
