// v0.11: SubAgentConfig type and validation.
//
// A sub-agent config is a declarative, JSON-serializable spec. It does NOT
// contain imperative logic — the sub-agent's behavior emerges from its
// systemPrompt + available tools + LLM, exactly like the built-in system
// agents. toolRefs are validated against the shared ToolRegistry at load time
// so config typos surface early, not at run time.
//
// v0.13 (decision D7): sub-agents may now reference MCP and skill tools in
// addition to system tools. Permission is decided solely by applyToolPolicy
// (single-layer enforcement — the v0.12.2 blanket "system-tools-only"
// rejection is removed). Unknown refs (resolving to nothing in the registry)
// are still rejected so typos surface at load time.

import type { ToolRegistry } from '../../shell/registry.js'
import { DEFAULT_CONFIG, type ShellConfig } from '../../shell/config.js'
import type { AgentId } from '../databus.js'
import {
  DEFAULT_SUB_AGENT_TOOL_POLICY,
  PERMISSIVE_SUB_AGENT_POLICY,
  applyToolPolicy,
  findMatchingPattern,
  type SubAgentToolPolicy,
} from './policy.js'

export type SubAgentConfig = {
  name: AgentId
  systemPrompt: string
  toolRefs: readonly string[]
  // Optional guard threshold overrides. When omitted, the sub-agent uses the
  // same default ShellConfig as any other agent.
  config?: Partial<ShellConfig>
  /**
   * v0.39 (user ruling): the permission policy declared AT CREATION TIME —
   * part of the agent's identity, serialized with the config. REPLACES the
   * environment policy (no merging): what the config says is what applies.
   * Omitted → the environment policy (registry constructor / assembly's
   * nesting toggle), else the conservative DEFAULT — see
   * validateSubAgentConfig's fallback chain.
   */
  toolPolicy?: SubAgentToolPolicy | undefined
  /**
   * 归属（用户拍板 2026-09-09）：'agent' = AI 运行时经 define_subagent 定义
   * 的任务导向子代理——会话级生命周期（只进会话内存，不落盘，会话销毁即
   * 回收）；'user' = 用户配置的长期资产（面板 upsert / ~/.databus/agents/
   * 手写落盘）。缺省 undefined 视为 'user'（磁盘为事实源）。
   */
  createdBy?: 'user' | 'agent' | undefined
}

/**
 * v0.39: the policy that governs a config's toolRefs — the config's own
 * declaration if present, else the permissive fallback. No environment
 * policy is merged in: the boundary is what the creator wrote.
 *
 * RUNTIME layer only (division of labor, do not conflate):
 * validateSubAgentConfig above is the registration gate — it decides which
 * toolRefs may enter a config at all, and its bare-call fallback is the
 * conservative DEFAULT (fail closed). effectiveToolPolicy runs AFTER
 * registration succeeded: toolRefs already passed the gate, so an undeclared
 * policy here means "no extra runtime restriction" — PERMISSIVE is correct,
 * not a security hole.
 */
export const effectiveToolPolicy = (cfg: {
  toolPolicy?: SubAgentToolPolicy | undefined
}): SubAgentToolPolicy => cfg.toolPolicy ?? PERMISSIVE_SUB_AGENT_POLICY

// v0.11.1 P2.1: path-safe name validation. A sub-agent name becomes a filename
// (<name>.json) and an agentId, so it must never allow path traversal or
// Windows reserved device names.
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

// v0.11.2 G2: system identity names that must never be used as sub-agent names.
// These are sourceAgentId values used by the harness internals (databus, system
// agents, drive-coordinator, main loop). Allowing them would cause identity
// confusion in mailbox, databus projections, and state queries.
const RESERVED_AGENT_NAMES = new Set([
  'databus', 'system', 'drive-coordinator',
  'warehouse', 'compressor', 'recall', 'main',
])

// System-agent-private tools are globally registered but must never enter a
// user-defined sub-agent's toolRefs. The runtime identity guard in the tool is
// the execution boundary; this check keeps the tool schema out of the
// sub-agent's context in the first place.
const SYSTEM_AGENT_PRIVATE_TOOLS = new Set(['submit_curated_memory'])

const isSafeAgentName = (value: string): boolean => {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) return false
  if (RESERVED_NAMES.has(value.toUpperCase())) return false
  if (RESERVED_AGENT_NAMES.has(value)) return false
  return true
}

// v0.11.2 G4: sub-agent tool permissions are now controlled by SubAgentToolPolicy.
// The default policy denies recursion-enabling and system-only tools plus
// privileged filesystem/shell tools, matching v0.11.1 behavior. Callers can
// pass a custom policy to allow specific tools or deny by namespace.

// v0.11.1 P2.4: validate config overrides against the positive-int fields of
// ShellConfig. Values must be positive integers and cannot exceed the
// corresponding DEFAULT_CONFIG ceiling (sub-agents must be *more* constrained
// than the working agent, never less).
const POSITIVE_INT_FIELDS = [
  'maxTokens',
  'maxSteps',
  'maxToolCalls',
  'maxElapsedMs',
  'maxConsecutiveToolErrors',
  'maxSubAgentDepth',
] as const

const validateShellConfigOverrides = (config: unknown): Partial<ShellConfig> => {
  if (config === null || typeof config !== 'object') {
    throw new Error('Sub-agent config "config" field must be an object')
  }
  const candidate = config as Record<string, unknown>
  const validated: Partial<ShellConfig> = {}

  for (const field of POSITIVE_INT_FIELDS) {
    if (candidate[field] === undefined) continue
    const value = candidate[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
      throw new Error(`Sub-agent config "config.${field}" must be a positive integer`)
    }
    if (value > DEFAULT_CONFIG[field]) {
      throw new Error(`Sub-agent config "config.${field}" cannot exceed default ${DEFAULT_CONFIG[field]}`)
    }
    validated[field] = value
  }

  const knownKeys = new Set<string>(POSITIVE_INT_FIELDS)
  const unknownKeys = Object.keys(candidate).filter((k) => !knownKeys.has(k))
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown config fields: ${unknownKeys.join(', ')}`)
  }

  return validated
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

/**
 * v0.39: shape validation for a config-declared toolPolicy (untrusted JSON —
 * it comes from disk or from the panel, so it must be checked before use).
 */
const validateToolPolicyShape = (value: unknown): SubAgentToolPolicy => {
  if (value === null || typeof value !== 'object') {
    throw new Error('Sub-agent config "toolPolicy" must be an object')
  }
  const p = value as Record<string, unknown>
  if (p.default !== 'allow' && p.default !== 'deny') {
    throw new Error('Sub-agent config "toolPolicy.default" must be "allow" or "deny"')
  }
  if (!Array.isArray(p.rules)) {
    throw new Error('Sub-agent config "toolPolicy.rules" must be an array')
  }
  const rules: SubAgentToolPolicy['rules'] = []
  for (const r of p.rules) {
    if (r === null || typeof r !== 'object') {
      throw new Error('Sub-agent config "toolPolicy.rules[]" entries must be objects')
    }
    const rule = r as Record<string, unknown>
    if (rule.mode !== 'allow' && rule.mode !== 'deny') {
      throw new Error('Sub-agent config "toolPolicy.rules[].mode" must be "allow" or "deny"')
    }
    if (typeof rule.pattern !== 'string' || rule.pattern.length === 0) {
      throw new Error('Sub-agent config "toolPolicy.rules[].pattern" must be a non-empty string')
    }
    rules.push({ mode: rule.mode, pattern: rule.pattern })
  }
  return { default: p.default, rules }
}

export const validateSubAgentConfig = (
  cfg: unknown,
  registry: ToolRegistry,
  opts?: { toolPolicy?: SubAgentToolPolicy },
): SubAgentConfig => {
  if (cfg === null || typeof cfg !== 'object') {
    throw new Error('Sub-agent config must be an object')
  }
  const candidate = cfg as Record<string, unknown>
  // P2.1: path-safe name — prevents path traversal and reserved filenames.
  if (!isNonEmptyString(candidate.name) || !isSafeAgentName(candidate.name)) {
    throw new Error(
      'Sub-agent name must be 1-64 characters, only [a-zA-Z0-9_-], and not a Windows or system reserved name'
    )
  }
  if (!isNonEmptyString(candidate.systemPrompt)) {
    throw new Error('Sub-agent config requires a non-empty "systemPrompt" string')
  }
  if (!isStringArray(candidate.toolRefs) || candidate.toolRefs.length === 0) {
    throw new Error('Sub-agent config requires a non-empty "toolRefs" string array')
  }

  // v0.39: the config may declare its own policy — validated for shape, then
  // used (REPLACES any environment policy). Fallback chain, in order:
  //   1. the config's own declaration (cfg.toolPolicy);
  //   2. the environment policy (opts.toolPolicy — what the registry's
  //      constructor carries: assembly maps the nesting toggle to
  //      PERMISSIVE/DEFAULT);
  //   3. DEFAULT_SUB_AGENT_TOOL_POLICY for bare calls — fail closed. This
  //      function gates untrusted JSON, and a caller that declares no
  //      environment gets the strictest boundary (the permissive fallback
  //      would have made a silent registry-less call an implicit allow-all).
  let declaredPolicy: SubAgentToolPolicy | undefined
  if (candidate.toolPolicy !== undefined) {
    declaredPolicy = validateToolPolicyShape(candidate.toolPolicy)
  }
  const policy = declaredPolicy ?? opts?.toolPolicy ?? DEFAULT_SUB_AGENT_TOOL_POLICY
  for (const ref of candidate.toolRefs) {
    if (SYSTEM_AGENT_PRIVATE_TOOLS.has(ref)) {
      throw new Error(`Tool '${ref}' is reserved for the compressor system agent`)
    }
    if (!applyToolPolicy(ref, policy)) {
      const matchedPattern = findMatchingPattern(ref, policy)
      const patternHint = matchedPattern
        ? `(matched deny pattern: '${matchedPattern}')`
        : '(denied by default policy)'
      throw new Error(
        `Tool '${ref}' is not allowed by sub-agent policy ${patternHint}`
      )
    }
  }

  // v0.13: sub-agents may reference system, MCP, and skill tools. Whether a
  // given ref is *permitted* was already decided by applyToolPolicy above
  // (single-layer enforcement — v0.13 constraint 5 / decision D7). Here we
  // only assert the ref resolves to *something* registered, so typos still
  // surface at load time. This replaces the v0.12.2 blanket rejection of
  // MCP/skill refs; permission is now policy-driven, not kind-driven.
  for (const ref of candidate.toolRefs) {
    if (registry.resolveRef(ref) === undefined) {
      throw new Error(`Unknown toolRefs in sub-agent config: ${ref}`)
    }
  }

  const validated: SubAgentConfig = {
    name: candidate.name,
    systemPrompt: candidate.systemPrompt,
    toolRefs: candidate.toolRefs,
  }

  // v0.39: the declared policy travels with the config (part of identity).
  if (declaredPolicy !== undefined) {
    validated.toolPolicy = declaredPolicy
  }

  // P2.4: strict validation of config overrides (positive ints ≤ DEFAULT_CONFIG).
  if (candidate.config !== undefined) {
    validated.config = validateShellConfigOverrides(candidate.config)
  }

  // 归属标记透传（用户拍板 2026-09-09）：'agent' = AI 任务导向（会话级），
  // 'user'/缺省 = 用户长期资产。仅接受枚举值，其他输入丢弃（视为 user）。
  if (candidate.createdBy === 'user' || candidate.createdBy === 'agent') {
    validated.createdBy = candidate.createdBy
  }

  return validated
}
