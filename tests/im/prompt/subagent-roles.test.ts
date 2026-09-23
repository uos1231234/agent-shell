// Tests for built-in sub-agent roles — v0.38
//
// Verifies the out-of-the-box roles register against a real registry, that the
// explore role is truly read-only (whitelist), and that the editor role can
// hold the writer tools — which requires its policy override to work, since the
// default policy denies write / edit.

import { describe, it, expect } from 'vitest'
import type { ToolRegistry } from '../../../src/shell/registry.js'
import { createBuiltinTools } from '../../../src/im/tools/index.js'
import { BUILTIN_SUB_AGENT_CONFIGS, ROLE_TOOL_REFS } from '../../../src/im/prompt/subagent-roles.js'
import { SubAgentRegistry } from '../../../src/im/sub-agent/index.js'

const mockRegistry = (): ToolRegistry => {
  const builtin = createBuiltinTools({ cwd: process.cwd(), dataDir: process.cwd() })
  return builtin as unknown as ToolRegistry
}

describe('ROLE_TOOL_REFS', () => {
  it('explore holds only read-only tools and no shell or writer', () => {
    const refs = new Set<string>(ROLE_TOOL_REFS.explore)
    for (const r of refs) {
      expect(/^(read|ls|find|grep|ast_grep)$/.test(r), `${r} should be read-only`).toBe(true)
    }
    // The two-layered read-only guarantee: the whitelist must not contain bash
    // or any writer, because with bash granted the whitelist would not be a
    // guarantee (bash can delete anything).
    expect(refs.has('bash')).toBe(false)
    expect(refs.has('powershell')).toBe(false)
    expect(refs.has('write')).toBe(false)
    expect(refs.has('edit')).toBe(false)
    expect(refs.has('search_replace')).toBe(false)
  })

  it('editor holds read + the writer tools', () => {
    const refs = new Set<string>(ROLE_TOOL_REFS.editor)
    expect(refs.has('write')).toBe(true)
    expect(refs.has('edit')).toBe(true)
    expect(refs.has('search_replace')).toBe(true)
  })
})

describe('BUILTIN_SUB_AGENT_CONFIGS', () => {
  it('contains explore and editor with matching prompts', () => {
    const names = BUILTIN_SUB_AGENT_CONFIGS.map((c) => c.name)
    expect(names).toContain('explore')
    expect(names).toContain('editor')
    const explore = BUILTIN_SUB_AGENT_CONFIGS.find((c) => c.name === 'explore')!
    const editor = BUILTIN_SUB_AGENT_CONFIGS.find((c) => c.name === 'editor')!
    expect(explore.systemPrompt).toContain('code-search specialist')
    expect(explore.systemPrompt).toContain('read-only')
    expect(editor.systemPrompt).toContain('implementation sub-agent')
  })

  it('editor carries an EDITOR policy override, explore does not', () => {
    const explore = BUILTIN_SUB_AGENT_CONFIGS.find((c) => c.name === 'explore')!
    const editor = BUILTIN_SUB_AGENT_CONFIGS.find((c) => c.name === 'editor')!
    expect(explore.toolPolicy).toBeUndefined()
    expect(editor.toolPolicy).toBeDefined()
  })
})

describe('registration against a real registry', () => {
  it('registers both built-in roles including the editor (policy override works)', async () => {
    const registry = mockRegistry()
    const sub = new SubAgentRegistry({ registry })
    for (const cfg of BUILTIN_SUB_AGENT_CONFIGS) {
      await sub.register({
        name: cfg.name,
        systemPrompt: cfg.systemPrompt,
        toolRefs: [...cfg.toolRefs],
        ...(cfg.toolPolicy !== undefined ? { toolPolicy: cfg.toolPolicy } : {}),
      })
    }
    // If the editor policy override failed, the editor toolRefs (write/edit)
    // would have been rejected by the default policy at registration.
    const names = sub.list()
    expect(names).toEqual(['editor', 'explore'])
    expect(sub.get('editor')).toBeDefined()
    expect(sub.get('explore')).toBeDefined()
  })
})