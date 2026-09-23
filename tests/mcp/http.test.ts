import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { ToolRegistry } from '../../src/shell/registry.js'
import { bootMcpServers } from '../../src/mcp/boot.js'
import type { McpBootResult } from '../../src/mcp/boot.js'

const here = dirname(fileURLToPath(import.meta.url))
const httpFixture = join(here, '..', 'fixtures', 'http-mcp-server.mjs')

/**
 * Start the HTTP fixture subprocess on an ephemeral port and resolve once its
 * `PORT=<n>` line is read from stdout. Returns the base URL and a kill handle.
 */
function startHttpFixture(): Promise<{ url: string; kill: () => void }> {
  const child: ChildProcess = spawn(process.execPath, [httpFixture, '0'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let buf = ''
  return new Promise((resolve, reject) => {
    const onPort = (data: Buffer) => {
      buf += data.toString()
      const m = buf.match(/PORT=(\d+)/)
      if (m) {
        const port = Number(m[1])
        resolve({
          url: `http://127.0.0.1:${port}/mcp`,
          kill: () => {
            try {
              child.kill()
            } catch {
              /* already dead */
            }
          },
        })
      }
    }
    child.stdout?.on('data', onPort)
    child.on('error', reject)
    // Safety: if the process exits before printing PORT, reject.
    child.on('exit', (code) => {
      if (buf.indexOf('PORT=') === -1) {
        reject(new Error(`http fixture exited (code=${code}) before printing PORT`))
      }
    })
  })
}

// Track resources so afterEach always cleans up even on failure.
let booted: McpBootResult | undefined
let fixtureKill: (() => void) | undefined

afterEach(async () => {
  if (booted) {
    await booted.close()
    booted = undefined
  }
  if (fixtureKill) {
    fixtureKill()
    fixtureKill = undefined
  }
})

describe('mcp/http — real HTTP server via bootMcpServers', () => {
  it('lists the echo tool from the HTTP fixture', async () => {
    const fixture = await startHttpFixture()
    fixtureKill = fixture.kill

    const registry = new ToolRegistry()
    booted = await bootMcpServers(registry, [
      {
        name: 'echo-http',
        transport: 'http',
        url: fixture.url,
        timeoutMs: 15000,
      },
    ])

    expect(booted.servers).toEqual(['echo-http'])
    expect(booted.tools).toEqual(['echo-http__echo'])
    expect(registry.listMCPTools('echo-http')).toEqual(['echo'])
  })

  it('execute(echo) returns the echoed text over HTTP', async () => {
    const fixture = await startHttpFixture()
    fixtureKill = fixture.kill

    const registry = new ToolRegistry()
    booted = await bootMcpServers(registry, [
      {
        name: 'echo-http',
        transport: 'http',
        url: fixture.url,
        timeoutMs: 15000,
      },
    ])

    // v0.10.5: MCP tools now require a `reason` (registry guard).
    const result = await registry.execute('echo-http__echo', { text: 'over-http', reason: 'test' })
    expect(result).toBe('over-http')
  })

  it('connection failure to a bad HTTP endpoint includes the server name', async () => {
    const registry = new ToolRegistry()
    // Port 1 is reserved/unopenable on most systems → connection refused.
    await expect(
      bootMcpServers(registry, [
        {
          name: 'bad-http',
          transport: 'http',
          url: 'http://127.0.0.1:1/mcp',
          timeoutMs: 3000,
        },
      ]),
    ).rejects.toThrow(/bad-http/)
  })

  it('http config with headers is accepted (headers reach the transport)', async () => {
    const fixture = await startHttpFixture()
    fixtureKill = fixture.kill

    const registry = new ToolRegistry()
    // The fixture ignores headers, but the client must still connect fine
    // when headers are configured — exercising the requestInit wiring path.
    booted = await bootMcpServers(registry, [
      {
        name: 'echo-http',
        transport: 'http',
        url: fixture.url,
        headers: { 'X-Test': '1' },
        timeoutMs: 15000,
      },
    ])

    // v0.10.5: MCP tools now require a `reason` (registry guard).
    const result = await registry.execute('echo-http__echo', { text: 'with-headers', reason: 'test' })
    expect(result).toBe('with-headers')
  })
})
