// write-approval.ts
//
// SecurityDoor that gates filesystem-mutation tools (write/edit) and shell
// execution (bash/powershell) behind human approval. This is the ONLY door in
// the v0.16 set that performs a human round-trip; the other two doors
// (sensitive-path, dangerous-command) are hard policy blocks with no approval
// path.
//
// v0.16 (Q4-A): duplicate detection was REMOVED from this door. It no longer
// imports isSensitivePath / checkDangerousCommand — sensitive reads are hard-
// blocked by the sensitive-path door, and dangerous commands are hard-blocked
// by the dangerous-command door (both run before this door in registration
// order). This door's sole job is the approval flow:
//   - write/edit → approval keyed by file path (file-scope grant short-circuits
//     subsequent edits of the same file).
//   - bash/powershell → session-scope approval (one grant unlocks ordinary
//     shell for the session; `timeout:null` additionally requires and records
//     a separate unlimited-timeout grant).
//
// Design notes:
//   - The door is stateless except for `handler`/`timeoutMs` captured in the
//     closure. Per-session mutable grant state lives in
//     SessionSecurityState.approvalStore, which the Router passes in — a bash
//     approval in session A does NOT short-circuit session B (v0.16
//     session-isolation guarantee, Q2-A: isolation is achieved through the
//     permission fields in state, not through the sessionId string).
//   - `sessionId` is the first check() parameter per the SecurityDoor
//     contract. This door does not directly use it; it is reserved for future
//     per-session policies. It MUST remain in the signature.
//   - Flow per call:
//       1. write/edit or bash/powershell? If not -> allow (pass-through).
//       2. Prior grant in state.approvalStore matching the scope? -> allow.
//       3. Otherwise call the ApprovalHandler (round-trip to the user) with a
//          timeout. 'approved' -> record grant + allow. 'rejected' / timeout /
//          throw -> { allow: false } (fail-closed).

import {
  type ApprovalHandler,
  type ApprovalRequest,
  type ApprovalScope,
  ApprovalStore,
} from '../../im/tools/security/approval-store.js'
import type {
  SessionId,
  SessionSecurityState,
  SecurityDecision,
  SecurityDoor,
} from '../types.js'

/** Default approval timeout: 300 seconds (5 minutes). */
const DEFAULT_TIMEOUT_MS = 300_000

/** Tool names that mutate the filesystem and always require approval. */
const WRITE_TOOLS = new Set(['write', 'edit', 'search_replace'])

/** Tool names that run a shell command. */
const SHELL_TOOLS = new Set(['bash', 'powershell'])

/**
 * Options for {@link createWriteApprovalDoor}.
 */
export interface WriteApprovalDoorOptions {
  /** Called when a tool call needs a fresh human decision. */
  handler: ApprovalHandler
  /** Max wait for the handler before failing closed. Default 300000 (300s). */
  timeoutMs?: number
}

/**
 * Extract a non-empty string field from unknown tool arguments.
 * Returns undefined when the field is absent or not a string.
 */
function getStringField(args: unknown, field: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const v = (args as Record<string, unknown>)[field]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function getField(args: unknown, field: string): unknown {
  if (typeof args !== 'object' || args === null) return undefined
  return (args as Record<string, unknown>)[field]
}

/**
 * Run an ApprovalHandler with a timeout. Resolves to 'approved'/'rejected'
 * on normal completion, or rejects on timeout / handler error / abort. The
 * caller (the door) converts any rejection into a fail-closed deny decision.
 *
 * v0.27: `signal` 竞速——turn.cancel 的 abort 要能打断"卡在门内等用户"的
 * 工具调用（loop 的 abort 检查只在 await 边界生效，工具不返回就到不了
 * 边界）。abort 触发 → reject AbortError → 门 fail-closed 拒绝 → 工具
 * 报错返回 → loop 下一个边界抛出 → 回合以 shell-terminated 收敛。
 */
function callHandlerWithTimeout(
  handler: ApprovalHandler,
  request: ApprovalRequest,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<'approved' | 'rejected'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`approval timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    let onAbort: (() => void) | undefined
    if (signal !== undefined) {
      onAbort = () => {
        clearTimeout(timer)
        reject(new DOMException('aborted by turn.cancel', 'AbortError'))
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    handler(request)
      .then((result) => {
        clearTimeout(timer)
        if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
        resolve(result)
      })
      .catch((err) => {
        clearTimeout(timer)
        if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
  })
}

/**
 * Create the write-approval SecurityDoor.
 *
 * Gates write/edit (filesystem mutation) and bash/powershell (shell) behind
 * human approval. Approval grants are recorded in the per-session
 * `state.approvalStore`, so repeats in the same session skip the handler.
 * A shell call with `timeout:null` uses a separate grant and never inherits
 * ordinary shell approval.
 *
 * Returns `{ allow: true }` for non-write/non-shell tools (pass-through), and
 * `{ allow: false, reason }` when the handler rejects or times out
 * (fail-closed). The Router throws on `{ allow: false }`.
 */
export function createWriteApprovalDoor(
  options: WriteApprovalDoorOptions,
): SecurityDoor {
  const handler = options.handler
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    name: 'write-approval',
    async check(
      _sessionId: SessionId,
      state: SessionSecurityState,
      toolName: string,
      args: unknown,
      _ctx,
    ): Promise<SecurityDecision> {
      const store: ApprovalStore = state.approvalStore

      // Full-permission sessions bypass approval.
      if (state.fullPermission) return { allow: true }

      // --- 1. Determine whether this call needs approval, and on what grounds.
      let reason = ''
      let filePath: string | undefined
      let isWrite = false
      let isShell = false
      let needsUnlimitedTimeout = false

      // Writes always require approval (unless already granted below).
      if (WRITE_TOOLS.has(toolName)) {
        isWrite = true
        const pathArg = getStringField(args, 'path')
        if (pathArg !== undefined) filePath = pathArg
        reason = `tool "${toolName}" modifies the filesystem`
      }

      // Shell tools require session-scope approval. Note: dangerous-command
      // door runs BEFORE this door, so dangerous commands are already
      // hard-blocked here — the approval this door grants covers only commands
      // the policy doors let through.
      if (SHELL_TOOLS.has(toolName)) {
        isShell = true
        needsUnlimitedTimeout = getField(args, 'timeout') === null
        reason = needsUnlimitedTimeout
          ? `tool "${toolName}" requests a shell command without a harness deadline`
          : `tool "${toolName}" runs a shell command`
      }

      // Nothing flagged -> allow.
      if (reason.length === 0) return { allow: true }

      // search_replace is in WRITE_TOOLS above, so it flows through the generic
      // isWrite branch — the directory-path grant semantics are identical to write.

      // --- 2. Check the store for a prior grant; short-circuit if present.
      if (isWrite && filePath !== undefined) {
        // File/directory-scope grant (a directory grant covers children, so an
        // approved search_replace root or write dir short-circuits writes under
        // it). Session-scope `write` grant is the coarser fallback.
        if (store.isGrantedForPath(filePath)) {
          return { allow: true }
        }
        if (store.isGranted(ApprovalStore.keyForWrite(toolName, filePath, 'session'))) {
          return { allow: true }
        }
      }
      if (isShell) {
        const hasShellGrant = store.isGranted(ApprovalStore.keyForBash('session'))
        const hasUnlimitedGrant = store.isGranted(ApprovalStore.keyForUnlimitedTimeout())
        if (hasShellGrant && (!needsUnlimitedTimeout || hasUnlimitedGrant)) {
          return { allow: true }
        }
      }

      // --- 3. Ask the human. ctx.signal（turn.cancel）与审批等待竞速。
      const request: ApprovalRequest = { toolName, args, reason }
      let decision: 'approved' | 'rejected'
      try {
        decision = await callHandlerWithTimeout(handler, request, timeoutMs, _ctx?.signal)
      } catch (err) {
        // Timeout or handler throw -> fail closed.
        const msg = err instanceof Error ? err.message : String(err)
        return { allow: false, reason: `approval denied (fail-closed): ${msg}` }
      }

      if (decision === 'rejected') {
        const detail = filePath !== undefined
          ? `${reason} (path: ${filePath})`
          : reason
        return { allow: false, reason: `approval rejected by user: ${detail}` }
      }

      // --- 4. Approved -> record the grant per scope and allow.
      if (isWrite && filePath !== undefined) {
        const scope: ApprovalScope = 'file'
        store.grant(ApprovalStore.keyForWrite(toolName, filePath, scope))
      }
      if (isShell) {
        store.grant(ApprovalStore.keyForBash('session'))
        if (needsUnlimitedTimeout) {
          store.grant(ApprovalStore.keyForUnlimitedTimeout())
        }
      }
      return { allow: true }
    },
  }
}
