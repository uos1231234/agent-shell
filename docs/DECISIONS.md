# Decision Log

This document records the architectural decisions for `agent-shell`. Each decision is final and binding unless explicitly reversed by a later ADR.

---

## ADR-001: databus = 上下文投影层 (proposed earlier, reaffirmed)

**Status**: Active vision; the v0.10.4 contract correction makes the projection ownership explicit

**Context**: We needed a way for multiple "expert" sessions to share tool results without redundant calls. The v0.10.1 split-store implementation narrowed Databus to tool turns but left working-prompt ordering split across ConversationMemory and Databus.

**Decision**: Databus is **not** a second conversation history. It is a **tool-only projection** of the canonical ordered conversation. `ConversationMemory` is the ordering authority for working and system-agent prompts; each canonical `role: 'tool'` turn is copied to Databus for explicit cross-agent query/subscribe. Databus must not be appended to the working prompt as a second history source.

**Note (2026-08-29)**: the currently landed v0.10.3.1 source still contains the historical split-store prompt assembly. The v0.10.4 plan ([`docs/plans/v0.10.4-system-agent-autodrive.md`](./plans/v0.10.4-system-agent-autodrive.md)) is the implementation contract that corrects this gap. The `bus.snapshot()` API described in the original draft never existed in the recovered code; do not invent it.

---

## ADR-002: shell = 漏斗 (funnel), not FSM

**Status**: Active

**Context**: Initial designs proposed a 5-state FSM (`Idle` / `Running` / `Tripped` / `Recovering` / `Dead`) with a transition table.

**Decision**: The shell is a **funnel**. State is one of three values: `Running` / `Tripped` / `Dead`. There is no `Recovering` state, no half-open probing, no transition table.

- `Running` → all information flows through to the protocol layer
- `Tripped` / `Dead` → the gate is closed; protocol layer is not called; IM terminates

**Rationale**: A guard firing is a **hard terminal** event. The user (or IM) decides whether to start a new session. Auto-recovery creates new infinite-loop entry points and is rejected.

**Consequence**: shell internal state is a 3-value enum + 5 metrics fields + config. No `transitions` table. No `state_machine` library.

---

## ADR-003: IM (Information Modeling) = first-class citizen

**Status**: Active

**Context**: Where does "business logic" (databus queries, expert status, tool selection) live?

**Decision**: IM is its own top-level module (`src/im/`) with its own data types, its own tests, and its own evolution path. The shell and protocol are **infrastructure** for IM. They do not contain business logic.

**Rationale**: The actual engineering work is **designing what the LLM sees** (prompt composition, tool selection, history projection). Shell and protocol are merely the "funnel" and the "delivery mechanism". The interesting code lives in IM.

**Consequence**: `src/im/loop.ts` is the entry point of any real application. `src/shell/` and `src/protocol/` are reusable across any IM implementation.

---

## ADR-004: shell state never enters the LLM's view

**Status**: Active

**Context**: When a guard trips, does the LLM need to know?

**Decision**: **No.** The shell's terminal state (`IMLoopResult.finalState` / `hits`, returned by `runIMLoop`) is a control signal for the caller only. It is never concatenated into the prompt sent to the LLM.

**Rationale**: If the LLM sees "you have been rate-limited" or "your token budget is exhausted", it will attempt to find a way around the limit (rewrite the prompt, switch to a different mode, ask the user for permission). This defeats the purpose of guards.

**Consequence**: From the LLM's perspective, a tripped shell looks identical to a protocol error (network failure, model overloaded). The error is opaque. IM decides what to do (in our case: stop).

---

## ADR-005: tool calling uses OpenAI native function calling format (形态 A)

**Status**: Active

**Context**: How does the LLM invoke tools? Options: native OpenAI `tools` field, injected text markers, hybrid.

**Decision**: **Native OpenAI function calling** (`tools: [{ type: 'function', function: { name, description, parameters } }]` in the request, `tool_calls` in the response).

**Rationale**:
- LLMs are trained on this format. No in-context learning required.
- The protocol layer (HTTP) is **unchanged** — `tools` is a first-class field of the request body.
- Tool schemas do not pollute the `messages` array.
- Tool calls are a structured part of the response; no regex parsing of marker text.

**Consequence**:
- `shell.compose(parts)` produces `{ messages, tools }` directly in OpenAI request format. Protocol layer does **no transformation** of tool calls.
- The `systemTool` / `mcp` / `skill` prompt parts in IM are **references** to registered tools. `shell.compose()` resolves references → fetches schemas → puts them in the `tools` field.
- Tool results are sent back as `role: 'tool'` messages in the next turn (also native OpenAI format).

---

## ADR-006: tools are registered explicitly (system tools, MCP, skills)

**Status**: Active

**Context**: How are tools made known to the LLM?

**Decision**: All tools (system tools, MCP server tools, skills) are **registered** at startup via a unified `ToolRegistry`. The IM references tools by name when composing the prompt. `shell.compose()` resolves the references into OpenAI tool schemas.

**Rationale**:
- Single source of truth for each tool's schema and executor.
- Updating a tool = updating one place.
- Clear boundary between "tool implementation" and "tool usage in IM".

**Consequence**:
- `shell.registerTools([{ name, description, parameters, execute }])`
- `shell.registerMCP(server, [{ name, description, parameters }])`
- `shell.registerSkill({ name, description, execute })`
- `shell.listSystemTools()` / `shell.listMCPTools()` / `shell.listSkills()` for IM to enumerate
- **No runtime add/remove** — registration is startup-time only (no hot-plug).

---

## ADR-007: shell and protocol are peers via a single interface (the call site), not a bidirectional channel

**Status**: Active (revised from earlier "EventChannel" design)

**Context**: Earlier drafts proposed an `EventChannel` for bidirectional shell ↔ protocol communication.

**Decision**: There is **no bidirectional channel**. The shell and protocol are peers in the sense that **neither owns the other**, but communication is unidirectional through a single call interface:

```
IM → shell.compose(parts) → FinalPrompt
IM → shell.call(prompt)   → Response (shell internally calls protocol, collects usage, runs guards)
```

The protocol is a pure function. The shell holds metrics and runs guards. The IM orchestrates.

**Rationale**: Bidirectional pub-sub is **overengineering** for a single LLM call. The only signal that needs to flow "back" from protocol to shell is `usage` — that is handled by an `onUsage` callback passed at call time, not by an event channel.

**Consequence**: No `src/channel/` module. The shell → protocol relationship is "shell calls a pure function with a callback". Tested via mock callbacks.

---

## ADR-008: protocol layer handles 429/503 retries internally (5x exponential backoff); everything else propagates

**Status**: Active

**Context**: How should network / API errors be handled?

**Decision**:
- HTTP 429 (rate limit) and 503 (service unavailable) → **automatic retry up to 5 times** with exponential backoff, **inside the protocol layer**.
- All other errors (400, 401, 404, 500, network errors, timeouts) → **propagate as-is** to the caller (shell), which converts them to a `Tripped` state and a `ShellTerminatedError`.

**Rationale**: 429/503 are transient and have a clear retry semantics. Other errors are either fatal (auth, bad request) or unrecoverable (timeout on non-rate-limited path). Mixed retry policies are an anti-pattern.

**Consequence**: `protocol.retry.ts` is the only place that knows about retries. Shell and IM do not.

---

## ADR-009: one layer of code, no defensive padding

**Status**: Active

**Context**: How defensive should the code be?

**Decision**: **One layer.** No nested `try { try { try {} } catch {} } catch {}` constructs. No "just in case" checks. Trust the type system and tests. When tests fail, fix the logic, do not add another `if`.

**Rationale**: Defensive layers hide bugs. Tests are the safety net. If a test exposes a bug, the fix is in the implementation, not in a new wrapping `if`.

**Consequence**: Every function does one thing. Every public function is tested against at least one happy path and one edge case. No "fallback" paths.

---

## ADR-013: tool 错误流 = 普通 tool content（deepseek-harness 风格）

**Status**: Active (revised after the deepseek-style refactor on 2026-08-26; the previous "5 phase verdict" version is superseded)

**Context**: Tool execution in agent-shell has two failure modes:

1. **The call itself is malformed** — invalid JSON in `arguments`, etc.
2. **The tool's execution failed** — the tool itself threw (ENOENT, EPERM, exit code ≠ 0, validation error, etc.).

Both modes produce a `role: 'tool'` turn on the wire. The OpenAI Chat Completions schema is exactly three fields: `{ role, tool_call_id, content }`. Any extra field (notably `isError`) is rejected by strict providers.

**Decision**:

- **Tool errors are plain English on a normal `role: 'tool'` turn.** When a tool's `execute` throws (or arguments fail to parse as JSON), the IM loop in `src/im/loop.ts:executeToolCalls` catches the throw and writes a `role: 'tool'` turn whose `content` is a human-readable sentence: `` `Tool "${name}" failed: ${msg}` ``. The LLM sees the failure on its next turn and adjusts.

- **No internal marker on the wire.** We do NOT prefix with `error: `, do NOT add an `isError` field on the `role: 'tool'` turn, do NOT use a separate verdict type. The protocol-layer `ParseResult<T>` is `{ ok: true; value: T } | { ok: false }` — no error message field either. The caller (im/loop.ts) writes the English sentence.

- **Tools are self-validating.** Each tool's `execute` checks its own contract at the top (see `src/im/tools/validate.ts:requireReason`, which the factory `wrap()` and the standalone `wrapReason()` both call). The protocol layer does no validation. The shell layer does no validation. The factory only declares the schema; the tool is responsible for the runtime contract.

- **The consecutive-error circuit breaker IS a guard — but a session-scoped one, not a tool-scoped one.** "Don't let the LLM loop on the same broken tool call 10 times" is a terminal concern — it should trip `state = 'Tripped'`. It belongs in the guard family, but it must be distinguished from **tool-internal validation** (path escaping cwd, command-not-string, reason-missing, blocked directory): those are tool-internal and surface to the LLM as ordinary `role: 'tool'` content the model can read and self-correct on. The errorRate guard is **session-scoped** — it does not know which tool failed, only that some tool in some round failed — and it terminates the **session** when the LLM cannot self-correct after N consecutive failed rounds. The boundary: tool-internal errors are feedback to the LLM; errorRate is the session's last-resort safety net when feedback is not enough.
  - `metrics.consecutiveToolErrors` tracks consecutive tool errors. (An earlier draft also kept `consecutiveErrors` "reserved for protocol failures"; that reserved field was removed by ADR-015 — a metric nobody produces and no guard reads is dead weight. Protocol errors terminate the loop immediately; they do not accumulate.)
  - `shell/guards.ts:runGuards()` compares `consecutiveToolErrors` to `config.maxConsecutiveToolErrors` (default **10**) and trips when exceeded. The guard's `GuardId` stays `'errorRate'`.
  - The loop calls `addToolError(metrics)` on any failed tool execution and `resetToolErrors(metrics)` when all calls in the batch succeed. The wiring lives in `im/loop.ts`, not in the tool itself.

- **`src/im/tool-runner.ts` was deleted.** The five-phase verdict concept (empty-name / empty-reason / parse-error / truncated / run) is gone. Tool execution is now `Promise.all(toolCalls.map(async tc => try { registry.execute(...) } catch (e) { return error turn }))` in the IM loop.

**Rationale**:

- LLM training: models are trained to read `role: 'tool'` content as a tool's reply. Adding a special verdict type or an `isError` flag asks the LLM to learn a new convention that isn't part of the spec. DeepSeek's harness uses the same plain-content pattern; matching that minimizes surprise and the risk of a provider refusing the message shape.
- Protocol purity: `protocol/types.ts:ChatMessage['role: 'tool']` is three fields. Keeping it that way avoids field-rejection errors from strict providers and keeps the protocol layer as a pure wire layer that emits no UI text.
- Databus as single source of truth: tool execution results live in the databus as ordinary `role: 'tool'` turns. No special verdict type means the databus schema is uniform and the compose layer doesn't need to know about error variants.
- The 10-count circuit breaker is a runtime guard, not a UX feature. It belongs in the guard family because it terminates the turn (`state: 'Tripped'`). Naming it `errorRate` is a leftover from when the counter was shared; the metric is now `consecutiveToolErrors` and the field is `consecutiveToolErrors > maxConsecutiveToolErrors`.

**Consequence**:

- `src/im/tool-runner.ts` is gone. Its 5-phase verdict logic is replaced by `executeToolCalls` in `src/im/loop.ts`.
- `src/shell/metrics.ts` tracks tool-layer errors with `consecutiveToolErrors` (helpers: `addToolError` / `resetToolErrors`). The former `consecutiveErrors` / `addError` / `resetErrors` "protocol-error" family was removed by ADR-015 — it had no producer and no guard reader.
- `src/shell/config.ts` has `maxConsecutiveToolErrors` (default 10, drives the errorRate guard). A former "reserved" `maxConsecutiveErrors` never shipped and is gone.
- `src/im/turn.ts:Turn` for `role: 'tool'` carries an IM-internal `isError?: true` flag. `turnToMessage()` strips it before serialization — the LLM only ever sees the `content` string.
- `src/im/tools/validate.ts` exposes `requireReason` (tool contract) and `wrapReason` (factory contract); both produce plain English on throw.

**Counterexample (what this ADR rejects)**: imagine a `ToolGuard` trait that classifies every tool call as `Allowed | Denied | Retry` and projects the verdict into the LLM's prompt. Then every tool would have to be wrapped in this trait, the trait would need to know about all 8 tools' contracts, and the verdict would have to be projected into the LLM somehow. This is exactly the kind of cross-layer coupling that ADR-009 (one layer of code) rejects. The `tool-runner` 5-phase code we had before the refactor was the start of that mistake.

---

## ADR-010 superseded (2026-08-27): tool-call bucket caps are removed

**Status**: Superseded by ADR-013 (2026-08-27)

**Context**: ADR-010 originally declared a two-bucket parallel-execution cap on built-in system tools (reads bucket, max 5 parallel; commands bucket, max 3 parallel), enforced by a `tool-runner.ts` "5-phase verdict" layer. The cap was the project's only attempt at a "global tool call rate limit" — every tool call was classified, excess calls were truncated to error turns. The implementation had drifted into a state where the `tool-runner.ts` file was deleted, the cap was no longer enforced anywhere, but the bucket metadata still lived on as "informational" in `tools/buckets.ts`. Tool schema descriptions still mentioned "max 5" and "max 3", so the LLM saw a cap it could not trust.

**Decision**:

- `src/im/tools/buckets.ts` is deleted (was dead code per ADR-015: every export symbol must have a non-test caller; no caller existed in production).
- `src/im/tool-runner.ts` was already deleted by the earlier deepseek refactor.
- Tool schema descriptions and the bucket column are removed; the LLM no longer sees a cap it cannot trust.
- Tool-internal validation is the only place tool-internal guards live. Each is `throw` from `execute()` → caught by the factory's `wrap()` or `wrapReason()` (both in `tools/validate.ts`) → surfaced to the LLM as a plain English sentence on a `role: 'tool'` turn. Examples that remain:
  - `src/im/tools/path.ts:resolvePath` rejects paths that escape the configured cwd.
  - `src/im/tools/validate.ts:requireReason` rejects calls with an empty or missing `reason`.
  - `src/im/tools/write.ts:isBlocked` rejects writes into OS-protected directories.
  - Per-tool `execute()` arg-shape checks (e.g. `bash.ts` / `powershell.ts` refusing a non-string command).
- The 8-tool test surface in `tests/im/tools/index.test.ts` is unchanged (it asserts registry membership + round-trips, not bucket caps).

**Rationale**: A "global tool call rate limit" via a verdict-truncation layer is the exact shape of cross-layer coupling ADR-009 rejects. The truncation layer would have to know about every tool's contract (which arguments are valid, what counts as "excess") and project a verdict back into the prompt. The tool-internal pattern — each tool enforces its own contract at the top of `execute()` — is one layer of code with no cross-tool knowledge. The session-level safety net (the `errorRate` guard) lives in `shell/guards.ts` and terminates the session when the LLM cannot self-correct, not the individual tool call. These two layers (tool-internal + session-scope) are sufficient; a third layer (per-batch cap) was redundant and unmaintained.

**Consequence**:

- The 8 built-in tools register cleanly with no bucket column. Their `description` and `parameters` no longer mention a cap.
- `tools/buckets.ts` no longer exists. Imports of its exports would now fail; `find_references` confirmed there are none in `src/` or `tests/`.
- ADR-015's "no dead code, no reserved fields" rule is now satisfied for the tool cap area as well as the metrics area.

**Supersedes**: The original ADR-010 ("tool-call buckets" — concurrent-call caps) and the `tool-runner.ts` 5-phase verdict layer that ADR-013 already removed. The `reason` field requirement (originally bundled into ADR-010 alongside the bucket config) is preserved — it is now solely an ADR-013 concern, enforced by `requireReason` / `wrapReason` in `src/im/tools/validate.ts`.

---

## ADR-014: every guard must be reachable on the happy path

**Status**: Active

**Context**: After a code review (2026-08-26), three of the five guards were discovered to be silently unreachable in the default configuration:

1. **time guard** — `metrics.elapsedMs` was declared in `src/shell/metrics.ts` and read by `src/shell/guards.ts:runGuards()`, but **no code in the entire package wrote it**. The user's `maxElapsedMs: 60_000` had no effect — the value was 0 forever.
2. **iter guard** — `metrics.stepCount` was incremented **only inside the `if (usage) { ... }` branch** in `src/shell/call.ts`. OpenAI streaming does not emit a usage chunk unless the request opts in with `stream_options: { include_usage: true }`. Many providers (vllm, ollama, local inference) never emit it. Default configuration: `stepCount` was always 0, `iter` guard never tripped.
3. **token guard** — same root cause as `iter`: `metrics.totalTokens` is updated only when a usage chunk arrives, so the `token` guard's threshold was unreachable on providers that don't emit usage.

This is **ADR-009's silent failure mode**: a guard exists, the threshold is configurable, the test for the guard is a pure-function unit test that passes, but the **producer** is missing or coupled to an external condition. The unit test is green; the integration is broken.

**Decision**:

- **The time guard's producer is in the IM loop.** `src/im/loop.ts` declares `loopStart = Date.now()` at the top of `runIMLoop` and calls a new exported helper `advanceElapsed(metrics, loopStart, now)` after every `shellCall`. The wall-clock anchor lives in the loop because the loop is the only thing that knows "this session started at T"; the shell is a single-call primitive and has no notion of session duration. The export of `advanceElapsed` is intentional — it makes the producer visible and testable. `tests/shell/guards.test.ts` imports it directly and asserts "if a refactor drops the producer, this test fails before the time guard test would catch the symptom".

- **The iter guard's producer is unconditional.** `src/shell/call.ts` now calls `addStep(deps.metrics)` **outside** any `if (usage)`. A step is "one shell call round", not "one usage chunk". The coupling is removed. Token accumulation still goes through the usage path (because we cannot know how many tokens were spent without a usage chunk); when usage is missing, the token guard is best-effort and will only trip on accumulated tool-call load via the `toolRate` guard.

- **The token guard's producer is opt-in at the protocol layer.** `src/protocol/client.ts:streamChat` automatically injects `stream_options: { include_usage: true }` into every request unless the caller explicitly sets `stream: false` AND `stream_options`. This makes the OpenAI streaming protocol emit a usage chunk by default, so the `token` guard is reachable against the OpenAI-shaped API used by most third-party providers. Providers that ignore `stream_options` (vllm in non-OpenAI mode, etc.) will still fall back to "no usage" and the token guard will be best-effort there — but the IM's `toolRate` and `iter` guards remain reachable.

- **Tests pin the contracts.** `tests/im/loop.test.ts:max-steps guard` no longer sends a usage chunk in the scripted responses. `tests/shell/call.test.ts:step counting without usage` asserts `stepCount === 1` after a single call without usage, and asserts `metrics` is unchanged when the gate short-circuits (proving `addStep` runs only after the wire is reached). Together they make "iter guard silently coupled to usage chunk" a regression that fails in CI.

**Rationale**: ADR-009 says "trust the type system and tests". This ADR adds the corollary: **a unit test of a guard's pure function is not enough** — every guard must also have a test that exercises the producer chain end-to-end. Otherwise the green unit test masks an unreachable guard, and the user sets a threshold and discovers it never trips.

**Consequence**:

- `src/im/loop.ts` exports a new pure helper `advanceElapsed(m: Metrics, loopStart: number, now: number): Metrics`. The IM loop's `runIMLoop` function calls it after every `shellCall` (whether or not a guard trips on that call).
- `src/shell/call.ts` no longer reads or writes `stepCount` manually; it calls `addStep` from `src/shell/metrics.ts`. `src/shell/metrics.ts` already exported `addStep`; this ADR merely routes the call site to it. The dead-import surface in `src/im/loop.ts` (`addStep`, `addUsage`, `addError`, `resetErrors`, `type Usage`) is also cleaned up: only the helpers the loop actually uses (`addToolError`, `resetToolErrors`) remain imported.
- `src/protocol/client.ts:streamChat` mutates the outgoing request to set `stream_options.include_usage: true`. A caller can override this by passing an explicit `stream_options` (e.g. `{ stream_options: { include_usage: false } }`); the merge is shallow-override so the caller's flag wins.
- `src/im/tools/glob.ts` had two dead branches and a stale "No need for an extra separator" comment in `globToRegex`; both removed, and the `if/else` collapsed into the single rule "add `/` only between two non-`**` segments". The behavior is identical to the original (verified by 200 passing tests) but the code is now 12 lines shorter and the dead branches cannot regress.
- `tests/im/tools/__tests__/glob.test.ts` was a 89-line copy of `tests/im/tools/glob.test.ts` (93 lines, more complete). The `__tests__` copy is deleted. This was a copy-paste leftover from the codebase recovery, not an intentional test colocated with the source.
- `tests/shell/guards.test.ts:timeGuard` gains two new cases: "does NOT trip when elapsedMs === maxElapsedMs" (strict greater-than parity with other guards) and "is reachable from the IM loop via advanceElapsed — regression pin" (imports `advanceElapsed` and proves the producer is wired).
- **errorRate guard end-to-end producer test (added 2026-08-27, v0.9).** The five guards produced end-to-end tests for `time`/`iter`/`token`/`toolRate` in this ADR; `errorRate` was the one holdout because the producer chain (`im/loop.ts:executeToolCalls` → `addToolError` → `metrics.consecutiveToolErrors` → `runGuards`) is more involved. `tests/im/loop.test.ts:errorRate guard (ADR-014 end-to-end producer chain)` now contains three cases: (a) 11 consecutive error rounds trip the guard on the 11th (`maxConsecutiveToolErrors: 10`, strict `>`); (b) alternating success/failure does NOT trip (success rounds reset the counter — the `config.ts` field comment calls out this known limit); (c) one round with N parallel failing tool calls counts as **one** error, not N. The third case is the producer-chain pin: it fails if anyone refactors `addToolError` to be called per-call instead of per-round. Together these tests close the ADR-014 loop for the last guard.
- The codebase is **28 test files / 200 tests / 0 typecheck errors** after this change. (v0.9: 27 test files / 197 tests — the file count drop is from the ADR-010 bucket deletion; the test count change comes from the new errorRate end-to-end tests, the new client.ts stream-injection tests, and one new path-anchoring test in `tests/im/tools/index.test.ts`.)

---

## ADR-015: guards are evaluated at one point (the IM, after `advanceElapsed`); no dead code, no "reserved" fields

**Status**: Active

**Context**: A penetration test (2026-08-26) found a blind spot left over from the ADR-014 fix: `shellCall` computed `runGuards` on metrics that did **not** yet include the wall-clock `elapsedMs` (the IM applied `advanceElapsed` only after `shellCall` returned). A single slow **final** round — one that answers with plain content and no tool calls — sailed through as `'completed'` even when it blew past `maxElapsedMs`. The multi-round path was covered (the next round's entry gate caught it), but the last round never re-checked.

The same review surfaced a second, systemic problem: a growing pile of code that no caller reached.

- `src/shell/snapshot.ts` (`createSnapshot`) — imported by the loop but never called; `IMLoopResult.finalState/hits` already is the snapshot.
- `src/im/error.ts` — a whole file of re-exports with zero importers.
- `src/shell/json-schema.ts` — a compat re-export shim left over from a move to `shared/`.
- `Metrics.consecutiveErrors` + `addError` / `resetErrors` — "reserved for protocol errors" since ADR-013, but protocol errors terminate the loop immediately; nothing ever produced or read the field.
- `ShellConfig.protocolRetries` — declared, defaulted, and **ignored**: `client.ts` used its own hardcoded defaults.
- `StreamOptions.maxRetries` / `baseDelayMs` — the opposite failure: declared in the type, ignored by the implementation (a wiring bug: callers thought they were configuring retries).
- `state.ts:isRunning` / `isTerminal`, `tool-calls.ts:parseChatCompletionResponse`, `glob.ts:isGlobPattern`, `Databus.last/clear/subscribe` — API surface with no callers outside their own tests.
- `IMLoopResult.reason: 'no-stream-content'` — a union member no code path could produce.
- Dead imports and write-only locals in the loop (`allHits`).

**Decision**:

1. **One guard evaluation point per round.** `shellCall` no longer runs `runGuards` after the call (the entry gate stays — it is what throws `ShellTerminatedError` when a previously-tripped shell is called). The IM runs `advanceElapsed(metrics, loopStart, Date.now())` immediately after every `shellCall`, then runs `runGuards` on the result — including on the final round. `ShellCallResult` loses its `hits` field; guards are evaluated exactly once, on the freshest metrics.
2. **No dead code, no "reserved" fields.** Everything listed above is deleted, not commented out. New rule (extends ADR-014): every exported symbol must have a caller outside its own test file, every `Metrics` field must have a producer **and** a guard reader, every `ShellConfig` field must be read by the layer it configures. "Reserved for future use" is rejected — future use can re-add the field in one commit when it actually gains a producer.
3. **Wiring bugs in options are fixed, not documented.** `StreamOptions.maxRetries` / `baseDelayMs` are now actually consumed by `streamChat` (they were silently ignored). A declared-but-ignored option is worse than an absent one.

**Rationale**: Two evaluation points meant two subtly different metric snapshots; the difference was exactly the `time`-guard blind spot. One evaluation point is simpler to reason about and impossible to get out of sync. Dead code is not free: every item above either lied to its reader (`protocolRetries` "configures" nothing), required maintenance, or masked a real wiring bug (`StreamOptions`). "Reserved" fields are the seed of unreachable guards (ADR-014) — `consecutiveErrors` sat reserved long enough to be cited in two documents as if it worked.

**Consequence**:

- `src/shell/call.ts` returns `{ response, updatedMetrics, toolCalls }`; guard evaluation lives only in `src/im/loop.ts`.
- Deleted files: `src/shell/snapshot.ts`, `src/im/error.ts`, `src/shell/json-schema.ts`. Deleted exports: `isRunning`, `isTerminal`, `parseChatCompletionResponse`, `isGlobPattern`, `addError`, `resetErrors`, `addToolCall`, `Metrics.consecutiveErrors`, `ShellConfig.protocolRetries`, `Databus.last/clear/subscribe`, `IMLoopResult.reason: 'no-stream-content'`.
- `addToolCall` is replaced by `addToolCalls(m, n)` which matches its only call site (batch counting) — `call.ts` no longer hand-rolls the spread.
- `advanceElapsed` now takes the shell's `updatedMetrics` directly: `metrics = advanceElapsed(result.updatedMetrics, loopStart, Date.now())`.
- Regression tests: `tests/im/loop.test.ts:time guard: last-round blind spot` — a single slow round with `maxElapsedMs: 25` must terminate as `'guard-tripped'` with the `time` hit, and a fast round must still `'complete'`.
- Docs synced: ARCHITECTURE (data flow, module list, invariants 2/9), DECISIONS (ADR-001/004/013 wording), CODE_MAP, IM-GUIDE, README.
- The codebase is **27 test files / 189 tests / 0 typecheck errors** after this change (test count drops because tests of deleted API surface were removed; no behavior coverage was lost — guard producer chains all retain end-to-end tests).

---

## ADR-016: agent-shell 信息流架构 (v0.10)

**Status**: Active contract; v0.10.1-v0.10.3 are landed, while the v0.10.4 canonical-order correction remains planned

**Correction record (2026-08-29)**: the original v0.10.1 split-store prompt assembly is historical implementation detail, not the target information model. The canonical sequence and projection ownership are defined in [`docs/adr/0016-information-flow-architecture.md`](./adr/0016-information-flow-architecture.md) and [`docs/plans/v0.10.4-system-agent-autodrive.md`](./plans/v0.10.4-system-agent-autodrive.md).

**Full text**: [`docs/adr/0016-information-flow-architecture.md`](./adr/0016-information-flow-architecture.md)

**Context**: v0.9's databus is a single in-memory turn array holding all roles. It breaks when a session outlives one LLM context window (>200K tokens) or when multiple agents need to coordinate. ADR-001 envisioned a "projection layer"; v0.9 never implemented it.

**Decision**: agent-shell is no longer "main agent + tool registry + state machine". It is **one canonical ordered conversation plus three projection flows**:

1. **Canonical ConversationMemory** — the session-scoped ordered `role: 'user' | 'assistant' | 'tool'` sequence. It is the only ordering authority for working and system-agent prompts. A complete task block is cut from one user turn through just before the next user turn and must contain a tool turn.
2. **Databus projection** — append-only `role: 'tool'` projection copies, cross-agent readable through `query` / `subscribe`, in-memory and ephemeral. It is not a second prompt history and is never appended to working context.
3. **State-line** — persistent M1/M2 curated memory and M3 archive/index, maintained by the system agents and injected only through the context projection.
4. **Mailbox** — private FIFO per `AgentId`, in-memory and ephemeral. The runtime injects only a "you have N unread" hint; content is pulled by `mailbox_read`.

Three **system agents** (warehouse / compressor / recall) are full `runIMLoop` instances — not single-shot LLM calls. They reuse v0.9's `streamChat` adapter, `ToolRegistry`, and guard infrastructure. The `createSystemAgent` factory takes 8 fields (name, systemPrompt, toolRefs, llmStreamChat, url, model, mailbox, registry; config optional). `mailbox` is injected directly in the signature — no module-level global.

The working agent gets 7 new tools: `databus_query` / `databus_subscribe` / `state_query` / `compress_block` / `ask_recall` / `mailbox_send` / `mailbox_read`. The 8 v0.9 system tools and mcp/skill surface are unchanged.

LLM context is a **dynamic projection** at 200K, 500K, and 900K thresholds. The M3 index **never enters the context** — the warehouse agent emails the working agent a hint when new M3 blocks are available. The v0.10.4 correction makes the canonical conversation the only working-prompt history source.

**v0.18 progressive tool disclosure**: MCP tools and module skills default to NOT entering the top-level `tools[]`. The LLM loads them on-demand via `load_tools` system tool. Loaded tool schemas are injected as `role:'system'` messages with a `tools` field (dynamic schema injection) — this is **not** a new projection but a conversation-history-level injection. After compaction, schemas naturally disappear; the LLM must re-load. Server is the minimum disclosure granularity (not single tool). Sub-agent policy filtering is applied at `load_tools` execute time via `ctx.toolPolicy`. See `ARCHITECTURE.md` "Progressive Tool Disclosure" section and `docs/plans/v0.18-progressive-tool-disclosure.md` for details.

**v0.10.1 code-review fixes (12 issues P0-P3)**:
- P0: ADR-016 §3.3 factory signature synced to actual 8 fields; plan §3 wiring.ts marked as not-adopted (dead code)
- P1: tool schemas aligned to ADR (`state_query.stamps`→`string[]`, `compress_block.block`→array, `ask_recall.scope`→union enum, mailbox tools' `from`/`agentId` removed from schema — captured in closure); `createSystemAgent` metrics bug fixed (returns `result.metrics`, not empty); `readOwnInbox` does not auto-mark-read
- P2: 7 new tool tests added; `noopSystemAgent` wording clarified ("not configured", not "placeholder")
- P3: `executeToolCalls` takes `workingAgentId` param, returns full `ToolTurn[]` (not `Omit`)

**Rationale**: The canonical sequence must have one ordering authority because OpenAI requires each assistant tool call to be followed by its matching tool result before a later assistant message. Databus, StateLine, and Mailbox remain separate projection surfaces with distinct ownership and retention, but Databus is a copy of canonical tool turns rather than a source for rebuilding prompt order. This separation lets each projection evolve independently without reintroducing split-store ordering.

**Consequence**:
- `src/im/conversation-memory.ts` is the canonical ordered user/assistant/tool sequence; `src/im/databus.ts` remains a role:'tool'-only projection copy with explicit cross-agent query/subscribe access
- `src/im/mailbox/` NEW — `Mailbox` class (send / readOwnInbox / markRead / hasUnread / inboxSize)
- `src/im/system-agent.ts` NEW — `createSystemAgent` factory; `src/im/system-agents/` NEW — `register.ts` + 7 tool files
- `src/im/minimal.ts` NEW — `createMinimalIM(opts)` factory
- `src/im/prompts/` NEW — 4 system-prompt .md files + `index.ts` loader
- `IMLoopOptions` adds `conversationMemory` / `workingAgentId` / `mailbox` / `systemAgents` (all required)
- 7 new tools use closures to capture dependencies — `ToolExecutor` signature unchanged, 8 existing tools zero-modified
- The codebase was **38 test files / 258 tests / 0 typecheck errors** after v0.10.1 + code-review fixes; later v0.10.3.1 reached 336 tests. The v0.10.4 source correction is still planned.
- **v0.10.2** (2026-08-28, commit `ef67968`): `src/im/state-line/` 5 new files (types / jsonl-writer / append-stamp / chroma-bridge / index); `registry.ts` `execute(name, args, ctx?)` 3rd arg optional; `state-query.ts` stub → real (jsonl direct read + chromadb RAG, no LLM); `IMLoopOptions.stateLine?: StateLine` optional; `createSystemAgent` 9th field `stateLine: StateLine` required; `registerSystemAgentTools` 5th param; `minimal.ts` noopStateLine default. 3 test files (21 new tests). **40 test files / 277 tests / 0 tsc errors**.
- v0.10.3 (context dynamic projection) is implemented (2026-08-28, commit `3427e9f`): `src/im/context-projection.ts` NEW (buildContextProjection, M0-M3 per-round pull via classifyMemoryLayer, not via SignalBus); M2 uses Plan B (two query calls merged); `stateLine` changed from optional to required; `createNoopStateLine()` added; mailbox unread hint injected to system prompt; `minimal.ts` uses createNoopStateLine. Tests 317→331 (+14), 43 test files, 0 tsc errors.

---

## ADR-017: 修复方案1 (P0–P9) — 2026-08-29

> ⚠️ **双轨命名说明**：本 DECISIONS.md 中的 ADR-017 = "修复方案1 P0-P9"（10 项 bug 修复）；而 `docs/adr/0017-sub-agent-databus-boundary.md` 文件中的 ADR-017 = "Sub-agent Databus boundary and security hardening (v0.11)"（两总线 + P2.1-P2.8 安全加固）。两者主题不同但共享同一编号——这是历史双轨命名，未做合并以免引用断裂。下文引用 ADR-017 时需根据上下文区分是"修复方案1"还是"sub-agent 边界"。

**Context**: 修复方案1.md identified 10 issues across P0 (critical) to P9 (optimization). All are non-v0.10.4-dependent and were executed in sequence with test-first methodology.

**Decisions**:

1. **P0 — wrapTool re-throw**: `wrapTool` (helpers.ts) no longer catches exceptions internally; it re-throws unchanged so `loop.ts`'s catch block can count errors for the `errorRate` guard. Previously wrapTool swallowed errors into a string return, making the guard unreachable on tool exceptions.

2. **P1 — SystemAgent fresh state per run()**: `createSystemAgent` now constructs a fresh `Databus` and `ConversationMemory` inside each `run()` call, preventing state accumulation across invocations.

3. **P2 — Mailbox tools read identity from context**: `ToolContext` gained `agentId` field; mailbox tools (`mailbox_send`, `mailbox_read`) read sender/reader identity from `ctx.agentId` instead of closure capture, enabling cross-agent reuse.

4. **P3 — Token guard uses per-request size**: New `Metrics.lastRequestTokens` field (overwritten each round, not accumulated). The `token` guard reads `lastRequestTokens` instead of cumulative `totalTokens`. This fixes the guard firing on long sessions even when individual requests are small. `call.ts` populates it from `usage.promptTokens` (when available) or a text estimate (4 chars/token).

5. **P4 — Memory layering uses lastRequestTokens**: `classifyMemoryLayer` input changed from cumulative `promptTokens` to `lastRequestTokens`, aligning layer transition with actual per-round context size.

6. **P5 — Databus tools made deterministic**: `databus_query` no longer delegates to `warehouse.run()` (which caused infinite recursion); it reads `ctx.databus` directly. `databus_subscribe` gained TTL (10 min) + event cap (20) + `'*'` wildcard source filtering. `Databus.subscribe` accepts `sourceAgentId: AgentId | '*'`.

7. **P6 — ProtocolError wrapping**: `ProtocolError` gained `retriable: boolean` field. `client.ts` wraps connection failures as `ProtocolError(0, ..., retriable: true)`, mid-stream interruptions as `ProtocolError(0, ..., retriable: false)`, and detects OpenAI streaming error frames (`data: {"error":...}`). `retry.ts` `isRetriable` reads `retriable` field instead of hardcoded status codes.

8. **P7 — SSE buffer limit**: `stream.ts` caps single-event buffer at 1MB (`MAX_EVENT_BYTES`); exceeding throws "malformed stream" error (caught by P6's wrapping layer).

9. **P8 — Empty tools array omitted**: `call.ts` omits the `tools` key from the request when `tools.length === 0`, since OpenAI-shaped providers reject `"tools": []`. `ShellDeps.streamChat` type updated to `tools?:` (optional).

10. **P9 — jsonl read cache**: `state-line/index.ts` added per-file read cache keyed on `(size, mtime)`. Repeated queries on unchanged files skip re-read. External writes detected via stat change → automatic cache invalidation. `StateLineConfig.jsonlWarnBytes` (default 5MB) triggers a one-time `console.warn` per path.

**Rationale**: Each fix addresses a root cause identified in 修复方案1.md without changing mature designs (append-only jsonl, API signatures, tool registry, guard evaluation point). P3+P4 together fix the token guard's session-level false-positive. P5 fixes a recursion bug that would hang the working agent. P6 makes retry decisions explicit per-error rather than status-code-based.

**Consequence**: 44 test files / 367 tests / 0 tsc errors. No new dependencies. No test files or cases deleted. All 10 items followed test-first (failing test → fix → green).

---

## ADR-018: MCP / Skill 扩展系统 — 2026-08-31

**完整文本**: `docs/adr/0018-mcp-skill-extension.md`（Status: Active）

**Context**: ADR-016 §11 曾声明 "No mcp / skill ecosystem expansion. The mechanism exists; the ecosystem does not." v0.13 推翻此条——MCP 连接 + JS/TS 模块 skill 作为正式扩展机制落地，子代理经 policy 受控开放工具访问（推翻 v0.12.2 的 blanket ban）。

**Decisions**:

1. **D1 — stdio + HTTP dual transport**: MCP 连接同时支持 stdio（子进程）和 HTTP（远程）两种 transport。stdio 子进程 env 显式构造，**不**透传 `process.env`（防密钥外泄）。

2. **D2 — SDK 隔离在 src/mcp/**: `@modelcontextprotocol/sdk@^1.30.0` 作为唯一运行时依赖，**仅**在 `src/mcp/` 目录内 import；对外暴露 `McpConnection` narrow interface（`listTools` / `callTool` 返回 string / `close`），其余代码不直接依赖 SDK。

3. **D3 — JS/TS 模块 skill**: `loadSkillsFromDir` 扫描 `.ts/.js/.mts/.mjs`，dynamic import 后校验 `name` / `description` / `execute` 三字段。skill 是代码模块（非配置），与 system tool 共享同一 wrap 路径（`helpers.ts`：reason 校验 + throw 转干净英文句子）。

4. **D4 — text skill 预注入**: text skill 在 prompt compose 前置阶段注入（`skills/text-loader.ts`），不占工具槽位。

5. **D5 — resolveRef 单分类器**: `resolveRef` 按单一顺序 `system → mcp → skill` 解析工具引用，与 `execute` dispatch 顺序对齐，避免双分类器不一致。

6. **D6 — bootstrapExtensions 一键装配**: `bootstrapExtensions` 一次性装配所有 MCP 连接 + skill，fail-fast（任一失败即抛）+ idempotent `close()`。注册是启动期行为，**无热插拔**（registry.ts:6 不变）。

7. **D7 — 子代理经 policy 开放工具访问（行为变更）**: `SubAgentToolPolicy`（`src/im/sub-agent/policy.ts`）取代 v0.12.2 的 blanket ban，default = `'allow'`。子代理可访问 MCP/skill 工具，但父代理可通过 policy 收紧（deny / allow-list）。

8. **D8 — 渐进式工具披露（v0.18）**: MCP 工具和 module skill 默认不进入顶层 `tools[]`，LLM 通过 `load_tools` 按需加载。`mcpRefs` 角色收缩为注册侧门控（决定哪些工具注册到 registry），不再控制 LLM 看到什么。动态 schema 注入对话历史（`role:'system'` 消息携带 `tools` 字段），compaction 后自然丢失。Server 是最小披露粒度（同一 server 的工具协作紧密）。子代理 policy 在 `load_tools` execute 时运行时检查（`ctx.toolPolicy`），阻止未授权工具加载。`load_tools` 走 `wrapTool → requireReason + SecurityRouter.check()` 路径。

**Rationale**: 扩展机制是 production hardening 的前置——没有 MCP/skill 生态，agent-shell 只能用内置 8+7 工具，无法对接外部能力。SDK 隔离避免外部依赖污染核心层；narrow interface 保证 SDK 升级不波及业务代码。policy 开放而非 blanket ban，是因为 v0.12.2 的全面禁止在实际使用中被证明过于保守（子代理无法调用任何扩展工具）。

**Consequence**: 79 test files / 893 tests / 0 tsc errors. 新增 1 运行时依赖 `@modelcontextprotocol/sdk@^1.30.0`（devDeps 不变）。推翻 ADR-016 §11 "no mcp/skill ecosystem"（已在 `adr/0016-information-flow-architecture.md` §11 末尾加 forward pointer）。

**Amendment (2026-09-17, naming risk)**: v0.42 的 `submit_curated_memory` 暴露出一个命名契约缺口。生产装配先加载 module skill、后注册系统工具，而 skill loader 的碰撞检测只查询当时已经存在的 system tool；因此同名 module skill 可以先进 loadable metadata，并出现在 `buildServerSummary` / `load_tools` 中。执行仍按 `system → mcp → skill` 命中真实系统工具，随后被身份守卫拒绝，所以没有越权提交；但“私有工具对其他 agent 不可见”不成立。后续规则：系统智能体私有工具名必须是跨所有公开工具来源的全局保留名，碰撞处理必须与注册顺序无关；`toolRefs` 排除和运行时身份守卫都不能替代这一契约。用户自行 DIY 同名 skill 不作为产品级兼容/授权承诺。

---

## ADR-019: Wiki System Agent — code-domain knowledge base — 2026-08-31

**完整文本**: `docs/adr/0019-wiki-system-agent.md`（Status: Active；计划已落盘，代码待实现）

**Context**: v0.13 落地 MCP/skill 扩展系统（ADR-018）后，agent 不再限于内置工具。但"后端制造代码领域 wiki 知识库"这一场景需要专用 system agent——能扫描代码仓库、生成 wiki 卡片、渲染 MD，且能力隔离在单一 agent 身份内。用户在 `本地文学 wiki-mcp` 已有文学领域 wiki-mcp 实现（server/lib/data/visualizer 四层，MCP stdio，零外部依赖），提供可复用架构骨架。v0.13.1 将此骨架领域适配到代码领域（module/interface/function/class/pattern/concept 6 类型），并引入身份级守卫机制。

**Decisions**:

1. **D1 — wiki-mcp server 独立进程，MCP stdio 连接**: `src/mcp-servers/wiki-mcp/server.js` 是独立 Node.js 进程，通过 MCP stdio 协议与 harness 通信。复用 literature wiki-mcp server.js 主循环模式，注册 15 核心工具 + 2 新工具（`scan_codebase` + `render_md`）。harness 侧通过 v0.13 的 `bootMcpServers` 连接。wiki-mcp server 保持零外部依赖（纯 Node.js 内置模块）。**不把 wiki 逻辑混入 harness 核心 loop**。

2. **D2 — 上下文注入守卫（ctx.isWikiAgent）**: `registry.execute()` 入口对 `wiki__` 前缀工具检查 `ctx.isWikiAgent`，非 wiki agent 调用 → `throw`。`IMLoopOptions` 加 `isWikiAgent?: boolean`；`createSystemAgent` 在 name==='wiki' 时设 `isWikiAgent: true`。**不靠接线层约束**（toolRefs 过滤），靠运行时 ctx 校验——working agent 需要看见 wiki 工具 schema（才能委托），但不应该能直接调用。守卫走既有错误流（throw → loop.ts catch → 干净英文句子），**不新增熔断统计**（ADR-015）。

3. **D3 — 工具名前缀 `wiki__` 做命名空间隔离**: 所有 wiki-mcp 工具名以 `wiki__` 开头，与 v0.13 MCP server 工具命名（`serverName__toolName`）一致。`wiki__` 前缀同时是守卫的判别依据——`registry.execute()` 用 `name.startsWith('wiki__')` 识别需要身份守卫的工具。

4. **D4 — scan_codebase 工具提供路径指针能力**: `wiki__scan_codebase` 是 wiki-mcp 新工具（literature wiki-mcp 无此工具）：递归扫描代码仓库，读取关键文件（README / package.json / 入口文件），生成 wiki 卡片。当前是**轻量扫描**（文件名 + 导出 + 注释），AST 解析留未来。

5. **D5 — MD 渲染复用 literature wiki-mcp 管线**: `src/mcp-servers/wiki-mcp/visualizer/export-md.js` 复用 literature wiki-mcp 渲染管线，模板改为代码领域（6 类型各自 MD 模板）。`wiki__render_md` 读 data/ JSON → export-md.js → 写 output/wiki/ .md。

6. **D6 — 前端 API 契约 = 工具 schema，文档标注**: wiki agent 暴露的工具 schema 即为未来前端 REST/WebSocket API 的契约。计划文档（`docs/plans/v0.13.1-wiki-system-agent.md` §3）标注映射：`wiki__scan_codebase` → `/api/wiki/scan` POST、`wiki__generate_wiki` → `/api/wiki/generate` POST、`wiki__render_md` → `/api/wiki/render/:cardId` GET、`wiki__search_cards` → `/api/wiki/search` GET、`wiki__get_card` → `/api/wiki/cards/:cardId` GET。

**Rationale**: wiki 能力需要身份级隔离——wiki-mcp 工具注册在全局 registry（schema 全局可见），但执行权仅限 wiki agent。v0.13 的 `SubAgentToolPolicy` 管"子代理能调哪些工具"（命名空间治理），v0.13.1 的 `ctx.isWikiAgent` 管"哪个 agent 身份能调 wiki__ 工具"（身份治理），两者正交。复用 literature wiki-mcp 架构避免重写；领域适配仅需改枚举和模板。前端契约先行保证接口设计不滞后于实现。

**Consequence**: 计划已落盘（`docs/plans/v0.13.1-wiki-system-agent.md` + 本 ADR），代码待实现。实现后将新增 `src/mcp-servers/wiki-mcp/`（server.js + lib/ 4 文件 + visualizer/ + data/ + tests/）+ `src/im/system-agents/wiki-agent.ts`，修改 `registry.ts` / `loop.ts` / `system-agents/index.ts` / `system-agent.ts`。tests 数待实现后更新（当前仍 893/79，commit 仍 `206a5be`）。不引入新的 guard/metric/config 字段（ADR-015）；不改动 warehouse/compressor/recall 的 toolRefs；不改动 v0.13 MCP/skill 安全壳子。

---

## ADR-022: Tool Security + Search Enhancement (v0.15)

**Status**: Active (2026-09-01)

**Context**: v0.14 评审发现 agent-shell 工具安全是系统性短板：系统工具绕过 SecurityHook（无敏感文件检测、无危险命令、无审批）；grep 用 Node RegExp 性能不足；MCP server instructions 无净化。考察 AtomCode/Kimi Code/DeepSeek Harness 后形成方案。

**Decisions**:

1. **D1 — SystemSecurityHook 独立钩子数组**: 新增 `SystemSecurityHook` 类型 + `systemSecurityHooks[]` 数组 + `registerSystemSecurityHook()`。系统工具分支运行，不违反现有 `securityHooks` 契约。支持异步（审批 round-trip）。

2. **D2 — 读写路径分离**: `resolvePath`（write 用，不检查存在性）vs `resolvePathForRead`（read/ls/find/grep/edit 用，检查 + not-found hint）。

3. **D3 — 敏感文件检测 `isSensitivePath()`**: 纯零依赖函数，检测 `.env`/`id_rsa`/`.ssh`/`.aws/credentials` 等，含模板豁免和公钥豁免。

4. **D4 — 危险命令分类器 `checkDangerousCommand()`**: 纯函数递归分析 shell 命令，覆盖 rm -rf/curl|sh/dd/sudo/artifact 清理豁免。

5. **D5 — 人类审批机制**: `ApprovalStore`（grant scope 差异化：write 文件级、bash session 级）+ `createApprovalHook()`（300s 超时 fail-closed）。

6. **D6 — ripgrep 硬依赖**: 无 Node 降级，解析顺序 PATH → bundled → downloaded。找不到则 `RgNotFoundError` 含安装指引。

7. **D7 — MCP instructions 默认丢弃**: `mcpInstructionsMode` 配置（`discard`/`allow`），单点门控 `getInstructions()`。

8. **D8 — not-found hint 全局模式**: 突破 cwd 限制，但排除 home 目录防止信息泄漏。

**Rationale**: SystemSecurityHook 独立数组遵守现有测试契约；rg 硬依赖面向大代码库核心场景；审批 fail-closed 是安全底线；MCP 丢弃法参考 Kimi Code 保证可用性。

**Consequence**: 新增 6 源文件 + 8 测试文件，修改 8 现有文件。1166/1166 测试通过。

**v0.35 修订（2026-09-11）——分类器收 shell 方言参数**：D4 的 `checkDangerousCommand(command)` 改为 `checkDangerousCommand(command, shell: ShellKind = 'posix')`。理由：该函数被 `bash` 与 `powershell` 两个工具共用，而两 shell 在 `rm`/`del`/`curl`/`start` 上语义不同——不声明方言时，PowerShell 全漏（`Remove-Item -Recurse -Force` 判安全），而把 PS 表无条件并入 POSIX 表又会让 bash 侧 16 条既有用例误报（含 `rm -rf node_modules/` 等产物豁免）。door 与审批 hook 按工具名下发方言；同时补 `&`/换行分隔符、操作数后置 flags（`rm <dir> -rf`）、前导 shell 关键字剥离，以及内嵌 PS 宿主检测（`bash` 里写 `powershell -Command "…"` 不再能洗白）。

**v0.35.1 追加修订（同日）——PowerShell 判定从"取第一段命令名"改为结构分段**：v0.35 只取 `|` 之前第一段当命令名，而 PowerShell 的破坏性常来自**结构组合**——官方文档 Example 4 推荐的递归删除写法 `Get-ChildItem * -Recurse | Remove-Item`（递归参数在**上游**段）、`Remove-Item (Get-ChildItem -Recurse)`（括号子表达式）、`ForEach-Object { Remove-Item -Recurse -Force $_ }`（脚本块）三类全漏。现按语句/管道/子表达式/脚本块/here-string 切段后逐段判，并补 `-EncodedCommand`/`-e`/`-ec` 的 UTF-16LE base64 解码复判（解不出可读文本则 fail closed）。另新增**方言无关的 Windows 攻击面段**（`.NET TcpClient` 反向 shell、`netsh` 防火墙/端口转发、`vssadmin`/`wbadmin` 备份删除、`bcdedit` 恢复项、Defender `MpPreference` 篡改、`del/rd/rmdir /s`、`runas`/`takeown`/`icacls`/`schtasks`）——不做方言门控，因为门控只是制造绕过；并把 `runas`/`takeown`/`icacls`/`schtasks` 从 `PS_PRIVILEGE_TOOLS` 移出，避免同名条目两处登记产生不可达数据（ADR-015）。实测同一批 27 条判据由 8/27 升至 27/27。完整记录：`docs/plans/v0.35-powershell-dangerous-command-hardening.md` §11.6。

---

## ADR-023: v0.16 Security Extension + Phase 2 Tool Security Audit (2026-09-02)

**Status**: Active

**Context**: ADR-022 (v0.15) 立 SystemSecurityHook 为系统工具安全钩子。v0.16 用户拍板废弃它——与 SecurityRouter 并行会创建双轨审批路径，绕过 session 隔离。Phase 2 web_fetch / encoding / request_user_input 入注册表，3 工具与现有 SecurityDoor 工具集都不重叠。子代理审计 8 问：**6 ✅ / 2 ⚠️ / 0 ❌**。

**Decisions**:

1. **D1 — SystemSecurityHook → 注释保留**: 类型与字段保留为注释，`registerSystemSecurityHook()` 实现注释化。SecurityDoor 接管全部系统工具安全职责。任何新工具安全需求必须走 `registry.registerDoor()`，不得重新启用 SystemSecurityHook。

2. **D2 — SecurityDoor 4 项能力扩展**:
   - `fullPermission` 会话旁路门（`SessionSecurityState.fullPermission` + `SecurityRouter.check()` 早 return + `ApprovalStore.keyForFullPermission()`）
   - `release?(sessionId, toolName)` 可选钩子（`SecurityRouter.releaseTool()` 在 `finally` 块调用）
   - 会话生命周期：`getSession` / `getOrCreateSession` / `createSession({fullPermission?})` / `deleteSession`
   - `ctx.approvalStore?: ApprovalStore` 暴露（ToolRegistry.execute() 在 check() 后注入）

3. **D3 — createBrowserToolsDoor()**: 把 open_url / read_media 序列化到每 session 1 并发。`src/security/doors/browser-tools.ts`（新文件）。`release()` 释放槽。

4. **D4 — dangerous-command 递归强化**:
   - here-string `bash <<< 'rm -rf /'` → 提取 payload 重入
   - here-doc `bash <<EOF ... EOF` → 正则提取内容块重入
   - subshell ALL match — `$(...)` 不再只匹配第一个
   - echo/printf quoted payload — `$(echo 'rm -rf /')` 拆 quoted 重入

5. **D5 — bash BASH_TIMEOUT_CAP + fullPermission escape**: `BASH_TIMEOUT_CAP = 600` 秒。timeout 超 cap 时通过 `ctx.approvalStore?.isGranted(ApprovalStore.keyForFullPermission())` 判断；fullPermission allow，否则 deny。CI / 批处理场景的 escape hatch，但 session 隔离仍保留。

6. **D6 — ProtocolError retry**: `MAX_PROTOCOL_ERROR_RETRIES = 3` + `PROTOCOL_ERROR_RETRY_BASE_MS = 1000`（指数退避）。SSE 长连接抖动自动重试，避免 终端用户高频痛点。

7. **D7 — Phase 2 工具安全审计结论**:
   - `web_fetch` (category=read) 经 SecurityRouter 但不命中现有门；SSRF 防线在工具内部 `validateUrl`/`isSafeIp`/`BlockList` + DNS pin
   - `request_user_input` (category=command) 经路由器无门命中；`ctx.requestHandler` 缺失视为 caller 配置错误而非安全门
   - `encoding` (内部增强) 复用既有 read/edit 类别，sensitive-path + write-approval 仍生效
   - 子代理审计 8 问 6 ✅ / 2 ⚠️ / 0 ❌

**Rationale**: 单一权威胜过双轨并行——SystemSecurityHook 与 SecurityRouter 并行会随时间漂移出不一致行为。注释保留是为未来维护者留指针。fullPermission 是 bash 的合理 escape hatch；session 隔离仍保留（不能全开）。Phase 2 三个工具"不命中现有门"是有意的，硬塞进 SecurityDoor 反而扭曲概念——审计明确这一点后写进文档。

**Consequence**: 新增 4 源文件 + 19 文件修改；3 commit 按依赖顺序串行（定义层 / 接驳层 / 实测+修复）。1360/1360 测试绿，0 回归。两个 ⚠️ 缺口在本节末登记为 G1 / G2。

---

### 已知缺口 / 未决问题（ADR-023 附录）

#### ⚠️ G1 — request_user_input handler 缺失时只在工具内部 throw

- **症状**: caller 忘记注入 `ctx.requestHandler` 时，工具 throw `request_user_input: no request handler configured`，走 wrapTool → loop.ts catch → LLM 看到错误
- **严重性**: 低（不是安全 DoS，无资源耗尽，仅质量降级）
- **当前选择**: plan §4.3 明确"tool 层不硬编码 UI；handler 缺失视为 caller 配置错误"
- **建议改进**（不在 Phase 2 范围）: caller 包装器（宿主应用/TUI）启动前 validate——当 `request_user_input` 在 `systemToolRefs` 但 `IMLoopOptions.requestHandler` 未设时 fail-fast 给清晰提示
- **跟踪**: 等待 宿主应用集成时反馈

#### ⚠️ G2 — web_fetch 不在 BROWSER_TOOLS 集里

- **症状**: web_fetch 与 open_url 可并发
- **严重性**: 信息性（无真实竞态，session 隔离完好）
- **当前选择**: web_fetch 是服务端 HTTP（无浏览器副作用），与 open_url（客户端浏览器启动）无冲突
- **建议改进**（不在 Phase 2 范围）: 未来想统一"所有外部输出工具"并发语义时把 `web_fetch` 加入 `BROWSER_TOOLS`（一个常量改动）
- **跟踪**: 等待真实 LLM 流量数据

---

## ADR-024: 提示词工程设计决策 (v0.19)

> Status: Active
> Date: 2026-09-03
> Full text: `docs/adr/0024-prompt-engineering-decisions.md`（编号已于 2026-09-11 对齐：文件初编为 0023 与 ADR-023 撞号，现文件名与 ADR 编号一致）

**Context**: 对标 KimiCode / AtomCode / pi-agent / Claude Code / Codex / OpenClaw 6 个项目后，用户做出提示词工程设计决策。

**Decisions**:

1. **D1 — 分层配置注入**: system prompt 支持四层配置（managed → user → project → local），后层覆盖前层。配置层注入为 user message 而非 system prompt，模型遵循但保留判断空间。

2. **D2 — Project 层包含架构描述**: 项目配置层必须包含当前架构描述、可升级配置、可扩展配置。让 LLM 写代码时理解架构上下文，做出符合项目结构的设计决策。

3. **D3 — 系统提示词强制: 高内聚低耦合**: 写代码时必须符合高内聚、低耦合原则——同一模块内职责集中，模块间通过明确接口通信，新增功能优先在现有模块内扩展。

4. **D4 — 系统提示词强制: 基于代码信息编程**: 遇到不确定的 API 行为先看源码不猜测，遇到不确定的类型定义先读类型文件不假设，修改代码前先 read_file 看过原文，commit 前必须跑 tsc 和 vitest。

5. **D5 — 系统提示词段落化**: system prompt 拆分为独立段落，**不刻意维护缓存边界**。理由：我们用 OpenAI 兼容 API（ARK），没有 Anthropic 的 prompt caching；我们的结构天然保持前缀稳定。三种模式：full / minimal / none。

6. **D6 — Auto Memory 系统**: 新增跨会话结构化记忆（4 种笔记类型：user / feedback / project / reference），与 M1/M2/M3 压缩互补。压缩解决 token 上限，记忆解决知识保留。

7. **D7 — 工具自描述扩展**: 在 ToolDefinition 中新增可选 `parallelSafe` 字段，扩展 executeToolCalls 的并发分组策略。不引入新概念，只扩展现有类型。

8. **D8 — 通用事件钩子（纳入 v0.19 计划）**: 通用事件钩子（SessionStart / PreToolUse / PostToolUse / SessionEnd），可观测性是 production 的必要能力。价值：审计日志、动态上下文注入、错误恢复策略。与现有 SecurityHook / SystemSecurityHook 并行，不互相替代。
9. **D9 — 系统提示词纯中文**: 用户选择纯中文作为系统提示词语言，工具名和代码术语保留英文。
10. **D10 — 行动导向均衡**: 直接执行明确指令，架构变更或破坏性操作时确认，每次修改附三句话总结。
11. **D11 — 上下文注入 Hook 化**: loop.ts 硬编码的动态内容注入改为 ContextInjector hook 驱动。新增注入源 = 新增文件 + register()，不改 loop.ts。逐个迁移，每迁移一个跑回归。
12. **D12 — 架构描述是运行时功能**: 不是静态提示词段落，而是 harness 运行时扫描用户代码库后动态生成。与 v0.13.1 scan_codebase 配合，LLM 自主决定扫描范围并生成架构描述注入上下文。

**Rationale**: 基于 6 个项目的对标分析，核心理念：提示词不是静态文本，而是分层、可配置、可记忆的系统。

**Consequence**: 新增 `src/im/prompt-layers.ts` + `src/im/prompt-sections.ts` + `src/im/memory/auto-memory.ts` + 记忆工具。系统提示词模板更新。

---

## ADR-026: Signal Gate — 信号关（前后端信息流唯一管理点）

**Status**: Active (2026-09-06)

**Context**: 用户拍板自产前端壳（v0.22）。做前端之前必须先回答：前端需要的信息怎么流出状态机、需要前端参与的功能怎么接回状态机。现状 = 状态机是宝贝不可耦合（对外只有 Hook 点）+ 部分功能自备信号发射器沟通前后端（rendering 的 RenderingSignalBus、approval stub、request_user_input handler、logger sink、StateLine notify）。**发射器散落在功能里 = 跨边界信息流散落在功能里，没有被管理。**

**决策时的思考（用户拍板记录）**：
1. **信号关 = 信息流唯一管理点**——收编散落的发射器到一个统一管理点，信息流第一次可被统一观察/路由/记录/重放。
2. **否决线一句话**："所有想要耦合到我的宝贝状态机上的都不行，最多就是给你 Hook 点用，再加上部分功能自备一个信号发射器来沟通前后端。"
3. **两类东西都必须走信号关**：需要前端的功能（审批/提问 = **前端提供的服务**，需请求-应答语义）连接进信号关；需要前后端流转的信息流也走信号关。共用一套路由/超时/鉴权/归属语义，拆两条管线会写两遍并漂移。
4. **出站信号统一收口**——渲染产物也是出站信息不特殊，一律在 Gate 收口，前端只认 Gate 一个出口。

**Decisions**:

1. **D1 — Signal Gate = harness 自身信息流管理点，非插件系统**: 收编 18 个交互挂点为三种通道（出站事件 / 请求-应答 / 入站命令）。核心哲学第 6 条：hook 是信息流接缝，不是第三方插件 API。

2. **D2 — 前端与状态机之间只有信号关系**: Signal Gate 是唯一双向中转站。接线器订阅状态机既有挂点（Hook 点 + 发射器）→Gate；Web 层只做翻译。凡是想耦合到状态机的都被这道门挡在外面。

3. **D3 — Gate 纯内存可独立测试**: `createSignalGate()` 纯函数，只维护 subscribers/pending/sessions。Web 层是通道适配器之一（未来 ACP 可复用同一 Gate）。

4. **D4 — 单向依赖**: 状态机不认识 Gate（`onStreamChunk?` 可选回调，默认 undefined 零行为变化）。Gate 主动订阅。

5. **D5 — 审批只换 handler（前端服务接入信号关第一例）**: extensions.ts stub 替换为 `createGateApprovalHandler`。判定/grant/fail-closed 语义留在既有链路，Gate 只替换"问人"这一环。

6. **D6 — 渲染基座降级为 Gate 一级（出站信号统一收口）**: bus → Gate → base.handleSignal。渲染不特殊，所有出站信号在 Gate 收口。

7. **D7 — Web 层 `ws@8` + `node:http` 纯翻译**: `ws` 只进 webshell，库核心零依赖。同端口路径分派。Web 层不含业务。

8. **D8 — 断线恢复 = 内存 seq 游标 + 越界全量重拉**: 500 帧 ring buffer，不落盘 journal（本机 127.0.0.1 断线罕见，官方持久 journal 是远程模型）。

9. **D9 — Bearer token 鉴权**: `randomBytes(32).base64url`，fragment 传递。WS 用子协议字段。timingSafeEqual。

**Rationale**: 核心思想是信息流管理不是功能管理——信号关是"前后端边界"上该思想的正面落地：跨边界信息流有唯一管理点，状态机纯净（宝贝不可耦合）与信息流可管理（散落发射器收编）同时成立。

**Consequence**: 新增 `src/signals/` + `src/webshell/`。状态机改动最小（3 文件各 +1 可选字段）。extensions.ts 未改动。1772/1772 测试绿，0 tsc 错误。不新增 guard/metric/config 字段（ADR-015），不引入第三方插件 API，不改 compose/projection。完整文本：`docs/adr/0026-signal-gate.md`（含完整思考链 + 信息流架构图）。

---

## ADR-020: Observability Contract — structured logger 是一等 harness 面 (v0.14)

> Status: Active (2026-09-01)
> Full text: `docs/adr/0020-observability-contract.md`

**Context**: v0.13 评审发现可观测性是系统性短板。最严重一条：`runIMLoop` 以 fire-and-forget 调 `driveCoordinator.tick()`（`void` 丢 Promise），压缩管线失败只能靠 `mailbox.systemSend` 通知——而 mailbox 投递本身可能失败，失败时**整条压缩事件静默丢失**。全库无 structured logging（仅 3 处 `console.warn`），无法回答"哪一轮 token 突增""压缩为何没生效"。

**Decision**:
1. **Logger 是依赖图最底层的 shared 模块**——`src/shared/logger.ts` 与 `json-schema.ts` 平级，零 import，任何层可用，不破坏三层职责。5 级 + 数值阈值 + 可替换 sink（默认 stderr NDJSON）+ pino 风格 `child(bindings)`。
2. **`level`/`ts`/`msg` 永远由 emit 函数控制**——caller 传了 `level` 也无效（`.info()` 就是 `info`），防 caller 伪造级别。
3. **必保事件清单（删除即违反）**：`runIMLoop start/completed`、`guard tripped`（含 hits + finalMetrics）、`protocol error`、`shell terminated`、`tool errors in round`、`driveCoordinator.tick unhandled rejection`、压缩 dispatch start/ok/failed/skipped、M3 archive dispatch、`mailbox notice failed`、stateLine appendBlock/appendSummary/rawArchive ok/failed。后续 PR 不得删除或降级；新增子系统须至少 emit 一条结构化记录。
4. **mailbox 与 logger 双轨**：mailbox 是 user-facing 通知，logger 是 dev-facing 证据；所有 `systemSend` 点包 try/catch，失败 → `logger.error` → 主流程不受影响。
5. `IMLoopOptions.logger?` 可选注入，未传行为不变（默认阈值 `warn`）。
6. Logger 公开导出（`src/index.ts`），外部 caller 可接进自己的 ELK/pino/OTel。
7. `IMLoopResult` **不加 `rounds` 字段**——需要每轮 metrics 就注入 trace logger 自己聚合，保持既有测试 expect 模式不动。

**Consequence**: 测试 899 → 974（48 条直接验 logger 契约）。代价：测试期 stderr 出现大量 error 记录（error 路径的预期输出），fixture 应 `setSink(() => {})`。已知残留：state-line 的 stamp/block 双文件写入仍是两次独立 `appendFile`，SIGKILL 可能留孤儿 stamp——现在能被观测到，根治（fsync + 二阶段提交）属后续版本。

---

## ADR-021: MemoryConfig + maxSubAgentDepth — 魔数变为 caller 可配 (v0.14)

> Status: Active (2026-09-01)
> Full text: `docs/adr/0021-memory-config-and-sub-agent-depth.md`

**Context**: 两个阈值硬编码在模块常量里，所有调用方共享同一数字：`MEMORY_LAYER_THRESHOLDS = {M1:200K, M2:500K, M3:900K}`（测试想用小阈值验分层行为做不到）；`MAX_SUB_AGENT_DEPTH = 3`（调整要改源码）。

**Decision**:
1. **`MemoryConfig` 是独立类型，不是 ShellConfig 字段**——ShellConfig 是 runtime guard 配置（ADR-003 "shell 无业务字段"），MemoryConfig 是信息流分层配置，混在一起耦合无关关注点。放 `src/shell/memory-config.ts`（分层投影本质是 shell 层关注）。
2. **`classifyMemoryLayer(tokens, config?)` 双参签名**，默认 `DEFAULT_MEMORY_CONFIG`（原子迁移，单参调用行为不变）。`memoryConfig` 经 `IMLoopOptions` → `buildContextProjection` + `DriveSnapshot` **两处贯穿**——两个 layer 判定点必须看到同一份配置，否则投影认为 M0 而协调器认为 M1，精神分裂。
3. **`maxSubAgentDepth` 进 ShellConfig**（递归上限是 runtime guard 语义，不是信息流配置），默认 3。三级优先级：子代理 cfg override → deps.defaultConfig → DEFAULT_CONFIG；子代理**只能调低**（`validateShellConfigOverrides` 约束 ≤ DEFAULT）。
4. `RunSubagentDeps.defaultConfig` **可选**（偏离计划草案的必填）——可选 + DEFAULT 兜底让既有测试 helper 零改动。已知边界：极少数不传 defaultConfig 又自定义了深度的 caller，其自定义值对子代理不生效。

**Consequence**: 测试可用小数值验分层（memory-config 5 条 + memory-layers-custom 5 条 + depth-config 9 条）；不传新字段的 caller 与 v0.13 完全一致；`src/index.ts` 导出 `MemoryConfig`/`DEFAULT_MEMORY_CONFIG`。

---


## ADR-025: Hook 体系修复 — 死代码复活、并发分桶、渲染基座缺陷 (v0.20)

> Status: Active (2026-09-04)
> Full text: `docs/adr/0025-hook-system-repair.md`

**Context**: v0.20 修复了 hook 体系一系列系统性短板：① `executeToolCalls` 用硬编码 `MAX_CONCURRENT_TOOL_CALLS = 2` 覆盖了 `ToolCategory` 自描述系统（read=5/write=3/command=3 的设计值从未落地）；② `SessionLoopBase` 缺 hooks/hookSystem/contextInjector 字段 → 三个 hook 机制**结构性无法接线**；③ 渲染基座 P1 双 store 404 / P2 reminder 击穿 JSON / P3 重复 handle；④ `renderInline` 有 XSS（`javascript:` 链接未过滤）；⑤ `systemSecurityHooks` 是 v0.15→v0.16 迁移后的空壳。

**Decision**:
1. **并发分桶把注释变成代码**——废除硬编码 2，`CONCURRENCY_LIMITS = {read:5, write:3, command:3}`，`executeToolCalls` 按 `registry.getToolCategory(name)` 分桶：批内 `Promise.all` 并行、批间串行；输出 turns 按原始下标排序（LLM 配对依赖顺序）。
2. **SessionLoopBase 补齐 hook 字段** + 8 个 drift 字段（dynamicSchemas / toolPolicy / compressZone / signal 等），`buildLoopOptions` 显式转发（不转发 = 静默丢失）。
3. **渲染基座修复** P1 共享 `deps.rendering.store`、P2/P3 按 id 去重、**XSS 加 `safeHref()`**（entity-decode → lowercase → 白名单 http/https/mailto/#/相对路径 → 其余变 `#`）。
4. **删除 `systemSecurityHooks` 空壳**（字段 + 注释掉的注册方法 + 死循环）——保留只会让人以为这里能注册 hook，实际应走 SecurityDoor。
5. **wiki guard 双注册保留**（extensions.ts 与 wiki-agent.ts 各一处，谓词相同、重复无害；删任一处都会留下安全缺口），只修正误导性注释。
6. **PostToolUse 失败路径不 emit**——工具层 `wrapTool` 已做错误兜底 + error turn + errorCount，hook 再观察一次是重复做功，且 handler 抛错会击穿循环。
7. powershell 超时 cap 对齐 bash（`POWERSHELL_TIMEOUT_CAP`）。

**Side finding（对标结论，仍有效）**：考察 KimiCode（PermissionManager 优先链）、AtomCode（ToolMiddleware 责任链）后确认三种安全语义各有适用场景——**agent-shell 的 deny-override（所有 door 全跑全查，任意 deny 阻断）是最保守的**，适合"多安全维度任一不过即阻断"。

**Consequence**: 全量 1714/1714 绿（+5）；渗透测试 20/20 PASS（发现并修复 1 个真实 XSS）；前端视觉 23/23。后续任务 T7（SecurityRouter 状态下沉 registry）/T8（`parallelSafe(args)` 逐参数并发判定）当时记账未做。

---

## ADR-028: 数据落盘与用户知情 — args 随落盘全量保留 (2026-09-09)

> Status: Accepted (2026-09-09) · **Supersedes**: v0.24 拍板的"args 不落盘"
> Full text: `docs/adr/0028-args-persist-and-user-agreement.md`

**Context**: v0.24（09-07）曾拍板 `ToolTurn.args` 只活在内存、不落盘不进 prompt（动机：assistant turn 已含参数原文、敏感内容明文扩散、前端恢复不依赖它）。09-09 核查落盘数据时发现**隐藏代价**：落盘剥离导致 **recovery 恢复后内存 Databus 的 args 恒为 undefined**——databus 的消费方是 LLM 侧的工具活动理解（`databus_query`、压缩管线、子代理工具史），"调了 write"与"调了 write 写了什么"是两个信息量级；热路径带 args、恢复路径不带，同一会话前后行为不一致。

**Decision**:
1. **撤销 v0.24 剥离**——`persistTurn(tr)` 原样落盘，conversation.jsonl 与 databus.jsonl 的 tool 行均带完整 args。
2. **"冗余"论点只在渲染视角成立**——databus 的语义契约是工具事件完整记录（call 身份 + 参数 + 结果），背后没有 assistant turn 可兜底。
3. **敏感内容取舍不替用户决定**——落盘范围（明文 / TTL / 谁可访问 / 安全边界）写进 `docs/用户协议须提及.md` 作为正式用户协议必提 checklist；删除会话 / 手工清理 `~/.databus/sessions/` 是当前退出选项。
4. v0.24 的 wire-format 决策（args 不进 prompt 序列化）**不受影响**——落盘与上下文估算两条路径独立。

**Consequence**: 磁盘多一份 args 副本（含 write 全文），接受（换来"完整工具史可召回"）；恢复路径与热路径行为一致；`tests/im/loop-args-boundary.test.ts` 断言翻转为"落盘带 args 且与内存一致"；当时全量 2185 tests 绿。

---

## ADR-029: per-session 权限独立 + permission.changed 推送 (v0.22 方案 B)

> Status: Accepted (2026-09-07)
> Full text: `docs/adr/0029-per-session-permission.md`

**Context**: v0.22 的权限控件是**全局广播**（`permission.full` 无 sessionId，宿主遍历全部 openHandles 统一设置），前端本地乐观显示（无出站信号、无查询命令）。09-07 核查"前端切权限对会话是否实时"时暴露三重边界：只覆盖已打开会话（新开会话不受影响）；前端显示 ≠ 后端真实状态（刷新后失配）；已挂起审批不受切换影响（语义正确但需文档化）。

**Decision**（方案 B：push 信号）：
1. **每会话权限独立**——`permission.full` 加 `sessionId`，`setFullPermission(sessionId, enabled)` 只作用于目标会话（未打开抛干净错误）；**全局广播删除**。
2. **state push 同步**——新增出站信号 `permission.changed { sessionId, full }`；宿主在 `session.open`/`session.create` 完成后推送（**含对已打开会话的幂等推送**——必须放在 open handler 层而非 attachHandle 内，否则"标签页 B 打开已打开会话"拿不到状态）；变更由**状态持有者（宿主 handler）**emit，gate 保持纯路由。
3. **前端删本地乐观**——store 加 `SessionView.permissionFull` 忠实投影信号，UI = store = 后端事实源，刷新/多标签页天然同步（"UI 是信号的忠实投影"的权限版）。
4. **不提供 pull 命令**（否决 `permission.get`）——权限是低频操作，open/create 推送 + 命令回执推送两个时机都有信号，pull 冗余且破坏"只 push"的对称性。
5. **边界**：已挂起审批不受权限切换影响（仍需用户回包，fail-closed 兜底）——"切换自动放行挂起审批"是假实时，不做。

**Consequence**: 控制与存储一致（存储层本就 per-session）；库 1876 tests 绿 / webapp 71 绿 / 双 tsc 0 错。

---

## ADR-030: 安全二分 — 整体安全在 shell（二楼），工具安全在 im/tools（三楼）

> Status: Accepted (2026-09-07)
> Full text: `docs/adr/0030-security-dichotomy.md`

**Context**: 架构审查发现 `src/shell/` 对 `src/im/tools/` 有 3 条 import（registry → helpers 的 reason 校验/报错翻译/结果截断 + approval-store 审批记账本；compose → reasonField 规则文本），按"shell 不 import im"的字面楼规曾被误判为"历史遗留违反"，并一度建议搬家下沉到 shared。

**Decision**（用户否决该定性，给出根因性判据）：**安全分两类——整体安全在 shell（二楼），工具安全在 im/tools（三楼）**。
- **整体安全**（会话怎么安全跑完：guard / 预算 / 终止条件 / 状态机）→ shell；
- **工具安全**（单个工具调用怎么把关：reason 校验、报错翻译、结果修剪、审批记账）→ im/tools；
- 因此二楼工具登记册引用三楼工具安全零件是**符合分层意图的刻意设计，不是债，不搬家不下沉**。
- **边界纪律**：shell → im 的引用**只允许**落在 `im/tools` 的工具安全零件上；一旦引用 im 整体安全（loop / guards）、会话、记忆投影等业务层，即越过边界属真违反。引用面恰好封顶 3 条，可复验：`grep "from '../im" src/shell/*.ts`。

**Consequence**: 3 条 import 保留；AGENTS.md 中"shell 零 im import"改为"shell 允许引用 im/tools 的工具安全零件"；分层审查判定框架更新——"跨层 import"结论必须区分**工具安全引用（合法）**与**业务引用（违规）**，不能只看路径字面。零代码改动。

---

## ADR-031: 工具级压缩 + 交接笔记压缩 + warehouse 持久会话 (v0.30/v0.31)

> Status: Accepted (2026-09-09) · 决策者：用户逐项拍板，主代理按铁律先列状态机触点清单、逐点获准后实施
> Full text: `docs/adr/0031-tool-compression-and-system-agent-memory.md`

**Context**: v0.29 验收发现三组问题：① 压缩只在工具轮末 fire、completed 不 fire、块判定要求 ≥1 工具轮 → **纯文本会话永远无法压缩**，会话收尾无法压缩；② 单轮工具结果可引入数十万 token（实测 P99 单条 72K、最大 4 条占 88%），M 层压缩是"事后块级"，tools 堆积到跨阈值前没有算法级缓解；③ 子代理/系统智能体全链无压缩（长任务超阈值 = guard-tripped 丢工作），warehouse 单发 fresh 无法跨唤醒保持上下文。对标：KimiCode 是唯一有完整压缩参考的实现——自由文本第一人称交接笔记、0.85 窗口触发、用户消息逐字保留。

**Decisions**（摘要；完整 11 条见全文）：
- **D1 压缩调度统一每轮一次**——fire 从两处收敛到 finalizeRound 之后一处，覆盖全部轮型；tick 喂值改用协议层真实 usage（轮初估算仅 fallback）；顺带修掉"`createMetrics` 的 0 被当已知值 → 首轮估算恒为 0"的盲区（0 = 未知）。**不引入新 guard/metric/config 字段**（ADR-015）。
- **D2 块判定放宽**——user→next-user 跨度本身就是块，去掉"≥1 工具轮"硬条件；`validatePairing` 保留防半块。
- **D3 历史工具表（工具级算法压缩）**——canonical 工具回合超热窗口 20 后，窗口外 `result > 100 token` 的**完整批次**折叠成一条 markdown 表（`reason | tool | result` 前 100 token）；**纯算法不调 LLM**；**databus 不动**（原始事件保留供关键字召回，用户拍板）；执行点 = HOOK 5 afterToolExecution；实测压缩率 34x–3873x。
- **D4 交接笔记压缩**——KimiCode 式：`shouldCompact`（0.85×窗口）→ 序列化时间线 → LLM 生成第一人称笔记 → 原位 `replaceRange` 折叠；用户消息逐字保留（head 2K + tail 18K，中间丢弃计数如实告知 LLM）；摘要请求自身有 300K 预算并上报 droppedCount。装配在 `createSystemAgent` 的 `opts.compaction`（beforeShellCall，**不复用 mergeLoopHooks**——它会丢转发的 beforeShellCall）；覆盖子代理 / warehouse / recall，compressor 不装。
- **D5 warehouse 持久会话**——`createSystemAgent` 加 `persistent?: boolean`，跨 run 保留 conversationMemory/databus；JSONL 原子重写（tmp → rename，旧文件留 .bak）；跨 run usage 经 `initialMetrics.lastRequestTokens` 传递（否则中文低估 3–6x 会让压缩不触发）。只 warehouse 开 persistent。
- **D7/D8/D9/D10（v2 用户第二轮拍板）**——D7 工具表折叠统一装配在工厂（子代理与系统智能体同享）；D8 **系统智能体私有 databus 也完整落盘**（"他们的信息才最宝贵"，私有 bus 是它们唯一的工具活动记录）；D9 **mailbox 修法 A**：系统智能体注册进 agentTree（此前 `verifyRoute` 对未知发送方 fail-closed，warehouse/compressor/recall 的 LLM-facing `mailbox_send` **全被拒绝**，"回复邮件"在完整装配下不存在）；D10 压缩失败自动重试 3 次 / 间隔 15s，仍失败则分级上报（系统智能体走 mailbox、子代理通知调用者）。
- **D6 铁律遵守方式**——全部状态机触点（fire 时机、completed 路径、喂值、块判定、HOOK 5 canonical 修改权、beforeShellCall 折叠）逐项列请示清单、用户逐点批准后实施。

**Consequence**: M 层压缩从"工具驱动"变"对话驱动"（纯对话会话可压缩）；工具历史在上下文里变成可检索摘要、细节 100% 从 databus 召回（databus 权威、表是索引）；子代理长任务不再以 guard-tripped 丢工作。测试 +6 文件 → 2207 绿，v2 后 2215 绿 / 190 文件 / tsc 0 错。已知限制：工具表折叠只装配在工作代理 loop（子代理靠交接笔记兜底）；warehouse 落盘文件不参与会话删除的孤儿清理；交接笔记失败静默重试。

## ADR-032: 文件可恢复（file-history 快照 + session.rewind）(v0.36 / v0.36.1)

**Decision**: 给工作区文件加「写前留底 + 用户回滚」。v0.35 的安全面全是**拦截型**（危险命令分类器 / 敏感路径门禁 / 写审批），它们回答"这件事要不要做"，不回答"做错了怎么办"。用户 2026-09-11 拍板方向："安全的本质是可恢复——AI 改错了代码，用户能撤销即可；真正无解的是 AI 删库。"实证缺口：write/edit/search-replace 全是裸写，仓库里的 `.bak` 只保护宿主自身状态，用户工作区文件零保护；既有 `/undo` 只撤对话回合、不碰文件。

**D1 保护范围按"有没有别的撤销机制"划，不按"重不重要"划** —— 白名单 = 代码 + md/html/css + 结构化文本 + Makefile 等无扩展名常客；**docx/xlsx 刻意放弃**（zip 包被 AI 改一次基本整块重写，快照无信息量，而 Office/WPS 自带版本历史），反过来代码文件没有任何默认撤销机制。目录黑名单（node_modules/.git/dist…）+ 敏感文件（复用 `isSensitivePath`）一律不进快照库——快照绝不扩大凭据落盘面。

**D2 内容寻址 + 四道闸门同批交付** —— 对象按 sha256 命名（同内容只落一份）；单文件 2MB / 索引 2000 条 / 总字节 128MB / LRU + 对象清扫。对标：AtomCode 的 Code Rewind 正是**因磁盘占用在 v5.0.5 被禁用**，所以配额不是后续优化，是功能的一部分。

**D3 旁路但不静默** —— 快照失败不抛（写盘才是用户要的事），但 `recordInner` / `prune` / `rewind` 的失败路径都出 `logger.warn`（组件名 `file-history`）。v0.36 首版是空 catch，v0.36.1 补上：Windows 上 rename 被占用导致的 prune 静默失败，曾让"没回收"看起来像"一切正常"。

**D4 回滚权只在用户手里** —— LLM 不持有 rewind 工具；入口是 gate 命令 `session.rewind`，网页端按钮发 `{ sessionId, entries: 'last-turn' }`，宿主换算条数并执行。前端**不直连磁盘、不自己数快照**（记录在宿主侧）——一切走信号关。CLI 不做 `/rewind`（用户 2026-09-12 裁定：本功能只在网页端上线）；后端能力保留，将来加 CLI 入口只需一个 slash 命令调同一条 gate 命令。

**D5 三组结果分开报，不假装成功** —— 回执 = `{ restored, deleted, unbacked, entries }`，不是一个"完成"。`unbacked`（当时超限、无内容副本）必须如实上报。工具层同理：`write`/`edit`/`search_replace` 在"确实写了但没留底"时追加一行提示（`snapshotGapNotice` / `summarizeSnapshotGaps`），把设计边界**显性化**，而不是悄悄扩大保护范围。

**D6 索引写串行化（v0.36.1 P0-1）** —— `writeIndex`（read → 写 tmp → rename）与 `appendIndex` 交错时，append 可能落在**已被 rename 掉的旧 inode** 上 → 记录消失（Node 单线程使窗口仅在 await 边界，概率低但非零）；Windows 上更常见的表现是 rename 被占用而 EPERM → prune 静默不回收。修法 = 实例内 `withIndexLock`（Promise 队列）串行化**索引**读写（对象写入幂等，不串）。**不做**跨进程文件锁（单进程多实例，冲突窗口极小且后果仅丢单条记录）。

**D7 `'last-turn'` 是刻意选择的近似** —— 快照记录没有 turn 标识（`record` 由工具层调用，拿不到 loop 的 turn 边界），只能按时间簇聚类：从最新一条往回走，相邻两条间隔 > 10 分钟即认为跨了 turn。偏差两边都有（同一 turn 内停手超 10 分钟 → 少撤；两个 turn 挨得近 → 多撤），可接受的理由是按钮语义就是"撤掉刚才这批改动"，且结果面板逐条列出**具体撤了哪些文件**。无记录时返回空结果而非报错（前端自然落到"没有可撤销的改动"）。

**Consequence**: 用户获得"AI 改坏代码可一键还原"的能力，且**不依赖**用户会 git、**不依赖** OS 沙箱（Windows 同样可用）——与沙箱路线正交（沙箱管"跑不出去"，快照管"改错了能回来"）。代价：磁盘占用受四道闸门约束；`record` 会再读一次源文件（2MB 以内的文本可接受）。与 `session.undo` 正交（撤对话 vs 撤文件），可单独或组合使用。**明确不做**：跨进程文件锁、prune 按会话分组回收（配额是**全局资源**语义，对标 mimo-codex 的全局 MAX_SNAPSHOTS）、保留 unbacked 记录（无副本，留着也不能还原）、rewind 中途崩溃一致性（索引删除在还原循环之后，已确认无部分回滚窗口）、docx/xlsx 纳入保护、"删除只进回收站"（用户指定上线前再定；tradeoff：会废掉"帮用户清理磁盘"类任务——回收站不清空即不释放空间）。完整论证见 `docs/adr/0032-file-recovery-and-rewind.md`。

## ADR-033: 提示词模型族路由（唯一基底 + 双槽位）(v0.37)

**决策**：`FULL_PROMPT_TEMPLATE` 只有一份，模型族差异只允许落在两个可注入槽位——`{persona_section}`（首行）与 `{workflow_section}`（工具披露之后）。`resolvePromptVariants(modelId)` 按 id 子串路由（deepseek / glm），未命中回落通用段（通用段本身也是 minimax 提炼版，所有模型默认升级）。其余段落（安全 7 条 / 编码原则 / 代码信息驱动 / **双工具披露** / 行动策略 / 架构与记忆契约 / 注入防御）**唯一一份，变体结构上不可覆盖**。

**为什么**：上一版"整份模板变体"是**从通用模板派生**的副本，三重病：① 死代码（装配层从不传 `modelId`，148 行零消费者）② 复制时丢失 `# Architecture Management` / `# Memory Management` 两节契约（注入源只裸贴文件内容、不带维护指令，兜不住）③ 安全规则 7 → 5/4 条。**新结构把"变体不许削安全、不许丢契约"从纪律变成结构约束**——没有第二个副本可以走样。

**可照搬 MiMoCode 的只有两样**（用户拍板）：人格设定（取自 `prompt/minimax.txt`，含 "You are not a chatbot. You are an engineer with a keyboard and a deadline."，已剥掉 Bun / CLAUDE.md / question·actor·task 等宿主专属约束）与 workflow 阶段结构（Orient → Plan → Execute → Verify → Report）。**刻意不搬**：Explore 15 次硬限（数字无依据，改为可检查条件）、Git Safety 段。**工具双披露 / 安全设计 / 文件注入与维护机制一律自研保留**（用户判断双披露"表现更好，模型更清楚自己具备什么能力"）。

**接线点**：`src/host/assembly.ts:779` → `buildStaticPrompt({ ..., modelId: attachPlan.model })` → `src/im/prompt/section-builder.ts:47` → `resolvePromptVariants` / `selectPromptTemplate`。

**全文**：`docs/adr/0033-prompt-model-family-routing.md`；计划 `docs/plans/v0.37-prompt-model-family-routing.md`。

## ADR-034: 委托授权段——提示词镜像运行时授权 (v0.40)

**决策**：`subAgentNesting` 开关开启时，提示词注入委托授权段（prompt 只镜像运行时实际授予的能力）：FULL 在人格段之后注入 `{delegation_section}`（授权声明 + 树规则：深度 3 / 独立 loop·上下文 / define_subagent 会话级）；MINIMAL 的"禁止嵌套"行条件化——**子代理**持有 `run_subagent`（toolRefs 白名单 ∩ effectiveToolPolicy）才翻转成"授权 + 完整委托教学"（向 FULL 看齐，不是一句"你被授权了"），未授权则保留逐字原文。**子代理不读全局开关**（per-config policy 下读开关会谎报授权），读的是授权链解算后的最终事实。

**为什么**：原 MINIMAL 无条件禁止嵌套 = 提示词比运行时更严的硬矛盾（开关 ON 授权了工具、提示词却明令禁止，弱模型照做拒绝嵌套，授权静默失效）。判定谓词与子代理 loop 的 load_tools 过滤同构，从结构上消灭"提示词说有、运行时没有"。

**同源**：`createHostAssembly` 新增 `readSettings` 单入口（`settingsHomeDir` 测试缝），toolPolicy 判定 / 提示词条件 / Gate settings.get 三处共用——漂移面为零。**信号关零新增通道**：开关写入走既有 `settings.set` 命令，结果走既有 `system.prompt` 出站事件；attach 快照语义保持（**非热更新**，host 重启后新会话生效）。

**接线点**：`src/host/assembly.ts:810`（FULL 条件）→ `src/im/tools/run-subagent.ts:213`（MINIMAL 谓词）→ `selectPromptTemplate(mode, modelId, delegation)`。

**全文**：`docs/adr/0034-prompt-delegation-authorization.md`；验收 `docs/v0.40-委托授权段-验收报告.md`。

## ADR-035: goal 模式 — beforeComplete 接缝 + 独立 judge + goal 专属压缩梯度 (v0.41)

**决策**：轮次结束的 `completed` 判定加一个**否决接缝** HOOK 6 `beforeComplete`（`loop.ts:1001-1035`，位于既有 `toolCalls.length === 0` 分支内部、`return` 之前）——hook 返回 `continueWith` 时 harness 追加一个 `goal-<uuid>` user 回合并续跑，返回 undefined 时逐字节走原路径。**这是 goal 模式对状态机的全部改动**：不加 `IMLoopOptions.goal`、不加新终止原因、不改 guard、不改 `finalizeRound` 与 `fireDriveCoordinator` 的相对位置。判定者是**独立单发 judge**（`src/im/goal/judge.ts`，`toolRefs: []`、无压缩、看全量 canonical、严格 JSON 三值裁决 met/not_met/impossible），不给主模型 `update_goal` 工具。压缩分四档 **G0 热窗口 / G1 确定性本地合并（不调 LLM，零成本）/ G2 LLM 保守 N→1 折叠信封 / G3 既有 M3 归档**，goal 激活时与既有跨越驱动的块压缩**互斥**（`drive-coordinator.ts:815` 的 `goalModeActive` 守卫放在 M3 归档之后，`lastLayer` 记账照跑）。失败一律 **fail-open 且如实说失败**（judge 失败写进提醒的 `#JUDGE_REASON`，不编造理由；G2 失败降级为不折叠下轮再试；`maxRounds` 默认 24 耗尽时不调 judge 直接短路，`reason` 仍是 `completed`）。

**为什么**：长程任务（DeepSWE 式评测）需要 harness 在模型自称"做完了"之后自己核实一遍。三家参考实现的结构分歧只在"谁来判"——不让主模型自判（KimiCode 路线）是因为被测场景里主模型正是那个想早点收工的主体；judge 看全量是与工作代理同视野、零截断（代价已知：每 goal 轮一次全上下文调用）；judge **刻意不装压缩**，否则它审计的是交接笔记而非证据本身。`goal-` 回合必须是**正常块边界**（曾考虑像 `mem-` 信封那样豁免，核实为致命：`endIndexExclusive` 永远停在 -1，`no-eligible-block` 永久成立，上下文无界增长直到撞 1M guard）；语义上"一个 goal 轮 = 一个连贯任务块"，于是 `findNextTaskBlock` 一行不改。G1 可以是纯算法因为它产出 CuratedMemory 11 字段但 `status_hint` 恒为 `PENDING`、`conclusion` 逐字全量——**完全不设字数上限**，压缩率只来自丢弃输入材料；与块形状无关的压缩率下界由 G2 的 N→1 结构性提供，两者是**因果关系不是并列**（G1 保真 → G2 压的是高保真信封 → 单次损失而非复利损失）。`compressor-agent.md` 的三处字符上限同步删除（"a ceiling is truncation by another name"），代码侧只加低压缩率 `log.warn` 可观测，不加 cap/拒绝/重试——压缩率是测出来的，不是限出来的。

**协议层连带**：goal 块合并后角色序列会出现 `[envelope-user, next-user]` 连续 user（工作区 AGENTS.md §6.27 ④ 已预言），OpenAI 兼容栈接受、Anthropic 严格交替会 400。规则 `normalizeStrictAlternation`（`src/protocol/messages.ts:75`）只合并相邻 user（tool/assistant/system 刻意排除），无损 `\n\n` 拼接；唯一应用点 `call.ts:87`，由 `ModelCapabilities.strictAlternation` 门控，**缺省 false = 不转写**，既有会话 wire 形状逐字节不变。**不做 400 自愈**（用户拍板"只要开关，不加自愈"）：与 v0.32 的 reasoning 自愈不同，那个剔除的是可选增强字段，这里改变的是消息结构，静默改写结构比报错更难排查。

**接线点**：`src/im/loop.ts:1001-1035`（HOOK 6）→ `src/im/goal/hooks.ts:188-252`（① judge `:206` → ② G1 `:239` → ③ G2 `:240` → ④ 提醒 `:243`，顺序不可换，有测试钉住）→ `src/host/assembly.ts:777-795`（`createGoalHooks` 装配）+ `:823`（`goalModeActive` getter）+ `:1028`（四路 `mergeLoopHooks` 的第四路）+ `:1414-1436`（宿主 goal handlers）→ `src/signals/types.ts:87`（出站 `goal.changed`）/`:192-194`（入站 `goal.set/clear/get`）→ `src/signals/gate.ts:361-381`（穷尽路由）。CLI：`cli/commands/registry.ts:143` + `handlers.ts:297-324`（`/goal`）、`cli/session-view.ts:166-193`（`goalEventLabel`，`never` 穷尽守卫，TUI 与 headless 共用）、`cli/headless.ts:207-212` + `:254-258`（`--goal` 事件转发 + `goal.set` 前置于 `user.prompt`）。webapp 本期只做保持 tsc 绿的最小投影（`session-store.ts:291-309` + `:496-499`）——**这是拍板的约束不是遗漏**，7 项前端待同步清单见验收报告 §6。

**全文**：`docs/adr/0035-goal-mode.md`；计划 `docs/plans/v0.41-goal-mode.md`（23 项拍板 D1–D23）；验收 `docs/v0.41-验收报告.md`（含接线点行号表 + 探针实测的三项压缩观察待拍板）。

## ADR-036: 有界工具投影、超大召回转交与阶段式 Baseline (v0.42/v0.44)

**决策**：四条阈值职责分离——**D1 20K token 工具结果投影**（保头保尾 + 戳）、**D2 Databus token range/cursor**、**D3 200K 直接召回 ledger**（`src/im/tools/databus-recall.ts`）、**D4 超大召回委派**给 `large-recall` system agent、**D5 结构化召回报告 + raw 持久化**（commit `083a05b` / `f50fdfd`）。落地在**协议转换层**而非 `loop.ts`（2026-09-19 的实现修正了同日"仅设计"的记录）。

**为什么**：单轮工具结果可引入数十万 token（实测 P99 单条 72K、最大 4 条占 88%），块级压缩是"事后"的，工具结果堆积到跨阈值前没有算法级缓解。四阈值各管一段：20K 是"结果进上下文的常额上限"、200K 是"不经压缩直接召回的边"、300K 是 handoff 交接线、900K 是 M3 归档线——职责不重叠才有可测性。

**接线点**：`src/im/tools/result-budget.ts` → `src/im/tools/databus-recall.ts` → `src/im/system-agents/large-recall.ts` → `src/host/workflow/`。

**全文**：`docs/adr/0036-bounded-recall-and-baseline-workflow.md`；计划 `docs/plans/v0.44-bounded-recall-and-baseline-workflow.md`。

---

## 附：有计划未实现（2026-09-22 盘点）

| # | 事项 | 性质 |
|---|---|---|
| 1 | `fetch_output` 工具 | `docs/plans/工具更新代码计划.md` 称 Phase 1 已落地，实际 **grep 零命中**——计划文档与代码不符 |
| 2 | `docs/plans/` 未动计划 | `phase2-tool-update.md`、`v0.42-long-horizon-2m-benchmark.md`、`v0.43-*.md`（目标文件路径是旧路径，需先修） |
| 3 | 后台任务 | **无此概念**。`list_processes`/`kill_process` 只是单次同步调用期间的进程监督（`onSpawn` track、命令结束即 untrack）；提示词明确禁止 `&`/`nohup`/`Start-Process` 后台化（2026-09-18 用户拍板） |
| 4 | 测试覆盖洞 | `webapp/` 前端 11 个测试跑在自己 vitest 下、根 `npm test` 不跑；`src/mcp-servers/wiki-mcp/` 只有 `.js` smoke、不进 vitest include |
| 5 | 零消费者符号 8 个 | `tests/meta/zero-consumer.test.ts` 白名单：`HookSystem` 等 |
| 6 | 跨平台 | `chroma-bridge.ts:21` 硬编码 `D:\trae\runtime\python\python.exe`；`launcher/` 与 `build-portable.mjs` Windows-only |
