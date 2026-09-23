// v0.10.1c: SystemAgent factory.
//
// A SystemAgent wraps a private databus + conversationMemory + runIMLoop call.
// It is NOT the working agent — it is a background agent (warehouse, compressor,
// recall) that the working agent's tools call via closures.
//
// Each system agent gets its own private databus and conversationMemory so
// its turns never leak into the working agent's prompt. The system agent
// shares the working agent's ToolRegistry (it sees a subset of tools via
// systemToolRefs) and the shared Mailbox.
//
// The factory signature takes `mailbox: Mailbox` directly (USER DECISION:
// no module-level setDefaultMailbox/getDefaultMailbox).
//
// The factory returns `result.metrics` from the inner runIMLoop — not a
// stale copy. Each `run()` call starts with a fresh `createMetrics()`.

import type { AgentId, Databus } from './databus.js'
import type { ConversationMemory, ConversationTurn } from './conversation-memory.js'
import type { Mailbox } from './mailbox/index.js'
import type { Metrics } from '../shell/metrics.js'
import type { State } from '../shell/state.js'
import type { StreamChunk, ChatMessage } from '../protocol/types.js'
import type { ToolRegistry } from '../shell/registry.js'
import type { ShellConfig } from '../shell/config.js'
import type { IMLoopOptions, IMLoopResult } from './loop.js'
import type { StateLine } from './state-line/types.js'
import type { ContextInjector } from './hooks/context-injection.js'
import type { GuardHit } from '../shell/guards.js'
import type { BeforeShellCallContext, BeforeShellCallResult } from './loop-hooks.js'
import { runIMLoop } from './loop.js'
import { createMetrics } from '../shell/metrics.js'
import { createConfig } from '../shell/config.js'
import { Databus as DatabusClass } from './databus.js'
import { ConversationMemory as ConversationMemoryClass } from './conversation-memory.js'
import { appendCanonicalTurn, mintTurnId } from './turn.js'
import { shouldCompact, compactConversation } from './compaction/engine.js'
import { foldOversizeToolTurns } from './tools/history-tool-table.js'
import { GENERIC_TOKEN_COUNTER, type TokenCounter } from '../shared/token-counter.js'
import { applyToolPolicy } from './sub-agent/policy.js'
import {
  loadPersistedConversation, savePersistedConversation,
  loadPersistedDatabus, savePersistedDatabus, databusPersistPathOf,
} from './system-agent-persistence.js'

export type SystemAgentRunResult = {
  output: unknown
  metrics: Metrics
  finalState: State
  // v0.11.3 P1-1: surface the underlying loop's termination reason and guard
  // hits so callers (run_subagent) can distinguish 'completed' from
  // 'guard-tripped' without re-deriving it from metrics.
  reason: IMLoopResult['reason']
  hits: GuardHit[]
  // v0.42（用户拍板 2026-09-16）：提交协议生产结果。装配了 submitToolName 的
  // 代理（compressor）最后一次调用该工具时的 `memory` 参数快照——服务端按
  // schema 约束的 JSON，取代"解析最终回复文本里的自由 JSON"。未调用工具时
  // 为 undefined（调用方视为失败）。
  submitted?: Record<string, unknown> | undefined
}

export type SystemAgent = {
  run(input: { messages: ChatMessage[]; metadata?: Record<string, unknown> }): Promise<SystemAgentRunResult>
  stop(): void
  send(message: ChatMessage): void
}

const rid = (prefix: string): string => mintTurnId(prefix)

export const createSystemAgent = (opts: {
  name: AgentId
  systemPrompt: string
  toolRefs: readonly string[]
  llmStreamChat: (
    url: string,
    request: { model: string; messages: ChatMessage[]; tools: unknown[]; [k: string]: unknown },
  ) => AsyncIterable<StreamChunk>
  url: string
  model: string
  mailbox: Mailbox
  registry: ToolRegistry
  stateLine: StateLine
  config?: ShellConfig
  // v0.11: optional injected private databus. When provided, the agent
  // projects its tool turns into this bus instead of a fresh per-run one.
  // Used for user-defined sub-agents: the injected bus is the registry's
  // sharedDatabus so cross-sub-agent visibility works.
  databus?: Databus
  // v0.11: optional contextual databus. When provided, tools running inside
  // this agent's loop read from this bus (read-only context) instead of the
  // private bus. Wired to IMLoopOptions.ctxDatabus. For sub-agents this is
  // [sharedDatabus, workingDatabus]; for the working agent this is the sub-agents'
  // shared bus.
  sharedDatabus?: Databus | readonly Databus[]
  // v0.11.1 P2.3: recursion depth. The working agent starts at 0; each
  // run_subagent call increments by 1 before creating this agent.
  subAgentDepth?: number
  // v0.13.1: wiki system agent 标记。设为 true 时 loopOpts.isWikiAgent=true，
  // registry.execute() 据此放行 wiki__ 前缀工具。仅 wiki agent 传 true。
  isWikiAgent?: boolean
  // v0.16: security-router session identifier. Sub-agents inherit their
  // parent's sessionId (run-subagent.ts passes ctx.sessionId here) so a
  // parent's approval grants cover its children. Undefined falls back to
  // the router's '__global__' session.
  sessionId?: string
  // v0.17: per-loop control-flow hooks. Forwarded so child system/sub-agents
  // can intervene at the same phase points as the parent loop.
  hooks?: import('./loop-hooks.js').LoopHooks | undefined
  /**
   * v0.41: 调用方的取消信号，透传 IMLoopOptions.signal。
   *
   * 为什么需要：judge 智能体在 beforeComplete hook 内跑一次完整 LLM 调用。
   * 不透传的话 turn.cancel 期间它会跑到自己结束才响应——AGENTS.md 记录的
   * "turn.cancel 三层真取消"要求取消必须真的生效，不留覆盖缺口。
   * 缺省不传 = 既有系统智能体（warehouse/compressor/recall/wiki）行为不变。
   */
  signal?: AbortSignal | undefined
  /**
   * v0.41 D19: provider 要求严格角色交替时置 true，透传 IMLoopOptions.strictAlternation
   * → ShellDeps → shell/call.ts 出站前合并相邻 user。
   *
   * 消费方目前只有 goal judge：它把工作代理的全量 canonical 逐字铺进自己的请求，
   * 而 goal 模式下的 canonical 会出现相邻 user（G1 信封 mem- 紧邻续跑提醒 goal-）。
   * 其余系统智能体（warehouse/compressor/recall/wiki）不传 = 行为逐字节不变。
   */
  strictAlternation?: boolean | undefined
  // v0.18: sub-agent tool policy for load_tools runtime filtering.
  // When set, load_tools checks each requested tool against this policy.
  toolPolicy?: import('./sub-agent/policy.js').SubAgentToolPolicy
  // 会话工作区。透传 IMLoopOptions.workDir → ctx.workDir → runtime 注入
  // （WorkDir 行，与主代理对称）。run-subagent 从 deps.workDir 传入；
  // 缺省不注入，无害。
  workDir?: string
  /**
   * v0.34 D13（用户拍板 2026-09-10）：上下文注入器。提供时透传
   * `IMLoopOptions.contextInjector`，loop 每轮调 `inject(ctx)` 拿四类注入
   * （runtime/temporal afterSystem + memory/architecture afterUser）。
   *
   * 此前子代理/系统智能体都没有它 → 看不到 MEMORY.md / ARCHITECTURE.md /
   * 运行时与时间信息，而工作代理看得到。实例可与工作代理共享：`inject(ctx)`
   * 的 agentId/workDir/sessionId 由各自 loop 提供（loop.ts 的 contextInjector
   * 分支），互不串扰。
   */
  contextInjector?: ContextInjector
  /**
   * v0.30: 持久会话开关（用户拍板 2026-09-09）。true 时 conversationMemory
   * 与 databus 跨 run() 保留——代理被多次唤醒时在"上一轮状态"上继续，
   * 邮件往来因此有上下文（读到的询问与自己的回复都在持久历史里）。
   * 仅 warehouse 开启；compressor/recall/子代理保持单发 fresh 语义。
   */
  persistent?: boolean
  /**
   * v0.30: 持久会话的落盘路径（persistent=true 时生效）。JSONL 全量快照，
   * 每次 run 结束原子重写。落盘位置由宿主装配层计算——见
   * system-agent-persistence.ts 顶部注释（<dataDir>/<sessionId>/state/
   * warehouse-session.jsonl）。缺省 = 仅进程内持久，不落盘。
   */
  persistPath?: string
  /**
   * v0.30: 交接笔记压缩（KimiCode 式）。提供时 loop 的 beforeShellCall
   * 前置压缩检查：上下文 > triggerRatio × config.maxTokens（默认 0.85）→
   * LLM 生成交接笔记 → assistant/tool 折叠进笔记、user 消息逐字保留
   * （head/tail 预算）。子代理与 recall/warehouse 装配；compressor 单发
   * 固定输入不装。
   */
  compaction?: {
    triggerRatio?: number
    /**
     * 压缩失败重试：连续失败上限（默认 3）与间隔毫秒（默认 15_000，
     * 用户拍板 2026-09-09）。测试注入小值避免 45s 等待。
     */
    retryLimit?: number
    retryDelayMs?: number
  }
  /**
   * v0.42: 提交协议工具名（对齐参考实现的 function-calling
   * 方案）。装配后，代理循环里最后一次调用该工具的参数快照经
   * `result.submitted` 返回——生产结果由服务端按 schema 约束输出，不再依赖
   * "模型把 JSON 写成最终回复文本"。仅 compressor 装配。
   */
  submitToolName?: string
  /**
   * v0.30: 压缩失败上报的接收方（工作代理 / 调用者代理）。压缩连续失败后
   * mailbox systemSend 通知它——系统智能体报"应用程序错误"，子代理报
   * 压缩失败让主代理自行处理。系统智能体由装配层传入（handle.info.
   * workingAgentId）；子代理由 run-subagent 传入父 ctx.agentId。
   * 缺省 = 不做失败上报（纯静默重试）。
   */
  workingAgentId?: string
  /** Host-selected counter, or a resolver for a hot-switched provider/model. */
  tokenCounter?: TokenCounter | (() => TokenCounter)
}): SystemAgent => {
  // Per-run stores: system agents are single-shot — each run() is an
  // independent task. Reassigning fresh instances at the start of run()
  // prevents history accumulating across calls. `let` (not const) so
  // send() below keeps working against the current instance.
  // v0.11: if an external databus is injected, reuse it; otherwise create a
  // private one per run (built-in system agent behavior).
  let agentDatabus = opts.databus ?? new DatabusClass()
  let agentConvMem = new ConversationMemoryClass()
  // v0.30: 持久会话——工厂构造时读回既有状态（含压缩后的交接笔记形态）。
  // conversation 与私有 databus 都落盘（用户拍板 2026-09-09：系统智能体的
  // 工具活动记录是最宝贵的信息）。落盘位置见 system-agent-persistence.ts
  // 顶部注释。外部注入的 databus（子代理共享 bus）不落盘——它属于父会话。
  if (opts.persistent === true) {
    loadPersistedConversation(agentConvMem, opts.persistPath)
    if (opts.databus === undefined) {
      loadPersistedDatabus(agentDatabus, databusPersistPathOf(opts.persistPath))
    }
  }
  // v0.30: 跨 run 的最近请求真实 usage。每个 run() 是独立的 runIMLoop，
  // lastMetrics 不跨 run 保留——不传递的话持久会话每次唤醒的压缩触发
  // 都退化成文本估算（对中文低估 3-6 倍）。语义：上次请求模型实际见过的
  // prompt 大小，是本次唤醒时上下文规模的最好已知值。
  let lastKnownRequestTokens = 0
  // v0.42: 提交协议捕获槽。submitToolName 装配时，run() 内 beforeToolExecution
  // 钩子把最后一次 submit 工具的 `memory` 参数快照写进来；run() 结束原样返回。
  let submitted: Record<string, unknown> | undefined = undefined

  const agentConfig = opts.config ?? createConfig()

  const chatMessageToTurn = (msg: ChatMessage): ConversationTurn => {
    if (msg.role === 'user') {
      return { id: rid(`sys-${opts.name}-in`), role: 'user', content: msg.content, at: Date.now() }
    }
    if (msg.role === 'tool') {
      return {
        id: rid(`sys-${opts.name}-in`),
        role: 'tool',
        toolCallId: msg.tool_call_id,
        content: msg.content,
        sourceAgentId: opts.name,
        at: Date.now(),
      }
    }
    // assistant (system agents never receive system-role messages as input)
    const turn: ConversationTurn = {
      id: rid(`sys-${opts.name}-in`),
      role: 'assistant',
      content: msg.content,
      at: Date.now(),
    }
    if (msg.role === 'assistant' && msg.tool_calls) {
      turn.toolCalls = msg.tool_calls
    }
    return turn
  }

  return {
    async run(input) {
      const tokenCounter = typeof opts.tokenCounter === 'function'
        ? opts.tokenCounter()
        : opts.tokenCounter ?? GENERIC_TOKEN_COUNTER
      // Fresh stores per run() — system agents are single-shot, history
      // must not accumulate across calls.
      // v0.11: an injected databus is shared across runs (sub-agent bus);
      // only recreate the private bus when no external bus was provided.
      // v0.30: persistent=true（warehouse）跳过重置——跨唤醒保留会话。
      if (opts.persistent !== true) {
        if (!opts.databus) {
          agentDatabus = new DatabusClass()
        }
        agentConvMem = new ConversationMemoryClass()
      }
      // Seed conversation memory with input messages through the canonical
      // append path — tool messages are also projected to the private Databus.
      for (const msg of input.messages) {
        appendCanonicalTurn(agentConvMem, agentDatabus, chatMessageToTurn(msg))
      }

      // v0.42: 每次 run 独立捕获槽——compressor 单发语义，残留不跨 run。
      submitted = undefined

      const meta = input.metadata as {
        sourceStamps?: string[]
        rawArchiveIds?: string[]
        contextDatabus?: Databus | readonly Databus[]
        toolRefsOverride?: string[]
        toolPolicyOverride?: import('./sub-agent/policy.js').SubAgentToolPolicy
        sessionId?: string
        directRecallLimitTokens?: number
        signal?: AbortSignal
      } | undefined
      const effectiveToolRefs = meta?.toolRefsOverride ?? [...opts.toolRefs]
      const effectiveToolPolicy = meta?.toolPolicyOverride ?? opts.toolPolicy

      const loopOpts: IMLoopOptions = {
        config: agentConfig,
        registry: opts.registry,
        databus: agentDatabus,
        conversationMemory: agentConvMem,
        workingAgentId: opts.name,
        mailbox: opts.mailbox,
        systemAgents: {
          warehouse: noopSystemAgent,
          compressor: noopSystemAgent,
          recall: noopSystemAgent,
        },
        streamChat: opts.llmStreamChat as IMLoopOptions['streamChat'],
        url: opts.url,
        model: opts.model,
        tokenCounter,
        systemPrompt: opts.systemPrompt,
        userTemplate: '',
        // 思维链落盘门控（赋值面 = 落盘面）：仅持久会话（warehouse）的落盘
        // 文件含 reasoning；compressor/recall 与子代理无 persistPath，不赋值。
        ...(opts.persistPath !== undefined ? { persistReasoning: true } : {}),
        // 工作区透传 → ctx.workDir → runtime 注入（WorkDir 行，与主代理对称）。
        ...(opts.workDir !== undefined ? { workDir: opts.workDir } : {}),
        // v0.34 D13：四类上下文注入（MEMORY.md / ARCHITECTURE.md / 运行时 / 时间）。
        // 缺省时不传——loop 回落到既有的硬编码注入逻辑（向后兼容）。
        ...(opts.contextInjector !== undefined ? { contextInjector: opts.contextInjector } : {}),
        // v0.13: route toolRefs into the three loop channels by source kind.
        // resolveRef is the single classifier (registry.ts) — its order mirrors
        // execute's dispatch. MCP refs from the same server are aggregated into
        // one { server, refs } entry as loop.ts expects.
        //
        // Undefined refs (resolveRef returns undefined) are kept in
        // systemToolRefs rather than dropped. This is deliberately lenient: the
        // caller (config.ts validateSubAgentConfig) already guarantees every ref
        // resolves, so an undefined here is a theoretical edge. compose silently
        // skips systemToolRefs entries that match no registered system tool, so
        // keeping them cannot leak a phantom tool into the prompt. Throwing here
        // would duplicate config.ts's existence check (single-layer enforcement,
        // v0.13 constraint 5).
        //
        // v0.10.6: textSkill refs (form:'text') are intentionally NOT routed to
        // skillRefs. skillRefs become tool_call schemas in compose — but text
        // skills are pre-injected content, not callable tools. They are silently
        // dropped from the per-call routing here because the loop's
        // injectTextSkills flag (set to false for system agents below) already
        // governs whether text skills enter the prompt at all. A system agent
        // that lists a text-skill ref in toolRefs is declaring "I want this
        // content available", but system agents run with injectTextSkills:false,
        // so the content does NOT enter — this matches the user decision that
        // text skills are for working/sub agents only. No error is raised: the
        // ref is valid (resolveRef accepts it), it just has no effect for a
        // system agent. Working/sub agents get text skills via the loop's
        // registry.getTextSkills() injection, not via toolRefs routing.
        ...(() => {
          const systemToolRefs: string[] = []
          const mcpByServer = new Map<string, string[]>()
          const skillRefs: string[] = []
          for (const ref of effectiveToolRefs) {
            const src = opts.registry.resolveRef(ref)
            if (src === undefined) {
              systemToolRefs.push(ref)
            } else if (src.kind === 'system') {
              systemToolRefs.push(ref)
            } else if (src.kind === 'mcp') {
              const list = mcpByServer.get(src.server)
              if (list) list.push(ref)
              else mcpByServer.set(src.server, [ref])
            } else if (src.kind === 'skill') {
              skillRefs.push(ref)
            }
            // src.kind === 'textSkill': intentionally not added to any channel.
          }
          return {
            systemToolRefs,
            mcpRefs: [...mcpByServer].map(([server, refs]) => ({ server, refs })),
            skillRefs,
          }
        })(),
        stateLine: opts.stateLine,
        // v0.30: 携带上次 run 的真实请求规模（0 = 无已知值，退回文本估算）。
        initialMetrics: { ...createMetrics(), lastRequestTokens: lastKnownRequestTokens },
        // v0.10.6: system agents (warehouse / compressor / recall) do NOT get
        // text-skill pre-injection. Text skills are pure-content hints for the
        // working/sub agent's reasoning; system agents run focused background
        // tasks (archive / compress / recall) where injecting arbitrary user
        // skill content would be noise. This is the user-decided wiring-layer
        // constraint (the code layer does not enforce it elsewhere — a caller
        // could set injectTextSkills:true on a system agent if they had a
        // reason, but createSystemAgent defaults to false here).
        injectTextSkills: false,
      }
      // v0.12.3 stage 2b: thread M3 archive join metadata (sourceStamps +
      // rawArchiveIds) from the drive coordinator so record_m3_summary can
      // merge them into the M3Summary. The LLM must not fabricate these.
      if (meta?.sourceStamps !== undefined) {
        loopOpts.archiveSourceStamps = meta.sourceStamps
      }
      if (meta?.rawArchiveIds !== undefined) {
        loopOpts.archiveRawArchiveIds = meta.rawArchiveIds
      }
      // v0.11: wire the contextual databus so this agent's tools can read
      // from the shared/contextual bus (e.g. sub-agent reads working agent's
      // bus). The private databus above still receives this agent's own
      // tool-turn projections.
      const contextDatabus = meta?.contextDatabus
      if (contextDatabus !== undefined) {
        loopOpts.ctxDatabus = contextDatabus as NonNullable<IMLoopOptions['ctxDatabus']>
      } else if (opts.sharedDatabus) {
        loopOpts.ctxDatabus = opts.sharedDatabus
      }
      // v0.11.1 P2.3: propagate recursion depth so run_subagent inside the
      // sub-agent's loop can check and increment it.
      if (opts.subAgentDepth !== undefined) {
        loopOpts.subAgentDepth = opts.subAgentDepth
      }
      // v0.13.1: 传播 wiki agent 标记到 loop opts，loop 构造 ctx 时再写入
      // ctx.isWikiAgent，registry 守卫据此放行 wiki__ 工具。
      if (opts.isWikiAgent === true) {
        loopOpts.isWikiAgent = true
      }
      // v0.16: 传播 sessionId 到 loop opts，loop 构造 ctx 时写入 ctx.sessionId，
      // registry.execute → registry.checkDoors 据此定位 per-session 状态
      // （v0.20：SecurityRouter 已下沉为 ToolRegistry 直管，hook 形态不变）。
      // 子代理继承父代理的 sessionId（run-subagent.ts 透传 ctx.sessionId）。
      const effectiveSessionId = meta?.sessionId ?? opts.sessionId
      if (effectiveSessionId !== undefined) {
        loopOpts.sessionId = effectiveSessionId
      }
      if (meta?.directRecallLimitTokens !== undefined) {
        loopOpts.directRecallLimitTokens = meta.directRecallLimitTokens
      }
      // v0.17: forward hooks so a child system/sub-agent can intervene at the
      // same phase points. Matches the v0.16 sessionId propagation pattern.
      if (opts.hooks !== undefined) {
        loopOpts.hooks = opts.hooks
      }
      // v0.41: forward the caller's abort signal so turn.cancel reaches a
      // judge call in flight (see the `signal` opt's doc comment).
      const runSignal = meta?.signal ?? opts.signal
      if (runSignal !== undefined) {
        loopOpts.signal = runSignal
      }
      // v0.41 D19: forward the strict-alternation capability so the outbound
      // rewrite in shell/call.ts also covers this agent's own requests.
      if (opts.strictAlternation === true) {
        loopOpts.strictAlternation = true
      }
      // v0.18: forward tool policy for load_tools runtime filtering.
      if (effectiveToolPolicy !== undefined) {
        loopOpts.toolPolicy = effectiveToolPolicy
      }
      loopOpts.allowedToolRefs = effectiveToolPolicy === undefined
        ? [...effectiveToolRefs]
        : effectiveToolRefs.filter((ref) => applyToolPolicy(ref, effectiveToolPolicy))
      // v0.30: 交接笔记压缩 + 工具表折叠 hook。beforeShellCall 在
      // composePrompt 之前触发——压缩在每轮请求组装前完成（对本轮立即生效）；
      // afterToolExecution 折叠热窗口之外的大工具结果（子代理经此获得与
      // 工作代理一致的工具表保护）。与转发的父 hooks 合并：own 先跑、转发
      // hook 后跑。
      if (opts.compaction !== undefined) {
        const forwarded = opts.hooks
        // v0.30 (用户拍板 2026-09-09)：压缩失败自动重试 3 次、每次间隔 15s；
        // 仍失败则失败上报——系统智能体（固定名 warehouse/recall）经 mailbox
        // systemSend 通知工作代理"应用程序错误"，子代理（instanceId）通知
        // 调用者（workingAgentId = 父 ctx.agentId）让主代理自行处理。
        // 每次 run 的重试预算独立（failureStreak 不跨 run 保留）。
        const COMPACTION_RETRY_LIMIT = opts.compaction.retryLimit ?? 3
        const COMPACTION_RETRY_DELAY_MS = opts.compaction.retryDelayMs ?? 15_000
        const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
        const isSystemAgentName = (n: string): boolean =>
          n === 'warehouse' || n === 'compressor' || n === 'recall'
        const reportCompactionFailure = (err: unknown): void => {
          if (opts.workingAgentId === undefined) return
          try {
            opts.mailbox.systemSend({
              from: opts.name,
              to: opts.workingAgentId,
              subject: '压缩失败（应用程序错误）',
              body: isSystemAgentName(opts.name)
                ? `系统智能体 ${opts.name} 的上下文压缩连续失败，无法继续整理记忆：${err instanceof Error ? err.message : String(err)}。这是一个应用程序错误。`
                : `子代理 ${opts.name} 的上下文压缩连续失败：${err instanceof Error ? err.message : String(err)}。请主代理自行处理该子代理的任务。`,
            })
          } catch {
            // 上报失败不阻断（mailbox 不可达时静默）
          }
        }
        const runCompactionWithRetry = async (ctx: BeforeShellCallContext): Promise<void> => {
          if (!shouldCompact({
            promptTokens: ctx.promptTokens,
            maxTokens: agentConfig.maxTokens,
            ...(opts.compaction?.triggerRatio !== undefined ? { triggerRatio: opts.compaction.triggerRatio } : {}),
          })) {
            return
          }
          let lastErr: unknown
          for (let attempt = 0; attempt <= COMPACTION_RETRY_LIMIT; attempt += 1) {
            if (attempt > 0) await sleep(COMPACTION_RETRY_DELAY_MS)
            try {
              await compactConversation({
                conversationMemory: agentConvMem,
                streamChat: opts.llmStreamChat as Parameters<typeof compactConversation>[0]['streamChat'],
                url: opts.url,
                model: opts.model,
                systemPrompt: opts.systemPrompt,
                tokenCounter,
              })
              return
            } catch (e) {
              lastErr = e
            }
          }
          reportCompactionFailure(lastErr)
        }
        loopOpts.hooks = {
          ...(forwarded ?? {}),
          beforeShellCall: async (ctx: BeforeShellCallContext): Promise<BeforeShellCallResult | undefined> => {
            try {
              await runCompactionWithRetry(ctx)
            } catch {
              // 兜底：压缩 hook 自身异常不阻断本轮（转发 hook 仍执行）
            }
            return forwarded?.beforeShellCall !== undefined ? await forwarded.beforeShellCall(ctx) : undefined
          },
          // 工具表折叠（子代理与系统智能体获得与工作代理一致的保护——只对
          // 搭配 compaction 的代理装配，纯算法零成本，无匹配时立即返回）。
          afterToolExecution: async (ctx) => {
            if (ctx.conversationMemory !== undefined) {
              foldOversizeToolTurns(ctx.conversationMemory, { tokenCounter })
            }
            return forwarded?.afterToolExecution !== undefined
              ? await forwarded.afterToolExecution(ctx)
              : undefined
          },
        }
      }

      // v0.42: 提交协议捕获（对齐参考实现的 function-calling
      // 方案）。装配了 submitToolName 的代理（compressor）最后一次调用该工具时的
      // `memory` 参数就是生产结果——服务端按 schema 约束的 JSON，取代"把 JSON
      // 写成最终回复文本再事后解析"。捕获点选 in beforeToolExecution（loop.ts
      // 工具执行前、参数已解析）：啃到模型快照，无需等最终回复；最后一次提交
      // 覆盖先前的（失败的提交会被工具拒绝并在同一对话修复后重提，最终生效的
      // 就是最后一次）。
      if (opts.submitToolName !== undefined) {
        const forwarded = loopOpts.hooks
        const submitName = opts.submitToolName
        loopOpts.hooks = {
          ...(forwarded ?? {}),
          beforeToolExecution: async (ctx) => {
            try {
              for (const tc of ctx.toolCalls) {
                if (tc.function?.name !== submitName) continue
                const args = JSON.parse(tc.function.arguments) as { memory?: Record<string, unknown> }
                if (args !== null && typeof args === 'object' && args.memory !== undefined) {
                  submitted = args.memory
                }
              }
            } catch {
              // 捕获失败不阻断工具轮（与 callHook 的失败安全同纪律）
            }
            return forwarded?.beforeToolExecution !== undefined
              ? await forwarded.beforeToolExecution(ctx)
              : undefined
          },
        }
      }

      const result = await runIMLoop(loopOpts)

      // v0.30: 记录本次 run 的真实请求规模，供下次唤醒的压缩触发使用
      // （loop 内 estimatedTokens 首选 initialMetrics.promptTokens 路径——
      // 它读 lastRequestTokens）。
      lastKnownRequestTokens = result.metrics.lastRequestTokens

      // v0.30: 持久会话落盘——每次 run 结束全量原子快照（含压缩后的形态）。
      // conversation 与私有 databus 都写；落盘位置见 system-agent-persistence.ts
      // 顶部注释。
      if (opts.persistent === true) {
        try {
          savePersistedConversation(agentConvMem, opts.persistPath)
          if (opts.databus === undefined) {
            savePersistedDatabus(agentDatabus, databusPersistPathOf(opts.persistPath))
          }
        } catch {
          // 落盘失败不吞掉 run 结果——warehouse 的输出仍返回调用方；
          // 下次唤醒会从上一次成功快照恢复（最多丢最近一轮记忆）。
        }
      }

      // The "output" is the last assistant message content, or undefined if
      // the loop tripped without producing a final assistant turn.
      const lastTurn = agentConvMem.last()
      const output = lastTurn?.role === 'assistant' ? lastTurn.content : undefined

      return {
        output,
        metrics: result.metrics,
        finalState: result.finalState,
        reason: result.reason,
        hits: result.hits,
        // v0.42: 提交协议生产结果。条件展开保持 exactOptionalPropertyTypes
        // 兼容（未装配 submitToolName / 未调用工具时不带该字段）。
        ...(submitted !== undefined ? { submitted } : {}),
      }
    },

    stop() {
      // v0.10.1: stop() is a no-op for the interface. The actual stop
      // mechanism will be introduced in a future version.
    },

    send(message: ChatMessage) {
      appendCanonicalTurn(agentConvMem, agentDatabus, chatMessageToTurn(message))
    },
  }
}

// A noop system agent used as a placeholder when system agents call runIMLoop
// internally (system agents don't have their own system agents).
const noopSystemAgent: SystemAgent = {
  run: async (): Promise<SystemAgentRunResult> => { throw new Error('this agent does not have its own system agents (nested system-agent calls are not supported)') },
  stop() {},
  send() {},
}
