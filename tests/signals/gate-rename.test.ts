// v0.26 Wave A — session.rename 命令路由单测（仿 gate-waveb-commands.test.ts 款式）。
//
// 覆盖：
//   1. handler 提供时 → 正确路由（id/title 原样透传，sessionId 计入观察集）
//   2. handler 缺省时 → 干净英文错误（optional handler，getArtifact 先例）

import { describe, it, expect, vi } from 'vitest'

import { createSignalGate } from '../../src/signals/gate.js'
import type { SignalGateHandlers } from '../../src/signals/types.js'

const makeHandlers = (rename: SignalGateHandlers['session']['rename']): SignalGateHandlers => ({
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
    ...(rename !== undefined ? { rename } : {}),
  },
  cancel: vi.fn((_sessionId: string) => {}),
  setFullPermission: vi.fn((_sessionId: string, _enabled: boolean) => {}),
})

describe('SignalGate session.rename (v0.26 Wave A /title)', () => {
  it('routes to handlers.session.rename with id/title verbatim; sessionId enters the observed set', async () => {
    const rename = vi.fn(async (_id: string, _title: string) => {})
    const gate = createSignalGate({ handlers: makeHandlers(rename) })

    await gate.command({ kind: 'session.rename', sessionId: 's1', title: '新标题' })

    expect(rename).toHaveBeenCalledTimes(1)
    expect(rename).toHaveBeenCalledWith('s1', '新标题')
    expect(gate.snapshot().sessions).toContain('s1')
  })

  it('rejects with a clean error when the handler is not provided', async () => {
    const gate = createSignalGate({ handlers: makeHandlers(undefined) })

    await expect(
      gate.command({ kind: 'session.rename', sessionId: 's1', title: 'x' }),
    ).rejects.toThrow(/session\.rename.*requires a session\.rename handler/)
  })
})
