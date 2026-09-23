// v0.39: caller-scope — resolve the tool surface of the agent invoking
// define_subagent / run_subagent, for the privilege-non-amplification check.
//
// User ruling (2026-09-12): an AI-defined sub-agent may only be granted tools
// its caller already has ("特权不放大"). Referencing or running a user-configured
// agent from the TOP level is unrestricted — user configs are user-authorized.
// But a sub-agent that spawns or runs another one must stay inside its own
// toolRefs whitelist, or it could launder privileges it never had (e.g. a
// read-only sub-agent defining a bash-holding grandchild).
//
// Why instanceId string surgery instead of a ToolContext field: ToolContext has
// no "my toolRefs" field, and adding one means touching loop.ts context
// assembly (state-machine core — off-limits without explicit user sign-off).
// The instanceId format (`${templateName}-${randomUUID()}`) is generated in
// this same package (tree.ts generateInstanceId) and exercised end-to-end by
// the depth tests, which mint real instanceIds via generateInstanceId; if that
// format ever changes, update the tail offset here in lockstep.
//
// Fail-closed: any unresolvable caller (depth >= 1 but no agentId, or an id
// that does not map to a registered template) resolves to an EMPTY tool set —
// every requested ref then counts as a violation.

import type { SubAgentRegistry } from './registry.js'

/** Length of `-${randomUUID()}` — 36 chars for the UUID + 1 hyphen. */
const INSTANCE_ID_TAIL = 37

/**
 * Resolve the caller's tool whitelist for the privilege-non-amplification
 * check.
 *
 * Returns:
 *  - `undefined` — the caller is the top-level working agent. Its surface is
 *    the whole shared ToolRegistry, which validateSubAgentConfig already
 *    gates (unknown refs are rejected there), so no extra check applies.
 *  - `string[]`  — the caller is a sub-agent; these are its toolRefs. An
 *    unresolvable sub-agent identity yields `[]` (deny all) — fail closed.
 */
export const resolveCallerToolRefs = (
  ctx: { agentId?: string; subAgentDepth?: number } | undefined,
  subAgentRegistry: SubAgentRegistry,
): readonly string[] | undefined => {
  const depth = ctx?.subAgentDepth ?? 0
  if (depth < 1) return undefined
  const agentId = ctx?.agentId
  if (typeof agentId !== 'string' || agentId.length <= INSTANCE_ID_TAIL) {
    return []
  }
  // instanceId = `${templateName}-${uuid}` — strip the fixed-length tail.
  const templateName = agentId.slice(0, agentId.length - INSTANCE_ID_TAIL)
  return subAgentRegistry.get(templateName)?.toolRefs ?? []
}
