import { describe, it, expect, vi } from 'vitest'
import { HookSystem } from '../../../src/im/hooks/hook-system.js'
import type { HookContext, HookHandler } from '../../../src/im/hooks/types.js'

function makeHandler(event: string, returnValue?: any): HookHandler & { called: number } {
  let called = 0
  return {
    event: event as any,
    handler: async () => {
      called++
      return returnValue
    },
    get called() { return called },
  }
}

function makeCtx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    event: 'PostToolUse',
    toolName: 'read',
    duration: 100,
    sessionId: 'test-session',
    ...overrides,
  }
}

describe('HookSystem', () => {
  describe('register', () => {
    it('registers a handler', async () => {
      const hs = new HookSystem()
      const h = makeHandler('PostToolUse')
      hs.register(h)
      await hs.emit('PostToolUse', makeCtx())
      expect(h.called).toBe(1)
    })
  })

  describe('emit', () => {
    it('triggers handler for matching event', async () => {
      const hs = new HookSystem()
      const h = makeHandler('PostToolUse')
      hs.register(h)
      await hs.emit('PostToolUse', makeCtx())
      expect(h.called).toBe(1)
    })

    it('does not trigger handler for non-matching event', async () => {
      const hs = new HookSystem()
      const h = makeHandler('PostToolUse')
      hs.register(h)
      await hs.emit('SessionStart', makeCtx({ event: 'SessionStart' }))
      expect(h.called).toBe(0)
    })

    it('executes multiple handlers in registration order', async () => {
      const hs = new HookSystem()
      const order: number[] = []

      hs.register({
        event: 'PostToolUse',
        handler: async () => { order.push(1) },
      })
      hs.register({
        event: 'PostToolUse',
        handler: async () => { order.push(2) },
      })
      hs.register({
        event: 'PostToolUse',
        handler: async () => { order.push(3) },
      })

      await hs.emit('PostToolUse', makeCtx())
      expect(order).toEqual([1, 2, 3])
    })

    it('does not throw when no handlers registered', async () => {
      const hs = new HookSystem()
      await expect(hs.emit('PostToolUse', makeCtx())).resolves.toBeUndefined()
    })
  })

  describe('emitPreToolUse', () => {
    it('returns true when all handlers return true or undefined', async () => {
      const hs = new HookSystem()
      hs.register(makeHandler('PreToolUse', true))
      hs.register(makeHandler('PreToolUse', undefined))
      hs.register(makeHandler('PreToolUse', true))

      const result = await hs.emitPreToolUse(makeCtx({ event: 'PreToolUse' }))
      expect(result).toBe(true)
    })

    it('returns false when any handler returns false', async () => {
      const hs = new HookSystem()
      hs.register(makeHandler('PreToolUse', true))
      hs.register(makeHandler('PreToolUse', false))
      hs.register(makeHandler('PreToolUse', true))

      const result = await hs.emitPreToolUse(makeCtx({ event: 'PreToolUse' }))
      expect(result).toBe(false)
    })

    it('returns true when no PreToolUse handlers registered', async () => {
      const hs = new HookSystem()
      const result = await hs.emitPreToolUse(makeCtx({ event: 'PreToolUse' }))
      expect(result).toBe(true)
    })

    it('stops checking after first false', async () => {
      const hs = new HookSystem()
      const h2 = makeHandler('PreToolUse', true)
      hs.register(makeHandler('PreToolUse', false))
      hs.register(h2)

      const result = await hs.emitPreToolUse(makeCtx({ event: 'PreToolUse' }))
      expect(result).toBe(false)
      expect(h2.called).toBe(0)
    })
  })

  describe('clear', () => {
    it('removes all handlers', async () => {
      const hs = new HookSystem()
      const h1 = makeHandler('PostToolUse')
      const h2 = makeHandler('SessionStart')
      hs.register(h1)
      hs.register(h2)

      await hs.clear()

      await hs.emit('PostToolUse', makeCtx())
      await hs.emit('SessionStart', makeCtx({ event: 'SessionStart' }))
      expect(h1.called).toBe(0)
      expect(h2.called).toBe(0)
    })

    it('emit after clear does not trigger any handler', async () => {
      const hs = new HookSystem()
      const h = makeHandler('PostToolUse')
      hs.register(h)
      await hs.clear()
      await hs.emit('PostToolUse', makeCtx())
      expect(h.called).toBe(0)
    })
  })
})
