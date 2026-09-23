// Real-subprocess tests for the MCP instructions discard/allow gate.
//
// Uses tests/fixtures/instr-mcp-server.mjs, an MCP server that sets
// `instructions` in its initialize response. We boot it twice:
//   1. default (discard)  → bootMcpServers.instructions is {} and
//      conn.getInstructions() is undefined.
//   2. mcpInstructionsMode:'allow' → bootMcpServers.instructions carries the
//      server's string and conn.getInstructions() returns it.
//
// This is the end-to-end proof that a compromised server's instructions
// cannot reach the system prompt unless the operator explicitly opts in.

import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { ToolRegistry } from '../../src/shell/registry.js'
import { bootMcpServers } from '../../src/mcp/boot.js'
import { connectToServer } from '../../src/mcp/connection.js'
import type { McpBootResult } from '../../src/mcp/boot.js'

const here = dirname(fileURLToPath(import.meta.url))
const instrFixture = join(here, '..', 'fixtures', 'instr-mcp-server.mjs')

const INSTR_MARKER = 'INSTR_FIXTURE_MARKER'

let booted: McpBootResult | undefined
afterEach(async () => {
  if (booted) {
    await booted.close()
    booted = undefined
  }
})

function serverCfg(mode: 'discard' | 'allow' | undefined) {
  return {
    name: 'instr-srv',
    transport: 'stdio' as const,
    command: process.execPath,
    args: [instrFixture],
    timeoutMs: 15000,
    ...(mode !== undefined ? { mcpInstructionsMode: mode } : {}),
  }
}

describe('mcp/instructions — real subprocess discard/allow gate', () => {
  it('default mode discards server instructions (boot collects nothing)', async () => {
    const registry = new ToolRegistry()
    booted = await bootMcpServers(registry, [serverCfg(undefined)])

    expect(booted.instructions).toEqual({})
  })

  it('default mode: conn.getInstructions() returns undefined', async () => {
    const conn = await connectToServer(serverCfg(undefined))
    try {
      expect(conn.getInstructions?.()).toBeUndefined()
    } finally {
      await conn.close()
    }
  })

  it("mode 'allow' surfaces server instructions via bootMcpServers", async () => {
    const registry = new ToolRegistry()
    booted = await bootMcpServers(registry, [serverCfg('allow')])

    expect(booted.instructions).toHaveProperty('instr-srv')
    expect(booted.instructions['instr-srv']).toContain(INSTR_MARKER)
  })

  it("mode 'allow': conn.getInstructions() returns the server's string", async () => {
    const conn = await connectToServer(serverCfg('allow'))
    try {
      const instr = conn.getInstructions?.()
      expect(typeof instr).toBe('string')
      expect(instr).toContain(INSTR_MARKER)
    } finally {
      await conn.close()
    }
  })
})
