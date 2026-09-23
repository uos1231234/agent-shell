// The IM main loop. This is the orchestrator. The shell is a "valve" +
// guard-runner, the protocol is the "delivery mechanism", the registry is
// the "tool phonebook", the databus is the "conversation log". IM is the
// agent's brain.
//
// v0.17: extracted from a 633-line monolith into a thin driver +
// 5 hook call points + 4 pure helper functions. Behavior is 100%
// equivalent — 1211 tests pre-refactor still pass post-refactor. The
// extraction exists so the hook call points are obvious to read and so
// each phase (compose / shellCall / guards / toolExecution / toolResult)
// can be reasoned about and tested as a unit.
//
// ── Hook philosophy (user decision 2026-09-05) ─────────────────────────────
// Hooks are NOT a plugin API. This harness ships no third-party extensions
// and is not built for any: the only consumer of hooks is the harness
// itself (SignalBus wiring, rendering, error recovery). Their purpose is
// INFORMATION-FLOW management, not feature or code management — each hook
// point is a branching seam where the state machine emits part of its
// information stream to a side channel (e.g. afterToolExecution →
// RenderingSignalBus), while the main loop's context engineering stays
// intact. Therefore: helpers stay INSIDE this file (the state machine
// serves IM; AtomCode agent.rs takes the same stance — a 5.5k-line state
// machine whose hooks are internal seams only). Do NOT move loop logic
// into hooks, and do NOT add hooks to serve external users.

import type { ToolRegistry } from '../shell/registry.js'
import type { ShellConfig } from '../shell/config.js'
import type { Mailbox } from './mailbox/index.js'
import type { SystemAgent } from './system-agent.js'
import type { StateLine } from './state-line/types.js'
import type { ToolContext } from '../shared/tool-context.js'
import { shellCall, type ShellDeps, type ShellCallResult } from '../shell/call.js'
import { compose, type FinalPrompt, type PromptPart } from '../shell/compose.js'
import type { State } from '../shell/state.js'
import { runGuards, type GuardHit } from '../shell/guards.js'
import { ShellTerminatedError } from '../shell/gate.js'
import {
  createMetrics,
  addToolError,
  resetToolErrors,
  type Metrics,
} from '../shell/metrics.js'
import type { StreamChunk, ToolCall } from '../protocol/types.js'
import { ProtocolError } from '../protocol/types.js'
import { parseToolCallArguments } from '../protocol/tool-calls.js'
import type { ConversationTurn, ConversationMemory } from './conversation-memory.js'
import { turnToMessage, turnToMessageWithCounter, appendCanonicalTurn, appendToolResultWithProjection, mintTurnId } from './turn.js'
import type { ToolTurn, AgentId } from './databus.js'
import type { Databus } from './databus.js'
import { MultiDatabus } from './multi-databus.js'
import type { ToolCategory } from '../shell/registry.js'
import { CONCURRENCY_LIMITS } from '../shell/registry.js'
import { buildContextProjection } from './context-projection.js'
import { DEEPSEEK_TOKEN_COUNTER, type TokenCounter } from '../shared/token-counter.js'
import { createDirectRecallLedger, type DirectRecallLedger } from './tools/databus-recall.js'
import { buildServerSummary, buildDynamicToolSchemaMessage, type DynamicToolSource } from './dynamic-tool-context.js'
import type { OpenAITool } from '../protocol/types.js'
import type { DriveCoordinator } from './system-agents/drive-coordinator.js'
import type { Logger } from '../shared/logger.js'
import { defaultLogger } from '../shared/logger.js'
import type { MemoryConfig } from '../shell/memory-config.js'
import { DEFAULT_MEMORY_CONFIG } from '../shell/memory-config.js'
import {
  callHook,
  type LoopHooks,
  type AfterShellCallContext,
  type AfterShellCallResult,
} from './loop-hooks.js'

/** Max retries for ProtocolError (transient network/SSE failures). */
const MAX_PROTOCOL_ERROR_RETRIES = 3
/** Base delay (ms) between ProtocolError retries. Doubles each retry. */
const PROTOCOL_ERROR_RETRY_BASE_MS = 1000

// v0.10.1c: The three system agents available to the working agent's tools.
// The loop itself does not call these agents — they are used by the 7 new
// system-agent-backed tools via closures. Including the type here ensures
// the wiring is explicit at the IMLoopOptions level.
export type SystemAgents = {
  warehouse: SystemAgent
  compressor: SystemAgent
  recall: SystemAgent
}

// advanceElapsed: a one-liner that updates metrics.elapsedMs from a wall-clock
// anchor. It exists so the time guard's `metrics.elapsedMs > maxElapsedMs`
// check actually has a producer; without it the guard's threshold is
// unreachable (ADR-009: every guard must be reachable on the happy path).
export const advanceElapsed = (m: Metrics, loopStart: number, now: number): Metrics => ({
  ...m,
  elapsedMs: now - loopStart,
})

export type IMLoopOptions = {
  config: ShellConfig
  registry: ToolRegistry
  databus: Databus
  conversationMemory: ConversationMemory
  workingAgentId: AgentId
  mailbox: Mailbox
  systemAgents: SystemAgents
  driveCoordinator?: DriveCoordinator
  initialMetrics?: Metrics
  streamChat: (
    url: string,
    request: { model: string; messages: FinalPrompt['messages']; tools?: FinalPrompt['tools']; [k: string]: unknown },
  ) => AsyncIterable<StreamChunk>
  url: string
  model: string
  systemPrompt: string
  userTemplate: string
  systemToolRefs: string[]
  mcpRefs: { server: string; refs: string[] }[]
  skillRefs: string[]
  stateLine: StateLine
  // v0.11: optional contextual databus for tools. When set, ctx.databus
  // points to this bus (or a merged view of multiple buses) instead of the
  // loop's private databus. The private databus still receives this loop's
  // own tool-turn projections; tools read the contextual bus (e.g. sub-agent
  // events, working agent history).
  // An array of buses is wrapped in a MultiDatabus read-only merged view.
  ctxDatabus?: Databus | readonly Databus[]
  // v0.11.1 P2.3: recursion depth for nested run_subagent calls.
  // 0 = working agent (top level). Each run_subagent increments by 1
  // before launching the sub-agent's loop.
  subAgentDepth?: number
  // v0.12.3 stage 2b: compression zone for system agents. Set by system-agent.ts
  // from input.metadata.zone. Propagated to ToolContext.compressZone so
  // record_curated_block can fall back to the correct layer when the LLM
  // doesn't explicitly pass one.
  compressZone?: 'M1' | 'M2'
  injectTextSkills?: boolean
  archiveSourceStamps?: string[]
  archiveRawArchiveIds?: string[]
  isWikiAgent?: boolean
  sessionId?: string
  requestHandler?: (kind: string, payload: unknown) => Promise<unknown>
  logger?: Logger | undefined
  memoryConfig?: MemoryConfig
  // v0.17.x: optional abort signal. When triggered, the loop throws
  // `AbortError` between hook calls (after each await boundary) so callers
  // can cancel a long-running turn. Matches KimiCode's RunTurnInput.signal
  // pattern — optional here so existing callers that never opt in are not
  // affected; when absent, the loop synthesizes an AbortController that is
  // never aborted so the signal checks are no-ops in the steady state.
  signal?: AbortSignal | undefined
  persistTurn?: (turn: ConversationTurn, databusTurn?: ToolTurn) => Promise<void>
  // 思维链落盘门控（2026-09-12 用户拍板：赋值面 = 落盘面）。仅当本 loop 的
  // 会话确有持久化归宿时才把聚合 reasoning 赋进 assistant 回合：工作代理
  // （persistTurn → conversation.jsonl）与 warehouse 持久会话（persistPath →
  // warehouse-session.jsonl）置 true；子代理 / compressor / recall 无落盘
  // 归宿，缺省 false 不赋值——思维链只活在实时 thinking.delta 信号里。
  persistReasoning?: boolean
  // v0.17: per-loop control-flow hooks. Omit entirely for current behavior.
  hooks?: LoopHooks
  // v0.18: progressive tool disclosure — accumulated dynamic tool schemas.
  // Starts empty; each round, after tool execution, load_tools may attach
  // schemas to ctx._loadedDynamicTools. The loop collects them here so the
  // next round's compose includes them as dynamicSchema parts.
  dynamicSchemas?: Array<{ source: DynamicToolSource; tools: OpenAITool[] }>
  // v0.18: sub-agent tool policy, passed to ToolContext for load_tools filtering.
  toolPolicy?: import('../im/sub-agent/policy.js').SubAgentToolPolicy
  // Effective runtime boundary for system agents and sub-agents.
  allowedToolRefs?: readonly string[]
  directRecallLedger?: DirectRecallLedger
  directRecallLimitTokens?: number
  largeRecall?: ToolContext['largeRecall']
  // v0.20: 用户工作文件夹（前端/宿主创建会话时传入）。
  // 上下文注入源（MEMORY.md / ARCHITECTURE.md）据此根目录读取。
  // 不是 process.cwd()——进程 cwd 可能是宿主目录，不是用户工作文件夹。
  workDir?: string
  // v0.19: context injection hook — replaces hardcoded dynamic content injection.
  // When set, loop calls contextInjector.inject() for dynamic messages each round.
  // When absent, falls back to existing hardcoded injection logic (backward compat).
  contextInjector?: import('./hooks/context-injection.js').ContextInjector
  // v0.19: layered prompt configuration. Currently not wired into composePrompt; reserved.
  // promptLayers?: import('./prompt/types.js').PromptLayer[]
  // promptMode?: import('./prompt/types.js').PromptMode
  // v0.19: hook system — general-purpose event hooks for tool execution lifecycle.
  hookSystem?: import('./hooks/hook-system.js').HookSystem
  // v0.21: 流式增量旁路（可选观察者）。每轮 shellCall 消费 streamChat chunk
  // 时，loop 以当前轮的 turnId（mintTurnId('turn')，全局唯一）为上下文转发给
  // 这里；信号关的 delta-bridge 经此接入（src/signals/wiring/delta-bridge.ts）。
  // 纯观察，不改变聚合语义；默认 undefined 时零行为变化。
  onStreamChunk?: ((turnId: string, chunk: import('../protocol/types.js').StreamChunk) => void) | undefined
  /**
   * v0.41 D19：provider 是否要求严格角色交替。true 时 shellCall 出站前合并
   * 相邻的 role:'user' 消息（src/protocol/messages.ts）。事实源是
   * providers.json 的 capabilities.strictAlternation，装配层逐轮热解析后透传
   * （与 /provider use 热切换一致）。缺省 undefined = 不转写 = wire 形状零变化。
   */
  strictAlternation?: boolean | undefined
  /** Host-selected provider/model counter; omitted callers keep legacy DeepSeek behavior. */
  tokenCounter?: TokenCounter | undefined
}

export type IMLoopResult = {
  terminated: boolean
  reason: 'completed' | 'guard-tripped' | 'protocol-error' | 'shell-terminated'
  finalState: State
  hits: GuardHit[]
  turns: number
  metrics: Metrics
}

// ----------------------------------------------------------------------------
// Pure helpers (extracted from the monolith; identical behavior, no hooks).
// ----------------------------------------------------------------------------

// v0.20 (ADR-025 Part 2): RoundState 封装循环状态变量。
// 四散突变的 state/metrics/turns/lastMetrics/protocolErrorRetries 集中管理，
// 通过 hook ctx 传递，所有 hook 通过 ctx 读写状态。
interface RoundState {
  state: 'Running' | 'Tripped'
  metrics: Metrics
  turns: number
  lastMetrics: Metrics | null
  loopStart: number
  protocolErrorRetries: number
}

// v0.20 (ADR-025 Part 2): composePrompt 抽出为纯函数。
// 职责：组装 prompt parts（上下文注入 + 历史 + 用户消息 + 工具描述）。
// 不改变上下文组装顺序：system → afterSystem injections → history → userTemplate → afterUser injections → stateLine → tools → summaries → dynamicSchemas → skillText。
async function composePrompt(opts: IMLoopOptions, state: RoundState, estimatedTokens: number): Promise<PromptPart[]> {
  const projection = buildContextProjection({
    stateLine: opts.stateLine,
    mailbox: opts.mailbox,
    workingAgentId: opts.workingAgentId,
    estimatedTokens,
    ...(opts.memoryConfig ? { memoryConfig: opts.memoryConfig } : {}),
    availableToolRefs: opts.systemToolRefs,
  })

  const serverSummary = buildServerSummary(opts.registry)

  const conversationTurns = opts.conversationMemory.turns()

  let afterSystemInjections: import('./hooks/context-injection.js').ContextInjectionResult[] = []
  let afterUserInjections: import('./hooks/context-injection.js').ContextInjectionResult[] = []
  if (opts.contextInjector) {
    const injectionResults = await opts.contextInjector.inject({
      conversationHistory: conversationTurns as unknown as readonly unknown[],
      registry: opts.registry,
      sessionId: opts.sessionId,
      agentId: opts.workingAgentId,
      round: state.metrics.stepCount,
      // v0.20: 用户工作文件夹——注入源据此读 MEMORY.md/ARCHITECTURE.md
      workDir: opts.workDir,
    })
    afterSystemInjections = injectionResults.filter(r => r.position === 'afterSystem')
    afterUserInjections = injectionResults.filter(r => r.position === 'afterUser')
  }

  const parts: PromptPart[] = [
    { type: 'system', content: opts.systemPrompt + projection.systemSuffix },
    // v0.19: afterSystem injections (runtime, temporal) — after system prompt.
    ...afterSystemInjections.map(r => ({ type: 'system' as const, content: r.content })),
    // v0.19: conversation history — stable prefix right after system prompt.
    ...conversationTurns.map(turn => ({ type: 'turn' as const, message: turnToMessageWithCounter(turn, opts.tokenCounter) })),
    // Current round user message. v0.27 去重 → v0.41 后续补丁 (b)：入口已无条件
    // 把 userTemplate 落成 canonical user 回合（loop.ts:693），history part 已含
    // 该文本，跳过 userTemplate part——用户文本每轮恰好一次。判据用构造性事实
    // （userTemplate 非空 = 已落 canonical），不再内容扫描：u1 被压缩逐出后不复活
    // （见 omitUserTemplatePart 注释）。
    ...(omitUserTemplatePart(opts.userTemplate)
      ? []
      : [userTemplatePart(opts.userTemplate)]),
    // v0.19: afterUser injections (MEMORY.md) — after user message.
    ...afterUserInjections.map(r => ({ type: 'system' as const, content: r.content })),
    // Other parts (stateLine, tools, summaries).
    ...(projection.stateLinePart ? [projection.stateLinePart] : []),
    ...opts.systemToolRefs.map(ref => ({ type: 'systemTool' as const, ref })),
    ...(serverSummary ? [{ type: 'mcpServerSummary' as const, content: serverSummary }] : []),
    ...(opts.dynamicSchemas ?? []).map(ds => ({
      type: 'dynamicSchema' as const,
      tools: ds.tools,
      sourceLabel: ds.source.kind === 'mcp' ? `MCP server "${ds.source.server}"` : `skill "${ds.source.name}"`,
    })),
  ]
  if (opts.injectTextSkills !== false) {
    for (const ts of opts.registry.getTextSkills()) {
      const content = ts.whenToUse === undefined
        ? ts.body
        : `<!-- when_to_use: ${ts.whenToUse} -->\n${ts.body}`
      parts.push({ type: 'skillText', content, skillName: ts.name })
    }
  }
  return parts
}

/**
 * v0.27 → v0.41 后续补丁 (b)：本轮用户文本是否已进 canonical。
 *
 * 入口 append 是**无条件的**（loop.ts:693：userTemplate 非空必落 canonical user
 * 回合），所以"本轮用户文本是否已在 canonical" ≡ "userTemplate 是否非空"——这是
 * 构造性事实，不需要每轮运行时重推导。
 *
 * v0.27 原判据是内容扫描 `turns.some(t => t.content === userTemplate)`，它是对
 * 上述构造性事实的**运行时重推导**。G1/常规压缩把 u1 逐出 canonical（原位换成
 * mem- 信封）后，扫描不再命中 → userTemplate part 在每轮请求尾部被重新注入：
 * 一份**不在 canonical 里的幻影**（wire ≠ 落盘 ≠ 模型视野），既抵消压缩、又是
 * live-only（恢复/resume 从 canonical 重建，幻影消失，前后不一致）。
 *
 * 改用构造性事实根治：u1 逐出后**不复活**。模型视野 = canonical = 信封的
 * evidence_fragments 头锚（inputKeepTokens，默认 1K）；u1 全文在 raw-archive，
 * 经 state_query({stamps}) 按戳召回。空 userTemplate 仍返回 false（保持既有
 * 空 part 行为，系统智能体等调用方不受影响）。
 */
function omitUserTemplatePart(userTemplate: string): boolean {
  return userTemplate !== ''
}

/** composePrompt 的当前轮 user 消息 part（类型字面量需要具名常量保型）。 */
const userTemplatePart = (content: string): PromptPart => ({ type: 'userTemplate', content })

// v0.20 (ADR-025 Part 2): finalizeRound 抽出为纯函数。
// 职责：一轮结束后的持久化（appendAssistantTurn + fireDriveCoordinator）。
// 位置：HOOK 3 之后、HOOK 4 之前。不可干预的固定收尾。
async function finalizeRound(
  result: ShellCallResult,
  opts: IMLoopOptions,
  state: RoundState,
  estimatedTokens: number,
  log: Logger,
): Promise<void> {
  // Record the assistant turn in the databus.
  const assistantMsg = result.response.choices[0]?.message
  const now = Date.now()
  const assistantTurn: ConversationTurn = {
    id: mintTurnId(`assistant-${state.turns}`),
    role: 'assistant',
    content: assistantMsg?.content ?? null,
    at: now,
  }
  if (result.toolCalls.length > 0) {
    assistantTurn.toolCalls = result.toolCalls
  }
  // 思维链落盘（2026-09-12 用户拍板，赋值面 = 落盘面）：聚合器给出的
  // reasoning 原样入 canonical 回合——仅 persistReasoning 开启的 loop
  // （工作代理 / warehouse 持久会话）。恢复链路对 ConversationTurn 直存直读
  // 无需额外接线；turnToMessage 不投影该字段，后续请求不受影响。
  if (result.reasoning !== undefined && opts.persistReasoning === true) {
    assistantTurn.reasoning = result.reasoning
  }
  appendCanonicalTurn(opts.conversationMemory, opts.databus, assistantTurn)
  if (opts.persistTurn) await opts.persistTurn(assistantTurn)
}

// Run every tool call in the batch, returning one `role: 'tool'` Turn per call.
// Pure: no global state, no databus side effects.
//
// v0.20 hook repair: 按 category 分桶并发，废除硬编码 MAX_CONCURRENT_TOOL_CALLS = 2。
// - 先按 getToolCategory 分组（保留原始下标）
// - 每组按 CONCURRENCY_LIMITS[category] 切批并行（read=5 / write=3 / command=3）
// - 最终结果按原始下标排序，保证与输入 toolCalls 顺序一致（LLM 配对依赖此顺序）
//
// v0.20 (ADR-025 T8): parallelSafe 逐参数判定（AtomCode `parallel_safe(&self, args)`）。
// category 桶是默认/保守值；工具声明的 parallelSafe(args) === true 是精确覆盖——
// 该调用进入单独的并行安全桶，全部同时执行（不占用 category 桶的并发槽）。
// 判定失败（工具未声明 parallelSafe / 参数解析失败 / 谓词抛出）一律按 category 默认值。
const isParallelSafeCall = (tc: ToolCall, registry: ToolRegistry): boolean => {
  const sysTool = registry.getSystemTool(tc.function.name)
  if (!sysTool?.parallelSafe) return false
  const parsed = parseToolCallArguments(tc.function.arguments)
  if (!parsed.ok) return false
  try {
    return sysTool.parallelSafe(parsed.value) === true
  } catch {
    return false
  }
}

const executeToolCalls = async (
  toolCalls: readonly ToolCall[],
  registry: ToolRegistry,
  now: number,
  workingAgentId: AgentId,
  ctx?: ToolContext,
  hookSystem?: import('./hooks/hook-system.js').HookSystem,
): Promise<{ turns: ToolTurn[]; errorCount: number }> => {
  const turns: ToolTurn[] = new Array(toolCalls.length)
  let errorCount = 0

  // parallelSafe 调用单独成桶（不占用 category 桶的并发槽）；其余按 category 分组。
  const parallelSafeItems: Array<{ idx: number; tc: ToolCall }> = []
  const byCategory = new Map<ToolCategory, Array<{ idx: number; tc: ToolCall }>>()
  for (let idx = 0; idx < toolCalls.length; idx++) {
    const tc = toolCalls[idx]!
    if (isParallelSafeCall(tc, registry)) {
      parallelSafeItems.push({ idx, tc })
      continue
    }
    const category = registry.getToolCategory(tc.function.name)
    const group = byCategory.get(category)
    if (group) {
      group.push({ idx, tc })
    } else {
      byCategory.set(category, [{ idx, tc }])
    }
  }

  const runBatch = async (batch: ReadonlyArray<{ idx: number; tc: ToolCall }>): Promise<void> => {
    const results = await Promise.all(
      batch.map(async ({ idx, tc }): Promise<{ idx: number; turn: ToolTurn }> => {
        const turn = await executeSingleTool(tc, registry, now, workingAgentId, ctx, hookSystem)
        return { idx, turn }
      }),
    )
    for (const { idx, turn } of results) {
      turns[idx] = turn
      if (turn.isError === true) errorCount += 1
    }
  }

  // 并行安全桶：全部同时执行，不受 category 上限限制。
  if (parallelSafeItems.length > 0) {
    await runBatch(parallelSafeItems)
  }

  // 普通 category 桶：每组按自己的并发上限切批执行。
  for (const [category, items] of byCategory) {
    const limit = CONCURRENCY_LIMITS[category]
    for (let i = 0; i < items.length; i += limit) {
      await runBatch(items.slice(i, i + limit))
    }
  }

  return { turns, errorCount }
}

// 执行单个工具调用（解析参数 → PreToolUse hook → execute → PostToolUse hook）。
// 从 executeToolCalls 抽出，使分桶逻辑与单工具执行逻辑解耦。
async function executeSingleTool(
  tc: ToolCall,
  registry: ToolRegistry,
  now: number,
  workingAgentId: AgentId,
  ctx?: ToolContext,
  hookSystem?: import('./hooks/hook-system.js').HookSystem,
): Promise<ToolTurn> {
  const parsed = parseToolCallArguments(tc.function.arguments)
  if (!parsed.ok) {
    return {
      id: mintTurnId('tool'),
      role: 'tool',
      toolCallId: tc.id,
      isError: true,
      content: `The arguments for "${tc.function.name}" were not valid JSON; please re-issue the call with valid JSON arguments.`,
      sourceAgentId: workingAgentId,
      at: now,
      toolName: tc.function.name,
    }
  }
  try {
    // v0.19: emit PreToolUse hook — can block tool execution.
    if (hookSystem) {
      const allowed = await hookSystem.emitPreToolUse({
        event: 'PreToolUse',
        toolName: tc.function.name,
        args: parsed.value,
        sessionId: ctx?.sessionId,
        agentId: workingAgentId,
      })
      if (!allowed) {
        return {
          id: mintTurnId('tool'),
          role: 'tool',
          toolCallId: tc.id,
          isError: true,
          content: `Tool "${tc.function.name}" was blocked by a PreToolUse hook.`,
          sourceAgentId: workingAgentId,
          at: now,
          toolName: tc.function.name,
          args: parsed.value,
        }
      }
    }
    const toolStart = Date.now()
    const out = await registry.execute(tc.function.name, parsed.value, ctx)
    const duration = Date.now() - toolStart
    // v0.19: emit PostToolUse hook — observation point.
    if (hookSystem) {
      await hookSystem.emit('PostToolUse', {
        event: 'PostToolUse',
        toolName: tc.function.name,
        args: parsed.value,
        result: out,
        duration,
        sessionId: ctx?.sessionId,
        agentId: workingAgentId,
      })
    }
    return {
      id: mintTurnId('tool'),
      role: 'tool',
      toolCallId: tc.id,
      content: typeof out === 'string' ? out : JSON.stringify(out),
      sourceAgentId: workingAgentId,
      at: now,
      toolName: tc.function.name,
      args: parsed.value,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 工具层（wrapTool）已处理错误兜底 + error turn 记录 + errorCount 计数。
    // 失败路径不 emit PostToolUse：工具层已穿透状态机，hook 无需重复观察。
    // 状态机通过 isError turn + errorRate guard 感知失败。
    return {
      id: mintTurnId('tool'),
      role: 'tool',
      toolCallId: tc.id,
      isError: true,
      content: `Tool "${tc.function.name}" failed: ${msg}`,
      sourceAgentId: workingAgentId,
      at: now,
      toolName: tc.function.name,
      args: parsed.value,
    }
  }
}

// Compute this round's context size for the compression-layer trigger.
//
// 计数口径 = 实际发 LLM 的 wire format——经 turnToMessage 投影再序列化，排除
// id/at/sourceAgentId/toolName/args 等不进 prompt 的字段（直接 stringify turn 会把
// ToolTurn.args 双倍计入，M 层阈值失准）；userTemplate 与 composePrompt 同口径，
// user 回合已落 canonical 末尾时不再单列（实际请求里它作为 history 出现，不重复计）。
//
// 去上游化（参考实现 context-amplifier 同源经验）：触发用本地 DeepSeek 加权计数，
// **不再读 provider 的 usage.prompt_tokens**。根因（2026-09-16 scanidx2 实测）：
// relay 在 prompt 缓存命中时只回报未缓存增量，usage.prompt_tokens 被钉死在远低于
// 真实上下文的值——真实 1.2M、usage 卡在 ~200K，内存层永远停在 M1，M3 持续压缩
// 永不启动，canonical 一路涨到 revive 溢出 400。本地计数对高重复语料会高估，这是
// 触发的**安全方向**（提前压，真实窗口绝不溢出）。
// 注：token guard（1M 硬限终止，guards.ts）仍用 provider usage，与本触发口径解耦——
// 若 guard 也改用本地高估值会在真实 ~290K 就误终止长会话。
const estimateContextTokens = (opts: IMLoopOptions): number =>
  (opts.tokenCounter ?? DEEPSEEK_TOKEN_COUNTER).count(
    opts.systemPrompt
      + effectiveUserTemplate(opts.userTemplate)
      + opts.conversationMemory.turns().map(t => JSON.stringify(turnToMessageWithCounter(t, opts.tokenCounter))).join(''),
  )

/** v0.27 → v0.41 (b)：估计口径与 compose 去重一致——userTemplate 非空即已落 canonical，不重复计。 */
const effectiveUserTemplate = (userTemplate: string): string =>
  omitUserTemplatePart(userTemplate) ? '' : userTemplate

// v0.43（2026-09-22 用户拍板，效仿 mimocode）：上下文超过 512K token 后，每个用户
// 条目尾部追加固定记忆提醒——把模型掰向召回机制（state_query/ask_recall + mailbox_read），
// 而不是让机制迁就模型。"窗口里没有 ≠ 不存在"是 MRCR-3M 实测的直接失分根因
// （模型把清单缺失误判为事实不存在，直接报 MISSING，0 次召回工具调用）。
export const MEMORY_REMINDER_MIN_TOKENS = 512_000

const buildMemoryReminder = (): string =>
  '\n\n[记忆提醒] 当前会话上下文已超过 512K token，较早内容已被压缩为 #STAMP 信封或归档（M3）。'
  + '作答前如需历史事实：(1) 先查记忆层——state_query({layer:\'M1\'|\'M3\'}) 列出块、state_query({queryText:…}) 语义检索、ask_recall 问答式召回；'
  + '(2) 用 mailbox_read 读取未读邮件——drive 通知记录了哪些块被压缩/归档、对应的戳与召回方式；'
  + '(3) 不要凭印象作答，也不要把“当前窗口里没有”当成“不存在”——先召回查证，确认查不到才报告 unknown。'

// Build this round's ToolContext. Pure — does not mutate the registry.
const buildToolContext = (
  opts: IMLoopOptions,
  ctxDatabus: Databus | MultiDatabus | undefined,
  directRecallLedger: DirectRecallLedger,
): ToolContext => {
  const ctx: ToolContext = {
    stateLine: opts.stateLine,
    agentId: opts.workingAgentId,
    databus: ctxDatabus ?? opts.databus,
    subAgentDepth: opts.subAgentDepth ?? 0,
    directRecallLedger,
  }
  if (opts.directRecallLimitTokens !== undefined) ctx.directRecallLimitTokens = opts.directRecallLimitTokens
  if (opts.archiveSourceStamps !== undefined) ctx.archiveSourceStamps = opts.archiveSourceStamps
  if (opts.archiveRawArchiveIds !== undefined) ctx.archiveRawArchiveIds = opts.archiveRawArchiveIds
  if (opts.isWikiAgent === true) ctx.isWikiAgent = true
  if (opts.sessionId !== undefined) ctx.sessionId = opts.sessionId
  // v0.27: 取消信号透传给工具层——阻塞型路径（审批门）据此与 abort 竞速。
  if (opts.signal !== undefined) ctx.signal = opts.signal
  if (opts.requestHandler !== undefined) ctx.requestHandler = opts.requestHandler
  // v0.18: sub-agent tool policy for load_tools runtime filtering.
  if (opts.toolPolicy !== undefined) ctx.toolPolicy = opts.toolPolicy
  if (opts.allowedToolRefs !== undefined) ctx.allowedToolRefs = opts.allowedToolRefs
  if (opts.largeRecall !== undefined) ctx.largeRecall = opts.largeRecall
  if (opts.tokenCounter !== undefined) ctx.tokenCounter = opts.tokenCounter
  // v0.17: hooks propagate via ctx so run-subagent can pass them to child
  // loops (matching the v0.16 sessionId propagation pattern).
  if (opts.hooks !== undefined) ctx.hooks = opts.hooks
  return ctx
}

// Drive the background compression/eviction pipeline. Fire-and-forget with
// a catch handler so a tick failure can never become an unhandled promise
// rejection. Logged and swallowed.
const fireDriveCoordinator = (
  opts: IMLoopOptions,
  estimatedTokens: number,
  log: Logger,
): void => {
  if (!opts.driveCoordinator) return
  const dc = opts.driveCoordinator
  dc.tick({
    contextTokens: estimatedTokens,
    conversation: opts.conversationMemory,
    databus: opts.databus,
    ...(opts.tokenCounter !== undefined ? { tokenCounter: opts.tokenCounter } : {}),
    memoryConfig: opts.memoryConfig ?? DEFAULT_MEMORY_CONFIG,
  }).catch((e: unknown) => {
    log.error('driveCoordinator.tick unhandled rejection', {
      err: e instanceof Error ? e.message : String(e),
      errStack: e instanceof Error ? e.stack : undefined,
      contextTokens: estimatedTokens,
    })
  })
}

// v0.17.x batch-1 fix: protocol-error retry backoff is racing against the
// loop's AbortSignal. Previously `setTimeout(resolve, delay)` ignored an
// already-aborted signal — the user had to wait the full backoff before
// `throwIfAborted` could fire on the next await. This helper unblocks the
// promise as soon as either the timer elapses or the signal aborts.
// Root cause was the bare setTimeout not being signal-aware. The fix races
// the two completion paths; no defensive try/catch or state flag.
const waitWithAbort = (delayMs: number, signal: AbortSignal): Promise<void> => {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// (Abort handling is inlined at the call site where the abort must be
// observed; a helper was tried and removed because only one place needed
// the check, and inlining keeps the throw site obvious to readers.)

// ----------------------------------------------------------------------------
// The loop. Behavior is identical to the pre-v0.17 monolith.
// ----------------------------------------------------------------------------

export const runIMLoop = async (opts: IMLoopOptions): Promise<IMLoopResult> => {
  const log = (opts.logger ?? defaultLogger).child({ component: 'im-loop', workingAgentId: opts.workingAgentId })
  // v0.17.x P1-6: abort signal lifecycle. When caller passes a pre-aborted
  // signal, we honour it on the first await. The internal AbortController
  // stays open so existing callers that never opt into a signal are not
  // affected (throwIfAborted on a fresh controller is a no-op).
  const externalSignal = opts.signal
  const internalAc = new AbortController()
  // If the caller already aborted, propagate it to our internal controller
  // so every throwIfAborted below also fires.
  if (externalSignal?.aborted === true) internalAc.abort()
  // v0.17.x batch-1 fix: bridge externalSignal -> internalAc for the entire
  // turn. Without this listener, an external abort that fires AFTER the
  // initial check (e.g. another async path triggers `ac.abort()` partway
  // through the turn) would not propagate to internalAc and the loop's
  // throwIfAborted checks would see a stale un-aborted signal. Root cause:
  // the original implementation only handled the "aborted on entry" case
  // and forgot the "aborted mid-turn" case. The listener is removed when
  // the loop finishes so a single ToolRegistry instance can serve many
  // sequential runIMLoop calls without leaking listeners.
  const bridgeAbort = (): void => { internalAc.abort() }
  if (externalSignal !== undefined) {
    externalSignal.addEventListener('abort', bridgeAbort, { once: true })
  }
  const acSignal = internalAc.signal
  const directRecallLedger = opts.directRecallLedger ?? createDirectRecallLedger()

  let state: State = 'Running'
  let metrics: Metrics = opts.initialMetrics ?? createMetrics()
  let turns = 0
  let lastMetrics: Metrics | null = null
  const loopStart = Date.now()
  let protocolErrorRetries = 0
  log.info('runIMLoop start', { model: opts.model, url: opts.url })

  // v0.20 (ADR-025 #4): SessionStart hook — 会话开始信号
  opts.hookSystem?.emit('SessionStart', {
    event: 'SessionStart',
    sessionId: opts.sessionId,
    agentId: opts.workingAgentId,
    toolName: undefined,
    args: undefined,
    result: undefined,
    duration: undefined,
    error: undefined,
  })

  // Resolve contextual databus ONCE for the whole loop (v0.17 — closes a
  // MultiDatabus subscriber leak that existed in the per-round assembly).
  let ctxDatabus: Databus | MultiDatabus | undefined
  if (opts.ctxDatabus === undefined) {
    ctxDatabus = undefined
  } else if (Array.isArray(opts.ctxDatabus)) {
    if (opts.ctxDatabus.length === 1) {
      ctxDatabus = opts.ctxDatabus[0] as Databus
    } else if (opts.ctxDatabus.length > 1) {
      ctxDatabus = new MultiDatabus(opts.ctxDatabus as Databus[])
    } else {
      ctxDatabus = undefined
    }
  } else {
    ctxDatabus = opts.ctxDatabus as Databus
  }

  // v0.27 修复（用户指出 + 双轮实证 USERS=0/4）：user 回合此前从不进 canonical
  // 历史——用户输入只是当轮的 userTemplate 参数，用一次就丢（loop.ts 全文只有
  // assistant:286 / tool:986 两个 appendCanonicalTurn 调用）。后果链：落盘缺 user
  // 行（真实 conversation.jsonl 实证）→ 新客户端/恢复/CLI/导出全缺用户消息
  // （webapp 靠前端的本地乐观投影掩盖，即"多客户端不同步"局限的根源）→
  // drive-coordinator 的 user 边界切块在主会话永不成立（findNextTaskBlock
  // 只扫 role==='user'）。修复落在 loop 入口（compose 之前）：把 userTemplate
  // 落成 canonical user 回合（memory + persistTurn），后续轮次的 history 自带
  // 用户文本。消息组装顺序不变（system → history → userTemplate → …），状态机
  // 顺序不动——本轮去重交给 composePrompt（见下），只是当轮不重复出现两次。
  if (opts.userTemplate !== '') {
    // 记忆提醒（v0.43）：>512K 后每个用户条目尾部追加提醒块。userTemplate 落
    // canonical 之前估算本条目进入后的上下文规模（此刻它还没进 history，需单计）。
    const entryTokens = estimateContextTokens(opts)
      + (opts.tokenCounter ?? DEEPSEEK_TOKEN_COUNTER).count(opts.userTemplate)
    const userTurn: ConversationTurn = {
      id: mintTurnId('user'),
      role: 'user',
      content: entryTokens > MEMORY_REMINDER_MIN_TOKENS
        ? opts.userTemplate + buildMemoryReminder()
        : opts.userTemplate,
      at: Date.now(),
    }
    appendCanonicalTurn(opts.conversationMemory, opts.databus, userTurn)
    if (opts.persistTurn) await opts.persistTurn(userTurn)
  }

  try {
    while (true) {
      // v0.17.x P1-6: abort is observed AFTER the first hook call (so the
      // hook has a chance to see the aborted signal in ctx) and after every
      // subsequent await boundary. When aborted, throwIfAborted raises a
      // DOMException AbortError caught by the outer try/catch and translated
      // to 'shell-terminated' IMLoopResult. `continue` paths re-enter the
      // loop here, so each iteration checks abort at least once.
      turns += 1
      log.trace('round start', { turn: turns, state })
      // 本轮的流式 turnId。必须全局唯一（§6.7 mintTurnId 纪律）：信号关下游
      // （webapp / CLI session-view）以 turnId 为流式条目的 key——若用
      // `turn-${turns}` 这种每轮 runIMLoop 重置的短编号，跨轮撞车会把新轮的
      // 流式文本合并进旧轮条目（items.length 不变 → 前端不滚动 → 用户看到
      // "没有回应"，真实事故 2026-09-08）。
      const turnId = mintTurnId('turn')
      const estimatedTokens = estimateContextTokens(opts)

      // [HOOK 1] beforeShellCall — opt-in control flow intervention.
      const beforeDecision = await callHook(opts.hooks?.beforeShellCall, {
        turnId,
        stepNumber: turns,
        signal: acSignal,
        promptTokens: estimatedTokens,
      }, 'beforeShellCall', log)
      // (Abort handling: signal is passed to all hook ctx so hooks can
      // observe it. The throwIfAborted below is gated on no-synthetic so
      // a hook that intentionally terminates via block+synthetic is not
      // overridden by an external abort.)
      // KimiCode pattern (turn-step.ts:130): observe abort between awaits.
      // Skip when the hook supplied a syntheticResponse — the hook author
      // has already chosen the round's outcome, abort should not interfere.
      if (beforeDecision?.syntheticResponse === undefined) acSignal.throwIfAborted()
      // KimiCode pattern (turn-step.ts:125-127): block without replacement is
      // an error, not a continue. Throwing here lets the loop's try/catch
      // and finally cleanup run normally; the caller receives a clear
      // IMLoopResult with reason='guard-tripped' (the closest available
      // reason for "the hook author asked us to stop without supplying
      // anything to do").
      if (beforeDecision?.block === true && beforeDecision.syntheticResponse === undefined) {
        state = 'Tripped'
        log.warn('beforeShellCall block=true without syntheticResponse; terminating', { turn: turns })
        return {
          terminated: true,
          reason: 'guard-tripped',
          finalState: state,
          hits: [],
          turns,
          metrics,
        }
      }
      // v0.17.x P1-7: when a hook supplied a syntheticResponse, skip compose
      // + shellCall entirely — the hook owns the round's output. We still
      // run advanceElapsed + runGuards + appendTurn below so state-machine
      // invariants (metrics advance, guard evaluation, conversation write)
      // are preserved on synthetic rounds.
      const syntheticResult = beforeDecision?.syntheticResponse

      // --- Begin round body. The compose → shellCall → afterShellCall chain
      // is skipped when syntheticResult is provided.
      let finalResult: ShellCallResult
      if (syntheticResult !== undefined) {
        finalResult = syntheticResult
      } else {
        // v0.20 (ADR-025 Part 2): composePrompt 抽出为纯函数。
        // 上下文组装顺序不变：system → afterSystem injections → history → userTemplate → afterUser injections → stateLine → tools → summaries → dynamicSchemas → skillText。
        const parts = await composePrompt(opts, { state, metrics, turns, lastMetrics, loopStart, protocolErrorRetries }, estimatedTokens)

        const finalPrompt = compose(opts.registry, parts)

        const deps: ShellDeps = {
          config: opts.config,
          registry: opts.registry,
          state,
          metrics,
          streamChat: opts.streamChat,
          url: opts.url,
          model: opts.model,
          // v0.21: 流式增量旁路——loop 只负责补 turn 上下文（turnId），
          // 观察者语义由 opts.onStreamChunk 的注入方（delta-bridge）拥有。
          ...(opts.onStreamChunk !== undefined
            ? { onStreamChunk: (chunk: import('../protocol/types.js').StreamChunk): void => opts.onStreamChunk!(turnId, chunk) }
            : {}),
          // v0.41 D19：严格交替 provider 的出站转写开关（provider 客观属性，
          // 装配层从 capabilities.strictAlternation 解析后逐轮透传）。
          ...(opts.strictAlternation !== undefined ? { strictAlternation: opts.strictAlternation } : {}),
        }

        let result: ShellCallResult | undefined
        try {
          result = await shellCall(deps, finalPrompt)
        } catch (e) {
          if (e instanceof ShellTerminatedError) {
            log.warn('shell terminated', { state: e.state, hits: e.hits, turn: turns })
            // Pass the error to afterShellCall so the hook can react even
            // though we are terminating here.
            await callHook<AfterShellCallContext, AfterShellCallResult>(opts.hooks?.afterShellCall, {
              turnId,
              stepNumber: turns,
              signal: acSignal,
              error: e,
            }, 'afterShellCall', log)
            return {
              terminated: true,
              reason: 'shell-terminated',
              finalState: e.state,
              hits: e.hits,
              turns,
              metrics,
            }
          }
          if (e instanceof ProtocolError) {
            // [HOOK 2] afterShellCall — retry/terminate policy.
            const after = await callHook<AfterShellCallContext, AfterShellCallResult>(opts.hooks?.afterShellCall, {
              turnId,
              stepNumber: turns,
              signal: acSignal,
              error: e,
            }, 'afterShellCall', log)
            if (after?.overrideTerminate) {
              return {
                terminated: true,
                reason: after.overrideTerminate.reason,
                finalState: state,
                hits: [...(after.overrideTerminate.hits ?? [])],
                turns,
                metrics,
              }
            }
            if (after?.retry === true) {
              // v0.17.x P1-3: hook retries are also subject to the global
              // retry cap — a malformed hook must not let the loop retry
              // forever.
              protocolErrorRetries += 1
              if (protocolErrorRetries > MAX_PROTOCOL_ERROR_RETRIES) {
                log.warn('protocol error: hook retry cap reached', { turn: turns, retries: protocolErrorRetries - 1 })
                return {
                  terminated: true,
                  reason: 'protocol-error',
                  finalState: state,
                  hits: [],
                  turns,
                  metrics,
                }
              }
              acSignal.throwIfAborted()
              const delay = after.retryDelayMs ?? 0
              if (delay > 0) await waitWithAbort(delay, acSignal)
              continue
            }
            // Default: pre-v0.17 retry/terminate policy. Identical to before.
            if (!e.retriable) {
              log.warn('protocol error (non-retriable)', { err: e.message, turn: turns })
              return {
                terminated: true,
                reason: 'protocol-error',
                finalState: state,
                hits: [],
                turns,
                metrics,
              }
            }
            protocolErrorRetries += 1
            if (protocolErrorRetries > MAX_PROTOCOL_ERROR_RETRIES) {
              log.warn('protocol error: max retries exceeded', {
                err: e.message,
                turn: turns,
                retries: protocolErrorRetries - 1,
              })
              return {
                terminated: true,
                reason: 'protocol-error',
                finalState: state,
                hits: [],
                turns,
                metrics,
              }
            }
            const delayMs = PROTOCOL_ERROR_RETRY_BASE_MS * Math.pow(2, protocolErrorRetries - 1)
            log.warn('protocol error: retrying', {
              err: e.message,
              turn: turns,
              retry: protocolErrorRetries,
              maxRetries: MAX_PROTOCOL_ERROR_RETRIES,
              delayMs,
            })
            acSignal.throwIfAborted()
            await waitWithAbort(delayMs, acSignal)
            continue
          }
          log.error('shellCall threw unexpected error', {
            err: e instanceof Error ? e.message : String(e),
            errStack: e instanceof Error ? e.stack : undefined,
            turn: turns,
          })
          throw e
        }
        // [HOOK 2b] afterShellCall with result — synthetic replacement path.
        const afterResult = await callHook<AfterShellCallContext, AfterShellCallResult>(opts.hooks?.afterShellCall, {
          turnId,
          stepNumber: turns,
          signal: acSignal,
          result,
        }, 'afterShellCall', log)
        if (afterResult?.syntheticResult !== undefined) {
          result = afterResult.syntheticResult
        }
        if (afterResult?.overrideTerminate) {
          return {
            terminated: true,
            reason: afterResult.overrideTerminate.reason,
            finalState: state,
            hits: [...(afterResult.overrideTerminate.hits ?? [])],
            turns,
            metrics,
          }
        }
        finalResult = result!
      }

      // v0.20 (ADR-025 #4): TurnEnd hook — 单轮 LLM 调用完成信号（协议 done 穿透）
      opts.hookSystem?.emit('TurnEnd', {
        event: 'TurnEnd',
        sessionId: opts.sessionId,
        agentId: opts.workingAgentId,
        toolName: undefined,
        args: undefined,
        result: finalResult.response.choices[0]?.message?.content ?? null,
        duration: Date.now() - loopStart,
        error: undefined,
      })

      metrics = advanceElapsed(finalResult.updatedMetrics, loopStart, Date.now())
      lastMetrics = metrics
      log.trace('round shellCall ok', {
        turn: turns,
        elapsedMs: metrics.elapsedMs,
        stepCount: metrics.stepCount,
        lastRequestTokens: metrics.lastRequestTokens,
      })

      // Inspect guard hits (re-run after elapsed advance — closes the
      // last-round time-guard blind spot).
      const hits = runGuards(metrics, opts.config)

      // [HOOK 3] afterGuards — can forceTerminate. KimiCode pattern: the
      // hook returns a boolean decision, not a state mutation. The state
      // field must follow the actual semantic — guard-tripped only when
      // guards actually hit; otherwise Running (a forceTerminate without
      // hits means "we agreed to stop" not "the machine tripped").
      const afterGuardsResult = await callHook(opts.hooks?.afterGuards, {
        turnId,
        stepNumber: turns,
        signal: acSignal,
        hits,
      }, 'afterGuards', log)
      if (afterGuardsResult?.forceTerminate === true) {
        const reason = afterGuardsResult.reason ?? 'guard-tripped'
        // v0.17.x P0-2: state tracks actual lifecycle, not the hook's
        // desire. Only hits.length > 0 marks the shell as Tripped.
        state = hits.length > 0 ? 'Tripped' : 'Running'
        log.warn('forceTerminate by afterGuards hook', { turn: turns, reason, hits: hits.length })
        return {
          terminated: true,
          reason,
          finalState: state,
          hits,
          turns,
          metrics,
        }
      }

      if (hits.length > 0) {
        state = 'Tripped'
        log.warn('guard tripped', { turn: turns, hits, finalMetrics: metrics })
        return {
          terminated: true,
          reason: 'guard-tripped',
          finalState: state,
          hits,
          turns,
          metrics,
        }
      }

      // v0.20 (ADR-025 Part 2): finalizeRound 抽出为纯函数。
      // 职责：appendAssistantTurn + persistTurn（一轮结束后的持久化）。
      await finalizeRound(finalResult, opts, { state, metrics, turns, lastMetrics, loopStart, protocolErrorRetries }, estimatedTokens, log)

      // v0.30 (B1/B2/B3): 每轮 finalize 后统一 fire 一次压缩调度——不再只在
      // 工具轮末或 block-continue 路径触发。这一处覆盖全部轮型：工具轮、
      // 纯文本 completed 轮（会话收尾也能触发压缩）、synthetic 轮。
      // 喂值去上游化：用本轮 estimatedTokens（轮初对实际上 wire 的 canonical 做的
      // 本地 DeepSeek 加权计数 = 本轮真正发出去的那份内容的规模），**不再读
      // metrics.lastRequestTokens**——relay 缓存命中时低报 usage 会把内存层钉死在 M1
      // （根因见 estimateContextTokens 注释）。estimatedTokens 恰是"本轮请求的规模"，
      // 正是层判定该用的口径。
      fireDriveCoordinator(opts, estimatedTokens, log)

      if (finalResult.toolCalls.length === 0) {
        // [HOOK 6] beforeComplete — v0.41 goal 模式的唯一状态机接缝。
        // 位置承重：必须在 finalizeRound（assistant 回合已 append + persist）与
        // fireDriveCoordinator（本轮压缩已 fire）之后，所以 hook 看到的是本轮
        // 完整收尾后的 canonical，它的判定与后续改动都不会影响本轮的持久化。
        // 返回 continueWith = 否决 completed 终止，续跑一轮。
        const beforeComplete = await callHook(opts.hooks?.beforeComplete, {
          turnId,
          stepNumber: turns,
          signal: acSignal,
          lastRequestTokens: metrics.lastRequestTokens,
          conversationMemory: opts.conversationMemory,
          databus: opts.databus,
          tokenCounter: opts.tokenCounter,
        }, 'beforeComplete', log)

        if (beforeComplete?.continueWith !== undefined) {
          // 追加合成 user 回合。写法对齐本文件 loop 入口的 userTemplate 规范化
          // （v0.27）——那是全库唯一另一处往 canonical 写 user 回合的生产路径。
          // idPrefix 由 hook 生产方拥有（mem- / compaction-note- / sys- 同惯例），
          // 下游据此区分真实用户输入与 harness 生成的续跑。
          // 下一轮 composePrompt 经既有 history 投影（:244）自动带上 wire，
          // compose 层零改动；omitUserTemplatePart 的 role+content 去重不受影响。
          const continuation: ConversationTurn = {
            id: mintTurnId(beforeComplete.continueWith.idPrefix),
            role: 'user',
            content: beforeComplete.continueWith.content,
            at: Date.now(),
          }
          appendCanonicalTurn(opts.conversationMemory, opts.databus, continuation)
          if (opts.persistTurn) await opts.persistTurn(continuation)
          log.info('runIMLoop continuing via beforeComplete hook', { turns, idPrefix: beforeComplete.continueWith.idPrefix })
          continue
        }

        log.info('runIMLoop completed', { turns, metrics })
        return {
          terminated: true,
          reason: 'completed',
          finalState: state,
          hits: [],
          turns,
          metrics,
        }
      }

      // [HOOK 4] beforeToolExecution — block / synthetic results.
      const beforeToolsResult = await callHook(opts.hooks?.beforeToolExecution, {
        turnId,
        stepNumber: turns,
        signal: acSignal,
        toolCalls: finalResult.toolCalls,
      }, 'beforeToolExecution', log)

      let toolResults: ToolTurn[]
      let errorCount: number
      // v0.18: ctx is created here so we can collect loaded dynamic schemas
      // after tool execution. load_tools writes to ctx._loadedDynamicTools.
      const ctx = buildToolContext(opts, ctxDatabus, directRecallLedger)
      if (beforeToolsResult?.block === true) {
        // v0.20 契约明确（ADR-025）：block=true 无 syntheticToolResults = hook 编程错误。
        // assistant turn（含 tool_calls）已在 HOOK 4 之前 commit，跳过 tool 执行
        // → 下一轮 LLM 看到 tool_calls 无 tool response → provider 400 → 终止。
        // hook 应返回 {block: true, syntheticToolResults: []} 表示"静默跳过"。
        if (beforeToolsResult.syntheticToolResults !== undefined) {
          toolResults = [...beforeToolsResult.syntheticToolResults]
          errorCount = 0
        } else {
          log.warn('beforeToolExecution block=true without syntheticToolResults; continuing', { turn: turns })
          continue
        }
      } else if (beforeToolsResult?.syntheticToolResults !== undefined) {
        // Not blocked but synthetic results supplied — substitute.
        toolResults = [...beforeToolsResult.syntheticToolResults]
        errorCount = toolResults.filter(r => r.isError === true).length
      } else {
        const now = Date.now()
        const out = await executeToolCalls(finalResult.toolCalls, opts.registry, now, opts.workingAgentId, ctx, opts.hookSystem)
        toolResults = out.turns
        errorCount = out.errorCount
      }

      // v0.18: collect dynamic schemas loaded by load_tools in this round.
      // load_tools attaches schemas to ctx._loadedDynamicTools; the loop
      // accumulates them so the next round's compose includes them.
      const loadedDynamic = (ctx as Record<string, unknown>)['_loadedDynamicTools'] as
        | Array<{ source: DynamicToolSource; tools: OpenAITool[] }>
        | undefined
      if (loadedDynamic && loadedDynamic.length > 0) {
        if (!opts.dynamicSchemas) opts.dynamicSchemas = []
        opts.dynamicSchemas.push(...loadedDynamic)
      }

      // [HOOK 5] afterToolExecution — transform results before append.
      // v0.30: ctx 携带 conversationMemory + databus 引用——工具级压缩
      // （历史工具表折叠）经此 hook 修改 canonical；两个引用是可选字段，
      // 不使用它们的既有 hook 零影响。
        const afterToolsResult = await callHook(opts.hooks?.afterToolExecution, {
        turnId,
        stepNumber: turns,
        signal: acSignal,
        toolResults,
        errorCount,
          conversationMemory: opts.conversationMemory,
          databus: opts.databus,
          tokenCounter: opts.tokenCounter,
      }, 'afterToolExecution', log)
      if (afterToolsResult?.transformedResults !== undefined) {
        toolResults = [...afterToolsResult.transformedResults]
        errorCount = toolResults.filter(r => r.isError === true).length
      }

      if (errorCount > 0) {
        log.warn('tool errors in round', {
          turn: turns,
          errorCount,
          totalCount: toolResults.length,
          consecutiveToolErrors: metrics.consecutiveToolErrors + 1,
        })
      }
      metrics = errorCount > 0 ? addToolError(metrics) : resetToolErrors(metrics)
      for (const tr of toolResults) {
        const { projectedTurn } = appendToolResultWithProjection(
          opts.conversationMemory,
          opts.databus,
          tr,
          opts.tokenCounter !== undefined ? { tokenCounter: opts.tokenCounter } : undefined,
        )
        // v0.30 (2026-09-09 用户拍板，撤销 v0.24 "args 不落盘"): args 随落盘
        // 全量保留——databus 消费方是 LLM 侧工具活动理解，args 是工具事件语义
        // 核心；恢复（recovery）后内存 Databus 与热路径行为一致。敏感内容明文
        // 落盘的取舍写入 docs/用户协议须提及.md，由用户自决。
        // v0.44: conversation snapshot stores the same bounded projection the
        // model sees; the optional second argument preserves the complete
        // ToolTurn in databus.jsonl.
        if (opts.persistTurn) await opts.persistTurn(projectedTurn, tr)
      }
    }
  } catch (e) {
    // v0.17.x P1-6: an AbortError thrown by acSignal.throwIfAborted() — or
    // by a hook that aborted the signal mid-call — is reported as
    // 'shell-terminated' with the shell's normal failure state. Without
    // this catch, the AbortError would bubble to the caller as an
    // uncaught rejection, breaking the IMLoopResult contract.
    if (e instanceof Error && e.name === 'AbortError') {
      log.info('runIMLoop aborted', { turn: turns })
      state = 'Tripped'
      return {
        terminated: true,
        reason: 'shell-terminated',
        finalState: state,
        hits: [],
        turns,
        metrics,
      }
    }
    throw e
  } finally {
    if (ctxDatabus instanceof MultiDatabus) ctxDatabus.close()
    if (externalSignal !== undefined) {
      externalSignal.removeEventListener('abort', bridgeAbort)
    }
    // v0.20 (ADR-025 #4): SessionEnd hook — 会话结束信号
    opts.hookSystem?.emit('SessionEnd', {
      event: 'SessionEnd',
      sessionId: opts.sessionId,
      agentId: opts.workingAgentId,
      toolName: undefined,
      args: undefined,
      result: undefined,
      duration: undefined,
      error: undefined,
    })
  }
}
