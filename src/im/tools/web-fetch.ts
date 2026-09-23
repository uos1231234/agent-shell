// web-fetch.ts
//
// SSRF-protected URL fetch + HTML→text rendering.
//
// Security model (SSRF):
//   - scheme whitelist: only http/https (file://, data:, javascript: → throw)
//   - IP blocklist via node:net.BlockList: loopback, RFC1918 private, link-local
//     (169.254/16 incl. cloud metadata 169.254.169.254), CGNAT 100.64/10,
//     IPv6 loopback ::1, ULA fc00::/7, link-local fe80::/10.
//   - DNS resolve → validate ALL IPs → pin the first safe IP into the HTTP
//     agent's lookup (closes DNS-rebinding TOCTOU: without pinning, DNS is
//     looked up here and AGAIN by the agent at connect; a TTL=0 attacker
//     could rebind to a private IP between the two lookups).
//   - IPv4-mapped IPv6 (::ffff:a.b.c.d) is auto-unwrapped by BlockList.check;
//     IPv4-compatible (::a.b.c.d, deprecated) is manually unwrapped.
//   - Redirects followed manually (max 5 hops); each hop re-runs scheme + IP
//     validation so a 302 can't rebind to an internal address.
//
// Rendering:
//   - HTML → @mozilla/readability + linkedom (extracts main content, drops
//     script/style/nav/footer chrome).
//   - format:'html' → raw HTML (no readability).
//   - format:'markdown' → readability text + light markdown conversion
//     (headings → #, links → [text](url), code fences).
//   - Non-HTML (JSON, text/plain) → verbatim.
//   - charset: Content-Type header → BOM → UTF-8.
//
// Truncation: char-level ([...str].slice) so CJK/emoji isn't cut mid-codepoint.

import net from 'node:net'
import dns from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import type { IncomingMessage } from 'node:http'

// ---------------------------------------------------------------------------
// Types (public API, per plan §5.3)
// ---------------------------------------------------------------------------

export type WebFetchInput = {
  url: string
  format?: 'text' | 'markdown' | 'html' // default 'text'
  /** v0.29: 外部取消信号（turn.cancel / 用户关闭状态机）→ 中断进行中的网络请求。 */
  signal?: AbortSignal
}

export type WebFetchResult = {
  content: string      // rendered text/markdown/html
  finalUrl: string     // after redirect chain
  status: number
  contentType: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 5
const REQUEST_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024 // 10 MB hard cap (OOM defense)
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

// ---------------------------------------------------------------------------
// SSRF: BlockList (constructed once, immutable after)
// ---------------------------------------------------------------------------

function buildBlockList(): net.BlockList {
  const b = new net.BlockList()
  // IPv4
  b.addAddress('127.0.0.1', 'ipv4')             // loopback 127.0.0.0/8 (addRange covers /8)
  b.addRange('127.0.0.0', '127.255.255.255', 'ipv4')
  b.addRange('10.0.0.0', '10.255.255.255', 'ipv4')       // private 10/8
  b.addRange('172.16.0.0', '172.31.255.255', 'ipv4')     // private 172.16/12
  b.addRange('192.168.0.0', '192.168.255.255', 'ipv4')   // private 192.168/16
  b.addSubnet('169.254.0.0', 16, 'ipv4')                 // link-local (cloud metadata)
  b.addSubnet('100.64.0.0', 10, 'ipv4')                  // CGNAT 100.64/10
  b.addAddress('0.0.0.0', 'ipv4')                        // unspecified
  b.addSubnet('224.0.0.0', 4, 'ipv4')                    // multicast + reserved 240/4
  // IPv6
  b.addAddress('::1', 'ipv6')                  // loopback
  b.addAddress('::', 'ipv6')                   // unspecified
  b.addSubnet('fc00::', 7, 'ipv6')             // unique-local
  b.addSubnet('fe80::', 10, 'ipv6')            // link-local
  return b
}

const BLOCKLIST = buildBlockList()

// ---------------------------------------------------------------------------
// SSRF: pure validation functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Validate URL scheme — only http/https allowed.
 * Returns the parsed URL or throws.
 */
export function validateUrl(rawUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`web_fetch: invalid URL: ${rawUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `web_fetch: scheme "${parsed.protocol}" not allowed — only http(s) URLs can be fetched`,
    )
  }
  if (!parsed.hostname) {
    throw new Error(`web_fetch: URL has no host: ${rawUrl}`)
  }
  // Reject "http:///path" — Node parses this as hostname="path" (misleadingly).
  // A real hostname has at least one dot or is a valid IP or "localhost";
  // "path" is clearly a path with the host omitted.
  const isIp = net.isIP(parsed.hostname) !== 0
  const isLocalhost = parsed.hostname === 'localhost'
  const hasDot = parsed.hostname.includes('.')
  if (!isIp && !isLocalhost && !hasDot) {
    throw new Error(`web_fetch: URL has no host: ${rawUrl}`)
  }
  return parsed
}

/**
 * Check if an IP address is safe (not loopback/private/link-local/CGNAT/etc).
 * Handles IPv4-mapped IPv6 (::ffff:a.b.c.d) — BlockList.check unwraps it
 * automatically when family='ipv6'. Also handles the deprecated IPv4-compatible
 * form (::a.b.c.d) by manual unwrapping.
 *
 * Returns true if the IP is BLOCKED (unsafe), false if safe.
 */
export function isUnsafeIp(ip: string): boolean {
  // Determine family
  const family = net.isIP(ip)
  if (family === 0) {
    // Not a valid IP — treat as blocked (shouldn't happen after DNS lookup)
    return true
  }

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — BlockList.check with 'ipv6' handles
  // this automatically (verified at runtime). But also check the IPv4 part
  // directly to be belt-and-suspenders.
  if (family === 6) {
    // Check as IPv6 first (BlockList unwraps ::ffff: automatically)
    if (BLOCKLIST.check(ip, 'ipv6')) return true

    // IPv4-compatible form (::a.b.c.d, deprecated) — BlockList does NOT catch
    // this. Manually extract: if the address is ::X.Y.Z.W (not ::ffff:), unwrap.
    const lower = ip.toLowerCase()
    // ::ffff: already handled by BlockList. Check for bare ::<v4> form.
    if (lower.startsWith('::') && !lower.startsWith('::ffff:') && !lower.includes(':ffff:')) {
      // Could be ::a.b.c.d — try to extract the v4 part
      const parts = lower.split(':')
      // ::a.b.c.d → ['', '', 'a.b.c.d'] or similar
      const lastPart = parts[parts.length - 1]
      if (lastPart && lastPart.includes('.') && net.isIP(lastPart) === 4) {
        if (BLOCKLIST.check(lastPart, 'ipv4')) return true
      }
    }
    return false
  }

  // IPv4
  return BLOCKLIST.check(ip, 'ipv4')
}

/**
 * Resolve a hostname and return all IP addresses. Every IP must pass
 * isUnsafeIp. Returns the list of safe IPs (for pinning).
 */
async function resolveAndValidateHost(
  hostname: string,
  port: number,
): Promise<string[]> {
  // If hostname is already a literal IP, validate directly
  const ipFamily = net.isIP(hostname)
  if (ipFamily !== 0) {
    if (isUnsafeIp(hostname)) {
      throw new Error(
        `web_fetch: refusing to connect to ${hostname} — SSRF protection (blocked IP)`,
      )
    }
    return [hostname]
  }

  let addrs: LookupAddress[]
  try {
    addrs = await dns.lookup(hostname, { all: true })
  } catch (e) {
    throw new Error(`web_fetch: DNS resolution failed for "${hostname}": ${(e as Error).message}`)
  }

  if (addrs.length === 0) {
    throw new Error(`web_fetch: DNS returned no addresses for "${hostname}"`)
  }

  const safeIps: string[] = []
  for (const addr of addrs) {
    if (isUnsafeIp(addr.address)) {
      throw new Error(
        `web_fetch: refusing to connect to ${addr.address} (${addr.family === 4 ? 'IPv4' : 'IPv6'}) — SSRF protection (blocked IP range)`,
      )
    }
    safeIps.push(addr.address)
  }

  return safeIps
}

// ---------------------------------------------------------------------------
// HTTP client with IP pinning
// ---------------------------------------------------------------------------

/**
 * Create an http/https Agent whose DNS lookup is pinned to a pre-validated IP,
 * closing the DNS-rebinding TOCTOU window. The agent connects directly to the
 * pinned IP, ignoring any subsequent DNS change.
 */
function createPinnedAgent(scheme: 'http:' | 'https:', pinnedIp: string): http.Agent | https.Agent {
  // Format the host string correctly for an IPv6 literal (RFC 3986 requires
  // brackets around an IPv6 in a URI's host component). IPv4 doesn't need
  // brackets; net.isIP picks the right form.
  const isV6 = net.isIP(pinnedIp) === 6
  const hostLiteral = pinnedIp // LITERAL IP — what node uses for connect IP detection

  // For socket.connect(), we need the wire-form `host:port` string. IPv6
  // requires brackets around the address. The host field for the request
  // (used for IP detection in v24) is the IP literal alone — Node uses
  // net.isIP(opts.hostname||opts.host) to detect "is this an IP, skip DNS",
  // and including `:port` makes that check return 0 (not-an-IP).
  const hostWithPort = (port: number | string | null | undefined): string => {
    const portStr = port !== undefined && port !== null ? String(port) : '443'
    return isV6 ? `[${hostLiteral}]:${portStr}` : `${hostLiteral}:${portStr}`
  }

  if (scheme === 'https:') {
    const agent = new https.Agent({
      keepAlive: false,
      timeout: REQUEST_TIMEOUT_MS,
      // SNI / TLS cert hostname must remain the ORIGINAL hostname, not the IP.
      // The default https.Agent uses the request's Host header for SNI, so
      // we only override the connection target, not the TLS identity.
      servername: undefined, // let TLS use the Host header
    })
    const origCreate = agent.createConnection.bind(agent)
    agent.createConnection = (opts, cb) => {
      // Pin connect target to the literal IP. KEEP `hostname` as the IP
      // literal alone (Node v24 detects IP via `net.isIP(opts.hostname)`
      // BEFORE merging with port; including `:port` triggers a stray DNS
      // lookup that throws ENOTFOUND/Invalid IP on v24). For IPv6, we
      // bracket-IPv6 ONLY in `host`, not `hostname`. Drop `lookup` so
      // DNS is never re-queried (TOCTOU guard).
      const optsPinned = {
        ...opts,
        host: isV6 ? `[${hostLiteral}]` : hostLiteral,
        hostname: hostLiteral,
        lookup: undefined,
      }
      return origCreate(optsPinned, cb)
    }
    return agent
  }

  // http:
  const agent = new http.Agent({
    keepAlive: false,
    timeout: REQUEST_TIMEOUT_MS,
  })
  const origCreate = agent.createConnection.bind(agent)
  agent.createConnection = (opts, cb) => {
    const optsPinned = {
      ...opts,
      host: isV6 ? `[${hostLiteral}]` : hostLiteral,
      hostname: hostLiteral,
      lookup: undefined,
    }
    return origCreate(optsPinned, cb)
  }
  return agent
}

// ---------------------------------------------------------------------------
// Low-level HTTP request (single hop, no redirect following)
// ---------------------------------------------------------------------------

interface HopResult {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
  hitByteCap: boolean
}

/**
 * Perform a single HTTP(S) request with IP pinning, timeout, and byte cap.
 * Does NOT follow redirects — the caller handles that.
 */
function singleHop(
  url: URL,
  pinnedIp: string,
  signal?: AbortSignal,
): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:'
    const agent = createPinnedAgent(url.protocol as 'http:' | 'https:', pinnedIp)
    const port = url.port ? parseInt(url.port, 10) : isHttps ? 443 : 80
    const path = url.pathname + url.search

    const reqOpts: https.RequestOptions = {
      method: 'GET',
      protocol: url.protocol,
      hostname: url.hostname,
      port,
      path,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      agent,
      timeout: REQUEST_TIMEOUT_MS,
      // v0.29: 外部取消（turn.cancel / 用户关闭状态机）——node http 原生支持
      // AbortSignal：abort 时自动 destroy 请求并触发 'error'（AbortError）。
      ...(signal !== undefined ? { signal } : {}),
      // Don't follow redirects automatically — we handle them manually
    }

    const req = (isHttps ? https : http).request(reqOpts, (res: IncomingMessage) => {
      const chunks: Buffer[] = []
      let totalBytes = 0
      let hitByteCap = false

      res.on('data', (chunk: Buffer) => {
        if (hitByteCap) return
        if (totalBytes + chunk.length > MAX_RESPONSE_BYTES) {
          const remaining = MAX_RESPONSE_BYTES - totalBytes
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
          hitByteCap = true
          res.destroy() // stop reading
          return
        }
        chunks.push(chunk)
        totalBytes += chunk.length
      })

      res.on('end', () => {
        const body = Buffer.concat(chunks)
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
          hitByteCap,
        })
      })

      res.on('error', (e) => {
        reject(new Error(`web_fetch: response stream error for ${url.href}: ${e.message}`))
      })
    })

    req.on('error', (e) => {
      // Node error codes: ECONNREFUSED, ENOTFOUND, ETIMEDOUT, ECONNRESET, etc.
      reject(new Error(`web_fetch: request to ${url.href} failed: ${e.message}`))
    })

    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`web_fetch: request timed out after ${REQUEST_TIMEOUT_MS}ms for ${url.href}`))
    })

    req.end()
  })
}

// ---------------------------------------------------------------------------
// Redirect chain
// ---------------------------------------------------------------------------

/**
 * Fetch a URL, following redirects manually (max 5 hops). Each hop re-validates
 * scheme + IP. Returns the final response.
 */
async function fetchWithRedirects(
  startUrl: URL,
  signal?: AbortSignal,
): Promise<{ result: HopResult; finalUrl: URL }> {
  let url = startUrl
  let hops = 0

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // v0.29: 协作式取消——重定向链中 abort 即停。
    if (signal?.aborted === true) {
      throw new Error('web_fetch was aborted by the caller.')
    }
    // Re-validate scheme on every hop (a redirect could change it)
    validateUrl(url.href)

    // Re-validate IP on every hop (a redirect could change the host)
    const port = url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80
    const safeIps = await resolveAndValidateHost(url.hostname, port)
    const pinnedIp = safeIps[0]!

    const result = await singleHop(url, pinnedIp, signal)

    // Check for redirect (3xx)
    const status = result.status
    const isRedirect = status >= 300 && status < 400 && status !== 304

    if (!isRedirect) {
      return { result, finalUrl: url }
    }

    // Follow redirect
    if (hops >= MAX_REDIRECTS) {
      throw new Error(`web_fetch: too many redirects (>${MAX_REDIRECTS}) from ${startUrl.href}`)
    }

    const location = result.headers['location']
    if (!location || typeof location !== 'string') {
      // Redirect without Location header — treat as terminal
      return { result, finalUrl: url }
    }

    // Resolve relative redirects against the current URL
    try {
      url = new URL(location, url.href)
    } catch {
      throw new Error(`web_fetch: bad redirect target "${location}" from ${url.href}`)
    }
    hops++
  }
}

// ---------------------------------------------------------------------------
// Charset detection + body decoding
// ---------------------------------------------------------------------------

/**
 * Extract charset from Content-Type header (e.g. "text/html; charset=utf-8" → "utf-8").
 */
function charsetFromContentType(contentType: string): string | null {
  const match = /charset=["']?([a-zA-Z0-9_-]+)/i.exec(contentType)
  return match ? match[1]!.toLowerCase() : null
}

/**
 * Decode a response body Buffer to string, honoring charset:
 *   1. Content-Type header charset
 *   2. BOM (UTF-8 BOM → utf-8, UTF-16 BOM → utf-16le/be)
 *   3. UTF-8 (default)
 *
 * Node's TextDecoder supports: utf-8, utf-16le, utf-16be, gbk, gb18030, etc.
 */
function decodeBody(buf: Buffer, contentType: string | null): string {
  // 1. Content-Type charset
  if (contentType) {
    const cs = charsetFromContentType(contentType)
    if (cs) {
      try {
        return new TextDecoder(cs).decode(buf)
      } catch {
        // Unknown charset label — fall through to BOM/UTF-8
      }
    }
  }

  // 2. BOM detection
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3))
  }
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(buf.subarray(2))
    }
    if (buf[0] === 0xfe && buf[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(buf.subarray(2))
    }
  }

  // 3. UTF-8 (Node's default; invalid sequences become replacement chars)
  return new TextDecoder('utf-8').decode(buf)
}

// ---------------------------------------------------------------------------
// HTML → text / markdown rendering
// ---------------------------------------------------------------------------

/**
 * Extract readable text from HTML using @mozilla/readability + linkedom.
 * Strips script/style/nav/footer chrome, returns the main content text.
 */
function htmlToText(html: string): string {
  try {
    const { document } = parseHTML(html)
    // linkedom's document is structurally compatible with Readability's
    // expected DOM but its TS types don't match DOM lib's Document. Cast
    // through unknown to satisfy the constructor.
    const reader = new Readability(document as unknown as never)
    const article = reader.parse()
    if (article && article.textContent) {
      return article.textContent.trim()
    }
    // Readability failed (too short / not article-like) — fallback: strip tags
    return stripTagsFallback(html)
  } catch {
    // linkedom or readability threw — fallback
    return stripTagsFallback(html)
  }
}

/**
 * Fallback HTML→text: remove script/style/head content, strip tags, decode
 * common entities, collapse blank lines.
 */
function stripTagsFallback(html: string): string {
  let s = html
  // Remove script/style/head/nav/footer content
  for (const tag of ['script', 'style', 'head', 'nav', 'footer']) {
    const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi')
    s = s.replace(re, '')
  }
  // Replace block tags with newlines
  s = s.replace(/<(p|div|br|li|tr|h[1-6]|article|section|blockquote|pre|dd|dt)[^>]*>/gi, '\n')
  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, '')
  // Decode common entities
  s = s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
  // Collapse blank lines
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n')
    .trim()
}

/**
 * Convert readability-extracted HTML content to lightweight markdown.
 * Uses the article's innerHTML (readability returns cleaned HTML) and applies
 * simple tag→markdown conversions.
 */
function htmlToMarkdown(html: string): string {
  let articleHtml: string
  let articleText: string
  try {
    const { document } = parseHTML(html)
    const reader = new Readability(document as unknown as never)
    const article = reader.parse()
    if (article) {
      // Readability's article has `content` (cleaned article HTML, not
      // innerHTML) and textContent. The TS types are loose; access via typed cast.
      const a = article as { content?: string; textContent?: string }
      articleHtml = a.content ?? ''
      articleText = a.textContent ?? ''
    } else {
      articleHtml = html
      articleText = stripTagsFallback(html)
    }
  } catch {
    articleHtml = html
    articleText = stripTagsFallback(html)
  }

  // If readability produced no usable HTML, fall back to text with a note
  if (!articleHtml || articleHtml.trim().length === 0) {
    return `[format=markdown requested, fallback to text]\n${articleText}`
  }

  // Simple HTML → markdown conversion on the readability-cleaned HTML
  let md = articleHtml
  // Headings
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n')
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n')
  md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n')
  // Links
  md = md.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
  // Bold / italic
  md = md.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
  md = md.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
  // Code blocks
  md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n')
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
  // List items
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
  // Paragraphs / divs / blockquotes → newlines
  md = md.replace(/<(p|div|section|article|blockquote)[^>]*>/gi, '\n')
  md = md.replace(/<\/(p|div|section|article|blockquote)>/gi, '\n')
  // Line breaks
  md = md.replace(/<br\s*\/?>/gi, '\n')
  // Strip remaining tags
  md = md.replace(/<[^>]+>/g, '')
  // Decode entities
  md = md
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
  // Collapse 3+ blank lines to 1
  md = md.replace(/\n{3,}/g, '\n\n')
  return md.trim()
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Fetch a URL and return rendered text/markdown/html.
 *
 * SSRF-safe: blocks private/loopback/link-local IPs. HTML rendered via
 * readability+linkedom; JSON/plain returned raw. 不截断（2026-09-12 用户拍板）。
 *
 * @throws Error('web_fetch: <message>') on any failure
 */
export async function webFetch(input: WebFetchInput): Promise<string> {
  const format = input.format ?? 'text'
  const signal = input.signal

  // 1. Validate URL (scheme whitelist)
  const startUrl = validateUrl(input.url)

  // 2. Fetch with redirect chain (each hop re-validates scheme + IP)
  const { result, finalUrl } = await fetchWithRedirects(startUrl, signal)

  // 3. Check HTTP status
  if (result.status === 0 || (result.status < 200) || (result.status >= 300)) {
    throw new Error(`web_fetch: HTTP ${result.status} from ${finalUrl.href}`)
  }

  // 4. Content-Type sniff
  const contentType = (result.headers['content-type'] as string | undefined) ?? ''
  const ctLower = contentType.toLowerCase()
  const isHtml =
    ctLower.includes('text/html') ||
    ctLower.includes('application/xhtml') ||
    (ctLower.length === 0 && result.body.toString('utf-8').trimStart().startsWith('<'))

  // 5. Decode body
  const decoded = decodeBody(result.body, contentType || null)

  // 6. Render
  let content: string
  if (format === 'html') {
    content = decoded
  } else if (isHtml) {
    if (format === 'markdown') {
      content = htmlToMarkdown(decoded)
    } else {
      content = htmlToText(decoded)
    }
  } else {
    // Non-HTML (JSON, plain text, etc.) → verbatim
    content = decoded
  }

  // 7. Check for empty result
  if (content.trim().length === 0) {
    throw new Error(`web_fetch: page fetched but no readable text at ${finalUrl.href}`)
  }

  return content
}

// Build the WebFetchResult (for ToolContext storage — not returned to LLM).
// The loop only gets `content` (the string); the full result is available
// via a side channel if needed in the future.
export async function webFetchFull(input: WebFetchInput): Promise<WebFetchResult> {
  const format = input.format ?? 'text'
  const startUrl = validateUrl(input.url)
  const { result, finalUrl } = await fetchWithRedirects(startUrl, input.signal)
  const contentType = (result.headers['content-type'] as string | undefined) ?? ''
  const ctLower = contentType.toLowerCase()
  const isHtml =
    ctLower.includes('text/html') ||
    ctLower.includes('application/xhtml') ||
    (ctLower.length === 0 && result.body.toString('utf-8').trimStart().startsWith('<'))
  const decoded = decodeBody(result.body, contentType || null)
  let content: string
  if (format === 'html') {
    content = decoded
  } else if (isHtml) {
    content = format === 'markdown' ? htmlToMarkdown(decoded) : htmlToText(decoded)
  } else {
    content = decoded
  }
  return {
    content,
    finalUrl: finalUrl.href,
    status: result.status,
    contentType,
  }
}
