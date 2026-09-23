// v0.14 P1-1: mintTurnId uses crypto.randomUUID() (collision-free) instead
// of Math.random().toString(36) (6 chars of base36 entropy → birthday-paradox
// collisions in large tool batches). Tests verify uniqueness across 10k
// calls, the prefix format, and UUIDv4 structure.

import { describe, it, expect } from 'vitest'
import { mintTurnId } from '../../src/im/turn.js'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('im/turn — mintTurnId (v0.14 P1-1)', () => {
  it('returns a string with the prefix followed by a UUID', () => {
    const id = mintTurnId('tool-tc-1')
    expect(id.startsWith('tool-tc-1-')).toBe(true)
    // The suffix after the prefix + '-' is a UUIDv4.
    const uuid = id.slice('tool-tc-1-'.length)
    expect(uuid).toMatch(UUID_V4)
  })

  it('preserves arbitrary prefixes', () => {
    for (const prefix of ['tool', 'assistant-3', 'sys-warehouse-in', 'a-b-c']) {
      const id = mintTurnId(prefix)
      expect(id.startsWith(`${prefix}-`)).toBe(true)
    }
  })

  it('produces unique ids across 10k calls', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 10_000; i++) {
      ids.add(mintTurnId('tool'))
    }
    expect(ids.size).toBe(10_000)
  })

  it('every id in a 10k batch matches the prefix + UUIDv4 pattern', () => {
    for (let i = 0; i < 10_000; i++) {
      const id = mintTurnId('assistant-1')
      const uuid = id.slice('assistant-1-'.length)
      expect(uuid).toMatch(UUID_V4)
    }
  })

  it('two calls with the same prefix differ in the UUID portion', () => {
    const a = mintTurnId('x')
    const b = mintTurnId('x')
    expect(a).not.toBe(b)
  })
})
