---
license: other
license_name: pfsb
license_link: LICENSE
tags:
- agent
- llm
- agent-harness
- context-engineering
- memory
- cli
- typescript
- mcp
---

# agent-shell

A self-contained agent runtime: state machine (shell) + OpenAI protocol + information modeling (IM).

## Why

- **State machine is a funnel, not an FSM.** It runs 5 guards (token / step / tool-call / time / error-rate). When a guard trips, the shell closes its valve: the protocol is not called, and the IM terminates. There is no "recovering" state and no half-open probing — guards are hard terminals.
- **Every guard is reachable on the happy path** (ADR-014). The `time` guard's `metrics.elapsedMs` is driven by a wall-clock anchor in the IM loop (`advanceElapsed`); the `iter` guard's `metrics.stepCount` advances unconditionally on every call (not coupled to a usage chunk); the `token` guard's `metrics.totalTokens` is enabled by `stream: true` + `stream_options.include_usage` auto-injection in the protocol layer (so every OpenAI-shaped provider emits SSE + a usage chunk by default). No configuration silently leaves a guard's threshold unused.
- **Protocol is a pure function.** It speaks OpenAI's native function calling. The shell's only call into it is a `streamChat` that consumes SSE chunks. 429 / 503 are retried 5× with exponential backoff inside the protocol layer; every other error propagates as-is. The protocol layer does **not** auto-wrap; the IM loop and shell pass `streamChat` as a 2-arg function (see `docs/IM-GUIDE.md` for the 1-line adapter that bridges from `client.ts:streamChat`'s 3-arg shape).
- **IM (Information Modeling) is the first-class citizen.** IM owns the databus, the tool registry, the prompt composition, and the loop. The shell and protocol are infrastructure for IM — they do not contain business logic.
- **Tool errors flow as plain English on a `role: 'tool'` turn** (deepseek-harness style). No `error: ` prefix, no `isError` field, no separate verdict. The LLM reads the content like any other tool reply. Tool-internal validation (`path.ts:resolvePath` rejecting paths outside the cwd, `write.ts:isBlocked` rejecting OS-protected directories, `validate.ts:requireReason` rejecting empty reasons) is feedback to the model; the `errorRate` guard is the **session-scope** last-resort safety net that trips `state: 'Tripped'` when the LLM cannot self-correct after N consecutive error rounds (default config: trips on the 11th, strict `>`). See ADR-013.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  IM (Information Modeling) — first-class citizen     │
│                                                      │
│  ┌──────────┐   ┌──────────┐                          │
│  │  Databus │   │ Registry │                          │
│  │ (turns)  │   │ (tools)  │                          │
│  └────┬─────┘   └────┬─────┘                          │
│       │              │                                │
│       └──────────────┼──────────────┐                │
│                      ▼              │                │
│           ┌──────────────────────┐   │                │
│           │  compose(parts)      │   │                │
│           │  → FinalPrompt       │   │                │
│           └──────────┬───────────┘   │                │
│                      ▼               │                │
│       ┌──────────────────────────────┐               │
│       │  Shell                       │               │
│       │  - gate(state)               │               │
│       │  - shellCall(deps, prompt)   │               │
│       │  - metrics (addStep/Usage/   │               │
│       │    addToolCalls)             │               │
│       └──────────┬───────────────────┘               │
│                  │                                   │
│                  ▼                                   │
│       ┌──────────────────────────────┐               │
│       │  Protocol                    │               │
│       │  - streamChat(url, req)      │               │
│       │  - 429/503 retry 5×          │               │
│       │  - SSE → StreamChunk         │               │
│       └──────────────────────────────┘               │
└──────────────────────────────────────────────────────┘
```

## Six prompt parts

The shell composes a final OpenAI request from 6 part types (in order):

1. `system` — fixed system prompt
2. `userTemplate` — templated user prompt
3. `systemTool` — ref to a registered system tool
4. `mcp` — ref to one or more tools under a registered MCP server
5. `skill` — ref to a registered skill
6. `turn` — an already-translated ChatMessage from the IM databus

The shell resolves the tool refs into OpenAI-native `tools` field. The protocol layer does **no transformation** of the request body.

## What is NOT in this package

- No databus cross-session sharing (future concern)
- No Anthropic / Gemini / etc. protocols (only OpenAI)
- No business logic (no experts, no tasks, no tool selection heuristics)
- No `tool-runner.ts` (its 5-phase verdict concept was removed; tool errors flow as plain content on `role: 'tool'`)
- No `tools/buckets.ts` (ADR-010 superseded 2026-08-27; tool-internal validation + session-scope errorRate guard are the only layers)

## Run

```bash
npm install
npm test            # 197 tests
npx tsc --noEmit    # type-check
npx tsx examples/minimal.ts
npx tsx examples/guard-demo.ts
npx tsx examples/tool-flow.ts
```

> The first three are smoke tests. They use a **fake** `streamChat` (no real HTTP). For a real OpenAI-shaped endpoint, see the adapter pattern in [`docs/IM-GUIDE.md`](./docs/IM-GUIDE.md) — it shows the 1-line bridge from `client.ts:streamChat` (3-arg) to the IM loop's expected 2-arg shape, and the protocol layer will auto-inject `stream: true` + `stream_options.include_usage` so the IM's guards are reachable.

## ADRs

See [`docs/DECISIONS.md`](./docs/DECISIONS.md) for the architectural decision records (ADR-001 → ADR-036) that govern this code (ADR-013 describes the tool-error convention; ADR-014 describes the guard-reachability invariant; ADR-015 describes the single guard-evaluation point and the no-dead-code rule).

## License

[agent-shell License v1.0](./LICENSE), based on the [PolyForm Small Business License 1.0.0](https://polyformproject.org/licenses/small-business/1.0.0) with modified thresholds.

- **Individuals and non-commercial use** (personal, community, education, research): free.
- **Companies**: free if your company has fewer than 45 people (employees + contractors) **and** no more than ¥20,000,000 total revenue in the prior tax year.
- **Larger commercial use** (e.g. more than ¥20,000,000 annual revenue): contact the author at 2424105750@qq.com to agree a commercial license before use.
- **Attribution required**: anyone you distribute the software to must receive these terms and the `Required Notice:` line.
