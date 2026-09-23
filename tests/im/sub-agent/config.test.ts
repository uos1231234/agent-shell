import { describe, it, expect } from 'vitest'
import { validateSubAgentConfig, type SubAgentConfig } from '../../../src/im/sub-agent/config.js'
import { ToolRegistry } from '../../../src/shell/registry.js'

const makeRegistry = (): ToolRegistry => {
  const r = new ToolRegistry()
  r.registerSystemTool({
    name: 'echo',
    description: 'echo',
    parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
    execute: async (args) => (args as { x: string }).x,
  })
  r.registerSystemTool({
    name: 'read',
    description: 'read',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async () => 'ok',
  })
  return r
}

describe('im/sub-agent/config', () => {
  it('accepts a valid config', () => {
    const registry = makeRegistry()
    const cfg = validateSubAgentConfig({
      name: 'reviewer',
      systemPrompt: 'You review code.',
      toolRefs: ['echo'],
    }, registry)
    expect(cfg.name).toBe('reviewer')
    expect(cfg.systemPrompt).toBe('You review code.')
    expect(cfg.toolRefs).toEqual(['echo'])
  })

  it('rejects an unknown toolRef', () => {
    const registry = makeRegistry()
    expect(() =>
      validateSubAgentConfig({
        name: 'reviewer',
        systemPrompt: 'You review code.',
        toolRefs: ['echo', 'nonexistent'],
      }, registry),
    ).toThrow('Unknown toolRefs in sub-agent config: nonexistent')
  })

  it('rejects missing name', () => {
    const registry = makeRegistry()
    expect(() =>
      validateSubAgentConfig({
        systemPrompt: 'You review code.',
        toolRefs: ['echo'],
      } as unknown as Record<string, unknown>, registry),
    ).toThrow('Sub-agent name')
  })

  it('rejects missing systemPrompt', () => {
    const registry = makeRegistry()
    expect(() =>
      validateSubAgentConfig({
        name: 'reviewer',
        toolRefs: ['echo'],
      } as unknown as Record<string, unknown>, registry),
    ).toThrow('non-empty "systemPrompt"')
  })

  it('rejects empty toolRefs', () => {
    const registry = makeRegistry()
    expect(() =>
      validateSubAgentConfig({
        name: 'reviewer',
        systemPrompt: 'You review code.',
        toolRefs: [],
      }, registry),
    ).toThrow('non-empty "toolRefs"')
  })

  it('accepts optional config overrides', () => {
    const registry = makeRegistry()
    const cfg = validateSubAgentConfig({
      name: 'reviewer',
      systemPrompt: 'You review code.',
      toolRefs: ['echo'],
      config: { maxSteps: 50 },
    }, registry)
    expect(cfg.config).toEqual({ maxSteps: 50 })
  })

  it('rejects non-object config field', () => {
    const registry = makeRegistry()
    expect(() =>
      validateSubAgentConfig({
        name: 'reviewer',
        systemPrompt: 'You review code.',
        toolRefs: ['echo'],
        config: 'bad',
      } as unknown as Record<string, unknown>, registry),
    ).toThrow('"config" field must be an object')
  })

  // v0.13 (decision D7): the v0.12.2 blanket rejection of MCP/skill refs is
  // removed. Sub-agents may now reference MCP and skill tools; permission is
  // governed by SubAgentToolPolicy (checked above). Under the default policy
  // these refs are allowed. Unknown refs (resolving to nothing) are still
  // rejected — see the 'rejects an unknown toolRef' test above.
  it('accepts MCP namespaced tool refs under the default policy', () => {
    const registry = makeRegistry()
    registry.registerMCP('serverA', [{
      name: 'tool1',
      description: 't1',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    }])
    const cfg = validateSubAgentConfig({
      name: 'mcp-user',
      systemPrompt: 'Use MCP.',
      toolRefs: ['serverA__tool1'],
    }, registry)
    expect(cfg.toolRefs).toEqual(['serverA__tool1'])
  })

  it('accepts skill refs under the default policy', () => {
    const registry = makeRegistry()
    registry.registerSkill({
      name: 'mySkill',
      description: 'a skill',
      execute: async () => 'ok',
    })
    const cfg = validateSubAgentConfig({
      name: 'skill-user',
      systemPrompt: 'Use skill.',
      toolRefs: ['mySkill'],
    }, registry)
    expect(cfg.toolRefs).toEqual(['mySkill'])
  })
})
