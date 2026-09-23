// v0.14: classifyMemoryLayer signature change — accepts optional MemoryConfig.
// Verifies the config parameter works correctly and that the function is pure
// (no side effects, deterministic for the same inputs).

import { describe, it, expect } from 'vitest'
import { classifyMemoryLayer, MEMORY_LAYER_THRESHOLDS } from '../../src/im/memory-layers.js'
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from '../../src/shell/memory-config.js'

describe('classifyMemoryLayer custom config (v0.14)', () => {
  it('accepts a custom MemoryConfig as second argument', () => {
    const custom: MemoryConfig = {
      m1MinTokens: 100,
      m2MinTokens: 200,
      m3MinTokens: 300,
    }
    expect(classifyMemoryLayer(0, custom)).toBe('M0')
    expect(classifyMemoryLayer(99, custom)).toBe('M0')
    expect(classifyMemoryLayer(100, custom)).toBe('M1')
    expect(classifyMemoryLayer(150, custom)).toBe('M1')
    expect(classifyMemoryLayer(200, custom)).toBe('M2')
    expect(classifyMemoryLayer(299, custom)).toBe('M2')
    expect(classifyMemoryLayer(300, custom)).toBe('M3')
  })

  it('is pure — same inputs always produce same output', () => {
    const cfg: MemoryConfig = { m1MinTokens: 50, m2MinTokens: 60, m3MinTokens: 70 }
    const first = classifyMemoryLayer(55, cfg)
    const second = classifyMemoryLayer(55, cfg)
    expect(first).toBe(second)
    expect(first).toBe('M1')
  })

  it('MEMORY_LAYER_THRESHOLDS const is retained and matches defaults', () => {
    // Backward compat: the old const still exists and matches DEFAULT_MEMORY_CONFIG
    expect(MEMORY_LAYER_THRESHOLDS.M1_MIN_TOKENS).toBe(DEFAULT_MEMORY_CONFIG.m1MinTokens)
    expect(MEMORY_LAYER_THRESHOLDS.M2_MIN_TOKENS).toBe(DEFAULT_MEMORY_CONFIG.m2MinTokens)
    expect(MEMORY_LAYER_THRESHOLDS.M3_MIN_TOKENS).toBe(DEFAULT_MEMORY_CONFIG.m3MinTokens)
  })

  it('omitting config uses DEFAULT_MEMORY_CONFIG (backward compat)', () => {
    // Single-arg call — the pre-v0.14 signature — must still work identically.
    expect(classifyMemoryLayer(100_000)).toBe('M0')
    expect(classifyMemoryLayer(300_000)).toBe('M1')
    expect(classifyMemoryLayer(700_000)).toBe('M2')
    expect(classifyMemoryLayer(1_000_000)).toBe('M3')
  })

  it('edge case: zero-token thresholds', () => {
    // Everything is at least M1 when m1MinTokens is 0
    const zero: MemoryConfig = { m1MinTokens: 0, m2MinTokens: 0, m3MinTokens: 0 }
    expect(classifyMemoryLayer(0, zero)).toBe('M3')
    expect(classifyMemoryLayer(1, zero)).toBe('M3')
  })
})
