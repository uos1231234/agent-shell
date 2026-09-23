// Tests for temporal context injection — v0.19 D11
//
// Invariants:
//   - Returns string containing date and timezone.
//   - Format is correct: [时间上下文] 日期: YYYY-MM-DD | 时区: TZ

import { describe, it, expect } from 'vitest'
import { createTemporalInjection } from '../../../../src/im/hooks/injections/temporal.js'
import type { InjectionContext } from '../../../../src/im/hooks/context-injection.js'

function makeCtx(): InjectionContext {
  return {
    conversationHistory: [],
    registry: {} as any,
    round: 1,
  }
}

describe('temporal injection', () => {
  it('returns string containing date and timezone', async () => {
    const injection = createTemporalInjection()
    const result = await injection.inject(makeCtx())
    expect(result).not.toBeNull()
    expect(result).toContain('日期')
    expect(result).toContain('时区')
  })

  it('returns correct format with [时间上下文] prefix', async () => {
    const injection = createTemporalInjection()
    const result = await injection.inject(makeCtx())
    expect(result).toMatch(/^\[时间上下文\]/)
  })

  it('date is in YYYY-MM-DD format', async () => {
    const injection = createTemporalInjection()
    const result = await injection.inject(makeCtx())
    // Extract date from the result
    const dateMatch = result!.match(/日期: (\d{4}-\d{2}-\d{2})/)
    expect(dateMatch).not.toBeNull()
    // Verify it's a valid date
    const date = new Date(dateMatch![1]!)
    expect(date.toString()).not.toBe('Invalid Date')
  })

  it('matches ISO date for today', async () => {
    const injection = createTemporalInjection()
    const result = await injection.inject(makeCtx())
    const today = new Date().toISOString().split('T')[0]
    expect(result).toContain(`日期: ${today}`)
  })

  it('timezone is a non-empty string', async () => {
    const injection = createTemporalInjection()
    const result = await injection.inject(makeCtx())
    const tzMatch = result!.match(/时区: (.+)$/)
    expect(tzMatch).not.toBeNull()
    expect(tzMatch![1]!.length).toBeGreaterThan(0)
  })

  it('has correct name and priority', () => {
    const injection = createTemporalInjection()
    expect(injection.name).toBe('temporal_context')
    expect(injection.priority).toBe(20)
  })
})
