// v0.21 Signal Gate — createSignalGate 单元测试。
//
// 覆盖任务点名的五组行为：
//   1. emit/on：kind 过滤 + unsubscribe + '*' 通配 + 订阅者 throw 隔离
//   2. request/resolve：审批请求广播 → resolve 回包
//   3. request 超时：默认 300s fail-closed（fake timers）+ per-request 覆盖
//   4. command：user.prompt → runPrompt；session.list → session.list；
//      approval.decision / ask_user.answer 回包联动；cancel/revoke/full
//   5. snapshot：观察到的 session / 挂起请求 / 订阅数 / 发射数

import { describe, it, expect, vi } from 'vitest'

import { createSignalGate } from '../../src/signals/gate.js'
import type { GateSignal, SignalGateHandlers, WorkspaceReadResult } from '../../src/signals/types.js'
import type { IMLoopResult } from '../../src/im/loop.js'
import { createMetrics } from '../../src/shell/metrics.js'
import type { ApprovalRequest } from '../../src/im/tools/security/approval-store.js'

const loopResult = (): IMLoopResult => ({
  terminated: false,
  reason: 'completed',
  finalState: 'Running',
  hits: [],
  turns: 1,
  metrics: createMetrics(),
})

/** 最小 handlers mock：只让测试路由到的成员有实现，其余 throw（never 分支）；
 *  optional 成员（getArtifact / readWorkspaceFile / provider…）按需注入。 */
const makeHandlers = (optional: Partial<SignalGateHandlers> = {}): SignalGateHandlers => ({
  runPrompt: vi.fn(async (_sessionId: string, _text: string) => loopResult()),
  session: {
    create: vi.fn(async () => {
      throw new Error('create: not implemented in tests')
    }),
    open: vi.fn(async () => {
      throw new Error('open: not implemented in tests')
    }),
    list: vi.fn(async () => []),
    close: vi.fn(async (_id: string) => {}),
    delete: vi.fn(async (_id: string) => {}),
    history: vi.fn(async (_id: string) => [] as const),
  },
  cancel: vi.fn((_sessionId: string) => {}),
  setFullPermission: vi.fn((_sessionId: string, _enabled: boolean) => {}),
  ...optional,
})

const approvalPayload = (): ApprovalRequest => ({
  toolName: 'bash',
  args: { command: 'ls -la' },
  reason: 'dangerous command requires approval',
})

const delta = (text: string): GateSignal => ({
  kind: 'assistant.delta',
  sessionId: 's1',
  turnId: 't1',
  text,
})

// ============================================================================
// 1. emit / on
// ============================================================================

describe('SignalGate emit/on', () => {
  it('delivers an emitted signal to subscribers of that kind', () => {
    const gate = createSignalGate({ handlers: makeHandlers() })
    const received: string[] = []
    gate.on('assistant.delta', (sig) => {
      if (sig.kind === 'assistant.delta') received.push(sig.text)
    })
    gate.emit(delta('he'))
    gate.emit(delta('llo'))
    expect(received).toEqual(['he', 'llo'])
  })

  it('filters by kind: each subscriber only receives its own kind', () => {
    const gate = createSignalGate({ handlers: makeHandlers() })
    const deltas: string[] = []
    const results: string[] = []
    gate.on('assistant.delta', (sig) => {
      if (sig.kind === 'assistant.delta') deltas.push(sig.text)
    })
    gate.on('tool.result', (sig) => {
      if (sig.kind === 'tool.result') results.push(sig.toolName)
    })
    gate.emit(delta('x'))
    gate.emit({ kind: 'thinking.delta', sessionId: 's1', turnId: 't1', text: 'y' })
    gate.emit({
      kind: 'tool.result',
      sessionId: 's1',
      turnId: 't1',
      toolName: 'read_file',
      callId: 'c1',
      result: {
        id: 'tt1',
        role: 'tool',
        toolCallId: 'c1',
        content: 'file body',
        sourceAgentId: 'main',
        at: 1,
        toolName: 'read_file',
      },
    })
    expect(deltas).toEqual(['x'])
    expect(results).toEqual(['read_file'])
  })

  it('stops delivering after unsubscribe', () => {
    const gate = createSignalGate({ handlers: makeHandlers() })
    const received: string[] = []
    const off = gate.on('assistant.delta', (sig) => {
      if (sig.kind === 'assistant.delta') received.push(sig.text)
    })
    gate.emit(delta('a'))
    off()
    gate.emit(delta('b'))
    expect(received).toEqual(['a'])
  })

  it("'*' wildcard receives every kind, including requests", () => {
    const gate = createSignalGate({ handlers: makeHandlers() })
    const kinds: string[] = []
    gate.on('*', (sig) => {
      kinds.push(sig.kind)
    })
    gate.emit(delta('x'))
    gate.emit({ kind: 'log', level: 'info', msg: 'hi', ts: 1 })
    void gate.request({ kind: 'approval', payload: approvalPayload() })
    expect(kinds).toEqual(['assistant.delta', 'log', 'approval'])
  })

  it('a throwing subscriber does not break broadcast to other subscribers', () => {
    const gate = createSignalGate({ handlers: makeHandlers() })
    const received: string[] = []
    gate.on('assistant.delta', () => {
      throw new Error('boom')
    })
    gate.on('assistant.delta', (sig) => {
      if (sig.kind === 'assistant.delta') received.push(sig.text)
    })
    gate.emit(delta('a'))
    expect(received).toEqual(['a'])
  })
})

// ============================================================================
// 2. request / resolve
// ============================================================================

describe('SignalGate request/resolve', () => {
  it('broadcasts the request with a requestId, then resolves with the reply payload', async () => {
    const gate = createSignalGate({ handlers: makeHandlers() })
    const seen: { requestId: string; payload: ApprovalRequest }[] = []
    gate.on('approval', (req) => {
      if (req.kind === 'approval') seen.push({ requestId: req.requestId, payload: req.payload })
    })

    const p = gate.request({ kind: 'approval', payload: approvalPayload() })

    // 请求同步广播，且带 gate 生成的 requestId。
    expect(seen).toHaveLength(1)
    expect(seen[0]!.requestId).toMatch(/^req-/)
    expect(seen[0]!.payload).toMatchObject({ toolName: 'bash' })

    gate.resolve(seen[0]!.requestId, 'approved')
    await expect(p).resolves.toBe('approved')
  })

  it('ignores an unknown (late) requestId instead of throwing', () => {
    const gate = createSignalGate({ handlers: makeHandlers() })
    expect(() => gate.resolve('req-nope', 'approved')).not.toThrow()
  })
})

// ============================================================================
// 3. request 超时（fail-closed）
// ============================================================================

describe('SignalGate request timeout', () => {
  it('rejects with a timeout error after the default 300s when never resolved', async () => {
    vi.useFakeTimers()
    try {
      const gate = createSignalGate({ handlers: makeHandlers() })
      gate.on('approval', () => {}) // 前端收到但不回包
      const p = gate.request({ kind: 'approval', payload: approvalPayload() })
      const assertion = expect(p).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(300_000)
      await assertion
      // 超时后挂起表清空。
      expect(gate.snapshot().pendingRequests).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('honours a per-request timeoutMs override', async () => {
    vi.useFakeTimers()
    try {
      const gate = createSignalGate({ handlers: makeHandlers() })
      gate.on('ask_user', () => {})
      const p = gate.request({ kind: 'ask_user', payload: { questions: [{ question: 'Q?' }] } }, { timeoutMs: 5_000 })
      const assertion = expect(p).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(5_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

// ============================================================================
// 4. command 路由
// ============================================================================

describe('SignalGate command', () => {
  it('routes user.prompt to handlers.runPrompt', async () => {
    const handlers = makeHandlers()
    const gate = createSignalGate({ handlers })
    const out = await gate.command({ kind: 'user.prompt', sessionId: 's1', text: 'hello' })
    expect(handlers.runPrompt).toHaveBeenCalledWith('s1', 'hello')
    expect(out).toMatchObject({ reason: 'completed' })
  })

  it('routes session.list to handlers.session.list', async () => {
    const handlers = makeHandlers()
    const gate = createSignalGate({ handlers })
    const out = await gate.command({ kind: 'session.list' })
    expect(handlers.session.list).toHaveBeenCalledTimes(1)
    expect(out).toEqual([])
  })

  it('routes session.history to handlers.session.history with the session id', async () => {
    const turns = [
      { id: 'u1', role: 'user', content: 'hi', at: 1 },
      { id: 'a1', role: 'assistant', content: 'hello', at: 2 },
    ] as const
    const handlers = makeHandlers()
    ;(handlers.session.history as ReturnType<typeof vi.fn>).mockResolvedValue(turns)
    const gate = createSignalGate({ handlers })
    const out = await gate.command({ kind: 'session.history', sessionId: 's1' })
    expect(handlers.session.history).toHaveBeenCalledWith('s1')
    expect(out).toEqual(turns)
  })

  it('routes approval.decision into the pending approval request', async () => {
    const gate = createSignalGate({ handlers: makeHandlers() })
    let requestId = ''
    gate.on('approval', (req) => {
      if (req.kind === 'approval') requestId = req.requestId
    })
    const p = gate.request({ kind: 'approval', payload: approvalPayload() })
    await gate.command({ kind: 'approval.decision', requestId, decision: 'rejected' })
    await expect(p).resolves.toBe('rejected')
  })

  it('routes ask_user.answer into the pending ask_user request', async () => {
    const gate = createSignalGate({ handlers: makeHandlers() })
    let requestId = ''
    gate.on('ask_user', (req) => {
      if (req.kind === 'ask_user') requestId = req.requestId
    })
    const p = gate.request({ kind: 'ask_user', payload: { questions: [{ question: 'Q?' }] } })
    await gate.command({ kind: 'ask_user.answer', requestId, answers: ['A1'] })
    // 回包组装成 request_user_input.ts 消费契约的 { answers } 形状。
    await expect(p).resolves.toEqual({ answers: ['A1'] })
  })

  it('routes turn.cancel / permission.full to their handlers (per-session)', async () => {
    const handlers = makeHandlers()
    const gate = createSignalGate({ handlers })
    await gate.command({ kind: 'turn.cancel', sessionId: 's9' })
    await gate.command({ kind: 'permission.full', sessionId: 's9', enabled: true })
    expect(handlers.cancel).toHaveBeenCalledWith('s9')
    expect(handlers.setFullPermission).toHaveBeenCalledWith('s9', true)
  })

  it('throws a clean error for artifact.get when no getArtifact handler is configured', async () => {
    const gate = createSignalGate({ handlers: makeHandlers() })
    await expect(gate.command({ kind: 'artifact.get', artifactId: 'a1' })).rejects.toThrow(
      /requires a getArtifact handler/,
    )
  })

  it('routes workspace.read to handlers.readWorkspaceFile with passthrough args', async () => {
    const result: WorkspaceReadResult = {
      path: '.',
      kind: 'dir',
      entries: [{ name: 'a.txt', kind: 'file' }],
    }
    const readWorkspaceFile = vi.fn(async () => result)
    const gate = createSignalGate({ handlers: makeHandlers({ readWorkspaceFile }) })

    const out = await gate.command({ kind: 'workspace.read', sessionId: 's1', path: 'sub/file.txt' })

    expect(readWorkspaceFile).toHaveBeenCalledWith('s1', 'sub/file.txt')
    expect(out).toEqual(result)
  })

  it('throws a clean error for workspace.read when no readWorkspaceFile handler is configured', async () => {
    const gate = createSignalGate({ handlers: makeHandlers() })
    await expect(gate.command({ kind: 'workspace.read', sessionId: 's1', path: '.' })).rejects.toThrow(
      /requires a readWorkspaceFile handler/,
    )
  })
})

// ============================================================================
// 5. snapshot
// ============================================================================

describe('SignalGate snapshot', () => {
  it('reports observed sessions, pending requests, subscribers and emitted count', async () => {
    const handlers = makeHandlers()
    const gate = createSignalGate({ handlers })

    expect(gate.snapshot()).toEqual({
      sessions: [],
      pendingRequests: 0,
      subscribers: 0,
      emitted: 0,
    })

    const off = gate.on('assistant.delta', () => {})
    gate.emit(delta('x'))
    // log 信号不带 sessionId，不计入 sessions。
    gate.emit({ kind: 'log', level: 'info', msg: 'hi', ts: 1 })
    expect(gate.snapshot()).toEqual({
      sessions: ['s1'],
      pendingRequests: 0,
      subscribers: 1,
      emitted: 2,
    })

    let requestId = ''
    gate.on('approval', (req) => {
      if (req.kind === 'approval') requestId = req.requestId
    })
    void gate.request({ kind: 'approval', payload: approvalPayload() })
    expect(gate.snapshot().pendingRequests).toBe(1)
    gate.resolve(requestId, 'approved')
    expect(gate.snapshot().pendingRequests).toBe(0)

    off()
    expect(gate.snapshot().subscribers).toBe(1) // approval 订阅仍在

    // session.close 命令把该 session 移出观察集合。
    await gate.command({ kind: 'session.close', sessionId: 's1' })
    expect(handlers.session.close).toHaveBeenCalledWith('s1')
    expect(gate.snapshot().sessions).toEqual([])
  })
})
