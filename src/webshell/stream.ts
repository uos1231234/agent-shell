// v0.21 Web Shell — WS 事件流（Gate 出站信号 → WS 帧）。
//
// 断线恢复模型（§7 已拍板：内存 seq 游标 + 越界全量重拉，不落盘 journal）：
//   - 每条出站信号带单调 seq；服务端维护一个 ring buffer（默认 500 帧）。
//   - 客户端连接后发 {type:'subscribe', cursors?: {sessionId: seq}} →
//     服务端从 buffer 回放 cursors 之后的帧；buffer 不够（有空洞）→ 发
//     {type:'resync'} 让客户端走 /api/v1/snapshot 全量重拉。
//   - 心跳：server 每 30s ping；两周期无 pong 断开（ws 库自动处理协议层
//     pong，这里只发 ping）。
//
// 帧格式（服务端→客户端）：
//   {type:'ready', seq}
//   {type:'event', seq, signal}            — GateSignal / GateRequest
//   {type:'resync', from: seq}             — 游标越界，要求全量重拉
// 帧格式（客户端→服务端）：
//   {type:'subscribe', cursors?: Record<sessionId, seq>}

import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { SignalGate, GateSignal, GateRequest } from '../signals/index.js'

export type WebShellStreamOptions = {
  gate: SignalGate
  /** 连接鉴权（子协议 token）；非法连接直接关闭。 */
  authorize: (req: IncomingMessage) => boolean
  /** ring buffer 容量（默认 500）。 */
  bufferSize?: number
  /** 心跳间隔 ms（默认 30000）。 */
  heartbeatMs?: number
}

export type WebShellStream = {
  wss: WebSocketServer
  close(): Promise<void>
}

const DEFAULT_BUFFER_SIZE = 500
const DEFAULT_HEARTBEAT_MS = 30_000

export const createWebShellStream = (opts: WebShellStreamOptions): WebShellStream => {
  const wss = new WebSocketServer({ noServer: true })
  const bufferSize = opts.bufferSize ?? DEFAULT_BUFFER_SIZE
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS

  // 全局信号 ring buffer（跨连接共享；seq 全局单调）。
  const buffer: Array<{ seq: number; signal: GateSignal | GateRequest }> = []
  let seq = 0

  // Gate 出站 → seq 标注 → 广播给全部已订阅连接 + 进 buffer。
  const unsubscribe = opts.gate.on('*', (signal) => {
    seq += 1
    const frame = { seq, signal }
    buffer.push(frame)
    if (buffer.length > bufferSize) buffer.shift()
    const payload = JSON.stringify({ type: 'event', seq, signal })
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload)
    }
  })

  wss.on('connection', (ws: WebSocket) => {
    let alive = true
    ws.on('pong', () => {
      alive = true
    })
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate()
        clearInterval(heartbeat)
        return
      }
      alive = false
      ws.ping()
    }, heartbeatMs)
    ws.on('close', () => clearInterval(heartbeat))
    ws.on('error', () => ws.terminate())

    ws.on('message', (data: unknown) => {
      let msg: { type?: string; cursors?: Record<string, number> }
      try {
        msg = JSON.parse(String(data)) as typeof msg
      } catch {
        return
      }
      if (msg.type !== 'subscribe') return
      // ready 帧：当前水位。
      ws.send(JSON.stringify({ type: 'ready', seq }))
      const cursors = msg.cursors ?? {}
      const entries = [...buffer]
      // 找出需要回放的帧：seq 大于该会话游标的帧。
      const relevant = entries.filter((f) => {
        const sid = (f.signal as { sessionId?: string }).sessionId
        if (sid === undefined) return true // 无会话归属的信号（log 等）总是回放
        const cursor = cursors[sid]
        return cursor === undefined || f.seq > cursor
      })
      // 空洞检测：若某会话游标处的帧已被挤出 buffer（buffer 里最老的相关帧
      // seq 仍小于游标+1 的缺失窗口无法判断精确空洞——简化：游标存在但
      // buffer 中的全局最老 seq 大于游标+1，说明中间可能丢失 → resync）。
      const oldest = entries[0]?.seq ?? seq + 1
      const hasGap = Object.values(cursors).some((c) => oldest > c + 1)
      if (hasGap) {
        ws.send(JSON.stringify({ type: 'resync', from: oldest }))
        return
      }
      for (const f of relevant) {
        ws.send(JSON.stringify({ type: 'event', seq: f.seq, signal: f.signal }))
      }
    })
  })

  return {
    wss,
    close: (): Promise<void> =>
      new Promise((resolveClose) => {
        unsubscribe()
        for (const client of wss.clients) client.terminate()
        wss.close(() => resolveClose())
      }),
  }
}
