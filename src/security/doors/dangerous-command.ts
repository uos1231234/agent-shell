// dangerous-command.ts
//
// SecurityDoor that blocks bash/powershell tools from running commands
// classified as destructive by `checkDangerousCommand` (v0.15). Wraps the
// existing pure classifier — detection logic is unchanged.
//
// Design notes:
//   - Stateless door: no mutable data held. Session-level bash approval
//     grants live in SessionSecurityState.approvalStore and are managed by
//     the write-approval door (which historically also handled bash session
//     grants). This door only inspects the command string.
//   - `sessionId` is the first check() parameter per the SecurityDoor
//     contract. Isolation between sessions is achieved via the permission
//     fields in state (the router hands each session its own state); this door
//     does not branch on sessionId (command policy is global). It MUST remain
//     in the signature for future per-session command policies.
//   - Only bash/powershell are inspected; all other tools pass through.

import { checkDangerousCommand } from '../../im/tools/security/dangerous-command.js'
import type { ShellKind } from '../../im/tools/security/dangerous-command.js'
import type {
  SessionId,
  SessionSecurityState,
  SecurityDecision,
  SecurityDoor,
} from '../types.js'

/**
 * Tool names that run a shell command.
 *
 * **Checklist for a new shell-like tool** (`cmd` / `pwsh` / `wsl` / a future
 * `sh` tool): register it here AND in `SHELL_KIND_BY_TOOL` below. The door
 * returns `{ allow: true }` for any tool name it does not know, so a missing
 * entry means that tool runs **completely unchecked** — a silent fail-open.
 *
 * This is deliberate design, not an oversight: security lives in the door
 * layer (ADR-030 「工具安全在 im/tools、整体安全在 shell」), while the tool's
 * own self-description (`category` / `parallelSafe`) is about **concurrency**
 * (ADR-025 T8). Do not migrate this dispatch into tool self-description.
 */
const SHELL_TOOLS = new Set(['bash', 'powershell'])

/** Which shell dialect each shell tool speaks — passed to the classifier so it
 *  applies the matching pattern tables (v0.35). The two shells collide on
 *  names (`rm`, `del`, `curl`, `start`), so the classifier must not guess. */
const SHELL_KIND_BY_TOOL: ReadonlyMap<string, ShellKind> = new Map([
  ['bash', 'posix'],
  ['powershell', 'powershell'],
])

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
 * Create the dangerous-command SecurityDoor.
 *
 * For bash/powershell tools: extracts the `command` argument and calls
 * `checkDangerousCommand`. On a hit, returns
 * `{ allow: false, reason: 'Dangerous command: ...' }`.
 * For all other tools: returns `{ allow: true }` (pass-through).
 */
export function createDangerousCommandDoor(): SecurityDoor {
  return {
    name: 'dangerous-command',
    check(_sessionId, _state, toolName, args, _ctx) {
      if (!SHELL_TOOLS.has(toolName)) {
        return { allow: true }
      }
      const command = getStringField(args, 'command')
      if (command === undefined) {
        // No command field — nothing to check. Not itself a security event.
        return { allow: true }
      }
      const result = checkDangerousCommand(command, SHELL_KIND_BY_TOOL.get(toolName) ?? 'posix')
      if (result !== null) {
        return {
          allow: false,
          reason: `dangerous command: ${result.reason}`,
        }
      }
      return { allow: true }
    },
  }
}
