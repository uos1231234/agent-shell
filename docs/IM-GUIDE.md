# IM Guide — Information Modeling

IM is the first-class citizen of `agent-shell`. The shell and protocol are infrastructure; IM is where the work happens.

## What IM owns

- The **canonical conversation-memory** (the ordered `user` / `assistant` / `tool` sequence used to build working and system-agent prompts; v0.10.4 correction).
- The **databus projection** (a `role: 'tool'`-only copy for explicit cross-agent query/subscribe, not a second prompt-history source).
- The **mailbox** (private FIFO between agents, v0.10.1 NEW).
- The **state-line** (filesystem-persistent layered view, v0.10.2 NEW).
- The **tool registry** (system tools, MCP servers, skills, + 7 system-agent tools since v0.10.1).
- The **system-agent factory** (warehouse / compressor / recall, v0.10.1 NEW).
- The **prompt composition** (6 parts → final OpenAI request).
- The **loop** (orchestrate: compose → call → run tools → repeat).

## Lifecycle of an IM session

```ts
import { runIMLoop } from 'agent-shell/im/loop'
import { Databus } from 'agent-shell/im/databus'
import { ToolRegistry } from 'agent-shell/shell/registry'
import { createConfig } from 'agent-shell/shell/config'
import { streamChat as protocolStreamChat } from 'agent-shell/protocol/client'

// 1. Build the registry.
const registry = new ToolRegistry()
registry.registerSystemTool({ name: 'read_file', description: '...', parameters: {...}, execute: async (args) => { ... } })
registry.registerMCP('github', [
  { name: 'create_issue', description: '...', parameters: {...}, execute: async (args) => { ... } },
])
registry.registerSkill({ name: 'plan', description: '...', execute: async () => { ... } })

// 2. Build the canonical conversation and its Databus tool projection.
const databus = new Databus()
const conversationMemory = new ConversationMemory()
conversationMemory.append({ id: 'user-1', role: 'user', content: '...', at: Date.now() })
// v0.10.4: append assistant/tool turns in their actual protocol order.
// Tool results use appendCanonicalTurn(conversationMemory, databus, toolTurn).

// 2b. Build the mailbox and system agents (v0.10.1).
const mailbox = new Mailbox()
const systemAgents = createSystemAgents({ llmStreamChat: streamChat, url, model, mailbox, registry })

// 2c. Build the state-line (v0.10.2).
const stateLine = createStateLine()  // required in v0.10.3 (use createNoopStateLine() if no persistence needed)

// 3. Wire the protocol layer into the shape the IM loop expects.
//
// `runIMLoop` takes `streamChat: (url, request) => AsyncIterable<StreamChunk>`.
// `protocol/client.ts:streamChat` is `(url, request, options) => ...` with
// a required `onUsage` callback. The adapter below is the bridge:
//
//   - Forwards the URL and the request body unchanged.
//   - Wires `onUsage` to a no-op (the IM loop reads usage off the response
//     chunks, not the callback; the callback is a leftover from an earlier
//     shell design and the protocol layer keeps it for callers that want
//     to observe usage directly).
//   - Lets the protocol layer auto-inject `stream: true` and
//     `stream_options.include_usage` so the IM's `iter` / `token` / `time`
//     guards are reachable on every OpenAI-shaped provider (see
//     `src/protocol/client.ts:doFetch` for the injection rule).
const streamChat = (url: string, request: Parameters<typeof protocolStreamChat>[1]) =>
  protocolStreamChat(url, request, { onUsage: () => {} })

// 4. Run the loop.
const result = await runIMLoop({
  config: createConfig(),
  registry,
  databus,
  conversationMemory,         // canonical ordered user/assistant/tool sequence
  mailbox,                    // v0.10.1 NEW (agent-to-agent FIFO)
  systemAgents,               // v0.10.1 NEW (warehouse/compressor/recall)
  workingAgentId: 'main',     // v0.10.1 NEW (identifies this agent in mailbox/databus)
  stateLine,                  // v0.10.2 NEW (filesystem-persistent layered view; required in v0.10.3)
  streamChat,
  url: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-4',
  systemPrompt: 'You are a helpful assistant.',
  userTemplate: 'TEMPLATE',
  systemToolRefs: ['read_file'],
  mcpRefs: [{ server: 'github', refs: ['create_issue'] }],
  skillRefs: ['plan'],
})

console.log(result.terminated, result.reason, result.finalState)
```

**Common mistake**: passing `protocolStreamChat` directly to `runIMLoop` does not type-check — the two functions have different shapes (`(url, request, options) => ...` vs `(url, request) => ...`). The adapter above is the smallest bridge; do not skip it. The `onUsage: () => {}` no-op is intentional, not defensive padding: the IM loop reads usage from the response chunks themselves, and the callback is only useful for callers that want to observe usage out-of-band.

**v0.10.1 shortcut**: `createMinimalIM(opts)` wraps all of the above (registry, databus, conversation-memory, mailbox, system agents, adapter) in one call. See `src/im/minimal.ts`.

## System agent tools (v0.10.1, ADR-016)

`registerSystemAgentTools(registry, mailbox, workingAgentId, systemAgents)` registers 7 new tools. These tools use **closures** to capture `mailbox` and `workingAgentId` — they do not appear in the tool's JSON schema, and the `ToolExecutor` signature is unchanged.

The v0.10.4 auto-drive adds deterministic task-block extraction: a candidate starts at one canonical `user` turn and ends immediately before the next `user` turn, includes every intervening `assistant` and `tool` turn, and must contain at least one tool turn. The compressor receives that ordered block directly. It must not reconstruct the block from Databus, timestamps, or `toolCallId` sorting.

| Tool | What it does |
|---|---|
| `databus_query` | Query the databus for tool turns by sourceAgentIds / range / limit |
| `databus_subscribe` | Subscribe to databus append events (async callback) |
| `state_query` | Query the state-line by stamps / range / layer (jsonl direct read) or by queryText (chromadb RAG). No LLM. (v0.10.2: real impl) |
| `compress_block` | Ask the compressor agent to produce a CuratedMemory (11-field) from a block of tool turns |
| `ask_recall` | Ask the recall agent a free-text question; returns answer + evidence + reason |
| `mailbox_send` | Send a message to another agent's inbox (`from` = workingAgentId, captured in closure) |
| `mailbox_read` | Read your own inbox (`agentId` = workingAgentId, captured in closure) |

**Key invariants**:
- `mailbox_send` / `mailbox_read` do NOT expose `from` / `agentId` in their schema — the working agent's identity is captured in the closure at registration time.
- `mailbox_read` does NOT auto-mark-read. Call `markRead` explicitly after processing.
- The 3 system agents (warehouse / compressor / recall) are full `runIMLoop` instances, not single LLM calls. They reuse the same `streamChat` adapter, `ToolRegistry`, and guard infrastructure.
- `state_query` never invokes an LLM (v0.10.2): `stamps`/`range`/`layer` → jsonl direct read; `queryText` → chromadb cosine RAG via `embed.py`. LLM-mediated synthesis is `ask_recall`'s job.
- State-line is the **only** cross-session persistent layer (v0.10.2): `curatedMemory.jsonl` + `index.jsonl` + `stamps.jsonl` + chromadb vectors survive across sessions. Databus and mailbox are ephemeral.

## Adding a new system tool

Tools are self-validating. Each tool's `execute` checks its own contract (see `src/im/tools/validate.ts:requireReason`). The factory `wrap()` catches any thrown error and returns it as a clean English sentence the LLM can read.

```ts
registry.registerSystemTool({
  name: 'write_file',
  description: 'Write a file to disk',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  execute: async (args: unknown) => {
    const { path, content } = args as { path: string; content: string }
    // Validate YOUR tool's contract at the top of execute().
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('write_file requires a non-empty path')
    }
    await fs.promises.writeFile(path, content)
    return `wrote ${content.length} bytes to ${path}`
  },
})
```

Then list it in `systemToolRefs: ['read_file', 'write_file']`.

**Tool errors are deepseek-style**: if your `execute` throws, the loop catches it, increments `metrics.consecutiveToolErrors` once per round (regardless of how many tools failed in that round), and writes a `role: 'tool'` turn with content `"Tool \"<name>\" failed: <msg>"`. The LLM sees the error on its next turn and adjusts. After enough consecutive error rounds (the default config trips on the 11th — see `src/shell/config.ts` for the exact counting semantics), the `errorRate` guard trips the shell to `Tripped`. See `docs/DECISIONS.md` ADR-013.

## Guard reachability (ADR-014)

Every guard in `src/shell/guards.ts:runGuards` is reachable on the happy path — there is no configuration that silently makes a guard's threshold unused. This is an invariant; do not regress it.

- `token` guard reads `metrics.totalTokens` — produced by `addUsage` in `src/shell/call.ts` whenever the protocol returns a `usage` chunk. The protocol layer (`src/protocol/client.ts:streamChat`) auto-injects `stream: true` (so the OpenAI-shaped API returns SSE) and `stream_options: { include_usage: true }` (so the usage chunk is emitted) by default. A caller can override either field explicitly; if the caller sets `stream: false`, the `stream_options` injection is also skipped (no SSE path means no usage opt-in to apply to).
- `iter` guard reads `metrics.stepCount` — produced by `addStep` in `src/shell/call.ts`, **unconditionally** on every call. A step is "one shell call round", not "one usage chunk". This decouples the iter guard from the usage chunk.
- `toolRate` guard reads `metrics.toolCallCount` — produced in `src/shell/call.ts` whenever the response contained `tool_calls`.
- `time` guard reads `metrics.elapsedMs` — produced by `advanceElapsed(metrics, loopStart, Date.now())` in `src/im/loop.ts`, called after every `shellCall`. `loopStart` is captured at the top of `runIMLoop`. The helper is exported so tests can import it directly to verify the producer chain.
- `errorRate` guard reads `metrics.consecutiveToolErrors` — produced in `src/im/loop.ts:executeToolCalls` per failed tool call.

If you refactor any of these producers, add a regression test that imports the producer and asserts the metric moves. Pure-function unit tests on `runGuards` are not enough (see ADR-014 for the failure mode).

## Adding an MCP server

```ts
registry.registerMCP('github', [
  {
    name: 'create_issue',
    description: 'Create a GitHub issue',
    parameters: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } } },
    execute: async (args) => { /* call GitHub API */ return { url: 'https://...' } },
  },
])
```

Then list it in `mcpRefs: [{ server: 'github', refs: ['create_issue'] }]`. The LLM will see the tool as `github__create_issue`.

## Adding a skill

```ts
registry.registerSkill({
  name: 'plan',
  description: 'Plan a multi-step task and emit a structured plan',
  execute: async () => ({ plan: ['step 1', 'step 2', 'step 3'] }),
})
```

Skills are exposed to the LLM as callable tools (just like system tools), but they typically do not perform external I/O — they return planning data.

## Inspecting what the LLM will see

```ts
import { compose } from 'agent-shell/shell/compose'
import { turnToMessage } from 'agent-shell/im/turn'

// v0.10.4: ConversationMemory is the only working-prompt history source.
// It already contains user, assistant, and tool turns in protocol order.
// Databus is a tool-only projection for explicit cross-agent queries.
const finalPrompt = compose(registry, [
  { type: 'system', content: systemPrompt },
  { type: 'userTemplate', content: userTemplate },
  ...systemToolRefs.map(ref => ({ type: 'systemTool' as const, ref })),
  ...mcpRefs.flatMap(m => ({ type: 'mcp' as const, server: m.server, refs: m.refs })),
  ...skillRefs.map(ref => ({ type: 'skill' as const, ref })),
  ...conversationMemory.turns().map(turn => ({ type: 'turn' as const, message: turnToMessage(turn) })),
])
console.log(finalPrompt.messages)
console.log(finalPrompt.tools)
```

This is the **exact** request body that will be sent to the protocol layer.

`turnToMessage` strips the IM-internal `isError` flag from `role: 'tool'` turns before serialization — the LLM only ever sees the human-readable `content` string.

## Observability (v0.14, ADR-020)

Every harness subsystem emits structured NDJSON log records. The logger lives at `src/shared/logger.ts` (5 levels, pino-style `child()` bindings, swappable sink, default threshold `warn` — silent unless you opt in).

```ts
// Option A: turn up the global level (quickest way to see what's happening)
import { setLevel } from 'agent-shell/src/shared/logger.js'
setLevel('debug')

// Option B: inject your own logger into a loop (recommended for apps)
import { runIMLoop, createSilentLogger } from 'agent-shell'   // src/index.ts surface
const myLogger = createSilentLogger()                          // or your own Logger impl
const result = await runIMLoop({ ..., logger: myLogger })
```

Records land on **stderr** as one JSON object per line:

```json
{"component":"im-loop","workingAgentId":"main","model":"gpt-4","ts":1788239591517,"level":"info","msg":"runIMLoop start"}
{"component":"im-loop","workingAgentId":"main","turns":1,"metrics":{...},"level":"info","msg":"runIMLoop completed"}
{"component":"drive-coordinator","workingAgentId":"main","zone":"M1","err":"...","level":"error","msg":"dispatchCompression failed"}
```

**What you can answer with it**: which round's `lastRequestTokens` spiked (`round shellCall ok` trace), why compression didn't fire (`dispatchCompression skipped` / `failed` with `errStack`), whether M3 archival ran (`M3 archive dispatch start` / `warehouse run ok`), and every guard trip with its full hits array.

Three fields are emit-owned and cannot be spoofed by callers: `level`, `ts`, `msg`. Wire your own sink with `setSink(rec => ...)` to route into ELK / pino / OpenTelemetry. The full event taxonomy and the "no deletion of required events" rule is ADR-020.

## What to NEVER do

- **Do not** inspect the shell's terminal state (`IMLoopResult.finalState` / `hits`) from inside a prompt. It is a control signal, not prompt content.
- **Do not** register a tool at runtime (hot-plug). Register everything at startup; the registry is the source of truth.
- **Do not** catch `ShellTerminatedError` and continue the loop. The shell has spoken; the IM must stop.
- **Do not** build a custom retry layer on top of the protocol. The protocol layer is the only place that knows about retries.
- **Do not** prefix tool errors with `error: ` or add an `isError` field. The OpenAI Chat Completions schema does not accept it; the LLM learns from plain English. See ADR-013.
- **Do not** catch the protocol's `ProtocolError` and treat it as a tool error. Protocol errors terminate the loop immediately (reason `'protocol-error'`); they do not accumulate into any metric. Only tool errors have a counter (`metrics.consecutiveToolErrors`, read by the `errorRate` guard).
