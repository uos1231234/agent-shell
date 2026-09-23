// v0.18: Dynamic tool schema context for progressive tool disclosure.
//
// When load_tools loads MCP server tools or module skill tools, their full
// schemas are injected into the conversation as system messages carrying a
// `tools` field (the wire contract for dynamic tool schemas). This module
// provides:
//   - DynamicToolSchemaMessage: the message type (with origin tag for undo)
//   - buildDynamicToolSchemaMessage: create one schema message
//   - buildServerSummary: render server/skill descriptions for the system prompt
//   - collectLoadedSources: find what's already loaded in history
//   - isDynamicToolSchemaMessage: predicate for filtering
//
// Design follows KimiCode's dynamic-tools.ts pattern adapted for MCP's
// server-grouped tool model.

import type { OpenAITool } from '../protocol/types.js'
import type { ToolRegistry } from '../shell/registry.js'

// ---- Types -----------------------------------------------------------------

/** Origin variant of an injected dynamic tool schema message. */
export const DYNAMIC_TOOL_SCHEMA_VARIANT = 'dynamic_tool_schema'

export type DynamicToolSource =
  | { kind: 'mcp'; server: string }
  | { kind: 'skill'; name: string }

export type DynamicToolSchemaMessage = {
  role: 'system'
  content: string  // human-readable summary of what was loaded
  tools: OpenAITool[]
  origin: { kind: 'injection'; variant: typeof DYNAMIC_TOOL_SCHEMA_VARIANT; source: DynamicToolSource }
}

// ---- Predicates ------------------------------------------------------------

/**
 * True for messages that carry loaded tool schemas (the `tools` field).
 * These are system messages injected by load_tools.
 */
export function isDynamicToolSchemaMessage(msg: unknown): boolean {
  if (typeof msg !== 'object' || msg === null) return false
  const m = msg as Record<string, unknown>
  return m.role === 'system'
    && Array.isArray(m.tools)
    && m.tools.length > 0
    && m.origin != null
    && typeof m.origin === 'object'
    && (m.origin as Record<string, unknown>).variant === DYNAMIC_TOOL_SCHEMA_VARIANT
}

// ---- Construction ----------------------------------------------------------

/**
 * Build a dynamic tool schema message for one loaded source (MCP server or
 * module skill). The `content` field is a human-readable summary that appears
 * in the conversation; the `tools` field carries the full OpenAI-format schemas.
 */
export function buildDynamicToolSchemaMessage(
  source: DynamicToolSource,
  tools: OpenAITool[],
): DynamicToolSchemaMessage {
  const toolNames = tools.map(t => t.function.name).join(', ')
  const sourceLabel = source.kind === 'mcp'
    ? `MCP server "${source.server}"`
    : `skill "${source.name}"`

  return {
    role: 'system',
    content: `Loaded tools from ${sourceLabel}: ${toolNames}`,
    tools,
    origin: { kind: 'injection', variant: DYNAMIC_TOOL_SCHEMA_VARIANT, source },
  }
}

// ---- Server summary for system prompt --------------------------------------

/**
 * Build the server/skill summary block for the system prompt. Lists all
 * registered MCP servers and loadable skills so the LLM knows what's
 * available for load_tools selection.
 *
 * Returns an empty string when no servers or skills are registered.
 */
export function buildServerSummary(registry: ToolRegistry): string {
  const serverMetas = registry.listMCPServerMetas()
  const skillMetas = registry.listLoadableSkillMetas()

  if (serverMetas.size === 0 && skillMetas.size === 0) return ''

  const parts: string[] = []

  if (serverMetas.size > 0) {
    parts.push('### Available MCP servers')
    for (const [name, meta] of serverMetas) {
      const toolList = meta.toolNames.join(', ')
      parts.push(`- **${name}**: ${meta.description}\n  Tools: ${toolList}`)
    }
  }

  if (skillMetas.size > 0) {
    parts.push('### Available skills')
    for (const [name, meta] of skillMetas) {
      parts.push(`- **${name}**: ${meta.description}`)
    }
  }

  parts.push(
    '\nUse the load_tools tool with exact server names or skill names to load full tool definitions before calling them.',
  )

  return parts.join('\n')
}

// ---- Collect loaded sources from history -----------------------------------

// 【已注释下线（用户拍板 2026-09-10）】—— 系统工具需要披露升级时可用。
//
// 为什么下线：本函数是「扫描对话历史里的 DynamicToolSchemaMessage 标记」来算
// 已加载集合；而生产实际用的是另一条路——load_tools 读「本次调用的
// result.status === 'already'」（src/im/tools/load-tools.ts:77/86-97），并且
// 那条路工作正常（渲染面见下方 renderLoadResult 的 `Already available: ...`）。
// 同一需求两条平行实现，生产接了后者，本函数零调用。
//
// 恢复时机：**系统工具需要披露升级时可用**——例如要让「已加载」判定跨轮次、
// 基于对话历史去重（而非仅本次调用），或要将披露状态与其他上下文投影对齐时。
//
// /**
//  * Collect the set of already-loaded MCP server names and skill names from
//  * dynamic tool schema messages in the conversation history. Used by
//  * load_tools to report "already available" and skip re-injection.
//  */
// export function collectLoadedSources(
//   messages: readonly unknown[],
// ): { servers: Set<string>; skills: Set<string> } {
//   const servers = new Set<string>()
//   const skills = new Set<string>()
//
//   for (const msg of messages) {
//     if (!isDynamicToolSchemaMessage(msg)) continue
//     const m = msg as DynamicToolSchemaMessage
//     if (m.origin.source.kind === 'mcp') {
//       servers.add(m.origin.source.server)
//     } else {
//       skills.add(m.origin.source.name)
//     }
//   }
//
//   return { servers, skills }
// }

// ---- Render load announcement ----------------------------------------------

/**
 * Render a load_tools result as a human-readable string for the tool output.
 */
export function renderLoadResult(
  loaded: Array<{ source: DynamicToolSource; toolCount: number }>,
  alreadyLoaded: string[],
  unknown: string[],
): string {
  const lines: string[] = []

  for (const item of loaded) {
    const label = item.source.kind === 'mcp'
      ? `MCP server "${item.source.server}"`
      : `skill "${item.source.name}"`
    lines.push(`Loaded: ${label} (${item.toolCount} tools)`)
  }

  if (alreadyLoaded.length > 0) {
    lines.push(`Already available: ${alreadyLoaded.join(', ')}`)
  }

  for (const name of unknown) {
    lines.push(`Unknown: ${name}. Use the summary to find exact names.`)
  }

  return lines.join('\n')
}
