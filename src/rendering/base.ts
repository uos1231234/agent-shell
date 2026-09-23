// v0.20 rendering base: the silent rendering service.
//
// §5.3 of v0.20 plan. The base is the single built-in subscriber to the
// RenderingSignalBus. It renders markdown → HTML, stores artifacts, and
// exposes a frontend-facing interface (onArtifact events)。
//
// Dependency direction (C1): signal-bus → base. Base does NOT import
// loop / registry / protocol. It only imports:
//   - renderMarkdown (pure function)
//   - ArtifactStore (content-addressed store)
//   - RenderingSignalBus type (subscription)
//   - Logger
//
// v0.24: startPreviewServer 已注释掉（用户拍板 2026-09-07）。理由：信号关是
// 唯一前后端中转站——前端经 artifact.get 命令取 HTML（Bearer 鉴权 + 会话边界），
// preview server 若启用会成为 gate 之外的第二条无鉴权数据面（/list 一览全部
// 产物、无会话隔离）。观测需求由 webapp ArtifactTab（iframe srcDoc）与
// examples 的写文件形态覆盖。实现保留在下方注释中备查，禁止在宿主装配中启用。

// import { createServer, type Server } from 'node:http'

import { renderMarkdown } from './render-md.js'
import { ArtifactStore } from '../im/tools/artifact-store.js'
import type { RenderingSignalBus, ArtifactSignal } from './signal-bus.js'
import type { Logger } from '../shared/logger.js'

export type ArtifactHandle = {
  id: string
  kind: 'markdown' | 'html'
  title: string
  source: string
  at: number
}

export type RenderingBase = {
  /** Render md directly (non-signal path); returns handle and broadcasts. */
  renderMarkdown(md: string, meta: { title: string; source: string }): ArtifactHandle
  /** Snapshot of all handles in creation order. */
  handles(): readonly ArtifactHandle[]
  /** Frontend subscriber; returns unsubscribe. */
  onArtifact(cb: (h: ArtifactHandle) => void): () => void
  /** Get stored HTML by artifact id. */
  getHtml(id: string): string | undefined
  /**
   * v0.21: 公开的 signal 处理入口——信号关的 rendering 接线器经此转发
   * ArtifactSignal（bus → Gate → base 顺序）。autoSubscribe:false 时这是
   * 唯一的信号入口。
   */
  handleSignal(signal: ArtifactSignal): void
}

type ConsoleLike = {
  warn(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
}

export function createRenderingBase(
  bus: RenderingSignalBus,
  opts?: {
    logger?: Logger
    store?: ArtifactStore
    /**
     * v0.21: 是否自动订阅 bus（默认 true，向后兼容）。信号关装配传 false，
     * 由 Gate 的 rendering 接线器经 handleSignal 转发（bus → Gate → base）。
     */
    autoSubscribe?: boolean
  },
): RenderingBase {
  const store: ArtifactStore = opts?.store ?? new ArtifactStore()
  const logger: ConsoleLike =
    opts?.logger ?? {
      warn: (msg, fields) => console.warn(msg, fields ?? ''),
      info: (msg, fields) => console.info(msg, fields ?? ''),
    }

  const handles: ArtifactHandle[] = []
  const subscribers: Array<(h: ArtifactHandle) => void> = []

  // v0.20 P3 fix: 去重检查。重复 emit 同 id 的 signal 不会产生重复 handle。
  const hasHandle = (id: string): boolean => handles.some((h) => h.id === id)

  const broadcast = (h: ArtifactHandle): void => {
    for (const cb of subscribers) {
      try {
        cb(h)
      } catch (e) {
        logger.warn('rendering: onArtifact subscriber threw', {
          id: h.id,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }

  /** Core pipeline: render → store → handle → broadcast. */
  const pipeline = (md: string, meta: { title: string; source: string }): ArtifactHandle => {
    const html = renderMarkdown(md)
    const id = store.put(html)
    // v0.20 P3 fix: 去重。同 id 的 handle 已存在则跳过 push（避免重复 emit 产生重复项）。
    if (hasHandle(id)) {
      return handles.find((h) => h.id === id)!
    }
    const handle: ArtifactHandle = {
      id,
      kind: 'markdown' as const,
      title: meta.title,
      source: meta.source,
      at: Date.now(),
    }
    handles.push(handle)
    broadcast(handle)
    return handle
  }

  // v0.21: signal 处理逻辑提为公开入口 handleSignal——信号关（Signal Gate）
  // 的 rendering 接线器经它转发（bus → Gate → base，用户拍板的顺序）。
  // autoSubscribe 默认 true 保持既有行为（base 直连 bus）；信号关装配时
  // 以 autoSubscribe:false 创建 base，由 Gate 侧转发。
  const handleSignal = (signal: ArtifactSignal): void => {
    if (signal.kind === 'markdown') {
      try {
        pipeline(signal.content, { title: signal.title, source: signal.source })
      } catch (e) {
        logger.warn('rendering: render failed', {
          kind: signal.kind,
          error: e instanceof Error ? e.message : String(e),
        })
      }
      return
    }
    // artifact-ref: fetch stored html, construct handle, broadcast.
    try {
      const html = store.get(signal.artifactId)
      // v0.20 P3 fix: 去重。同 id 的 handle 已存在则跳过 push。
      if (hasHandle(signal.artifactId)) {
        return
      }
      const handle: ArtifactHandle = {
        id: signal.artifactId,
        kind: 'html' as const,
        title: signal.title,
        source: signal.source,
        at: Date.now(),
      }
      handles.push(handle)
      broadcast(handle)
    } catch (e) {
      logger.warn('rendering: artifact-ref lookup failed', {
        artifactId: signal.artifactId,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  if (opts?.autoSubscribe !== false) {
    // Subscribe to signals — base is the single built-in subscriber.
    bus.onSignal(handleSignal)
  }

  const renderMarkdownMethod = (
    md: string,
    meta: { title: string; source: string },
  ): ArtifactHandle => pipeline(md, meta)

  const handlesMethod = (): readonly ArtifactHandle[] => [...handles]

  const onArtifact = (cb: (h: ArtifactHandle) => void): (() => void) => {
    subscribers.push(cb)
    return () => {
      const idx = subscribers.indexOf(cb)
      if (idx >= 0) subscribers.splice(idx, 1)
    }
  }

  const getHtml = (id: string): string | undefined => {
    try {
      return store.get(id)
    } catch {
      return undefined
    }
  }

  // v0.24: startPreviewServer 注释掉（用户拍板 2026-09-07）——见文件头说明。
  // 原实现（备查，勿启用）：被动只读 HTTP 端点 /healthz + /list + /artifact/:id，
  // 无 Bearer、无会话隔离、绕过信号关。若未来确需 URL 形态的产物分享，必须
  // 先补鉴权与会话边界并经用户重新拍板。
  //
  // const startPreviewServer = (sopts?: { port?: number; host?: string }): Promise<{
  //   url: string
  //   close(): Promise<void>
  // }> => {
  //   const host = sopts?.host ?? '127.0.0.1'
  //   const port = sopts?.port ?? 0
  //   const server: Server = createServer((req, res) => {
  //     const url = req.url ?? '/'
  //     // GET /healthz
  //     if (url === '/healthz') {
  //       res.writeHead(200, { 'content-type': 'text/plain' })
  //       res.end('ok')
  //       return
  //     }
  //     // GET /list
  //     if (url === '/list') {
  //       res.writeHead(200, { 'content-type': 'application/json' })
  //       res.end(JSON.stringify(handles))
  //       return
  //     }
  //     // GET /artifact/:id — charset 必须显式声明：无 charset 时浏览器按本地
  //     // 默认编码（中文 Windows = GBK）解码 UTF-8 字节，中文全部变乱码。
  //     const m = /^\/artifact\/([a-f0-9]+)$/.exec(url)
  //     if (m) {
  //       const id = m[1]!
  //       const html = getHtml(id)
  //       if (html === undefined) {
  //         res.writeHead(404, { 'content-type': 'text/plain' })
  //         res.end('not found')
  //         return
  //       }
  //       res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  //       res.end(html)
  //       return
  //     }
  //     res.writeHead(404, { 'content-type': 'text/plain' })
  //     res.end('not found')
  //   })
  //
  //   return new Promise((resolve, reject) => {
  //     server.on('error', reject)
  //     server.listen(port, host, () => {
  //       const addr = server.address()
  //       const actualPort =
  //         addr !== null && typeof addr === 'object' ? addr.port : port
  //       const url = `http://${host}:${actualPort}/`
  //       logger.info('rendering: preview server start', { url })
  //       const close = (): Promise<void> =>
  //         new Promise((resolveClose, rejectClose) => {
  //           server.close((err) => {
  //             if (err) rejectClose(err)
  //             else {
  //               logger.info('rendering: preview server closed', { url })
  //               resolveClose()
  //             }
  //           })
  //         })
  //       resolve({ url, close })
  //     })
  //   })
  // }

  return {
    renderMarkdown: renderMarkdownMethod,
    handles: handlesMethod,
    onArtifact,
    getHtml,
    handleSignal,
  }
}
