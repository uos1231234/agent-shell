import { randomUUID } from 'node:crypto'
import { Databus } from './databus.js'
import { ConversationMemory, type ConversationTurn } from './conversation-memory.js'
import { Mailbox } from './mailbox/index.js'
import type { IMLoopOptions, SystemAgents } from './loop.js'
import type { SystemAgent } from './system-agent.js'
import type { DriveCoordinator } from './system-agents/drive-coordinator.js'
import { createNoopStateLine } from './state-line/index.js'
import type { StateLine } from './state-line/types.js'
import { SubAgentRegistry, defaultAgentsDir } from './sub-agent/index.js'
import { BUILTIN_SUB_AGENT_CONFIGS } from './prompt/subagent-roles.js'
import { createWhenToReadInjection } from './hooks/injections/when-to-read.js'

// A noop system agent used when real system agents are not configured.
// Tools that call system agents will throw a clear error at runtime.
const noopSystemAgent: SystemAgent = {
  run: async () => { throw new Error('no system agents configured; provide real systemAgents in IMLoopOptions to enable system-agent-backed tools') },
  stop() {},
  send() {},
}

const defaultSystemAgents: SystemAgents = {
  warehouse: noopSystemAgent,
  compressor: noopSystemAgent,
  recall: noopSystemAgent,
}

// v0.12.2: default tool refs for the WORKING agent — the harness tools every
// agent may use (databus + mailbox) plus ask_recall (working -> recall bridge).
// compress_block is intentionally absent (retired; drive-coordinator drives
// compression). A caller's explicit opts.systemToolRefs always wins.
export const DEFAULT_WORKING_AGENT_TOOL_REFS: readonly string[] = [
  'databus_query',
  'databus_subscribe',
  'state_query',
  'ask_recall',
  'mailbox_send',
  'mailbox_read',
  'mailbox_status',
  'mailbox_markread',
]

// Wraps partial IMLoopOptions with the v0.10.1 required fields.
// The caller still provides config, registry, streamChat, url, model, systemPrompt, etc.
export const createMinimalIM = (opts: {
  config: IMLoopOptions['config']
  registry: IMLoopOptions['registry']
  streamChat: IMLoopOptions['streamChat']
  url: string
  model: string
  systemPrompt: string
  userTemplate: string
  systemToolRefs?: string[]
  mcpRefs?: { server: string; refs: string[] }[]
  skillRefs?: string[]
  databus?: Databus
  conversationMemory?: ConversationMemory
  workingAgentId?: string
  mailbox?: Mailbox
  systemAgents?: SystemAgents
  stateLine?: StateLine
  // v0.11: optional sub-agent registry. When omitted, a default registry is
  // created; the caller can load configs from disk explicitly.
  subAgentRegistry?: SubAgentRegistry
  // v0.11: optional contextual databus. When set, the working agent's tools
  // read from this bus (e.g. sub-agent events) via ctxDatabus. Typically
  // set to subAgentRegistry.sharedDatabus.
  ctxDatabus?: Databus | readonly Databus[]
  // v0.11.2 G3: optional drive coordinator. Pass-through only — the caller
  // constructs it (via createDriveCoordinator or createNoopDriveCoordinator).
  // createMinimalIM does NOT build one; it just forwards what the caller gives.
  driveCoordinator?: DriveCoordinator
  // v0.16: optional explicit security-router sessionId. When omitted, a fresh
  // UUID is minted per createMinimalIM call (one call = one session). Callers
  // that want to pin a session (e.g. resume a previous conversation's
  // permission grants) can pass the same id here.
  securitySessionId?: string
  // v0.17: optional per-turn persistence hook (forwarded to IMLoopOptions).
  // When set, the loop calls it after every canonical append so a session
  // manager can snapshot the conversation. When omitted, pure in-memory.
  persistTurn?: (turn: ConversationTurn) => Promise<void>
  // v0.17: optional per-loop control-flow hooks (forwarded to IMLoopOptions).
  hooks?: IMLoopOptions['hooks']
  // v0.19: layered prompt configuration. Currently not wired into composePrompt; reserved.
  // promptLayers?: IMLoopOptions['promptLayers']
  // promptMode?: IMLoopOptions['promptMode']
  // v0.19: context injection hook — replaces hardcoded dynamic content injection.
  contextInjector?: IMLoopOptions['contextInjector']
  // v0.19: hook system — general-purpose event hooks.
  hookSystem?: IMLoopOptions['hookSystem']
}): IMLoopOptions => {
  // v0.12: resolve the working agent id first because it drives the tree root id.
  const workingAgentId = opts.workingAgentId ?? 'main'

  // v0.16 (Q1-B): each createMinimalIM call mints a fresh security-router
  // sessionId (UUID). One call = one session; two sessions sharing a registry
  // get distinct ApprovalStores, so permission changes never leak across
  // sessions. Sub-agents spawned by this loop inherit this sessionId via
  // run-subagent.ts (ctx.sessionId → child loop), so the whole family shares
  // the same permission context. getOrCreateSession (not createSession) is
  // used so a caller pre-seeding an explicit session (or calling
  // createMinimalIM twice) cannot crash on a duplicate id.
  const securitySessionId = opts.securitySessionId
    ?? `${randomUUID()}`

  // v0.20 (ADR-025 #5): register the when-to-read injection (v0.42: merged
  // memory_md + architecture_desc) when contextInjector is provided. Reads
  // ctx.workDir (user working folder, frontend-provided) — filename match
  // MEMORY.md / ARCHITECTURE.md; full text on demand via A/C/B choices.
  if (opts.contextInjector) {
    opts.contextInjector.register(createWhenToReadInjection())
  }

  // v0.12: when a subAgentRegistry is provided, the working agent's private
  // databus MUST be the tree root's ownDatabus. This ensures children's
  // ctxDatabus (which includes parent.ownDatabus) correctly sees the working
  // agent's tool events. We also align the tree root id with workingAgentId
  // before any children exist, so run_subagent can look up the current agent.
  // v0.17: the tree is bound to the same session UUID as the security router
  // (securitySessionId) so the sub-agent databus tree is attributable to the
  // session — databus, tree, and security all share one sessionId string value.
  // The caller may supply an explicit opts.databus to become the root bus.
  // When no registry, use the caller-provided bus or create a fresh one —
  // identical to v0.11 behavior (backward compat).
  //
  // Limitation: a SubAgentRegistry maps to exactly one working agent — a second
  // createMinimalIM call against the same registry either rewrites root.id
  // (no children) or throws (children present). Multiple working agents each
  // need their own SubAgentRegistry.
  let databus: Databus
  if (opts.subAgentRegistry) {
    opts.subAgentRegistry.agentTree.rebindRoot({
      rootId: workingAgentId,
      sessionId: securitySessionId,
      ...(opts.databus ? { rootOwnDatabus: opts.databus } : {}),
    })
    databus = opts.subAgentRegistry.agentTree.root.ownDatabus
  } else {
    databus = opts.databus ?? new Databus({ sessionId: securitySessionId })
  }

  // v0.12 P0-fix: when no caller-supplied mailbox but a subAgentRegistry is
  // present, inject the registry's agentTree into the Mailbox so that
  // verifyRoute enforces lineage isolation in production. When the caller
  // supplies their own mailbox, they are responsible for its tree wiring —
  // a caller-supplied Mailbox without an AgentTree will NOT enforce route
  // checks (Mailbox behaves as pre-v0.11 in that case). When neither registry
  // nor caller mailbox is present, a plain Mailbox is created (backward
  // compat — no route checks).
  const mailbox = opts.mailbox
    ?? (opts.subAgentRegistry
      ? new Mailbox(opts.subAgentRegistry.agentTree)
      : new Mailbox())

  const base: IMLoopOptions = {
    config: opts.config,
    registry: opts.registry,
    databus,
    conversationMemory: opts.conversationMemory ?? new ConversationMemory(),
    workingAgentId,
    mailbox,
    systemAgents: opts.systemAgents ?? defaultSystemAgents,
    stateLine: opts.stateLine ?? createNoopStateLine(),
    streamChat: opts.streamChat,
    url: opts.url,
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    userTemplate: opts.userTemplate,
    // v0.16: working agent's sessionId = the per-call UUID (or caller-pinned
    // securitySessionId). Loop threads it into ToolContext so
    // registry.execute → router.check dispatches to the right per-session
    // state. Always set (not gated on subAgentRegistry) so even a registry
    // without a sub-agent tree gets session isolation.
    sessionId: securitySessionId,
    systemToolRefs: opts.systemToolRefs ?? [...DEFAULT_WORKING_AGENT_TOOL_REFS],
    mcpRefs: opts.mcpRefs ?? [],
    skillRefs: opts.skillRefs ?? [],
    // v0.17: forward the optional per-turn persistence hook to the loop.
    ...(opts.persistTurn ? { persistTurn: opts.persistTurn } : {}),
    // v0.17: forward optional per-loop control-flow hooks.
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    // v0.19: promptLayers/promptMode — 当前未接入 composePrompt，预留接口。
    // ...(opts.promptLayers ? { promptLayers: opts.promptLayers } : {}),
    // ...(opts.promptMode ? { promptMode: opts.promptMode } : {}),
    ...(opts.contextInjector ? { contextInjector: opts.contextInjector } : {}),
    ...(opts.hookSystem ? { hookSystem: opts.hookSystem } : {}),
  }
  // v0.12: wire ctxDatabus from the tree root when a registry is present.
  // Working agent's ctxDatabus = [root.ownDatabus, root.familyDatabus] (D5) so
  // it sees its own history plus all its children's events. When no registry,
  // fall back to v0.11 behavior: just use base.databus (no tree, no shared
  // bus). Any caller-supplied ctxDatabus is appended in both paths.
  // v0.11.2 S2: when only the own bus would be present (no registry and no
  // caller ctxDatabus), don't set ctxDatabus at all — the loop falls back to
  // opts.databus, avoiding a single-element array + MultiDatabus.
  const ctxDatabus: Databus[] = []
  if (opts.subAgentRegistry) {
    ctxDatabus.push(opts.subAgentRegistry.agentTree.root.ownDatabus)
    ctxDatabus.push(opts.subAgentRegistry.agentTree.root.familyDatabus)
  } else if (base.databus) {
    ctxDatabus.push(base.databus)
  }
  if (opts.ctxDatabus) {
    if (Array.isArray(opts.ctxDatabus)) ctxDatabus.push(...opts.ctxDatabus)
    else ctxDatabus.push(opts.ctxDatabus as Databus)
  }
  // Only set ctxDatabus when there's more than one bus. With a registry there
  // are at least 2 (own + family); without, a single own-bus array adds no
  // value — the loop already uses opts.databus for that.
  if (ctxDatabus.length > 1) {
    return { ...base, ctxDatabus, ...(opts.driveCoordinator ? { driveCoordinator: opts.driveCoordinator } : {}) }
  }
  return { ...base, ...(opts.driveCoordinator ? { driveCoordinator: opts.driveCoordinator } : {}) }
}

// v0.11 helper: create a SubAgentRegistry with an optional disk load.
// Returns the registry so the caller can pass it to registerSystemAgentTools.
// v0.11.3 P0-2: callers can inject a custom SubAgentToolPolicy via opts.toolPolicy;
// it flows from the constructor into register() and loadFromDisk().
export const createSubAgentRegistry = async (opts?: {
  diskDir?: string
  registry?: import('../shell/registry.js').ToolRegistry
  toolPolicy?: import('./sub-agent/policy.js').SubAgentToolPolicy
  builtinRoles?: boolean
}): Promise<SubAgentRegistry> => {
  // P2.8: pass the ToolRegistry to the constructor so register() can
  // re-validate configs at the library level, not just via define_subagent.
  const registry = opts
    ? new SubAgentRegistry({
        ...(opts.registry ? { registry: opts.registry } : {}),
        ...(opts.toolPolicy ? { toolPolicy: opts.toolPolicy } : {}),
      })
    : new SubAgentRegistry()
  if (opts?.diskDir && opts?.registry) {
    await registry.loadFromDisk(opts.diskDir, opts.registry)
  }
  // v0.38: register the built-in roles so explore / editor are usable out of the
  // box. v0.39: each config carries its own toolPolicy (the editor's declares
  // its recursion guard) — nothing is injected at registration time.
  if (opts?.builtinRoles && opts?.registry) {
    for (const cfg of BUILTIN_SUB_AGENT_CONFIGS) {
      await registry.register({
        name: cfg.name,
        systemPrompt: cfg.systemPrompt,
        toolRefs: [...cfg.toolRefs],
        ...(cfg.toolPolicy !== undefined ? { toolPolicy: cfg.toolPolicy } : {}),
      })
    }
  }
  return registry
}

export { SubAgentRegistry, defaultAgentsDir }
