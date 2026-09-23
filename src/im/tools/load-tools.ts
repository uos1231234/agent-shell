// v0.18: load_tools — the progressive tool disclosure primitive.
//
// This tool is the ONLY way to make MCP server tools and module skill tools
// callable by the LLM. Instead of dumping all tool schemas into the top-level
// tools[] (token-expensive), the system prompt lists available servers/skills
// with short descriptions. The LLM calls load_tools to load the full schemas
// for the ones it needs, which get injected as dynamic tool schema messages
// in the conversation history.
//
// Sub-agent policy filtering: when ctx.toolPolicy is set, load_tools checks
// each requested tool against applyToolPolicy before loading. Tools denied
// by policy are silently skipped (reported in the output but not loaded).
//
// This is a system tool (registered via registerSystemAgentTools), so it goes
// through wrapTool → requireReason + SecurityRouter.check().

import type { ToolDefinition } from '../../shell/registry.js'
import type { ToolContext } from '../../shared/tool-context.js'
import type { ToolRegistry } from '../../shell/registry.js'
import { wrapTool, toSchema, reasonField } from './helpers.js'
import {
  buildDynamicToolSchemaMessage,
  renderLoadResult,
  type DynamicToolSource,
} from '../dynamic-tool-context.js'
import { applyToolPolicy, type SubAgentToolPolicy } from '../sub-agent/policy.js'
import type { OpenAITool } from '../../protocol/types.js'

type LoadSourcesInput = {
  sources: Array<
    | { type: 'mcp'; server: string }
    | { type: 'skill'; name: string }
  >
  reason: string
}

export const createLoadToolsTool = (
  registry: ToolRegistry,
): ToolDefinition => ({
  name: 'load_tools',
  description:
    '把某个 skill 或 MCP server 的工具定义加载进来，本轮变得可调用。'
    + '当前可加载的工具清单已在系统提示词中列出——**任务需要当前工具集之外的能力时调用**；'
    + '传入确切的来源，其完整定义立即进入会话上下文，下一次工具调用即可直接使用。',
  parameters: toSchema({
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['mcp', 'skill'],
            description: "'mcp' for an MCP server, 'skill' for a module skill",
          },
          server: {
            type: 'string',
            description: 'MCP server name (required when type is "mcp")',
          },
          name: {
            type: 'string',
            description: 'Skill name (required when type is "skill")',
          },
        },
        required: ['type'],
      },
      description: 'Array of sources to load. Each entry specifies an MCP server or module skill.',
    },
    reason: reasonField,
  }, ['sources', 'reason']),
  execute: wrapTool<LoadSourcesInput>(
    'load_tools',
    async (args, ctx) => {
      const sources = args.sources ?? []
      const loaded: Array<{ source: DynamicToolSource; toolCount: number }> = []
      const alreadyLoaded: string[] = []
      const unknown: string[] = []
      const denied: string[] = []

      for (const src of sources) {
        if (src.type === 'mcp') {
          const result = await loadMcpServer(registry, src.server, ctx)
          if (result.status === 'loaded') {
            loaded.push({ source: { kind: 'mcp', server: src.server }, toolCount: result.count })
          } else if (result.status === 'already') {
            alreadyLoaded.push(src.server)
          } else if (result.status === 'denied') {
            denied.push(src.server)
          } else {
            unknown.push(src.server)
          }
        } else if (src.type === 'skill') {
          const result = await loadSkill(registry, src.name, ctx)
          if (result.status === 'loaded') {
            loaded.push({ source: { kind: 'skill', name: src.name }, toolCount: result.count })
          } else if (result.status === 'already') {
            alreadyLoaded.push(src.name)
          } else if (result.status === 'denied') {
            denied.push(src.name)
          } else {
            unknown.push(src.name)
          }
        }
      }

      return renderLoadResult(loaded, alreadyLoaded, [...unknown, ...denied.map(n => `${n} (denied by policy)`)])
    },
  ),
})

// ---- helpers ---------------------------------------------------------------

type LoadResult =
  | { status: 'loaded'; count: number }
  | { status: 'already' }
  | { status: 'denied' }
  | { status: 'unknown' }

async function loadMcpServer(
  registry: ToolRegistry,
  server: string,
  ctx?: ToolContext,
): Promise<LoadResult> {
  const meta = registry.getMCPServerMeta(server)
  if (!meta) return { status: 'unknown' }

  const tools: OpenAITool[] = []
  for (const toolName of meta.toolNames) {
    if (ctx?.toolPolicy && !applyToolPolicy(toolName, ctx.toolPolicy)) {
      continue // policy denied — skip silently
    }
    const tool = registry.getMCPTool(server, toolName)
    if (!tool) continue
    tools.push({
      type: 'function',
      function: {
        name: `${server}__${tool.name}`,
        description: tool.description,
        parameters: tool.parameters,
      },
    })
  }

  if (tools.length === 0) return { status: 'denied' }

  // The schema message will be injected by the caller (loop.ts) via
  // buildDynamicToolSchemaMessage. Here we just return the loaded tools
  // so the caller can build the message.
  // Store on ctx for loop to pick up.
  if (!ctx) return { status: 'loaded', count: tools.length }

  // Attach loaded schemas to context for loop.ts to inject into history.
  // The loop reads ctx._loadedDynamicTools after tool execution.
  const existing = (ctx as Record<string, unknown>)['_loadedDynamicTools'] as
    | Array<{ source: DynamicToolSource; tools: OpenAITool[] }>
    | undefined
  const entry = { source: { kind: 'mcp' as const, server }, tools }
  if (existing) {
    existing.push(entry)
  } else {
    (ctx as Record<string, unknown>)['_loadedDynamicTools'] = [entry]
  }

  return { status: 'loaded', count: tools.length }
}

async function loadSkill(
  registry: ToolRegistry,
  name: string,
  ctx?: ToolContext,
): Promise<LoadResult> {
  const meta = registry.getLoadableSkillMeta(name)
  if (!meta) return { status: 'unknown' }

  if (ctx?.toolPolicy && !applyToolPolicy(name, ctx.toolPolicy)) {
    return { status: 'denied' }
  }

  const skill = registry.getSkill(name)
  if (!skill) return { status: 'unknown' }

  const tools: OpenAITool[] = [{
    type: 'function',
    function: {
      name: skill.name,
      description: skill.description,
      parameters: skill.parameters ?? { type: 'object', properties: {} },
    },
  }]

  const existing = (ctx as Record<string, unknown>)['_loadedDynamicTools'] as
    | Array<{ source: DynamicToolSource; tools: OpenAITool[] }>
    | undefined
  const entry = { source: { kind: 'skill' as const, name }, tools }
  if (existing) {
    existing.push(entry)
  } else {
    (ctx as Record<string, unknown>)['_loadedDynamicTools'] = [entry]
  }

  return { status: 'loaded', count: tools.length }
}
