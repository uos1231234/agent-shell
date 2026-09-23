// v0.17: unit tests for the LoopHooks types and callHook helper.
//
// callHook is a pure helper — these tests run without any harness or
// ToolRegistry. They are the new low-cost surface that the v0.17 refactor
// was designed to unlock (plan §6.3: hook functions are pure).

import { describe, it, expect, vi } from 'vitest'
import {
  callHook,
  type BeforeShellCallContext,
  type AfterShellCallContext,
  type AfterGuardsContext,
  type BeforeToolExecutionContext,
  type AfterToolExecutionContext,
} from '../../src/im/loop-hooks.js'
import type { GuardHit } from '../../src/shell/guards.js'
import { ShellTerminatedError } from '../../src/shell/gate.js'
import type { ToolCall } from '../../src/protocol/types.js'
import type { ToolTurn } from '../../src/im/databus.js'

describe('callHook', () => {
  it('returns undefined when hook is undefined (default behavior)', async () => {
    const out = await callHook(undefined, { turnId: 't', stepNumber: 1, signal: undefined, promptTokens: 100 }, 'beforeShellCall')
    expect(out).toBeUndefined()
  })

  it('passes ctx through and returns the hook result', async () => {
    const ctx: BeforeShellCallContext = { turnId: 't-1', stepNumber: 1, signal: undefined, promptTokens: 200 }
    const hook = vi.fn(async (c: BeforeShellCallContext) => {
      expect(c).toBe(ctx)
      return { block: true, reason: 'test' }
    })
    const out = await callHook(hook, ctx, 'beforeShellCall')
    expect(out).toEqual({ block: true, reason: 'test' })
    expect(hook).toHaveBeenCalledTimes(1)
  })

  it('returns undefined when hook returns undefined (not intervening)', async () => {
    const out = await callHook(async () => undefined, { turnId: 't', stepNumber: 1, signal: undefined, promptTokens: 0 }, 'afterGuards')
    expect(out).toBeUndefined()
  })

  it('catches a thrown error and returns undefined (fail-safe)', async () => {
    // Suppress the warn log so test output stays clean.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hook = async () => { throw new Error('boom') }
    const out = await callHook<BeforeShellCallContext, { block: boolean }>(hook, { turnId: 't', stepNumber: 1, signal: undefined, promptTokens: 0 }, 'beforeShellCall')
    expect(out).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]![0]).toMatch(/beforeShellCall/)
    expect(warnSpy.mock.calls[0]![0]).toMatch(/boom/)
    warnSpy.mockRestore()
  })

  it('catches non-Error throws and still returns undefined', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hook = async () => { throw 'string-throw' }
    const out = await callHook(hook, { turnId: 't', stepNumber: 1, signal: undefined, promptTokens: 0 }, 'afterShellCall')
    expect(out).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })
})

describe('BeforeShellCallContext shape', () => {
  it('accepts the documented fields', async () => {
    const captured: BeforeShellCallContext[] = []
    await callHook<BeforeShellCallContext, { block: boolean }>(async (c) => {
      captured.push(c)
      return undefined
    }, { turnId: 'turn-7', stepNumber: 7, signal: undefined, promptTokens: 12345 }, 'beforeShellCall')
    expect(captured).toHaveLength(1)
    expect(captured[0]).toEqual({ turnId: 'turn-7', stepNumber: 7, signal: undefined, promptTokens: 12345 })
  })
})

describe('AfterShellCallContext — error vs result exclusivity', () => {
  it('passes the error path ctx correctly (ShellTerminatedError)', async () => {
    const err = new ShellTerminatedError('Tripped', [{ id: 'iter', reason: 'test' }])
    const captured: AfterShellCallContext[] = []
    await callHook<AfterShellCallContext, unknown>(async (c) => {
      captured.push(c)
      return undefined
    }, { turnId: 't', stepNumber: 1, signal: undefined, error: err }, 'afterShellCall')
    expect(captured[0]!.error).toBe(err)
    expect(captured[0]!.result).toBeUndefined()
  })

  it('passes the result path ctx correctly', async () => {
    const fakeResult = { response: { id: 'r', model: 'gpt', choices: [] }, updatedMetrics: {} as never, toolCalls: [] }
    const captured: AfterShellCallContext[] = []
    await callHook<AfterShellCallContext, unknown>(async (c) => {
      captured.push(c)
      return undefined
    }, { turnId: 't', stepNumber: 2, signal: undefined, result: fakeResult }, 'afterShellCall')
    expect(captured[0]!.result).toBe(fakeResult)
    expect(captured[0]!.error).toBeUndefined()
  })

  it('a retry-result hook short-circuits the default protocol-error backoff', async () => {
    // Demonstrates the contract: returning { retry: true } is the hook's
    // signal to skip the default retry/backoff logic and use the hook's
    // delay instead. The loop wires this up (see step 6 integration tests).
    const out = await callHook<AfterShellCallContext, { retry: boolean; retryDelayMs: number }>(async () => {
      return { retry: true, retryDelayMs: 250 }
    }, { turnId: 't', stepNumber: 1, signal: undefined, error: new Error('net') as never }, 'afterShellCall')
    expect(out).toEqual({ retry: true, retryDelayMs: 250 })
  })

  it('an overrideTerminate result short-circuits to terminate', async () => {
    const out = await callHook<AfterShellCallContext, { overrideTerminate: { reason: 'protocol-error' } }>(async () => {
      return { overrideTerminate: { reason: 'protocol-error' } }
    }, { turnId: 't', stepNumber: 1, signal: undefined }, 'afterShellCall')
    expect(out?.overrideTerminate?.reason).toBe('protocol-error')
  })
})

describe('AfterGuardsContext', () => {
  it('passes hits through', async () => {
    const fakeHits: GuardHit[] = [{ id: 'iter', reason: 'too many steps' }]
    const captured: AfterGuardsContext[] = []
    await callHook<AfterGuardsContext, unknown>(async (c) => {
      captured.push(c)
      return undefined
    }, { turnId: 't', stepNumber: 3, signal: undefined, hits: fakeHits }, 'afterGuards')
    expect(captured[0]!.hits).toBe(fakeHits)
  })

  it('a forceTerminate hook result is honored', async () => {
    const out = await callHook<AfterGuardsContext, { forceTerminate: boolean; reason: 'guard-tripped' }>(async () => {
      return { forceTerminate: true, reason: 'guard-tripped' }
    }, { turnId: 't', stepNumber: 3, signal: undefined, hits: [] }, 'afterGuards')
    expect(out?.forceTerminate).toBe(true)
    expect(out?.reason).toBe('guard-tripped')
  })
})

describe('BeforeToolExecutionContext', () => {
  it('passes toolCalls through and accepts synthetic results', async () => {
    const tcs: ToolCall[] = [
      { id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } },
    ]
    const synth: ToolTurn[] = [{
      id: 't1', role: 'tool', toolCallId: 'c1', content: 'blocked', sourceAgentId: 'main', at: 1,
    }]
    const captured: BeforeToolExecutionContext[] = []
    const out = await callHook<BeforeToolExecutionContext, { block: boolean; syntheticToolResults?: ToolTurn[] }>(async (c) => {
      captured.push(c)
      return { block: true, syntheticToolResults: synth }
    }, { turnId: 't', stepNumber: 4, signal: undefined, toolCalls: tcs }, 'beforeToolExecution')
    expect(captured[0]!.toolCalls).toBe(tcs)
    expect(out?.block).toBe(true)
    expect(out?.syntheticToolResults).toBe(synth)
  })
})

describe('AfterToolExecutionContext', () => {
  it('passes toolResults + errorCount and accepts transformedResults', async () => {
    const results: ToolTurn[] = [
      { id: 't1', role: 'tool', toolCallId: 'c1', content: 'ok', sourceAgentId: 'main', at: 1 },
      { id: 't2', role: 'tool', toolCallId: 'c2', content: 'err', isError: true, sourceAgentId: 'main', at: 2 },
    ]
    const captured: AfterToolExecutionContext[] = []
    const out = await callHook<AfterToolExecutionContext, { transformedResults: ToolTurn[] }>(async (c) => {
      captured.push(c)
      return { transformedResults: results.slice(0, 1) }
    }, { turnId: 't', stepNumber: 5, signal: undefined, toolResults: results, errorCount: 1 }, 'afterToolExecution')
    expect(captured[0]!.errorCount).toBe(1)
    expect(out?.transformedResults).toHaveLength(1)
  })
})
