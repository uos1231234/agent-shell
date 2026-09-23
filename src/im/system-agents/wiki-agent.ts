// v0.13.1: Wiki system agent — code-domain knowledge base curator.
//
// Future Frontend API Contract (tool schema → REST endpoint):
//   POST /api/wiki/scan       → wiki__scan_codebase
//   POST /api/wiki/generate   → wiki__add_card (batch)
//   GET  /api/wiki/render/:id → wiki__render_md
//   GET  /api/wiki/search     → wiki__search_cards
//   GET  /api/wiki/cards/:id  → wiki__get_card
//
// The agent owns its wiki-mcp connection (spawned child process via
// createWikiMcpConnection). The connection is registered into the shared
// ToolRegistry under server name "wiki" so tools appear as wiki__<name>.
// isWikiAgent: true threads through createSystemAgent → IMLoopOptions →
// ToolContext, unlocking the wiki__ security hook registered in
// bootstrapExtensions (extensions.ts).
//
// Connection lifecycle: the caller MUST call wikiAgent.closeConnection()
// (or the agent's stop()) once done to kill the spawned server process.
// The agent does NOT auto-close on run() completion — the connection is
// reusable across multiple run() calls (single-shot agent, long-lived
// process). Tests that inject a fake connection should still call
// closeConnection() to avoid dangling fake timers.

import { createSystemAgent, type SystemAgent } from '../system-agent.js'
import { WIKI_AGENT_PROMPT } from '../prompts/index.js'
import { createWikiMcpConnection } from '../../mcp-servers/wiki-mcp/connection-adapter.js'
import { registerMcpConnection } from '../../mcp/boot.js'
import type { McpConnection } from '../../mcp/connection.js'
import type { Mailbox } from '../mailbox/index.js'
import type { ToolRegistry } from '../../shell/registry.js'
import type { StreamChunk, ChatMessage } from '../../protocol/types.js'
import type { StateLine } from '../state-line/types.js'
import { createWikiRenderRule } from '../../rendering/rules/wiki.js'
import { createRenderingLoopHook } from '../../rendering/hooks/rendering-loop-hook.js'
import type { RenderingSignalBus } from '../../rendering/signal-bus.js'
import type { RenderingBase } from '../../rendering/base.js'
import type { LoopHooks } from '../loop-hooks.js'
import { ArtifactStore } from '../../im/tools/artifact-store.js'

// All 17 wiki-mcp tools, as flat `wiki__<name>` refs. The wiki agent sees
// the full tool surface; the registry guard ensures no other agent can call
// them. Order mirrors server.js getTools() (query → diff → write → code).
export const WIKI_TOOL_REFS: readonly string[] = [
  // query (10)
  'wiki__search_cards',
  'wiki__get_card',
  'wiki__get_relations',
  'wiki__get_card_tree',
  'wiki__get_source',
  'wiki__list_cards',
  'wiki__get_phase_context',
  'wiki__list_phases',
  'wiki__check_doc_updates',
  'wiki__read_raw_file',
  // diff (1)
  'wiki__diff_docs',
  // write (4)
  'wiki__add_card',
  'wiki__update_card',
  'wiki__remove_card',
  'wiki__update_relations',
  // code-domain (2)
  'wiki__scan_codebase',
  'wiki__render_md',
]

export type WikiSystemAgent = SystemAgent & {
  /** Kill the spawned wiki-mcp server process. Idempotent. */
  closeConnection(): Promise<void>
}

export type CreateWikiAgentDeps = {
  registry: ToolRegistry
  stateLine: StateLine
  llmStreamChat: (
    url: string,
    request: { model: string; messages: ChatMessage[]; tools: unknown[]; [k: string]: unknown },
  ) => AsyncIterable<StreamChunk>
  url: string
  model: string
  mailbox: Mailbox
  tokenCounter?: import('../../shared/token-counter.js').TokenCounter | (() => import('../../shared/token-counter.js').TokenCounter)
  /**
   * Optional injected connection (tests pass a fake; production lets the
   * agent spawn its own via createWikiMcpConnection). When provided, the
   * agent registers it into the registry and owns its close() lifecycle.
   */
  connection?: McpConnection
  /**
   * Optional server path / spawn override forwarded to
   * createWikiMcpConnection when no `connection` is injected.
   */
  serverPath?: string
  /**
   * Optional rendering infrastructure (bus + base + shared store). When provided,
   * the wiki agent registers a wiki__render_md rule on the bus and wires the
   * rendering loop hook so that rendered markdown is silently turned into HTML
   * and broadcast to frontends. When omitted, the agent works as before (no
   * rendering).
   *
   * P1 fix (v0.20): the store MUST be the same instance used by both the rule
   * and the base. The rule writes artifact ids into the store; the base reads
   * them back in its onSignal callback. Two different stores → artifact-ref
   * lookup permanently fails → rendering silently lost.
   */
  rendering?: {
    bus: RenderingSignalBus
    base: RenderingBase
    store: ArtifactStore
  }
  /**
   * v0.41 D19 覆盖面扩展（用户拍板 2026-09-14）：provider 要求严格角色交替时置
   * true，透传给 wiki agent 的 loop。wiki agent 与其他系统智能体同因——
   * createSystemAgent 硬编码 `userTemplate: ''`，请求尾部总跟一条空 user 消息。
   */
  strictAlternation?: boolean | undefined
}

/**
 * Create the wiki system agent and register its wiki-mcp connection into the
 * shared registry. The agent is ready to run() immediately after this returns.
 *
 * Side effects:
 *   - Registers wiki__ tools into `deps.registry` (via registerMcpConnection).
 *   - Spawns a wiki-mcp server child process (unless `deps.connection` given).
 *
 * The caller is responsible for calling `wikiAgent.closeConnection()` (or
 * `stop()`) when the agent is no longer needed, to kill the child process.
 */
export async function createWikiAgent(deps: CreateWikiAgentDeps): Promise<WikiSystemAgent> {
  const conn = deps.connection ?? createWikiMcpConnection(
    deps.serverPath !== undefined ? { serverPath: deps.serverPath } : {},
  )
  // Register the connection's tools into the shared registry under server
  // name "wiki". registerMcpConnection returns the flat names it registered;
  // we discard the return — WIKI_TOOL_REFS is the authoritative list the
  // agent advertises to the LLM, and it must match what the server exposes.
  // A mismatch (server adds/removes a tool) would show up as a toolRef that
  // resolveRef can't classify — createSystemAgent routes unresolvable refs
  // into systemToolRefs, which compose silently skips. That's acceptable
  // degradation, not a crash.
  await registerMcpConnection(deps.registry, conn)

  // v0.13.1 wiki guard: safety-net registration. The primary registration
  // point is bootstrapExtensions (extensions.ts); this duplicate ensures the
  // guard is present even when callers create the wiki agent without running
  // bootstrapExtensions. Duplicate registration is harmless — the second hook
  // never blocks what the first already allowed (identical predicate), it only
  // adds a redundant check per wiki__ call when both paths ran.
  const WIKI_TOOL_PREFIX = 'wiki__'
  deps.registry.registerSecurityHook((_args, ctx, name) => {
    if (name.startsWith(WIKI_TOOL_PREFIX) && !ctx?.isWikiAgent) {
      return new Error(`Tool "${name}" is restricted to the wiki system agent`)
    }
  })

  // v0.20: register wiki rendering rule + wire rendering hook when rendering
  // infra is provided. The rule matches wiki__render_md results and turns them
  // into ArtifactSignals (HTML) via the rendering base. Idempotent with other
  // agents that share the same bus — the rule only fires for wiki__render_md.
  //
  // P1 fix: use the SHARED store (deps.rendering.store) — the same instance
  // the base was created with. Creating a separate store here would make the
  // rule's artifact ids invisible to the base's onSignal callback, causing
  // artifact-ref lookups to permanently fail (rendering silently lost).
  let renderingHook: LoopHooks | undefined
  let renderingRuleUnregister: (() => void) | undefined
  if (deps.rendering) {
    const { bus, store } = deps.rendering
    renderingRuleUnregister = bus.registerRule(createWikiRenderRule(store))
    renderingHook = { afterToolExecution: createRenderingLoopHook(bus) }
  }

  const agent = createSystemAgent({
    name: 'wiki',
    systemPrompt: WIKI_AGENT_PROMPT,
    toolRefs: WIKI_TOOL_REFS,
    llmStreamChat: deps.llmStreamChat,
    url: deps.url,
    model: deps.model,
    mailbox: deps.mailbox,
    registry: deps.registry,
    stateLine: deps.stateLine,
    // v0.13.1: unlock the wiki__ security hook for this agent's loop only.
    isWikiAgent: true,
    // v0.20: rendering hook — forwards wiki__render_md results to the bus.
    ...(renderingHook !== undefined ? { hooks: renderingHook } : {}),
    ...(deps.strictAlternation === true ? { strictAlternation: true } : {}),
    ...(deps.tokenCounter !== undefined ? { tokenCounter: deps.tokenCounter } : {}),
  })

  let connectionClosed = false
  const closeConnection = async (): Promise<void> => {
    if (connectionClosed) return
    connectionClosed = true
    // v0.20: 注销渲染 rule（如果注册了）
    renderingRuleUnregister?.()
    await conn.close().catch(() => undefined)
  }

  return {
    run: agent.run,
    // stop() also closes the connection — callers using the SystemAgent
    // interface (without the WikiSystemAgent extension) still get cleanup.
    stop() {
      agent.stop()
      void closeConnection()
    },
    send: agent.send,
    closeConnection,
  }
}
