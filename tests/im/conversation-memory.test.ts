import { describe, it, expect } from 'vitest'
import { ConversationMemory } from '../../src/im/conversation-memory.js'
import type { ConversationTurn } from '../../src/im/conversation-memory.js'

describe('im/conversation-memory', () => {
  it('appends and reads user/assistant turns in insertion order', () => {
    const cm = new ConversationMemory()
    const userTurn: ConversationTurn = { id: 'u1', role: 'user', content: 'hi', at: 1 }
    const assistantTurn: ConversationTurn = { id: 'a1', role: 'assistant', content: 'hello', at: 2 }
    cm.append(userTurn)
    cm.append(assistantTurn)
    expect(cm.turns()).toHaveLength(2)
    expect(cm.turns()[0]).toMatchObject({ role: 'user', content: 'hi' })
    expect(cm.turns()[1]).toMatchObject({ role: 'assistant', content: 'hello' })
  })

  it('returns an empty list before any append', () => {
    const cm = new ConversationMemory()
    expect(cm.turns()).toEqual([])
  })

  it('last() returns the most recent turn', () => {
    const cm = new ConversationMemory()
    cm.append({ id: 'u1', role: 'user', content: 'first', at: 1 })
    cm.append({ id: 'a1', role: 'assistant', content: 'second', at: 2 })
    expect(cm.last()).toMatchObject({ id: 'a1', role: 'assistant', content: 'second' })
  })

  it('last() returns undefined when empty', () => {
    const cm = new ConversationMemory()
    expect(cm.last()).toBeUndefined()
  })

  it('accepts tool turns in the canonical sequence (v0.10.4)', () => {
    const cm = new ConversationMemory()
    cm.append({ id: 'u1', role: 'user', content: 'do something', at: 1 })
    cm.append({ id: 'a1', role: 'assistant', content: null, toolCalls: [{ id: 'tc-1', type: 'function', function: { name: 'echo', arguments: '{}' } }], at: 2 })
    cm.append({ id: 't1', role: 'tool', toolCallId: 'tc-1', content: 'result', sourceAgentId: 'main', at: 3 })
    cm.append({ id: 'a2', role: 'assistant', content: 'done', at: 4 })

    expect(cm.turns()).toHaveLength(4)
    expect(cm.turns()[2]).toMatchObject({ role: 'tool', toolCallId: 'tc-1', content: 'result' })
    expect(cm.turns()[3]).toMatchObject({ role: 'assistant', content: 'done' })
  })

  describe('evictRange (v0.10.4)', () => {
    it('removes exactly the half-open range and returns removed turns', () => {
      const cm = new ConversationMemory()
      cm.append({ id: 'u1', role: 'user', content: 'first task', at: 1 })
      cm.append({ id: 'a1', role: 'assistant', content: 'reply', at: 2 })
      cm.append({ id: 't1', role: 'tool', toolCallId: 'tc-1', content: 'r1', sourceAgentId: 'main', at: 3 })
      cm.append({ id: 'a2', role: 'assistant', content: 'done', at: 4 })
      cm.append({ id: 'u2', role: 'user', content: 'second task', at: 5 })
      cm.append({ id: 'a3', role: 'assistant', content: 'reply2', at: 6 })

      // Evict indices 0..4 (u1 through a2, leaving u2 + a3)
      const removed = cm.evictRange(0, 4)
      expect(removed).toHaveLength(4)
      expect(removed[0]).toMatchObject({ id: 'u1' })
      expect(removed[3]).toMatchObject({ id: 'a2' })

      const remaining = cm.turns()
      expect(remaining).toHaveLength(2)
      expect(remaining[0]).toMatchObject({ id: 'u2' })
      expect(remaining[1]).toMatchObject({ id: 'a3' })
    })

    it('evicts a middle range, leaving the outer turns intact', () => {
      const cm = new ConversationMemory()
      cm.append({ id: 'u1', role: 'user', content: 'first', at: 1 })
      cm.append({ id: 'a1', role: 'assistant', content: 'r1', at: 2 })
      cm.append({ id: 't1', role: 'tool', toolCallId: 'tc-1', content: 'tr', sourceAgentId: 'main', at: 3 })
      cm.append({ id: 'a2', role: 'assistant', content: 'r2', at: 4 })
      cm.append({ id: 'u2', role: 'user', content: 'second', at: 5 })

      // Evict indices 1..4 (a1, t1, a2)
      const removed = cm.evictRange(1, 4)
      expect(removed.map(t => t.id)).toEqual(['a1', 't1', 'a2'])
      expect(cm.turns().map(t => t.id)).toEqual(['u1', 'u2'])
    })

    it('returns empty array and makes no change for a zero-width range', () => {
      const cm = new ConversationMemory()
      cm.append({ id: 'u1', role: 'user', content: 'x', at: 1 })
      const removed = cm.evictRange(0, 0)
      expect(removed).toEqual([])
      expect(cm.turns()).toHaveLength(1)
    })

    it('evicts the entire sequence with 0..length', () => {
      const cm = new ConversationMemory()
      cm.append({ id: 'u1', role: 'user', content: 'x', at: 1 })
      cm.append({ id: 'a1', role: 'assistant', content: 'y', at: 2 })
      const removed = cm.evictRange(0, 2)
      expect(removed).toHaveLength(2)
      expect(cm.turns()).toEqual([])
      expect(cm.last()).toBeUndefined()
    })
  })

  describe('replaceRange (handoff-note compaction foundation)', () => {
    it('replaces a middle range in place, preserving surrounding order', () => {
      const cm = new ConversationMemory()
      cm.append({ id: 'u1', role: 'user', content: 'first', at: 1 })
      cm.append({ id: 'a1', role: 'assistant', content: 'r1', at: 2 })
      cm.append({ id: 't1', role: 'tool', toolCallId: 'tc-1', content: 'tr', sourceAgentId: 'main', at: 3 })
      cm.append({ id: 'a2', role: 'assistant', content: 'r2', at: 4 })
      cm.append({ id: 'u2', role: 'user', content: 'second', at: 5 })

      const note = { id: 'note-1', role: 'user' as const, content: '（历史摘要）…', at: 6 }
      const removed = cm.replaceRange(1, 4, [note])
      expect(removed.map(t => t.id)).toEqual(['a1', 't1', 'a2'])
      expect(cm.turns().map(t => t.id)).toEqual(['u1', 'note-1', 'u2'])
    })

    it('replaces a range with multiple turns', () => {
      const cm = new ConversationMemory()
      cm.append({ id: 'u1', role: 'user', content: 'first', at: 1 })
      cm.append({ id: 'a1', role: 'assistant', content: 'r1', at: 2 })
      cm.append({ id: 'u2', role: 'user', content: 'second', at: 3 })

      const a = { id: 'n1', role: 'user' as const, content: 'a', at: 4 }
      const b = { id: 'n2', role: 'user' as const, content: 'b', at: 5 }
      const removed = cm.replaceRange(0, 1, [a, b])
      expect(removed.map(t => t.id)).toEqual(['u1'])
      expect(cm.turns().map(t => t.id)).toEqual(['n1', 'n2', 'a1', 'u2'])
    })

    it('supports empty replacement (degenerate to evictRange semantics)', () => {
      const cm = new ConversationMemory()
      cm.append({ id: 'u1', role: 'user', content: 'x', at: 1 })
      cm.append({ id: 'a1', role: 'assistant', content: 'y', at: 2 })
      const removed = cm.replaceRange(0, 1, [])
      expect(removed.map(t => t.id)).toEqual(['u1'])
      expect(cm.turns().map(t => t.id)).toEqual(['a1'])
    })

    it('zero-width range inserts without removing anything', () => {
      const cm = new ConversationMemory()
      cm.append({ id: 'u1', role: 'user', content: 'x', at: 1 })
      const note = { id: 'n1', role: 'user' as const, content: 'note', at: 2 }
      const removed = cm.replaceRange(0, 0, [note])
      expect(removed).toEqual([])
      expect(cm.turns().map(t => t.id)).toEqual(['n1', 'u1'])
    })
  })
})
