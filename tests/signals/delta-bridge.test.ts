// v0.21 Signal Gate — delta-bridge 单元测试。
//
// 覆盖流式增量 → Gate 出站信号的映射：
//   1. content_delta → assistant.delta（token 级文本）
//   2. tool_call_delta → 首个 delta 发 tool.started；同 index 后续不重复
//   3. finish / usage / done 不产信号
//   4. turn 切换时 per-turn 状态重置

import { describe, it, expect, vi } from 'vitest'
import { createDeltaBridge } from '../../src/signals/wiring/delta-bridge.js'
import type { SignalGate, GateSignal } from '../../src/signals/types.js'
import type { StreamChunk } from '../../src/protocol/types.js'

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

const contentDelta = (text: string): StreamChunk => ({
  type: 'content_delta',
  text,
})

const toolCallDelta = (index: number, name?: string, id?: string): StreamChunk => ({
  type: 'tool_call_delta',
  index,
  name: name ?? 'read_file',
  id: id ?? `call-${index}`,
  arguments_delta: '',
})

const finishChunk: StreamChunk = { type: 'finish', reason: 'stop' }
const doneChunk: StreamChunk = { type: 'done' }

describe('delta-bridge', () => {
  it('content_delta → assistant.delta', () => {
    const { gate, emitted } = makeGate()
    const bridge = createDeltaBridge({ gate, getSessionId: () => 's1' })

    bridge.onStreamChunk('turn-1', contentDelta('hello'))
    bridge.onStreamChunk('turn-1', contentDelta(' world'))

    expect(emitted).toHaveLength(2)
    expect(emitted[0]).toEqual({ kind: 'assistant.delta', sessionId: 's1', turnId: 'turn-1', text: 'hello' })
    expect(emitted[1]).toEqual({ kind: 'assistant.delta', sessionId: 's1', turnId: 'turn-1', text: ' world' })
  })

  it('tool_call_delta first index → tool.started', () => {
    const { gate, emitted } = makeGate()
    const bridge = createDeltaBridge({ gate, getSessionId: () => 's1' })

    bridge.onStreamChunk('turn-1', toolCallDelta(0, 'bash', 'c0'))
    bridge.onStreamChunk('turn-1', toolCallDelta(0, 'bash', 'c0'))

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toEqual({
      kind: 'tool.started',
      sessionId: 's1',
      turnId: 'turn-1',
      toolName: 'bash',
      callId: 'c0',
      args: null,
    })
  })

  it('same tool_call index second time → no duplicate', () => {
    const { gate, emitted } = makeGate()
    const bridge = createDeltaBridge({ gate, getSessionId: () => 's1' })

    bridge.onStreamChunk('turn-1', toolCallDelta(0))
    bridge.onStreamChunk('turn-1', toolCallDelta(0))
    bridge.onStreamChunk('turn-1', toolCallDelta(0))

    expect(emitted).toHaveLength(1)
  })

  it('different tool_call index → separate tool.started', () => {
    const { gate, emitted } = makeGate()
    const bridge = createDeltaBridge({ gate, getSessionId: () => 's1' })

    bridge.onStreamChunk('turn-1', toolCallDelta(0, 'read_file'))
    bridge.onStreamChunk('turn-1', toolCallDelta(1, 'bash'))

    expect(emitted).toHaveLength(2)
    expect(emitted[0]!.kind).toBe('tool.started')
    expect((emitted[0] as { toolName: string }).toolName).toBe('read_file')
    expect((emitted[1] as { toolName: string }).toolName).toBe('bash')
  })

  it('finish / usage / done produce no signals', () => {
    const { gate, emitted } = makeGate()
    const bridge = createDeltaBridge({ gate, getSessionId: () => 's1' })

    bridge.onStreamChunk('turn-1', finishChunk)
    bridge.onStreamChunk('turn-1', doneChunk)

    expect(emitted).toHaveLength(0)
  })

  it('turn switch resets per-turn state (same index in new turn emits again)', () => {
    const { gate, emitted } = makeGate()
    const bridge = createDeltaBridge({ gate, getSessionId: () => 's1' })

    bridge.onStreamChunk('turn-1', toolCallDelta(0))
    expect(emitted).toHaveLength(1)

    bridge.onStreamChunk('turn-2', toolCallDelta(0))
    expect(emitted).toHaveLength(2)
    expect((emitted[1] as { turnId: string }).turnId).toBe('turn-2')
  })

  it('getSessionId is read per-call (lazy)', () => {
    let currentSession = 's1'
    const { gate, emitted } = makeGate()
    const bridge = createDeltaBridge({ gate, getSessionId: () => currentSession })

    bridge.onStreamChunk('turn-1', contentDelta('a'))
    currentSession = 's2'
    bridge.onStreamChunk('turn-1', contentDelta('b'))

    expect((emitted[0] as { sessionId: string }).sessionId).toBe('s1')
    expect((emitted[1] as { sessionId: string }).sessionId).toBe('s2')
  })
})
