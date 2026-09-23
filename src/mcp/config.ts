// MCP server configuration: schema, validation, and file loading.
//
// This module is SDK-free (constraint 1 of v0.13 plan: MCP SDK imports live
// only in src/mcp/connection.ts). It owns the *shape* of what a
// configured MCP server looks like; connection.ts owns *how* to reach it.
//
// Discriminated union on `transport` keeps stdio vs http fields from leaking
// into each other — validation rejects cross-branch fields explicitly so a
// misconfigured file fails at load time, not at connect time.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ---- public schema ---------------------------------------------------------

/**
 * How to handle MCP server-provided instructions (the `instructions` field of
 * the initialize response).
 *
 * - 'discard' (default): silently drop server instructions. Safe — a
 *   compromised server cannot inject arbitrary text into the system prompt.
 * - 'allow': expose server instructions so the caller can inject them into
 *   the system prompt. Maximum compatibility with servers that rely on
 *   instructions to describe usage; UNsafe against a malicious/compromised
 *   server.
 *
 * @frontend This config item SHOULD be exposed in the UI as an
 * "MCP server instructions" security setting with options:
 * - "Discard (recommended)" — drop all server instructions
 * - "Allow" — expose server instructions for system-prompt injection
 */
export type McpInstructionsMode = 'discard' | 'allow'

export const DEFAULT_MCP_INSTRUCTIONS_MODE: McpInstructionsMode = 'discard'

/**
 * A configured MCP server. `transport` is the discriminant key:
 * - 'stdio' spawns a local process (command + args + env).
 * - 'http'  connects to a remote HTTP endpoint (url + headers).
 *
 * `timeoutMs` applies to every client request over this connection
 * (initialize / listTools / callTool). Defaults to 30s when omitted.
 *
 * `mcpInstructionsMode` controls whether the server's `instructions`
 * (from the initialize response) are exposed to the caller. Defaults to
 * 'discard' — server instructions are silently dropped and never reach the
 * system prompt. See McpInstructionsMode.
 */
export type McpServerConfig =
  | (StdioServerFields & { transport: 'stdio' })
  | (HttpServerFields & { transport: 'http' })

type CommonFields = {
  name: string
  timeoutMs?: number
  /**
   * Per-server override of instructions handling. Omitted ⇒ 'discard'.
   * See McpInstructionsMode.
   */
  mcpInstructionsMode?: McpInstructionsMode
  // v0.18: human-readable server description for progressive tool disclosure.
  // compose injects this into the server summary block so the LLM knows what
  // the server does. Omitted ⇒ boot.ts defaults to "MCP server: {name}".
  description?: string
}

type StdioServerFields = CommonFields & {
  command: string
  args?: string[]
  env?: Record<string, string>
}

type HttpServerFields = CommonFields & {
  url: string
  headers?: Record<string, string>
}

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/
const DEFAULT_TIMEOUT_MS = 30_000

// ---- default servers -------------------------------------------------------

/**
 * Default MCP servers that `bootstrapExtensions` connects when the caller
 * passes no `mcpServers` (i.e. `undefined`). An explicitly-passed array —
 * including `[]` — always overrides these defaults, so callers that want
 * zero servers can pass `mcpServers: []`.
 *
 * Currently ships Playwright MCP for browser automation + vision:
 *   --caps=vision         → enables coordinate-based click tools
 *   --image-responses=allow → screenshots return as image content parts
 */
export const DEFAULT_MCP_SERVERS: readonly McpServerConfig[] = [
  {
    name: 'playwright',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', '--caps=vision', '--image-responses=allow'],
  },
]

// ---- validation ------------------------------------------------------------

/**
 * Strongly validate an unknown config object into a McpServerConfig.
 * Throws clean English sentences (LLM-readable) on any violation:
 * missing/invalid name, bad transport, cross-branch field contamination,
 * empty stdio command, or non-http(s) url.
 */
export function validateMcpServerConfig(raw: unknown): McpServerConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('MCP server config must be a JSON object.')
  }
  const obj = raw as Record<string, unknown>

  // name
  const name = obj['name']
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new Error(
      `MCP server "name" must be 1-64 characters of [a-zA-Z0-9_-], got: ${JSON.stringify(name)}`,
    )
  }

  // transport
  const transport = obj['transport']
  if (transport !== 'stdio' && transport !== 'http') {
    throw new Error(
      `MCP server "${name}": "transport" must be "stdio" or "http", got: ${JSON.stringify(transport)}`,
    )
  }

  // timeoutMs (optional, shared)
  const timeoutMs = parseTimeoutMs(obj['timeoutMs'], name)

  // mcpInstructionsMode (optional, shared) — 'discard' by default, 'allow' opt-in.
  const mcpInstructionsMode = parseInstructionsMode(obj['mcpInstructionsMode'], name)

  if (transport === 'stdio') {
    rejectCrossFields(obj, name, 'url', 'headers')
    const command = obj['command']
    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error(`MCP server "${name}": stdio transport requires a non-empty "command".`)
    }
    const args = parseStringArray(obj['args'], name, 'args')
    const env = parseStringRecord(obj['env'], name, 'env')

    // Build without optional fields when absent (exactOptionalPropertyTypes:
    // never assign undefined to an optional property).
    const cfg: StdioServerFields & { transport: 'stdio' } = {
      name,
      transport: 'stdio',
      command,
      ...(args !== undefined ? { args } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(mcpInstructionsMode !== undefined ? { mcpInstructionsMode } : {}),
    }
    return cfg
  }

  // transport === 'http'
  rejectCrossFields(obj, name, 'command', 'args', 'env')
  const url = obj['url']
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error(`MCP server "${name}": http transport requires a non-empty "url".`)
  }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new Error(`MCP server "${name}": "url" is not a valid URL: ${url}`)
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(
      `MCP server "${name}": "url" must be http(s), got protocol "${parsedUrl.protocol}".`,
    )
  }
  const headers = parseStringRecord(obj['headers'], name, 'headers')

  const cfg: HttpServerFields & { transport: 'http' } = {
    name,
    transport: 'http',
    url,
    ...(headers !== undefined ? { headers } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(mcpInstructionsMode !== undefined ? { mcpInstructionsMode } : {}),
  }
  return cfg
}

// Reject fields that belong to the *other* transport branch. Keeps the
// discriminated union honest: a stdio config carrying `url` is a mistake the
// user should hear about, not a silently-ignored field.
function rejectCrossFields(obj: Record<string, unknown>, name: string, ...fields: string[]): void {
  for (const f of fields) {
    if (obj[f] !== undefined) {
      throw new Error(
        `MCP server "${name}": field "${f}" is not allowed for its transport type.`,
      )
    }
  }
}

function parseTimeoutMs(raw: unknown, name: string): number | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(
      `MCP server "${name}": "timeoutMs" must be a positive finite number, got: ${JSON.stringify(raw)}`,
    )
  }
  return raw
}

/**
 * Parse the optional `mcpInstructionsMode` field. Undefined → undefined
 * (caller treats absence as the 'discard' default). Rejects anything that
 * isn't 'discard' or 'allow'.
 */
function parseInstructionsMode(
  raw: unknown,
  name: string,
): McpInstructionsMode | undefined {
  if (raw === undefined) return undefined
  if (raw !== 'discard' && raw !== 'allow') {
    throw new Error(
      `MCP server "${name}": "mcpInstructionsMode" must be "discard" or "allow", got: ${JSON.stringify(raw)}`,
    )
  }
  return raw
}

function parseStringArray(raw: unknown, name: string, field: string): string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
    throw new Error(
      `MCP server "${name}": "${field}" must be an array of strings, got: ${JSON.stringify(raw)}`,
    )
  }
  return raw as string[]
}

function parseStringRecord(
  raw: unknown,
  name: string,
  field: string,
): Record<string, string> | undefined {
  if (raw === undefined) return undefined
  if (
    typeof raw !== 'object' ||
    raw === null ||
    Array.isArray(raw) ||
    Object.values(raw).some((v) => typeof v !== 'string')
  ) {
    throw new Error(
      `MCP server "${name}": "${field}" must be an object of string-to-string, got: ${JSON.stringify(raw)}`,
    )
  }
  return raw as Record<string, string>
}

// ---- file loading ----------------------------------------------------------

/**
 * Load and validate an MCP config file. Expected shape:
 *   { "servers": [ {McpServerConfig}, ... ] }
 * Duplicate server names within the file throw. Returns validated configs
 * in file order.
 */
export function loadMcpConfigFile(path: string): McpServerConfig[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    throw new Error(`Failed to read MCP config file "${path}": ${(e as Error).message}`)
  }

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    throw new Error(`MCP config file "${path}" is not valid JSON: ${(e as Error).message}`)
  }

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error(`MCP config file "${path}" must be an object with a "servers" array.`)
  }
  const root = json as Record<string, unknown>
  const servers = root['servers']
  if (!Array.isArray(servers)) {
    throw new Error(`MCP config file "${path}": "servers" must be an array.`)
  }

  const configs: McpServerConfig[] = []
  const seen = new Set<string>()
  for (let i = 0; i < servers.length; i++) {
    const cfg = validateMcpServerConfig(servers[i])
    if (seen.has(cfg.name)) {
      throw new Error(`MCP config file "${path}": duplicate server name "${cfg.name}".`)
    }
    seen.add(cfg.name)
    configs.push(cfg)
  }
  return configs
}

/**
 * Default on-disk location for the MCP config file:
 *   ~/.databus/mcp.json
 */
export function defaultMcpConfigPath(): string {
  return join(homedir(), '.databus', 'mcp.json')
}
