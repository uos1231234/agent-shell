// ADR-005 + ADR-006: Unified tool registry.
// All tools (system, MCP, skill) are callable via the same executor interface.
// Schemas are exported in OpenAI native format for direct inclusion in the request body.
// MCP tools are namespaced as `server__tool` to avoid collisions.
//
// Registration is startup-time only. No runtime add/remove. (No hot-plug.)
//
// v0.10.5: MCP/skill guard. System tools keep their own wrapTool path (ADR-013);
// MCP and skill tools are bare `execute`, so the registry wraps them here with
// the same quality bar: reason validation, security hooks, error wrapping, and
// result truncation. The system-tool branch is unchanged — it is already
// wrapped at registration time, so double-wrapping would only mask errors.

import type { JSONSchema } from '../shared/json-schema.js'
import type { ToolContext } from '../shared/tool-context.js'
import type { SessionId, SessionSecurityState, SecurityDoor } from '../security/types.js'
import { requireReason, cleanErrorMessage } from '../im/tools/helpers.js'
import { ApprovalStore } from '../im/tools/security/approval-store.js'

// v0.20: session fallback for callers that don't pass a sessionId (v0.15
// compat — no session isolation, single shared approval state).
const GLOBAL_SESSION = '__global__'

export type ToolExecutor = (args: unknown, ctx?: ToolContext) => Promise<unknown>

// v0.10.5: concurrency category for executeToolCalls' per-class batching.
// read = 5 concurrent; write / command = 3. MCP/skill tools default to
// 'command' (conservative: an unknown MCP tool may have side effects).
// System tools may declare a category to opt into higher read concurrency.
//
// 'recall'（2026-09-17 用户拍板）：深度召回工具（state_query 的 raw-archive /
// M3 语义检索分支）的独立桶，上限 1。它读的是**磁盘上的完整历史**，单次回执可达
// 数十 K token 且体量与"当前上下文还剩多少预算"无关——一轮里并发发几个，就等于把
// 若干块历史同时灌进窗口。长程基准（work-1 / work-2 事件流）实测该工具调用数为 0
// （模型全程未召回），所以这条限流是对**已设计好的失效模式**的预防，而非对已观测
// 事故的复盘——如实记录，不假称实测证据。
export type ToolCategory = 'read' | 'write' | 'command' | 'recall'

// v0.20 hook repair: 把注释的设计值落地为代码。executeToolCalls 按 category 分桶并发，
// 废除 memory-layers.ts 的硬编码 MAX_CONCURRENT_TOOL_CALLS = 2。
export const CONCURRENCY_LIMITS: Record<ToolCategory, number> = {
  read: 5,
  write: 3,
  command: 3,
  recall: 1,
}

export type ToolDefinition = {
  name: string
  description: string
  parameters: JSONSchema
  execute: ToolExecutor
  /** Concurrency category. Defaults to 'command' for MCP/skill tools. */
  category?: ToolCategory
  // v0.20 (ADR-025 T8): per-argument parallel-safety check (AtomCode-style
  // `parallel_safe(&self, args) -> bool`). Returns true when THIS call is safe
  // to run concurrently — executeToolCalls then routes it into a dedicated
  // unbounded bucket instead of the category's capped one. The category
  // remains the conservative default; parallelSafe is a precise override.
  // Never throws: call sites guard with try/catch and fall back to the
  // category bucket on parse/predicate failure.
  parallelSafe?: (args: unknown) => boolean
}

// Skills come in two forms (v0.10.6, user decision: load-time classification):
//   - form: 'module' — code-backed skill exposed to the LLM as a callable tool
//     (tool_call path). May declare `parameters`; execute computes a result.
//   - form: 'text'   — pure-content skill whose body is pre-injected into the
//     system prompt (skillText path, compose.ts). Has NO parameters and an
//     execute that returns the body verbatim (kept for backward-compat with
//     callers that still treat it as a tool). Text skills are NOT registered
//     as tools — they live in a separate textSkills store and never appear in
//     toOpenAIToolSchemas / the tool_call dispatch path.
//
// `form` is optional on the SkillDefinition type for backward compatibility
// with existing module-skill registrations that predate this split. Callers
// that omit it are treated as 'module' (the legacy default) everywhere it
// matters: registerSkill, resolveRef, compose, execute.
//
// `when_to_use` (optional): a human-readable hint for when the LLM should
// apply a text skill's content. Text-loader parses it from frontmatter;
// compose prepends it as a comment to the injected body so the LLM sees the
// hint inline. Module skills ignore this field.
export type SkillForm = 'text' | 'module'

export type SkillDefinition = Omit<ToolDefinition, 'parameters'> & {
  parameters?: JSONSchema
  /** Skill form. 'text' = pre-injected content; 'module' = callable tool. */
  form?: SkillForm
  /**
   * Text-skill body (the file content after frontmatter). Present only on
   * form:'text' skills; used by compose's skillText path and by
   * registerTextSkill. Module skills leave this undefined.
   */
  body?: string
  /** When-to-use hint for text skills (pre-injected as a comment). */
  when_to_use?: string
}

// A text skill as stored in the registry's textSkills map: name → body.
// Kept as a plain { name, body, whenToUse } triple so compose / loop can
// iterate without touching the SkillDefinition execute closure.
export type StoredTextSkill = {
  name: string
  body: string
  whenToUse?: string
}

export type SystemTool = ToolDefinition
export type MCPTool = ToolDefinition

// v0.13: declarative source of a flat tool name, used by sub-agent routing
// (system-agent.ts) and config validation (config.ts) to classify a ref
// without re-implementing execute's lookup. Order is bound to execute — see
// resolveRef's ORDER COUPLING comment.
//
// v0.10.6: 'textSkill' is a fourth kind. Text skills are NOT tool_call
// targets (execute never dispatches to them), but resolveRef still recognizes
// them so:
//   - config.ts validateSubAgentConfig accepts a text-skill name in toolRefs
//     (declaring intent to use the pre-injected content) rather than rejecting
//     it as an unknown ref.
//   - system-agent.ts routing can classify a text-skill ref and route it to
//     the injection-only path (it is NOT added to skillRefs, which compose
//     would turn into a tool_call schema).
export type RefSource =
  | { kind: 'system' }
  | { kind: 'mcp'; server: string }
  | { kind: 'skill' }
  | { kind: 'textSkill' }

// v0.10.5: security hook for the MCP/skill execute guard. A hook may inspect
// (args, ctx, toolName) and either return void (allow) or return an Error
// (block — the guard throws it, the loop formats the sentence). Hooks are
// registered at startup via registerSecurityHook and run synchronously
// before every MCP/skill execute. System tools bypass hooks (they have their
// own wrapTool path and are trusted builtins).
export type SecurityHook = (
  args: unknown,
  ctx: ToolContext | undefined,
  toolName: string,
) => void | Error

// v0.15: system-tool security hook. Runs in the system-tool path of execute()
// (before the wrapped tool). Async to support human-approval round-trips.
// Returns void | Error (sync) or Promise<void | Error> (async).
// System tools bypass the MCP/skill SecurityHook — this is the dedicated hook
// for them. The wiki-agent pattern (isWikiAgent ctx flag) is the reference.
//
// SystemSecurityHook is retained as a commented-out type for backward compatibility.
// It was superseded by the SecurityDoor system (v0.16) which provides a unified
// concurrency + approval pipeline for ALL tool sources (system/MCP/skill).
// Reviving this hook would create a parallel, untracked approval path that
// bypasses the SecurityRouter's session isolation and release mechanism.
//
// export type SystemSecurityHook = (
//   args: unknown,
//   ctx: ToolContext | undefined,
//   toolName: string,
// ) => void | Error | Promise<void | Error>

// Flat name of a tool: system tools and skills use their own name;
// MCP tools are namespaced as `server__tool`.
const mcpName = (server: string, tool: string): string => `${server}__${tool}`

const emptyParameters = (): JSONSchema => ({ type: 'object', properties: {} })

export class ToolRegistry {
  private readonly systemTools = new Map<string, SystemTool>()
  private readonly mcpTools = new Map<string, MCPTool>()         // key: server__tool
  private readonly mcpServers = new Map<string, string[]>()       // server -> [tool, tool, ...]
  private readonly skills = new Map<string, SkillDefinition>()
  // v0.10.6: text skills are pre-injected into the system prompt (compose's
  // skillText path), NOT exposed as callable tools. Kept separate from
  // `skills` so toOpenAIToolSchemas / execute / resolveRef never surface them
  // as tool_call targets. Keyed by name for O(1) collision checks.
  private readonly textSkills = new Map<string, StoredTextSkill>()
  private readonly securityHooks: SecurityHook[] = []
  // v0.20: SecurityDoor 注册表（复用 systemSecurityHooks 点位）+ per-session
  // 安全状态。状态从 SecurityRouter 下沉到 registry 本体（hook 形态——
  // execute() 直接遍历 doors，不再经过独立 router 调度层）。
  // 注册入口保持 registerDoor()（bootstrapExtensions / 测试不变）；
  // 会话入口保持 createSession()（e2e-security-verification 等不变），
  // 惰性创建用 getOrCreateSession()（createMinimalIM 每 call 一个 UUID）。
  private readonly securityDoors: SecurityDoor[] = []
  private readonly securitySessions = new Map<SessionId, SessionSecurityState>()

  // v0.18: progressive tool disclosure metadata.
  // mcpServerMeta: server name → { description, toolNames } for load_tools
  //   and compose's server summary injection. Populated by bootMcpServers.
  // loadableSkillMeta: skill name → { description } for load_tools
  //   and compose's skill summary injection. Populated by registerSystemAgentTools.
  private readonly mcpServerMeta = new Map<string, { description: string; toolNames: string[] }>()
  private readonly loadableSkillMeta = new Map<string, { description: string }>()

  // ---------- registration ----------

  registerSystemTool(tool: SystemTool): void {
    this.systemTools.set(tool.name, tool)
  }

  registerMCP(server: string, tools: MCPTool[]): void {
    for (const tool of tools) {
      const key = mcpName(server, tool.name)
      this.mcpTools.set(key, tool)
    }
    this.mcpServers.set(server, tools.map(t => t.name))
  }

  registerSkill(skill: SkillDefinition): void {
    // v0.10.6: form:'text' skills are a programming error here — they must
    // go through registerTextSkill so they land in the textSkills store and
    // never appear as callable tools. We throw rather than silently route,
    // because a text skill registered as a tool would (a) be callable by the
    // LLM (defeating the pre-injection design) and (b) shadow any later
    // text-skill registration of the same name. Callers that legitimately
    // don't know the form (legacy code) omit `form` and default to 'module'.
    if (skill.form === 'text') {
      throw new Error(
        `registerSkill called with a text-form skill "${skill.name}"; use registerTextSkill instead`,
      )
    }
    this.skills.set(skill.name, skill)
  }

  // v0.10.6: register a pure-content text skill. The body is pre-injected
  // into the system prompt by compose (skillText part) — the skill is NOT
  // exposed as a callable tool. `whenToUse` is an optional hint prepended to
  // the body as a comment at injection time. Throws on name collision with
  // any existing text skill (duplicate registration is a startup wiring bug).
  registerTextSkill(name: string, body: string, whenToUse?: string): void {
    if (this.textSkills.has(name)) {
      throw new Error(`Duplicate text skill registration: "${name}"`)
    }
    // Also reject collision with the callable-tool buckets — a text skill
    // sharing a name with a system/MCP/module-skill tool would shadow it in
    // resolveRef (which checks textSkills last) and confuse compose. This
    // mirrors the loader-level collision checks but at registration time.
    if (this.systemTools.has(name) || this.skills.has(name)) {
      throw new Error(
        `Text skill name "${name}" collides with an existing tool (system or module skill)`,
      )
    }
    // MCP flat names are stored in mcpTools keyed by `${server}__${toolName}`.
    // The text-skill `name` is compared directly against those flat keys —
    // a text skill named 'srv__tool' collides with MCP tool 'tool' under
    // server 'srv' (flat name 'srv__tool'). We must NOT re-prefix with server
    // (that would produce 'srv__srv__tool' and miss the collision).
    if (this.mcpTools.has(name)) {
      throw new Error(
        `Text skill name "${name}" collides with MCP tool "${name}"`,
      )
    }
    const entry: StoredTextSkill = whenToUse === undefined
      ? { name, body }
      : { name, body, whenToUse }
    this.textSkills.set(name, entry)
  }

  // v0.10.6: expose stored text skills for compose / loop to inject. Returns
  // a snapshot array (never the live map) so callers can iterate without
  // worrying about concurrent mutation during startup wiring.
  getTextSkills(): readonly StoredTextSkill[] {
    return [...this.textSkills.values()]
  }

  // v0.10.6: text-skill name listing, parallel to listSkills. Used by the
  // text-loader's registry collision check so a later text-skill batch can
  // detect duplicates against already-registered text skills.
  listTextSkills(): string[] {
    return [...this.textSkills.keys()].sort()
  }

  // v0.10.6: single text-skill lookup. Used by the text-loader's collision
  // check (assertNoRegistryCollision) and by tests.
  getTextSkill(name: string): StoredTextSkill | undefined {
    return this.textSkills.get(name)
  }

  // v0.18: progressive tool disclosure metadata.
  // registerMCPServerMeta records server-level info (description + tool names)
  // populated by bootMcpServers after tools are registered. The description is
  // used by compose's server summary injection; toolNames by load_tools.
  registerMCPServerMeta(server: string, description: string, toolNames: string[]): void {
    this.mcpServerMeta.set(server, { description, toolNames: toolNames.slice().sort() })
  }

  getMCPServerMeta(server: string): { description: string; toolNames: string[] } | undefined {
    return this.mcpServerMeta.get(server)
  }

  listMCPServerMetas(): ReadonlyMap<string, { description: string; toolNames: string[] }> {
    return this.mcpServerMeta
  }

  // v0.18: loadable skill metadata for load_tools + compose's skill summary.
  // Populated by registerSystemAgentTools for each module-form skill.
  registerLoadableSkillMeta(name: string, description: string): void {
    this.loadableSkillMeta.set(name, { description })
  }

  getLoadableSkillMeta(name: string): { description: string } | undefined {
    return this.loadableSkillMeta.get(name)
  }

  listLoadableSkillMetas(): ReadonlyMap<string, { description: string }> {
    return this.loadableSkillMeta
  }

  // v0.10.5: register a security hook invoked before every MCP/skill execute.
  // Hooks run in registration order; the first Error return blocks the call.
  registerSecurityHook(fn: SecurityHook): void {
    this.securityHooks.push(fn)
  }

  // ---------- security doors (v0.20, hook morphology) ----------
  //
  // v0.16→v0.20: the standalone SecurityRouter class is dissolved. Its two
  // pieces of state (doors array + sessions map) and its three behaviors
  // (check / releaseTool / session lifecycle) now live directly on the
  // registry, executed at the systemSecurityHooks position inside execute().
  // deny-override semantics are preserved: every registered door runs until
  // one rejects; the first rejection throws (short-circuit) after all
  // earlier doors already ran. check-release pairing is preserved: execute()
  // releases door slots in finally blocks (see execute below).

  /** Register a door. Doors run in registration order; first reject wins. */
  registerDoor(door: SecurityDoor): void {
    this.securityDoors.push(door)
  }

  /**
   * Explicitly create a session. Throws if the sessionId already exists —
   * use this when a caller wants to pre-seed state without ambiguity
   * (e.g. fullPermission pre-seeding in e2e-security-verification).
   */
  createSession(sessionId: SessionId, opts?: { fullPermission?: boolean }): SessionSecurityState {
    if (this.securitySessions.has(sessionId)) {
      throw new Error(`ToolRegistry: security session "${sessionId}" already exists`)
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
    this.securitySessions.set(sessionId, state)
    return state
  }

  /** Look up an existing session, lazily creating a default one if missing. */
  getOrCreateSession(sessionId: SessionId | undefined): SessionSecurityState {
    const id = sessionId ?? GLOBAL_SESSION
    let state = this.securitySessions.get(id)
    if (!state) {
      state = { sessionId: id, approvalStore: new ApprovalStore(), fullPermission: false }
      this.securitySessions.set(id, state)
    }
    return state
  }

  /** Look up an existing session. Returns undefined if the session does not exist. */
  getSession(sessionId: SessionId | undefined): SessionSecurityState | undefined {
    return this.securitySessions.get(sessionId ?? GLOBAL_SESSION)
  }

  /** Delete a session and its approval store. No-op if the session does not exist. */
  deleteSession(sessionId: SessionId): boolean {
    return this.securitySessions.delete(sessionId)
  }

  /**
   * Run all doors against this tool call. Resolves when every door allows;
   * throws the first rejection. Full-permission sessions bypass all doors.
   * The throw message is surfaced to the LLM (consistent with the v0.15 hook
   * behavior — the LLM needs to know why it was blocked).
   */
  async checkDoors(
    sessionId: SessionId,
    state: SessionSecurityState,
    toolName: string,
    args: unknown,
    ctx: ToolContext,
  ): Promise<void> {
    // Full-permission sessions bypass all security doors.
    if (state.fullPermission) return
    for (const door of this.securityDoors) {
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
   * Called by execute() in finally blocks. A release failure on one door must
   * not prevent other doors from releasing their slots.
   */
  releaseTool(sessionId: SessionId | undefined, toolName: string): void {
    for (const door of this.securityDoors) {
      try {
        door.release?.(sessionId ?? GLOBAL_SESSION, toolName)
      } catch {
        // swallow: release must be best-effort across all doors
      }
    }
  }

  // ---------- lookup ----------

  getSystemTool(name: string): SystemTool | undefined {
    return this.systemTools.get(name)
  }

  getMCPTool(server: string, name: string): MCPTool | undefined {
    return this.mcpTools.get(mcpName(server, name))
  }

  getSkill(name: string): SkillDefinition | undefined {
    return this.skills.get(name)
  }

  // v0.10.5: single classifier for executeToolCalls' per-category batching.
  // Mirrors execute's dispatch order (system → mcp → skill) so the category
  // reported here always matches the tool that execute() will actually run.
  // Unknown / unregistered names default to 'command' (the conservative cap).
  getToolCategory(name: string): ToolCategory {
    const sys = this.systemTools.get(name)
    if (sys) return sys.category ?? 'command'
    const mcp = this.mcpTools.get(name)
    if (mcp) return mcp.category ?? 'command'
    const skill = this.skills.get(name)
    if (skill) return skill.category ?? 'command'
    return 'command'
  }

  // ---------- enumeration ----------

  listSystemTools(): string[] {
    return [...this.systemTools.keys()].sort()
  }

  listMCPServers(): string[] {
    return [...this.mcpServers.keys()].sort()
  }

  listMCPTools(server: string): string[] {
    return (this.mcpServers.get(server) ?? []).slice().sort()
  }

  listSkills(): string[] {
    return [...this.skills.keys()].sort()
  }

  // ---------- ref source classification ----------
  //
  // resolveRef is the single classifier that maps a flat tool name to its
  // source (system / mcp / skill / textSkill). It is the basis for sub-agent
  // toolRef routing in system-agent.ts and existence checking in config.ts.
  //
  // ORDER COUPLING (CRITICAL): the lookup order for the three tool_call
  // buckets (systemTools → mcpTools → skills) MUST stay identical to
  // `execute`'s dispatch order (first hit wins). If anyone changes execute's
  // lookup order, this method must change in lockstep — otherwise sub-agent
  // routing and runtime dispatch would disagree on which executor handles a
  // shadowed name. The two are bound by design (v0.13 D6): resolveRef is the
  // declarative mirror of execute's imperative lookup.
  //
  // v0.10.6: textSkills are checked LAST and return { kind: 'textSkill' }.
  // This does NOT participate in execute's dispatch (execute never reaches
  // textSkills — they are pre-injected, not callable), but resolveRef still
  // reports them so config.ts can accept a text-skill ref as valid. Placing
  // the text-skill check last keeps the tool_call ordering intact (a name
  // shadowed between a tool and a text skill resolves to the tool, matching
  // execute's behavior).
  resolveRef(name: string): RefSource | undefined {
    if (this.systemTools.has(name)) return { kind: 'system' }
    if (this.mcpTools.has(name)) {
      // Recover the server from the mcpServers map rather than splitting the
      // flat name (a tool name may itself contain '__'). Walk the servers and
      // return the first whose registered tool list produces this flat name.
      for (const [server, tools] of this.mcpServers) {
        if (tools.some((t) => mcpName(server, t) === name)) {
          return { kind: 'mcp', server }
        }
      }
      // mcpTools has the key but mcpServers has no matching entry — should be
      // unreachable given registerMCP writes both atomically; fall back to the
      // first '__'-split segment as a best-effort server name.
      const sep = name.indexOf('__')
      return { kind: 'mcp', server: sep === -1 ? name : name.slice(0, sep) }
    }
    if (this.skills.has(name)) return { kind: 'skill' }
    if (this.textSkills.has(name)) return { kind: 'textSkill' }
    return undefined
  }

  // ---------- executor dispatch ----------

  async execute(name: string, args: unknown, ctx?: ToolContext): Promise<unknown> {
    // Tool schemas are advisory: a model can forge a tool call by name.
    // Enforce the loop's effective toolRefs before SecurityDoor so an
    // unauthorized sub-agent call cannot trigger approval or side effects.
    if (ctx?.allowedToolRefs !== undefined && !ctx.allowedToolRefs.includes(name)) {
      throw new Error('Tool "' + name + '" is not available to this agent')
    }

    // v0.16 (Q3-B), v0.20 hook morphology: every tool source — system, MCP,
    // skill — passes through the security doors, now executed directly by the
    // registry (the standalone SecurityRouter is dissolved). Doors dispatch on
    // the tool name and may be registered for any source; this is not
    // system-tool-specific. Doors currently only gate system tools by name, so
    // MCP/skill calls that no door matches are allowed (pass-through) — the
    // architecture is what matters here, not an existing blocking rule.
    //
    // Doors may reserve concurrency slots during check() (e.g. the browser-tools
    // door adds the session to its in-flight set). If a later door rejects and
    // checkDoors() throws, those reservations must still be released — hence
    // the try/catch + releaseTool + rethrow below.
    const sessionState = this.getOrCreateSession(ctx?.sessionId)
    try {
      await this.checkDoors(ctx?.sessionId ?? GLOBAL_SESSION, sessionState, name, args, ctx ?? {})
    } catch (e) {
      this.releaseTool(ctx?.sessionId, name)
      throw e
    }

    // Expose the session's approval store on ctx so tools can check full-permission
    // grants (e.g., bash timeout extension). The session is guaranteed to exist
    // (getOrCreateSession above).
    if (ctx) {
      ctx.approvalStore = sessionState.approvalStore
    }

    const sysTool = this.systemTools.get(name)
    if (sysTool) {
      // System tools are already wrapped at registration time (wrapTool:
      // requireReason + re-throw on error). Do NOT double-wrap — that would
      // re-run requireReason on an already-validated call and mask the
      // wrapped error sentence with a second formatting pass.
      try {
        return await sysTool.execute(args, ctx)
      } finally {
        this.releaseTool(ctx?.sessionId, name)
      }
    }

    const mcpTool = this.mcpTools.get(name)
    if (mcpTool) {
      try {
        return await this.executeGuarded(name, mcpTool, args, ctx)
      } finally {
        this.releaseTool(ctx?.sessionId, name)
      }
    }

    const skill = this.skills.get(name)
    if (skill) {
      try {
        return await this.executeGuarded(name, skill, args, ctx)
      } finally {
        this.releaseTool(ctx?.sessionId, name)
      }
    }

    throw new Error(`Tool not registered: ${name}`)
  }

  // v0.10.5: shared guard for MCP and skill tools. System tools skip this
  // (they have wrapTool). The guard applies, in order:
  //   1. security hooks (may block by returning an Error)
  //   2. reason validation (MCP/skill schemas inject `reason` via compose.ts)
  //   3. execute, with errors wrapped as `Tool "X" failed: <clean msg>`
  // 结果不截断（2026-09-12 用户拍板：未经同意不允许任何信息截断机制）——
  // 超大结果原样进 canonical，由 fold hook（history-tool-table）按拍板的
  // 保头保尾机制收敛。
  // The wrapped error sentence matches loop.ts' system-tool formatting, so
  // the LLM sees a uniform error shape regardless of tool source.
  private async executeGuarded(
    name: string,
    tool: { execute: ToolExecutor },
    args: unknown,
    ctx: ToolContext | undefined,
  ): Promise<unknown> {
    for (const hook of this.securityHooks) {
      const r = hook(args, ctx, name)
      if (r instanceof Error) throw r
    }
    // requireReason throws on missing/empty/non-string reason; compose.ts
    // injects the `reason` field into every MCP/skill schema so the LLM is
    // contractually asked to supply it.
    requireReason((args ?? {}) as { reason?: unknown }, name)
    try {
      return await tool.execute(args, ctx)
    } catch (e) {
      throw new Error(`Tool "${name}" failed: ${cleanErrorMessage(e)}`)
    }
  }

  // ---------- schema export for OpenAI native format ----------

  // Returns the unified `tools` array ready to be placed in a chat.completions request.
  // Tools are listed in order: systemTools, mcpTools (server, then name), skills.
  toOpenAIToolSchemas(): {
    type: 'function'
    function: { name: string; description: string; parameters: JSONSchema }
  }[] {
    const schemas: {
      type: 'function'
      function: { name: string; description: string; parameters: JSONSchema }
    }[] = []

    for (const name of this.listSystemTools()) {
      const tool = this.systemTools.get(name)!
      schemas.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })
    }

    for (const server of this.listMCPServers()) {
      for (const toolName of this.listMCPTools(server)) {
        const tool = this.mcpTools.get(mcpName(server, toolName))!
        schemas.push({
          type: 'function',
          function: {
            name: mcpName(server, tool.name),
            description: tool.description,
            parameters: tool.parameters,
          },
        })
      }
    }

    for (const name of this.listSkills()) {
      const skill = this.skills.get(name)!
      schemas.push({
        type: 'function',
        function: {
          name: skill.name,
          description: skill.description,
          // Skills take arbitrary args; we keep the schema open by default.
          parameters: skill.parameters ?? emptyParameters(),
        },
      })
    }

    return schemas
  }
}
