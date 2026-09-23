// MCP connection: the ONLY place the MCP SDK is imported.
//
// v0.13 constraint 1: every SDK import must live under src/mcp/. This file is
// that boundary. Everything outside src/mcp/ sees only the narrow
// `McpConnection` interface (listTools / callTool / close) — so the SDK is a
// replaceable battery (plan principle 1): swapping it means editing this one
// file, nothing else.
//
// Decision D2 (plan §7): callTool returns a string. Text content blocks are
// joined with "\n"; an isError result throws; empty content falls back to
// JSON.stringify of the whole result. The LLM-facing surface only ever sees
// strings or thrown errors; loop.ts's existing error wrapping takes it from
// there.
//
// Decision D4 (plan §7, constraint 8): stdio subprocess env = an explicit
// safe whitelist from process.env + cfg.env overrides. We never forward
// process.env wholesale, to avoid leaking secrets (ARK_KEY, OPENAI_API_KEY,
// AWS_*, …) into spawned servers. v0.14 P0-2 replaces the prior
// { ...getDefaultEnvironment(), ...cfg.env } merge (which forwarded the SDK's
// own broad default env) with buildSafeEnv below.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import type { McpServerConfig, McpInstructionsMode } from './config.js'
import { DEFAULT_MCP_INSTRUCTIONS_MODE } from './config.js'
import { packageVersion } from './version.js'

// v0.14 P0-2: only forward well-known safe variables to MCP stdio subprocesses.
// Secret-bearing env vars (ARK_KEY, OPENAI_API_KEY, AWS_*, etc.) MUST NOT be
// forwarded unless explicitly listed in cfg.env. The prior
// { ...getDefaultEnvironment(), ...cfg.env } merge forwarded the SDK's broad
// default env (which includes all of process.env) — this whitelist closes that
// secret-leak vector.
const SAFE_ENV_VARS = [
  'PATH', 'Path',
  'HOME', 'HOMEPATH', 'USERPROFILE',
  'LANG', 'LANGUAGE', 'LC_ALL',
  'TZ',
  'TMPDIR', 'TMP', 'TEMP',
] as const

function buildSafeEnv(cfgEnv?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  const sys = process.env as Record<string, string | undefined>
  for (const k of SAFE_ENV_VARS) {
    if (sys[k] !== undefined) out[k] = sys[k]!
  }
  if (cfgEnv) Object.assign(out, cfgEnv)
  return out
}

// @internal — exported solely so tests can verify the whitelist behavior
// without spawning a subprocess. NOT part of the public MCP-layer surface.
export { buildSafeEnv }

// ---- narrow public interface ----------------------------------------------

/**
 * A live connection to one MCP server. This is the only type crossing the
 * src/mcp/ boundary; it deliberately exposes no SDK types so callers (boot,
 * tests) can mock it with a plain object.
 *
 * `getInstructions()` returns the server-provided `instructions` string from
 * the initialize response, or `undefined` when the mode is 'discard' (the
 * default). This is the single chokepoint where instructions either survive
 * or are dropped — callers MUST NOT reach around it. See McpInstructionsMode.
 *
 * The method is optional on the interface so that in-process MCP servers
 * (e.g. the wiki-mcp adapter) that have no instructions to surface don't have
 * to stub it; `connectToServer` always provides it.
 */
export type McpConnection = {
  readonly serverName: string
  listTools(): Promise<{ name: string; description?: string; inputSchema: unknown }[]>
  callTool(name: string, args: unknown): Promise<string>
  /**
   * Server instructions from the initialize response.
   * - mode 'discard' (default): always returns `undefined`.
   * - mode 'allow': returns the server's instructions string, or `undefined`
   *   if the server sent none.
   *
   * Optional: in-process MCP servers without an initialize handshake may omit
   * this; callers should treat absence as `undefined`.
   */
  getInstructions?(): string | undefined
  close(): Promise<void>
}

// ---- connect ---------------------------------------------------------------

const CLIENT_NAME = 'agent-shell'

/**
 * Establish a connection to one MCP server per its config:
 * - stdio → spawn the process and talk over stdin/stdout.
 * - http  → POST to the Streamable HTTP endpoint.
 *
 * Performs the MCP initialize handshake. All subsequent client requests
 * (listTools / callTool) carry cfg.timeoutMs (default 30s) as the SDK
 * per-request timeout. Connection failures include the server name in the
 * message so a multi-server boot can identify the offender.
 */
export async function connectToServer(cfg: McpServerConfig): Promise<McpConnection> {
  const timeout = cfg.timeoutMs ?? 30_000
  // Resolve the instructions mode once: explicit per-server override, else
  // the 'discard' default. This is the only place the decision is made.
  const mode: McpInstructionsMode = cfg.mcpInstructionsMode ?? DEFAULT_MCP_INSTRUCTIONS_MODE
  const client = new Client(
    { name: CLIENT_NAME, version: packageVersion() },
    { capabilities: {} },
  )

  try {
    if (cfg.transport === 'stdio') {
      // Whitelist-only env + explicit cfg.env overrides. Never process.env wholesale.
      const env = buildSafeEnv(cfg.env)
      const transport = new StdioClientTransport({
        command: cfg.command,
        ...(cfg.args !== undefined ? { args: cfg.args } : {}),
        env,
      })
      // SDK transport implementations are structurally compatible with the
      // Transport contract at runtime; under exactOptionalPropertyTypes the
      // generic onmessage signatures don't line up statically, so assert here.
      await client.connect(transport as Transport, { timeout })
    } else {
      const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
        ...(cfg.headers !== undefined
          ? { requestInit: { headers: cfg.headers } }
          : {}),
      })
      await client.connect(transport as Transport, { timeout })
    }
  } catch (e) {
    // Make sure a half-open client doesn't leak on failure.
    try {
      await client.close()
    } catch {
      /* swallow close error; the connect error is the real signal */
    }
    throw new Error(
      `MCP server "${cfg.name}" connection failed: ${(e as Error).message}`,
    )
  }

  return {
    serverName: cfg.name,
    // Resolve the mode once at connect time. 'allow' is the only path that
    // surfaces instructions; everything else (including the 'discard'
    // default) keeps them invisible to callers.
    async listTools() {
      const result = await client.listTools(undefined, { timeout })
      return result.tools.map((t) => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        inputSchema: t.inputSchema,
      }))
    },
    async callTool(name: string, args: unknown) {
      // MCP tools/call expects arguments as a JSON object (or absent). The
      // narrow McpConnection interface accepts unknown to stay SDK-free; here
      // at the boundary we assert the shape the protocol requires.
      const result = await client.callTool(
        { name, arguments: args as Record<string, unknown> | undefined },
        undefined,
        { timeout },
      )
      return stringifyCallToolResult(result, name, cfg.name)
    },
    getInstructions() {
      // The single gate. Under 'discard' (default) we never read the server's
      // instructions, so a compromised server cannot inject text into the
      // system prompt. Only under explicit 'allow' do we expose them.
      if (mode !== 'allow') return undefined
      try {
        return client.getInstructions()
      } catch {
        // SDK throws if called before initialize completes; we are past it,
        // but stay defensive rather than surfacing SDK errors to callers.
        return undefined
      }
    },
    async close() {
      await client.close()
    },
  }
}

// ---- result → string (decision D2) ----------------------------------------

/**
 * Turn a CallToolResult into the single string the LLM-facing layer consumes.
 *  - isError === true  → throw, message = joined text (or JSON fallback).
 *  - text content      → join with "\n".
 *  - non-text only     → JSON.stringify the content array.
 *  - empty content     → JSON.stringify the whole result.
 *
 * Accepts `unknown` and narrows internally: the SDK's CallToolResult return
 * type is a large discriminated union that doesn't satisfy a hand-written
 * structural type under exactOptionalPropertyTypes, so we treat the result
 * opaquely and read only the fields we care about.
 */
function stringifyCallToolResult(
  result: unknown,
  toolName: string,
  serverName: string,
): string {
  const obj = (typeof result === 'object' && result !== null ? result : {}) as {
    content?: unknown
    isError?: unknown
  }
  const content = obj.content
  const textBlocks: string[] = []
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        textBlocks.push((block as { text: string }).text)
      }
    }
  }

  const text = textBlocks.join('\n')

  if (obj.isError === true) {
    const msg = text || JSON.stringify(result)
    throw new Error(`MCP tool "${serverName}__${toolName}" returned an error: ${msg}`)
  }

  if (text !== '') return text
  // No text blocks: fall back to a JSON dump so the caller still sees something.
  if (Array.isArray(content) && content.length > 0) {
    return JSON.stringify(content)
  }
  return JSON.stringify(result)
}
