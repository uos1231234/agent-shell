// v0.21 Signal Gate — assemble (wireSessionToGate + mergeLoopHooks) 单元测试。
//
// 覆盖：
//   1. wireSessionToGate 返回完整 wiring 对象
//   2. onStreamChunk 经 bridge 转发 delta 信号
//   3. gateHooks.afterToolExecution 转发 tool.result 信号
//   4. requestHandler 路由 request_user_input
//   5. dispose 清理全部订阅
//   6. mergeLoopHooks 合并宿主与 gate 的 hooks

import { describe, it, expect, vi } from 'vitest'
import { wireSessionToGate, mergeLoopHooks } from '../../src/signals/assemble.js'
import { createSignalGate } from '../../src/signals/gate.js'
import type { SignalGate, GateSignal, GateRequest } from '../../src/signals/types.js'
import type { LoopHooks } from '../../src/im/loop-hooks.js'
import type { IMLoopResult } from '../../src/im/loop.js'
import type { StreamChunk } from '../../src/protocol/types.js'
import { createMetrics } from '../../src/shell/metrics.js'

const loopResult = (): IMLoopResult => ({
  terminated: false,
  reason: 'completed',
  finalState: 'Running',
  hits: [],
  turns: 1,
  metrics: createMetrics(),
})

const makeGate = (): SignalGate =>
  createSignalGate({
    handlers: {
      runPrompt: vi.fn(async () => loopResult()),
      session: {
        create: vi.fn(async () => ({ id: 'new', title: 't', createdAt: 1, workDir: '' } as never)),
        open: vi.fn(async () => ({ id: 'opened', title: 't', createdAt: 1, workDir: '' } as never)),
        list: vi.fn(async () => []),
        close: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
        history: vi.fn(async () => [] as const),
      },
      cancel: vi.fn(),
      setFullPermission: vi.fn(),
    },
  })

describe('wireSessionToGate', () => {
  it('returns all wiring fields', () => {
    const gate = makeGate()
    const wiring = wireSessionToGate({ gate, sessionId: 's1' })

    expect(typeof wiring.onStreamChunk).toBe('function')
    expect(typeof wiring.gateHooks.afterToolExecution).toBe('function')
    expect(typeof wiring.requestHandler).toBe('function')
    expect(typeof wiring.approvalHandler).toBe('function')
    expect(typeof wiring.dispose).toBe('function')
  })

  it('onStreamChunk emits assistant.delta through gate', () => {
    const gate = makeGate()
    const emitted: Array<GateSignal | GateRequest> = []
    gate.on('*', (sig) => emitted.push(sig))
    const wiring = wireSessionToGate({ gate, sessionId: 's1' })

    const chunk: StreamChunk = { type: 'content_delta', text: 'hello' }
    wiring.onStreamChunk('turn-1', chunk)

    const assistantDeltas = emitted.filter((s) => s.kind === 'assistant.delta')
    expect(assistantDeltas).toHaveLength(1)
    expect((assistantDeltas[0] as { text: string }).text).toBe('hello')
  })

  it('gateHooks.afterToolExecution emits tool.result', async () => {
    const gate = makeGate()
    const emitted: Array<GateSignal | GateRequest> = []
    gate.on('*', (sig) => emitted.push(sig))
    const wiring = wireSessionToGate({ gate, sessionId: 's1' })

    const ctx = {
      turnId: 'turn-1',
      stepNumber: 1,
      signal: undefined,
      toolResults: [{
        id: 'tt1',
        role: 'tool' as const,
        toolCallId: 'c1',
        content: 'ok',
        sourceAgentId: 'main',
        at: Date.now(),
        toolName: 'read_file',
      }],
      errorCount: 0,
    }
    await wiring.gateHooks.afterToolExecution?.(ctx)

    const toolResults = emitted.filter((s) => s.kind === 'tool.result')
    expect(toolResults).toHaveLength(1)
  })

  it('requestHandler routes request_user_input', async () => {
    const gate = makeGate()
    const wiring = wireSessionToGate({ gate, sessionId: 's1' })

    // Simulate front end answering immediately.
    let capturedRequestId = ''
    gate.on('ask_user', (sig) => {
      if (sig.kind === 'ask_user') {
        capturedRequestId = sig.requestId
        // Auto-resolve to simulate front end answer.
        setTimeout(() => gate.resolve(capturedRequestId, { answers: ['A'] }), 0)
      }
    })

    const result = await wiring.requestHandler('request_user_input', {
      questions: [{ question: 'Q?' }],
    })
    expect(result).toEqual({ answers: ['A'] })
  })

  it('requestHandler rejects unknown kind', async () => {
    const gate = makeGate()
    const wiring = wireSessionToGate({ gate, sessionId: 's1' })

    await expect(wiring.requestHandler('unknown_kind', {})).rejects.toThrow(/unknown requestHandler kind/)
  })

  it('dispose clears disposers array', () => {
    const gate = makeGate()
    const wiring = wireSessionToGate({ gate, sessionId: 's1' })

    // Should not throw and should be idempotent.
    wiring.dispose()
    wiring.dispose()
  })
})

describe('mergeLoopHooks', () => {
  it('returns gateHooks when own is undefined', () => {
    const gateHooks: LoopHooks = {
      afterToolExecution: vi.fn(),
    }
    const merged = mergeLoopHooks(undefined, gateHooks)
    expect(merged).toBe(gateHooks)
  })

  it('afterToolExecution runs owner first then gate', async () => {
    const callOrder: string[] = []
    const own: LoopHooks = {
      afterToolExecution: async (ctx) => {
        callOrder.push('own')
        return { transformedResults: ctx.toolResults }
      },
    }
    const gateHooks: LoopHooks = {
      afterToolExecution: async () => {
        callOrder.push('gate')
        return undefined
      },
    }
    const merged = mergeLoopHooks(own, gateHooks)

    const ctx = {
      turnId: 't1',
      stepNumber: 1,
      signal: undefined,
      toolResults: [],
      errorCount: 0,
    }
    await merged.afterToolExecution?.(ctx)

    expect(callOrder).toEqual(['own', 'gate'])
  })

  it('other hooks use own directly (no gate version)', () => {
    const own: LoopHooks = {
      beforeShellCall: vi.fn(),
      afterShellCall: vi.fn(),
      afterGuards: vi.fn(),
    }
    const gateHooks: LoopHooks = {}
    const merged = mergeLoopHooks(own, gateHooks)

    expect(merged.beforeShellCall).toBe(own.beforeShellCall)
    expect(merged.afterShellCall).toBe(own.afterShellCall)
    expect(merged.afterGuards).toBe(own.afterGuards)
  })
})
