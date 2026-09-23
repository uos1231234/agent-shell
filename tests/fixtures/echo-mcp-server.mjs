// stdio MCP server fixture for tests/mcp/stdio.test.ts.
//
// Registers two tools:
//   - `echo`: returns its `text` argument verbatim as a text content block.
//   - `fail`: returns an isError result, to exercise the callTool→throw path (D2).
//
// Run directly with `node` (no build step — .mjs). Launched as a subprocess
// by bootMcpServers via StdioClientTransport. Uses zod for the echo param
// schema so McpServer parses+passes arguments to the callback correctly.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer(
  { name: 'echo-server', version: '0.0.0' },
  { capabilities: {} },
)

// echo: return the provided text as a text content block.
server.tool(
  'echo',
  'Echo back the provided text',
  { text: z.string() },
  async (args) => ({ content: [{ type: 'text', text: args.text }] }),
)

// fail: isError result so the client's callTool must throw (D2).
server.tool('fail', 'Always returns an MCP error', async () => ({
  content: [{ type: 'text', text: 'boom' }],
  isError: true,
}))

const transport = new StdioServerTransport()
await server.connect(transport)
