// v0.11.2 G4: SubAgentToolPolicy — declarative, extensible permission policy.
//
// Replaces the hardcoded SUB_AGENT_FORBIDDEN_TOOLS / SUB_AGENT_PRIVILEGED_TOOLS
// sets so that future skills/MCP servers can be controlled by namespace rules
// (glob patterns with a single '*' wildcard).

export type ToolPolicyRule = {
  mode: 'allow' | 'deny'
  // Exact tool ref, or a glob with a single '*' wildcard.
  // Examples: 'bash', 'dangerous-server__*', 'my-skill__*'.
  pattern: string
}

export type SubAgentToolPolicy = {
  description?: string
  default: 'allow' | 'deny'
  rules: ToolPolicyRule[]
}

// Backward-compatible default (v0.11.2 → v0.38): the registry-level fallback
// policy used ONLY where no per-config policy exists (the recursion-guard
// override in assembly.ts). v0.39 semantics: a sub-agent's permission boundary
// is its own toolRefs whitelist plus — when its config declares one — its own
// toolPolicy. The deny list below is no longer imposed on configs that carry
// no policy; see PERMISSIVE_SUB_AGENT_POLICY.
// When adding a new file-mutating tool, add it to this list in the same commit.
export const DEFAULT_SUB_AGENT_TOOL_POLICY: SubAgentToolPolicy = {
  default: 'allow',
  rules: [
    { mode: 'deny', pattern: 'run_subagent' },
    { mode: 'deny', pattern: 'define_subagent' },
    { mode: 'deny', pattern: 'record_curated_block' },
    { mode: 'deny', pattern: 'record_m3_summary' },
    { mode: 'deny', pattern: 'bash' },
    { mode: 'deny', pattern: 'powershell' },
    { mode: 'deny', pattern: 'write' },
    { mode: 'deny', pattern: 'edit' },
    // v0.38 (user ruling): closed the gap — search_replace also mutates files
    // (batch-replacing across several files per call), so leaving it out made
    // the deny list narrower than the write surface it was meant to cover.
    { mode: 'deny', pattern: 'search_replace' },
  ],
}

/**
 * v0.39: the permissive fallback — `default: 'allow'` with no rules.
 *
 * This is the default policy field of every sub-agent config that does not
 * declare one (user ruling 2026-09-12): the whitelist (`toolRefs`) IS the
 * permission boundary, and the global policy layer no longer imposes a second
 * hidden restriction on top of it. What a sub-agent can call is exactly what
 * its creator wrote into toolRefs — visible in the config, editable in the
 * panel, nothing implied.
 */
export const PERMISSIVE_SUB_AGENT_POLICY: SubAgentToolPolicy = {
  description: 'no policy restriction — the toolRefs whitelist is the only boundary',
  default: 'allow',
  rules: [],
}

/**
 * The built-in `editor` role's own declared policy (v0.39). Under the replace
 * semantics a config policy stands alone — this does not derive from the
 * default deny list anymore. It denies only the recursion-enabling and
 * system-internal tools; the writers (`write` / `edit` / `search_replace`) are
 * governed by the role's toolRefs whitelist, which names them explicitly.
 */
export const EDITOR_TOOL_POLICY: SubAgentToolPolicy = {
  description: 'built-in editor role: recursion and system-internal tools denied',
  default: 'allow',
  rules: [
    { mode: 'deny', pattern: 'run_subagent' },
    { mode: 'deny', pattern: 'define_subagent' },
    { mode: 'deny', pattern: 'record_curated_block' },
    { mode: 'deny', pattern: 'record_m3_summary' },
  ],
}

// Returns true if the toolRef is allowed by the policy.
// Rules are evaluated in order; the last matching rule wins.
// If no rule matches, the policy default applies.
export const applyToolPolicy = (toolRef: string, policy: SubAgentToolPolicy): boolean => {
  let allowed = policy.default === 'allow'
  for (const rule of policy.rules) {
    if (matchesPattern(rule.pattern, toolRef)) {
      allowed = rule.mode === 'allow'
    }
  }
  return allowed
}

// Finds the matching rule's pattern for error reporting.
// Returns the pattern of the last matching rule, or null if no rule matched.
export const findMatchingPattern = (toolRef: string, policy: SubAgentToolPolicy): string | null => {
  let matched: string | null = null
  for (const rule of policy.rules) {
    if (matchesPattern(rule.pattern, toolRef)) {
      matched = rule.pattern
    }
  }
  return matched
}

const matchesPattern = (pattern: string, ref: string): boolean => {
  if (pattern === ref) return true
  const star = pattern.indexOf('*')
  if (star === -1) return false
  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  return ref.startsWith(prefix) && ref.endsWith(suffix)
}
