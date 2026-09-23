// v0.29 Wave B2 — session.fork / session.undo 命令路由单测（仿 gate-rename 款式）。
//
// 覆盖：
//   1. handler 提供时 → 正确路由（sessionId 计入观察集；fork 的回执原样透传）
//   2. handler 缺省时 → 干净英文错误（optional handler，rename 先例）
//   【session.compact 已注释下线（用户拍板 2026-09-08）——不在本文件】

import { describe, it, expect, vi } from 'vitest'

import { createSignalGate } from '../../src/signals/gate.js'
import type { SignalGateHandlers } from '../../src/signals/types.js'
import type { SessionInfo } from '../../src/im/session/types.js'

const forkedInfo: SessionInfo = {
  id: 'fork-uuid',
  title: 'src (fork)',
  workingAgentId: 'main',
  createdAt: 1,
  lastActiveAt: 1,
  turnCount: 0,
  layer: 'M0',
  snapshotExpired: false,
}

const makeHandlers = (
  fork: SignalGateHandlers['session']['fork'],
  undo: SignalGateHandlers['session']['undo'],
): SignalGateHandlers => ({
  runPrompt: vi.fn(async () => {
    throw new Error('runPrompt: not implemented in tests')
  }),
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
    ...(fork !== undefined ? { fork } : {}),
    ...(undo !== undefined ? { undo } : {}),
  },
  cancel: vi.fn((_sessionId: string) => {}),
  setFullPermission: vi.fn((_sessionId: string, _enabled: boolean) => {}),
})

describe('SignalGate session.fork (v0.29 Wave B2 /fork)', () => {
  it('routes to handlers.session.fork; sessionId enters the observed set; receipt passes through', async () => {
    const fork = vi.fn(async (_id: string) => forkedInfo)
    const gate = createSignalGate({ handlers: makeHandlers(fork, undefined) })

    const receipt = await gate.command({ kind: 'session.fork', sessionId: 's1' })

    expect(fork).toHaveBeenCalledTimes(1)
    expect(fork).toHaveBeenCalledWith('s1')
    expect(receipt).toEqual(forkedInfo)
    expect(gate.snapshot().sessions).toContain('s1')
  })

  it('rejects with a clean error when the handler is not provided', async () => {
    const gate = createSignalGate({ handlers: makeHandlers(undefined, undefined) })

    await expect(gate.command({ kind: 'session.fork', sessionId: 's1' })).rejects.toThrow(
      /session\.fork.*requires a session\.fork handler/,
    )
  })
})

describe('SignalGate session.undo (v0.29 Wave B2 /undo)', () => {
  it('routes blocks verbatim; sessionId enters the observed set', async () => {
    const undo = vi.fn(async (_id: string, _blocks: number) => ({ blocks: 2, evicted: 6 }))
    const gate = createSignalGate({ handlers: makeHandlers(undefined, undo) })

    const receipt = await gate.command({ kind: 'session.undo', sessionId: 's1', blocks: 2 })

    expect(undo).toHaveBeenCalledTimes(1)
    expect(undo).toHaveBeenCalledWith('s1', 2)
    expect(receipt).toEqual({ blocks: 2, evicted: 6 })
    expect(gate.snapshot().sessions).toContain('s1')
  })

  it('rejects with a clean error when the handler is not provided', async () => {
    const gate = createSignalGate({ handlers: makeHandlers(undefined, undefined) })

    await expect(gate.command({ kind: 'session.undo', sessionId: 's1', blocks: 1 })).rejects.toThrow(
      /session\.undo.*requires a session\.undo handler/,
    )
  })
})
