// v0.21 Web Shell — bearer token 鉴权。
//
// 模式参照 kimi kap-server（persistent token 文件 + URL fragment 传递）：
//   - token：randomBytes(32).base64url（256-bit）；提供 tokenFile 时落盘
//     0600，重启复用（rotate = 改文件，热生效——每次校验重读文件）。
//   - 传递：前端 URL 带 `#token=...`（fragment 不进 server 日志）；REST 用
//     `Authorization: Bearer <token>` 头；浏览器 WS 无法设 Authorization，
//     借 Sec-WebSocket-Protocol 子协议字段携带（`agent-shell.bearer.<token>`）。
//   - 豁免：/healthz、静态资产（含 index——v0.22 拍板：fragment token 不
//     上送，index 鉴权会让首次导航必然 401；静态只是空壳无数据）。/api 与
//     WS 必须过鉴权。
//   - 校验：timingSafeEqual 常量时间比较。

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'

export const WS_BEARER_PROTOCOL_PREFIX = 'agent-shell.bearer.'

export type WebShellAuth = {
  /** 当前 token（供 server 打印带 fragment 的 URL）。 */
  token: string
  /** REST 鉴权（/api/*）：Authorization: Bearer 头。 */
  authorizeRequest(req: IncomingMessage): boolean
  /** WS 鉴权：从子协议头提取 token；合法返回 true。 */
  authorizeWs(req: IncomingMessage): boolean
}

const constantTimeEquals = (a: string, b: string): boolean => {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** 从请求头提取 bearer token（Authorization 头）。 */
const extractHeaderToken = (req: IncomingMessage): string | undefined => {
  const header = req.headers.authorization
  if (header === undefined) return undefined
  const m = /^Bearer\s+(.+)$/i.exec(header)
  return m?.[1]
}

/** 从 WS 子协议头提取 token（`agent-shell.bearer.<token>`）。 */
export const extractWsToken = (req: IncomingMessage): string | undefined => {
  const header = req.headers['sec-websocket-protocol']
  if (header === undefined) return undefined
  for (const part of header.split(',').map((p) => p.trim())) {
    if (part.startsWith(WS_BEARER_PROTOCOL_PREFIX)) {
      return part.slice(WS_BEARER_PROTOCOL_PREFIX.length)
    }
  }
  return undefined
}

export type WebShellAuthOptions = {
  /** 显式提供 token（测试/编程用）。缺省时生成新 token。 */
  token?: string
  /** token 持久化文件（0600）；存在则复用，不存在则生成并写入。 */
  tokenFile?: string
}

export const createWebShellAuth = (opts?: WebShellAuthOptions): WebShellAuth => {
  // token 解析顺序：显式 token > tokenFile 已有 > 生成并写入 tokenFile。
  let token: string
  if (opts?.token !== undefined) {
    token = opts.token
  } else if (opts?.tokenFile !== undefined && existsSync(opts.tokenFile)) {
    token = readFileSync(opts.tokenFile, 'utf8').trim()
  } else {
    token = randomBytes(32).toString('base64url')
    if (opts?.tokenFile !== undefined) {
      writeFileSync(opts.tokenFile, token, { mode: 0o600 })
    }
  }

  const readTokenFile = (): string => {
    if (opts?.tokenFile === undefined || !existsSync(opts.tokenFile)) return token
    return readFileSync(opts.tokenFile, 'utf8').trim()
  }

  const matches = (presented: string | undefined): boolean => {
    if (presented === undefined) return false
    return constantTimeEquals(presented, readTokenFile())
  }

  return {
    token,
    authorizeRequest: (req) => matches(extractHeaderToken(req)),
    authorizeWs: (req) => matches(extractWsToken(req)),
  }
}
