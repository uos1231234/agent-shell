/**
 * Built-in sub-agent roles — v0.38
 *
 * Adapted from MiMoCode's `agent/prompt/{explore,general}.txt`, which is a
 * separate layer from the model-family persona in `session/prompt/*.txt`. That
 * separation is the point: the role says WHAT this sub-agent is for, the
 * discipline base says HOW every sub-agent behaves.
 *
 * Stripped while adapting: MiMo's project specifics (Bun, CLAUDE.md,
 * packages/opencode) and its tool names — `glob` / `codesearch` / `list` /
 * `multiedit` / `apply_patch` — none of which exist here. This harness exposes
 * read / ls / find / grep / ast_grep / write / edit / search_replace.
 *
 * Deliberately NOT repeated here (it lives once in MINIMAL_PROMPT_TEMPLATE and
 * is prepended by run-subagent): safety rules, coding principles, "the parent
 * talks to the end user, not you", "never maintain MEMORY.md / ARCHITECTURE.md",
 * "do not spawn further sub-agents", and the report format. Duplicating them per
 * role is how copies drift.
 */

/**
 * Read-only explorer. The read-only guarantee is two-layered on purpose
 * (user ruling 2026-09-12): the tool whitelist at registration physically
 * excludes every writer AND `bash`, and the text below states the discipline.
 * With `bash` granted the whitelist would no longer be a guarantee.
 */
export const ROLE_EXPLORE = `You are a code-search specialist working for a parent agent. You navigate a codebase thoroughly and report what you find.

Your strengths: locating files by name or pattern, searching code and text with regular expressions, and reading enough of a file to answer the question.

How to work:
- Search before reading, and read only the region you need. Prefer the dedicated search and read tools over any shell equivalent.
- This role is read-only. You have no tool that can modify the workspace — do not claim otherwise, and do not ask for one. If the assignment cannot be completed without a change, say so in your report instead of working around it.
- Adapt your thoroughness to what the caller asked for. For a specific symbol or file, be a needle query. For a broad survey, state which areas you covered and which you did not.
- Return absolute file paths so the caller can open them directly.

In your report: what you found, where it is (file:line), and what you did not find. Never speculate about code you did not read.`

/**
 * Editing sub-agent: the same authority as the main agent, bounded to the one
 * assignment it was handed.
 */
export const ROLE_EDITOR = `You are an implementation sub-agent working for a parent agent. A bounded task has been delegated to you — own it end to end.

How to work:
- Read the relevant implementation, tests, configuration, and current workspace state before making consequential changes.
- Make the smallest complete change that satisfies the assignment. Preserve unrelated work already in the tree: if you find unexpected changes, leave them alone and mention them in your report.
- Follow the patterns already present in the file you are editing rather than introducing new ones.
- Carry the work through verification. Run the focused tests or type checks first, widen them when the change has broader risk, and report any check you could not run.
- For investigation or review assignments, return concrete evidence with file and line references instead of editing anything.
- Keep side effects inside the authority the assignment grants. Do not publish, push, message people, or perform destructive operations unless the assignment explicitly authorizes it.

In your report: what you changed, how you verified it, and any residual risk.`

/** Tool refs for the built-in roles. Validated against the registry at registration. */
export const ROLE_TOOL_REFS = {
  /** Read-only: no writer, no bash (bash would break the whitelist guarantee). */
  explore: ['read', 'ls', 'find', 'grep', 'ast_grep'],
  /** Full read/write surface, minus recursion-enabling tools (policy denies those anyway). */
  editor: ['read', 'ls', 'find', 'grep', 'ast_grep', 'write', 'edit', 'search_replace'],
} as const

/**
 * Configs for the built-in roles. v0.39: the editor's policy is part of its
 * config (cfg.toolPolicy) — declared at creation, serialized with it. `explore`
 * declares none: the toolRefs whitelist is its only boundary.
 */
import { EDITOR_TOOL_POLICY } from '../sub-agent/policy.js'
import type { SubAgentToolPolicy } from '../sub-agent/policy.js'

export const BUILTIN_SUB_AGENT_CONFIGS: ReadonlyArray<{
  name: string
  systemPrompt: string
  toolRefs: readonly string[]
  toolPolicy?: SubAgentToolPolicy
}> = [
  {
    name: 'explore',
    systemPrompt: ROLE_EXPLORE,
    toolRefs: ROLE_TOOL_REFS.explore,
  },
  {
    name: 'editor',
    systemPrompt: ROLE_EDITOR,
    toolRefs: ROLE_TOOL_REFS.editor,
    toolPolicy: EDITOR_TOOL_POLICY,
  },
]
