// HTTP MCP server fixture for tests/mcp/http.test.ts.
//
// Spawns a node:http server on 127.0.0.1 that delegates every request to a
// single StreamableHTTPServerTransport (stateful mode, server-generated session
// id). Registers an `echo` tool that returns its `text` argument verbatim.
//
// Port is taken from argv[2] (or 0 = ephemeral). Once listening, the chosen
// port is printed to stdout as `PORT=<n>` so the test can connect to it.
//
// Run directly with `node tests/fixtures/http-mcp-server.mjs <port>`.

import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const port = Number.parseInt(process.argv[2] ?? '0', 10) || 0

const mcp = new McpServer(
  { name: 'echo-http-server', version: '0.0.0' },
  { capabilities: {} },
)

mcp.tool(
  'echo',
  'Echo back the provided text over HTTP',
  { text: z.string() },
  async (args) => ({ content: [{ type: 'text', text: args.text }] }),
)

// One stateful transport instance serves all requests on this server.
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
await mcp.connect(transport)

const httpServer = http.createServer(async (req, res) => {
  await transport.handleRequest(req, res)
})

httpServer.listen(port, '127.0.0.1', () => {
  const addr = httpServer.address()
  const actualPort = typeof addr === 'object' && addr ? addr.port : port
  // Signal the chosen port to the parent test process.
  process.stdout.write(`PORT=${actualPort}\n`)
})

// Keep the server alive until the parent kills the process (test teardown).
