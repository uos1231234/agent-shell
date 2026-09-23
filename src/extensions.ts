// v0.13 Batch 3 + v0.10.6: one-shot extension bootstrap.
//
// Startup-time assembly of MCP servers + skill modules + text skills into a
// ToolRegistry. Zero hot-plug (registry.ts:6 — "Registration is startup-time
// only. No runtime add/remove."). This module is pure orchestration: it wires
// bootMcpServers + loadSkillsFromDir + loadTextSkillsFromDir together and owns
// a single close() that tears down any MCP connections opened. It contains no
// business logic.
//
// Order is fixed (plan §3.1 + v0.13 incremental): MCP first, then module
// skills, then text skills. This matters for collision detection — each
// loader's { registry } option checks names against the registry's existing
// flat names (system / mcp-flat / module skill / text skill), so loading
// later means a name that shadows anything already registered fails at load
// time rather than silently shadowing at execute time (registry dispatches
// system → mcp → module skill on first hit).
//
// v0.10.6 routing split: module skills (form:'module') still go through
// registry.registerSkill (tool_call path, unchanged). Text skills
// (form:'text') now go through registry.registerTextSkill — they land in the
// registry's textSkills store and are pre-injected into the system prompt by
// compose (skillText part), NOT exposed as callable tools. This is the
// user-decided load-time classification: pure-content skills are separated
// from execution skills at registration, not at call time.
//
// Fail-fast continues at the composition layer: if either skill stage throws,
// every MCP connection already opened is closed before rethrowing — no
// partial-boot silent state survives (plan constraint 7).

import type { ToolRegistry } from './shell/registry.js'
import type { McpServerConfig } from './mcp/config.js'
import type { ApprovalHandler } from './im/tools/security/approval-store.js'
import { DEFAULT_MCP_SERVERS } from './mcp/config.js'
import { bootMcpServers, type McpBootResult } from './mcp/boot.js'
import { loadSkillsFromDir } from './skills/loader.js'
import { loadTextSkillsFromDir } from './skills/text-loader.js'
import {
  createSensitivePathDoor,
  createDangerousCommandDoor,
  createWriteApprovalDoor,
  createBrowserToolsDoor,
} from './security/index.js'
// v0.20: 渲染基座工厂（per-session 隔离）
import { createRenderingSignalBus } from './rendering/signal-bus.js'
import { createRenderingBase } from './rendering/base.js'
import type { RenderingSignalBus } from './rendering/signal-bus.js'
import type { RenderingBase } from './rendering/base.js'
import { ArtifactStore } from './im/tools/artifact-store.js'

/**
 * Register the wiki__ tool guard on a registry. Extracted so that
 * bootstrapExtensions and any caller that builds a wiki agent without the full
 * bootstrap path share a single implementation. createWikiAgent no longer
 * registers its own hook — it relies on this being called first.
 */
export function registerWikiGuard(registry: ToolRegistry): void {
  const WIKI_TOOL_PREFIX = 'wiki__'
  registry.registerSecurityHook((_args, ctx, name) => {
    if (name.startsWith(WIKI_TOOL_PREFIX) && !ctx?.isWikiAgent) {
      return new Error(`Tool "${name}" is restricted to the wiki system agent`)
    }
  })
}

export type ExtensionBootstrapOptions = {
  registry: ToolRegistry
  mcpServers?: readonly McpServerConfig[]
  skillsDir?: string
  /** Directory of plain-text skill files (.md / .txt). Loaded after skillsDir. */
  textSkillsDir?: string
  /** Called when a tool call needs human approval. If omitted, a fail-closed stub is used. */
  approvalHandler?: ApprovalHandler
}

export type ExtensionBootstrapResult = {
  /** MCP server names that were connected, in config order. */
  servers: string[]
  /** Flat `server__tool` names of every MCP tool registered. */
  tools: string[]
  /** Module skill names that were loaded and registered (from skillsDir). */
  skills: string[]
  /** Text skill names that were loaded and registered (from textSkillsDir). */
  textSkills: string[]
  // v0.20: per-session 渲染基座（bus + base + store 三件套）。
  // 多会话隔离：每个会话独立的 bus/base/store，避免跨会话 artifact 泄漏。
  rendering?: {
    bus: RenderingSignalBus
    base: RenderingBase
    store: ArtifactStore
  }
  /**
   * Close every MCP connection opened during bootstrap. Idempotent. When no
   * MCP servers were configured this is a no-op (skills hold no connection).
   */
  close(): Promise<void>
}

/**
 * Assemble MCP servers and skill modules into `registry` in one call.
 *
 * MCP servers are booted first (fail-fast: one bad server closes everything
 * already opened). Skills are then loaded from `skillsDir` and registered
 * one by one; loadSkillsFromDir already rejects names colliding with any
 * existing registry entry (system / mcp-flat / skill), so the order above is
 * what makes skill-vs-MCP collision detection work.
 *
 * If the skill stage throws, the MCP connections opened earlier are closed
 * before the error propagates — a partial boot never escapes this function.
 */
export async function bootstrapExtensions(
  opts: ExtensionBootstrapOptions,
): Promise<ExtensionBootstrapResult> {
  const { registry, skillsDir, textSkillsDir } = opts

  // ---- MCP stage ----
  // When the caller omits mcpServers entirely (undefined), fall back to
  // DEFAULT_MCP_SERVERS (playwright). An explicit array — including [] —
  // is respected as the caller's intent (zero servers).
  const mcpServers = opts.mcpServers === undefined ? DEFAULT_MCP_SERVERS : opts.mcpServers
  let mcp: McpBootResult | undefined
  if (mcpServers.length > 0) {
    mcp = await bootMcpServers(registry, mcpServers)
  }

  // v0.20: per-session 渲染基座（bus + base + store 三件套）。
  // 声明在 try/catch 外部，确保 return 和 close() 可访问。
  const renderingStore = new ArtifactStore()
  const renderingBus = createRenderingSignalBus()
  const renderingBase = createRenderingBase(renderingBus, { store: renderingStore })

  // ---- Skill stages (module skills, then text skills) ----
  // Order is fixed (plan §3.1 + v0.13 incremental): MCP → module skill → text
  // skill. The registry grows incrementally, so each later stage's collision
  // check covers everything loaded before it — a text skill that shadows a
  // module skill name (or an MCP flat name, or a system tool) fails at load
  // time rather than silently shadowing at execute time.
  //
  // On failure of EITHER skill stage, close the MCP connections opened above
  // so no partial state survives. Skills themselves hold no connection, so
  // there is nothing else to clean up.
  let skillNames: string[]
  let textSkillNames: string[]
  try {
    if (skillsDir) {
      const defs = await loadSkillsFromDir(skillsDir, { registry })
      for (const def of defs) {
        registry.registerSkill(def)
      }
      skillNames = defs.map((d) => d.name)
    } else {
      skillNames = []
    }
    if (textSkillsDir) {
      const textDefs = await loadTextSkillsFromDir(textSkillsDir, { registry })
      for (const def of textDefs) {
        // v0.10.6: text skills (form:'text') go to the textSkills store, NOT
        // the callable-tool skills map. registerSkill would throw on form:'text'
        // (registry.ts guards against the misroute). registerTextSkill stores
        // (name, body, whenToUse) for compose to pre-inject; the def's execute
        // closure is ignored. body/when_to_use are optional on the type but
        // guaranteed present by loadTextSkillsFromDir for form:'text' skills —
        // we read them via def.body (non-null because text-loader set it) and
        // def.when_to_use (may be legitimately undefined).
        if (def.body === undefined) {
          // Defensive: text-loader always sets body for form:'text'. If this
          // fires, a caller hand-constructed a form:'text' def without body —
          // a programming error worth surfacing, not silently skipping.
          throw new Error(
            `Text skill "${def.name}" has no body (form:'text' requires body)`,
          )
        }
        registry.registerTextSkill(def.name, def.body, def.when_to_use)
      }
      textSkillNames = textDefs.map((d) => d.name)
    } else {
      textSkillNames = []
    }
  } catch (e) {
    if (mcp) await mcp.close()
    throw e
  }

  // v0.13.1: wiki-mcp tools (wiki__ prefix) are restricted to the wiki system
  // agent. Enforced via a security hook so the generic registry.execute() stays
  // prefix-agnostic — the registry knows nothing about "wiki". The hook runs
  // inside executeGuarded (before reason validation + execute) for every
  // MCP/skill tool call. wiki__ tools are MCP tools, so they go through
  // executeGuarded and hit this hook. Non-wiki agents (ctx.isWikiAgent falsy)
  // are blocked; the wiki agent's loop sets ctx.isWikiAgent=true (via
  // IMLoopOptions → ToolContext) to pass the hook.
  //
  // Primary registration point: bootstrapExtensions (this call). The wiki agent
  // factory (createWikiAgent in wiki-agent.ts) also registers an identical
  // predicate as a safety net — callers that create the wiki agent without
  // running bootstrapExtensions still get the guard. The duplicate is harmless
  // (identical predicate: the second hook never blocks what the first already
  // allowed); it only adds one redundant check per wiki__ call when both paths
  // ran.
  registerWikiGuard(registry)

  // v0.16: replace the v0.15 approval SystemSecurityHook with three
  // pluggable SecurityDoors registered on the ToolRegistry. v0.20: the
  // standalone SecurityRouter is dissolved — the registry itself runs every
  // door's check() in registration order before tool.execute() (see
  // registry.ts execute() + checkDoors()). Doors share a per-session
  // SessionSecurityState; each session's approval grant cache lives on the
  // ApprovalStore that the registry itself attaches to the session state —
  // callers do NOT pass a store to the door.
  //
  // The approval handler is still a stub that rejects (fail-closed secure
  // default). TODO: wire up the actual handler from the caller's approval
  // channel (SSE/websocket/CLI). The handler shape is unchanged from v0.15.
  registry.registerDoor(createSensitivePathDoor())
  registry.registerDoor(createDangerousCommandDoor())
  registry.registerDoor(createWriteApprovalDoor({
    handler: opts.approvalHandler ?? (async (request) => {
      // TODO: emit event to user, await response.
      // For now: reject (fail-closed secure default).
      console.warn('[approval] tool call needs approval:', request.toolName, request.reason)
      return 'rejected'
    }),
    timeoutMs: 300000,  // 300s
  }))
  registry.registerDoor(createBrowserToolsDoor())

  const closeMcp = mcp
  let closed = false
  return {
    servers: mcp?.servers ?? [],
    tools: mcp?.tools ?? [],
    skills: skillNames,
    textSkills: textSkillNames,
    // v0.20: per-session 渲染基座
    rendering: {
      bus: renderingBus,
      base: renderingBase,
      store: renderingStore,
    },
    async close() {
      // Idempotent: a second call is a no-op. closeMcp.close() is itself
      // idempotent (boot.ts D3), and the local `closed` flag guards the case
      // where no MCP was booted (closeMcp is undefined).
      if (closed) return
      closed = true
      if (closeMcp) await closeMcp.close()
    },
  }
}
