# ADR-018: MCP / Skill 扩展系统 (v0.13)

**Status**: Active (2026-08-31)

**Context**: ADR-016 §11 recorded the v0.10 state of the world: "mcp / skill surface is **not expanded into a plugin ecosystem** — the registration mechanism exists; the ecosystem does not." That was an accurate description of v0.10–v0.12: `ToolRegistry.registerMCP` / `registerSkill` existed, `PromptPart('mcp'/'skill')` and `IMLoopOptions.mcpRefs/skillRefs` were wired through compose + loop, but there was no way to *connect* an MCP server, no way to *load* a skill module, and sub-agents were blanket-denied MCP/skill refs (v0.12.2 one-shot rejection in config.ts). The mechanism was present; the ecosystem was absent.

On 2026-08-31 the user made four decisions that collectively overturn that position:

1. **Transport**: implement both **stdio + HTTP** (protocol surface limited to the tools subset: initialize / tools/list / tools/call — resources/prompts/sampling deferred).
2. **SDK**: adopt the official **`@modelcontextprotocol/sdk`**, but confine every SDK import to `src/mcp/**` so the SDK stays a replaceable battery behind a narrow interface.
3. **Skill form**: skills are **JS/TS modules** (one file, `export SkillDefinition`), not SKILL.md text.
4. **Sub-agent access**: sub-agents reach MCP/skill tools **through policy** (`SubAgentToolPolicy` namespace rules), not through a kind-based blanket ban.

This ADR records those decisions and their consequences.

---

## Decision

### 1. stdio + HTTP dual transport

`McpServerConfig` is a discriminated union (`transport: 'stdio' | 'http'`). stdio spawns a subprocess via `StdioClientTransport`; HTTP uses `StreamableHTTPClientTransport` against a URL. Both carry `timeoutMs` as the SDK per-request timeout. stdio subprocess env is the SDK's safe default (`getDefaultEnvironment`) plus explicit `cfg.env` overrides — `process.env` is never passed wholesale (constraint 8: no secret leakage into spawned servers).

### 2. SDK isolation behind `McpConnection`

`src/mcp/connection.ts` is the **only** file that imports `@modelcontextprotocol/sdk`. Everything outside `src/mcp/` sees the three-method narrow interface:

```ts
type McpConnection = {
  readonly serverName: string
  listTools(): Promise<{ name; description?; inputSchema }[]>
  callTool(name, args): Promise<string>   // D2: text blocks joined with \n; isError → throw
  close(): Promise<void>
}
```

`callTool` returns a `string` (D2): text content blocks are joined with `\n`; an `isError: true` result throws; empty content falls back to `JSON.stringify(result)`. The LLM-facing surface only ever sees strings or thrown errors — loop.ts's existing error wrapping takes it from there. Swapping or removing the SDK means editing `connection.ts` alone; boot.ts, registry, im, skills, and extensions are SDK-free.

### 3. JS/TS module skills

`loadSkillsFromDir(dir, { registry? })` scans direct files (`.ts/.js/.mts/.mjs`), dynamically imports each, takes the `default` export (falling back to a named `skill` export), validates per D5 (name `[a-zA-Z0-9_-]{1,64}`, non-empty description, callable `execute`, optional `type:'object'` parameters schema), and rejects name collisions against the batch and (when a registry is supplied) against the registry's existing flat names across all three buckets. The loader returns definitions; it does **not** register them — registration is the caller's job (`extensions.ts`). `.ts`/`.mts` skills require a TS-capable runtime (tsx, vitest's vite pipeline, ts-node); plain `node` runs only `.js`/`.mjs`. This is a known constraint of dynamic `import()`, documented in the loader, not worked around.

### 4. Sub-agent access via policy (D7 — behavior change)

The v0.12.2 blanket rejection of MCP/skill refs in `validateSubAgentConfig` is **removed**. Permission is now decided solely by `applyToolPolicy` (single-layer enforcement — config.ts is the only check; run-subagent.ts and system-agent.ts do not re-check). Unknown refs (resolving to nothing via `registry.resolveRef`) are still rejected so typos surface at load time. `DEFAULT_SUB_AGENT_TOOL_POLICY` (`default: 'allow'`) means sub-agents **can** use MCP/skill tools by default; callers tighten the surface with deny rules (e.g. `other__*`). This overturns v0.12.2's "system-tools-only" default.

### 5. `resolveRef` — single classifier

`registry.resolveRef(name): RefSource | undefined` is the only "flat name → source" classifier. Its lookup order mirrors `execute`'s dispatch (system → mcp → skill, first hit wins). `system-agent.ts` uses it to route `toolRefs` into `systemToolRefs` / `mcpRefs` / `skillRefs`; `config.ts` uses it for existence checking. One fact, no second copy.

### 6. One-shot bootstrap, zero hot-plug

`bootstrapExtensions({ registry, mcpServers?, skillsDir? })` assembles MCP servers then skills in one call (order matters: MCP first so skill-vs-MCP collision detection works). Fail-fast continues at the composition layer — a skill-stage throw closes already-opened MCP connections. `close()` is idempotent. Registration remains startup-time only (registry.ts:6); v0.13 does not introduce runtime add/remove.

---

## Explicit supersession of ADR-016 §11

**This ADR overturns ADR-016 §11** ("mcp / skill surface is not expanded into a plugin ecosystem — the registration mechanism exists; the ecosystem does not") and the matching line in ADR-016 §0 ("No mcp / skill ecosystem expansion. The mechanism exists; the ecosystem does not."). The user decision on 2026-08-31 is that the ecosystem now exists: real MCP servers connect, real skill modules load, and sub-agents reach both via policy.

**ADR-016 itself is not retroactively edited.** ADR-016 remains the record of the v0.10 design intent; ADR-018 is the record that v0.13 changed one clause of it. Supersession is forward-only — readers see both the original constraint and its overturn.

---

## Consequences

**Positive**

- **Real ecosystem接入**: any stdio/HTTP MCP server and any JS/TS skill module can now populate the ToolRegistry at startup. The agent is no longer limited to the built-in system tools.
- **Policy-facing prefix governance**: `SubAgentToolPolicy` glob rules (`server__*`, exact names) give callers a declarative, namespace-aware way to tighten the sub-agent surface without touching kind-based code. Single-layer enforcement keeps the permission model auditable.
- **SDK replaceability**: because the SDK lives behind `McpConnection`, a future swap (hand-written protocol, alternate SDK version) is a one-file change. Tests outside `src/mcp/` use plain-object fakes and never import the SDK.
- **Tree + MCP orthogonality**: sub-agent tree semantics (AgentTree, familyDatabus) and MCP tool semantics are independent — a sub-agent's MCP tool turn projects onto its node bus exactly like a system-tool turn (verified in `tests/im/sub-agent/mcp-pentest.test.ts`).

**Negative**

- **SDK transitive dependency**: `@modelcontextprotocol/sdk@1.30.0` (and its transitive `zod`) is now a runtime dependency. Pinning is via `package.json` `"^1.30.0"`; a future SDK major bump could require `connection.ts` changes.
- **`.ts` skills need a TS runtime**: plain `node` cannot execute `.ts`/`.mts` skill files. Hosts that load `.ts` skills must run under tsx / ts-node / vitest. `.js`/`.mjs` skills have no such requirement.
- **Sub-agent default surface widened**: `default: 'allow'` means a sub-agent can reach every registered MCP/skill tool unless the caller explicitly denies. This is the correct default for ergonomics, but production deployments that want a closed surface must supply a `default: 'deny'` policy with explicit allow rules — the framework does not guess.
- **stdio subprocess surface**: booting a stdio MCP server spawns a child process with a controlled env. Hosts are responsible for the commands they configure; the framework only guarantees `process.env` is not leaked wholesale (D4).

---

**Last updated**: 2026-08-31 (v0.13 Batch 3 landed: extensions.ts + tests + example + this ADR)
