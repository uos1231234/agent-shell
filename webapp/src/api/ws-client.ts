// WS 客户端：连 v0.21 webshell 的 /api/v1/ws。
//
// 帧协议（v0.21 stream.ts）：
//   服务端 → 客户端：{type:'ready', seq} | {type:'event', seq, signal} | {type:'resync', from}
//   客户端 → 服务端：{type:'subscribe', cursors?: Record<sessionId, seq>}
//
// 断线恢复模型（v0.22 拍板）：内存 cursors（每 sessionId 的最大 seq）→ 重连时
// 带 cursors 订阅 → buffer 内 replay 增量；resync 帧（越界）→ 上层走
// session.history + session.list 交错拼装。指数退避重连。

import type { GateCommand } from '@agent-shell/signals'
import { readToken } from './token'

export type WsFrame =
  | { type: 'ready'; seq: number }
  | { type: 'event'; seq: number; signal: unknown }
  | { type: 'resync'; from: number }

export type WsClientOptions = {
  /** 每条 event 帧回调（含 GateSignal / GateRequest）。 */
  onEvent: (signal: unknown, seq: number) => void
  /** 连接状态变化回调（UI 连接徽章）。 */
  onStatus: (status: 'connecting' | 'open' | 'closed') => void
  /** resync 请求回调（越界 → 上层全量恢复）。 */
  onResync: () => void
  /** 发送命令（resync 恢复流程要用 session.history/session.list）。 */
  sendCommand: (cmd: GateCommand) => void
  /** 重连基础延迟 ms（默认 1000，指数退避至 30s 封顶）。 */
  baseRetryMs?: number
}

/**
 * 惰性单例 WS 连接。cursors 在客户端内存里（Record<sessionId, seq>）。
 * app 生命周期内持有一条连接；页面关闭即断（服务端 buffer 内可 replay）。
 */
export const createWsClient = (opts: WsClientOptions) => {
  let ws: WebSocket | null = null
  let closedByUser = false
  let retry = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  /** 每 sessionId 的最大已见 seq（服务端 replay 过滤语义按会话游标）。 */
  const cursors = new Map<string, number>()
  /** 全局最大已见 seq（v0.21 seq 全局单调）：重连 replay 与在线帧去重。 */
  let maxSeenSeq = 0

  const trackCursor = (seq: number, signal: unknown): void => {
    if (seq > maxSeenSeq) maxSeenSeq = seq
    const sid = (signal as { sessionId?: string }).sessionId
    if (sid === undefined) return
    const cur = cursors.get(sid) ?? 0
    if (seq > cur) cursors.set(sid, seq)
  }

  const connect = (): void => {
    const token = readToken()
    if (token === null) {
      opts.onStatus('closed')
      return
    }
    opts.onStatus('connecting')
    // 浏览器 WS 鉴权走 Sec-WebSocket-Protocol 子协议（webshell 约定）。
    ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/api/v1/ws`, [
      `agent-shell.bearer.${token}`,
    ])
    ws.onopen = () => {
      retry = 0
      const cursorObj: Record<string, number> = {}
      for (const [k, v] of cursors) cursorObj[k] = v
      ws?.send(JSON.stringify({ type: 'subscribe', cursors: cursorObj }))
    }
    ws.onmessage = (m: MessageEvent) => {
      let frame: WsFrame
      try {
        frame = JSON.parse(String(m.data)) as WsFrame
      } catch {
        return
      }
      if (frame.type === 'ready') {
        opts.onStatus('open')
        return
      }
      if (frame.type === 'resync') {
        // 游标越界（buffer 挤出）→ 上层走 history 全量恢复。
        cursors.clear()
        // maxSeenSeq 保留是有意的——重连后（空 cursors）服务端 replay 全量会被
        // 下方 seq 去重拦截，恢复完全依赖上层 history（App.tsx pullHistory 整体替换）。
        opts.onResync()
        return
      }
      if (frame.type === 'event') {
        // 服务端对无会话信号（log 等）总是 replay——用全局单调 seq 去重。
        if (frame.seq <= maxSeenSeq) return
        trackCursor(frame.seq, frame.signal)
        opts.onEvent(frame.signal, frame.seq)
      }
    }
    ws.onclose = () => {
      if (closedByUser) {
        opts.onStatus('closed')
        return
      }
      opts.onStatus('connecting')
      const delay = Math.min((opts.baseRetryMs ?? 1000) * 2 ** retry, 30_000)
      retry++
      reconnectTimer = setTimeout(connect, delay)
    }
    ws.onerror = () => ws?.close()
  }

  return {
    connect,
    close: () => {
      closedByUser = true
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
      ws?.close()
    },
    /** 重置游标并重连（resync 恢复后由上层调用以重新 replay）。 */
    reconnect: () => {
      ws?.close()
    },
  }
}

export type WsClient = ReturnType<typeof createWsClient>
