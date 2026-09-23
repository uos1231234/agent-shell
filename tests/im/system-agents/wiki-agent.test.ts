// v0.13.1: wiki system agent integration tests.
//
// These tests verify:
//   a. createWikiAgent creates an agent + registers wiki__ tools into the registry
//   b. security hook: a non-wiki ctx calling a wiki__ tool throws
//   c. security hook: a wiki ctx (isWikiAgent: true) passes the hook
//      and dispatches to the (fake) connection
//   d. scan_codebase end-to-end: fake connection returns canned suggestions,
//      the agent's tool path surfaces them through execute()
//
// We use a FakeMcpConnection (no subprocess) so the tests are hermetic —
// no spawn, no real wiki-mcp server, no filesystem writes. The guard logic
// under test is the wiki__ security hook registered by createWikiAgent,
// which is connection-agnostic.

import { describe, it, expect } from 'vitest'
import { ToolRegistry } from '../../../src/shell/registry.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import { createNoopStateLine } from '../../../src/im/state-line/index.js'
import { createWikiAgent, WIKI_TOOL_REFS } from '../../../src/im/system-agents/wiki-agent.js'
import type { McpConnection } from '../../../src/mcp/connection.js'
import type { StreamChunk } from '../../../src/protocol/types.js'

// ---- fake connection -------------------------------------------------------

type FakeTool = { name: string; description?: string; inputSchema: unknown }

class FakeWikiConnection implements McpConnection {
  readonly serverName = 'wiki'
  readonly tools: FakeTool[]
  readonly callLog: { name: string; args: unknown }[] = []
  closeCount = 0
  // Canned responses keyed by tool name. Tests override per-case.
  responses: Map<string, unknown> = new Map()
  // Default: echo back the args as a text block.
  defaultResponse: unknown = null

  constructor(tools: FakeTool[]) {
    this.tools = tools
  }

  async listTools(): Promise<FakeTool[]> {
    return this.tools
  }

  async callTool(name: string, args: unknown): Promise<string> {
    this.callLog.push({ name, args })
    const resp = this.responses.get(name) ?? this.defaultResponse
    // Mimic the real server's response shape: { content: [{type:'text',text}] , isError? }
    if (resp !== null && typeof resp === 'object' && 'content' in (resp as object)) {
      const r = resp as { content?: unknown[]; isError?: boolean }
      const text = (r.content ?? []).map((b) => (b as { text?: string }).text ?? '').join('\n')
      if (r.isError) {
        throw new Error(`MCP tool "wiki__${name}" returned an error: ${text}`)
      }
      return text
    }
    // String default
    return typeof resp === 'string' ? resp : JSON.stringify(resp)
  }

  async close(): Promise<void> {
    this.closeCount += 1
  }
}

// The 17 wiki-mcp tool names (bare — boot.ts prefixes with wiki__).
const WIKI_BARE_TOOLS: FakeTool[] = WIKI_TOOL_REFS.map((ref) => {
  const bare = ref.replace(/^wiki__/, '')
  return { name: bare, description: `wiki tool ${bare}`, inputSchema: { type: 'object', properties: {} } }
})

// Minimal noop streamChat — the agent's run() isn't exercised in these tests
// (we test execute() + guard directly), but createWikiAgent requires it.
const noopStreamChat = async function* (): AsyncIterable<never> {}

const makeDeps = (conn: FakeWikiConnection) => ({
  registry: new ToolRegistry(),
  stateLine: createNoopStateLine(),
  llmStreamChat: noopStreamChat as unknown as Parameters<typeof createWikiAgent>[0]['llmStreamChat'],
  url: 'https://x',
  model: 'gpt-4',
  mailbox: new Mailbox(),
  connection: conn as McpConnection,
})

// ---- tests -----------------------------------------------------------------

describe('im/system-agents/wiki-agent', () => {
  it('createWikiAgent registers wiki__ tools and returns a closeable agent', async () => {
    const conn = new FakeWikiConnection(WIKI_BARE_TOOLS)
    const deps = makeDeps(conn)
    const agent = await createWikiAgent(deps)

    // All 17 flat names registered under the wiki server.
    expect(deps.registry.listMCPServers()).toEqual(['wiki'])
    const flatTools = deps.registry.listMCPTools('wiki')
    expect(flatTools.length).toBe(17)
    expect(flatTools).toContain('search_cards')
    expect(flatTools).toContain('scan_codebase')
    expect(flatTools).toContain('render_md')

    // The agent exposes closeConnection (WikiSystemAgent extension).
    expect(typeof agent.closeConnection).toBe('function')
    await agent.closeConnection()
    expect(conn.closeCount).toBe(1)
    // Idempotent: a second close is a no-op.
    await agent.closeConnection()
    expect(conn.closeCount).toBe(1)
  })

  it('guard: non-wiki ctx calling wiki__ tool throws (security hook)', async () => {
    const conn = new FakeWikiConnection(WIKI_BARE_TOOLS)
    const deps = makeDeps(conn)
    await createWikiAgent(deps)

    // No ctx (undefined) — hook rejects.
    await expect(
      deps.registry.execute('wiki__search_cards', { query: 'foo', reason: 'test' }),
    ).rejects.toThrow(/restricted to the wiki system agent/)

    // ctx without isWikiAgent — hook rejects.
    await expect(
      deps.registry.execute('wiki__search_cards', { query: 'foo', reason: 'test' }, {
        agentId: 'main',
      }),
    ).rejects.toThrow(/restricted to the wiki system agent/)

    // ctx.isWikiAgent === false — hook rejects.
    await expect(
      deps.registry.execute('wiki__search_cards', { query: 'foo', reason: 'test' }, {
        isWikiAgent: false,
      }),
    ).rejects.toThrow(/restricted to the wiki system agent/)

    // The fake connection must NOT have been called — hook is before dispatch.
    expect(conn.callLog.length).toBe(0)
  })

  it('guard: wiki ctx (isWikiAgent: true) passes hook and dispatches to connection', async () => {
    const conn = new FakeWikiConnection(WIKI_BARE_TOOLS)
    conn.responses.set('search_cards', {
      content: [{ type: 'text', text: '{"count":1,"results":[{"id":"mod-foo","title":"foo"}]}' }],
    })
    const deps = makeDeps(conn)
    await createWikiAgent(deps)

    // ctx.isWikiAgent === true — hook passes, executeGuarded runs (reason
    // validation + execute), the closure calls conn.callTool.
    const result = await deps.registry.execute(
      'wiki__search_cards',
      { query: 'foo', reason: 'find foo' },
      { isWikiAgent: true },
    )

    // The closure passed the bare name "search_cards" (not "wiki__search_cards").
    expect(conn.callLog).toEqual([{ name: 'search_cards', args: { query: 'foo', reason: 'find foo' } }])
    expect(typeof result).toBe('string')
    expect(result).toContain('mod-foo')
  })

  it('guard rejects even a non-wiki tool name that is NOT registered as wiki__', async () => {
    // Sanity: the hook keys off the name prefix only. A tool named 'other__x'
    // is not wiki-prefixed, so the hook lets it through (it then fails as
    // unregistered). This confirms the hook is prefix-scoped, not a blanket
    // block on all MCP tools.
    const conn = new FakeWikiConnection(WIKI_BARE_TOOLS)
    const deps = makeDeps(conn)
    await createWikiAgent(deps)

    await expect(
      deps.registry.execute('other__x', { reason: 'test' }, { isWikiAgent: true }),
    ).rejects.toThrow(/Tool not registered/)
  })

  it('scan_codebase surfaces suggestions through the wiki agent tool path', async () => {
    const cannedSuggestions = {
      files_scanned: 2,
      cards_suggested: 2,
      suggestions: [
        {
          id: 'src-registry',
          type: 'module',
          title: 'ToolRegistry',
          summary: 'Unified tool registry',
          source: 'src/shell/registry.ts',
          sourceSnippet: 'export class ToolRegistry',
          tags: ['scanned', 'file:src/shell/registry.ts'],
        },
        {
          id: 'src-loop',
          type: 'module',
          title: 'runIMLoop',
          summary: 'The IM main loop',
          source: 'src/im/loop.ts',
          sourceSnippet: 'export const runIMLoop',
          tags: ['scanned', 'file:src/im/loop.ts'],
        },
      ],
      root: 'D:/repo',
      degraded: false,
    }
    const conn = new FakeWikiConnection(WIKI_BARE_TOOLS)
    conn.responses.set('scan_codebase', {
      content: [{ type: 'text', text: JSON.stringify(cannedSuggestions) }],
    })
    const deps = makeDeps(conn)
    await createWikiAgent(deps)

    const result = await deps.registry.execute(
      'wiki__scan_codebase',
      { repo_path: 'D:/repo', reason: 'scan repo for cards' },
      { isWikiAgent: true },
    )

    // The closure called scan_codebase with the bare name + full args.
    expect(conn.callLog[0]).toEqual({
      name: 'scan_codebase',
      args: { repo_path: 'D:/repo', reason: 'scan repo for cards' },
    })
    // Result is the text the connection returned — parse it back to assert shape.
    expect(typeof result).toBe('string')
    const parsed = JSON.parse(result as string)
    expect(parsed.cards_suggested).toBe(2)
    expect(parsed.suggestions[0].id).toBe('src-registry')
    expect(parsed.suggestions[0].type).toBe('module')
  })

  it('wiki__ tool error from the connection propagates as a thrown Error', async () => {
    const conn = new FakeWikiConnection(WIKI_BARE_TOOLS)
    conn.responses.set('add_card', {
      isError: true,
      content: [{ type: 'text', text: '{"error":"duplicate id: mod-foo"}' }],
    })
    const deps = makeDeps(conn)
    await createWikiAgent(deps)

    // executeGuarded wraps the connection's thrown error as
    // `Tool "wiki__add_card" failed: MCP tool "wiki__add_card" returned an error: ...`
    await expect(
      deps.registry.execute(
        'wiki__add_card',
        { card: { id: 'mod-foo', type: 'module', title: 'foo', summary: 's', content: 'c' }, reason: 'add' },
        { isWikiAgent: true },
      ),
    ).rejects.toThrow(/wiki__add_card/)
  })
})
