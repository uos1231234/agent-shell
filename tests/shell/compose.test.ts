import { describe, it, expect } from 'vitest'
import { compose, type PromptPart } from '../../src/shell/compose.js'
import type { ToolRegistry } from '../../src/shell/registry.js'
import { ToolRegistry as TR } from '../../src/shell/registry.js'
import type { ChatMessage } from '../../src/protocol/types.js'

const echoParams = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } as const

const newRegistry = (): ToolRegistry => {
  const r: ToolRegistry = new TR()
  r.registerSystemTool({ name: 'echo', description: 'echo back', parameters: echoParams, execute: async (a) => a })
  r.registerSkill({ name: 'plan', description: 'plan a task', execute: async () => ({ ok: true }) })
  r.registerMCP('gh', [{ name: 'issue', description: 'create issue', parameters: echoParams, execute: async (a) => a }])
  return r
}

describe('shell/compose', () => {
  it('places system + userTemplate in the first messages, in order', () => {
    const out = compose(newRegistry(), [
      { type: 'system', content: 'SYS' },
      { type: 'userTemplate', content: 'TEMPLATE' },
    ])
    expect(out.messages[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(out.messages[1]).toEqual({ role: 'user', content: 'TEMPLATE' })
  })

  it('appends turn messages in order after the template', () => {
    const t1: ChatMessage = { role: 'user', content: 'hi' }
    const t2: ChatMessage = { role: 'assistant', content: 'hello' }
    const out = compose(newRegistry(), [
      { type: 'system', content: 'SYS' },
      { type: 'userTemplate', content: 'T' },
      { type: 'turn', message: t1 },
      { type: 'turn', message: t2 },
    ])
    expect(out.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'T' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('passes through assistant tool_calls and tool results in turns', () => {
    const t1: ChatMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'echo', arguments: '{"x":"hi"}' } }],
    }
    const t2: ChatMessage = { role: 'tool', tool_call_id: 'tc-1', content: '{"echo":"hi"}' }
    const out = compose(newRegistry(), [
      { type: 'system', content: 'SYS' },
      { type: 'userTemplate', content: 'T' },
      { type: 'turn', message: t1 },
      { type: 'turn', message: t2 },
    ])
    expect(out.messages[2]).toEqual(t1)
    expect(out.messages[3]).toEqual(t2)
  })

  it('resolves systemTool references into the tools array; mcp/skill are now no-ops (v0.18 progressive disclosure)', () => {
    const out = compose(newRegistry(), [
      { type: 'system', content: 'SYS' },
      { type: 'userTemplate', content: 'T' },
      { type: 'systemTool', ref: 'echo' },
      { type: 'mcp', server: 'gh', refs: ['issue'] },
      { type: 'skill', ref: 'plan' },
    ])
    const names = out.tools.map(t => t.function.name).sort()
    // v0.18: mcp/skill parts are no-ops — tools are loaded dynamically via load_tools.
    expect(names).toEqual(['echo'])
  })

  it('ignores a systemTool ref that is not registered (no crash, no entry)', () => {
    const out = compose(newRegistry(), [
      { type: 'system', content: 'SYS' },
      { type: 'userTemplate', content: 'T' },
      { type: 'systemTool', ref: 'nonexistent' },
    ])
    expect(out.tools).toEqual([])
  })

  it('emits an empty tools array when no tool parts are present', () => {
    const out = compose(newRegistry(), [
      { type: 'system', content: 'SYS' },
      { type: 'userTemplate', content: 'T' },
    ])
    expect(out.tools).toEqual([])
  })

  it('emits a single system message even if both system and userTemplate are provided', () => {
    const out = compose(newRegistry(), [
      { type: 'system', content: 'SYS' },
      { type: 'userTemplate', content: 'TEMPLATE' },
    ])
    expect(out.messages.filter(m => m.role === 'system').length).toBe(1)
    expect(out.messages.filter(m => m.role === 'user').length).toBe(1)
  })

  // ---------- v0.10.6: skillText part (pre-injection into system prompt) ----------

  it('skillText appends content to the last system message, separated by \\n\\n', () => {
    const out = compose(newRegistry(), [
      { type: 'system', content: 'BASE SYSTEM' },
      { type: 'userTemplate', content: 'T' },
      { type: 'skillText', content: 'STYLE RULES', skillName: 'style-guide' },
    ])
    // There is still exactly one system message (skillText appends, not inserts).
    const sysMsgs = out.messages.filter((m) => m.role === 'system')
    expect(sysMsgs).toHaveLength(1)
    expect(sysMsgs[0]!.content).toBe('BASE SYSTEM\n\nSTYLE RULES')
  })

  it('skillText creates a new system message when none exists yet', () => {
    // Defensive path: loop.ts always emits a system part first, but compose
    // must still work if the caller omitted it. skillText creates a system
    // message holding just the skill content.
    const out = compose(newRegistry(), [
      { type: 'skillText', content: 'ONLY SKILL', skillName: 'guide' },
      { type: 'userTemplate', content: 'T' },
    ])
    const sysMsgs = out.messages.filter((m) => m.role === 'system')
    expect(sysMsgs).toHaveLength(1)
    expect(sysMsgs[0]!.content).toBe('ONLY SKILL')
  })

  it('multiple skillText parts stack under the same system message in order', () => {
    const out = compose(newRegistry(), [
      { type: 'system', content: 'SYS' },
      { type: 'skillText', content: 'RULES-A', skillName: 'a' },
      { type: 'skillText', content: 'RULES-B', skillName: 'b' },
      { type: 'skillText', content: 'RULES-C', skillName: 'c' },
    ])
    const sysMsgs = out.messages.filter((m) => m.role === 'system')
    expect(sysMsgs).toHaveLength(1)
    expect(sysMsgs[0]!.content).toBe('SYS\n\nRULES-A\n\nRULES-B\n\nRULES-C')
  })

  it('skillText does NOT add an entry to the tools array (pure pre-injection)', () => {
    const out = compose(newRegistry(), [
      { type: 'system', content: 'SYS' },
      { type: 'skillText', content: 'BODY', skillName: 'style-guide' },
    ])
    expect(out.tools).toEqual([])
  })

  it('skillText after turns appends to the earlier system message (not a turn neighbor)', () => {
    // The system message was already created before the turns; skillText
    // finds it by scanning backwards and appends to it. It must NOT create a
    // new system message between turns.
    const out = compose(newRegistry(), [
      { type: 'system', content: 'SYS' },
      { type: 'userTemplate', content: 'T' },
      { type: 'turn', message: { role: 'user', content: 'hi' } },
      { type: 'skillText', content: 'LATE SKILL', skillName: 'guide' },
    ])
    const sysMsgs = out.messages.filter((m) => m.role === 'system')
    expect(sysMsgs).toHaveLength(1)
    expect(sysMsgs[0]!.content).toBe('SYS\n\nLATE SKILL')
    // The skillText did not insert a new message between turns.
    expect(out.messages.map((m) => m.role)).toEqual(['system', 'user', 'user'])
  })
})
