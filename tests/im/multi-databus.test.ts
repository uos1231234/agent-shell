import { describe, it, expect } from 'vitest'
import { MultiDatabus } from '../../src/im/multi-databus.js'
import { Databus, type ToolTurn } from '../../src/im/databus.js'

const makeTurn = (
  id: string,
  sourceAgentId: string,
  at: number,
  content = '',
): ToolTurn => ({
  id,
  role: 'tool',
  toolCallId: `tc-${id}`,
  content,
  sourceAgentId,
  at,
})

describe('im/multi-databus', () => {
  it('merges turns() from multiple buses sorted by at', () => {
    const a = new Databus()
    const b = new Databus()
    a.append(makeTurn('a1', 'main', 3))
    b.append(makeTurn('b1', 'sub', 1))
    b.append(makeTurn('b2', 'sub', 2))

    const multi = new MultiDatabus([a, b])
    const turns = multi.turns()
    expect(turns.map(t => t.id)).toEqual(['b1', 'b2', 'a1'])
  })

  it('deduplicates turns by id across buses', () => {
    const a = new Databus()
    const b = new Databus()
    // Same id in both buses — happens when a turn is projected into two
    // buses simultaneously (e.g. working agent seed turn).
    const turn = makeTurn('dup', 'main', 5)
    a.append(turn)
    b.append(turn)

    const multi = new MultiDatabus([a, b])
    expect(multi.turns().map(t => t.id)).toEqual(['dup'])
  })

  it('query() filters by sourceAgentIds across all buses', () => {
    const a = new Databus()
    const b = new Databus()
    a.append(makeTurn('a1', 'main', 1))
    a.append(makeTurn('a2', 'helper', 2))
    b.append(makeTurn('b1', 'main', 3))
    b.append(makeTurn('b2', 'reviewer', 4))

    const multi = new MultiDatabus([a, b])
    const result = multi.query({ sourceAgentIds: ['main'] })
    expect(result.map(t => t.id)).toEqual(['a1', 'b1'])
  })

  it('query() applies range filter across all buses', () => {
    const a = new Databus()
    const b = new Databus()
    a.append(makeTurn('a1', 'main', 10))
    b.append(makeTurn('b1', 'main', 20))
    b.append(makeTurn('b2', 'main', 30))

    const multi = new MultiDatabus([a, b])
    const result = multi.query({ range: [15, 25] })
    expect(result.map(t => t.id)).toEqual(['b1'])
  })

  it('query() applies limit after merge+sort', () => {
    const a = new Databus()
    const b = new Databus()
    for (let i = 0; i < 5; i++) {
      a.append(makeTurn(`a${i}`, 'main', i))
      b.append(makeTurn(`b${i}`, 'sub', i + 10))
    }

    const multi = new MultiDatabus([a, b])
    const result = multi.query({ limit: 3 })
    expect(result.map(t => t.id)).toEqual(['b2', 'b3', 'b4'])
  })

  it('query() with no filter returns all merged sorted', () => {
    const a = new Databus()
    const b = new Databus()
    b.append(makeTurn('b1', 'sub', 1))
    a.append(makeTurn('a1', 'main', 2))

    const multi = new MultiDatabus([a, b])
    const result = multi.query()
    expect(result.map(t => t.id)).toEqual(['b1', 'a1'])
  })

  it('subscribe() receives events from all underlying buses', () => {
    const a = new Databus()
    const b = new Databus()
    const multi = new MultiDatabus([a, b])

    const events: ToolTurn[] = []
    multi.subscribe('*', (turn) => events.push(turn))

    a.append(makeTurn('a1', 'main', 1))
    b.append(makeTurn('b1', 'sub', 2))

    expect(events.map(t => t.id)).toEqual(['a1', 'b1'])
  })

  it('subscribe() with specific agentId receives matching events from all buses', () => {
    const a = new Databus()
    const b = new Databus()
    const multi = new MultiDatabus([a, b])

    const events: ToolTurn[] = []
    multi.subscribe('main', (turn) => events.push(turn))

    a.append(makeTurn('a1', 'main', 1))
    b.append(makeTurn('b1', 'sub', 2))
    a.append(makeTurn('a2', 'main', 3))

    expect(events.map(t => t.id)).toEqual(['a1', 'a2'])
  })

  it('subscribe() unsubscribe stops all underlying subscriptions', () => {
    const a = new Databus()
    const b = new Databus()
    const multi = new MultiDatabus([a, b])

    const events: ToolTurn[] = []
    const unsub = multi.subscribe('*', (turn) => events.push(turn))

    a.append(makeTurn('a1', 'main', 1))
    unsub()
    b.append(makeTurn('b1', 'sub', 2))

    expect(events.map(t => t.id)).toEqual(['a1'])
  })

  it('subscribe() deduplicates events by turn id across buses', () => {
    const a = new Databus()
    const b = new Databus()
    const multi = new MultiDatabus([a, b])

    const events: ToolTurn[] = []
    multi.subscribe('*', (turn) => events.push(turn))

    // Same turn appended to both buses — subscriber should only see it once
    const turn = makeTurn('dup-event', 'main', 5)
    a.append(turn)
    b.append(turn)

    expect(events.map(t => t.id)).toEqual(['dup-event'])
  })

  it('evictByIds() removes matching entries from all buses', () => {
    const a = new Databus()
    const b = new Databus()
    a.append(makeTurn('a1', 'main', 1))
    b.append(makeTurn('b1', 'sub', 2))
    a.append(makeTurn('a2', 'main', 3))
    b.append(makeTurn('b2', 'sub', 4))

    const multi = new MultiDatabus([a, b])
    const removed = multi.evictByIds(['a1', 'b2'])

    expect(removed).toBe(2)
    expect(a.turns().map(t => t.id)).toEqual(['a2'])
    expect(b.turns().map(t => t.id)).toEqual(['b1'])
  })

  it('throws when constructed with empty bus array', () => {
    expect(() => new MultiDatabus([])).toThrow('at least one')
  })
})
