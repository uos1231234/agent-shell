/**
 * Hook system types (v0.19 D8, v0.20 ADR-025 #4)
 *
 * 5 hook events:
 * - SessionStart: agent session begins (emitted at loop setup)
 * - TurnEnd: one LLM turn completes (emitted by protocol `done` in call.ts:83)
 * - SessionEnd: agent session ends (emitted in loop finally)
 * - PreToolUse: before tool execution (can block by returning false)
 * - PostToolUse: after tool execution
 */

export type HookEvent = 'SessionStart' | 'TurnEnd' | 'SessionEnd' | 'PreToolUse' | 'PostToolUse'

export type HookContext = {
  event: HookEvent
  toolName?: string | undefined
  args?: unknown | undefined
  result?: unknown | undefined
  duration?: number | undefined
  error?: Error | undefined
  sessionId?: string | undefined
  agentId?: string | undefined
}

export type HookHandler = {
  event: HookEvent
  handler: (ctx: HookContext) => Promise<void | boolean>
}
