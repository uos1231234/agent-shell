// MCP boot: turn a list of McpServerConfig into a running set of registered
// tools, and own the lifecycle (connect all → register → close all).
//
// v0.13 plan §5.1: registerMcpConnection converts a live McpConnection's
// tools into registry MCPTool entries (flat name `server__tool`); the
// execute closure captures the connection and the *original* tool name so
// registry dispatch hits the right remote tool. bootMcpServers wires
// connectToServer + registerMcpConnection together with fail-fast semantics
// (constraint 7): one server fails → close everything already opened → throw.

import type { ToolRegistry, MCPTool } from '../shell/registry.js'
import type { JSONSchema } from '../shared/json-schema.js'
import type { McpServerConfig } from './config.js'
import type { McpConnection } from './connection.js'
import { connectToServer } from './connection.js'

const flatName = (server: string, tool: string): string => `${server}__${tool}`

const emptyParameters = (): JSONSchema => ({ type: 'object', properties: {} })

/**
 * Register every tool exposed by `conn` into `registry` under the connection's
 * server name. Each tool's execute closure calls `conn.callTool(rawName, args)`
 * — the registry only ever sees the flat `server__tool` name, the closure
 * remembers the original. Returns the flat names registered.
 *
 * Throws if two tools within the same connection share a name (plan D5:
 * collisions must fail at load time, not silently shadow).
 */
export async function registerMcpConnection(
  registry: ToolRegistry,
  conn: McpConnection,
): Promise<string[]> {
  const tools = await conn.listTools()
  const seen = new Set<string>()
  const mcpTools: MCPTool[] = []

  for (const t of tools) {
    if (seen.has(t.name)) {
      throw new Error(
        `MCP server "${conn.serverName}": duplicate tool name "${t.name}".`,
      )
    }
    seen.add(t.name)

    const rawName = t.name
    const parameters = coerceParameters(t.inputSchema, conn.serverName, rawName)
    const description =
      typeof t.description === 'string' && t.description !== ''
        ? t.description
        : `MCP tool ${flatName(conn.serverName, rawName)}`

    mcpTools.push({
      name: rawName,
      description,
      parameters,
      execute: async (args) => conn.callTool(rawName, args),
    })
  }

  registry.registerMCP(conn.serverName, mcpTools)
  return mcpTools.map((t) => flatName(conn.serverName, t.name))
}

/**
 * Boot a list of MCP servers: connect each in order, register its tools, and
 * return a handle whose close() shuts every connection down.
 *
 * Fail-fast (constraint 7): if any server fails to connect/register, every
 * connection opened so far is closed before the error is rethrown — no
 * partial-boot silent state survives.
 *
 * `close()` on the returned result is idempotent (D3): a second call is a
 * no-op.
 */
export async function bootMcpServers(
  registry: ToolRegistry,
  cfgs: readonly McpServerConfig[],
): Promise<McpBootResult> {
  const opened: McpConnection[] = []
  const serverNames: string[] = []
  const allTools: string[] = []
  // Per-server instructions, keyed by server name. Present only when the
  // server's mode is 'allow' AND the server actually sent instructions; absent
  // (undefined) under the default 'discard' mode or when the server sent none.
  const instructions: Record<string, string> = {}
  const seenServers = new Set<string>()

  const closeAll = async (): Promise<void> => {
    const conns = opened.splice(0, opened.length)
    await Promise.all(conns.map((c) => c.close().catch(() => undefined)))
  }

  try {
    for (const cfg of cfgs) {
      if (seenServers.has(cfg.name)) {
        throw new Error(`Duplicate MCP server name "${cfg.name}" in boot config.`)
      }
      seenServers.add(cfg.name)

      const conn = await connectToServer(cfg)
      opened.push(conn)

      const flatNames = await registerMcpConnection(registry, conn)
      serverNames.push(cfg.name)
      allTools.push(...flatNames)

      // v0.18: store server-level metadata for progressive tool disclosure.
      // compose uses description for the server summary block; load_tools uses
      // toolNames to resolve which schemas to inject on selection.
      // Raw names are fetched from the connection (flat names have server__ prefix
      // which we must not include in the metadata).
      const connTools = await conn.listTools()
      registry.registerMCPServerMeta(
        cfg.name,
        cfg.description ?? `MCP server: ${cfg.name}`,
        connTools.map(t => t.name),
      )

      // Collect instructions only if the connection exposes them (i.e. the
      // per-server mode is 'allow'). Under the default 'discard' this is
      // always undefined and the entry is simply not recorded. In-process
      // servers may omit getInstructions entirely — treat that as discard.
      const instr = conn.getInstructions?.()
      if (instr !== undefined) {
        instructions[cfg.name] = instr
      }
    }
  } catch (e) {
    await closeAll()
    throw e
  }

  let closed = false
  return {
    servers: serverNames,
    tools: allTools,
    // Instructions that survived the per-server mode gate. Empty under the
    // default 'discard' mode. Callers that build the system prompt MAY consult
    // this; under 'discard' it is always `{}` so prompt assembly is unchanged.
    instructions,
    async close() {
      if (closed) return
      closed = true
      await closeAll()
    },
  }
}

export type McpBootResult = {
  /** Server names that were successfully connected, in config order. */
  servers: string[]
  /** Flat `server__tool` names of every tool registered. */
  tools: string[]
  /**
   * Per-server instructions (keyed by server name) that were exposed because
   * the server's `mcpInstructionsMode` was 'allow'. Empty object under the
   * default 'discard' mode. Callers injecting these into a system prompt MUST
   * treat them as untrusted server-supplied text.
   */
  instructions: Record<string, string>
  /** Close all connections. Idempotent: subsequent calls are no-ops. */
  close(): Promise<void>
}

// ---- helpers ---------------------------------------------------------------

/**
 * Coerce a tool's inputSchema (unknown from the SDK) into the registry's
 * JSONSchema. The MCP spec mandates inputSchema.type === "object"; if a server
 * violates that or omits the schema, fall back to an empty object schema so
 * the tool is still callable rather than dropped.
 */
function coerceParameters(
  inputSchema: unknown,
  serverName: string,
  toolName: string,
): JSONSchema {
  if (
    typeof inputSchema === 'object' &&
    inputSchema !== null &&
    (inputSchema as { type?: unknown }).type === 'object'
  ) {
    return inputSchema as JSONSchema
  }
  // Malformed schema: keep the tool callable with an open empty schema.
  // (Logged via the description fallback elsewhere; here we just stay safe.)
  void serverName
  void toolName
  return emptyParameters()
}
