// Tests for MCP server summary injection — v0.19 D11
//
// Invariants:
//   - With MCP servers registered, injects summary.
//   - Without MCP servers, returns null.

import { describe, it, expect } from 'vitest'
import { createMcpSummaryInjection } from '../../../../src/im/hooks/injections/mcp-summary.js'
import type { InjectionContext } from '../../../../src/im/hooks/context-injection.js'
import type { ToolRegistry } from '../../../../src/shell/registry.js'

function createMockRegistry(opts: {
  mcpServers?: Array<{ name: string; description: string; toolNames: string[] }>
  skills?: Array<{ name: string; description: string }>
} = {}): ToolRegistry {
  const mcpServers = opts.mcpServers ?? []
  const skills = opts.skills ?? []

  const mcpMap = new Map(mcpServers.map(s => [s.name, { description: s.description, toolNames: s.toolNames }]))
  const skillMap = new Map(skills.map(s => [s.name, { description: s.description }]))

  return {
    listMCPServerMetas: () => mcpMap,
    listLoadableSkillMetas: () => skillMap,
  } as unknown as ToolRegistry
}

function makeCtx(registry: ToolRegistry): InjectionContext {
  return {
    conversationHistory: [],
    registry,
    round: 1,
  }
}

describe('mcp-summary injection', () => {
  it('injects summary when MCP servers are present', async () => {
    const registry = createMockRegistry({
      mcpServers: [{ name: 'playwright', description: '浏览器自动化', toolNames: ['navigate', 'click'] }],
    })
    const injection = createMcpSummaryInjection()
    const result = await injection.inject(makeCtx(registry))
    expect(result).not.toBeNull()
    expect(result).toContain('playwright')
    expect(result).toContain('浏览器自动化')
  })

  it('returns null when no MCP servers or skills', async () => {
    const registry = createMockRegistry()
    const injection = createMcpSummaryInjection()
    const result = await injection.inject(makeCtx(registry))
    expect(result).toBeNull()
  })

  it('injects summary when only skills are present', async () => {
    const registry = createMockRegistry({
      skills: [{ name: 'wiki', description: '知识库系统' }],
    })
    const injection = createMcpSummaryInjection()
    const result = await injection.inject(makeCtx(registry))
    expect(result).not.toBeNull()
    expect(result).toContain('wiki')
  })

  it('includes tool names in summary for MCP servers', async () => {
    const registry = createMockRegistry({
      mcpServers: [{ name: 'test-srv', description: '测试服务', toolNames: ['tool_a', 'tool_b'] }],
    })
    const injection = createMcpSummaryInjection()
    const result = await injection.inject(makeCtx(registry))
    expect(result).toContain('tool_a')
    expect(result).toContain('tool_b')
  })

  it('has correct name and priority', () => {
    const injection = createMcpSummaryInjection()
    expect(injection.name).toBe('mcp_server_summary')
    expect(injection.priority).toBe(30)
  })
})
