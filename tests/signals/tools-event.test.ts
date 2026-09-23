// tools-event.test.ts — v0.28: session.event 'tools' 事件经 gate 的通路契约。
// session.event 是自由事件通道（event: string），gate 不认识具体 event 名——
// 本测试验证 emit/on 对 'tools' event 的透传（含 data payload 原样到达）。

import { describe, it, expect } from 'vitest'
import { createSignalGate } from '../../src/signals/gate.js'
import type { SignalGateHandlers, SessionToolsPayload } from '../../src/signals/index.js'

const makeHandlers = (): SignalGateHandlers => ({
  runPrompt: async () => {
    throw new Error('not used in this test')
  },
  session: {
    create: async () => {
      throw new Error('not used')
    },
    open: async () => {
      throw new Error('not used')
    },
    list: async () => [],
    close: async () => {},
    delete: async () => {},
    history: async () => [],
  },
  cancel: () => {},
  setFullPermission: () => {},
})

describe("session.event 'tools' passthrough", () => {
  it("delivers an emitted 'tools' event with its payload to session.event subscribers", () => {
    const gate = createSignalGate({ handlers: makeHandlers() })
    const payload: SessionToolsPayload = {
      tools: [
        { name: 'read', description: 'Read a file with 1-based line numbers.' },
        { name: 'edit', description: 'Replace unique text in a file.' },
      ],
    }

    const received: { event: string; data: unknown }[] = []
    gate.on('session.event', (sig) => {
      if (sig.kind === 'session.event') received.push({ event: sig.event, data: sig.data })
    })

    gate.emit({ kind: 'session.event', sessionId: 's1', event: 'tools', data: payload })

    expect(received).toHaveLength(1)
    expect(received[0]!.event).toBe('tools')
    expect(received[0]!.data).toEqual(payload)
    // data 契约：{ name, description } 数组，纪律文本原样透传
    const tools = (received[0]!.data as SessionToolsPayload).tools
    expect(tools.map((t) => t.name)).toEqual(['read', 'edit'])
    expect(tools[1]!.description).toBe('Replace unique text in a file.')
  })
})
