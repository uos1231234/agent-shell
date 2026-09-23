// v0.14: MemoryConfig — verifies default values, overrides, and that
// classifyMemoryLayer respects custom thresholds.

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MEMORY_CONFIG,
  type MemoryConfig,
} from '../../src/shell/memory-config.js'
import { classifyMemoryLayer } from '../../src/im/memory-layers.js'

describe('MemoryConfig defaults (v0.14)', () => {
  it('DEFAULT_MEMORY_CONFIG has 200K / 500K / 900K thresholds', () => {
    expect(DEFAULT_MEMORY_CONFIG.m1MinTokens).toBe(200_000)
    expect(DEFAULT_MEMORY_CONFIG.m2MinTokens).toBe(500_000)
    expect(DEFAULT_MEMORY_CONFIG.m3MinTokens).toBe(900_000)
  })

  it('classifyMemoryLayer with defaults reproduces pre-v0.14 boundaries', () => {
    // < 200K → M0
    expect(classifyMemoryLayer(0)).toBe('M0')
    expect(classifyMemoryLayer(199_999)).toBe('M0')
    // 200K – 499,999 → M1
    expect(classifyMemoryLayer(200_000)).toBe('M1')
    expect(classifyMemoryLayer(499_999)).toBe('M1')
    // 500K – 899,999 → M2
    expect(classifyMemoryLayer(500_000)).toBe('M2')
    expect(classifyMemoryLayer(899_999)).toBe('M2')
    // >= 900K → M3
    expect(classifyMemoryLayer(900_000)).toBe('M3')
    expect(classifyMemoryLayer(1_000_000)).toBe('M3')
  })
})

describe('MemoryConfig overrides (v0.14)', () => {
  it('lower thresholds shift all layer boundaries down', () => {
    const low: MemoryConfig = {
      m1MinTokens: 10_000,
      m2MinTokens: 30_000,
      m3MinTokens: 50_000,
    }
    expect(classifyMemoryLayer(0, low)).toBe('M0')
    expect(classifyMemoryLayer(9_999, low)).toBe('M0')
    expect(classifyMemoryLayer(10_000, low)).toBe('M1')
    expect(classifyMemoryLayer(29_999, low)).toBe('M1')
    expect(classifyMemoryLayer(30_000, low)).toBe('M2')
    expect(classifyMemoryLayer(49_999, low)).toBe('M2')
    expect(classifyMemoryLayer(50_000, low)).toBe('M3')
    expect(classifyMemoryLayer(999_999, low)).toBe('M3')
  })

  it('higher thresholds shift all layer boundaries up', () => {
    const high: MemoryConfig = {
      m1MinTokens: 400_000,
      m2MinTokens: 800_000,
      m3MinTokens: 1_200_000,
    }
    // Everything that was M1 at 200K is now M0
    expect(classifyMemoryLayer(200_000, high)).toBe('M0')
    expect(classifyMemoryLayer(399_999, high)).toBe('M0')
    expect(classifyMemoryLayer(400_000, high)).toBe('M1')
    expect(classifyMemoryLayer(799_999, high)).toBe('M1')
    expect(classifyMemoryLayer(800_000, high)).toBe('M2')
    expect(classifyMemoryLayer(1_199_999, high)).toBe('M2')
    expect(classifyMemoryLayer(1_200_000, high)).toBe('M3')
  })

  it('DEFAULT_MEMORY_CONFIG passed explicitly is identical to omitting it', () => {
    for (const tokens of [0, 199_999, 200_000, 499_999, 500_000, 899_999, 900_000, 2_000_000]) {
      expect(classifyMemoryLayer(tokens)).toBe(classifyMemoryLayer(tokens, DEFAULT_MEMORY_CONFIG))
    }
  })
})
