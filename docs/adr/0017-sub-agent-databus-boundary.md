# ADR-017: Sub-agent Databus boundary and security hardening (v0.11)

**Status**: Active (2026-08-29; supersedes the `ToolContext.sharedDatabus` design sketched in the v0.11 plan pre-audit)

**Context**: v0.11 introduced user-defined sub-agents (`define_subagent` + `run_subagent`) on top of the v0.10 information-flow architecture (ADR-016). The first implementation landed a `ToolContext.sharedDatabus` field and dual-bus merge logic inside `databus_query` / `databus_subscribe` — treating "shared bus" as a tool-level concern. That approach violated ADR-016's principle that tools read one bus and the loop decides which bus, and it left eight security boundaries unenforced. This ADR records the corrected two-bus architecture (`ctxDatabus` + `MultiDatabus`) and the P2.1–P2.8 hardening that closes those boundaries.

**This ADR is the implementation contract for v0.11.1.**

---

## 0. One-sentence summary

A sub-agent writes its tool-turn projections to a single shared `Databus` and reads a `MultiDatabus` merged view of `[sharedDatabus, workingDatabus]` through `IMLoopOptions.ctxDatabus` — never through a `ToolContext` field — and eight security boundaries (path safety, tool permissions, recursion depth, config clamping, reserved senders, mailbox capacity, atomic writes, register re-validation) enforce that sub-agents are strictly more constrained than the working agent.

---

## 1. Why two buses (projection vs context)

ADR-016 §2.1 defines the Databus as an append-only, cross-agent-readable projection of `role: 'tool'` turns. Each `runIMLoop` instance owns one private Databus that receives its own tool-turn projections. Sub-agents introduce a second need: a sub-agent must **read** the working agent's tool events (to understand the context it was spawned into) without **writing** to the working agent's private bus.

| Bus | Owner | Who writes | Who reads | Lifetime |
|---|---|---|---|---|
| **Private bus** (`opts.databus`) | The working agent's `runIMLoop` | The working agent's tool loop | The working agent's tools (via `ctx.databus`) | session-scoped |
| **Shared bus** (`subAgentRegistry.sharedDatabus`) | `SubAgentRegistry` | All sub-agents (via `createSystemAgent({ databus: sharedDatabus })`) | Sub-agents' tools + the working agent's tools (via `ctxDatabus`) | session-scoped |

The working agent's private bus is the **projection** surface: the working agent writes there, and ADR-016's system agents (warehouse / compressor / recall) query it. The shared bus is the **context** surface: sub-agents write there so they can see each other, and the working agent reads it to monitor sub-agent activity. These are structurally different roles and must not be collapsed into one bus.

---

## 2. Why `MultiDatabus` instead of `ToolContext.sharedDatabus`

### 2.1 The rejected design

The pre-audit v0.11 implementation added a `sharedDatabus?: Databus` field to `ToolContext` and made `databus_query` / `databus_subscribe` merge `ctx.databus` + `ctx.sharedDatabus` internally. This had three problems:

1. **Tools became bus-aware.** `databus_query` had to know that two buses exist and how to merge them — violating ADR-016's invariant that "tools read one bus; the loop decides which one."
2. **No array support.** A sub-agent needs to read *both* the shared bus and the working agent's bus. A single `sharedDatabus` field can only carry one extra bus, forcing an either/or choice.
3. **Merge logic duplicated.** Every read-side tool (`databus_query`, `databus_subscribe`) independently implemented dedup + sort, which is a maintenance hazard.

### 2.2 The accepted design

`MultiDatabus` (src/im/multi-databus.ts) is a **read-only merged view** over a `readonly Databus[]`. It implements the read-side Databus API (`turns`, `query`, `subscribe`, `evictByIds`) but **not** the write side (`append`, `last`, `clear`) — writes always go to a single concrete Databus.

The merge logic lives in one place: `dedupeAndSort` deduplicates by `turn.id` and sorts by `at` ascending (ties broken by `id` for determinism). `query` applies `limit` *after* the global sort, so a limit sees the freshest turns across all buses, not per-bus.

The loop resolves the contextual bus at `loop.ts:329-344`:

```ts
let ctxDatabus: Databus | MultiDatabus | undefined
if (opts.ctxDatabus === undefined) {
  ctxDatabus = undefined
} else if (Array.isArray(opts.ctxDatabus)) {
  ctxDatabus = new MultiDatabus(opts.ctxDatabus)
} else {
  ctxDatabus = opts.ctxDatabus as Databus
}
const ctx: ToolContext = {
  ...
  databus: ctxDatabus ?? opts.databus,
  subAgentDepth: opts.subAgentDepth ?? 0,
}
```

Tools still see `ctx.databus` — a single Databus-compatible object. They never know whether it is a concrete `Databus` or a `MultiDatabus`. The loop owns the decision; tools stay bus-blind.

### 2.3 Why `ctxDatabus` is on `IMLoopOptions`, not `ToolContext`

`IMLoopOptions.ctxDatabus` is a **loop-construction-time** decision: the caller (working agent harness, `run_subagent`, `createSystemAgent`) decides which buses this loop's tools should see. `ToolContext` is a **per-tool-call** value object passed into `execute(name, args, ctx)`. Putting a bus-selection field on `ToolContext` conflates "what the loop decided at construction" with "what a single tool call receives," and it invites tools to override the loop's decision. By keeping the field on `IMLoopOptions` and resolving it to `ctx.databus` once, the architecture preserves ADR-016's separation: the loop decides, the tool reads.

---

## 3. The two-Databus boundary (D8–D12, locked)

### 3.1 Working agent

```ts
// Working agent's loop (loop.ts)
ctxDatabus: [mainDatabus, subAgentRegistry.sharedDatabus]
// → MultiDatabus merges the working agent's own bus with the sub-agents' shared bus
// → working agent's tools see both its own projections and sub-agent activity
```

The working agent writes to `mainDatabus` (its private bus). Its tools read the merged view, so the working agent can monitor what its sub-agents are doing without losing its own tool history.

### 3.2 Sub-agent

```ts
// run-subagent.ts:87,91
databus: subAgentRegistry.sharedDatabus,                          // write target
sharedDatabus: [subAgentRegistry.sharedDatabus, workingDatabus],  // read context (array → MultiDatabus)
```

A sub-agent **writes** its tool-turn projections to the shared bus (`databus: subAgentRegistry.sharedDatabus`). It **reads** a MultiDatabus view of `[sharedDatabus, workingDatabus]` — so it sees both its own (and sibling sub-agents') activity and the working agent's tool events (read-only).

### 3.3 System agents (ADR-016's three)

The three ADR-016 system agents (warehouse / compressor / recall) do **not** touch the sub-agent bus boundary. They are created via `createSystemAgents(deps)` without `sharedDatabus`, so their `ctxDatabus` is undefined and their tools read only their own private bus. They interact with the working agent through `databus_query` / `state_query` / `mailbox_send` — the same ADR-016 surface. Sub-agents are a v0.11 concern; ADR-016's system agents remain on the main chain.

### 3.4 Information-flow diagram

```
                    ┌─────────────────────────────────────────────────┐
                    │             Working agent (depth 0)              │
                    │  writes → mainDatabus (private)                  │
                    │  reads  → MultiDatabus([mainDatabus, sharedBus]) │
                    │           via ctxDatabus                         │
                    └───────────────┬─────────────────────────────────┘
                                    │ run_subagent (depth 0 → 1)
                                    ▼
              ┌─────────────────────────────────────────────────────┐
              │              Sub-agent (depth 1)                     │
              │  writes → sharedBus (subAgentRegistry.sharedDatabus) │
              │  reads  → MultiDatabus([sharedBus, mainDatabus])     │
              │           via ctxDatabus (read-only on mainDatabus)  │
              └─────────────────────────────────────────────────────┘
                                    │ run_subagent (depth 1 → 2)  [if allowed]
                                    ▼
                            (depth 2 sub-agent, same pattern)
                                    │ run_subagent (depth 2 → 3)  [if allowed]
                                    ▼
                            (depth 3 sub-agent — cannot spawn further)

  ADR-016 system agents (warehouse/compressor/recall):
    created without sharedDatabus → ctxDatabus = undefined → read own private bus only
    interact with working agent via databus_query / state_query / mailbox_send
```

---

## 4. Security hardening (P2.1–P2.8)

The sub-agent boundary is a trust boundary: a sub-agent is LLM-controlled code that runs tools. Without hardening, a sub-agent could escape its scope via path traversal, privileged tools, unbounded recursion, oversized config, sender spoofing, or mailbox flooding. The following eight boundaries are enforced at the points indicated.

| # | Boundary | Enforcement point | Key constants / rules |
|---|---|---|---|
| **P2.1** | Path-safe agent names | `isSafeAgentName` in config.ts:25-35 | `^[a-zA-Z0-9_-]{1,64}$` + Windows `RESERVED_NAMES` (CON/PRN/AUX/NUL/COM*/LPT*) checked case-insensitively |
| **P2.2** | Tool permissions | `validateSubAgentConfig` in config.ts:100-160 | `SUB_AGENT_FORBIDDEN_TOOLS` = {run_subagent, define_subagent, record_curated_block, record_m3_summary} — always rejected; `SUB_AGENT_PRIVILEGED_TOOLS` = {bash, powershell, write, edit} — rejected unless `allowPrivilegedTools=true` |
| **P2.3** | Recursion depth | `run-subagent.ts:67-73` + `ToolContext.subAgentDepth` | `MAX_SUB_AGENT_DEPTH = 3`; working agent = depth 0; each `run_subagent` increments by 1; throws at `depth >= 3` |
| **P2.4** | Config clamping | `validateShellConfigOverrides` in config.ts:66-92 | Fields: maxTokens, maxSteps, maxToolCalls, maxElapsedMs, maxConsecutiveToolErrors; each must be a positive integer ≤ `DEFAULT_CONFIG[field]` (sub-agents can only be more constrained); unknown keys rejected |
| **P2.5** | Reserved senders | `Mailbox.send` in mailbox.ts:20-25 | `RESERVED_SENDERS` = {databus, system, drive-coordinator}; `send()` rejects; `systemSend()` bypasses (framework-internal only, used by drive-coordinator) |
| **P2.6** | Mailbox capacity | `Mailbox.deliver` in mailbox.ts:34-65 | `MAX_INBOX_SIZE = 1000` (per-recipient, checked before push); `MAX_BODY_LENGTH = 10_000` (checked at top of deliver); both apply to `send` and `systemSend` |
| **P2.7** | Atomic writes | `SubAgentRegistry.writeToDisk` in registry.ts:100-116 | tmp file (`${path}.tmp-${ts}-${rand}`) + `rename(tmp, path)` from `node:fs/promises`; on failure, in-memory entry deleted + warning logged |
| **P2.8** | Register re-validation | `SubAgentRegistry.register` in registry.ts:34-56 | Constructor accepts optional `ToolRegistry`; when present, `register()` calls `validateSubAgentConfig` before storing; when absent, trusts caller (backward compat). `loadFromDisk` validates every loaded file. `define_subagent` validates before calling `register`. |

### 4.1 The send / systemSend split (P2.5 detail)

`Mailbox.send()` is the **LLM-facing** path: it enforces `RESERVED_SENDERS` so a sub-agent cannot spoof `from: 'system'` or `from: 'drive-coordinator'`. `Mailbox.systemSend()` is the **framework-internal** path: it bypasses the reserved-sender check because the drive coordinator and databus_subscribe callback genuinely need to send from those identities. Both route through the private `deliver()` method, so capacity limits (P2.6) apply universally. `systemSend` is not exposed to tools — it is only called by `drive-coordinator.ts` and the `databus_subscribe` event bridge.

### 4.2 Why sub-agents are strictly more constrained (P2.4 rationale)

`validateShellConfigOverrides` rejects any config value that exceeds `DEFAULT_CONFIG`. A sub-agent's `maxTokens` can be *lower* than 1,000,000 but never higher; its `maxSteps` can be *lower* than 200 but never higher. This guarantees a sub-agent cannot escalate its resource budget beyond the working agent's defaults — it can only accept a tighter constraint. Unknown config keys are rejected outright (no silent ignoring), so a sub-agent cannot smuggle in a field that bypasses validation.

---

## 5. Invariants (the contract this ADR enforces)

1. **Two buses, not one.** The private bus (projection) and the shared bus (context) are structurally distinct. Sub-agents write to the shared bus; the working agent writes to its private bus. Neither is collapsed into the other.
2. **Tools read one bus.** `ToolContext.databus` is a single Databus-compatible object. The loop decides whether it is a concrete `Databus` or a `MultiDatabus`; tools never branch on bus type. There is no `ToolContext.sharedDatabus` field.
3. **`ctxDatabus` is loop-scoped.** The contextual bus is set on `IMLoopOptions`, resolved once into `ctx.databus`, and never overridden by individual tools.
4. **`MultiDatabus` is read-only.** It implements `turns` / `query` / `subscribe` / `evictByIds` but not `append` / `last` / `clear`. Writes always target a single concrete `Databus`.
5. **Sub-agents are strictly more constrained.** P2.1–P2.8 ensure a sub-agent cannot escalate permissions, recurse unboundedly, exceed the working agent's config defaults, spoof system senders, flood mailboxes, or persist corrupt configs.
6. **System agents stay on the main chain.** ADR-016's three system agents are created without `sharedDatabus` and do not touch the sub-agent bus boundary. Sub-agents are a v0.11 concern layered on top of ADR-016.
7. **Recursion is bounded.** `MAX_SUB_AGENT_DEPTH = 3`. The working agent is depth 0; a sub-agent launched by the working agent is depth 1; a sub-agent launched by that sub-agent is depth 2; depth 3 is the last allowed level. `run_subagent` throws at `depth >= 3`.

---

## 6. What this ADR explicitly does NOT do

- **No cross-session sub-agent persistence beyond config files.** Sub-agent configs are persisted as JSON (P2.7 atomic writes), but the shared Databus is in-memory and session-scoped — same as ADR-016 §4.1.
- **No sub-agent metric aggregation.** Sub-agent metrics are returned from `runIMLoop` but not yet aggregated into the working agent's metrics. That is deferred to v0.11+ production hardening.
- **No multi-tenant sub-agent quotas.** P2.6 enforces a per-inbox capacity, but there is no per-*agent* sub-agent spawn quota. Deferred.
- **No `MultiDatabus` write API.** `MultiDatabus` will never gain `append`. If a future feature needs to write to multiple buses, it writes to each concrete bus individually.

---

## 7. Consequence (implementation status)

**v0.11** (commit `5d6ca8e`): landed `define_subagent` + `run_subagent` + `SubAgentRegistry` + `ToolContext.sharedDatabus` (the rejected design). Audit (plan §8) found 7 violations (V1–V7).

**v0.11.1** (commit `6af1805` + P0/P2 hardening): this ADR's architecture is implemented:
- `src/im/multi-databus.ts` NEW: read-only merged view, `dedupeAndSort`, no write API.
- `src/im/loop.ts` MODIFIED: `IMLoopOptions.ctxDatabus: Databus | readonly Databus[]` (line 104); array wrapped in `MultiDatabus` at lines 329-344; `ctx.databus = ctxDatabus ?? opts.databus` (line 342).
- `src/im/system-agent.ts` MODIFIED: `sharedDatabus?: Databus | readonly Databus[]` opt (line 73); wired to `loopOpts.ctxDatabus` at line 159.
- `src/im/tools/run-subagent.ts` MODIFIED: `MAX_SUB_AGENT_DEPTH = 3` (line 22); depth guard (lines 67-73); `sharedDatabus: [subAgentRegistry.sharedDatabus, deps.workingDatabus]` (line 91); `subAgentDepth: currentDepth + 1` (line 94).
- `src/shared/tool-context.ts` MODIFIED: `sharedDatabus` field removed; `databus?: unknown` + `subAgentDepth?: number` only.
- `src/im/sub-agent/config.ts` MODIFIED: `isSafeAgentName`, `RESERVED_NAMES`, `SUB_AGENT_FORBIDDEN_TOOLS`, `SUB_AGENT_PRIVILEGED_TOOLS`, `validateShellConfigOverrides`, `validateSubAgentConfig`.
- `src/im/sub-agent/registry.ts` MODIFIED: constructor accepts optional `ToolRegistry`; `register()` re-validates; `writeToDisk` uses tmp + rename; `loadFromDisk` validates every file.
- `src/im/mailbox/mailbox.ts` MODIFIED: `RESERVED_SENDERS`, `send()` / `systemSend()` split, `MAX_INBOX_SIZE` / `MAX_BODY_LENGTH` in `deliver()`.
- `src/im/tools/define-subagent.ts` MODIFIED: validates with registry before `register()`.
- Tests: 57 files / 525 tests green, 0 tsc errors. 24 penetration tests exercise the full tool execution chain (define_subagent, mailbox_send, run_subagent) not just isolated validators.

---

**Last updated**: 2026-08-30 v0.11.2 (G1-G4 + S2-S4 remediation; 562 tests green, 0 tsc errors; real-LLM adapter + monitor verified)
**Next update**: v0.11+ production hardening (sub-agent metric aggregation, multi-tenant quotas, disk persistence hardening)

---

## 8. v0.11.2 Remediation (2026-08-30)

v0.11.1 passed tsc + vitest but had 4 implementation gaps (G1-G4) and 3 structural issues (S2-S4) found in deep review. v0.11.2 closes them:

| ID | Fix | Status |
|---|---|---|
| **G1** | `tests/im/loop-run-subagent.test.ts` — real working-agent `runIMLoop` → `run_subagent` tool_call → sub-agent loop → tool result → final answer. ScriptedLLM pattern (no network). | [已验证] |
| **G2** | `RESERVED_AGENT_NAMES` (7 names) checked in `isSafeAgentName` — reserved names blocked at sub-agent config source, not just mailbox layer. | [已验证] |
| **G3** | `createMinimalIM` passes `driveCoordinator` through to `IMLoopOptions` (caller constructs; `createNoopDriveCoordinator` for harness). | [已验证] |
| **G4** | `src/im/sub-agent/policy.ts` — `SubAgentToolPolicy` declarative permission system (`default` + `rules` + single `*` wildcard, last-match-wins). Replaces hardcoded `SUB_AGENT_FORBIDDEN_TOOLS` / `SUB_AGENT_PRIVILEGED_TOOLS`. `config.ts` + `define-subagent.ts` use `applyToolPolicy`. | [已验证] |
| **S2** | `loop.ts` single-element `ctxDatabus` array uses concrete `Databus` directly (no `MultiDatabus` wrap); `minimal.ts` doesn't set `ctxDatabus` when only own bus present. | [已验证] |
| **S3** | `registry.ts` `register()` returns `Promise<void>` (awaits disk write, no auto-rollback); `define-subagent.ts` + all callers `await`. | [已验证] |
| **S4** | pentest P2.3 comment clarifies it's a depth-check logic contract test, points to G1 test as real E2E. | [已验证] |

**Real-LLM integration** (user-requested, beyond plan scope):
- `examples/real-llm-adapter.ts` — `createRealLLMStreamChat(cfg)`: injects `Authorization: Bearer <key>` via custom `Fetcher`, bridges protocol's 3-arg `streamChat(url, request, options)` to IM's 2-arg `streamChat(url, request)`.
- `examples/real-llm-monitor.ts` — monitoring script: traces each round's tokens, every tool call + result + latency, guard status, final termination reason + cumulative usage.
- Verified against real LLM (glm-5.3-flash via ARK endpoint): working agent loop ran 2 rounds (task → calculate tool_call → result 396 → final answer), 688 total tokens, 11.8s elapsed.
