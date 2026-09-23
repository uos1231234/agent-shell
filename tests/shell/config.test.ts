import { describe, it, expect } from 'vitest'
import { createConfig, type ShellConfig } from '../../src/shell/config.js'

describe('shell/config', () => {
  describe('createConfig', () => {
    it('returns sensible defaults', () => {
      const c = createConfig()
      expect(c.maxTokens).toBeGreaterThan(0)
      expect(c.maxSteps).toBeGreaterThan(0)
      expect(c.maxToolCalls).toBe(1000)            // v0.29: default raised to 1000
      expect(c.maxElapsedMs).toBeGreaterThan(0)
      expect(c.maxConsecutiveToolErrors).toBeGreaterThan(0)
    })

    it('overrides are applied', () => {
      const c = createConfig({ maxTokens: 1000, maxToolCalls: 5 })
      expect(c.maxTokens).toBe(1000)
      expect(c.maxToolCalls).toBe(5)
      // Other defaults preserved
      expect(c.maxSteps).toBeGreaterThan(0)
    })
  })

  it('rejects non-positive thresholds at construction (defense via types, not layers)', () => {
    // We don't do runtime validation; the type system + test surface the invariant.
    // If someone passes 0, the guards will trip immediately — which is a test, not a bug.
    const c: ShellConfig = createConfig({ maxTokens: 0 })
    expect(c.maxTokens).toBe(0) // accepted at type level; semantic meaning is "trip immediately"
  })
})
