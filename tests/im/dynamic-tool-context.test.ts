import { describe, it, expect } from 'vitest'
import {
  isDynamicToolSchemaMessage,
  buildDynamicToolSchemaMessage,
  buildServerSummary,
  // collectLoadedSources 已注释下线（用户拍板 2026-09-10）——系统工具需要披露
  // 升级时可用。恢复时连同下方 describe 块一起取消注释。
  // collectLoadedSources,
  renderLoadResult,
  DYNAMIC_TOOL_SCHEMA_VARIANT,
} from '../../src/im/dynamic-tool-context'
import { ToolRegistry } from '../../src/shell/registry'

describe('dynamic-tool-context', () => {
  describe('isDynamicToolSchemaMessage', () => {
    it('returns true for a valid dynamic tool schema message', () => {
      const msg = buildDynamicToolSchemaMessage(
        { kind: 'mcp', server: 'wiki' },
        [{ type: 'function', function: { name: 'wiki__search', description: 'search', parameters: { type: 'object', properties: {} } } }],
      )
      expect(isDynamicToolSchemaMessage(msg)).toBe(true)
    })

    it('returns false for a plain system message', () => {
      expect(isDynamicToolSchemaMessage({ role: 'system', content: 'hello' })).toBe(false)
    })

    it('returns false for null', () => {
      expect(isDynamicToolSchemaMessage(null)).toBe(false)
    })

    it('returns false for messages with wrong variant', () => {
      expect(isDynamicToolSchemaMessage({
        role: 'system',
        content: 'test',
        tools: [{ type: 'function', function: { name: 'x', description: 'x', parameters: { type: 'object', properties: {} } } }],
        origin: { kind: 'injection', variant: 'wrong_variant' },
      })).toBe(false)
    })

    it('returns false for messages with empty tools array', () => {
      expect(isDynamicToolSchemaMessage({
        role: 'system',
        content: 'test',
        tools: [],
        origin: { kind: 'injection', variant: DYNAMIC_TOOL_SCHEMA_VARIANT },
      })).toBe(false)
    })
  })

  describe('buildDynamicToolSchemaMessage', () => {
    it('creates a message for MCP server', () => {
      const tools = [
        { type: 'function' as const, function: { name: 'wiki__search', description: 'search', parameters: { type: 'object' as const, properties: {} } } },
        { type: 'function' as const, function: { name: 'wiki__get', description: 'get', parameters: { type: 'object' as const, properties: {} } } },
      ]
      const msg = buildDynamicToolSchemaMessage({ kind: 'mcp', server: 'wiki' }, tools)
      expect(msg.role).toBe('system')
      expect(msg.content).toContain('wiki')
      expect(msg.content).toContain('wiki__search')
      expect(msg.content).toContain('wiki__get')
      expect(msg.tools).toBe(tools)
      expect(msg.origin.source).toEqual({ kind: 'mcp', server: 'wiki' })
    })

    it('creates a message for skill', () => {
      const tools = [
        { type: 'function' as const, function: { name: 'ast-grep', description: 'ast search', parameters: { type: 'object' as const, properties: {} } } },
      ]
      const msg = buildDynamicToolSchemaMessage({ kind: 'skill', name: 'ast-grep' }, tools)
      expect(msg.content).toContain('ast-grep')
      expect(msg.origin.source).toEqual({ kind: 'skill', name: 'ast-grep' })
    })
  })

  describe('buildServerSummary', () => {
    it('returns empty string when no servers or skills registered', () => {
      const r = new ToolRegistry()
      expect(buildServerSummary(r)).toBe('')
    })

    it('renders MCP server summaries', () => {
      const r = new ToolRegistry()
      r.registerMCPServerMeta('wiki', 'Literature wiki MCP server', ['search_cards', 'get_card'])
      r.registerMCPServerMeta('browser', 'Browser automation', ['navigate', 'screenshot'])

      const summary = buildServerSummary(r)
      expect(summary).toContain('wiki')
      expect(summary).toContain('Literature wiki MCP server')
      expect(summary).toContain('get_card')
      expect(summary).toContain('search_cards')
      expect(summary).toContain('browser')
      expect(summary).toContain('Browser automation')
      expect(summary).toContain('load_tools')
    })

    it('renders skill summaries', () => {
      const r = new ToolRegistry()
      r.registerLoadableSkillMeta('ast-grep', 'AST-based code search')
      r.registerLoadableSkillMeta('search-replace', 'Search and replace across files')

      const summary = buildServerSummary(r)
      expect(summary).toContain('ast-grep')
      expect(summary).toContain('AST-based code search')
      expect(summary).toContain('search-replace')
      expect(summary).toContain('load_tools')
    })

    it('renders both MCP servers and skills', () => {
      const r = new ToolRegistry()
      r.registerMCPServerMeta('wiki', 'Wiki server', ['search'])
      r.registerLoadableSkillMeta('ast-grep', 'AST search')

      const summary = buildServerSummary(r)
      expect(summary).toContain('Available MCP servers')
      expect(summary).toContain('Available skills')
    })
  })

  // 【已注释下线（用户拍板 2026-09-10）】collectLoadedSources 是"扫描对话历史
  // 标记"的平行实现，生产零调用（生产用 load_tools 的 result.status==='already'）。
  // 系统工具需要披露升级时连同源文件一起恢复。
  //
  // describe('collectLoadedSources', () => {
  //   it('returns empty sets for empty messages', () => {
  //     const result = collectLoadedSources([])
  //     expect(result.servers.size).toBe(0)
  //     expect(result.skills.size).toBe(0)
  //   })
  //
  //   it('collects MCP servers and skills from dynamic schema messages', () => {
  //     const dummyTools = [{ type: 'function' as const, function: { name: 'x', description: 'x', parameters: { type: 'object' as const, properties: {} } } }]
  //     const messages = [
  //       { role: 'user', content: 'hello' },
  //       buildDynamicToolSchemaMessage({ kind: 'mcp', server: 'wiki' }, dummyTools),
  //       buildDynamicToolSchemaMessage({ kind: 'skill', name: 'ast-grep' }, dummyTools),
  //       { role: 'system', content: 'regular message' },
  //       buildDynamicToolSchemaMessage({ kind: 'mcp', server: 'browser' }, dummyTools),
  //     ]
  //     const result = collectLoadedSources(messages)
  //     expect(result.servers).toEqual(new Set(['wiki', 'browser']))
  //     expect(result.skills).toEqual(new Set(['ast-grep']))
  //   })
  // })

  describe('renderLoadResult', () => {
    it('renders loaded, already loaded, and unknown sources', () => {
      const result = renderLoadResult(
        [
          { source: { kind: 'mcp', server: 'wiki' }, toolCount: 5 },
          { source: { kind: 'skill', name: 'ast-grep' }, toolCount: 1 },
        ],
        ['browser'],
        ['nonexistent'],
      )
      expect(result).toContain('Loaded: MCP server "wiki" (5 tools)')
      expect(result).toContain('Loaded: skill "ast-grep" (1 tools)')
      expect(result).toContain('Already available: browser')
      expect(result).toContain('Unknown: nonexistent')
    })
  })
})
