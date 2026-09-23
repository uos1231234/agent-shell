import { describe, it, expect } from 'vitest'
import {
  runGuards,
  type GuardId,
  type GuardHit,
} from '../../src/shell/guards.js'
import { createMetrics, type Metrics } from '../../src/shell/metrics.js'
import { createConfig, type ShellConfig } from '../../src/shell/config.js'
import { advanceElapsed } from '../../src/im/loop.js'

const at = (m: Partial<Metrics>): Metrics => ({ ...createMetrics(), ...m })
const cfg = (c: Partial<ShellConfig>): ShellConfig => createConfig(c)

describe('shell/guards', () => {
  describe('tokenGuard', () => {
    it('trips when lastRequestTokens > maxTokens', () => {
      const hits = runGuards(at({ lastRequestTokens: 1001 }), cfg({ maxTokens: 1000 }))
      expect(hits.find(h => h.id === 'token')).toBeDefined()
    })

    it('does NOT trip when lastRequestTokens === maxTokens (strict greater-than)', () => {
      const hits = runGuards(at({ lastRequestTokens: 1000 }), cfg({ maxTokens: 1000 }))
      expect(hits.find(h => h.id === 'token')).toBeUndefined()
    })

    it('does NOT trip on cumulative totalTokens — only lastRequestTokens matters', () => {
      // 5M cumulative but lastRequestTokens within budget → no trip
      const hits = runGuards(at({ totalTokens: 5_000_000, lastRequestTokens: 500 }), cfg({ maxTokens: 1_000_000 }))
      expect(hits.find(h => h.id === 'token')).toBeUndefined()
    })
  })

  describe('iterGuard', () => {
    it('trips when stepCount > maxSteps', () => {
      const hits = runGuards(at({ stepCount: 6 }), cfg({ maxSteps: 5 }))
      expect(hits.find(h => h.id === 'iter')).toBeDefined()
    })
  })

  describe('toolRateGuard', () => {
    it('trips when toolCallCount > maxToolCalls (default 1000)', () => {
      const hits = runGuards(at({ toolCallCount: 1001 }), cfg({}))
      expect(hits.find(h => h.id === 'toolRate')).toBeDefined()
    })

    it('respects custom maxToolCalls', () => {
      const hits = runGuards(at({ toolCallCount: 6 }), cfg({ maxToolCalls: 5 }))
      expect(hits.find(h => h.id === 'toolRate')).toBeDefined()
    })
  })

  describe('timeGuard', () => {
    it('trips when elapsedMs > maxElapsedMs', () => {
      const hits = runGuards(at({ elapsedMs: 1001 }), cfg({ maxElapsedMs: 1000 }))
      expect(hits.find(h => h.id === 'time')).toBeDefined()
    })

    it('does NOT trip when elapsedMs === maxElapsedMs (strict greater-than)', () => {
      const hits = runGuards(at({ elapsedMs: 1000 }), cfg({ maxElapsedMs: 1000 }))
      expect(hits.find(h => h.id === 'time')).toBeUndefined()
    })

    it('is reachable from the IM loop via advanceElapsed — regression pin', () => {
      // ADR-009: every guard must be reachable on the happy path. The
      // time guard is a special case because its metric (elapsedMs) has
      // a wall-clock producer in the IM loop, not in the shell.
      // This test imports `advanceElapsed` and verifies the producer
      // actually advances the metric, so the time guard stays
      // reachable. If a refactor drops the producer, this test fails
      // even before the time guard test above would catch the symptom.
      const start = 1_000_000
      const m1 = advanceElapsed(at({}), start, start + 50)
      expect(m1.elapsedMs).toBe(50)
      const m2 = advanceElapsed(m1, start, start + 60_001)
      const hits = runGuards(m2, cfg({ maxElapsedMs: 60_000 }))
      expect(hits.find(h => h.id === 'time')).toBeDefined()
    })
  })

  describe('errorRateGuard', () => {
    it('trips when consecutiveToolErrors > maxConsecutiveToolErrors', () => {
      const hits = runGuards(at({ consecutiveToolErrors: 6 }), cfg({ maxConsecutiveToolErrors: 5 }))
      expect(hits.find(h => h.id === 'errorRate')).toBeDefined()
    })
  })

  describe('multiple guards', () => {
    it('returns all tripped guards, not just the first', () => {
      const hits = runGuards(
        at({ lastRequestTokens: 9999, stepCount: 9999, toolCallCount: 9999 }),
        cfg({ maxTokens: 100, maxSteps: 100, maxToolCalls: 100 }),
      )
      const ids = new Set(hits.map(h => h.id))
      expect(ids.has('token')).toBe(true)
      expect(ids.has('iter')).toBe(true)
      expect(ids.has('toolRate')).toBe(true)
    })

    it('returns empty array when no guard is tripped', () => {
      const hits = runGuards(at({ lastRequestTokens: 50, stepCount: 5, toolCallCount: 50 }), cfg({}))
      expect(hits).toEqual([])
    })
  })

  it('hit objects carry the guard id and a descriptive reason', () => {
    const hits: GuardHit[] = runGuards(at({ lastRequestTokens: 9999 }), cfg({ maxTokens: 100 }))
    const token = hits.find(h => h.id === 'token')
    expect(token).toBeDefined()
    expect(token!.reason).toMatch(/token/i)
  })
})
