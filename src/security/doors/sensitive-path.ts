// sensitive-path.ts
//
// SecurityDoor that blocks read/ls/find/grep tools from accessing sensitive
// credential / key / secret paths. Wraps the existing `isSensitivePath` pure
// function (v0.15) — detection logic is unchanged, only the call shape moves
// from a SystemSecurityHook into a pluggable door.
//
// Design notes:
//   - The door is stateless: it holds no mutable data. All session-level
//     state (approval grants, etc.) lives in SessionSecurityState, which the
//     Router passes in. This door only reads `args` and consults the pure
//     detector.
//   - `sessionId` is the first check() parameter per the SecurityDoor
//     contract. Isolation between sessions is achieved via the permission
//     fields in state (the router hands each session its own state); this door
//     does not branch on sessionId (path policy is global). It MUST remain in
//     the signature so future per-session path policies can be added without
//     changing the interface.
//   - Tools that carry a `path` argument and only READ (read/ls/find/grep)
//     are gated here. Write tools are gated by the write-approval door, which
//     also consults isSensitivePath via its own reason construction (the
//     approval hook historically combined both; the door split keeps each
//     concern in one place). To avoid duplicating the sensitive-path block on
//     writes, this door is pass-through for write/edit — the write-approval
//     door handles them.

import { isSensitivePath, findSensitiveShellPath } from '../../im/tools/security/sensitive-path.js'
import type {
  SessionId,
  SessionSecurityState,
  SecurityDecision,
  SecurityDoor,
} from '../types.js'

/** Read-only tools that carry a `path` argument and are gated by this door. */
const PATH_TOOLS = new Set(['read', 'ls', 'find', 'grep'])

/**
 * Shell tools carry a `command` string instead of a `path` argument. They are
 * gated on the paths *inside* that string, so `bash` cannot read a credential
 * file that `read` refuses (v0.35.2 — closes that asymmetry; see
 * `findSensitiveShellPath`).
 *
 * The same checklist as the dangerous-command door applies: a new shell-like
 * tool must be registered here too, otherwise it silently bypasses this gate.
 */
const SHELL_TOOLS = new Set(['bash', 'powershell'])

/**
 * Extract a non-empty string field from unknown tool arguments.
 * Returns undefined when the field is absent or not a string.
 */
function getStringField(args: unknown, field: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const v = (args as Record<string, unknown>)[field]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * Create the sensitive-path SecurityDoor.
 *
 * For read/ls/find/grep tools: extracts the `path` argument and calls
 * `isSensitivePath`. On a hit, returns `{ allow: false, reason }`.
 * For all other tools: returns `{ allow: true }` (pass-through).
 */
export function createSensitivePathDoor(): SecurityDoor {
  return {
    name: 'sensitive-path',
    check(_sessionId, _state, toolName, args, _ctx) {
      if (SHELL_TOOLS.has(toolName)) {
        const command = getStringField(args, 'command')
        if (command === undefined) {
          // No command field — nothing to check. Not itself a security event.
          return { allow: true }
        }
        const hit = findSensitiveShellPath(command)
        if (hit !== null) {
          return {
            allow: false,
            reason: `tool "${toolName}" references a sensitive path: ${hit}`,
          }
        }
        return { allow: true }
      }
      if (!PATH_TOOLS.has(toolName)) {
        return { allow: true }
      }
      const path = getStringField(args, 'path')
      if (path === undefined) {
        // No path field — nothing to check. Not itself a security event.
        return { allow: true }
      }
      if (isSensitivePath(path)) {
        return {
          allow: false,
          reason: `tool "${toolName}" targets a sensitive path: ${path}`,
        }
      }
      return { allow: true }
    },
  }
}
