// v0.17 SessionBusRegistry tests: per-session databus ownership.

import { describe, it, expect } from 'vitest'
import { SessionBusRegistry } from '../../../src/im/session/bus-registry.js'
import { Databus, type ToolTurn } from '../../../src/im/databus.js'

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

describe('im/session/bus-registry', () => {
  it('registerSession → getSession returns the buses', () => {
    const reg = new SessionBusRegistry()
    const own = new Databus()
    const family = new Databus()
    reg.registerSession('s1', { own, family })
    const got = reg.getSession('s1')
    expect(got).toBeDefined()
    expect(got!.own).toBe(own)
    expect(got!.family).toBe(family)
  })

  it('registerSession throws on duplicate', () => {
    const reg = new SessionBusRegistry()
    const buses = { own: new Databus(), family: new Databus() }
    reg.registerSession('s1', buses)
    expect(() => reg.registerSession('s1', buses)).toThrow(/already registered/)
  })

  it('getSession returns undefined for unknown session', () => {
    const reg = new SessionBusRegistry()
    expect(reg.getSession('nope')).toBeUndefined()
  })

  it('getOrCreateSession lazily creates a default pair on first call', () => {
    const reg = new SessionBusRegistry()
    expect(reg.getSession('s1')).toBeUndefined()
    const buses = reg.getOrCreateSession('s1')
    expect(buses).toBeDefined()
    expect(buses.own).toBeInstanceOf(Databus)
    expect(buses.family).toBeInstanceOf(Databus)
    // second call returns the same pair
    expect(reg.getOrCreateSession('s1')).toBe(buses)
  })

  it('registerOrUpdate is idempotent and replaces', () => {
    const reg = new SessionBusRegistry()
    const a = { own: new Databus(), family: new Databus() }
    const b = { own: new Databus(), family: new Databus() }
    reg.registerOrUpdate('s1', a)
    reg.registerOrUpdate('s1', b)
    expect(reg.getSession('s1')).toBe(b)
  })

  it('unregisterSession returns true when existed, false otherwise', () => {
    const reg = new SessionBusRegistry()
    reg.registerSession('s1', { own: new Databus(), family: new Databus() })
    expect(reg.unregisterSession('s1')).toBe(true)
    expect(reg.unregisterSession('s1')).toBe(false)
    expect(reg.getSession('s1')).toBeUndefined()
  })

  it('listSessions returns sorted session ids', () => {
    const reg = new SessionBusRegistry()
    reg.registerSession('zeta', { own: new Databus(), family: new Databus() })
    reg.registerSession('alpha', { own: new Databus(), family: new Databus() })
    reg.registerSession('mid', { own: new Databus(), family: new Databus() })
    expect(reg.listSessions()).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('query merges own+family, sorts by at, dedupes by id', () => {
    const reg = new SessionBusRegistry()
    const own = new Databus()
    const family = new Databus()
    reg.registerSession('s1', { own, family })

    own.append(makeTurn('o1', 'main', 30))
    family.append(makeTurn('f1', 'sub', 10))
    family.append(makeTurn('f2', 'sub', 20))
    // duplicate id present in both buses (a projected seed turn)
    const dup = makeTurn('dup', 'main', 5)
    own.append(dup)
    family.append(dup)

    const result = reg.query('s1')
    const ids = result.map(t => t.id)
    expect(ids).toEqual(['dup', 'f1', 'f2', 'o1'])
  })

  it('query applies sourceAgentIds filter', () => {
    const reg = new SessionBusRegistry()
    const own = new Databus()
    const family = new Databus()
    reg.registerSession('s1', { own, family })

    own.append(makeTurn('o1', 'main', 10))
    family.append(makeTurn('f1', 'helper', 20))
    family.append(makeTurn('f2', 'main', 30))

    const result = reg.query('s1', { sourceAgentIds: ['main'] })
    expect(result.map(t => t.id)).toEqual(['o1', 'f2'])
  })

  it('query applies limit (most recent N)', () => {
    const reg = new SessionBusRegistry()
    const own = new Databus()
    const family = new Databus()
    reg.registerSession('s1', { own, family })

    for (let i = 0; i < 5; i++) {
      own.append(makeTurn(`o${i}`, 'main', i))
      family.append(makeTurn(`f${i}`, 'sub', i + 100))
    }
    const result = reg.query('s1', { limit: 3 })
    expect(result.map(t => t.id)).toEqual(['f2', 'f3', 'f4'])
  })

  it('query returns [] for unknown session', () => {
    const reg = new SessionBusRegistry()
    expect(reg.query('nope')).toEqual([])
  })

  it('subscribe receives events from own bus; unsubscribe stops', () => {
    const reg = new SessionBusRegistry()
    const own = new Databus()
    const family = new Databus()
    reg.registerSession('s1', { own, family })

    const events: ToolTurn[] = []
    const unsub = reg.subscribe('s1', 'main', (t) => events.push(t))

    own.append(makeTurn('o1', 'main', 1))
    family.append(makeTurn('f1', 'sub', 2)) // different agent → not received
    expect(events.map(t => t.id)).toEqual(['o1'])

    unsub()
    own.append(makeTurn('o2', 'main', 3))
    expect(events.map(t => t.id)).toEqual(['o1'])
  })

  it('subscribe with wildcard "*" receives from both buses, deduped', () => {
    const reg = new SessionBusRegistry()
    const own = new Databus()
    const family = new Databus()
    reg.registerSession('s1', { own, family })

    const events: ToolTurn[] = []
    reg.subscribe('s1', '*', (t) => events.push(t))

    own.append(makeTurn('o1', 'main', 1))
    family.append(makeTurn('f1', 'sub', 2))
    // duplicate id in both buses → subscriber sees once
    const dup = makeTurn('dup', 'main', 3)
    own.append(dup)
    family.append(dup)

    expect(events.map(t => t.id)).toEqual(['o1', 'f1', 'dup'])
  })

  it('subscribe on unknown session returns a no-op unsubscribe', () => {
    const reg = new SessionBusRegistry()
    const unsub = reg.subscribe('nope', '*', () => {})
    expect(() => unsub()).not.toThrow()
  })

  it('session isolation: two sessions query independently', () => {
    const reg = new SessionBusRegistry()
    const a = { own: new Databus(), family: new Databus() }
    const b = { own: new Databus(), family: new Databus() }
    reg.registerSession('a', a)
    reg.registerSession('b', b)

    a.own.append(makeTurn('a1', 'main', 1))
    b.own.append(makeTurn('b1', 'main', 2))

    expect(reg.query('a').map(t => t.id)).toEqual(['a1'])
    expect(reg.query('b').map(t => t.id)).toEqual(['b1'])
  })
})
