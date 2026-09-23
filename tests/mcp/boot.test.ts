import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Mock connectToServer so bootMcpServers can be exercised end-to-end with
// fake connections — no SDK, no subprocess. The mock is per-test-file and
// returns whatever fake we configure via `__setNextConnections`.
import { ToolRegistry } from '../../src/shell/registry.js'

// We import boot after setting up the mock below. The mock factory captures
// a module-level queue of fake connections.
const fakeQueue: FakeConn[] = []
function __setNextConnections(conns: FakeConn[]): void {
  fakeQueue.length = 0
  fakeQueue.push(...conns)
}

vi.mock('../../src/mcp/connection.js', () => ({
  connectToServer: async () => {
    const conn = fakeQueue.shift()
    if (!conn) throw new Error('test setup error: no fake connection queued')
    return conn
  },
}))

// Import boot AFTER the mock is registered so it picks up the mocked connectToServer.
const { bootMcpServers, registerMcpConnection } = await import('../../src/mcp/boot.js')

// ---- fake connection -------------------------------------------------------

type FakeTool = { name: string; description?: string; inputSchema: unknown }

class FakeConn {
  readonly serverName: string
  readonly tools: FakeTool[]
  readonly callLog: { name: string; args: unknown }[] = []
  closeCount = 0
  closed = false
  /**
   * What getInstructions() returns. Real connections return undefined under
   * 'discard' and the server string under 'allow'; the fake lets each test
   * control this directly so boot's collection logic can be exercised.
   */
  instructionsResult: string | undefined = undefined

  constructor(serverName: string, tools: FakeTool[]) {
    this.serverName = serverName
    this.tools = tools
  }

  async listTools(): Promise<FakeTool[]> {
    return this.tools
  }

  async callTool(name: string, args: unknown): Promise<string> {
    this.callLog.push({ name, args })
    return `called ${this.serverName}__${name} with ${JSON.stringify(args)}`
  }

  getInstructions(): string | undefined {
    return this.instructionsResult
  }

  async close(): Promise<void> {
    this.closeCount++
    this.closed = true
  }
}

const echoSchema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }

// ---- tests -----------------------------------------------------------------

describe('mcp/boot — registerMcpConnection', () => {
  it('registers tools under server name and returns flat names', async () => {
    const registry = new ToolRegistry()
    const conn = new FakeConn('echo-srv', [
      { name: 'echo', description: 'echo back', inputSchema: echoSchema },
      { name: 'ping', inputSchema: { type: 'object', properties: {} } },
    ])

    const flat = await registerMcpConnection(registry, conn)

    expect(flat).toEqual(['echo-srv__echo', 'echo-srv__ping'])
    expect(registry.getMCPTool('echo-srv', 'echo')).toBeDefined()
    expect(registry.getMCPTool('echo-srv', 'ping')).toBeDefined()
    expect(registry.listMCPServers()).toEqual(['echo-srv'])
    expect(registry.listMCPTools('echo-srv').sort()).toEqual(['echo', 'ping'])
  })

  it('execute dispatches to conn.callTool with the ORIGINAL tool name', async () => {
    const registry = new ToolRegistry()
    const conn = new FakeConn('srv', [{ name: 'echo', inputSchema: echoSchema }])
    await registerMcpConnection(registry, conn)

    // v0.10.5: MCP tools now require a `reason` (registry guard). The guard
    // also strips reason before dispatch? No — the closure receives the full
    // args; only the schema-level injection is cosmetic. The guard validates
    // reason and passes args through. We assert callTool sees the original
    // tool name "echo" and the args minus nothing (reason is included).
    const result = await registry.execute('srv__echo', { text: 'hi', reason: 'test' })

    // The closure must pass the raw name "echo" (not "srv__echo") to callTool.
    expect(conn.callLog).toEqual([{ name: 'echo', args: { text: 'hi', reason: 'test' } }])
    expect(result).toBe('called srv__echo with {"text":"hi","reason":"test"}')
    expect(typeof result).toBe('string')
  })

  it('execute returns a string (D2 contract)', async () => {
    const registry = new ToolRegistry()
    const conn = new FakeConn('srv', [{ name: 'echo', inputSchema: echoSchema }])
    await registerMcpConnection(registry, conn)

    // v0.10.5: MCP tools now require a `reason` (registry guard).
    const result = await registry.execute('srv__echo', { text: 'x', reason: 'test' })
    expect(typeof result).toBe('string')
  })

  it('uses a generated description when the tool omits one', async () => {
    const registry = new ToolRegistry()
    const conn = new FakeConn('srv', [{ name: 'echo', inputSchema: echoSchema }])
    await registerMcpConnection(registry, conn)

    const tool = registry.getMCPTool('srv', 'echo')
    expect(tool?.description).toBe('MCP tool srv__echo')
  })

  it('throws on duplicate tool names within the same connection', async () => {
    const registry = new ToolRegistry()
    const conn = new FakeConn('srv', [
      { name: 'dup', inputSchema: echoSchema },
      { name: 'dup', inputSchema: echoSchema },
    ])

    await expect(registerMcpConnection(registry, conn)).rejects.toThrow(/duplicate.*dup/)
  })
})

describe('mcp/boot — bootMcpServers', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-boot-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('connects all servers, registers tools, returns flat tool names', async () => {
    const registry = new ToolRegistry()
    const c1 = new FakeConn('a', [{ name: 't1', inputSchema: echoSchema }])
    const c2 = new FakeConn('b', [{ name: 't2', inputSchema: echoSchema }])
    __setNextConnections([c1, c2])

    const result = await bootMcpServers(registry, [
      { name: 'a', transport: 'stdio', command: 'x' },
      { name: 'b', transport: 'http', url: 'http://x' },
    ])

    expect(result.servers).toEqual(['a', 'b'])
    expect(result.tools).toEqual(['a__t1', 'b__t2'])
    expect(registry.listMCPServers().sort()).toEqual(['a', 'b'])
  })

  it('throws on duplicate server names in config', async () => {
    const registry = new ToolRegistry()
    __setNextConnections([new FakeConn('a', [])])

    await expect(
      bootMcpServers(registry, [
        { name: 'a', transport: 'stdio', command: 'x' },
        { name: 'a', transport: 'stdio', command: 'y' },
      ]),
    ).rejects.toThrow(/Duplicate.*a/)
  })

  it('fail-fast: closes already-opened connections when a later one fails', async () => {
    const registry = new ToolRegistry()
    const c1 = new FakeConn('a', [{ name: 't1', inputSchema: echoSchema }])
    // Second connectToServer call will fail (queue empty -> throw).
    __setNextConnections([c1])

    await expect(
      bootMcpServers(registry, [
        { name: 'a', transport: 'stdio', command: 'x' },
        { name: 'b', transport: 'stdio', command: 'y' },
      ]),
    ).rejects.toThrow(/no fake connection queued/)

    // The first connection must have been closed during fail-fast cleanup.
    expect(c1.closeCount).toBe(1)
    expect(c1.closed).toBe(true)
  })

  it('close() is idempotent — second call is a no-op', async () => {
    const registry = new ToolRegistry()
    const c1 = new FakeConn('a', [{ name: 't1', inputSchema: echoSchema }])
    __setNextConnections([c1])

    const result = await bootMcpServers(registry, [
      { name: 'a', transport: 'stdio', command: 'x' },
    ])

    await result.close()
    await result.close()
    await result.close()

    expect(c1.closeCount).toBe(1)
  })

  it('instructions: default (discard) → boot collects nothing', async () => {
    // FakeConn simulates a 'discard' connection: getInstructions() returns
    // undefined regardless of what the server sent. boot must record nothing.
    const registry = new ToolRegistry()
    const c1 = new FakeConn('a', [{ name: 't1', inputSchema: echoSchema }])
    c1.instructionsResult = undefined // discard path
    __setNextConnections([c1])

    const result = await bootMcpServers(registry, [
      { name: 'a', transport: 'stdio', command: 'x' },
    ])

    expect(result.instructions).toEqual({})
  })

  it('instructions: allow + server-sent → boot collects them keyed by server', async () => {
    const registry = new ToolRegistry()
    const c1 = new FakeConn('a', [{ name: 't1', inputSchema: echoSchema }])
    c1.instructionsResult = 'Use tool t1 to echo text.' // allow path surfaced them
    __setNextConnections([c1])

    const result = await bootMcpServers(registry, [
      { name: 'a', transport: 'stdio', command: 'x' },
    ])

    expect(result.instructions).toEqual({ a: 'Use tool t1 to echo text.' })
  })

  it('instructions: allow but server sent none → boot collects nothing', async () => {
    const registry = new ToolRegistry()
    const c1 = new FakeConn('a', [{ name: 't1', inputSchema: echoSchema }])
    c1.instructionsResult = undefined // allow mode, but server sent no instructions
    __setNextConnections([c1])

    const result = await bootMcpServers(registry, [
      { name: 'a', transport: 'stdio', command: 'x' },
    ])

    expect(result.instructions).toEqual({})
  })
})
