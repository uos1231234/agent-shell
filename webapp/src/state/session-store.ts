// session-store：WS 事件 → 会话视图的增量 reducer（前端核心）。
//
// 原则（v0.22 计划 §4.1）：UI 是"信号的忠实投影"——不预测/不缓存后端状态，
// 每条信号即时反映。会话视图 = ChatItem 列表（user 消息 + assistant turn）+
// timeline（事件台账）+ artifacts + logs。reducer 是纯函数，vitest 全覆盖。
//
// 用户消息：事件流无 user.message 信号（计划 §7 局限），composer 发出时
// optimistic append；恢复场景由 history 补全。
//
// turn.end 无 turnId（IMLoopResult 是 runIMLoop 级聚合）——metrics/reason 落在
// SessionView.lastResult（会话级"上一回合统计"），per-turn 不归因。

import { create } from 'zustand'
import type {
  GateSignal,
  GateRequest,
  SessionInfo,
  ArtifactHandle,
  ConversationTurn,
  ContentPart,
  SessionToolsPayload,
  ProviderCatalog,
  WikiGenerateStatus,
  GoalState,
  WorkflowState,
} from '../api/contract'

// ---------------------------------------------------------------------------
// 视图类型
// ---------------------------------------------------------------------------

export type ToolCallView = {
  callId: string
  name: string
  args: unknown
  result?: string
  isError?: boolean
  /** tool.started 已见、tool.result 未到。 */
  pending: boolean
}

export type TurnMetrics = {
  totalTokens: number
  promptTokens: number
  completionTokens: number
  /** 思考 tokens 累计（v0.32；上游带 reasoning_tokens 才非 0）。 */
  reasoningTokens: number
  stepCount: number
  toolCallCount: number
  elapsedMs: number
  lastRequestTokens: number
}

export type TurnView = {
  type: 'turn'
  turnId: string
  text: string
  /** 推理模型的思考流（reasoning_delta → thinking.delta），默认折叠展示。 */
  thinking: string
  toolCalls: Record<string, ToolCallView>
  toolCallOrder: string[]
  recovered?: boolean
}

export type UserMessageView = {
  type: 'user'
  id: string
  text: string
  recovered?: boolean
}

// v0.30：上下文压缩 / M3 归档标记（memory.activity 信号的 live-only 投影）。
// layer/taskGoal 来自后端 state-line 接线器的 detail（缺失时为空串，渲染端降级）。
export type MemoryItemView = {
  type: 'memory'
  id: string
  activity: 'memory.compressed' | 'memory.archived'
  layer: string
  taskGoal: string
}

/**
 * v0.41：canonical 里 `goal-<uuid>` user 回合（harness 生成的续跑提醒）的
 * 恢复投影——渲染为分隔条而非普通用户气泡（提醒是 harness 生成物，不是用户
 * 说话）。live 侧不经此类型：续跑提醒实时可见于 goal.changed round 事件，
 * session.history 回放时才需要识别 goal- 前缀。
 */
export type GoalMarkerView = {
  type: 'goal'
  id: string
  text: string
}

export type ChatItem = TurnView | UserMessageView | MemoryItemView | GoalMarkerView

export type TimelineEntry = {
  seq: number
  kind: string
  detail: string
}

export type LogEntry = {
  seq: number
  ts: number
  level: string
  msg: string
  component?: string
  fields?: Record<string, unknown>
}

export type LastResultView = {
  reason: string
  turns: number
  metrics: TurnMetrics
  hits: ReadonlyArray<{ id: string; reason: string }>
}

export type SessionView = {
  info?: SessionInfo
  systemPrompt?: string
  /** v0.28：session.event 'tools' 推来的工具自描述清单（可选——未收到信号即为 undefined，不默认空数组）。 */
  tools?: SessionToolsPayload['tools']
  items: ChatItem[]
  timeline: TimelineEntry[]
  artifacts: ArtifactHandle[]
  running: boolean
  /**
   * v0.34 C1：该会话排队中的用户消息条数（`turn.queue` 信号的权威投影）。
   * 前端只镜像后端广播的 pending，不自己推算——入队/出队/取消丢弃/会话关闭
   * 后端都会发一条，因此不会因漏掉某条状态转移而显示错状态。
   */
  queuedCount: number
  /** permission.changed 推送的忠实投影（后端事实源；per-session 独立，未收到信号即 false）。 */
  permissionFull: boolean
  /**
   * v0.41：该会话当前 goal 的忠实投影（`undefined` = 未激活）。goal.changed
   * 信号驱动：set 建立、round 更新轮次与裁决、终止型事件（met / impossible /
   * rounds_exhausted / cleared）清空。不本地乐观——刷新/多客户端天然一致。
   * live-only 局限与 CLI 相同：round 事件不带 condition，中途接入的客户端
   * 没有条件文本（后端权威状态经 goal.get 现拉）。
   */
  goal?: GoalState
  /** LongHorizon workflow is a per-session signal projection. */
  workflow?: WorkflowState
  lastResult?: LastResultView
  /**
   * 在途 turnId 感知（mid-turn resync 修复，语义对齐 CLI cli/session-view.ts）：
   * 已流出正文、但 canonical 尚未落盘的 turnId 集合。生命周期 = assistant/
   * thinking delta 加入；tool.started/tool.result 移除（loop 的 finalizeRound
   * 先持久化该轮正文、再执行工具——工具信号到达即该轮正文已入历史）；
   * turn.end 清空。applyHistory 据此保留流式尾部条目（否则整体替换会冲掉
   * 正在增长的 partial 正文，后续 delta 从中途重建导致文本截断）。
   * 可选仅为兼容 MessageList 的兜底字面量——emptySession() 恒提供，reducer
   * 把 undefined 当空集合处理。
   */
  inFlightTurnIds?: ReadonlySet<string>
}

const LOG_CAP = 1000
const TIMELINE_CAP = 20_000

const emptySession = (): SessionView => ({
  items: [],
  timeline: [],
  artifacts: [],
  running: false,
  queuedCount: 0,
  permissionFull: false,
  inFlightTurnIds: new Set<string>(),
})

const EMPTY_IN_FLIGHT: ReadonlySet<string> = new Set()

/** in-flight 集合的不可变增删（reducer 纯函数纪律：不原地改旧 state 持有的 Set；undefined 当空集合）。 */
const withInFlight = (ids: ReadonlySet<string> | undefined, turnId: string, present: boolean): ReadonlySet<string> => {
  if ((ids?.has(turnId) ?? false) === present) return ids ?? EMPTY_IN_FLIGHT
  const next = new Set(ids)
  if (present) next.add(turnId)
  else next.delete(turnId)
  return next
}

// ---------------------------------------------------------------------------
// reducer（纯函数，导出供单测）
// ---------------------------------------------------------------------------

export type StoreState = {
  sessions: Record<string, SessionView>
  sessionList: SessionInfo[]
  logs: LogEntry[]
  /**
   * 服务商/模型/档位目录（v0.32）：provider.changed 广播的忠实投影 +
   * ModelSwitcher 打开时的 provider.list 回执填充。undefined = 未拉取
   * （选择器首次打开时拉取，不预先请求）。
   */
  providerCatalog: ProviderCatalog | undefined
  /** wiki.changed 广播时间戳（v0.33b 知识卡片面板刷新信号；0 = 未变更过）。 */
  wikiChangedAt: number
  /** wiki.generateStatus 投影（v0.33b：工作区知识库生成任务的进度/结果）。 */
  wikiGen: WikiGenerateStatus | undefined
  /** 审批 / ask_user 请求队列（浮层数据源；回包后移除）。 */
  pendingRequests: GateRequest[]
  activeSessionId: string | null
}

export type StoreActions = {
  handleSignal: (sig: GateSignal | GateRequest) => void
  setSessionList: (infos: SessionInfo[]) => void
  upsertSessionInfo: (info: SessionInfo) => void
  applyHistory: (sessionId: string, turns: ConversationTurn[]) => void
  setActiveSession: (id: string | null) => void
  appendLocalUserMessage: (sessionId: string, text: string) => void
  markRunning: (sessionId: string, running: boolean) => void
  removePendingRequest: (requestId: string) => void
  /** v0.32：provider.list 回执填充目录（与 provider.changed 广播同投影）。 */
  setProviderCatalog: (catalog: ProviderCatalog) => void
}

const getSession = (state: StoreState, sid: string): SessionView => state.sessions[sid] ?? emptySession()

const withSession = (state: StoreState, sid: string, patch: (s: SessionView) => SessionView): StoreState => {
  const cur = getSession(state, sid)
  return { ...state, sessions: { ...state.sessions, [sid]: patch(cur) } }
}

const turnItem = (turnId: string, recovered?: boolean): TurnView => ({
  type: 'turn',
  turnId,
  text: '',
  thinking: '',
  toolCalls: {},
  toolCallOrder: [],
  ...(recovered ? { recovered: true } : {}),
})

/** 更新（或追加）items 里指定 turnId 的 turn；返回新数组。 */
const upsertTurn = (items: ChatItem[], turnId: string, patch: (t: TurnView) => TurnView, recovered?: boolean): ChatItem[] => {
  const idx = items.findIndex((it) => it.type === 'turn' && it.turnId === turnId)
  if (idx === -1) return [...items, patch(turnItem(turnId, recovered))]
  const next = [...items]
  next[idx] = patch(items[idx] as TurnView)
  return next
}

const abbrev = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? ''
  return s.length > 80 ? s.slice(0, 80) + '…' : s
}

/** memory.activity 的 detail 窄化（后端 state-line 接线器形态：{ layer, stamp, taskGoal }）。 */
const memoryDetailOf = (detail: unknown): { layer: string; taskGoal: string } => {
  if (detail === undefined || typeof detail !== 'object') return { layer: '', taskGoal: '' }
  const d = detail as { layer?: unknown; taskGoal?: unknown }
  return {
    layer: typeof d.layer === 'string' ? d.layer : '',
    taskGoal: typeof d.taskGoal === 'string' ? d.taskGoal : '',
  }
}

const timelineEntry = (seq: number, sig: GateSignal | GateRequest): TimelineEntry => {
  const detail = (() => {
    switch (sig.kind) {
      case 'assistant.delta':
      case 'thinking.delta':
        return sig.text
      case 'tool.started':
        return `${sig.toolName}(${abbrev(sig.args)})`
      case 'tool.result':
        return `${sig.toolName} → ${abbrev(sig.result?.content)}`
      case 'artifact':
        return sig.handle.title
      case 'turn.end':
        return `${sig.result.reason} · ${sig.result.turns} turns · ${sig.result.metrics.totalTokens} tokens`
      case 'turn.queue':
        return `排队 ${sig.pending} 条`
      case 'session.event':
        return sig.event
      case 'memory.activity': {
        // detail = state-line 接线器的 { layer, stamp, taskGoal }；缺失时降级为 activity 本身。
        if (sig.detail === undefined || typeof sig.detail !== 'object') return sig.activity
        const d = sig.detail as { layer?: unknown; taskGoal?: unknown }
        const layer = typeof d.layer === 'string' ? d.layer : ''
        const goal = typeof d.taskGoal === 'string' ? d.taskGoal : ''
        return [sig.activity, layer, goal].filter(Boolean).join(' · ')
      }
      case 'log':
        return sig.msg
      case 'approval':
        return `${sig.payload.toolName}: ${sig.payload.reason}`
      case 'ask_user':
        return sig.payload.questions.map((q) => q.question).join(' / ')
      case 'permission.changed':
        return sig.full ? 'full access' : 'default'
      // v0.32：provider.changed 是全局目录广播——timeline 记一行摘要（台账可审计）。
      case 'provider.changed': {
        const active = sig.catalog.providers.find((p) => p.active)
        return active !== undefined
          ? `${active.selectedModel} · ${active.reasoningEffort ?? '默认'}`
          : 'provider catalog updated'
      }
      // v0.33b：wiki.changed 全局知识库变更广播——timeline 记一行摘要。
      case 'wiki.changed':
        return '知识库已更新'
      // v0.33b 第二轮：生成任务状态。
      case 'wiki.generateStatus': {
        const st = sig.status
        if (st.status === 'started') return `开始生成知识库：${st.workDir}`
        if (st.status === 'completed') return `知识库生成完成（+${st.cardsCreated} 卡）`
        return `知识库生成失败：${st.error}`
      }
      // v0.41 goal 模式：紧凑摘要进台账（可审计）。完整投影（目标条件、轮次
      // 进度条、judge 理由）属后续工作，见 v0.41 计划 §9 前端待同步清单。
      // never 穷尽守卫是刻意的：新增 GoalEvent status 会让 webapp 编译失败，
      // 把"前端待同步"从文档约定升级成编译期强制。
      // v0.42（并行会话）：大输入切块状态广播——最小投影保编译绿（台账一行），
      // 完整 UI（ContextMeter 徽标等）属 v0.42 前端同步。
      case 'chunk.changed':
        return sig.enabled ? '切块开启' : '切块关闭'
      case 'workflow.changed':
        return `长程工作流 ${sig.state.enabled ? '开启' : '关闭'} · ${sig.state.phase}`
      case 'workflow.run': {
        const e = sig.event
        return `workflow ${e.phase}${e.role !== undefined ? ` · ${e.role}` : ''}`
      }
      case 'goal.changed': {
        const e = sig.event
        switch (e.status) {
          case 'set':
            return `目标已设置 · 上限 ${e.maxRounds} 轮`
          case 'round':
            return e.verdict.verdict === 'judge_failed'
              ? `目标判定未跑成 · 第 ${e.round}/${e.maxRounds} 轮`
              : `目标未达成 · 第 ${e.round}/${e.maxRounds} 轮`
          case 'met':
            return `目标已达成 · ${e.roundsUsed} 轮`
          case 'impossible':
            return '目标不可达'
          case 'rounds_exhausted':
            return `目标轮次用尽 · ${e.roundsUsed} 轮`
          case 'cleared':
            return '目标已关闭'
          case 'goal_block_merged':
            return `goal 块已合并 · ${e.blockTokens}→${e.envelopeTokens} tok`
          case 'envelopes_distilled':
            return `信封已折叠 ${e.sourceStamps.length}→1 · ${e.beforeTokens}→${e.afterTokens} tok`
          case 'distill_failed':
            return '信封折叠失败（保留原样）'
          default: {
            const _exhaustive: never = e
            return _exhaustive
          }
        }
      }
    }
  })()
  return { seq, kind: sig.kind, detail }
}

const pushTimeline = (tl: TimelineEntry[], entry: TimelineEntry): TimelineEntry[] => {
  const next = [...tl, entry]
  return next.length > TIMELINE_CAP ? next.slice(next.length - TIMELINE_CAP) : next
}

/**
 * 单条信号 → 新 state。GateRequest（approval/ask_user）进 pendingRequests 队列；
 * GateSignal 按会话分桶更新视图；log 无会话归属走全局（全局 seq 去重由
 * ws-client 负责，这里只追加）。
 */
export const reduceSignal = (state: StoreState, sig: GateSignal | GateRequest, seq: number): StoreState => {
  if (sig.kind === 'approval' || sig.kind === 'ask_user') {
    const base =
      sig.sessionId !== undefined
        ? withSession(state, sig.sessionId, (s) => ({
            ...s,
            timeline: pushTimeline(s.timeline, timelineEntry(seq, sig)),
          }))
        : state
    return { ...base, pendingRequests: [...base.pendingRequests, sig] }
  }

  if (sig.kind === 'log') {
    const entry: LogEntry = {
      seq,
      ts: sig.ts,
      level: sig.level,
      msg: sig.msg,
      ...(sig.component !== undefined ? { component: sig.component } : {}),
      ...(sig.fields !== undefined ? { fields: sig.fields as Record<string, unknown> } : {}),
    }
    const logs = [...state.logs, entry]
    return {
      ...state,
      logs: logs.length > LOG_CAP ? logs.slice(logs.length - LOG_CAP) : logs,
    }
  }

  // v0.32：provider.changed 全局目录广播（无会话归属）——忠实替换投影。
  if (sig.kind === 'provider.changed') {
    return { ...state, providerCatalog: sig.catalog }
  }

  // v0.33b：wiki.changed 全局知识库变更广播（无会话归属）——知识卡片面板
  // 订阅 wikiChangedAt 变化后重拉列表（面板数据不走会话分片）。
  if (sig.kind === 'wiki.changed') {
    return { ...state, wikiChangedAt: Date.now() }
  }

  // v0.33b 第二轮：wiki.generateStatus 生成任务进度——忠实替换投影。
  if (sig.kind === 'wiki.generateStatus') {
    return { ...state, wikiGen: sig.status }
  }

  return withSession(state, sig.sessionId, (s) => {
    switch (sig.kind) {
      case 'assistant.delta':
        // 正文在流 → 该轮尚未落 canonical，标记在途（hydrate/resync 时保留流式尾部）。
        return {
          ...s,
          timeline: pushTimeline(s.timeline, timelineEntry(seq, sig)),
          items: upsertTurn(s.items, sig.turnId, (t) => ({ ...t, text: t.text + sig.text })),
          inFlightTurnIds: withInFlight(s.inFlightTurnIds, sig.turnId, true),
        }
      case 'thinking.delta':
        // 推理模型的思考流（v0.22 协议层已接入 reasoning_delta）——累积进 turn，
        // UI 折叠展示。
        return {
          ...s,
          timeline: pushTimeline(s.timeline, timelineEntry(seq, sig)),
          items: upsertTurn(s.items, sig.turnId, (t) => ({ ...t, thinking: t.thinking + sig.text })),
          inFlightTurnIds: withInFlight(s.inFlightTurnIds, sig.turnId, true),
        }
      case 'tool.started':
        // 工具信号到达 = 该轮正文已被 finalizeRound 持久化（先持久化后执行工具），
        // 不再是"历史覆盖不到"的在途正文。
        return {
          ...s,
          timeline: pushTimeline(s.timeline, timelineEntry(seq, sig)),
          items: upsertTurn(s.items, sig.turnId, (t) => {
            if (t.toolCalls[sig.callId] !== undefined) return t
            return {
              ...t,
              toolCalls: {
                ...t.toolCalls,
                [sig.callId]: { callId: sig.callId, name: sig.toolName, args: sig.args, pending: true },
              },
              toolCallOrder: [...t.toolCallOrder, sig.callId],
            }
          }),
          inFlightTurnIds: withInFlight(s.inFlightTurnIds, sig.turnId, false),
        }
      case 'tool.result':
        return {
          ...s,
          timeline: pushTimeline(s.timeline, timelineEntry(seq, sig)),
          items: upsertTurn(s.items, sig.turnId, (t) => {
            const call = t.toolCalls[sig.callId]
            if (call === undefined) {
              // 恢复/丢帧场景：result 先于 started——直接以 result 建卡。
              // args 回填：ToolTurn 随 v0.24 携带 args，缺失则诚实置 undefined。
              return {
                ...t,
                toolCalls: {
                  ...t.toolCalls,
                  [sig.callId]: {
                    callId: sig.callId,
                    name: sig.result.toolName ?? 'unknown',
                    args: sig.result.args ?? undefined,
                    result: sig.result.content,
                    ...(sig.result.isError ? { isError: true } : {}),
                    pending: false,
                  },
                },
                toolCallOrder: [...t.toolCallOrder, sig.callId],
              }
            }
            return {
              ...t,
              toolCalls: {
                ...t.toolCalls,
                [sig.callId]: {
                  ...call,
                  // args 回填：result 携带 args（完整聚合）优先，缺失保留 started 时的。
                  args: sig.result.args ?? call.args,
                  result: sig.result.content,
                  ...(sig.result.isError ? { isError: true } : {}),
                  pending: false,
                },
              },
            }
          }),
          inFlightTurnIds: withInFlight(s.inFlightTurnIds, sig.turnId, false),
        }
      case 'turn.queue':
        // v0.34 C1 / D9：排队条数的权威广播。直接镜像 pending。
        return {
          ...s,
          queuedCount: sig.pending,
          timeline: pushTimeline(s.timeline, timelineEntry(seq, sig)),
        }
      case 'turn.end':
        // 回合收口：在途集合清空（此后同 turnId 的迟到 delta 视为新一轮，正常语义）。
        // v0.34 C1：若仍有排队（queuedCount > 0），gate 已把队首提升为在途并紧接着
        // 执行 → **不能置 running:false**（否则 UI 会闪一下空闲）。queuedCount 的新值
        // 由随后的 turn.queue 信号权威覆盖（emit 顺序：turn.end 先于 turn.queue）。
        return {
          ...s,
          timeline: pushTimeline(s.timeline, timelineEntry(seq, sig)),
          running: s.queuedCount > 0,
          inFlightTurnIds: EMPTY_IN_FLIGHT,
          lastResult: {
            reason: sig.result.reason,
            turns: sig.result.turns,
            metrics: sig.result.metrics,
            hits: sig.result.hits,
          },
        }
      case 'artifact':
        return {
          ...s,
          timeline: pushTimeline(s.timeline, timelineEntry(seq, sig)),
          artifacts: [...s.artifacts.filter((h) => h.id !== sig.handle.id), sig.handle],
        }
      case 'permission.changed':
        // per-session 权限推送（后端事实源）：显示 = store 忠实投影，无本地乐观态。
        return {
          ...s,
          timeline: pushTimeline(s.timeline, timelineEntry(seq, sig)),
          permissionFull: sig.full,
        }
      // v0.41 goal 模式：台账摘要（可审计）+ SessionView.goal 忠实投影。
      // 投影规则照 CLI session-view.ts 抄（与后端 GoalSessionState 同步）：
      // set 建立、round 只更新轮次与裁决、终止型事件清空；G1/G2 压缩事件
      // （goal_block_merged / envelopes_distilled / distill_failed）只进台账。
      case 'goal.changed': {
        const e = sig.event
        let goal = s.goal
        if (e.status === 'set') {
          goal = { condition: e.condition, maxRounds: e.maxRounds, roundsUsed: 0 }
        } else if (e.status === 'round') {
          goal = {
            condition: s.goal?.condition ?? '',
            maxRounds: e.maxRounds,
            roundsUsed: e.round,
            lastVerdict: e.verdict,
          }
        } else if (e.status === 'met' || e.status === 'impossible' || e.status === 'rounds_exhausted' || e.status === 'cleared') {
          goal = undefined
        }
        // exactOptionalPropertyTypes 下清除可选字段必须走解构 omit（显式 undefined 不合法）。
        const timeline = pushTimeline(s.timeline, timelineEntry(seq, sig))
        if (goal === undefined) {
          const { goal: _cleared, ...rest } = s
          return { ...rest, timeline }
        }
        return { ...s, timeline, goal }
      }
      case 'workflow.changed':
        return {
          ...s,
          timeline: pushTimeline(s.timeline, timelineEntry(seq, sig)),
          workflow: sig.state,
        }
      case 'workflow.run':
        return {
          ...s,
          timeline: pushTimeline(s.timeline, timelineEntry(seq, sig)),
        }
      // v0.42（并行会话）：切块状态——最小投影（台账一行），UI 扩充属 v0.42。
      case 'chunk.changed':
        return {
          ...s,
          timeline: pushTimeline(s.timeline, timelineEntry(seq, sig)),
        }
      case 'session.event': {
        const withTl = { ...s, timeline: pushTimeline(s.timeline, timelineEntry(seq, sig)) }
        if (sig.event === 'system.prompt') {
          const text = (sig.data as { text?: string } | undefined)?.text
          return text !== undefined ? { ...withTl, systemPrompt: text } : withTl
        }
        if (sig.event === 'tools') {
          // v0.28：工具自描述清单——data 缺失/无 tools 时不覆盖既有值，timeline 照记。
          const tools = (sig.data as SessionToolsPayload | undefined)?.tools
          return tools !== undefined ? { ...withTl, tools } : withTl
        }
        return withTl
      }
      case 'memory.activity': {
        // live-only：StateLine 写入的实时投影，session.history 不回放 StateLine——
        // hydrate/resync 后压缩标记从聊天流消失是有意行为（层信息仍由 ContextMeter
        // 的 info.layer 承载），不做历史重建兜底。id 用传入 seq 保证唯一。
        const d = memoryDetailOf(sig.detail)
        return {
          ...s,
          timeline: pushTimeline(s.timeline, timelineEntry(seq, sig)),
          items: [
            ...s.items,
            {
              type: 'memory',
              id: `memory-${seq}`,
              activity: sig.activity === 'memory.archived' ? sig.activity : 'memory.compressed',
              layer: d.layer,
              taskGoal: d.taskGoal,
            } satisfies MemoryItemView,
          ],
        }
      }
    }
  })
}

// ---------------------------------------------------------------------------
// zustand store
// ---------------------------------------------------------------------------

let seqCounter = 0
const nextSeq = (): number => ++seqCounter

export const useSessionStore = create<StoreState & StoreActions>()((set) => ({
  sessions: {},
  sessionList: [],
  logs: [],
  providerCatalog: undefined,
  wikiChangedAt: 0,
  wikiGen: undefined,
  pendingRequests: [],
  activeSessionId: null,

  handleSignal: (sig) => set((state) => reduceSignal(state, sig, nextSeq())),

  setSessionList: (infos) => set(() => ({ sessionList: infos })),

  setProviderCatalog: (catalog) => set(() => ({ providerCatalog: catalog })),

  upsertSessionInfo: (info) =>
    set((state) => {
      const known = state.sessionList.some((i) => i.id === info.id)
      return {
        sessionList: known
          ? state.sessionList.map((i) => (i.id === info.id ? info : i))
          : [...state.sessionList, info],
        ...(state.sessions[info.id] !== undefined
          ? { sessions: { ...state.sessions, [info.id]: { ...state.sessions[info.id]!, info } } }
          : {}),
      }
    }),

  applyHistory: (sessionId, turns) =>
    set((state) =>
      withSession(state, sessionId, (s) => ({
        ...s,
        items: applyHistoryItems(s.items, turns, s.inFlightTurnIds),
      })),
    ),

  setActiveSession: (id) => set(() => ({ activeSessionId: id })),

  appendLocalUserMessage: (sessionId, text) =>
    set((state) =>
      withSession(state, sessionId, (s) => ({
        ...s,
        items: [...s.items, { type: 'user', id: `local-${nextSeq()}`, text } satisfies UserMessageView],
      })),
    ),

  markRunning: (sessionId, running) =>
    set((state) => withSession(state, sessionId, (s) => ({ ...s, running }))),

  removePendingRequest: (requestId) =>
    set((state) => ({
      pendingRequests: state.pendingRequests.filter((r) => r.requestId !== requestId),
    })),
}))

// ---------------------------------------------------------------------------
// 产物派生（v0.24 P0）：turn 的工具调用事实 → 产物路径列表（视图层投影，非新状态）
// ---------------------------------------------------------------------------

const PRODUCING_TOOLS = new Set(['write', 'edit', 'search_replace'])

/**
 * 成功（!pending 且非 isError）的 write/edit/search_replace 调用 → args.path
 * （args 为对象且 path 为非空 string 才算），按 toolCallOrder 首见顺序去重。
 * 对实时 reducer 产物与 historyToItems 产物同样适用（恢复后 chips 自动复原）。
 */
export const producedFilesOf = (turn: TurnView): string[] => {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const id of turn.toolCallOrder) {
    const call = turn.toolCalls[id]
    if (call === undefined || call.pending || call.isError === true) continue
    if (!PRODUCING_TOOLS.has(call.name)) continue
    if (call.args === null || typeof call.args !== 'object') continue
    const path = (call.args as { path?: unknown }).path
    if (typeof path !== 'string' || path.length === 0) continue
    if (seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

/** 批次聚合态：error 优先（折叠后错误必须仍可见），其次 pending。 */
export type ToolBatchState = 'error' | 'pending' | 'done'

export type ToolBatchSummary = {
  count: number
  /** 去重后的工具名序列（首见顺序）："read ×2, grep, write"。 */
  label: string
  state: ToolBatchState
  errorCount: number
  pendingCount: number
}

/**
 * 一个轮次（turnId）内所有工具调用的批次摘要——折叠行的数据源。
 * 纯函数：对实时 reducer 产物与 historyToItems 产物同样适用。
 */
export const toolBatchSummary = (calls: readonly ToolCallView[]): ToolBatchSummary => {
  const counts = new Map<string, number>()
  let errorCount = 0
  let pendingCount = 0
  for (const c of calls) {
    counts.set(c.name, (counts.get(c.name) ?? 0) + 1)
    // 与 ToolCallCard 的判态顺序一致：isError 优先于 pending。
    if (c.isError === true) errorCount += 1
    else if (c.pending) pendingCount += 1
  }
  const label = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ')
  const state: ToolBatchState = errorCount > 0 ? 'error' : pendingCount > 0 ? 'pending' : 'done'
  return { count: calls.length, label, state, errorCount, pendingCount }
}


// ---------------------------------------------------------------------------
// history 恢复：ConversationTurn[] → ChatItem[]（交错拼装的"事实"半边）
// ---------------------------------------------------------------------------

const textOf = (content: string | ContentPart[] | null | undefined): string => {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  return content.map((p) => (p.type === 'text' ? p.text : '')).join('')
}

const safeParse = (s: string | undefined): unknown => {
  if (s === undefined) return undefined
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

/**
 * canonical 序列 → 视图 items。assistant turn 承接 tool 结果（按 toolCallId
 * join，arguments 是 raw JSON string——OpenAI 形态）；tool 归属最近的
 * assistant turn（canonical 保证 assistant 在前）。
 *
 * 不加 memory 分支（live-only）：memory.activity 来自 StateLine 写入的实时信号，
 * session.history 不回放 StateLine——恢复后压缩标记从聊天流消失是有意行为
 * （层信息仍在 ContextMeter 的 info.layer），不做历史重建兜底。
 */
export const historyToItems = (turns: ConversationTurn[]): ChatItem[] => {
  const items: ChatItem[] = []
  let lastTurnIdx = -1
  for (const t of turns) {
    if (t.role === 'user') {
      // v0.41：`goal-<uuid>` 回合是 harness 生成的续跑提醒（#GOAL_CONTINUATION
      // 标记块），不是用户说话——渲染为分隔条（GoalMarkerView），不进用户气泡。
      if (t.id.startsWith('goal-')) {
        items.push({ type: 'goal', id: t.id, text: textOf(t.content) })
        lastTurnIdx = -1
        continue
      }
      items.push({ type: 'user', id: t.id, text: textOf(t.content), recovered: true })
      lastTurnIdx = -1
    } else if (t.role === 'assistant') {
      const item: TurnView = {
        type: 'turn',
        turnId: t.id,
        text: textOf(t.content),
        // 思维链落盘（2026-09-12）：历史回合的 reasoning 投影为思考折叠块，
        // 恢复后与 live 同一条渲染路径（TurnView.thinking → ThinkingBlock）。
        thinking: t.reasoning ?? '',
        toolCalls: {},
        toolCallOrder: (t.toolCalls ?? []).map((c) => c.id),
        recovered: true,
      }
      for (const c of t.toolCalls ?? []) {
        item.toolCalls[c.id] = {
          callId: c.id,
          name: c.function.name,
          args: safeParse(c.function.arguments),
          pending: false,
        }
      }
      items.push(item)
      lastTurnIdx = items.length - 1
    } else {
      if (lastTurnIdx >= 0) {
        const item = items[lastTurnIdx] as TurnView
        const existing = item.toolCalls[t.toolCallId]
        item.toolCalls[t.toolCallId] = {
          ...(existing ?? { callId: t.toolCallId, name: t.toolName ?? 'unknown', args: undefined, pending: false }),
          result: t.content,
          ...(t.isError ? { isError: true } : {}),
          pending: false,
        }
      }
    }
  }
  return items
}

/**
 * applyHistory 的条目合成：history 整体替换（v0.24 拍板语义）+ 两类 resync
 * 窗口保护的叠加（v0.29 拍板 / mid-turn resync 修复）。
 *
 * 保护一：未确认 optimistic user 条目。resync 的 history 快照可能恰落在
 * 「前端已 optimistic append、后端尚未落盘 user 回合」之间（user 消息无确认
 * 信号，唯一确认途径是 hydrate）。此时整体替换会冲掉 local- 条目、而快照里
 * 又没有真 user 回合 → 消息暂隐到下次 hydrate。规则（按 content 数量对齐）：
 *   - 本地同 content 的 user 条目总数 > 快照中同 content 的 user 回合数
 *     → 保留末尾相应差额条数的 local- 条目（send 顺序，通常在末尾），
 *       等下次 hydrate 确认；
 *   - 差额 ≤ 0 → 全部丢弃（真回合已在快照中，不重复显示）。
 * 本地计数含既有真 user 条目（同文本场景：旧真条目由快照承接，新 local- 不被
 * 旧回合的错误抵消）。快照 user 回合数只增不减（canonical 追加），多客户端
 * 场景快照更多时按 0 处理。
 *
 * 保护二：in-flight 流式尾部。assistant 回合在 finalizeRound 才落 canonical——
 * 流式进行中（已收到部分 delta、turn.end 未到）resync 时，历史快照不含该
 * turnId，整体替换会冲掉 partial 正文；后续 delta 经 upsertTurn 新建条目，
 * 文本从中途开始（截断），直到下次 hydrate 才自愈。规则：历史照常整体重建
 * （已完成轮次的正文已被持久化，history 必含，保留 live 项会重复），然后把
 * inFlightTurnIds 内的现有 assistant 条目（同一对象引用）追加在历史项之后
 * ——后续 delta 继续命中同一 item，turn.end 收口。两条保护独立生效，保留项
 * 按 current 原相对顺序追加（无在途、无未确认条目时与纯替换逐字节一致）。
 */
export const applyHistoryItems = (
  current: ChatItem[],
  turns: ConversationTurn[],
  inFlightTurnIds: ReadonlySet<string> | undefined = EMPTY_IN_FLIGHT,
): ChatItem[] => {
  const base = historyToItems(turns)

  const locals = current.filter((it): it is UserMessageView => it.type === 'user' && it.id.startsWith('local-'))
  const bump = (m: Map<string, number>, text: string): Map<string, number> =>
    m.set(text, (m.get(text) ?? 0) + 1)
  // 本地 user 条目总数（真条目 + local-），用于同文本差额计算。
  const localTotal = new Map<string, number>()
  for (const it of current) if (it.type === 'user') bump(localTotal, it.text)
  // 快照已确认数（historyToItems 产物中的 user 条目）。
  const confirmed = new Map<string, number>()
  for (const it of base) if (it.type === 'user') bump(confirmed, it.text)

  const keptLocalIds = new Set<string>()
  for (let i = locals.length - 1; i >= 0; i--) {
    const text = locals[i]!.text
    if ((localTotal.get(text) ?? 0) > (confirmed.get(text) ?? 0)) {
      keptLocalIds.add(locals[i]!.id)
      localTotal.set(text, localTotal.get(text)! - 1)
    }
  }

  if (keptLocalIds.size === 0 && inFlightTurnIds.size === 0) return base

  // 两类保留项合一次过滤：保持 current 原相对顺序（user 与在途 turn 交错时
  // 不颠倒——local- 在流式 turn 之前/之后发送都忠实还原）。
  const preserved = current.filter((it) => {
    if (it.type === 'user') return it.id.startsWith('local-') && keptLocalIds.has(it.id)
    // memory 条目是 live-only 投影（session.history 不回放 StateLine），hydrate/resync
    // 时照常被整体替换冲掉——压缩标记消失是有意行为，不保留。
    if (it.type === 'memory') return false
    // goal 条目同理（goal- 回合在 history 快照里，由 historyToItems 重建）。
    if (it.type === 'goal') return false
    return inFlightTurnIds.has(it.turnId)
  })
  return preserved.length > 0 ? [...base, ...preserved] : base
}
