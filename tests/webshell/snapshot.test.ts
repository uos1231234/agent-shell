// v0.21 Web Shell — /api/v1/snapshot 端点测试。
//
// 覆盖：
//   1. 未授权 → 401
//   2. 授权 → 200 + snapshot JSON
//   3. snapshot 内容与 gate.snapshot() 一致

import { describe, it, expect } from 'vitest'
import { createSignalGate, type SignalGate } from '../../src/signals/index.js'
import { createWebShellServer, type WebShellServer } from '../../src/webshell/index.js'
import type { IMLoopResult } from '../../src/im/loop.js'
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
      runPrompt: async () => loopResult(),
      session: {
        create: async () => ({ id: 'new', title: 't', createdAt: 1, workDir: '' } as never),
        open: async () => ({ id: 'opened', title: 't', createdAt: 1, workDir: '' } as never),
        list: async () => [],
        close: async () => {},
        delete: async () => {},
        history: async () => [],
      },
      cancel: () => {},
      setFullPermission: () => {},
    },
  })

describe('/api/v1/snapshot', () => {
  it('returns 401 without auth', async () => {
    const gate = makeGate()
    const web = await createWebShellServer({ gate, port: 0, host: '127.0.0.1' })
    try {
      const res = await fetch(`http://127.0.0.1:${web.port}/api/v1/snapshot`)
      expect(res.status).toBe(401)
    } finally {
      await web.close()
    }
  })

  it('returns snapshot JSON with auth', async () => {
    const gate = makeGate()
    const web = await createWebShellServer({ gate, port: 0, host: '127.0.0.1' })
    try {
      // Emit something to populate snapshot.
      gate.emit({ kind: 'assistant.delta', sessionId: 's1', turnId: 't1', text: 'x' })

      const res = await fetch(`http://127.0.0.1:${web.port}/api/v1/snapshot`, {
        headers: { authorization: `Bearer ${web.token}` },
      })
      expect(res.status).toBe(200)

      const body = (await res.json()) as { ok: boolean; snapshot: { sessions: string[]; emitted: number } }
      expect(body.ok).toBe(true)
      expect(body.snapshot.sessions).toContain('s1')
      expect(body.snapshot.emitted).toBe(1)
    } finally {
      await web.close()
    }
  })

  it('snapshot matches gate.snapshot() directly', async () => {
    const gate = makeGate()
    const web = await createWebShellServer({ gate, port: 0, host: '127.0.0.1' })
    try {
      gate.emit({ kind: 'log', level: 'info', msg: 'test', ts: 1 })

      const res = await fetch(`http://127.0.0.1:${web.port}/api/v1/snapshot`, {
        headers: { authorization: `Bearer ${web.token}` },
      })
      const body = (await res.json()) as { ok: boolean; snapshot: ReturnType<typeof gate.snapshot> }
      expect(body.snapshot).toEqual(gate.snapshot())
    } finally {
      await web.close()
    }
  })
})
