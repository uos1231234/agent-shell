// v0.21 Web Shell — stream 断线恢复单元测试。
//
// 覆盖：
//   1. subscribe → ready 帧（seq 水位）
//   2. 缓冲区回放（cursors 之后的帧）
//   3. subscribe without cursors replays all buffered events

import { describe, it, expect, vi } from 'vitest'
import { createSignalGate, type SignalGate } from '../../src/signals/index.js'
import type { IMLoopResult } from '../../src/im/loop.js'
import { createMetrics } from '../../src/shell/metrics.js'
import WebSocket from 'ws'

const loopResult = (): IMLoopResult => ({
  terminated: false,
  reason: 'completed',
  finalState: 'Running',
  hits: [],
  turns: 1,
  metrics: createMetrics(),
})

const waitOpen = (ws: WebSocket): Promise<void> =>
  new Promise((resolveOpen, rejectOpen) => {
    ws.once('open', resolveOpen)
    ws.once('error', rejectOpen)
  })

const waitFrame = (ws: WebSocket, type: string): Promise<Record<string, unknown>> =>
  new Promise((resolveFrame, rejectFrame) => {
    const timer = setTimeout(() => rejectFrame(new Error(`timeout waiting "${type}"`)), 3000)
    ws.on('message', (data: Buffer) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>
      if (frame.type === type) {
        clearTimeout(timer)
        resolveFrame(frame)
      }
    })
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
        history: vi.fn(async () => []),
      },
      cancel: vi.fn(),
      setFullPermission: vi.fn(),
    },
  })

describe('webshell stream', () => {
  it('subscribe returns ready frame with current seq', async () => {
    const gate = makeGate()
    const { createWebShellServer } = await import('../../src/webshell/server.js')
    const web = await createWebShellServer({ gate, port: 0, host: '127.0.0.1' })

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${web.port}/api/v1/ws`, [
        `agent-shell.bearer.${web.token}`,
      ])
      await waitOpen(ws)
      ws.send(JSON.stringify({ type: 'subscribe' }))

      const ready = await waitFrame(ws, 'ready')
      expect(typeof ready.seq).toBe('number')
      ws.close()
    } finally {
      await web.close()
    }
  })

  it('replay: events after cursor are sent', async () => {
    const gate = makeGate()
    const { createWebShellServer } = await import('../../src/webshell/server.js')
    const web = await createWebShellServer({ gate, port: 0, host: '127.0.0.1' })

    try {
      // Emit some events before connecting (goes into ring buffer).
      gate.emit({ kind: 'assistant.delta', sessionId: 's1', turnId: 't1', text: 'a' })
      gate.emit({ kind: 'assistant.delta', sessionId: 's1', turnId: 't1', text: 'b' })

      const ws = new WebSocket(`ws://127.0.0.1:${web.port}/api/v1/ws`, [
        `agent-shell.bearer.${web.token}`,
      ])
      await waitOpen(ws)

      // Collect ALL frames (ready + replayed events) via a single listener set up BEFORE subscribe.
      const allFrames: Array<Record<string, unknown>> = []
      const collectFrame = (data: Buffer) => {
        allFrames.push(JSON.parse(String(data)) as Record<string, unknown>)
      }
      ws.on('message', collectFrame)

      // Subscribe with cursor 0 → server replays events after ready.
      ws.send(JSON.stringify({ type: 'subscribe', cursors: { s1: 0 } }))

      // Wait for ready frame + replayed events to arrive.
      await new Promise((r) => setTimeout(r, 200))

      const readyFrame = allFrames.find((f) => f.type === 'ready')
      expect(readyFrame).toBeDefined()
      expect(readyFrame!.seq).toBe(2)

      const eventFrames = allFrames.filter((f) => f.type === 'event')
      expect(eventFrames).toHaveLength(2)
      expect((eventFrames[0]!.signal as { text: string }).text).toBe('a')
      expect((eventFrames[1]!.signal as { text: string }).text).toBe('b')

      ws.removeListener('message', collectFrame)
      ws.close()
    } finally {
      await web.close()
    }
  })

  it('subscribe without cursors replays all buffered events', async () => {
    const gate = makeGate()
    const { createWebShellServer } = await import('../../src/webshell/server.js')
    const web = await createWebShellServer({ gate, port: 0, host: '127.0.0.1' })

    try {
      // Emit events before connecting.
      gate.emit({ kind: 'assistant.delta', sessionId: 's1', turnId: 't1', text: 'x' })
      gate.emit({ kind: 'assistant.delta', sessionId: 's1', turnId: 't1', text: 'y' })

      const ws = new WebSocket(`ws://127.0.0.1:${web.port}/api/v1/ws`, [
        `agent-shell.bearer.${web.token}`,
      ])
      await waitOpen(ws)

      const allFrames: Array<Record<string, unknown>> = []
      ws.on('message', (data: Buffer) => {
        allFrames.push(JSON.parse(String(data)) as Record<string, unknown>)
      })

      // Subscribe without cursors → all buffered events replayed.
      ws.send(JSON.stringify({ type: 'subscribe' }))

      await new Promise((r) => setTimeout(r, 200))

      const eventFrames = allFrames.filter((f) => f.type === 'event')
      expect(eventFrames).toHaveLength(2)

      ws.close()
    } finally {
      await web.close()
    }
  })
})
