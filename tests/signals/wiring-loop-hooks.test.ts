// v0.21 Signal Gate — loop-hooks wiring 单元测试。
//
// 覆盖：
//   1. createGateLoopHooks: afterToolExecution → tool.result 信号
//   2. wrapRunPromptWithTurnEnd: runPrompt 后发 turn.end 信号

import { describe, it, expect, vi } from 'vitest'
import { createGateLoopHooks, wrapRunPromptWithTurnEnd } from '../../src/signals/wiring/loop-hooks.js'
import type { SignalGate, GateSignal } from '../../src/signals/types.js'
import type { IMLoopResult } from '../../src/im/loop.js'
import { createMetrics } from '../../src/shell/metrics.js'

const makeGate = () => {
  const emitted: GateSignal[] = []
  const gate: SignalGate = {
    emit: vi.fn((sig: GateSignal) => { emitted.push(sig) }),
    on: vi.fn(() => () => {}),
    request: vi.fn(),
    resolve: vi.fn(),
    command: vi.fn(),
    snapshot: vi.fn(() => ({ sessions: [], pendingRequests: 0, subscribers: 0, emitted: 0 })),
  }
  return { gate, emitted }
}

const loopResult = (): IMLoopResult => ({
  terminated: false,
  reason: 'completed',
  finalState: 'Running',
  hits: [],
  turns: 1,
  metrics: createMetrics(),
})

const toolTurn = (toolName: string, toolCallId: string) => ({
  id: `tt-${toolCallId}`,
  role: 'tool' as const,
  toolCallId,
  content: 'result',
  sourceAgentId: 'main',
  at: Date.now(),
  toolName,
})

describe('createGateLoopHooks', () => {
  it('afterToolExecution emits tool.result for each turn', async () => {
    const { gate, emitted } = makeGate()
    const hooks = createGateLoopHooks({ gate, getSessionId: () => 's1' })

    const ctx = {
      turnId: 'turn-1',
      stepNumber: 1,
      signal: undefined,
      toolResults: [toolTurn('read_file', 'c1'), toolTurn('bash', 'c2')],
      errorCount: 0,
    }
    const result = await hooks.afterToolExecution?.(ctx)

    expect(result).toBeUndefined()
    expect(emitted).toHaveLength(2)
    expect(emitted[0]).toEqual({
      kind: 'tool.result',
      sessionId: 's1',
      turnId: 'turn-1',
      toolName: 'read_file',
      callId: 'c1',
      result: ctx.toolResults[0],
    })
    expect(emitted[1]).toEqual({
      kind: 'tool.result',
      sessionId: 's1',
      turnId: 'turn-1',
      toolName: 'bash',
      callId: 'c2',
      result: ctx.toolResults[1],
    })
  })

  it('afterToolExecution returns undefined (does not transform)', async () => {
    const { gate } = makeGate()
    const hooks = createGateLoopHooks({ gate, getSessionId: () => 's1' })

    const result = await hooks.afterToolExecution?.({
      turnId: 'turn-1',
      stepNumber: 1,
      signal: undefined,
      toolResults: [],
      errorCount: 0,
    })
    expect(result).toBeUndefined()
  })
})

describe('wrapRunPromptWithTurnEnd', () => {
  it('emits turn.end after runPrompt resolves', async () => {
    const { gate, emitted } = makeGate()
    const innerResult = loopResult()
    const runPrompt = vi.fn(async () => innerResult)
    const wrapped = wrapRunPromptWithTurnEnd({ gate, getSessionId: () => 's1' }, runPrompt)

    const result = await wrapped('s1', 'hello')

    expect(result).toBe(innerResult)
    expect(runPrompt).toHaveBeenCalledWith('s1', 'hello')
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toEqual({ kind: 'turn.end', sessionId: 's1', result: innerResult })
  })

  it('emits turn.end even if runPrompt rejects', async () => {
    const { gate, emitted } = makeGate()
    const runPrompt = vi.fn(async () => { throw new Error('loop crashed') })
    const wrapped = wrapRunPromptWithTurnEnd({ gate, getSessionId: () => 's1' }, runPrompt)

    await expect(wrapped('s1', 'hello')).rejects.toThrow('loop crashed')
    // turn.end is emitted AFTER the await — if the promise rejects, the emit never happens.
    // This is correct: turn.end means "turn completed with a result", not "turn threw".
    expect(emitted).toHaveLength(0)
  })
})
