import { describe, it, expect, vi } from 'vitest'
import { createRenderingLoopHook } from '../../../src/rendering/hooks/rendering-loop-hook.js'
import type { RenderingSignalBus } from '../../../src/rendering/signal-bus.js'
import type { AfterToolExecutionContext } from '../../../src/im/loop-hooks.js'
import type { ToolTurn } from '../../../src/im/databus.js'

const mkTurn = (overrides: Partial<ToolTurn> = {}): ToolTurn => ({
  id: 't1',
  role: 'tool',
  toolCallId: 'tc-1',
  content: '{}',
  sourceAgentId: 'main',
  at: 1,
  ...overrides,
})

const mkCtx = (toolResults: ToolTurn[]): AfterToolExecutionContext => ({
  turnId: 'turn-1',
  stepNumber: 1,
  signal: undefined,
  toolResults,
  errorCount: 0,
})

type EmitCall = { toolName: string; turn: ToolTurn }

/** Mock bus that only records emit calls — matching/broadcast not exercised here. */
const mkMockBus = (): { bus: RenderingSignalBus; emitCalls: EmitCall[] } => {
  const emitCalls: EmitCall[] = []
  const bus: RenderingSignalBus = {
    registerRule: () => () => {},
    onSignal: () => () => {},
    emit: async (toolName, turn) => {
      emitCalls.push({ toolName, turn })
    },
  }
  return { bus, emitCalls }
}

describe('rendering/rendering-loop-hook', () => {
  it('forwards each toolResult to bus.emit in order, with the turn itself', async () => {
    const { bus, emitCalls } = mkMockBus()
    const hook = createRenderingLoopHook(bus)
    const turn1 = mkTurn({ id: 't1', toolCallId: 'tc-1', toolName: 'wiki__render_md', content: '{"a":1}' })
    const turn2 = mkTurn({ id: 't2', toolCallId: 'tc-2', toolName: 'grep', content: 'plain' })

    await hook(mkCtx([turn1, turn2]))

    expect(emitCalls).toHaveLength(2)
    expect(emitCalls[0]).toEqual({ toolName: 'wiki__render_md', turn: turn1 })
    expect(emitCalls[1]).toEqual({ toolName: 'grep', turn: turn2 })
  })

  it('returns undefined — the LoopHooks "not intervening" signal', async () => {
    const { bus } = mkMockBus()
    const hook = createRenderingLoopHook(bus)

    const result = await hook(mkCtx([mkTurn()]))

    expect(result).toBeUndefined()
  })

  it('empty toolResults — emit is never called', async () => {
    const { bus, emitCalls } = mkMockBus()
    const hook = createRenderingLoopHook(bus)

    await hook(mkCtx([]))

    expect(emitCalls).toHaveLength(0)
  })

  it('single turn — emit called exactly once', async () => {
    const { bus, emitCalls } = mkMockBus()
    const hook = createRenderingLoopHook(bus)
    const turn = mkTurn({ toolName: 'bash', content: 'ok' })

    await hook(mkCtx([turn]))

    expect(emitCalls).toHaveLength(1)
    expect(emitCalls[0]?.toolName).toBe('bash')
    expect(emitCalls[0]?.turn).toBe(turn)
  })

  it('turn without toolName — forwards "" as toolName (bus match-all-false → silent)', async () => {
    // D3a: ToolTurn.toolName is optional; the hook is a pure type bridge,
    // mapping undefined → ''. No matching/extraction logic lives here.
    const { bus, emitCalls } = mkMockBus()
    const hook = createRenderingLoopHook(bus)
    // exactOptionalPropertyTypes: an absent toolName is the "undefined" case.
    const { toolName: _omit, ...base } = mkTurn({ toolName: 'x' })
    const turn: ToolTurn = base

    await hook(mkCtx([turn]))

    expect(emitCalls).toHaveLength(1)
    expect(emitCalls[0]?.toolName).toBe('')
    expect(emitCalls[0]?.turn).toBe(turn)
  })

  it('hook type: is the AfterToolExecutionHook signature (async, ctx in, Result|undefined out)', async () => {
    const { bus } = mkMockBus()
    const hook = createRenderingLoopHook(bus)
    expect(typeof hook).toBe('function')
    expect(hook.constructor.name).toBe('AsyncFunction')
  })
})
