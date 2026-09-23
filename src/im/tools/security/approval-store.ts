// approval-store.ts
//
// In-memory store of previously granted approvals for the human-approval
// security hook. A granted key lets subsequent tool calls with the same key
// bypass the round-trip to the user (the ApprovalHandler).
//
// Design notes:
//   - Zero dependencies — a plain Set<string> keyed by deterministic strings.
//   - Keys are built by static helpers (keyForWrite / keyForBash) so callers
//     never construct them ad hoc — guarantees the same key shape is used for
//     "check" and "grant".
//   - Scopes are intentional: 'file' for writes (one file → one key, fine
//     enough to be safe, coarse enough to avoid re-asking on every edit of the
//     same file); 'session' for bash (per-command granularity is useless and
//     would spam the user).
//   - The store holds NO persistence — grants live for the lifetime of the
//     ApprovalStore instance (i.e. one agent session).

/**
 * Granularity at which an approval applies.
 *
 * - 'file'   → one specific file path (writes/edits): `write:/abs/path`
 * - 'session'→ the whole tool category this session: `write` / `bash`
 */
export type ApprovalScope = 'file' | 'session'

/**
 * A request for human approval, passed to the {@link ApprovalHandler}.
 */
export interface ApprovalRequest {
  /** Name of the tool whose invocation needs approval. */
  toolName: string
  /** The raw tool-call arguments (passed through for the UI to display). */
  args: unknown
  /** Human-readable reason this call requires approval. */
  reason: string
  /** Optional short description of the dangerous aspect (e.g. "rm -rf /"). */
  dangerous?: string
}

/**
 * Callback invoked when the store has no matching grant. Resolves to
 * 'approved' (user accepted) or 'rejected' (user declined). Any rejection,
 * timeout, or throw is treated as Deny (fail-closed) by the hook.
 */
export type ApprovalHandler = (request: ApprovalRequest) => Promise<'approved' | 'rejected'>

export class ApprovalStore {
  private readonly granted = new Set<string>()

  /** Check if an approval key was previously granted. */
  isGranted(key: string): boolean {
    if (this.granted.has(key)) return true
    // Full permission includes an unlimited harness deadline. Keep this
    // implication in the session grant store so tools do not create a second
    // permission path for the same session policy.
    return key === ApprovalStore.keyForUnlimitedTimeout()
      && this.granted.has(ApprovalStore.keyForFullPermission())
  }

  /**
   * Check whether a file path is covered by a prior file- or directory-scope
   * grant. A grant on `/project` covers `/project/foo.ts` (path-boundary
   * prefix match) but NOT `/project2/bar.ts` — the trailing `/` guard prevents
   * prefix collisions. This lets "approve this directory" naturally cover the
   * files under it (search_replace roots, write paths), matching user intent
   * without re-prompting on every edit. Session-scope grants (`write`) are NOT
   * consulted here — callers check those via `isGranted(keyForWrite(...,
   * 'session'))`.
   */
  isGrantedForPath(filePath: string): boolean {
    const norm = filePath.replace(/\\/g, '/')
    for (const key of this.granted) {
      if (!key.startsWith('write:')) continue
      const gp = key.slice('write:'.length).replace(/\\/g, '/')
      if (norm === gp) return true
      // Path-boundary prefix: `/project` covers `/project/foo.ts`, not `/project2`.
      if (norm.startsWith(gp + '/')) return true
    }
    return false
  }

  /** Grant an approval for the given key. */
  grant(key: string): void {
    this.granted.add(key)
  }

  /** Revoke a previously granted approval. No-op if the key was not granted. */
  revoke(key: string): void {
    this.granted.delete(key)
  }

  /**
   * Build the approval key for a write/edit tool.
   *
   * - scope 'file'    → `write:/abs/path` — all writes to this exact file are
   *   auto-approved for the rest of the session.
   * - scope 'session' → `write` — every write/edit this session is auto-approved.
   *
   * `toolName` is accepted for API symmetry but writes and edits share the
   * `write` namespace: both mutate the filesystem, so a grant for one is a
   * grant for the other (this matches how users think about "let it edit
   * files").
   */
  static keyForWrite(toolName: string, filePath: string, scope: ApprovalScope): string {
    void toolName // namespace is shared; kept in signature for clarity
    if (scope === 'session') return 'write'
    return `write:${filePath}`
  }

  /**
   * Build the approval key for a bash command.
   *
   * Only the 'session' scope is meaningful for bash: per-command keys would be
   * unique strings that never match a future call (commands vary), so they
   * would never short-circuit — worse than useless. We therefore accept only
   * 'session' and return the constant `bash` key.
   *
   * The `scope` parameter is kept in the signature so the call site mirrors
   * keyForWrite and the hook can pass its default uniformly.
   */
  static keyForBash(scope: ApprovalScope): string {
    // Per-command scope is intentionally unsupported (see doc comment). If a
    // caller passes a non-session scope we still return the session key —
    // there is no coarser-than-session option that makes sense for bash.
    void scope
    return 'bash'
  }

  /**
   * Key for full-permission mode. When this key is granted in a session's
   * ApprovalStore, the bash tool and other tools treat the session as having
   * unlimited permissions (no timeout cap, no approval prompts).
   */
  static keyForFullPermission(): string {
    return 'session:full-permission'
  }

  /** Session grant for a user-approved command without a harness deadline. */
  static keyForUnlimitedTimeout(): string {
    return 'session:unlimited-timeout'
  }
}
