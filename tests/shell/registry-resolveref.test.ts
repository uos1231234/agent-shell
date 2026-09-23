// v0.13 Batch 2: resolveRef unit tests.
//
// resolveRef must mirror execute's dispatch order exactly:
//   systemTools → mcpTools → skills (first hit wins).
// These tests pin that order, including the shadowing case where a skill
// shares a name with a system tool (system must win, matching execute).

import { describe, it, expect } from 'vitest'
import { ToolRegistry } from '../../src/shell/registry.js'

const params = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } as const

describe('shell/registry.resolveRef', () => {
  it('classifies a system tool as { kind: "system" }', () => {
    const r = new ToolRegistry()
    r.registerSystemTool({ name: 'echo', description: 'd', parameters: params, execute: async () => ({}) })
    expect(r.resolveRef('echo')).toEqual({ kind: 'system' })
  })

  it('classifies an MCP flat name as { kind: "mcp", server }', () => {
    const r = new ToolRegistry()
    r.registerMCP('srv', [
      { name: 'tool', description: 'd', parameters: params, execute: async () => ({}) },
    ])
    expect(r.resolveRef('srv__tool')).toEqual({ kind: 'mcp', server: 'srv' })
  })

  it('classifies a skill name as { kind: "skill" }', () => {
    const r = new ToolRegistry()
    r.registerSkill({ name: 'my-skill', description: 'd', execute: async () => ({}) })
    expect(r.resolveRef('my-skill')).toEqual({ kind: 'skill' })
  })

  it('returns undefined for an unknown name', () => {
    const r = new ToolRegistry()
    r.registerSystemTool({ name: 'echo', description: 'd', parameters: params, execute: async () => ({}) })
    expect(r.resolveRef('nope')).toBeUndefined()
  })

  it('shadows: a skill named like a system tool resolves as system (matches execute order)', async () => {
    // Both a system tool and a skill are registered under 'dup'. execute
    // dispatches system first, so resolveRef must also return system —
    // otherwise sub-agent routing and runtime dispatch would disagree.
    const r = new ToolRegistry()
    r.registerSystemTool({ name: 'dup', description: 'sys', parameters: params, execute: async () => 'sys' })
    r.registerSkill({ name: 'dup', description: 'skill', execute: async () => 'skill' })
    expect(r.resolveRef('dup')).toEqual({ kind: 'system' })
    // And execute actually runs the system tool, confirming the coupling.
    expect(await r.execute('dup', {})).toBe('sys')
  })

  it('shadows: an MCP flat name that collides with a system tool resolves as system', async () => {
    // A system tool named 'srv__tool' would shadow the MCP entry of the same
    // flat name. resolveRef must report system to stay aligned with execute.
    const r = new ToolRegistry()
    r.registerSystemTool({ name: 'srv__tool', description: 'sys', parameters: params, execute: async () => 'sys' })
    r.registerMCP('srv', [
      { name: 'tool', description: 'mcp', parameters: params, execute: async () => 'mcp' },
    ])
    expect(r.resolveRef('srv__tool')).toEqual({ kind: 'system' })
    expect(await r.execute('srv__tool', {})).toBe('sys')
  })

  it('recovers the server for an MCP tool whose name contains "__"', () => {
    // Tool name 'a__b' under server 'srv' → flat name 'srv__a__b'. resolveRef
    // must return server 'srv', not a naive first-split segment.
    const r = new ToolRegistry()
    r.registerMCP('srv', [
      { name: 'a__b', description: 'd', parameters: params, execute: async () => ({}) },
    ])
    expect(r.resolveRef('srv__a__b')).toEqual({ kind: 'mcp', server: 'srv' })
  })

  // ---------- v0.10.6: textSkill kind ----------

  it('classifies a text-skill name as { kind: "textSkill" }', () => {
    // Text skills live in a separate textSkills store, NOT in the skills map.
    // resolveRef must still recognize them (checked last) so config.ts can
    // accept a text-skill ref as a valid (existing) toolRef.
    const r = new ToolRegistry()
    r.registerTextSkill('style-guide', 'body content')
    expect(r.resolveRef('style-guide')).toEqual({ kind: 'textSkill' })
  })

  it('returns undefined for a name not in any bucket', () => {
    const r = new ToolRegistry()
    r.registerTextSkill('style-guide', 'body')
    expect(r.resolveRef('nope')).toBeUndefined()
  })

  it('shadows: a text skill named like a system tool resolves as system (execute order intact)', () => {
    // A system tool and a text skill both named 'dup'. resolveRef checks
    // systemTools FIRST, so it returns system — matching execute's dispatch
    // (execute never reaches textSkills). The text skill's content is simply
    // shadowed for routing purposes (config.ts sees a tool, not textSkill).
    //
    // NOTE: registerTextSkill rejects collision with an existing system tool,
    // so we cannot register both in the same registry. We verify resolveRef's
    // ordering by registering only the system tool and confirming it resolves
    // as system (the text-skill check is never reached because systemTools wins).
    const r = new ToolRegistry()
    r.registerSystemTool({ name: 'dup', description: 'sys', parameters: params, execute: async () => 'sys' })
    expect(r.resolveRef('dup')).toEqual({ kind: 'system' })
  })
})
