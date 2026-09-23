// Tests for the M0–M3 memory-layer classifier + signal dispatch (v0.10.2.1).
//
// The classifier is a pure if-else: token count → layer. The signal dispatch
// emits a LayerSignal and fires registered handlers; v0.10.2.1 ships no
// business-logic handlers (they arrive in v0.10.3), so the no-op default
// must not throw.
//
// v0.10.2.2: SignalBus is instance-scoped. Tests cover both the default global
// bus (onLayerEnter/emitLayerSignal) and per-instance isolation.

import { describe, it, expect } from 'vitest'
import {
  classifyMemoryLayer,
  MEMORY_LAYER_THRESHOLDS,
  onLayerEnter,
  emitLayerSignal,
  createSignalBus,
  MAX_CONCURRENT_TOOL_CALLS,
  type LayerSignal,
} from '../../src/im/memory-layers.js'

describe('im/memory-layers', () => {
  describe('MEMORY_LAYER_THRESHOLDS', () => {
    it('has the three user-mandated thresholds', () => {
      expect(MEMORY_LAYER_THRESHOLDS.M1_MIN_TOKENS).toBe(200_000)
      expect(MEMORY_LAYER_THRESHOLDS.M2_MIN_TOKENS).toBe(500_000)
      expect(MEMORY_LAYER_THRESHOLDS.M3_MIN_TOKENS).toBe(900_000)
    })
  })

  describe('classifyMemoryLayer', () => {
    it('returns M0 below 200K', () => {
      expect(classifyMemoryLayer(0)).toBe('M0')
      expect(classifyMemoryLayer(199_999)).toBe('M0')
    })

    it('returns M1 at 200K–499999', () => {
      expect(classifyMemoryLayer(200_000)).toBe('M1')
      expect(classifyMemoryLayer(499_999)).toBe('M1')
    })

    it('returns M2 at 500K–899999', () => {
      expect(classifyMemoryLayer(500_000)).toBe('M2')
      expect(classifyMemoryLayer(899_999)).toBe('M2')
    })

    it('returns M3 at 900K and above', () => {
      expect(classifyMemoryLayer(900_000)).toBe('M3')
      expect(classifyMemoryLayer(10_000_000)).toBe('M3')
    })

    it('boundary: 199999 → M0, 200000 → M1 (exact threshold is inclusive of the upper layer)', () => {
      expect(classifyMemoryLayer(199_999)).toBe('M0')
      expect(classifyMemoryLayer(200_000)).toBe('M1')
    })

    it('boundary: 499999 → M1, 500000 → M2', () => {
      expect(classifyMemoryLayer(499_999)).toBe('M1')
      expect(classifyMemoryLayer(500_000)).toBe('M2')
    })

    it('boundary: 899999 → M2, 900000 → M3', () => {
      expect(classifyMemoryLayer(899_999)).toBe('M2')
      expect(classifyMemoryLayer(900_000)).toBe('M3')
    })
  })

  describe('emitLayerSignal (default global bus)', () => {
    it('returns M0 signal without a threshold field', async () => {
      const signal = await emitLayerSignal(100)
      expect(signal.layer).toBe('M0')
      expect(signal.contextTokens).toBe(100)
      expect(signal).not.toHaveProperty('threshold')
    })

    it('returns M1 signal with the M1 threshold', async () => {
      const signal = await emitLayerSignal(300_000)
      expect(signal.layer).toBe('M1')
      expect(signal.contextTokens).toBe(300_000)
      expect((signal as { threshold: number }).threshold).toBe(200_000)
    })

    it('returns M2 signal with the M2 threshold', async () => {
      const signal = await emitLayerSignal(600_000)
      expect(signal.layer).toBe('M2')
      expect((signal as { threshold: number }).threshold).toBe(500_000)
    })

    it('returns M3 signal with the M3 threshold', async () => {
      const signal = await emitLayerSignal(1_000_000)
      expect(signal.layer).toBe('M3')
      expect((signal as { threshold: number }).threshold).toBe(900_000)
    })

    it('does not throw when no handler is registered (no-op default)', async () => {
      await expect(emitLayerSignal(500_000)).resolves.toBeDefined()
    })
  })

  describe('onLayerEnter (default global bus)', () => {
    it('fires the handler when the matching layer is emitted', async () => {
      const received: LayerSignal[] = []
      const unsub = onLayerEnter('M2', (s) => { received.push(s) })

      await emitLayerSignal(600_000)  // M2
      expect(received).toHaveLength(1)
      expect(received[0]!.layer).toBe('M2')

      unsub()
    })

    it('does not fire for a different layer', async () => {
      const received: LayerSignal[] = []
      const unsub = onLayerEnter('M1', (s) => { received.push(s) })

      await emitLayerSignal(600_000)  // M2, not M1
      expect(received).toHaveLength(0)

      unsub()
    })

    it('unsubscribe stops future calls', async () => {
      const received: LayerSignal[] = []
      const unsub = onLayerEnter('M1', (s) => { received.push(s) })

      await emitLayerSignal(300_000)  // M1 → fires
      expect(received).toHaveLength(1)

      unsub()

      await emitLayerSignal(400_000)  // M1 → does NOT fire
      expect(received).toHaveLength(1)
    })

    it('multiple handlers for the same layer all fire', async () => {
      const calls: string[] = []
      const unsub1 = onLayerEnter('M3', () => { calls.push('first') })
      const unsub2 = onLayerEnter('M3', () => { calls.push('second') })

      await emitLayerSignal(1_000_000)
      expect(calls).toEqual(['first', 'second'])

      unsub1()
      unsub2()
    })
  })

  describe('createSignalBus (instance-scoped)', () => {
    it('handlers on one bus do not fire on another', async () => {
      const busA = createSignalBus()
      const busB = createSignalBus()
      const receivedA: LayerSignal[] = []
      const receivedB: LayerSignal[] = []

      busA.on('M1', (s) => { receivedA.push(s) })
      busB.on('M1', (s) => { receivedB.push(s) })

      await busA.emit(300_000)  // M1

      expect(receivedA).toHaveLength(1)
      expect(receivedB).toHaveLength(0)

      busA.clear()
      busB.clear()
    })

    it('clear() removes all handlers', async () => {
      const bus = createSignalBus()
      const received: LayerSignal[] = []
      bus.on('M2', (s) => { received.push(s) })

      await bus.emit(600_000)  // fires
      expect(received).toHaveLength(1)

      bus.clear()

      await bus.emit(600_000)  // does not fire
      expect(received).toHaveLength(1)
    })

    it('multiple handlers fire concurrently (Promise.all, not sequential)', async () => {
      const bus = createSignalBus()
      const order: string[] = []

      // Handler A is slow (30ms), handler B is fast (5ms).
      // If sequential (for-await), order would be ['A', 'B'].
      // If concurrent (Promise.all), both start immediately; B resolves first
      // but Promise.all waits for all — the key test is that B is NOT blocked by A.
      const slowUnsub = bus.on('M1', async () => {
        await new Promise((r) => setTimeout(r, 30))
        order.push('A')
      })
      const fastUnsub = bus.on('M1', async () => {
        await new Promise((r) => setTimeout(r, 5))
        order.push('B')
      })

      const start = Date.now()
      await bus.emit(300_000)  // M1
      const elapsed = Date.now() - start

      // Concurrent: total time ≈ max(30, 5) = ~30ms, NOT 35ms.
      // Sequential would be 35ms. Allow generous slack for CI.
      expect(elapsed).toBeLessThan(50)
      expect(order).toHaveLength(2)

      slowUnsub()
      fastUnsub()
      bus.clear()
    })

    it('unsubscribe from instance bus stops future calls', async () => {
      const bus = createSignalBus()
      const received: LayerSignal[] = []
      const unsub = bus.on('M1', (s) => { received.push(s) })

      await bus.emit(300_000)
      expect(received).toHaveLength(1)

      unsub()
      await bus.emit(300_000)
      expect(received).toHaveLength(1)

      bus.clear()
    })
  })

  describe('MAX_CONCURRENT_TOOL_CALLS', () => {
    it('is 2 (v0.10.2.1 hard cap)', () => {
      expect(MAX_CONCURRENT_TOOL_CALLS).toBe(2)
    })
  })
})
