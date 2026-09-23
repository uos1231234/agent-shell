// v0.17: Loop hooks — KimiCode-style control-flow intervention points.
//
// Who hooks are for (user decision 2026-09-05): the HARNESS ITSELF. This is
// not a plugin API and no external consumer is expected. Hook points are
// information-flow branch seams of the state machine: the loop emits part
// of its stream to a side channel (SignalBus / rendering / error recovery)
// without diluting the core context engineering. See the philosophy block
// at the top of loop.ts.
//
// Design philosophy (plan §1): hooks are BIDIRECTIONAL contracts (caller passes
// ctx in, hook returns Result out). They can affect control flow. This is the
// deliberate counterpart to events, which are UNIDIRECTIONAL broadcast (caller
// pushes event out, subscribers only read, dispatcher never waits on return).
//
// The two are orthogonal mechanisms: events without hooks would lose the ability
// to gate behavior; hooks without events would lose the ability to fan out to
// observers. Conflating them (e.g. "let events block dispatch until subscribers
// vote") is the design anti-pattern KimiCode explicitly rejects — see
// events.ts:155: "Hooks can affect control flow at deterministic transcript
// points. Event listeners observe output and cannot change turn behavior."
//
// This file owns:
//   - 6 hook context types (precise per-stage, not one mega-ctx)
//   - 6 hook result types (data objects, never exceptions)
//   - LoopHooks interface
//   - callHook helper (failure-safe: hook throw → undefined + log.warn)
//
// Hook ordering is fixed by call sites in loop.ts (deterministic, serial, awaited).

import type { ToolCall } from '../protocol/types.js'
import type { GuardHit } from '../shell/guards.js'
import type { ToolTurn } from './databus.js'
import type { ShellCallResult } from '../shell/call.js'
import { ShellTerminatedError } from '../shell/gate.js'
import { ProtocolError } from '../protocol/types.js'
import type { Logger } from '../shared/logger.js'
import type { TokenCounter } from '../shared/token-counter.js'

// ============================================================================
// Helper
// ============================================================================

/**
 * Fail-safe hook invocation. A hook returning undefined means "not
 * intervening — caller uses default behavior." A hook throwing is caught and
 * treated as undefined (with a warning) so a single hook failure cannot break
 * the turn. This mirrors KimiCode loop/tool-call.ts §491-501.
 *
 * v0.17.x P1-5: the warning goes through the caller's structured logger so
 * the failure inherits the loop's component/workingAgentId binding rather
 * than leaking to the global console. When log is undefined, fall back to
 * console.warn (callers that pass no logger still get diagnostic output).
 */
export async function callHook<TContext, TResult>(
  hook: ((ctx: TContext) => Promise<TResult | undefined>) | undefined,
  ctx: TContext,
  hookName: string,
  log?: Logger,
): Promise<TResult | undefined> {
  if (hook === undefined) return undefined
  try {
    return await hook(ctx)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (log !== undefined) {
      log.warn(`loop-hook:${hookName} threw, treating as no-op`, { err: msg })
    } else {
      console.warn(`[loop-hook:${hookName}] hook threw, treating as no-op: ${msg}`)
    }
    return undefined
  }
}

// ============================================================================
// Hook 1: beforeShellCall
// ============================================================================

export interface BeforeShellCallContext {
  readonly turnId: string
  readonly stepNumber: number
  readonly signal: AbortSignal | undefined
  readonly promptTokens: number
}

export interface BeforeShellCallResult {
  /** When true, skip this shellCall entirely and continue to the next round. */
  readonly block?: boolean | undefined
  readonly reason?: string | undefined
  /**
   * If set, the loop substitutes this assistant turn instead of calling the
   * shell, then proceeds as if the shell returned it. Used for synthetic
   * completions (e.g. injected answers, tests).
   */
  readonly syntheticResponse?: ShellCallResult | undefined
}

export type BeforeShellCallHook = (
  ctx: BeforeShellCallContext,
) => Promise<BeforeShellCallResult | undefined>

// ============================================================================
// Hook 2: afterShellCall
// ============================================================================

export interface AfterShellCallContext {
  readonly turnId: string
  readonly stepNumber: number
  readonly signal: AbortSignal | undefined
  /** Set when shellCall threw; mutually exclusive with `result`. */
  readonly error?: ShellTerminatedError | ProtocolError | undefined
  /** Set when shellCall resolved; mutually exclusive with `error`. */
  readonly result?: ShellCallResult | undefined
}

export interface AfterShellCallResult {
  /** When true with a ProtocolError, the loop retries with the hook's delay. */
  readonly retry?: boolean | undefined
  readonly retryDelayMs?: number | undefined
  /** Replaces the actual shellCall result for the rest of this round. */
  readonly syntheticResult?: ShellCallResult | undefined
  /** Forces termination of the turn from this round. */
  readonly overrideTerminate?: {
    readonly reason: 'shell-terminated' | 'protocol-error'
    readonly hits?: ReadonlyArray<GuardHit>
  } | undefined
}

export type AfterShellCallHook = (
  ctx: AfterShellCallContext,
) => Promise<AfterShellCallResult | undefined>

// ============================================================================
// Hook 3: afterGuards
// ============================================================================

export interface AfterGuardsContext {
  readonly turnId: string
  readonly stepNumber: number
  readonly signal: AbortSignal | undefined
  readonly hits: ReadonlyArray<GuardHit>
}

export interface AfterGuardsResult {
  /** Force termination even when guards did not hit. */
  readonly forceTerminate?: boolean | undefined
  readonly reason?: 'completed' | 'guard-tripped' | 'protocol-error' | 'shell-terminated' | undefined
}

export type AfterGuardsHook = (
  ctx: AfterGuardsContext,
) => Promise<AfterGuardsResult | undefined>

// ============================================================================
// Hook 4: beforeToolExecution
// ============================================================================

export interface BeforeToolExecutionContext {
  readonly turnId: string
  readonly stepNumber: number
  readonly signal: AbortSignal | undefined
  readonly toolCalls: ReadonlyArray<ToolCall>
}

export interface BeforeToolExecutionResult {
  /**
   * When true, all tool calls in this batch are skipped.
   *
   * v0.20 契约明确（ADR-025）：
   * - block=true + syntheticToolResults 已提供 → 用 syntheticToolResults 替代执行结果
   * - block=true + 无 syntheticToolResults → 行为未定义（loop 继续，产生孤儿消息序列）
   *   原因：assistant turn（含 tool_calls）已在 HOOK 4 之前 commit，
   *   跳过 tool 执行后下一轮 LLM 看到 tool_calls 无 tool response → provider 400 → 终止。
   *   如果 hook 本意是"静默跳过"，应返回 {block: true, syntheticToolResults: []}。
   */
  readonly block?: boolean | undefined
  readonly reason?: string | undefined
  /** Replaces the actual tool results; the loop appends these instead. */
  readonly syntheticToolResults?: ReadonlyArray<ToolTurn> | undefined
}

export type BeforeToolExecutionHook = (
  ctx: BeforeToolExecutionContext,
) => Promise<BeforeToolExecutionResult | undefined>

// ============================================================================
// Hook 5: afterToolExecution
// ============================================================================

export interface AfterToolExecutionContext {
  readonly turnId: string
  readonly stepNumber: number
  readonly signal: AbortSignal | undefined
  readonly toolResults: ReadonlyArray<ToolTurn>
  readonly errorCount: number
  // v0.30: 工具级压缩（历史工具表折叠）的 canonical 修改入口。工具执行后、
  // 本轮结果 append 前触发，hook 可在此折叠热窗口之外的旧工具回合。
  // 可选引用——不使用它们的既有 hook 零影响。databus 是工具事件投影
  // （折叠只改 canonical，databus 保留供关键字召回）。
  readonly conversationMemory?: import('./conversation-memory.js').ConversationMemory | undefined
  readonly databus?: import('./databus.js').Databus | undefined
  readonly tokenCounter?: TokenCounter | undefined
}

export interface AfterToolExecutionResult {
  /** Replaces the tool results appended to conversation memory / databus. */
  readonly transformedResults?: ReadonlyArray<ToolTurn> | undefined
}

export type AfterToolExecutionHook = (
  ctx: AfterToolExecutionContext,
) => Promise<AfterToolExecutionResult | undefined>

// ============================================================================
// Hook 6: beforeComplete
// ============================================================================

/**
 * v0.41（goal 模式）：loop 即将以 `completed` 终止时的唯一否决点。
 *
 * **触发时机与其它 hook 不同**：它不在每轮触发，只在
 * `finalResult.toolCalls.length === 0`（本轮 assistant 未发起工具调用，
 * 即 loop 本应返回 `reason:'completed'`）的那一轮触发，且位置在
 * finalizeRound（assistant 回合已 append + persist）与 fireDriveCoordinator
 * （本轮压缩调度已 fire）**之后**——所以 hook 看到的 canonical 是本轮完整
 * 收尾后的状态，改动它不会影响本轮的持久化与压缩。
 *
 * 为什么不能复用既有 hook（`[已验证]`，v0.41 计划 D1）：
 *   - HOOK 1 在每轮开头，无法阻止**上一轮**末尾的 return；
 *   - HOOK 2b 的 syntheticResult 是替换 assistant 输出，靠伪造 tool_calls
 *     续跑会在 canonical 里留下假工具回合（轨迹说谎）；
 *   - HOOK 3 只有 forceTerminate，且跑在 finalizeRound 之前；
 *   - HOOK 4/5 只在 `toolCalls.length > 0` 时可达，恰好错过这一轮。
 */
export interface BeforeCompleteContext {
  readonly turnId: string
  readonly stepNumber: number
  readonly signal: AbortSignal | undefined
  /**
   * 本轮协议层真实 usage（`metrics.lastRequestTokens`，由 shell/call.ts 从
   * usage.promptTokens 写入）。与 loop.ts 的压缩喂值同口径——hook 若要按
   * 上下文规模做决策，用这个而不是自己估算。
   */
  readonly lastRequestTokens: number
  /**
   * canonical 与 databus 引用。HOOK 5 的 AfterToolExecutionContext 已有先例
   * （v0.30 工具级压缩）。hook 可读全量历史做判定；**写**应通过返回
   * continueWith 交给 loop 执行（唯一合法写路径 appendCanonicalTurn +
   * persistTurn 在 loop 手里，hook 自行 append 会绕过落盘）。
   */
  readonly conversationMemory: import('./conversation-memory.js').ConversationMemory
  readonly databus: import('./databus.js').Databus
  readonly tokenCounter?: TokenCounter | undefined
}

export interface BeforeCompleteResult {
  /**
   * 不要以 completed 终止：loop 会按此追加一条 `role:'user'` 的 canonical
   * 回合（appendCanonicalTurn + persistTurn），然后 `continue` 进入下一轮。
   * 下一轮的 composePrompt 经既有 history 投影自动把它带上 wire——compose
   * 层零改动。
   *
   * `idPrefix` 由**生产方**拥有，与既有惯例一致：`mem-`（压缩信封）、
   * `compaction-note-`（交接笔记）、`sys-`（系统智能体 send）。前缀即生产者
   * 身份，下游（会话恢复 / 前端渲染 / grep 排查）据此区分"真实用户输入"与
   * "harness 生成的续跑"。loop 用 mintTurnId(idPrefix) 铸全局唯一 id。
   */
  readonly continueWith?: {
    readonly content: string
    readonly idPrefix: string
  } | undefined
}

export type BeforeCompleteHook = (
  ctx: BeforeCompleteContext,
) => Promise<BeforeCompleteResult | undefined>

// ============================================================================
// Aggregate
// ============================================================================

/**
 * Optional per-loop hooks. All hooks are async; returning undefined (or
 * omitting a field) means "use default behavior." Hooks run serially in
 * fixed order at their trigger points (see loop.ts). A hook throwing is
 * isolated by callHook — the turn continues with default behavior.
 *
 * Hooks are PER-LOOP, passed via IMLoopOptions.hooks — no module-level
 * registry. Sub-agents inherit the parent's hooks via ctx.hooks
 * (run-subagent.ts), matching the v0.16 sessionId propagation pattern.
 */
export interface LoopHooks {
  readonly beforeShellCall?: BeforeShellCallHook | undefined
  readonly afterShellCall?: AfterShellCallHook | undefined
  readonly afterGuards?: AfterGuardsHook | undefined
  readonly beforeToolExecution?: BeforeToolExecutionHook | undefined
  readonly afterToolExecution?: AfterToolExecutionHook | undefined
  /** v0.41：completed 终止判定的否决点（goal 模式续跑）。见 Hook 6 段。 */
  readonly beforeComplete?: BeforeCompleteHook | undefined
}
