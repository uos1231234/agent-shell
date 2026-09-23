// v0.21 webshell 集成测试：真实 HTTP+WS server × 真实 ws 客户端。
//
// 覆盖计划 DoD 的"端到端验证（无前端）"项：
//   - /healthz 免鉴权
//   - /api/v1/cmd 鉴权（401 / 200）
//   - WS 连接（子协议 token）→ ready → gate.emit → 客户端收 event 帧
//   - 审批闭环：gate.request → WS 收到 approval 请求 → REST approval.decision
//     → request promise resolve 'approved'

import { describe, it, expect } from 'vitest'
import WebSocket from 'ws'

import { createSignalGate, type SignalGate } from '../../src/signals/index.js'
import { createWebShellServer } from '../../src/webshell/index.js'

type TestRig = {
  gate: SignalGate
  server: Awaited<ReturnType<typeof createWebShellServer>>
  base: string
  wsUrl: string
}

const rigWith = async (handlers?: Partial<Parameters<typeof createSignalGate>[0]['handlers']>, distDir?: string): Promise<TestRig> => {
  const gate = createSignalGate({
    handlers: {
      runPrompt: handlers?.runPrompt ?? (async () => {
        throw new Error('not implemented')
      }),
      cancel: handlers?.cancel ?? (() => {}),
      setFullPermission: handlers?.setFullPermission ?? (() => {}),
      session: {
        create: handlers?.session?.create ?? (async () => {
          throw new Error('not implemented')
        }),
        open: handlers?.session?.open ?? (async () => {
          throw new Error('not implemented')
        }),
        list: handlers?.session?.list ?? (async () => []),
        close: handlers?.session?.close ?? (async () => {}),
        delete: handlers?.session?.delete ?? (async () => {}),
        history: handlers?.session?.history ?? (async () => []),
      },
    },
  })
  const server = await createWebShellServer({
    gate,
    port: 0,
    host: '127.0.0.1',
    ...(distDir !== undefined ? { distDir } : {}),
  })
  const base = `http://127.0.0.1:${server.port}`
  return { gate, server, base, wsUrl: `ws://127.0.0.1:${server.port}/api/v1/ws` }
}

const waitOpen = (ws: WebSocket): Promise<void> =>
  new Promise((resolveOpen, rejectOpen) => {
    ws.once('open', resolveOpen)
    ws.once('error', rejectOpen)
  })

const waitFrame = (ws: WebSocket, type: string): Promise<Record<string, unknown>> =>
  new Promise((resolveFrame, rejectFrame) => {
    const timer = setTimeout(() => rejectFrame(new Error(`timeout waiting frame "${type}"`)), 3000)
    ws.on('message', (data: Buffer) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>
      if (frame.type === type) {
        clearTimeout(timer)
        resolveFrame(frame)
      }
    })
  })

describe('webshell server', () => {
  it('GET /healthz answers ok without auth', async () => {
    const rig = await rigWith()
    try {
      const res = await fetch(`${rig.base}/healthz`)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('ok')
    } finally {
      await rig.server.close()
    }
  })

  it('POST /api/v1/cmd rejects without bearer token and accepts with it', async () => {
    const rig = await rigWith()
    try {
      const noAuth = await fetch(`${rig.base}/api/v1/cmd`, {
        method: 'POST',
        body: JSON.stringify({ kind: 'session.list' }),
      })
      expect(noAuth.status).toBe(401)

      const authed = await fetch(`${rig.base}/api/v1/cmd`, {
        method: 'POST',
        headers: { authorization: `Bearer ${rig.server.token}` },
        body: JSON.stringify({ kind: 'session.list' }),
      })
      expect(authed.status).toBe(200)
      const body = (await authed.json()) as { ok: boolean; result: unknown[] }
      expect(body.ok).toBe(true)
      expect(body.result).toEqual([])
    } finally {
      await rig.server.close()
    }
  })

  it('WS: authorized client receives ready then gate events; unauthorized is rejected', async () => {
    const rig = await rigWith()
    try {
      // 未授权：不带子协议 token → 握手被拒。
      const bad = new WebSocket(rig.wsUrl)
      await expect(waitOpen(bad)).rejects.toBeTruthy()
      // waitOpen 失败后要等 error 事件消费完再关闭。
      bad.terminate()

      // 授权：子协议携带 token。
      const ws = new WebSocket(rig.wsUrl, [`agent-shell.bearer.${rig.server.token}`])
      await waitOpen(ws)
      ws.send(JSON.stringify({ type: 'subscribe' }))
      const ready = await waitFrame(ws, 'ready')
      expect(typeof ready.seq).toBe('number')

      rig.gate.emit({
        kind: 'assistant.delta',
        sessionId: 's1',
        turnId: 'turn-1',
        text: 'hello',
      })
      const event = await waitFrame(ws, 'event')
      const signal = event.signal as { kind: string; text?: string }
      expect(signal.kind).toBe('assistant.delta')
      expect(signal.text).toBe('hello')
      ws.close()
    } finally {
      await rig.server.close()
    }
  })

  it('approval loop: gate.request broadcasts over WS and resolves via REST decision', async () => {
    const rig = await rigWith({
      runPrompt: async () => {
        const decision = (await rig.gate.request({
          kind: 'approval',
          payload: { toolName: 'write', args: { path: '/tmp/x' }, reason: 'test write' },
          sessionId: 's1',
        })) as string
        return decision as unknown as import('../../src/im/loop.js').IMLoopResult
      },
    })
    try {
      const ws = new WebSocket(rig.wsUrl, [`agent-shell.bearer.${rig.server.token}`])
      await waitOpen(ws)
      ws.send(JSON.stringify({ type: 'subscribe' }))
      await waitFrame(ws, 'ready')

      // 发 user.prompt（异步跑——runPrompt 内部挂起等审批）。
      const cmdPromise = fetch(`${rig.base}/api/v1/cmd`, {
        method: 'POST',
        headers: { authorization: `Bearer ${rig.server.token}` },
        body: JSON.stringify({ kind: 'user.prompt', sessionId: 's1', text: 'hi' }),
      })

      // WS 上收到 approval 请求帧 → 提取 requestId → REST 回批准。
      const requestFrame = await waitFrame(ws, 'event')
      const signal = requestFrame.signal as { kind: string; requestId?: string }
      expect(signal.kind).toBe('approval')
      expect(signal.requestId).toBeTruthy()

      const decision = await fetch(`${rig.base}/api/v1/cmd`, {
        method: 'POST',
        headers: { authorization: `Bearer ${rig.server.token}` },
        body: JSON.stringify({
          kind: 'approval.decision',
          requestId: signal.requestId,
          decision: 'approved',
        }),
      })
      expect(decision.status).toBe(200)

      // user.prompt 的回执 = runPrompt 的返回（= 审批结果）。
      const cmdResponse = await cmdPromise
      const cmdBody = (await cmdResponse.json()) as { ok: boolean; result: unknown }
      expect(cmdBody.ok).toBe(true)
      expect(cmdBody.result).toBe('approved')
      ws.close()
    } finally {
      await rig.server.close()
    }
  })

  it('static fallback: index serves without auth (v0.22), api still requires bearer; 404 when no distDir', async () => {
    // 无 distDir → 404（不是 401）。
    const rig = await rigWith()
    try {
      const noDist = await fetch(`${rig.base}/`)
      expect(noDist.status).toBe(404)
    } finally {
      await rig.server.close()
    }

    // 有 distDir：index 免鉴权 200；/api/v1/cmd 无 token 仍 401。
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dist = mkdtempSync(join(tmpdir(), 'webshell-static-'))
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>t</title>')
    const rig2 = await rigWith(undefined, dist)
    try {
      const index = await fetch(`${rig2.base}/`)
      expect(index.status).toBe(200)
      expect(await index.text()).toContain('<!doctype html>')
      const api = await fetch(`${rig2.base}/api/v1/cmd`, { method: 'POST', body: '{}' })
      expect(api.status).toBe(401)
    } finally {
      await rig2.server.close()
      rmSync(dist, { recursive: true, force: true })
    }
  })
})
