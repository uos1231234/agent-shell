import { describe, it, expect } from 'vitest'
import { ToolRegistry } from '../../src/shell/registry'
import { createLoadToolsTool } from '../../src/im/tools/load-tools'
import { DEFAULT_SUB_AGENT_TOOL_POLICY, type SubAgentToolPolicy } from '../../src/im/sub-agent/policy'
import type { ToolContext } from '../../src/shared/tool-context'

function setupRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  // Register MCP server with tools
  r.registerMCP('wiki', [
    {
      name: 'search_cards',
      description: 'Search cards',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      execute: async () => '[]',
    },
    {
      name: 'get_card',
      description: 'Get a card by id',
      parameters: { type: 'object', properties: { card_id: { type: 'string' } }, required: ['card_id'] },
      execute: async () => '{}',
    },
    {
      name: 'add_card',
      description: 'Add a card',
      parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      execute: async () => 'ok',
    },
  ])
  r.registerMCPServerMeta('wiki', 'Literature wiki MCP server', ['search_cards', 'get_card', 'add_card'])

  // Register another MCP server
  r.registerMCP('browser', [
    {
      name: 'navigate',
      description: 'Navigate to URL',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      execute: async () => 'ok',
    },
  ])
  r.registerMCPServerMeta('browser', 'Browser automation', ['navigate'])

  // Register a module skill
  r.registerSkill({
    name: 'ast-grep',
    description: 'AST-based code search',
    parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
    execute: async () => '[]',
  })
  r.registerLoadableSkillMeta('ast-grep', 'AST-based code search')

  return r
}

describe('load_tools tool', () => {
  describe('basic loading', () => {
    it('loads MCP server tools and attaches to ctx', async () => {
      const registry = setupRegistry()
      const tool = createLoadToolsTool(registry)
      const ctx: ToolContext = {}

      const result = await tool.execute(
        { sources: [{ type: 'mcp', server: 'wiki' }], reason: 'test load' },
        ctx,
      )

      expect(typeof result).toBe('string')
      expect(result).toContain('wiki')
      expect(result).toContain('3 tools')

      // Check that schemas were attached to ctx
      const loaded = (ctx as Record<string, unknown>)['_loadedDynamicTools'] as
        | Array<{ source: { kind: string; server: string }; tools: unknown[] }>
        | undefined
      expect(loaded).toBeDefined()
      expect(loaded!.length).toBe(1)
      expect(loaded![0]!.source).toEqual({ kind: 'mcp', server: 'wiki' })
      expect(loaded![0]!.tools.length).toBe(3)
    })

    it('loads skill tools and attaches to ctx', async () => {
      const registry = setupRegistry()
      const tool = createLoadToolsTool(registry)
      const ctx: ToolContext = {}

      const result = await tool.execute(
        { sources: [{ type: 'skill', name: 'ast-grep' }], reason: 'test load' },
        ctx,
      )

      expect(result).toContain('ast-grep')
      expect(result).toContain('1 tools')

      const loaded = (ctx as Record<string, unknown>)['_loadedDynamicTools'] as
        | Array<{ source: { kind: string; name: string }; tools: unknown[] }>
        | undefined
      expect(loaded).toBeDefined()
      expect(loaded![0]!.source).toEqual({ kind: 'skill', name: 'ast-grep' })
    })

    it('handles mixed sources (MCP + skill)', async () => {
      const registry = setupRegistry()
      const tool = createLoadToolsTool(registry)
      const ctx: ToolContext = {}

      const result = await tool.execute(
        {
          sources: [
            { type: 'mcp', server: 'wiki' },
            { type: 'skill', name: 'ast-grep' },
            { type: 'mcp', server: 'browser' },
          ],
          reason: 'test mixed load',
        },
        ctx,
      )

      expect(result).toContain('wiki')
      expect(result).toContain('ast-grep')
      expect(result).toContain('browser')

      const loaded = (ctx as Record<string, unknown>)['_loadedDynamicTools'] as Array<unknown>
      expect(loaded.length).toBe(3)
    })
  })

  describe('unknown sources', () => {
    it('reports unknown MCP server', async () => {
      const registry = setupRegistry()
      const tool = createLoadToolsTool(registry)
      const ctx: ToolContext = {}

      const result = await tool.execute(
        { sources: [{ type: 'mcp', server: 'nonexistent' }], reason: 'test' },
        ctx,
      )

      expect(result).toContain('Unknown: nonexistent')
    })

    it('reports unknown skill', async () => {
      const registry = setupRegistry()
      const tool = createLoadToolsTool(registry)
      const ctx: ToolContext = {}

      const result = await tool.execute(
        { sources: [{ type: 'skill', name: 'nonexistent' }], reason: 'test' },
        ctx,
      )

      expect(result).toContain('Unknown: nonexistent')
    })
  })

  describe('policy filtering', () => {
    it('allows all tools when no policy set', async () => {
      const registry = setupRegistry()
      const tool = createLoadToolsTool(registry)
      const ctx: ToolContext = {}

      const result = await tool.execute(
        { sources: [{ type: 'mcp', server: 'wiki' }], reason: 'test' },
        ctx,
      )

      // All 3 tools should be loaded (no policy filtering)
      expect(result).toContain('3 tools')
    })

    it('filters denied tools by policy', async () => {
      const registry = setupRegistry()
      const tool = createLoadToolsTool(registry)
      const policy: SubAgentToolPolicy = {
        default: 'allow',
        rules: [
          { mode: 'deny', pattern: 'add_card' },  // deny specific wiki tool
          { mode: 'deny', pattern: 'navigate' },    // deny browser tool
        ],
      }
      const ctx: ToolContext = { toolPolicy: policy }

      const result = await tool.execute(
        {
          sources: [
            { type: 'mcp', server: 'wiki' },
            { type: 'mcp', server: 'browser' },
          ],
          reason: 'test policy',
        },
        ctx,
      )

      // wiki: 2 of 3 tools (add_card denied), browser: 0 of 1 (navigate denied)
      expect(result).toContain('2 tools')  // wiki search_cards + get_card
      expect(result).toContain('denied by policy')  // browser fully denied
    })

    it('denies all tools for a server when policy denies all', async () => {
      const registry = setupRegistry()
      const tool = createLoadToolsTool(registry)
      const policy: SubAgentToolPolicy = {
        default: 'deny',
        rules: [],  // deny everything
      }
      const ctx: ToolContext = { toolPolicy: policy }

      const result = await tool.execute(
        { sources: [{ type: 'mcp', server: 'wiki' }], reason: 'test' },
        ctx,
      )

      expect(result).toContain('denied by policy')
    })
  })

  describe('reason validation', () => {
    it('requires a reason field', async () => {
      const registry = setupRegistry()
      const tool = createLoadToolsTool(registry)
      const ctx: ToolContext = {}

      await expect(
        tool.execute({ sources: [{ type: 'mcp', server: 'wiki' }] }, ctx),
      ).rejects.toThrow(/reason/)
    })

    it('rejects empty reason', async () => {
      const registry = setupRegistry()
      const tool = createLoadToolsTool(registry)
      const ctx: ToolContext = {}

      await expect(
        tool.execute({ sources: [{ type: 'mcp', server: 'wiki' }], reason: '' }, ctx),
      ).rejects.toThrow(/reason/)
    })
  })

  describe('schema quality', () => {
    it('preserves tool schema fields in loaded tools', async () => {
      const registry = setupRegistry()
      const tool = createLoadToolsTool(registry)
      const ctx: ToolContext = {}

      await tool.execute(
        { sources: [{ type: 'mcp', server: 'wiki' }], reason: 'test' },
        ctx,
      )

      const loaded = (ctx as Record<string, unknown>)['_loadedDynamicTools'] as Array<{
        source: unknown
        tools: Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>
      }>
      const searchTool = loaded[0]!.tools.find(t => t.function.name === 'wiki__search_cards')
      expect(searchTool).toBeDefined()
      expect(searchTool!.type).toBe('function')
      expect(searchTool!.function.description).toBe('Search cards')
      expect(searchTool!.function.parameters).toEqual({
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      })
    })
  })
})
