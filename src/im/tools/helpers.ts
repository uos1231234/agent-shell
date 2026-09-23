// Shared tool helpers: reason validation, schema builder, reason field/drop.
// Extracted from tools/index.ts and validate.ts so both old and new callers
// share one canonical implementation.
//
// ADR-013: every tool schema declares a `reason` field (NOT marked `required`
// because some coding-plan services reject schema deviations). `requireReason`
// is the enforcer at each tool's `execute()` entry.

import type { JSONSchema } from '../../shared/json-schema.js'
import type { ToolContext } from '../../shared/tool-context.js'

export const requireReason = (args: { reason?: unknown }, toolName: string): string => {
  const r = args.reason
  if (typeof r !== 'string' || r.length === 0) {
    throw new Error(`${toolName} requires a "reason" string explaining what this call is for. Please add a reason and re-issue.`)
  }
  return r
}

export const wrapTool = <I extends { reason?: unknown }>(
  toolName: string,
  executor: (input: I, ctx?: ToolContext) => Promise<unknown>,
): ((raw: unknown, ctx?: ToolContext) => Promise<unknown>) => {
  return async (raw: unknown, ctx?: ToolContext): Promise<unknown> => {
    try {
      const args = (raw ?? {}) as I
      requireReason(args, toolName)
      return await executor(args, ctx)
    } catch (e) {
      // Re-throw unchanged. Sentence formatting happens exactly once in
      // loop.ts executeToolCalls' catch (the single isError marking point,
      // ADR-013). Swallowing here makes errorRate guard blind to all
      // wrapped (production) tool failures.
      throw e
    }
  }
}

export const toSchema = (props: Record<string, unknown>, required: readonly string[]): JSONSchema => ({
  type: 'object',
  properties: props,
  required,
})

export const reasonField = {
  type: 'string',
  description: 'Why are you calling this tool in this turn? Required. Empty reason will be rejected.',
} as const

export const dropReason = <T extends object>(i: T): Omit<T, 'reason'> => {
  const { reason: _ignored, ...rest } = i as T & { reason?: unknown }
  return rest
}

// Error formatting for the MCP/skill registry guard (registry.execute).
// System tools already wrap their own errors via wrapTool; MCP/skill tools
// are bare execute, so the registry guard wraps them with the same quality bar.
// 工具结果不在此截断（2026-09-12 用户拍板：未经同意不允许任何信息截断
// 机制）；非字符串结果由 loop 的单点序列化处理。

/**
 * Extract a clean, stack-trace-free error message from a thrown value.
 * Errors → e.message; everything else → String(e). The registry guard
 * uses this to build the `Tool "X" failed: <msg>` sentence thrown to the
 * loop (which already formats system-tool failures the same way).
 */
export const cleanErrorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)
