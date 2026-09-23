// web-fetch.test.ts — SSRF validation + HTML rendering + redirect + truncation.
//
// All HTTP calls are mocked: we replace node:https and node:http with fakes
// that return canned responses, so no real network is touched.
// The pure functions (validateUrl, isUnsafeIp) are tested directly without
// any mocks.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ClientRequest } from 'node:http'

// ---------------------------------------------------------------------------
// Mock infrastructure for node:https / node:http
// ---------------------------------------------------------------------------

// Each test sets up a sequence of responses the mock should return.
// This lets us test redirect chains (multiple responses per call).
interface MockResponse {
  status: number
  headers: Record<string, string>
  body: Buffer | string
  // Optional: simulate a request error instead of a response
  error?: string
  // Optional: simulate timeout
  timeout?: boolean
}

let responseQueue: MockResponse[] = []
let requestCalls: { url: string; headers: Record<string, string> }[] = []

function enqueueResponse(r: MockResponse): void {
  responseQueue.push(r)
}
function clearQueue(): void {
  responseQueue = []
  requestCalls = []
}

// A fake IncomingMessage — EventEmitter with statusCode, headers, body chunks.
function createFakeResponse(r: MockResponse): IncomingMessage {
  const ee = new EventEmitter() as IncomingMessage
  ;(ee as unknown as { statusCode: number }).statusCode = r.status
  ;(ee as unknown as { headers: Record<string, string> }).headers = r.headers
  // Emit data + end on next tick (mimics async stream)
  process.nextTick(() => {
    if (r.error) {
      ee.emit('error', new Error(r.error))
      return
    }
    const body = typeof r.body === 'string' ? Buffer.from(r.body) : r.body
    if (body.length > 0) ee.emit('data', body)
    ee.emit('end')
  })
  return ee
}

// A fake ClientRequest — EventEmitter with .end(), .destroy(), .on()
function createFakeRequest(cb: (res: IncomingMessage) => void): ClientRequest {
  const ee = new EventEmitter() as unknown as ClientRequest
  ;(ee as unknown as { end: () => void }).end = () => {
    const next = responseQueue.shift()
    if (!next) {
      process.nextTick(() => ee.emit('error', new Error('mock: no response queued')))
      return
    }
    if (next.timeout) {
      process.nextTick(() => ee.emit('timeout'))
      return
    }
    if (next.error && !next.status) {
      process.nextTick(() => ee.emit('error', new Error(next.error)))
      return
    }
    const res = createFakeResponse(next)
    cb(res)
  }
  ;(ee as unknown as { destroy: () => void }).destroy = () => {
    // no-op for mock
  }
  return ee
}

// Mock module factory — replaces node:https and node:http
// The source uses `import https from 'node:https'` (default import), so the
// mock must provide a default export whose properties are Agent + request.
function createMockHttpModule(protocol: string) {
  class MockAgent {
    options: Record<string, unknown>
    constructor(opts: Record<string, unknown> = {}) {
      this.options = opts
    }
    createConnection(opts: unknown, cb: (err: unknown, socket: unknown) => void) {
      // Fake — we don't actually connect
      cb(null, new EventEmitter())
    }
  }

  function request(
    opts: { hostname?: string; port?: number; path?: string; headers?: Record<string, string>; protocol?: string },
    cb: (res: IncomingMessage) => void,
  ): ClientRequest {
    // Skip default port in URL string for cleaner test assertions
    const port = opts.port
    const isDefaultPort =
      (port === 443 && (opts.protocol || protocol) === 'https:') ||
      (port === 80 && (opts.protocol || protocol) === 'http:')
    const portStr = port && !isDefaultPort ? `:${port}` : ''
    const urlStr = `${opts.protocol || protocol}//${opts.hostname}${portStr}${opts.path}`
    requestCalls.push({ url: urlStr, headers: opts.headers ?? {} })
    return createFakeRequest(cb)
  }

  const mod = { Agent: MockAgent, request, get: request }
  // ESM default export for `import https from 'node:https'`
  return { default: mod, ...mod }
}

vi.mock('node:https', () => createMockHttpModule('https:'))
vi.mock('node:http', () => createMockHttpModule('http:'))
vi.mock('node:dns/promises', () => {
  const lookup = (
    hostname: string,
    _opts: unknown,
  ): Promise<{ address: string; family: number }[]> => {
    // Map hostnames to fake public IPs for redirect tests.
    const ipMap: Record<string, string[]> = {
      'example.com': ['93.184.216.34'],
      'other.example.com': ['93.184.216.35'],
    }
    const addrs = ipMap[hostname]
    if (!addrs) {
      return Promise.reject(new Error(`getaddrinfo ENOTFOUND ${hostname}`))
    }
    return Promise.resolve(addrs.map((a) => ({ address: a, family: 4 })))
  }
  // Also handle the 2-arg form (hostname, options) — source calls
  // dns.lookup(hostname, { all: true }) which returns LookupAddress[]
  const mod = { lookup }
  return { default: mod, ...mod }
})

// Import AFTER mocks are registered
const { validateUrl, isUnsafeIp, webFetch } = await import(
  '../../../src/im/tools/web-fetch.js'
)

// ---------------------------------------------------------------------------
// Tests: scheme validation (pure function)
// ---------------------------------------------------------------------------

describe('validateUrl — scheme whitelist', () => {
  it('accepts http://', () => {
    const u = validateUrl('http://example.com/path')
    expect(u.protocol).toBe('http:')
  })

  it('accepts https://', () => {
    const u = validateUrl('https://example.com/path')
    expect(u.protocol).toBe('https:')
  })

  it('rejects file:// scheme', () => {
    expect(() => validateUrl('file:///etc/passwd')).toThrow(/scheme.*not allowed/)
  })

  it('rejects javascript: scheme', () => {
    expect(() => validateUrl('javascript:alert(1)')).toThrow(/scheme.*not allowed/)
  })

  it('rejects ftp:// scheme', () => {
    expect(() => validateUrl('ftp://example.com/file')).toThrow(/scheme.*not allowed/)
  })

  it('rejects data: scheme', () => {
    expect(() => validateUrl('data:text/html,<b>hi</b>')).toThrow(/scheme.*not allowed/)
  })

  it('rejects malformed URLs', () => {
    expect(() => validateUrl('not a url at all')).toThrow(/invalid URL/)
  })

  it('rejects URLs without a host', () => {
    expect(() => validateUrl('http:///path')).toThrow(/no host/)
  })
})

// ---------------------------------------------------------------------------
// Tests: SSRF IP validation (pure function)
// ---------------------------------------------------------------------------

describe('isUnsafeIp — SSRF blocklist', () => {
  it('blocks IPv4 loopback 127.0.0.0/8', () => {
    expect(isUnsafeIp('127.0.0.1')).toBe(true)
    expect(isUnsafeIp('127.255.255.255')).toBe(true)
  })

  it('blocks IPv4 private 10/8', () => {
    expect(isUnsafeIp('10.0.0.1')).toBe(true)
    expect(isUnsafeIp('10.255.255.255')).toBe(true)
  })

  it('blocks IPv4 private 172.16/12', () => {
    expect(isUnsafeIp('172.16.0.1')).toBe(true)
    expect(isUnsafeIp('172.31.255.255')).toBe(true)
  })

  it('blocks IPv4 private 192.168/16', () => {
    expect(isUnsafeIp('192.168.1.1')).toBe(true)
    expect(isUnsafeIp('192.168.0.0')).toBe(true)
  })

  it('blocks IPv4 link-local 169.254/16 (cloud metadata)', () => {
    expect(isUnsafeIp('169.254.169.254')).toBe(true)
    expect(isUnsafeIp('169.254.0.1')).toBe(true)
  })

  it('blocks IPv4 CGNAT 100.64/10', () => {
    expect(isUnsafeIp('100.64.0.1')).toBe(true)
    expect(isUnsafeIp('100.127.255.255')).toBe(true)
  })

  it('blocks IPv4 unspecified 0.0.0.0', () => {
    expect(isUnsafeIp('0.0.0.0')).toBe(true)
  })

  it('blocks IPv6 loopback ::1', () => {
    expect(isUnsafeIp('::1')).toBe(true)
  })

  it('blocks IPv6 unique-local fc00::/7', () => {
    expect(isUnsafeIp('fd00::1')).toBe(true)
    expect(isUnsafeIp('fc00::1')).toBe(true)
  })

  it('blocks IPv6 link-local fe80::/10', () => {
    expect(isUnsafeIp('fe80::1')).toBe(true)
  })

  it('blocks IPv4-mapped IPv6 ::ffff:127.0.0.1', () => {
    expect(isUnsafeIp('::ffff:127.0.0.1')).toBe(true)
    expect(isUnsafeIp('::ffff:10.0.0.1')).toBe(true)
    expect(isUnsafeIp('::ffff:169.254.169.254')).toBe(true)
  })

  it('blocks IPv4-compatible IPv6 ::127.0.0.1 (deprecated form)', () => {
    expect(isUnsafeIp('::127.0.0.1')).toBe(true)
  })

  it('allows public IPv4 addresses', () => {
    expect(isUnsafeIp('1.1.1.1')).toBe(false)
    expect(isUnsafeIp('8.8.8.8')).toBe(false)
    expect(isUnsafeIp('93.184.216.34')).toBe(false)
  })

  it('allows public IPv6 addresses', () => {
    expect(isUnsafeIp('2606:4700:4700::1111')).toBe(false)
    expect(isUnsafeIp('2606:4700::1')).toBe(false)
  })

  it('allows IPv4-mapped IPv6 with public IPv4', () => {
    expect(isUnsafeIp('::ffff:1.1.1.1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: webFetch with mocked HTTP (SSRF rejection at fetch time)
// ---------------------------------------------------------------------------

describe('webFetch — SSRF rejection at fetch time', () => {
  beforeEach(() => clearQueue())

  it('rejects literal loopback IP in URL', async () => {
    await expect(webFetch({ url: 'http://127.0.0.1/admin' })).rejects.toThrow(/SSRF protection/)
  })

  it('rejects literal private IP in URL', async () => {
    await expect(webFetch({ url: 'http://10.0.0.1/internal' })).rejects.toThrow(/SSRF protection/)
  })

  it('rejects literal link-local IP (cloud metadata)', async () => {
    await expect(webFetch({ url: 'http://169.254.169.254/latest/meta-data/' })).rejects.toThrow(
      /SSRF protection/,
    )
  })

  it('rejects literal CGNAT IP', async () => {
    await expect(webFetch({ url: 'http://100.64.0.1/' })).rejects.toThrow(/SSRF protection/)
  })
})

// ---------------------------------------------------------------------------
// Tests: HTML → text rendering
// ---------------------------------------------------------------------------

describe('webFetch — HTML rendering', () => {
  beforeEach(() => clearQueue())

  it('renders HTML to text via readability', async () => {
    const html =
      '<html><head><title>My Page</title></head><body>' +
      '<header><nav>Home About Contact</nav></header>' +
      '<main><article>' +
      '<h1>Real Article Title</h1>' +
      '<p>This is the main content paragraph with enough text for readability to detect it properly. ' +
      'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor.</p>' +
      '<p>Second paragraph with additional content for the reader.</p>' +
      '</article></main>' +
      '<footer>Copyright 2024</footer>' +
      '</body></html>'

    enqueueResponse({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: html,
    })

    const result = await webFetch({ url: 'https://example.com/article' })
    expect(result).toContain('Real Article Title')
    expect(result).toContain('main content paragraph')
    expect(result).not.toContain('Home About Contact')
    expect(result).not.toContain('Copyright 2024')
  })

  it('returns raw HTML when format=html', async () => {
    const html = '<html><body><p>Hello</p></body></html>'
    enqueueResponse({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: html,
    })

    const result = await webFetch({ url: 'https://example.com/raw', format: 'html' })
    expect(result).toBe(html)
  })

  it('renders HTML to markdown (headings + links)', async () => {
    const html =
      '<html><head><title>Doc</title></head><body>' +
      '<main><article>' +
      '<h1>Main Title</h1>' +
      '<h2>Section</h2>' +
      '<p>See <a href="https://example.com/docs">the docs</a> for more details. ' +
      'Sufficient text for readability detection here. ' +
      'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor.</p>' +
      '</article></main></body></html>'

    enqueueResponse({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: html,
    })

    const result = await webFetch({ url: 'https://example.com/doc', format: 'markdown' })
    // Readability may downgrade h1→h2; check for heading markers + content
    expect(result).toMatch(/#{1,2}\s+Main Title/)
    expect(result).toMatch(/#{1,3}\s+Section/)
    // Link should be preserved in markdown format
    expect(result).toMatch(/\[the docs\]\(https:\/\/example\.com\/docs\)/)
  })
})

// ---------------------------------------------------------------------------
// Tests: non-HTML passthrough
// ---------------------------------------------------------------------------

describe('webFetch — non-HTML passthrough', () => {
  beforeEach(() => clearQueue())

  it('returns text/plain verbatim', async () => {
    const text = 'Hello, this is plain text.\nLine two.\n'
    enqueueResponse({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: text,
    })

    const result = await webFetch({ url: 'https://example.com/readme.txt' })
    expect(result).toBe(text)
  })

  it('returns JSON verbatim', async () => {
    const json = '{"key": "value", "num": 42}'
    enqueueResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: json,
    })

    const result = await webFetch({ url: 'https://example.com/api/data' })
    expect(result).toBe(json)
  })

  it('returns JSON with charset verbatim', async () => {
    const json = '{"name": "test"}'
    enqueueResponse({
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: json,
    })

    const result = await webFetch({ url: 'https://example.com/api/data2' })
    expect(result).toBe(json)
  })
})

// ---------------------------------------------------------------------------
// Tests: redirect chain
// ---------------------------------------------------------------------------

describe('webFetch — redirect following', () => {
  beforeEach(() => clearQueue())

  it('follows a 302 redirect to a safe URL', async () => {
    // First response: 302 redirect
    enqueueResponse({
      status: 302,
      headers: { location: 'https://other.example.com/final' },
      body: '',
    })
    // Second response: 200 OK
    enqueueResponse({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'Final content here',
    })

    const result = await webFetch({ url: 'https://example.com/redirect' })
    expect(result).toBe('Final content here')
    // Verify both URLs were requested
    expect(requestCalls).toHaveLength(2)
    expect(requestCalls[0]!.url).toContain('example.com/redirect')
    expect(requestCalls[1]!.url).toContain('other.example.com/final')
  })

  it('follows a 301 redirect', async () => {
    enqueueResponse({
      status: 301,
      headers: { location: 'https://example.com/new' },
      body: '',
    })
    enqueueResponse({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'Moved content',
    })

    const result = await webFetch({ url: 'https://example.com/old' })
    expect(result).toBe('Moved content')
  })

  it('follows relative redirect', async () => {
    enqueueResponse({
      status: 302,
      headers: { location: '/relative/path' },
      body: '',
    })
    enqueueResponse({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'Relative target',
    })

    const result = await webFetch({ url: 'https://example.com/start' })
    expect(result).toBe('Relative target')
    expect(requestCalls[1]!.url).toContain('example.com/relative/path')
  })

  it('rejects redirect to unsafe IP (169.254.169.254)', async () => {
    enqueueResponse({
      status: 302,
      headers: { location: 'http://169.254.169.254/meta' },
      body: '',
    })

    await expect(webFetch({ url: 'https://example.com/trap' })).rejects.toThrow(/SSRF protection/)
  })

  it('throws on too many redirects (>5)', async () => {
    // Queue 7 redirect responses (will hit the 6th hop limit)
    for (let i = 0; i < 7; i++) {
      enqueueResponse({
        status: 302,
        headers: { location: `https://example.com/hop${i + 1}` },
        body: '',
      })
    }

    await expect(webFetch({ url: 'https://example.com/loop' })).rejects.toThrow(
      /too many redirects/,
    )
  })

  it('treats 304 Not Modified as terminal (not a redirect)', async () => {
    enqueueResponse({
      status: 304,
      headers: {},
      body: '',
    })

    // 304 is not a redirect and not 2xx — treated as HTTP error
    await expect(webFetch({ url: 'https://example.com/cached' })).rejects.toThrow(
      /HTTP 304/,
    )
  })
})

// ---------------------------------------------------------------------------
// Tests: HTTP error status
// ---------------------------------------------------------------------------

describe('webFetch — HTTP error status', () => {
  beforeEach(() => clearQueue())

  it('throws on 404', async () => {
    enqueueResponse({
      status: 404,
      headers: { 'content-type': 'text/html' },
      body: '<html><body>Not Found</body></html>',
    })

    await expect(webFetch({ url: 'https://example.com/missing' })).rejects.toThrow(
      /HTTP 404/,
    )
  })

  it('throws on 500', async () => {
    enqueueResponse({
      status: 500,
      headers: {},
      body: 'Internal Server Error',
    })

    await expect(webFetch({ url: 'https://example.com/error' })).rejects.toThrow(
      /HTTP 500/,
    )
  })
})

// ---------------------------------------------------------------------------
// Tests: char-level truncation
// ---------------------------------------------------------------------------

describe('webFetch — no truncation (2026-09-12 user decision)', () => {
  beforeEach(() => clearQueue())

  it('returns short content verbatim', async () => {
    enqueueResponse({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'short text',
    })

    const result = await webFetch({ url: 'https://example.com/short' })
    expect(result).toBe('short text')
  })

  it('returns oversized content in full (no truncation marker)', async () => {
    // 60K chars — beyond the old 50K cap; must arrive complete.
    const longText = 'A'.repeat(60000)
    enqueueResponse({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: longText,
    })

    const result = await webFetch({ url: 'https://example.com/long' })
    expect(result).toBe(longText)
    expect(result).not.toContain('Truncated')
  })
})

// ---------------------------------------------------------------------------
// Tests: timeout + content-length
// ---------------------------------------------------------------------------

describe('webFetch — timeout', () => {
  beforeEach(() => clearQueue())

  it('throws on request timeout', async () => {
    enqueueResponse({
      status: 0,
      headers: {},
      body: '',
      timeout: true,
    })

    await expect(webFetch({ url: 'https://example.com/slow' })).rejects.toThrow(
      /timed out/,
    )
  })
})

// ---------------------------------------------------------------------------
// Tests: request error
// ---------------------------------------------------------------------------

describe('webFetch — request error', () => {
  beforeEach(() => clearQueue())

  it('throws on connection error', async () => {
    enqueueResponse({
      status: 0,
      headers: {},
      body: '',
      error: 'ECONNREFUSED',
    })

    await expect(webFetch({ url: 'https://example.com/refused' })).rejects.toThrow(
      /ECONNREFUSED/,
    )
  })
})

// ---------------------------------------------------------------------------
// Tests: charset handling
// ---------------------------------------------------------------------------

describe('webFetch — charset handling', () => {
  beforeEach(() => clearQueue())

  it('decodes UTF-8 BOM correctly', async () => {
    // UTF-8 BOM + text
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    const text = Buffer.from('Hello UTF-8', 'utf-8')
    const body = Buffer.concat([bom, text])

    enqueueResponse({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body,
    })

    const result = await webFetch({ url: 'https://example.com/bom' })
    expect(result).toBe('Hello UTF-8')
  })

  it('honors charset from Content-Type header', async () => {
    // Use a simple ASCII body with a charset declaration — verifying the
    // charset is parsed (not the actual encoding, since ASCII is ASCII)
    enqueueResponse({
      status: 200,
      headers: { 'content-type': 'text/plain; charset=iso-8859-1' },
      body: 'Hello World',
    })

    const result = await webFetch({ url: 'https://example.com/charset' })
    expect(result).toBe('Hello World')
  })
})

// ---------------------------------------------------------------------------
// Tests: empty body
// ---------------------------------------------------------------------------

describe('webFetch — empty body', () => {
  beforeEach(() => clearQueue())

  it('throws on empty HTML response', async () => {
    enqueueResponse({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '',
    })

    await expect(webFetch({ url: 'https://example.com/empty' })).rejects.toThrow(
      /no readable text/,
    )
  })
})
