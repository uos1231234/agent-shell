// v0.21 Web Shell — auth 单元测试。
//
// 覆盖：
//   1. createWebShellAuth: 生成随机 token
//   2. createWebShellAuth: 显式 token 复用
//   3. createWebShellAuth: tokenFile 持久化（写入 + 重启复用）
//   4. authorizeRequest: Bearer 头校验
//   5. authorizeWs: 子协议 token 校验
//   6. timing-safe: 不等长 token 被拒

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createWebShellAuth, extractWsToken } from '../../src/webshell/auth.js'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 创建一个 mock IncomingMessage（只含 headers）。 */
const mockReq = (headers: Record<string, string | undefined>): IncomingMessage => {
  const req = new IncomingMessage(new Socket())
  req.headers = headers
  return req
}

let tmpDir: string
afterEach(() => {
  if (tmpDir !== undefined) {
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = undefined as unknown as string
  }
})

describe('createWebShellAuth', () => {
  it('generates a random token when no options', () => {
    const auth = createWebShellAuth()
    expect(auth.token.length).toBeGreaterThan(20)
  })

  it('reuses explicit token', () => {
    const auth = createWebShellAuth({ token: 'my-secret-token' })
    expect(auth.token).toBe('my-secret-token')
  })

  it('writes token to tokenFile and reuses on restart', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'auth-test-'))
    const tokenFile = join(tmpDir, 'token')

    const auth1 = createWebShellAuth({ tokenFile })
    const firstToken = auth1.token

    // Simulate restart: create a new auth instance with same tokenFile.
    const auth2 = createWebShellAuth({ tokenFile })
    expect(auth2.token).toBe(firstToken)
  })
})

describe('authorizeRequest', () => {
  it('accepts valid Bearer token', () => {
    const auth = createWebShellAuth({ token: 'test-token' })
    const req = mockReq({ authorization: 'Bearer test-token' })
    expect(auth.authorizeRequest(req)).toBe(true)
  })

  it('rejects missing Authorization header', () => {
    const auth = createWebShellAuth({ token: 'test-token' })
    const req = mockReq({})
    expect(auth.authorizeRequest(req)).toBe(false)
  })

  it('rejects wrong Bearer token', () => {
    const auth = createWebShellAuth({ token: 'test-token' })
    const req = mockReq({ authorization: 'Bearer wrong-token' })
    expect(auth.authorizeRequest(req)).toBe(false)
  })

  it('rejects non-Bearer Authorization', () => {
    const auth = createWebShellAuth({ token: 'test-token' })
    const req = mockReq({ authorization: 'Basic dXNlcjpwYXNz' })
    expect(auth.authorizeRequest(req)).toBe(false)
  })
})

describe('authorizeWs', () => {
  it('accepts valid agent-shell.bearer subprotocol', () => {
    const auth = createWebShellAuth({ token: 'ws-token' })
    const req = mockReq({ 'sec-websocket-protocol': 'agent-shell.bearer.ws-token' })
    expect(auth.authorizeWs(req)).toBe(true)
  })

  it('rejects missing subprotocol', () => {
    const auth = createWebShellAuth({ token: 'ws-token' })
    const req = mockReq({})
    expect(auth.authorizeWs(req)).toBe(false)
  })

  it('rejects wrong token in subprotocol', () => {
    const auth = createWebShellAuth({ token: 'ws-token' })
    const req = mockReq({ 'sec-websocket-protocol': 'agent-shell.bearer.wrong' })
    expect(auth.authorizeWs(req)).toBe(false)
  })

  it('handles multiple subprotocols (comma-separated)', () => {
    const auth = createWebShellAuth({ token: 'ws-token' })
    const req = mockReq({ 'sec-websocket-protocol': 'other, agent-shell.bearer.ws-token' })
    expect(auth.authorizeWs(req)).toBe(true)
  })
})

describe('extractWsToken', () => {
  it('extracts token from agent-shell.bearer prefix', () => {
    const req = mockReq({ 'sec-websocket-protocol': 'agent-shell.bearer.my-token' })
    expect(extractWsToken(req)).toBe('my-token')
  })

  it('returns undefined when no matching prefix', () => {
    const req = mockReq({ 'sec-websocket-protocol': 'other-protocol' })
    expect(extractWsToken(req)).toBeUndefined()
  })

  it('returns undefined when header missing', () => {
    const req = mockReq({})
    expect(extractWsToken(req)).toBeUndefined()
  })
})
