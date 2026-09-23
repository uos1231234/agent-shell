// v0.16: Security router core types.
//
// SecurityDoor is a pluggable policy that inspects a tool call against a
// per-session security state. The SecurityRouter (router.ts) holds the
// session map and door list; doors are stateless strategies — all mutable
// state (approval grants, etc.) lives in SessionSecurityState.
//
// v0.16 (Q2-A): isolation between sessions is achieved through the PERMISSION
// FIELDS in SessionSecurityState (each session owns a distinct ApprovalStore),
// NOT through the sessionId string. The router maps ctx.sessionId → the
// session's state, so doors already see isolated permission data. sessionId is
// still passed as the first check() argument so a future door can implement
// per-session policies (e.g. "session X may not run bash at all") without an
// interface change; today no door branches on it.

import type { ApprovalStore } from '../im/tools/security/approval-store.js'
import type { ToolContext } from '../shared/tool-context.js'

export type SessionId = string

export type SessionSecurityState = {
  sessionId: SessionId
  approvalStore: ApprovalStore
  /** When true, all security doors auto-allow (full-permission session). */
  fullPermission?: boolean
}

export type SecurityDecision = {
  allow: boolean
  reason?: string
  approvalId?: string
}

export interface SecurityDoor {
  readonly name: string
  check(
    sessionId: SessionId,
    state: SessionSecurityState,
    toolName: string,
    args: unknown,
    ctx: ToolContext,
  ): SecurityDecision | Promise<SecurityDecision>
  /** Optional: release a concurrency slot / approval grant after tool execution completes. */
  release?(sessionId: SessionId, toolName: string): void
}
