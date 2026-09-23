// v0.16: SecurityRouter — per-session security state + pluggable door dispatch.
//
// v0.20 DEPRECATED: the standalone router layer is dissolved. ToolRegistry now
// owns the doors array + sessions map directly and runs doors at the
// systemSecurityHooks position inside execute() (registry.checkDoors() /
// registry.releaseTool()). Use ToolRegistry.registerDoor() +
// registry.getOrCreateSession() instead. This class is retained (not deleted)
// because tests/security/router.test.ts + session-isolation.test.ts pin the
// door-dispatch semantics (deny-override, session isolation, '__global__'
// fallback) that the registry must keep honoring; those tests now serve as the
// executable spec for the inlined behavior.
//
// The router lived inside ToolRegistry.execute(): after the system security
// hooks run and before tool.execute(). It looks up (or lazily creates) the
// SessionSecurityState for ctx.sessionId (defaulting to '__global__' when
// unset, preserving v0.15 behavior for callers that don't pass a sessionId),
// then runs each registered door in registration order. The first door that
// returns { allow: false } causes a throw — doors themselves never throw.
//
// Design (plan §4): doors are stateless strategies; all mutable state
// (approval grants) is held in SessionSecurityState.approvalStore. The
// router passes both sessionId and state to door.check() so a door can
// inspect identity and permission fields together.

import type { SessionId, SessionSecurityState, SecurityDoor } from './types.js'
import type { ToolContext } from '../shared/tool-context.js'
import { ApprovalStore } from '../im/tools/security/approval-store.js'

const GLOBAL_SESSION = '__global__'

/**
 * @deprecated v0.20: Use ToolRegistry.registerDoor() and registry.checkDoors() instead.
 * SecurityDoor now runs at the systemSecurityHooks position (hook morphology) —
 * the doors array + sessions map live on ToolRegistry, not in a standalone router.
 */
export class SecurityRouter {
  private readonly sessions = new Map<SessionId, SessionSecurityState>()
  private readonly doors: SecurityDoor[] = []

  /** Look up an existing session. Returns undefined if the session does not exist. */
  getSession(sessionId: SessionId | undefined): SessionSecurityState | undefined {
    return this.sessions.get(sessionId ?? GLOBAL_SESSION)
  }

  /** Look up an existing session, lazily creating a default one if missing. */
  getOrCreateSession(sessionId: SessionId | undefined): SessionSecurityState {
    const id = sessionId ?? GLOBAL_SESSION
    let state = this.sessions.get(id)
    if (!state) {
      state = { sessionId: id, approvalStore: new ApprovalStore(), fullPermission: false }
      // For consistency with createSession: a full-permission session must also
      // carry the approval-store grant that tool-level checks consult (e.g. the
      // bash 600s cap in bash.ts). Currently always false here, but the guard
      // keeps the invariant uniform if a future caller pre-seeds fullPermission.
      if (state.fullPermission) {
        state.approvalStore.grant(ApprovalStore.keyForFullPermission())
      }
      this.sessions.set(id, state)
    }
    return state
  }

  /**
   * Explicitly create a session. Throws if the sessionId already exists —
   * use this when a caller wants to pre-seed state without ambiguity.
   */
  createSession(sessionId: SessionId, opts?: { fullPermission?: boolean }): SessionSecurityState {
    if (this.sessions.has(sessionId)) {
      throw new Error(`SecurityRouter: session "${sessionId}" already exists`)
    }
    const state: SessionSecurityState = {
      sessionId,
      approvalStore: new ApprovalStore(),
      fullPermission: opts?.fullPermission ?? false,
    }
    // A full-permission session must also carry the approval-store grant that
    // tool-level checks (e.g. bash timeout cap in bash.ts) consult. Without this,
    // fullPermission short-circuits the doors but the bash 600s cap would still
    // apply — an asymmetry that defeats the "full permission" contract.
    if (state.fullPermission) {
      state.approvalStore.grant(ApprovalStore.keyForFullPermission())
    }
    this.sessions.set(sessionId, state)
    return state
  }

  /** Delete a session and its approval store. No-op if the session does not exist. */
  deleteSession(sessionId: SessionId): boolean {
    return this.sessions.delete(sessionId)
  }

  /** Register a door. Doors run in registration order; first reject wins. */
  registerDoor(door: SecurityDoor): void {
    this.doors.push(door)
  }

  /**
   * Run all doors against this tool call. Resolves when every door allows;
   * throws the first rejection. The throw message is surfaced to the LLM
   * (consistent with v0.15 hook behavior — the LLM needs to know why it was
   * blocked).
   */
  async check(ctx: ToolContext, toolName: string, args: unknown): Promise<void> {
    const sessionId = ctx.sessionId ?? GLOBAL_SESSION
    const state = this.getOrCreateSession(sessionId)
    // Full-permission sessions bypass all security doors.
    if (state.fullPermission) return
    for (const door of this.doors) {
      const decision = await door.check(sessionId, state, toolName, args, ctx)
      if (!decision.allow) {
        throw new Error(
          `Security door "${door.name}" rejected: ${decision.reason ?? 'no reason'}`,
        )
      }
    }
  }

  /**
   * Release any concurrency slots / resources held by a completed tool call.
   * Called by ToolRegistry.execute() in a finally block after tool execution.
   */
  releaseTool(sessionId: SessionId | undefined, toolName: string): void {
    for (const door of this.doors) {
      try {
        door.release?.(sessionId ?? GLOBAL_SESSION, toolName)
      } catch (e) {
        // A release failure on one door must not prevent other doors from
        // releasing their concurrency slots / resources.
        void e
      }
    }
  }
}
