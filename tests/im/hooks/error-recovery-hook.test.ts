import { describe, it, expect } from 'vitest'
import { createErrorRecoveryHook } from '../../../src/im/hooks/error-recovery-hook.js'
import type { HookContext } from '../../../src/im/hooks/types.js'

function makeCtx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    event: 'PostToolUse',
    toolName: 'read',
    duration: 100,
    sessionId: 'test-session',
    ...overrides,
  }
}

describe('createErrorRecoveryHook', () => {
  it('returns an object with event and handler properties', () => {
    const hook = createErrorRecoveryHook()
    expect(hook).toHaveProperty('event')
    expect(hook).toHaveProperty('handler')
    expect(hook.event).toBe('PostToolUse')
    expect(typeof hook.handler).toBe('function')
  })

  it('shouldSuggestAlternatives returns false when no errors', () => {
    const hook = createErrorRecoveryHook()
    expect(hook.shouldSuggestAlternatives()).toBe(false)
  })

  it('shouldSuggestAlternatives returns false after 1 consecutive error', async () => {
    const hook = createErrorRecoveryHook()
    await hook.handler(makeCtx({ error: new Error('fail') }))
    expect(hook.shouldSuggestAlternatives()).toBe(false)
  })

  it('shouldSuggestAlternatives returns false after 2 consecutive errors', async () => {
    const hook = createErrorRecoveryHook()
    await hook.handler(makeCtx({ error: new Error('fail 1') }))
    await hook.handler(makeCtx({ error: new Error('fail 2') }))
    expect(hook.shouldSuggestAlternatives()).toBe(false)
  })

  it('shouldSuggestAlternatives returns true after 3 consecutive errors', async () => {
    const hook = createErrorRecoveryHook()
    await hook.handler(makeCtx({ error: new Error('fail 1') }))
    await hook.handler(makeCtx({ error: new Error('fail 2') }))
    await hook.handler(makeCtx({ error: new Error('fail 3') }))
    expect(hook.shouldSuggestAlternatives()).toBe(true)
  })

  it('shouldSuggestAlternatives returns true after more than 3 consecutive errors', async () => {
    const hook = createErrorRecoveryHook()
    await hook.handler(makeCtx({ error: new Error('fail 1') }))
    await hook.handler(makeCtx({ error: new Error('fail 2') }))
    await hook.handler(makeCtx({ error: new Error('fail 3') }))
    await hook.handler(makeCtx({ error: new Error('fail 4') }))
    expect(hook.shouldSuggestAlternatives()).toBe(true)
  })

  it('successful call resets consecutive error count', async () => {
    const hook = createErrorRecoveryHook()
    // 2 errors
    await hook.handler(makeCtx({ error: new Error('fail 1') }))
    await hook.handler(makeCtx({ error: new Error('fail 2') }))
    expect(hook.shouldSuggestAlternatives()).toBe(false)

    // success resets
    await hook.handler(makeCtx())
    expect(hook.shouldSuggestAlternatives()).toBe(false)

    // only 2 more errors, not enough to trigger
    await hook.handler(makeCtx({ error: new Error('fail 3') }))
    await hook.handler(makeCtx({ error: new Error('fail 4') }))
    expect(hook.shouldSuggestAlternatives()).toBe(false)
  })

  it('error -> success -> error resets counter', async () => {
    const hook = createErrorRecoveryHook()
    await hook.handler(makeCtx({ error: new Error('fail') }))
    await hook.handler(makeCtx()) // success resets
    await hook.handler(makeCtx({ error: new Error('fail again') }))

    expect(hook.shouldSuggestAlternatives()).toBe(false)
  })

  it('error -> success -> 3 errors triggers suggestion', async () => {
    const hook = createErrorRecoveryHook()
    await hook.handler(makeCtx({ error: new Error('fail 1') }))
    await hook.handler(makeCtx()) // success resets
    await hook.handler(makeCtx({ error: new Error('fail 2') }))
    await hook.handler(makeCtx({ error: new Error('fail 3') }))
    await hook.handler(makeCtx({ error: new Error('fail 4') }))

    expect(hook.shouldSuggestAlternatives()).toBe(true)
  })
})
