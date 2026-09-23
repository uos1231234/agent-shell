/**
 * === Wiki-Mcp Connection Adapter ===
 *
 * v0.13.1: spawn `src/mcp-servers/wiki-mcp/wiki_server.js` as a child process and
 * speak JSON-RPC 2.0 over its stdin/stdout. Implements the same narrow
 * `McpConnection` interface as `src/mcp/connection.ts` so boot.ts's
 * `registerMcpConnection` can register its tools into the harness registry
 * under the `wiki` server name (flat names `wiki__<tool>`).
 *
 * Why a hand-rolled adapter instead of the MCP SDK's StdioClientTransport?
 * The wiki-mcp server is a zero-dependency ESM process speaking the MCP
 * line-delimited JSON-RPC protocol directly. The SDK transport works, but
 * pulling it in here would widen the SDK's import surface beyond
 * `src/mcp/connection.ts` (v0.13 constraint 1: SDK imports live only under
 * src/mcp/). This adapter uses only `node:child_process` + `node:events` —
 * no new dependency, no SDK leak — and is mockable in tests by injecting a
 * fake spawn.
 *
 * Protocol contract (verified against wiki_server.js):
 *   - Client writes one JSON-RPC request per line to the child's stdin.
 *   - Server writes one JSON-RPC response per line to its stdout.
 *   - Server logs go to stderr (logger.js) — never mixed into stdout.
 *   - Methods used: initialize / tools/list / tools/call / ping.
 *   - Server's PROTOCOL_VERSION = '2024-11-05' (supported by SDK 1.30.0).
 *
 * Lifecycle: `close()` kills the child process (SIGTERM). The connection is
 * single-use; listTools is memoized after the first call (server tool list
 * is static for the process lifetime).
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { Writable, Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { McpConnection } from '../../mcp/connection.js'

// Resolve wiki_server.js relative to this file so the adapter works regardless of
// the harness process's cwd (tests run from repo root; production may run
// from elsewhere). This file lives at src/mcp-servers/wiki-mcp/.
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const DEFAULT_SERVER_PATH = join(__dirname, 'wiki_server.js')

/**
 * Spawn config for the wiki-mcp server. Exported so tests can inject a fake
 * spawn (e.g. a stub that returns canned JSON-RPC responses) without touching
 * real subprocess I/O.
 */
export type WikiSpawnFn = (
  command: string,
  args: readonly string[],
  opts: { stdio: readonly ['pipe', 'pipe', 'inherit']; env?: NodeJS.ProcessEnv },
) => ChildProcess

const defaultSpawn: WikiSpawnFn = (command, args, opts) =>
  spawn(command, args as string[], opts as { stdio: ['pipe', 'pipe', 'inherit']; env?: NodeJS.ProcessEnv }) as ChildProcess

/**
 * Create a live McpConnection to the wiki-mcp server.
 *
 * @param opts.serverPath  Absolute path to wiki_server.js. Defaults to the
 *                         sibling wiki_server.js resolved from this adapter file.
 * @param opts.nodeCommand Node binary to invoke. Defaults to `node`.
 * @param opts.spawn       Injectable spawn function (tests).
 * @param opts.timeoutMs   Per-request timeout (ms). Defaults to 30s.
 */
export function createWikiMcpConnection(opts: {
  serverPath?: string
  nodeCommand?: string
  spawn?: WikiSpawnFn
  timeoutMs?: number
  /** v0.33: 子进程环境变量增补（WIKI_DATA_DIR 全局单库覆盖）。默认继承宿主进程环境。 */
  env?: NodeJS.ProcessEnv
} = {}): McpConnection {
  const serverPath = opts.serverPath ?? DEFAULT_SERVER_PATH
  const nodeCmd = opts.nodeCommand ?? 'node'
  const spawnFn = opts.spawn ?? defaultSpawn
  const timeout = opts.timeoutMs ?? 30_000

  const proc = spawnFn(nodeCmd, [serverPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
    ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
  })
  // stdio is ['pipe','pipe','inherit'] so stdin/stdout are non-null streams; the
  // generic ChildProcess type marks them nullable, so capture + assert once.
  const stdin = proc.stdin as Writable
  const stdout = proc.stdout as Readable

  // Pending requests by JSON-RPC id → { resolve, reject, timer }.
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  let nextId = 1
  let buffer = ''
  let closed = false

  // Line-delimited JSON-RPC: accumulate stdout, split on '\n', dispatch each
  // complete line to its pending waiter by id.
  stdout.setEncoding('utf-8')
  stdout.on('data', (chunk: string) => {
    buffer += chunk
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line === '') continue
      let msg: { id?: number; result?: unknown; error?: { message?: string } }
      try {
        msg = JSON.parse(line)
      } catch {
        // Malformed line from the server — skip. Server logs to stderr, so a
        // parse failure here is a protocol violation we can't recover per-line.
        continue
      }
      if (typeof msg.id !== 'number') continue
      const entry = pending.get(msg.id)
      if (!entry) continue
      pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.error) {
        entry.reject(new Error(msg.error.message ?? `wiki-mcp request ${msg.id} failed`))
      } else {
        entry.resolve(msg.result)
      }
    }
  })

  proc.on('error', (err) => {
    // Child failed to spawn — reject all pending with the spawn error.
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(`wiki-mcp process error: ${err.message}`))
    }
    pending.clear()
  })

  proc.on('exit', (code, signal) => {
    closed = true
    // Reject any still-pending requests: the process is gone.
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(
        new Error(`wiki-mcp process exited (code=${code} signal=${signal}) before responding`),
      )
    }
    pending.clear()
  })

  const send = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error('wiki-mcp connection closed'))
        return
      }
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`wiki-mcp "${method}" timed out after ${timeout}ms`))
      }, timeout)
      pending.set(id, { resolve, reject, timer })
      const req = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
      stdin.write(req, (err) => {
        if (err) {
          pending.delete(id)
          clearTimeout(timer)
          reject(new Error(`wiki-mcp write failed: ${err.message}`))
        }
      })
    })

  // MCP initialize handshake. The server returns { protocolVersion, capabilities,
  // serverInfo, instructions }. We don't negotiate capabilities beyond tools —
  // the server statically advertises tools + resources.
  let initDone = false
  const ensureInit = async (): Promise<void> => {
    if (initDone) return
    await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agent-shell', version: '0.13.1' },
    })
    initDone = true
  }

  // Memoize tools/list — the server's tool set is static for the process
  // lifetime (no hot-plug). Avoids a round-trip on every registry boot.
  let toolsCache:
    | { name: string; description?: string; inputSchema: unknown }[]
    | undefined

  return {
    serverName: 'wiki',
    async listTools() {
      await ensureInit()
      if (toolsCache) return toolsCache
      const result = (await send('tools/list', {})) as {
        tools: { name: string; description?: string; inputSchema: unknown }[]
      }
      toolsCache = result.tools
      return toolsCache
    },
    async callTool(name, args) {
      await ensureInit()
      const result = (await send('tools/call', { name, arguments: args })) as {
        content?: unknown
        isError?: boolean
      }
      return stringifyCallToolResult(result, name)
    },
    async close() {
      if (closed) return
      closed = true
      for (const [, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error('wiki-mcp connection closed'))
      }
      pending.clear()
      proc.kill('SIGTERM')
    },
  }
}

/**
 * Turn the server's tools/call result into the single string the harness
 * LLM-facing layer consumes. Mirrors connection.ts's stringifyCallToolResult
 * (decision D2): isError → throw; text blocks joined with '\n'; empty → JSON.
 *
 * The wiki-mcp server always returns `content: [{ type: 'text', text: ... }]`
 * (see wiki_server.js textResponse / errResponse), so the text-join path is the
 * common case.
 */
function stringifyCallToolResult(
  result: { content?: unknown; isError?: boolean },
  toolName: string,
): string {
  const content = result.content
  const textBlocks: string[] = []
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        textBlocks.push((block as { text: string }).text)
      }
    }
  }
  const text = textBlocks.join('\n')
  if (result.isError === true) {
    const msg = text || JSON.stringify(result)
    throw new Error(`MCP tool "wiki__${toolName}" returned an error: ${msg}`)
  }
  if (text !== '') return text
  if (Array.isArray(content) && content.length > 0) return JSON.stringify(content)
  return JSON.stringify(result)
}
