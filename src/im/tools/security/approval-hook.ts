// approval-hook.ts
//
// SystemSecurityHook implementation that gates sensitive tool calls behind
// human approval. Composed on top of three pure detectors:
//   - isSensitivePath()  — flags reads/writes of credentials, keys, .env, ...
//   - checkDangerousCommand() — flags rm -rf, sudo, curl|sh, force push, ...
//   - write/edit detection — any filesystem mutation requires approval
//
// Flow for every checked tool call:
//   1. Does the store already have a matching grant? → allow (return void).
//   2. Otherwise, is the call sensitive / dangerous / a write? If none, allow.
//   3. If yes, call the ApprovalHandler (round-trip to the user).
//      - 'approved' → grant per scope (so repeats skip the handler) + allow.
//      - 'rejected' → return Error (loop formats it for the LLM).
//      - timeout / throw → return Error (fail-closed: never let the call through
//        when we could not get a positive decision).
//
// Design notes:
//   - The hook is async (returns Promise<void | Error>) to match the
//     SystemSecurityHook contract used for system tools (v0.15 plan §9.1).
//   - Only one round-trip per (tool, scope) group: after the first approval
//     the store short-circuits, so a session-level bash grant stops all
//     further bash approval prompts.
//   - Argument extraction is defensive: tool args arrive as `unknown`. We
//     narrow to the expected shape via a small helper and skip checks we
//     cannot run (e.g. no path field → no sensitive-path check), rather than
//     throwing — a missing field is not itself a security event.

import { isSensitivePath } from './sensitive-path.js'
import { checkDangerousCommand } from './dangerous-command.js'
import { type ApprovalHandler, type ApprovalRequest, type ApprovalScope, ApprovalStore } from './approval-store.js'

/** Default approval timeout: 300 seconds (5 minutes). */
const DEFAULT_TIMEOUT_MS = 300_000

/** Tool names that mutate the filesystem and always require approval. */
const WRITE_TOOLS = new Set(['write', 'edit'])

/** Tool names that run a shell command. */
const SHELL_TOOLS = new Set(['bash', 'powershell'])

/**
 * Configuration for {@link createApprovalHook}.
 */
export interface ApprovalHookConfig {
  /** The shared approval store (grants persist for the session). */
  store: ApprovalStore
  /** Called when a tool call needs a fresh human decision. */
  handler: ApprovalHandler
  /** Max wait for the handler before failing closed. Default 300000 (300s). */
  timeoutMs?: number
}

/**
 * Extract a string field from unknown tool arguments.
 * Returns undefined when the field is absent or not a string.
 */
function getStringField(args: unknown, field: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const v = (args as Record<string, unknown>)[field]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * Run an ApprovalHandler with a timeout. Resolves to 'approved'/'rejected'
 * on normal completion, or rejects on timeout / handler error. The caller
 * (the hook) converts any rejection into a fail-closed Deny.
 */
function callHandlerWithTimeout(
  handler: ApprovalHandler,
  request: ApprovalRequest,
  timeoutMs: number,
): Promise<'approved' | 'rejected'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`approval timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    handler(request)
      .then((result) => {
        clearTimeout(timer)
        resolve(result)
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
  })
}

/**
 * Create a SystemSecurityHook that checks tool calls for approval requirements.
 *
 * The returned function has the signature `(args, ctx, toolName) =>
 * Promise<void | Error>`, matching the system-tool security hook contract:
 *   - resolves void  → allow the call
 *   - resolves Error → block the call (the registry throws it)
 */
export function createApprovalHook(
  config: ApprovalHookConfig,
): (args: unknown, ctx: unknown, toolName: string) => Promise<void | Error> {
  const store = config.store
  const handler = config.handler
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return async (args: unknown, _ctx: unknown, toolName: string): Promise<void | Error> => {
    // --- 1. Determine whether this call needs approval, and on what grounds.
    let reason = ''
    let dangerous: string | undefined
    /** Path used both for the sensitive-path check and for the write grant key. */
    let filePath: string | undefined
    /** Bash command string, used for the dangerous-command check. */
    let command: string | undefined
    /** Whether a write grant should be recorded on approval. */
    let isWrite = false
    /** Whether a bash grant should be recorded on approval. */
    let isShell = false

    // File-path-bearing tools: read/write/edit/ls all carry `path`.
    const pathArg = getStringField(args, 'path')
    if (pathArg !== undefined && isSensitivePath(pathArg)) {
      reason = `tool "${toolName}" targets a sensitive path: ${pathArg}`
      dangerous = 'sensitive-file access'
      filePath = pathArg
    }

    // Shell tools: inspect the command.
    if (SHELL_TOOLS.has(toolName)) {
      const cmdArg = getStringField(args, 'command')
      if (cmdArg !== undefined) {
        const result = checkDangerousCommand(
          cmdArg,
          toolName === 'powershell' ? 'powershell' : 'posix',
        )
        if (result !== null) {
          reason = reason.length > 0
            ? `${reason}; dangerous command: ${result.reason}`
            : `dangerous command: ${result.reason}`
          dangerous = result.reason
          command = cmdArg
        }
      }
      isShell = true
    }

    // Writes always require approval (unless already granted below).
    if (WRITE_TOOLS.has(toolName)) {
      isWrite = true
      if (pathArg !== undefined) filePath = pathArg
      if (reason.length === 0) {
        reason = `tool "${toolName}" modifies the filesystem`
      }
    }

    // Nothing flagged → allow.
    if (reason.length === 0) return undefined

    // --- 2. Check the store for a prior grant; short-circuit if present.
    if (isWrite && filePath !== undefined) {
      if (store.isGranted(ApprovalStore.keyForWrite(toolName, filePath, 'file'))) {
        return undefined
      }
      if (store.isGranted(ApprovalStore.keyForWrite(toolName, filePath, 'session'))) {
        return undefined
      }
    }
    if (isShell) {
      if (store.isGranted(ApprovalStore.keyForBash('session'))) {
        return undefined
      }
    }

    // --- 3. Ask the human.
    const request: ApprovalRequest = dangerous !== undefined
      ? { toolName, args, reason, dangerous }
      : { toolName, args, reason }
    let decision: 'approved' | 'rejected'
    try {
      decision = await callHandlerWithTimeout(handler, request, timeoutMs)
    } catch (err) {
      // Timeout or handler throw → fail closed.
      const msg = err instanceof Error ? err.message : String(err)
      return new Error(`approval denied (fail-closed): ${msg}`)
    }

    if (decision === 'rejected') {
      return new Error(`approval rejected by user: ${reason}`)
    }

    // --- 4. Approved → record the grant per scope and allow.
    if (isWrite && filePath !== undefined) {
      const scope: ApprovalScope = 'file'
      store.grant(ApprovalStore.keyForWrite(toolName, filePath, scope))
    }
    if (isShell) {
      store.grant(ApprovalStore.keyForBash('session'))
    }
    // Sensitive-path-only reads (not a write, not a shell): grant nothing —
    // each sensitive read should still prompt, because a one-off approval to
    // read .env does not imply approval to read id_rsa. Returning void here
    // is the single-shot allow for this call.
    return undefined
  }
}
