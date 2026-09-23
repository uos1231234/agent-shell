import { describe, it, expect } from 'vitest'
import { createMetrics, addUsage, addStep, addToolCalls, addToolError, resetToolErrors, type Metrics } from '../../src/shell/metrics.js'

const initial = (): Metrics => createMetrics()

describe('shell/metrics', () => {
  describe('createMetrics', () => {
    it('starts at zero', () => {
      const m = initial()
      expect(m.totalTokens).toBe(0)
      expect(m.promptTokens).toBe(0)
      expect(m.completionTokens).toBe(0)
      expect(m.stepCount).toBe(0)
      expect(m.toolCallCount).toBe(0)
      expect(m.consecutiveToolErrors).toBe(0)
      expect(m.elapsedMs).toBe(0)
    })
  })

  describe('addUsage', () => {
    it('accumulates prompt + completion = total', () => {
      const m = addUsage(initial(), { promptTokens: 100, completionTokens: 50, totalTokens: 150 })
      expect(m.promptTokens).toBe(100)
      expect(m.completionTokens).toBe(50)
      expect(m.totalTokens).toBe(150)
    })

    it('accumulates across calls', () => {
      const m = addUsage(addUsage(initial(), { promptTokens: 10, completionTokens: 5, totalTokens: 15 }), { promptTokens: 20, completionTokens: 5, totalTokens: 25 })
      expect(m.totalTokens).toBe(40)
    })
  })

  describe('addStep', () => {
    it('increments step count by exactly 1', () => {
      const m = addStep(initial())
      expect(m.stepCount).toBe(1)
      const m2 = addStep(m)
      expect(m2.stepCount).toBe(2)
    })
  })

  describe('addToolCalls', () => {
    it('adds n to tool call count', () => {
      const m = addToolCalls(initial(), 3)
      expect(m.toolCallCount).toBe(3)
      const m2 = addToolCalls(m, 2)
      expect(m2.toolCallCount).toBe(5)
    })
  })

  describe('addToolError / resetToolErrors', () => {
    it('increments then zeroes consecutiveToolErrors', () => {
      const m = addToolError(addToolError(initial()))
      expect(m.consecutiveToolErrors).toBe(2)
      const m2 = resetToolErrors(m)
      expect(m2.consecutiveToolErrors).toBe(0)
    })
  })
})
