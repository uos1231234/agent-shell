// v0.21 Web Shell — 同端口 HTTP+WS 服务器。
//
// 路径分派（deepseek host-webserver + host-frontend-static 同款模式）：
//   GET  /healthz          — 免鉴权探活
//   POST /api/v1/cmd       — 前端指令 → gate.command()（鉴权：Bearer 头）
//   GET  /api/v1/snapshot  — 全量重拉兜底（鉴权）
//   GET  /api/v1/ws        — WS upgrade（鉴权：子协议 token）
//   其余 GET               — 静态 fallback（dist SPA；index 过鉴权，资产公开）
//
// server 只翻译：HTTP JSON ↔ gate.command / gate.snapshot；WS ↔ gate 信号。
// 不含业务。

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'


import type { SignalGate, GateCommand } from '../signals/index.js'
import { createWebShellAuth, type WebShellAuth } from './auth.js'
import { createWebShellStream, type WebShellStream } from './stream.js'

export type WebShellServerOptions = {
  gate: SignalGate
  /** 静态 SPA dist 目录（v0.22 webapp 构建产物）；缺省时不 serve 静态。 */
  distDir?: string
  host?: string
  port?: number
  /** 显式 token（缺省生成 / tokenFile 复用）。 */
  token?: string
  tokenFile?: string
}

export type WebShellServer = {
  url: string
  port: number
  token: string
  auth: WebShellAuth
  stream: WebShellStream
  close(): Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
}

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectBody)
  })

export const createWebShellServer = async (opts: WebShellServerOptions): Promise<WebShellServer> => {
  const auth = createWebShellAuth({
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.tokenFile !== undefined ? { tokenFile: opts.tokenFile } : {}),
  })
  const stream = createWebShellStream({ gate: opts.gate, authorize: (req) => auth.authorizeWs(req) })
  const distRoot = opts.distDir !== undefined ? resolve(opts.distDir) : undefined

  // ---- 静态 fallback（dist SPA）----
  // 静态资产（含 index）免鉴权（v0.22 拍板）：fragment token 不上送，index
  // 强制 Authorization 会让首次导航必然 401。index 只是空壳无数据——真正的
  // 数据面（cmd/snapshot/WS）全部强制 Bearer。前端加载后从 location.hash 取
  // token 调 API/WS；无 token 时显示引导页。
  const serveStatic = (pathname: string, req: IncomingMessage, res: ServerResponse): void => {
    if (distRoot === undefined) {
      res.writeHead(404).end()
      return
    }
    const target = resolve(normalize(join(distRoot, pathname === '/' ? 'index.html' : pathname)))
    // 路径穿越防护（host-frontend-static 同款）：越界 403。
    if (target !== distRoot && !target.startsWith(distRoot + sep)) {
      res.writeHead(403).end()
      return
    }
    let filePath = target
    try {
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        // SPA fallback：未命中的路径回 index.html。
        filePath = join(distRoot, 'index.html')
      }
    } catch {
      res.writeHead(500).end()
      return
    }
    try {
      const body = readFileSync(filePath)
      const type = MIME[extname(filePath)] ?? 'application/octet-stream'
      res.writeHead(200, { 'content-type': type })
      res.end(body)
    } catch {
      res.writeHead(404).end()
    }
  }

  const server: Server = createServer((req, res) => {
    // strip query/fragment：req.url 含 ?a=b 时静态路径会 fallback 到 index.html
    // （文件名带 query 不存在），module 资产因此拿不到。
    const pathname = (req.url ?? '/').split('?')[0]!.split('#')[0]!
    // 1) healthz：免鉴权。
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
      return
    }
    // 2) /api/v1/cmd：POST JSON → gate.command。
    if (pathname === '/api/v1/cmd' && req.method === 'POST') {
      if (!auth.authorizeRequest(req)) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      void readBody(req)
        .then((body) => commandFromBody(opts.gate, body))
        .then((result) => sendJson(res, 200, { ok: true, result }))
        .catch((e: unknown) => sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) }))
      return
    }
    // 3) /api/v1/snapshot：全量重拉兜底。
    if (pathname === '/api/v1/snapshot' && req.method === 'GET') {
      if (!auth.authorizeRequest(req)) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      sendJson(res, 200, { ok: true, snapshot: opts.gate.snapshot() })
      return
    }
    // 4) 其余 GET → 静态 fallback（含鉴权规则）。
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(pathname, req, res)
      return
    }
    res.writeHead(405).end()
  })

  // 5) WS upgrade：仅 /api/v1/ws，子协议 token 鉴权；未命中路径 destroy。
  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url ?? '/').split('?')[0]!.split('#')[0]!
    if (pathname !== '/api/v1/ws') {
      socket.destroy()
      return
    }
    if (!auth.authorizeWs(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    stream.wss.handleUpgrade(req, socket, head, (ws) => {
      stream.wss.emit('connection', ws, req)
    })
  })

  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 0

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  const actualPort = address !== null && typeof address === 'object' ? address.port : port

  return {
    url: `http://${host}:${actualPort}/#token=${auth.token}`,
    port: actualPort,
    token: auth.token,
    auth,
    stream,
    close: (): Promise<void> =>
      new Promise((resolveClose) => {
        void stream.close()
        server.close(() => resolveClose())
      }),
  }
}

/** cmd 请求体 → gate.command（校验 kind 存在，未知 kind 干净报错）。 */
const commandFromBody = async (gate: SignalGate, body: string): Promise<unknown> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error('request body is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || !('kind' in parsed)) {
    throw new Error('command requires a "kind" field')
  }
  const cmd = parsed as GateCommand
  return gate.command(cmd)
}
