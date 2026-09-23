import { describe, it, expect } from 'vitest'
import { turnToMessage, appendCanonicalTurn } from '../../src/im/turn.js'
import { ConversationMemory } from '../../src/im/conversation-memory.js'
import { Databus } from '../../src/im/databus.js'

describe('im/turn', () => {
  it('user turn → user message', () => {
    expect(turnToMessage({ id: 't1', role: 'user', content: 'hi', at: 1 }))
      .toEqual({ role: 'user', content: 'hi' })
  })

  it('assistant turn with text → assistant message with content', () => {
    expect(turnToMessage({ id: 't1', role: 'assistant', content: 'hello', at: 1 }))
      .toEqual({ role: 'assistant', content: 'hello' })
  })

  it('assistant turn with tool_calls → assistant message with content and tool_calls', () => {
    const t = {
      id: 'a1',
      role: 'assistant' as const,
      content: 'I will read.',
      toolCalls: [{ id: 'tc-1', type: 'function' as const, function: { name: 'echo', arguments: '{}' } }],
      at: 1,
    }
    expect(turnToMessage(t)).toEqual({
      role: 'assistant',
      content: 'I will read.',
      tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'echo', arguments: '{}' } }],
    })
  })

  it('tool turn → tool message with tool_call_id', () => {
    expect(turnToMessage({ id: 'r1', role: 'tool', toolCallId: 'tc-1', content: '{"ok":true}', sourceAgentId: 'main', at: 1 }))
      .toEqual({ role: 'tool', tool_call_id: 'tc-1', content: '{"ok":true}' })
  })

  describe('appendCanonicalTurn (v0.10.4)', () => {
    it('appends user/assistant turns to conversation only, not databus', () => {
      const conv = new ConversationMemory()
      const db = new Databus()
      appendCanonicalTurn(conv, db, { id: 'u1', role: 'user', content: 'hi', at: 1 })
      appendCanonicalTurn(conv, db, { id: 'a1', role: 'assistant', content: 'hello', at: 2 })

      expect(conv.turns().map(t => t.id)).toEqual(['u1', 'a1'])
      expect(db.turns()).toHaveLength(0)
    })

    it('appends tool turns to both conversation and databus', () => {
      const conv = new ConversationMemory()
      const db = new Databus()
      appendCanonicalTurn(conv, db, { id: 'u1', role: 'user', content: 'go', at: 1 })
      appendCanonicalTurn(conv, db, { id: 'a1', role: 'assistant', content: null, toolCalls: [{ id: 'tc-1', type: 'function', function: { name: 'echo', arguments: '{}' } }], at: 2 })
      appendCanonicalTurn(conv, db, { id: 't1', role: 'tool', toolCallId: 'tc-1', content: 'result', sourceAgentId: 'main', at: 3 })
      appendCanonicalTurn(conv, db, { id: 'a2', role: 'assistant', content: 'done', at: 4 })

      // Canonical has all 4 turns in order
      expect(conv.turns().map(t => t.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
      // Databus has only the tool projection
      expect(db.turns().map(t => t.id)).toEqual(['t1'])
    })
  })
})
