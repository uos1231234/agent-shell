// Tests for ContextInjector — priority-ordered injection source registry.
//
// Invariants:
//   - register adds sources and sorts by priority.
//   - inject executes sources in priority order, returns non-empty content.
//   - Empty/null injection results are skipped.
//   - clear removes all sources.

import { describe, it, expect, beforeEach } from 'vitest'
import { ContextInjector, type InjectionContext, type ContextInjectionSource } from '../../../src/im/hooks/context-injection.js'

function makeCtx(overrides: Partial<InjectionContext> = {}): InjectionContext {
  return {
    conversationHistory: [],
    registry: {} as any,
    round: 1,
    ...overrides,
  }
}

function makeSource(name: string, priority: number, content: string | null, position: 'afterSystem' | 'afterUser' = 'afterSystem'): ContextInjectionSource {
  return {
    name,
    priority,
    position,
    inject: async () => content,
  }
}

describe('ContextInjector', () => {
  let injector: ContextInjector

  beforeEach(() => {
    injector = new ContextInjector()
  })

  it('register adds a source', async () => {
    const source = makeSource('test', 10, 'hello')
    injector.register(source)
    const result = await injector.inject(makeCtx())
    expect(result).toEqual([{ content: 'hello', position: 'afterSystem' }])
  })

  it('register sorts sources by priority ascending', async () => {
    injector.register(makeSource('low', 30, 'third'))
    injector.register(makeSource('high', 10, 'first'))
    injector.register(makeSource('mid', 20, 'second'))
    const result = await injector.inject(makeCtx())
    expect(result).toEqual([
      { content: 'first', position: 'afterSystem' },
      { content: 'second', position: 'afterSystem' },
      { content: 'third', position: 'afterSystem' },
    ])
  })

  it('inject returns only non-empty content', async () => {
    injector.register(makeSource('empty', 10, ''))
    injector.register(makeSource('valid', 20, 'content'))
    const result = await injector.inject(makeCtx())
    expect(result).toEqual([{ content: 'content', position: 'afterSystem' }])
  })

  it('inject skips null results', async () => {
    injector.register(makeSource('null_source', 10, null))
    injector.register(makeSource('valid', 20, 'data'))
    const result = await injector.inject(makeCtx())
    expect(result).toEqual([{ content: 'data', position: 'afterSystem' }])
  })

  it('inject returns empty array when no sources', async () => {
    const result = await injector.inject(makeCtx())
    expect(result).toEqual([])
  })

  it('inject returns empty array when all sources return null', async () => {
    injector.register(makeSource('a', 10, null))
    injector.register(makeSource('b', 20, null))
    const result = await injector.inject(makeCtx())
    expect(result).toEqual([])
  })

  it('clear removes all sources', async () => {
    injector.register(makeSource('test', 10, 'hello'))
    await injector.clear()
    const result = await injector.inject(makeCtx())
    expect(result).toEqual([])
  })

  it('inject passes ctx to source inject function', async () => {
    let receivedCtx: InjectionContext | null = null
    injector.register({
      name: 'ctx_checker',
      priority: 10,
      position: 'afterSystem',
      inject: async (ctx) => {
        receivedCtx = ctx
        return 'ok'
      },
    })
    const ctx = makeCtx({ sessionId: 'sess-1', round: 5 })
    await injector.inject(ctx)
    expect(receivedCtx).toBe(ctx)
  })
})
