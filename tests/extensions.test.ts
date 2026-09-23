// v0.13 Batch 3: bootstrapExtensions integration tests.
//
// Exercises the composition layer (src/extensions.ts) that wires bootMcpServers
// + loadSkillsFromDir together. We mock connectToServer (same手法 as
// tests/mcp/boot.test.ts) so no SDK subprocess is needed here — the real
// subprocess E2E lives in tests/im/sub-agent/mcp-pentest.test.ts.
//
// Coverage:
//   - MCP + skill assembled together → all three registry buckets queryable
//     and executable
//   - no MCP, no skillsDir → empty result + close is a no-op
//   - skill name colliding with an MCP flat name → throw + MCP connection closed
//   - close() is idempotent

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ToolRegistry } from '../src/shell/registry.js'

// ---- fake connection injection (mirrors tests/mcp/boot.test.ts) ----
const fakeQueue: FakeConn[] = []
function __setNextConnections(conns: FakeConn[]): void {
  fakeQueue.length = 0
  fakeQueue.push(...conns)
}

vi.mock('../src/mcp/connection.js', () => ({
  connectToServer: async () => {
    const conn = fakeQueue.shift()
    if (!conn) throw new Error('test setup error: no fake connection queued')
    return conn
  },
}))

// Import extensions AFTER the mock is registered so bootMcpServers picks up
// the mocked connectToServer.
const { bootstrapExtensions } = await import('../src/extensions.js')

type FakeTool = { name: string; description?: string; inputSchema: unknown }

class FakeConn {
  readonly serverName: string
  readonly tools: FakeTool[]
  readonly callLog: { name: string; args: unknown }[] = []
  closeCount = 0
  closed = false

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

  async close(): Promise<void> {
    this.closeCount++
    this.closed = true
  }
}

const echoSchema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }

// Write a skill .js module into `dir` with the given name + execute body.
const writeSkill = (dir: string, fileName: string, name: string, body: string): void => {
  writeFileSync(
    join(dir, fileName),
    `export default {
  name: '${name}',
  description: 'skill ${name}',
  execute: async (args) => ${body},
};`,
  )
}

// Write a text skill (.md) into `dir` with the given frontmatter + body.
const writeTextSkill = (
  dir: string,
  fileName: string,
  name: string,
  description: string,
  body: string,
): void => {
  writeFileSync(
    join(dir, fileName),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}`,
  )
}

describe('bootstrapExtensions — MCP + skill assembly', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ext-test-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('boots MCP and loads skills; all three registry buckets are queryable and executable', async () => {
    const conn = new FakeConn('echo-srv', [
      { name: 'echo', description: 'echo back', inputSchema: echoSchema },
    ])
    __setNextConnections([conn])
    writeSkill(dir, 'greet.js', 'greet', '`Hello from skill: ${args.text}`')

    const registry = new ToolRegistry()
    const result = await bootstrapExtensions({
      registry,
      mcpServers: [{ name: 'echo-srv', transport: 'stdio', command: 'node' }],
      skillsDir: dir,
    })

    expect(result.servers).toEqual(['echo-srv'])
    expect(result.tools).toEqual(['echo-srv__echo'])
    expect(result.skills).toEqual(['greet'])

    // MCP bucket
    expect(registry.getMCPTool('echo-srv', 'echo')).toBeDefined()
    expect(registry.listMCPServers()).toEqual(['echo-srv'])
    // Skill bucket
    expect(registry.getSkill('greet')).toBeDefined()
    expect(registry.listSkills()).toEqual(['greet'])
    // resolveRef classifies both correctly
    expect(registry.resolveRef('echo-srv__echo')).toEqual({ kind: 'mcp', server: 'echo-srv' })
    expect(registry.resolveRef('greet')).toEqual({ kind: 'skill' })

    // Execute both — MCP closure hits the fake connection, skill runs its body.
    // v0.10.5: MCP/skill tools now require a `reason` (registry guard); the
    // guard passes args through verbatim (reason is validated, not stripped).
    const mcpResult = await registry.execute('echo-srv__echo', { text: 'hi', reason: 'test' })
    expect(mcpResult).toBe('called echo-srv__echo with {"text":"hi","reason":"test"}')
    expect(conn.callLog).toEqual([{ name: 'echo', args: { text: 'hi', reason: 'test' } }])

    const skillResult = await registry.execute('greet', { text: 'world', reason: 'test' })
    expect(skillResult).toBe('Hello from skill: world')

    await result.close()
    expect(conn.closed).toBe(true)
    expect(conn.closeCount).toBe(1)
  })

  it('explicit empty mcpServers ([]) → all-empty result + close is a no-op', async () => {
    const registry = new ToolRegistry()
    const result = await bootstrapExtensions({ registry, mcpServers: [] })

    expect(result.servers).toEqual([])
    expect(result.tools).toEqual([])
    expect(result.skills).toEqual([])

    // close must not throw and must be callable multiple times
    await expect(result.close()).resolves.toBeUndefined()
    await expect(result.close()).resolves.toBeUndefined()
  })

  it('omitting mcpServers → defaults to DEFAULT_MCP_SERVERS (playwright)', async () => {
    // When the caller passes no mcpServers, bootstrapExtensions falls back
    // to DEFAULT_MCP_SERVERS. We mock the connection so no real subprocess
    // is spawned; the fake connection proves the default was applied.
    const conn = new FakeConn('playwright', [
      { name: 'browser_navigate', inputSchema: echoSchema },
    ])
    __setNextConnections([conn])

    const registry = new ToolRegistry()
    const result = await bootstrapExtensions({ registry })

    expect(result.servers).toEqual(['playwright'])
    expect(result.tools).toEqual(['playwright__browser_navigate'])
    await result.close()
    expect(conn.closed).toBe(true)
  })

  it('skill name colliding with an MCP flat name throws AND closes the MCP connection', async () => {
    // MCP registers `echo-srv__echo`. The skill below is named `echo-srv__echo`
    // — loadSkillsFromDir({ registry }) detects the collision against the MCP
    // flat name and throws. bootstrapExtensions must then close the MCP
    // connection opened earlier so no partial state escapes.
    const conn = new FakeConn('echo-srv', [
      { name: 'echo', inputSchema: echoSchema },
    ])
    __setNextConnections([conn])
    // The skill name collides with the flat MCP name `echo-srv__echo`.
    writeSkill(dir, 'bad.js', 'echo-srv__echo', `'should not load'`)

    const registry = new ToolRegistry()
    await expect(
      bootstrapExtensions({
        registry,
        mcpServers: [{ name: 'echo-srv', transport: 'stdio', command: 'node' }],
        skillsDir: dir,
      }),
    ).rejects.toThrow(/collides with MCP tool "echo-srv__echo"/)

    // The MCP connection was opened before the skill stage failed; it must
    // have been closed by the fail-fast cleanup in bootstrapExtensions.
    expect(conn.closed).toBe(true)
    expect(conn.closeCount).toBe(1)

    // Registry still has the MCP tools (they were registered before the skill
    // stage), but the skill was never registered.
    expect(registry.getMCPTool('echo-srv', 'echo')).toBeDefined()
    expect(registry.getSkill('echo-srv__echo')).toBeUndefined()
  })

  it('close() is idempotent across multiple calls', async () => {
    const conn = new FakeConn('a', [{ name: 't1', inputSchema: echoSchema }])
    __setNextConnections([conn])

    const registry = new ToolRegistry()
    const result = await bootstrapExtensions({
      registry,
      mcpServers: [{ name: 'a', transport: 'stdio', command: 'node' }],
    })

    await result.close()
    await result.close()
    await result.close()

    // The underlying connection's close is idempotent (boot.ts D3), and our
    // local `closed` flag short-circuits before even calling it again.
    expect(conn.closeCount).toBe(1)
  })

  it('boots MCP + module skill + text skill together; all three buckets populated and mutually non-colliding', async () => {
    const conn = new FakeConn('echo-srv', [
      { name: 'echo', description: 'echo back', inputSchema: echoSchema },
    ])
    __setNextConnections([conn])
    writeSkill(dir, 'greet.js', 'greet', '`Hello from skill: ${args.text}`')
    // A separate temp dir for text skills (the `dir` fixture is used for the
    // module skill above). Created+cleaned within this test.
    const textDir = mkdtempSync(join(tmpdir(), 'ext-text-'))
    try {
      writeTextSkill(textDir, 'style-guide.md', 'style-guide', '写诗风格规则', '\n- 每行不超过 12 字\n- 押 ang 韵\n')

      const registry = new ToolRegistry()
      const result = await bootstrapExtensions({
        registry,
        mcpServers: [{ name: 'echo-srv', transport: 'stdio', command: 'node' }],
        skillsDir: dir,
        textSkillsDir: textDir,
      })

      expect(result.servers).toEqual(['echo-srv'])
      expect(result.tools).toEqual(['echo-srv__echo'])
      expect(result.skills).toEqual(['greet'])
      expect(result.textSkills).toEqual(['style-guide'])

      // All three buckets queryable + resolvable to the right kind.
      expect(registry.resolveRef('echo-srv__echo')).toEqual({ kind: 'mcp', server: 'echo-srv' })
      expect(registry.resolveRef('greet')).toEqual({ kind: 'skill' })
      // v0.10.6: text skills resolve as 'textSkill' (not 'skill') — they are
      // pre-injected into the system prompt, NOT exposed as callable tools.
      expect(registry.resolveRef('style-guide')).toEqual({ kind: 'textSkill' })

      // v0.10.6: text skills are no longer callable via execute (they are
      // pre-injected content). Verify the stored body is retrievable instead.
      const stored = registry.getTextSkill('style-guide')
      expect(stored?.body).toBe('\n- 每行不超过 12 字\n- 押 ang 韵\n')

      await result.close()
      expect(conn.closed).toBe(true)
    } finally {
      rmSync(textDir, { recursive: true, force: true })
    }
  })

  it('text skill colliding with an MCP flat name throws AND closes the MCP connection', async () => {
    // MCP registers `echo-srv__echo`. The text skill below is named
    // `echo-srv__echo` — loadTextSkillsFromDir({ registry }) detects the
    // collision against the MCP flat name and throws. bootstrapExtensions
    // must then close the MCP connection opened earlier (fail-fast cleanup).
    const conn = new FakeConn('echo-srv', [
      { name: 'echo', inputSchema: echoSchema },
    ])
    __setNextConnections([conn])
    writeTextSkill(dir, 'bad.md', 'echo-srv__echo', 'shadow mcp', '\nbody\n')

    const registry = new ToolRegistry()
    await expect(
      bootstrapExtensions({
        registry,
        mcpServers: [{ name: 'echo-srv', transport: 'stdio', command: 'node' }],
        textSkillsDir: dir,
      }),
    ).rejects.toThrow(/collides with MCP tool "echo-srv__echo"/)

    // The MCP connection was opened before the text-skill stage failed; it
    // must have been closed by the fail-fast cleanup in bootstrapExtensions.
    expect(conn.closed).toBe(true)
    expect(conn.closeCount).toBe(1)

    // Registry still has the MCP tools (registered before the text-skill
    // stage), but the text skill was never registered.
    expect(registry.getMCPTool('echo-srv', 'echo')).toBeDefined()
    expect(registry.getSkill('echo-srv__echo')).toBeUndefined()
  })
})
