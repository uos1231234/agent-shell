import { describe, it, expect } from 'vitest'
import { validateSubAgentConfig } from '../../../src/im/sub-agent/config.js'
import { DEFAULT_CONFIG } from '../../../src/shell/config.js'
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
  r.registerSystemTool({
    name: 'bash',
    description: 'bash',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'ok',
  })
  return r
}

const validBase = {
  systemPrompt: 'You review code.',
  toolRefs: ['echo'],
}

describe('im/sub-agent/config — P2.1 path-safe name', () => {
  it('accepts a simple alphanumeric name', () => {
    const cfg = validateSubAgentConfig({ name: 'reviewer', ...validBase }, makeRegistry())
    expect(cfg.name).toBe('reviewer')
  })

  it('accepts name with hyphens and underscores', () => {
    const cfg = validateSubAgentConfig({ name: 'code-reviewer_v2', ...validBase }, makeRegistry())
    expect(cfg.name).toBe('code-reviewer_v2')
  })

  it('rejects path traversal ../escape', () => {
    expect(() =>
      validateSubAgentConfig({ name: '../escape', ...validBase }, makeRegistry()),
    ).toThrow('Sub-agent name')
  })

  it('rejects slash in name a/b', () => {
    expect(() =>
      validateSubAgentConfig({ name: 'a/b', ...validBase }, makeRegistry()),
    ).toThrow('Sub-agent name')
  })

  it('rejects .. alone', () => {
    expect(() =>
      validateSubAgentConfig({ name: '..', ...validBase }, makeRegistry()),
    ).toThrow('Sub-agent name')
  })

  it('rejects empty string', () => {
    expect(() =>
      validateSubAgentConfig({ name: '', ...validBase }, makeRegistry()),
    ).toThrow('Sub-agent name')
  })

  it('rejects name over 64 characters', () => {
    const long = 'a'.repeat(65)
    expect(() =>
      validateSubAgentConfig({ name: long, ...validBase }, makeRegistry()),
    ).toThrow('Sub-agent name')
  })

  it('accepts name of exactly 64 characters', () => {
    const exact = 'a'.repeat(64)
    const cfg = validateSubAgentConfig({ name: exact, ...validBase }, makeRegistry())
    expect(cfg.name).toBe(exact)
  })

  it('rejects Windows reserved name CON', () => {
    expect(() =>
      validateSubAgentConfig({ name: 'CON', ...validBase }, makeRegistry()),
    ).toThrow('Sub-agent name')
  })

  it('rejects Windows reserved name PRN (case-insensitive)', () => {
    expect(() =>
      validateSubAgentConfig({ name: 'prn', ...validBase }, makeRegistry()),
    ).toThrow('Sub-agent name')
  })

  it('rejects Windows reserved name COM1', () => {
    expect(() =>
      validateSubAgentConfig({ name: 'COM1', ...validBase }, makeRegistry()),
    ).toThrow('Sub-agent name')
  })

  it('rejects Windows reserved name LPT9', () => {
    expect(() =>
      validateSubAgentConfig({ name: 'LPT9', ...validBase }, makeRegistry()),
    ).toThrow('Sub-agent name')
  })

  it('rejects name with space', () => {
    expect(() =>
      validateSubAgentConfig({ name: 'my agent', ...validBase }, makeRegistry()),
    ).toThrow('Sub-agent name')
  })

  it('rejects name with dot', () => {
    expect(() =>
      validateSubAgentConfig({ name: 'agent.v2', ...validBase }, makeRegistry()),
    ).toThrow('Sub-agent name')
  })
})

describe('im/sub-agent/config — G2 reserved agent names', () => {
  // v0.11.2 G2: system identity names must never be used as sub-agent names.
  // These are sourceAgentId values used by harness internals. Allowing them
  // would cause identity confusion in mailbox, databus projections, and state queries.
  const reservedNames = [
    'databus', 'system', 'drive-coordinator',
    'warehouse', 'compressor', 'recall', 'main',
  ]

  for (const name of reservedNames) {
    it(`rejects reserved agent name "${name}"`, () => {
      expect(() =>
        validateSubAgentConfig({ name, ...validBase }, makeRegistry()),
      ).toThrow('Sub-agent name')
    })
  }

  it('rejects reserved name even if it would otherwise be valid', () => {
    // "system" passes the [a-zA-Z0-9_-] regex and is not a Windows reserved
    // name, but it IS a reserved agent name. Verify it's rejected for the
    // right reason (system reserved, not path-safety).
    expect(() =>
      validateSubAgentConfig({ name: 'system', ...validBase }, makeRegistry()),
    ).toThrow('Sub-agent name')
  })

  it('accepts a name that merely contains a reserved word as substring', () => {
    // "my-system" is not the same as "system" — it should be accepted.
    const cfg = validateSubAgentConfig({ name: 'my-system', ...validBase }, makeRegistry())
    expect(cfg.name).toBe('my-system')
  })
})

describe('im/sub-agent/config — P2.2 tool permissions', () => {
  it('rejects run_subagent in toolRefs (forbidden)', () => {
    const r = makeRegistry()
    r.registerSystemTool({
      name: 'run_subagent',
      description: 'run sub-agent',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    })
    expect(() =>
      validateSubAgentConfig({ name: 'a', ...validBase, toolRefs: ['echo', 'run_subagent'] }, r),
    ).toThrow('not allowed by sub-agent policy')
  })

  it('rejects define_subagent in toolRefs (forbidden)', () => {
    const r = makeRegistry()
    r.registerSystemTool({
      name: 'define_subagent',
      description: 'define sub-agent',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    })
    expect(() =>
      validateSubAgentConfig({ name: 'a', ...validBase, toolRefs: ['echo', 'define_subagent'] }, r),
    ).toThrow('not allowed by sub-agent policy')
  })

  it('rejects bash in toolRefs by default (privileged)', () => {
    const r = makeRegistry()
    expect(() =>
      validateSubAgentConfig({ name: 'a', ...validBase, toolRefs: ['echo', 'bash'] }, r),
    ).toThrow('not allowed by sub-agent policy')
  })

  it('accepts bash when custom policy allows it', () => {
    const r = makeRegistry()
    const cfg = validateSubAgentConfig(
      { name: 'a', ...validBase, toolRefs: ['echo', 'bash'] },
      r,
      { toolPolicy: { default: 'allow', rules: [] } },
    )
    expect(cfg.toolRefs).toEqual(['echo', 'bash'])
  })

  it('accepts normal tools without privileged flag', () => {
    const cfg = validateSubAgentConfig({ name: 'a', ...validBase }, makeRegistry())
    expect(cfg.toolRefs).toEqual(['echo'])
  })

  it('rejects compressor-private tools even when the declared policy allows everything', () => {
    expect(() =>
      validateSubAgentConfig(
        { name: 'a', ...validBase, toolRefs: ['echo', 'submit_curated_memory'] },
        makeRegistry(),
        { toolPolicy: { default: 'allow', rules: [] } },
      ),
    ).toThrow('reserved for the compressor system agent')
  })
})

describe('im/sub-agent/config — P2.4 config overrides validation', () => {
  it('accepts valid positive integer overrides', () => {
    const cfg = validateSubAgentConfig(
      { name: 'a', ...validBase, config: { maxSteps: 50, maxTokens: 100000 } },
      makeRegistry(),
    )
    expect(cfg.config).toEqual({ maxSteps: 50, maxTokens: 100000 })
  })

  it('rejects zero maxSteps', () => {
    expect(() =>
      validateSubAgentConfig({ name: 'a', ...validBase, config: { maxSteps: 0 } }, makeRegistry()),
    ).toThrow('positive integer')
  })

  it('rejects negative maxToolCalls', () => {
    expect(() =>
      validateSubAgentConfig({ name: 'a', ...validBase, config: { maxToolCalls: -5 } }, makeRegistry()),
    ).toThrow('positive integer')
  })

  it('rejects non-integer maxTokens', () => {
    expect(() =>
      validateSubAgentConfig({ name: 'a', ...validBase, config: { maxTokens: 1.5 } }, makeRegistry()),
    ).toThrow('positive integer')
  })

  it('rejects maxSteps exceeding DEFAULT_CONFIG', () => {
    expect(() =>
      validateSubAgentConfig({ name: 'a', ...validBase, config: { maxSteps: DEFAULT_CONFIG.maxSteps + 1 } }, makeRegistry()),
    ).toThrow('cannot exceed default')
  })

  it('accepts maxSteps equal to DEFAULT_CONFIG boundary', () => {
    const cfg = validateSubAgentConfig(
      { name: 'a', ...validBase, config: { maxSteps: DEFAULT_CONFIG.maxSteps } },
      makeRegistry(),
    )
    expect(cfg.config).toEqual({ maxSteps: DEFAULT_CONFIG.maxSteps })
  })

  it('rejects unknown config field', () => {
    expect(() =>
      validateSubAgentConfig({ name: 'a', ...validBase, config: { bogus: 1 } }, makeRegistry()),
    ).toThrow('Unknown config fields')
  })

  it('rejects Infinity maxElapsedMs', () => {
    expect(() =>
      validateSubAgentConfig({ name: 'a', ...validBase, config: { maxElapsedMs: Infinity } }, makeRegistry()),
    ).toThrow('positive integer')
  })

  it('accepts empty config object (no overrides)', () => {
    const cfg = validateSubAgentConfig(
      { name: 'a', ...validBase, config: {} },
      makeRegistry(),
    )
    expect(cfg.config).toEqual({})
  })
})

// v0.13 (decision D7): the v0.12.2 blanket rejection of MCP/skill refs is
// removed. Sub-agents may now reference MCP and skill tools; permission is
// governed by SubAgentToolPolicy (default policy allows them). Unknown refs
// (resolving to nothing in the registry) are still rejected.
describe('im/sub-agent/config — v0.13 MCP/skill ref acceptance', () => {
  it('accepts an MCP tool ref in toolRefs under the default policy', () => {
    const r = makeRegistry()
    r.registerMCP('ext-server', [{
      name: 'search',
      description: 'external search',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    }])
    const cfg = validateSubAgentConfig(
      { name: 'a', ...validBase, toolRefs: ['echo', 'ext-server__search'] },
      r,
    )
    expect(cfg.toolRefs).toEqual(['echo', 'ext-server__search'])
  })

  it('accepts a skill ref in toolRefs under the default policy', () => {
    const r = makeRegistry()
    r.registerSkill({
      name: 'my-skill',
      description: 'a skill',
      execute: async () => 'ok',
    })
    const cfg = validateSubAgentConfig(
      { name: 'a', ...validBase, toolRefs: ['echo', 'my-skill'] },
      r,
    )
    expect(cfg.toolRefs).toEqual(['echo', 'my-skill'])
  })

  it('still rejects a completely unknown ref as Unknown', () => {
    const r = makeRegistry()
    expect(() =>
      validateSubAgentConfig(
        { name: 'a', ...validBase, toolRefs: ['echo', 'nonexistent'] },
        r,
      ),
    ).toThrow('Unknown toolRefs')
  })
})
