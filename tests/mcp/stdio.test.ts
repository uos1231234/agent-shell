import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { ToolRegistry } from '../../src/shell/registry.js'
import { bootMcpServers } from '../../src/mcp/boot.js'
import type { McpBootResult } from '../../src/mcp/boot.js'

const here = dirname(fileURLToPath(import.meta.url))
const echoFixture = join(here, '..', 'fixtures', 'echo-mcp-server.mjs')

// Each test boots its own subprocess; close it in afterEach to avoid leaks.
let booted: McpBootResult | undefined
afterEach(async () => {
  if (booted) {
    await booted.close()
    booted = undefined
  }
})

describe('mcp/stdio — real subprocess via bootMcpServers', () => {
  it('lists the echo and fail tools from the fixture server', async () => {
    const registry = new ToolRegistry()
    booted = await bootMcpServers(registry, [
      {
        name: 'echo-srv',
        transport: 'stdio',
        command: process.execPath,
        args: [echoFixture],
        timeoutMs: 15000,
      },
    ])

    expect(booted.servers).toEqual(['echo-srv'])
    expect(booted.tools.sort()).toEqual(['echo-srv__echo', 'echo-srv__fail'])
    expect(registry.listMCPTools('echo-srv').sort()).toEqual(['echo', 'fail'])
  })

  it('execute(echo) returns the echoed text as a string', async () => {
    const registry = new ToolRegistry()
    booted = await bootMcpServers(registry, [
      {
        name: 'echo-srv',
        transport: 'stdio',
        command: process.execPath,
        args: [echoFixture],
        timeoutMs: 15000,
      },
    ])

    // v0.10.5: MCP tools now require a `reason` (registry guard).
    const result = await registry.execute('echo-srv__echo', { text: 'hello-mcp', reason: 'test' })
    expect(result).toBe('hello-mcp')
  })

  it('execute(fail) throws because the tool returns isError (D2)', async () => {
    const registry = new ToolRegistry()
    booted = await bootMcpServers(registry, [
      {
        name: 'echo-srv',
        transport: 'stdio',
        command: process.execPath,
        args: [echoFixture],
        timeoutMs: 15000,
      },
    ])

    // v0.10.5: MCP tools now require a `reason` (registry guard). The
    // underlying tool error is wrapped as `Tool "echo-srv__fail" failed: ...`.
    await expect(registry.execute('echo-srv__fail', { reason: 'test' })).rejects.toThrow(/error.*boom/)
  })

  it('getMCPTool exposes the inputSchema from the server', async () => {
    const registry = new ToolRegistry()
    booted = await bootMcpServers(registry, [
      {
        name: 'echo-srv',
        transport: 'stdio',
        command: process.execPath,
        args: [echoFixture],
        timeoutMs: 15000,
      },
    ])

    const echo = registry.getMCPTool('echo-srv', 'echo')
    expect(echo).toBeDefined()
    // echo fixture uses zod { text: z.string() }; the schema should reference text.
    expect(JSON.stringify(echo?.parameters)).toContain('text')
  })

  it('connection failure message includes the server name', async () => {
    const registry = new ToolRegistry()
    // Point at a non-existent executable to force a spawn failure.
    await expect(
      bootMcpServers(registry, [
        {
          name: 'missing-srv',
          transport: 'stdio',
          command: 'this-executable-does-not-exist-xyz',
          args: [],
          timeoutMs: 5000,
        },
      ]),
    ).rejects.toThrow(/missing-srv/)
  })
})
