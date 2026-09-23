// Tests for runtime context injection — v0.19 D11
//
// Invariants:
//   - With sessionId/agentId, injects full info.
//   - With only round, injects only round.
//   - Returns correct format.

import { describe, it, expect } from 'vitest'
import { createRuntimeInjection } from '../../../../src/im/hooks/injections/runtime.js'
import type { InjectionContext } from '../../../../src/im/hooks/context-injection.js'

function makeCtx(overrides: Partial<InjectionContext> = {}): InjectionContext {
  return {
    conversationHistory: [],
    registry: {} as any,
    round: 1,
    ...overrides,
  }
}

describe('runtime injection', () => {
  it('injects full info when sessionId and agentId are present', async () => {
    const injection = createRuntimeInjection()
    const ctx = makeCtx({ sessionId: 'sess-abc', agentId: 'agent-1', round: 3 })
    const result = await injection.inject(ctx)
    expect(result).not.toBeNull()
    expect(result).toContain('sess-abc')
    expect(result).toContain('agent-1')
    expect(result).toContain('Round: 3')
  })

  it('injects only round when sessionId and agentId are absent', async () => {
    const injection = createRuntimeInjection()
    const ctx = makeCtx({ round: 7 })
    const result = await injection.inject(ctx)
    expect(result).not.toBeNull()
    expect(result).toContain('Round: 7')
    expect(result).not.toContain('Session')
    expect(result).not.toContain('Agent')
  })

  it('returns correct format with [运行时上下文] prefix', async () => {
    const injection = createRuntimeInjection()
    const ctx = makeCtx({ sessionId: 's1', agentId: 'a1', round: 2 })
    const result = await injection.inject(ctx)
    expect(result).toMatch(/^\[运行时上下文\]/)
  })

  it('parts are joined with " | "', async () => {
    const injection = createRuntimeInjection()
    const ctx = makeCtx({ sessionId: 's1', agentId: 'a1', round: 2 })
    const result = await injection.inject(ctx)
    expect(result).toContain(' | ')
    expect(result).toBe('[运行时上下文] Session: s1 | Agent: a1 | Round: 2')
  })

  it('has correct name and priority', () => {
    const injection = createRuntimeInjection()
    expect(injection.name).toBe('runtime_context')
    expect(injection.priority).toBe(10)
  })

  it('injects WorkDir when ctx.workDir is present', async () => {
    const injection = createRuntimeInjection()
    const ctx = makeCtx({ sessionId: 's1', agentId: 'a1', round: 2, workDir: '/home/user/proj' })
    const result = await injection.inject(ctx)
    expect(result).toContain('WorkDir: /home/user/proj')
    expect(result).toBe('[运行时上下文] Session: s1 | Agent: a1 | Round: 2 | WorkDir: /home/user/proj')
  })

  it('omits WorkDir when ctx.workDir is absent', async () => {
    const injection = createRuntimeInjection()
    const ctx = makeCtx({ sessionId: 's1', agentId: 'a1', round: 2 })
    const result = await injection.inject(ctx)
    expect(result).not.toContain('WorkDir')
    expect(result).toBe('[运行时上下文] Session: s1 | Agent: a1 | Round: 2')
  })
})
