import { describe, it, expect } from 'vitest'
import { Databus } from '../../src/im/databus.js'
import type { ToolTurn } from '../../src/im/databus.js'

const toolTurn = (overrides: Partial<ToolTurn> = {}): ToolTurn => ({
  id: 't1',
  role: 'tool',
  toolCallId: 'tc-1',
  content: 'result',
  sourceAgentId: 'main',
  at: 1,
  ...overrides,
})

describe('im/databus', () => {
  it('appends and reads tool turns in insertion order', () => {
    const d = new Databus()
    d.append(toolTurn({ id: 't1', toolCallId: 'tc-1', content: 'first', at: 1 }))
    d.append(toolTurn({ id: 't2', toolCallId: 'tc-2', content: 'second', at: 2 }))
    expect(d.turns()).toHaveLength(2)
    expect(d.turns()[0]).toMatchObject({ id: 't1', role: 'tool', content: 'first' })
    expect(d.turns()[1]).toMatchObject({ id: 't2', role: 'tool', content: 'second' })
  })

  it('returns an empty list before any append', () => {
    const d = new Databus()
    expect(d.turns()).toEqual([])
  })

  it('turns() returns a live read-only view of the internal store', () => {
    const d = new Databus()
    d.append(toolTurn({ id: 't1', at: 1 }))
    const view = d.turns()
    d.append(toolTurn({ id: 't2', at: 2 }))
    expect(view.length).toBe(2)
    expect(d.turns().length).toBe(2)
  })

  it('rejects role: "user" at compile time (role-bounded to tool)', () => {
    const d = new Databus()
    // @ts-expect-error role 'user' is not assignable to ToolTurn
    d.append({ id: 'u1', role: 'user', content: 'hi', at: 1 })
  })

  describe('query', () => {
    it('filters by sourceAgentIds', () => {
      const d = new Databus()
      d.append(toolTurn({ id: 't1', sourceAgentId: 'main', at: 10 }))
      d.append(toolTurn({ id: 't2', sourceAgentId: 'warehouse', at: 20 }))
      d.append(toolTurn({ id: 't3', sourceAgentId: 'main', at: 30 }))
      const result = d.query({ sourceAgentIds: ['main'] })
      expect(result).toHaveLength(2)
      expect(result.every(t => t.sourceAgentId === 'main')).toBe(true)
    })

    it('filters by time range', () => {
      const d = new Databus()
      d.append(toolTurn({ id: 't1', at: 100 }))
      d.append(toolTurn({ id: 't2', at: 200 }))
      d.append(toolTurn({ id: 't3', at: 300 }))
      const result = d.query({ range: [150, 250] })
      expect(result).toHaveLength(1)
      expect(result[0]!.id).toBe('t2')
    })

    it('returns the most recent N with limit', () => {
      const d = new Databus()
      for (let i = 1; i <= 5; i++) {
        d.append(toolTurn({ id: `t${i}`, at: i * 10 }))
      }
      const result = d.query({ limit: 2 })
      expect(result).toHaveLength(2)
      expect(result[0]!.id).toBe('t4')
      expect(result[1]!.id).toBe('t5')
    })

    it('combines sourceAgentIds + limit', () => {
      const d = new Databus()
      d.append(toolTurn({ id: 't1', sourceAgentId: 'main', at: 10 }))
      d.append(toolTurn({ id: 't2', sourceAgentId: 'warehouse', at: 20 }))
      d.append(toolTurn({ id: 't3', sourceAgentId: 'main', at: 30 }))
      d.append(toolTurn({ id: 't4', sourceAgentId: 'main', at: 40 }))
      const result = d.query({ sourceAgentIds: ['main'], limit: 1 })
      expect(result).toHaveLength(1)
      expect(result[0]!.id).toBe('t4')
    })
  })

  describe('evictByIds (v0.10.4)', () => {
    it('removes only the entries whose id is in the set', () => {
      const d = new Databus()
      d.append(toolTurn({ id: 't1', at: 1 }))
      d.append(toolTurn({ id: 't2', at: 2 }))
      d.append(toolTurn({ id: 't3', at: 3 }))
      const removed = d.evictByIds(['t1', 't3'])
      expect(removed).toBe(2)
      expect(d.turns().map(t => t.id)).toEqual(['t2'])
    })

    it('leaves unrelated agent turns intact', () => {
      const d = new Databus()
      d.append(toolTurn({ id: 't1', sourceAgentId: 'main', at: 1 }))
      d.append(toolTurn({ id: 't2', sourceAgentId: 'warehouse', at: 2 }))
      d.append(toolTurn({ id: 't3', sourceAgentId: 'main', at: 3 }))
      d.evictByIds(['t1'])
      expect(d.turns().map(t => t.id)).toEqual(['t2', 't3'])
    })

    it('returns 0 and makes no change for unknown ids', () => {
      const d = new Databus()
      d.append(toolTurn({ id: 't1', at: 1 }))
      const removed = d.evictByIds(['nope'])
      expect(removed).toBe(0)
      expect(d.turns()).toHaveLength(1)
    })

    it('handles empty id list as a no-op', () => {
      const d = new Databus()
      d.append(toolTurn({ id: 't1', at: 1 }))
      expect(d.evictByIds([])).toBe(0)
      expect(d.turns()).toHaveLength(1)
    })
  })

  describe('subscribe', () => {
    it('calls subscriber on append when sourceAgentId matches', () => {
      const d = new Databus()
      const received: ToolTurn[] = []
      d.subscribe('main', (t) => received.push(t))
      d.append(toolTurn({ id: 't1', sourceAgentId: 'main', at: 1 }))
      expect(received).toHaveLength(1)
      expect(received[0]!.id).toBe('t1')
    })

    it('does NOT call subscriber when sourceAgentId differs', () => {
      const d = new Databus()
      const received: ToolTurn[] = []
      d.subscribe('main', (t) => received.push(t))
      d.append(toolTurn({ id: 't1', sourceAgentId: 'warehouse', at: 1 }))
      expect(received).toHaveLength(0)
    })

    it('unsubscribe stops further callbacks', () => {
      const d = new Databus()
      const received: ToolTurn[] = []
      const unsub = d.subscribe('main', (t) => received.push(t))
      d.append(toolTurn({ id: 't1', sourceAgentId: 'main', at: 1 }))
      unsub()
      d.append(toolTurn({ id: 't2', sourceAgentId: 'main', at: 2 }))
      expect(received).toHaveLength(1)
    })

    it('wildcard "*" receives events from any sourceAgentId', () => {
      const d = new Databus()
      const received: ToolTurn[] = []
      d.subscribe('*', (t) => received.push(t))
      d.append(toolTurn({ id: 't1', sourceAgentId: 'main', at: 1 }))
      d.append(toolTurn({ id: 't2', sourceAgentId: 'warehouse', at: 2 }))
      d.append(toolTurn({ id: 't3', sourceAgentId: 'recall', at: 3 }))
      expect(received).toHaveLength(3)
    })

    it('wildcard unsubscribe stops further callbacks', () => {
      const d = new Databus()
      const received: ToolTurn[] = []
      const unsub = d.subscribe('*', (t) => received.push(t))
      d.append(toolTurn({ id: 't1', sourceAgentId: 'main', at: 1 }))
      unsub()
      d.append(toolTurn({ id: 't2', sourceAgentId: 'warehouse', at: 2 }))
      expect(received).toHaveLength(1)
    })
  })
})
