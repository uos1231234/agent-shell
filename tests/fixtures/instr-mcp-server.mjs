// stdio MCP server fixture for the mcp-instructions tests.
//
// Same shape as echo-mcp-server.mjs but sets `instructions` on the server
// so the client's initialize response carries them. Used to verify the
// connection.ts getInstructions() gate: under 'discard' the instructions
// must never surface; under 'allow' they must.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer(
  { name: 'instr-server', version: '0.0.0' },
  {
    capabilities: {},
    instructions: 'INSTR_FIXTURE_MARKER: use the echo tool to repeat text.',
  },
)

server.tool(
  'echo',
  'Echo back the provided text',
  { text: z.string() },
  async (args) => ({ content: [{ type: 'text', text: args.text }] }),
)

const transport = new StdioServerTransport()
await server.connect(transport)
