# ADR-016: agent-shell 信息流架构 (v0.10)

**Status**: Active (draft 2026-08-27; v0.10.4 corrects the landed split-store prompt assembly)

**Context**: v0.9 `databus: append / turns / last / clear / subscribe` was a single in-memory turn array. v0.10.1 narrowed it to tool-only and introduced a separate user/assistant `ConversationMemory`, but that split made it possible for `loop.ts` to append all conversation turns before all tool turns. The resulting protocol message order can break `assistant.tool_calls` ↔ `tool` pairing. ADR-002 ("databus = projection layer, not data store") points at the correct direction: the full conversation must have one ordering authority, while Databus remains a projection surface for cross-agent tool events.

**This ADR is the implementation contract.**

---

## 0. One-sentence summary

agent-shell is no longer "main agent + tool registry + state machine". It is **one canonical ordered conversation plus three projection flows** (Databus / StateLine / Mailbox) that together support **a working agent's LLM context**. The context is a **dynamic projection** that changes shape at 200K, 500K, and 900K. IM (Information Modeling) is **not a central scheduler** — it is the **information-control engineering** that governs the canonical sequence and its projections.

---

## 1. How the working agent's LLM context is built

The working agent's `runIMLoop` is the only thing the user ever sees. Everything else (databus / state-line / mailbox / 3 system agents) is **plumbing** that decides what goes into that context.

### 1.1 Three context intervals

The working agent's LLM context window is filled by **different sources at different session sizes**:

| Interval | What the working agent actually sees |
|---|---|
| **0 - 200K (M0)** | system prompt + the canonical full user / assistant / tool sequence for the most recent work |
| **200K - 500K (M1)** | the same canonical sequence (after completed blocks are replaced) **plus** state-line injected `curatedMemory` (M1) for older history |
| **500K - 900K (M2)** | the canonical sequence + M1 curated memory **plus** M2 summary compression for the 500K-900K bracket |
| **> 900K (M3)** | the freshest canonical sequence + M1/M2 curated memory **plus** a single email from the warehouse agent pointing to new M3 summaries; **the M3 index itself is not in the context** |

This is the only place "200K", "500K", and "900K" appear. The **databus is not layered** — only the context is. The databus stays a flat append-only log of tool events; the state-line produces the layered views.

### 1.2 The injection pipeline (one shell call before)

Before every `shellCall`, the runtime does three things in order, and only injects the result — never the raw projection stores:

```
runtime (auto, before shellCall)
  ├─ 1. canonical conversation turns (ordered user/assistant/tool sequence) → context base
  ├─ 2. state_query(curated memory, M1/M2 up to 900K window)              → [State-line] → inject blocks
  └─ 3. mailbox_hasUnread(workingAgentId)                                  → [Mailbox]   → "you have N unread" hint at end of system prompt
```

The working agent receives its own canonical conversation history plus selected StateLine/mailbox projections. Databus is not appended as a second copy of that working history; it remains available to cross-agent callers through `databus_query` / `databus_subscribe`. The working agent must call tools (`ask_recall`, `state_query`, `databus_query`, `mailbox_read`) to ask for information outside the automatic projections.

### 1.3 Why the mailbox is a hint, not an injection

LLM mailbox = LLM mirror of the human inbox.

- **Human**: A receives a letter → notification appears → A decides when to read → reading is **active**.
- **LLM**: working agent receives a letter → "you have N unread" appended to system prompt → working agent decides when to read → `mailbox_read` is **active**.

Auto-injecting mailbox contents would make the working agent **passively aware** of every other agent's message and **lose its active control** over which communications enter its context. The "N unread" hint **preserves the working agent's information-control right** — the same right the user gives the LLM by writing the system prompt.

### 1.4 The >900K handoff (new rule, added in this revision)

The M3 summary index **does not enter the context** at any layer — it is too large to project. Instead:

> When the canonical conversation plus its StateLine projections crosses 900K, the **warehouse agent sends an email** to the working agent: *"block range [A, B] compressed into M3 stamp=X; queryable via `state_query` or `ask_recall`*. The shared Databus contributes tool-event evidence to warehouse/recall queries, but it is not the total-context counter or the working prompt's history source.

The working agent's next LLM turn sees the email hint, decides it cares, and calls `ask_recall({ query, scope: 'archive' })` or `state_query({ stamp })`. The databus tool-field projection **between** warehouse agent and working agent is what makes this possible — the warehouse agent can see **what the working agent is doing** (via the shared databus) and predict what the working agent will need to know.

This is the **only** way M3 ever reaches the working agent. There is no "M3 auto-injected at the top of the prompt" — that path was rejected because M3 is too large and too sparse to be worth a permanent slot in the context window.

---

## 2. Canonical conversation and its three projections

The working agent's context is built from one canonical ordered conversation plus three projection surfaces. The canonical conversation owns protocol order; Databus, StateLine, and Mailbox expose derived cross-agent or persistent views. Only the runtime decides which selected projections enter a prompt.

### 2.1 Databus (the tool-field projection)

**Definition**: an append-only, cross-agent-readable **projection copy** of canonical `role: 'tool'` turns. The canonical conversation (the `ConversationMemory` instance for each session) owns the complete ordered sequence of `role: 'user'`, `role: 'assistant'`, and `role: 'tool'` turns. Databus never owns user/assistant turns and never becomes the ordering authority.

**Write trigger**: any agent's tool execution completes → the runtime first appends the tool turn to its canonical conversation and then appends a structurally equivalent `role: 'tool'` projection to Databus through one named write path.

**Read paths** (two, both pull-based):

1. **Subscribe**: `databus_subscribe({ sourceAgentIds, filter?, onEvent })` — async event stream; **does not enter context**; onEvent is a callback the agent handles.
2. **Query**: `databus_query({ sourceAgentIds, range?, limit? })` — returns a `readonly ToolTurn[]` snapshot; the caller decides what to do with it (typically feed it into a system agent).

**Invariants**:
- The databus **does not transform** any content. It is a pure projection.
- The databus **does not inject** into any LLM context. Only `query` / `subscribe` callers see the contents.
- The databus is **cross-agent readable** (any agent can read any other agent's tool events) but **role-bounded**: callers see `role: 'tool'` content only, never `role: 'user' / 'assistant'`.
- In v0.10, the databus is **in-memory** (same as v0.9) — persistence is delegated to the state-line.

### 2.2 State-line (the curated / indexed / mapped view)

**Definition**: three system agents (warehouse / compressor / recall) **collaboratively** maintain persistent layered views over completed canonical task blocks and their tool evidence. It is **not** a copy of the canonical conversation or Databus; it is the **processed, lossy view** written to the system-agent-owned files.

**Write responsibilities** (strict single-writer per slot):

| System agent | Writes | Reads |
|---|---|---|
| **Compressor agent** | `curatedMemory.jsonl` (M1 / M2, 11-field) | canonical block input + Databus (via `databus_query`) + StateLine |
| **Warehouse agent** | `index.jsonl` (M3 summaries) + `vectors.bin` (RAG vectors) + `stamps.jsonl` (stamp → physical file map) | curated blocks + Databus (via `databus_query`) |
| **Recall agent** | **nothing** | Databus + state-line curated memory + state-line index |

**Read paths**:
- `state_query({ stamps?, range?, layer?: 'M1' | 'M2' | 'M3' })` — returns a `readonly StateLineEntry[]`.
- The recall agent's `ask_recall` tool uses this internally.

**11-field schema** (参考实现 L2 verbatim, **no `metadata` field** — that name was hallucinated in an earlier draft and is now retracted):

```ts
type CuratedMemory = {
  task_goal: string                                              // required
  causal_steps: Array<{ intent: string; tool_action: string; result: string }>  // required, minItems 1
  evidence_fragments: Array<{ source: string; fragment: string; relevance: string }>  // required, minItems 1
  conclusion: string                                             // required
  next_action: string                                            // required
  working_state: {                                               // required
    current_goal: string
    effective_decisions: string[]
    rejected_decisions: string[]
    architecture_boundaries: string[]
    remaining_work: string[]
  }
  status_hint?: 'DONE' | 'PENDING' | 'UNKNOWN'                  // optional
}
```

This is a **strong-constraint schema**: 6 required top-level fields, 1 optional, 5 required `working_state` sub-fields. The compressor agent's `compress_block` tool is required to call back up to 5 times (参考实现 `maxAttempts: 5`) to fill every required field. **There is no `metadata` field for free-form extension in v0.10.** If a future ADR needs extensibility it will be added explicitly then, not smuggled in here.

**Invariants**:
- The state-line **does not** mirror the canonical conversation or Databus. It is a **processed view** with a different physical format (jsonl / binary) and a different lifecycle.
- The state-line is **single-writer per slot** (3 agents, 3 slots, no overlap).
- The state-line is **persistent** (filesystem, see §4) — this is the only place cross-session memory survives.
- The state-line is **layered** (M1 / M2 / M3 / ARCHIVE) but the layering is an **output property of the warehouse agent's `update_index` calls**, not a stored invariant on every entry.

### 2.3 Mailbox (the private FIFO between agents)

**Definition**: one inbox per `AgentId`. Default visibility: **private**. Cross-agent visibility is achieved by **forwarding**, not by reading another's inbox.

**API**:

```ts
mailbox_send({ from: AgentId, to: AgentId | AgentId[], subject: string, body: string, replyTo?: MailId }): void
mailbox_readOwnInbox({ agentId: AgentId, opts?: { unreadOnly?: boolean; limit?: number } }): readonly MailItem[]
mailbox_hasUnread({ agentId: AgentId }): boolean   // called automatically by runtime
```

**Three invariants**:
- **Privacy**: A cannot read B's inbox. The only way to forward information across agents is for B to call `mailbox_send` to A.
- **FIFO**: items are stored in `sentAt` order; `readOwnInbox` returns them in that order.
- **No injection**: `mailbox_hasUnread` only produces a "you have N unread" hint. The runtime appends this to the system prompt tail of that agent on its next turn. Content is **never** auto-injected.

**Lifecycle**: in-memory in v0.10; **not persisted** across sessions. Cross-session messages go through the databus (tool-field projection is persistent) or the state-line (curated memory is persistent), not the mailbox.

---

## 3. The three system agents (Q2, locked)

### 3.1 Three system agents = full LLM sessions

The three system agents are **not** "a single LLM call wrapped in a tool". They are **full LLM sessions**, structurally identical to the working agent's `runIMLoop`, with the following differences only. Each session has its own canonical ordered conversation; its Databus is only the tool-turn projection of that private conversation:

| Dimension | Working agent | Three system agents |
|---|---|---|
| **Trigger** | user input / main interaction | databus event / mailbox arrival / another agent's call |
| **LLM context** | canonical ordered conversation + selected StateLine/mailbox projections | canonical ordered input conversation + selected Databus/StateLine/mailbox projections |
| **Output form** | user-visible response | curated memory / index update / recall answer |
| **Lifetime** | whole session | scoped to the calling task (can be short-lived) |

### 3.2 Why they must be full LLM sessions (Q2 reasoning)

A "one-shot LLM call" implementation is **not robust**:

- LLM calls fail (timeout / 5xx / parse error). One-shot calls have no retry.
- LLM calls need tools. The compressor agent may need to **query the databus first** to know what to compress — that requires the tool loop.
- LLM calls have intermediate turns. The recall agent may need to **read several candidate blocks first** before generating an answer — that requires multi-turn.
- LLM calls need retry-with-feedback. If the 11-field output is missing a required field, the agent must be told which field and re-output — that requires the same turn loop the working agent has.

A `runIMLoop` instance already provides all of this: turn loop, guards, state machine, tool loop, retry, metrics. The three system agents are **just `runIMLoop` instances with different system prompts, different tool registries, and different input sources**.

### 3.3 The factory pattern (Q1, locked; v0.10.1 revised)

> **v0.10.1 revision**: The factory signature was expanded from 5 fields to 8
> (added `url`, `model`, `mailbox`, `registry` as required; `config` as
> optional with `createConfig()` default). The `initialMetrics` field was
> removed (it was never used — the agent returns `result.metrics` from the
> inner `runIMLoop` call). `mailbox` is injected directly in the factory
> signature, not via module-level default.

```ts
function createSystemAgent(opts: {
  name: AgentId                          // 'warehouse' | 'compressor' | 'recall'
  systemPrompt: string                   // the only behavioural input that differs across the three
  toolRefs: readonly string[]            // which tools the agent can call
  llmStreamChat: (url, request) => AsyncIterable<StreamChunk>   // reused v0.9 streamChat adapter
  url: string                            // LLM endpoint
  model: string                          // model name
  mailbox: Mailbox                       // shared mailbox (injected directly, not module-level)
  registry: ToolRegistry                 // the working agent's registry (system agent sees a subset via toolRefs)
  config?: ShellConfig                   // default: createConfig()
}): {
  run(input: { messages: ChatMessage[]; metadata?: Record<string, unknown> }): Promise<{
    output: unknown
    metrics: Metrics                     // from the inner runIMLoop, not a stale copy
    finalState: State
  }>
  stop(): void
  send(message: ChatMessage): void
}
```

Three concrete instances, created by `createSystemAgents(deps)`:

```ts
const warehouseAgent = createSystemAgent({
  name: 'warehouse',
  systemPrompt: WAREHOUSE_AGENT_SYSTEM,         // when to build / update indexes
  toolRefs: ['databus_query', 'databus_subscribe', 'mailbox_send', 'mailbox_read'],
  llmStreamChat, url, model, mailbox, registry,
})
const compressorAgent = createSystemAgent({
  name: 'compressor',
  systemPrompt: COMPRESSOR_AGENT_SYSTEM,       // how to identify task boundaries, how to fill 11 fields
  toolRefs: ['databus_query', 'state_query', 'mailbox_send', 'mailbox_read'],
  llmStreamChat, url, model, mailbox, registry,
})
const recallAgent = createSystemAgent({
  name: 'recall',
  systemPrompt: RECALL_AGENT_SYSTEM,            // from-precise-to-broad, by-stamp-first
  toolRefs: ['databus_query', 'state_query', 'mailbox_send', 'mailbox_read'],
  llmStreamChat, url, model, mailbox, registry,
})
```

The working agent calls them **via the tool the system agent exposes** — `databus_query`, legacy `compress_block`, `ask_recall`. The system agent's `run` method is the tool's `execute` body. Automatic v0.10.4 compression is coordinator-driven and uses a private compressor-only record tool; it does not rely on the working agent to discover or delimit a block.

### 3.4 The tool surface (what the working agent can call)

These are the **only** new tools the working agent sees in v0.10:

> **Convention**: All tools (v0.9's 8 + v0.10's 7) require a `reason: string`
> field per ADR-013. It is not listed in each row below for brevity.

| Tool | System agent | Input | Output |
|---|---|---|---|
| `databus_query` | warehouse | `{ sourceAgentIds?, range?, limit? }` | `readonly ToolTurn[]` |
| `databus_subscribe` | warehouse | `{ sourceAgentIds? }` | `Unsubscribe` |
| `state_query` | warehouse | `{ stamps?: string[], range?, layer? }` | `readonly StateLineEntry[]` |
| `compress_block` | compressor | legacy `{ block: ToolTurn[], intent? }` caller path | `CuratedMemory` (11-field, strong constraint) |
| `ask_recall` | recall | `{ query: string; scope: 'compressed' \| 'archive' \| '*'; limit? }` | `{ answer: string; evidence: Array<{ stamp: string; quote: string }>; reason: string }` (LLM free-text, no schema lock) |
| `mailbox_send` | (none — direct API) | `{ to, subject, body, replyTo? }` | `void` (`from` is implicit from `workingAgentId`) |
| `mailbox_read` | (none — direct API) | `{ unreadOnly?, limit? }` | `readonly MailItem[]` (`agentId` is implicit from `workingAgentId`) |

The working agent's 8 system tools (`read` / `write` / `edit` / `ls` / `find` / `grep` / `bash` / `powershell`) and the mcp / skill surface are **unchanged** from v0.9.

### 3.5 Invariants (system agents)

1. The three system agents are **full `runIMLoop` instances**, not single LLM calls wrapped in a tool.
2. The three system agents are **structurally identical** to the working agent; only `systemPrompt`, `toolRefs`, and input source differ. Their private canonical conversation is assembled in exact append order; their private Databus is a tool-only projection and is never appended as a duplicate history.
3. The three system agents **reuse v0.9's `streamChat` adapter**; the LLM calling layer is not reinvented.
4. The three system agents are **controlled by all consumers** — any agent can call any of their tools. No single agent owns them.
5. The system agents' `compress_block` enforces the 11-field strong-constraint schema, retrying up to 5 times on missing required fields. The recall agent's `ask_recall` returns free-text LLM output with no schema lock.
6. The system agents' `metadata?: Record<string, unknown>` in `run()` is the **input envelope** (where the calling agent passes context), not an output extension slot. There is no `metadata` field in the 11-field output schema.

---

## 4. Physical storage (Q1, locked)

### 4.1 Databus (in-memory, ephemeral projection)

**v0.10**: in-memory `ToolTurn[]` projection (down from v0.9's `Turn[]` — `role: 'user' / 'assistant'` are no longer accepted by the Databus API).

The Databus projection is **not persisted**. The canonical conversation remains session-scoped, while the StateLine is the persistent layer; on session start, prior context is **rebuilt from the StateLine** (not from a replayed Databus). Databus is a cross-agent working projection, not a canonical log.

### 4.2 State-line (filesystem, persistent)

```
~/.databus/
├── state/
│   ├── stamps.jsonl          # stamp → physical file map. One stamp per line.
│   ├── curatedMemory.jsonl   # M1 / M2 11-field curated memory. One block per line.
│   ├── index.jsonl           # M3 summaries. One summary per line.
│   └── vectors/              # RAG vector store (chromadb PersistentClient).
│       └── chroma/           #   sqlite3 + hnsw segments; one collection `m3_summaries`.
```

**Why jsonl for the three `.jsonl` files**: append-only friendly (databus-style), grep / awk readable (debug-friendly), file-level lock-free (the three system agents can write concurrently without DB transactions).

**Why `vectors/chroma/` is a chromadb PersistentClient (not a hand-rolled `vectors.bin`)**: the warehouse agent needs cosine similarity search over M3 summaries. chromadb gives us HNSW indexing, metadata filtering (by `stamp`), and upsert — for free. The earlier draft's `vectors.bin` (binary mmap) was a premature optimisation; chromadb's sqlite3 + hnsw segments are fast enough at v0.10.2 scale (hundreds to low-thousands of M3 summaries) and far less code to maintain.

**RAG model (locked, v0.10.2)**: `chromadb.utils.embedding_functions.ONNXMiniLM_L6_V2` — i.e. **all-MiniLM-L6-v2**, 384-dim, cosine distance, ONNX runtime. The model is cached at `~/.cache/chroma/onnx_models/all-MiniLM-L6-v2/` (chromadb's default download path; pre-warmed during RAG capability discovery). Node does **not** load the model directly — it calls `scripts/embed.py` via `child_process.spawn` (see §4.5).

**Persistence boundary**: the state-line **survives across sessions**. The databus and mailbox do not.

### 4.3 Mailbox (in-memory, ephemeral)

`Map<AgentId, MailItem[]>` — FIFO, scoped to the current session. Cross-session messages go via the databus (tool-field projection) or the state-line (curated memory), not via the mailbox.

### 4.4 Default path

`~/.databus/` is the default. This is **not yet configurable** in v0.10.1 — the path is hard-coded, with a TODO for a `config.databusPath` field. v0.10.1 ships with a hard-coded default; v0.10.2 introduces the config field.

### 4.5 Node → Python bridge (`scripts/embed.py`)

The warehouse agent is a Node `runIMLoop` instance, but the RAG stack (chromadb + ONNX MiniLM) is Python-only. The bridge is a **single Python entry point** invoked via `child_process.spawn`:

```
Node (warehouse agent)                  Python (scripts/embed.py)
  ─────────────────────                   ───────────────────────
  spawn(python, embed.py)
  ──── stdin: JSON request ────►          parse JSON
                                          ONNXMiniLM_L6_V2 + PersistentClient
          ◄──── stdout: JSON response ──── print(json.dumps(resp))
  close stdin  →  Python exits 0
```

**Two subcommands** (the `command` field in the request JSON):

| `command` | Input fields | Output |
|---|---|---|
| `embed` | `items: Array<{id, text, stamp}>`, optional `storePath` / `collection` | `{ok, count, dim}` |
| `query` | `queryText: string`, optional `limit` / `storePath` / `collection` | `{ok, results: Array<{id, stamp, distance, document}>}` |

**Protocol invariants** (the contract Node relies on):
1. Node writes **one** JSON object to stdin, then closes stdin.
2. Python writes **one** JSON object to stdout, then exits 0 — **even on error**. Errors are `{ok:false, error:string}`; Node never sees a non-zero exit code from a well-formed request.
3. Diagnostic logs go to **stderr**; Node must not parse stderr.
4. Default `storePath` = `~/.databus/state/vectors/chroma`; default `collection` = `m3_summaries`.
5. The `stamp` metadata is the **only** metadata stored on each vector — it is the join key back to `stamps.jsonl` / `index.jsonl`.

**Why spawn (not a native Node binding or a long-lived daemon)**: spawn is the lowest-risk option. A native binding would require building against onnxruntime-node + a Node chromadb client (neither is mature). A long-lived daemon would add a lifecycle to manage (start / health / restart). spawn pays a ~1.3s cold-start per call, but the warehouse agent batches embed calls (one `embed` per M3 block, not per token) and query calls are user-initiated — the latency is acceptable for v0.10.2. If profiling later shows it matters, v0.10.3+ can introduce a daemon; the `embed.py` protocol above is daemon-compatible (stdin/stdout JSON-RPC shape).

**Python runtime**: `D:\trae\runtime\python\python.exe` (Python 3.10.11, trae cn official). Dependencies: `chromadb==1.5.9`, `onnxruntime==1.20.1` (both pre-installed in that runtime). The path is **not** auto-discovered — v0.10.2 hard-codes it in the Node spawn call, with a TODO for `config.pythonPath`.

---

## 5. The five key end-to-end flows

### 5.1 User asks a question

```
1. User message arrives at runIMLoop and is appended to the canonical conversation.
2. Runtime (auto, before shellCall):
   a. canonical ordered conversation (user/assistant/tool) → working context base
   b. state_query(curated memory, M1/M2 up to 900K window) → inject blocks
   c. mailbox_hasUnread(workingAgentId) → inject "N unread" hint
3. Working agent LLM thinks. Calls system tools / agent tools as needed.
4. Any tool call result → append to canonical conversation, then copy that tool turn to Databus.
5. LLM outputs final answer → user-visible.
```

### 5.2 Canonical sequence crosses 200K → compressor agent runs (M1 boundary)

```
1. The canonical conversation estimate crosses 200K (M0 → M1 boundary).
2. The drive coordinator finds the oldest complete canonical task block:
   one user turn through just before the next user turn, containing at least one tool turn.
3. The coordinator passes that exact ordered block as compressor.run({ messages }).
4. The compressor agent runs a full turn loop and calls its compressor-only record tool with the 11 fields.
5. The record tool writes curatedMemory.jsonl (M1/M2).
6. Only after successful persistence, the coordinator evicts the exact canonical range and its Databus tool projection ids.
7. The next working projection sees the smaller canonical sequence plus the injected M1/M2 state-line blocks.
```

### 5.3 Working agent calls ask_recall

```
1. Working agent calls ask_recall({ query, scope, limit }).
2. ask_recall.execute internally calls recall agent: run({ query, scope, limit }).
3. Recall agent LLM runs a full turn loop:
   - state_query({ layer: scope, limit }) to find candidate stamps
   - For each candidate, databus_query(stamp) to read the original tool field
   - May also ask warehouse for related blocks via mailbox
   - Final turn: LLM free-text answer with evidence + reason
4. ask_recall.execute takes the LLM output, wraps as a role:tool turn.
5. The role:tool turn auto-appends to databus (so the recall is itself auditable).
6. Working agent in its next LLM turn sees the role:tool turn (the answer).
7. Working agent uses the answer in its own response.
```

### 5.4 >900K handoff: warehouse agent emails the working agent

```
1. The canonical conversation plus projected StateLine context crosses 900K (M3 boundary).
2. The drive coordinator dispatches the warehouse archive drive.
3. Warehouse agent mailbox_send('warehouse' → 'main', subject: "new M3 available",
   body: "block range [A, B] compressed into M3 stamp=X; queryable via state_query or ask_recall").
4. Next shellCall for the working agent: mailbox_hasUnread('main') = true.
5. Runtime appends "you have 1 unread email" to the working agent's system prompt.
6. Working agent LLM sees the hint, decides to look.
7. Working agent calls mailbox_read → reads the email.
8. Working agent decides: call state_query({ stamp: X }) or ask_recall({ query, scope: 'archive' }).
```

This is the **only** way M3 reaches the working agent. There is no other path.

### 5.5 Cross-agent communication (mailbox)

```
1. Any agent calls mailbox_send({ from, to, subject, body, replyTo? }).
2. Mailbox pushes onto the recipient's inbox.
3. On the recipient's next shellCall, runtime calls mailbox_hasUnread.
4. If true, runtime appends "you have N unread" to the recipient's system prompt.
5. Recipient calls mailbox_read → reads its own inbox only.
6. Recipient decides: reply (mailbox_send) or take action (call some other tool).
```

A **cannot** read B's inbox. The only way A learns what B has to say is if B calls `mailbox_send` to A. This is the same privacy model as human email.

---

## 6. Difference from v0.9

| Item | v0.9 | v0.10 (this ADR) |
|---|---|---|
| Databus contents | in-memory `Turn[]` (user/assistant/tool all) | in-memory, `role: 'tool'` only |
| State-line | does not exist | **new** — filesystem + files |
| Mailbox | does not exist | **new** — in-memory `Map<AgentId, MailItem[]>` |
| Three system agents | do not exist | **new** — three `runIMLoop` instances |
| User / assistant turns in Databus | yes | **no** — they live in the canonical conversation; Databus projects tool turns only |
| Canonical conversation | implicit inside the single v0.9 turn array | explicit ordered `ConversationMemory` containing user/assistant/tool |
| Information-flow relationship | single (databus) | canonical conversation + three projections (Databus / StateLine / Mailbox) |
| LLM context composition | simple (everything in) | canonical ordered turns + dynamic StateLine/Mailbox projection at 200K / 500K / 900K |
| mcp / skill surface | in ToolRegistry | **unchanged** — kept; no ecosystem expansion |
| User-level agent | does not exist | **new** — `registerUserAgent` API (parallel to the three system agents) |
| `metadata` field on 11-field output | hallucinated in earlier draft | **retracted** — schema is verbatim 参考实现 L2 |
| v0.9 IMLoopOptions.streamChat 2-arg interface | exists | **kept** — three system agents reuse it |
| v0.9 200 tests | green | **kept green** — v0.10 is purely additive |

---

## 7. Invariants (the contract this ADR enforces)

1. Three system agents are **full `runIMLoop` instances**, not single-shot LLM calls wrapped in tools.
2. Three system agents are **structurally identical** to the working agent; only `systemPrompt`, `toolRefs`, and input source differ.
3. Three system agents **reuse v0.9's `streamChat` adapter**; the LLM calling layer is not reinvented.
4. Databus accepts **`role: 'tool'` only**. `role: 'user'` / `'assistant'` are rejected at the type level.
5. Databus is **passive**: no auto-inject. Only `query` / `subscribe` callers see the contents.
6. State-line is **not a mirror of the databus** — it is a processed view, layered (M1 / M2 / M3 / ARCHIVE), single-writer per slot.
7. State-line uses 参考实现 L2's 11-field strong-constraint schema. **No `metadata` field** (this ADR retracts the earlier hallucination explicitly).
8. Mailbox is **private FIFO** per `AgentId`. A cannot read B's inbox. Forwarding is the only cross-agent information path.
9. Mailbox injects a hint ("you have N unread"), not the contents. Contents are pulled by `mailbox_read`.
10. LLM context is a **dynamic projection** at 200K, 500K, and 900K. The M3 index never enters the context; it is only **emailed** by the warehouse agent when new M3 blocks land.
11. The working agent has 7 new tools in v0.10 (`databus_query` / `databus_subscribe` / `state_query` / `compress_block` / `ask_recall` / `mailbox_send` / `mailbox_read`) plus the 8 v0.9 system tools. mcp / skill surface is unchanged.
12. mcp / skill surface is **not expanded into a plugin ecosystem** — the registration mechanism exists; the ecosystem does not.

---

## 8. Consequence (implementation plan)

This ADR is implemented in three v0.10 increments, all **purely additive** to v0.9's 200 green tests.

**v0.10.1** ✅ IMPLEMENTED (2026-08-27): databus constrains + mailbox infrastructure + system-agent factory
- `src/im/databus.ts`: type-level reject of `role: 'user' / 'assistant'` — `ToolTurn` with `sourceAgentId` field, `query()` / `subscribe()` / `turns()` API
- `src/im/conversation-memory.ts` NEW: `ConversationTurn` (user/assistant) + `ConversationMemory` class — user/assistant turns moved here from databus
- `src/im/mailbox/` NEW: `Mailbox` class with `send` / `readOwnInbox` / `markRead` / `hasUnread` / `inboxSize`; privacy invariant (no `readInbox(agentId)` method)
- `src/im/system-agent.ts` NEW: `createSystemAgent({...})` factory — wraps private `runIMLoop` instance per agent; `mailbox: Mailbox` passed directly in factory signature (USER DECISION: no module-level global state)
- `src/im/system-agents/index.ts` NEW: `createSystemAgents(deps)` → `{ warehouse, compressor, recall }`
- `src/im/system-agents/register.ts` NEW: `registerSystemAgentTools(registry, mailbox, workingAgentId, systemAgents)` — registers 7 new tools via closures (no `ToolContext` / `ToolExecutor` signature change)
- 7 new tool files: `databus-query.ts` / `databus-subscribe.ts` / `state-query.ts` (stub) / `compress-block.ts` / `ask-recall.ts` / `mailbox-send.ts` / `mailbox-read.ts`
- `src/im/minimal.ts` NEW: `createMinimalIM(opts)` factory with default `Mailbox` + noop `SystemAgents`
- `IMLoopOptions` updated: `conversationMemory` + `workingAgentId` + `mailbox` + `systemAgents` all required
- 3 system-agent system-prompt drafts loaded via `src/im/prompts/index.ts`
- Tests: 218 → 258 (+40: 14 §A + 9 §B + 12 §C + 5 code-review fixes), 0 tsc errors, 38 test files

**v0.10.2**: state-line implementation — IMPLEMENTED (2026-08-28, commit `ef67968`)
- `src/im/state-line/types.ts` NEW: CuratedMemory (ADR-016 §2.2 11-field verbatim, no `metadata`), M3Summary, StampRecord, StateLineEntry, StateLineConfig, ToolContext, CompressorInterface, WarehouseInterface, StateLine type
- `src/im/state-line/jsonl-writer.ts` NEW: `appendJsonl<T>` (mkdir -p + appendFile, no lock)
- `src/im/state-line/append-stamp.ts` NEW: `appendStamp` (no dedup per §7.2 #5 — duplicate silently, reader de-duplicates)
- `src/im/state-line/chroma-bridge.ts` NEW: `embedL3` + `queryL3` via `child_process.spawn` (Python path `D:\trae\runtime\python\python.exe`, 15s default timeout, errors return `{ok:false,error}` not throw)
- `src/im/state-line/index.ts` NEW: `createStateLine(config?)` factory returning `{compressor, warehouse, query, subscribe, close}`; `appendBlock` writes `curatedMemory.jsonl` + `stamps.jsonl` (attaches `_stamp` field for query matching); `appendSummary` writes `index.jsonl` + `stamps.jsonl` + `embedL3` call
- `scripts/embed.py` pre-existing (183 lines, protocol locked in v0.10.0 capability discovery); v0.10.2 wires it via `chroma-bridge.ts`
- `src/shell/registry.ts` MODIFIED: `execute(name, args, ctx?: ToolContext)` — 3rd arg optional, default `{}`; v0.9 tools ignore it
- `src/im/tools/state-query.ts` MODIFIED: stub → real; `queryText` param → chromadb RAG via `ctx.stateLine.warehouse.queryM3()`; `stamps`/`range`/`layer` → jsonl direct read via `ctx.stateLine.query()`; no LLM in either branch (§7.2 #1)
- `src/im/loop.ts` MODIFIED: `IMLoopOptions.stateLine: StateLine` (required in v0.10.3, was optional in v0.10.2); `executeToolCalls` passes `ctx` to `registry.execute`
- `src/im/system-agent.ts` MODIFIED: factory opts adds `stateLine: StateLine` (9th field, required); passed to inner `loopOpts`
- `src/im/system-agents/index.ts` MODIFIED: `SystemAgentDeps` adds `stateLine`
- `src/im/system-agents/register.ts` MODIFIED: 5th param `_stateLine: StateLine`; `createStateQueryTool()` no longer takes warehouse (uses `ctx.stateLine`)
- `src/im/minimal.ts` MODIFIED: `stateLine?: StateLine` optional + `noopStateLine` default
- 11-field schema validation: CuratedMemory type enforces 6 required top-level + 1 optional + 5 required `working_state` = 11 fields; no `metadata` field
- Tests: 258 → 277 (+19: 12 state-line + 5 chroma-bridge + 2 state-query replacement), 0 tsc errors, 40 test files

**v0.10.2.1**: M-layer rename + tool hardening + memory-layers classifier + concurrency cap (2026-08-28)
- L1/L2/L3 → M0/M1/M2/M3 rename across all source, tests, prompts, and ADR. Two-threshold model (200K/950K) replaced with three-threshold model (200K/500K/900K). `L3Summary` → `M3Summary`, `l1_stamp` → `m1_stamp`, `queryL3` → `queryM3`, chromadb collection `l3_summaries` → `m3_summaries`.
- `src/shared/tool-context.ts` NEW: `ToolContext` type moved to shared module (bottom of dependency graph; both shell and im import it, neither owns it).
- `src/im/tools/helpers.ts` NEW: `wrapTool`, `requireReason`, `toSchema`, `reasonField`, `dropReason` — shared by v0.9 factory and v0.10 tools. `wrapTool` returns `(raw, ctx?) => Promise<unknown>` matching `ToolExecutor`.
- `src/im/tools/validate.ts` MODIFIED: `requireReason` + `wrapReason` re-export from helpers.ts (backward compat).
- `src/im/memory-layers.ts` NEW: `classifyMemoryLayer` (pure if-else range check, 200K/500K/900K thresholds), `emitLayerSignal` + `onLayerEnter` (handler dispatch, no-op default in v0.10.2.1), `MAX_CONCURRENT_TOOL_CALLS = 2`.
- `src/im/loop.ts` MODIFIED: `executeToolCalls` uses 2-batch sequential slicing (`for (i += 2) { Promise.all(slice) }`) instead of unbounded `Promise.all`.
- `src/im/system-agents/register.ts` MODIFIED: 5th param `_stateLine` removed (back to 4 params; stateLine reaches state_query via ctx).
- 7 v0.10 tools: local `toSchema`/`reasonField` removed; import from `helpers.ts`; `execute` wrapped with `wrapTool`.
- v0.9 factory (`tools/index.ts`): local `wrap`/`toSchema`/`reasonField`/`dropReason` removed; import from `helpers.ts`; `wrap` → `wrapTool`.
- `bash.ts` / `powershell.ts`: `wrapReason` → `wrapTool`, local `reasonField` → import from `helpers.ts`.
- Tests: 277 → ~300+ (helpers + memory-layers + state-line M-layer + concurrency cap + reason rejection for all tools)

**v0.10.3**: working-agent context dynamic projection — IMPLEMENTED (2026-08-28, commit `3427e9f`)
- `src/im/context-projection.ts` NEW: pure function module exporting `buildContextProjection`, `estimateTokensFromText`, `ContextProjectionConfig`, `DEFAULT_CONTEXT_PROJECTION_CONFIG` (databusMaxTurnsByLayer={M0:50,M1:30,M2:20,M3:10}, stateLineMaxBlocks=20, conversationMaxTokens=50_000 [reserved, not yet consumed]), `ProjectionInput`, `ProjectionResult`
- M0 (<200K): databus turns only (window=50), no state-line part
- M1 (200-500K): + one system part containing M1 blocks; header format `### M1 block stamp=<stamp>`; databus window=30
- M2 (500-900K): + one system part containing M1+M2 blocks; implementation uses Plan B — two separate `query({layer:'M1'})` and `query({layer:'M2'})` calls merged, budget split evenly. `StateLineQueryFilter.layer` type NOT changed to array. databus window=20
- M3 (≥900K): state-line projection dropped; system prompt appends `[context overflow] M3 available via state_query/ask_recall`; databus window=10
- Mailbox unread count: `mailbox.readOwnInbox(id).length` → system prompt appends `[mailbox] you have N unread`
- No SignalBus — projection is per-round pull, calls `classifyMemoryLayer(estimatedTokens)` directly. SignalBus remains reserved for warehouse proactive email push.
- `src/im/loop.ts` MODIFIED: `stateLine` changed from `stateLine?: StateLine` to `stateLine: StateLine` (required); parts assembly calls `buildContextProjection`; state-line part placed after userTemplate, before tool refs; token estimate now includes databus turns
- `src/im/state-line/index.ts` MODIFIED: new export `createNoopStateLine()`; `readJsonl` tolerates corrupted lines (per-line try/catch, skip on parse failure) for append-only crash recovery
- `src/im/state-line/types.ts` MODIFIED: `StateLineEntry` legalizes `_stamp` as optional runtime metadata (`(CuratedMemory & { _stamp?: string }) | M3Summary`)
- `src/im/minimal.ts` MODIFIED: uses `createNoopStateLine()`
- Tests: 317 → 331 (+14: 11 context-projection + 3 loop e2e), 0 tsc errors, 43 test files

**v0.10.3.1**: layer-aware databus window + _stamp passthrough + jsonl corruption recovery — IMPLEMENTED (2026-08-29, commit `0521421`)

**v0.10.4 implemented** (2026-08-29, commit pending): the landed v0.10.3/v0.10.3.1 split-store prompt assembly is superseded and replaced. `ConversationMemory` is the canonical ordered `user | assistant | tool` sequence; each canonical tool turn is copied to the tool-only Databus projection; working and system-agent prompts read canonical order only. Deterministic task blocks are cut from one user turn through just before the next user turn, require at least one tool turn, and are evicted by canonical range plus exact projected tool ids after successful StateLine persistence. The drive coordinator (`DriveCoordinator`) finds task blocks (`findNextTaskBlock`), delivers them to the compressor via `SystemAgent.run({ messages })`, and evicts the exact range after persistence. Compressor prompt declares canonical full-block input and `record_curated_block` as primary output; working prompt declares canonical conversation as single source of truth and Databus as tool-only projection; warehouse prompt retains 200K=compress / 900K=archive semantics and does not own task-boundary detection; recall prompt retains on-demand M3 → stamp → StateLine recall with no crossing handler. Implementation specified in `docs/plans/v0.10.4-system-agent-autodrive.md`. Tests: 336 → 398 (+62), 0 tsc errors, 45 test files.
- `src/im/context-projection.ts` MODIFIED: `databusMaxTurns` (single value) → `databusMaxTurnsByLayer` (M0=50/M1=30/M2=20/M3=10) — the databus window now narrows as the session grows, freeing context budget for state-line blocks at higher layers. `selectStateLineBlocks` uses `.slice(-maxBlocks)` instead of a `limit` param. Added `conversationMaxTokens: 50_000` reserved field (declared, not yet consumed — pending M2/M3 conversation trimming by token budget; see ADR-015 tension noted below).
- `src/im/loop.ts` MODIFIED: state-line part moved after userTemplate before tool refs (aligns with v0.10.3 plan §3.2); token estimate now includes databus turns; `conversationTurns` extracted to variable
- `src/im/state-line/types.ts` MODIFIED: `StateLineEntry` changed from `CuratedMemory | M3Summary` to `(CuratedMemory & { _stamp?: string }) | M3Summary` — legalizing `_stamp` as optional runtime metadata
- `src/im/state-line/index.ts` MODIFIED: `readJsonl` tolerates corrupted lines (try/catch per line, skip on parse failure); `appendBlock` notify uses `recordToWrite` (with _stamp); `query` returns entries WITH _stamp instead of stripping it
- `src/im/conversation-memory.ts` MODIFIED: `appendCanonicalTurn()` is the single production write path — appends to ConversationMemory always; when `role==='tool'`, also appends to Databus projection. `evictRange(startIndex, endIndexExclusive)` removes exact canonical range.
- `src/im/databus.ts` MODIFIED: `evictByIds(toolTurnIds)` removes exact projected tool turns by id.
- `src/im/system-agents/find-task-block.ts` NEW: `findNextTaskBlock()` — deterministic selector scanning canonical turns for user-start to next-user-boundary, requires ≥1 tool turn, validates pairing, recurses to find next eligible span.
- `src/im/system-agents/drive-coordinator.ts` NEW: `DriveCoordinator` — `{ tick(snapshot), stop() }` fire-and-forget at end of each round; tracks `lastLayer` + `inFlightBlockKey`; dispatches compressor via `SystemAgent.run({ messages })`, evicts exact range after successful persistence.
- `src/im/system-agents/system-agent.ts` MODIFIED: `run({ messages })` preserves tool input messages in private canonical memory and private Databus projection.
- `src/im/prompts/compressor-agent.md` REWRITTEN: declares canonical full-block input via `run({ messages })`, `record_curated_block` as primary output, no Databus query.
- `src/im/prompts/working-agent.md` REWRITTEN: declares canonical conversation as single source of truth, Databus as tool-only projection (not duplicated), drive coordinator handles compression automatically.
- `src/im/prompts/warehouse-agent.md` REWRITTEN: retains 200K=compress / 900K=archive semantics, receives curated input for archive, does not own task-boundary detection.
- `src/im/prompts/recall-agent.md` REVIEWED: retains on-demand M3 → stamp → StateLine recall, no crossing handler — no changes needed.
- Tests: 336 → 398 (+62: 21 drive-coordinator + canonical ordering/projection/eviction/system-agent delivery), 0 tsc errors, 45 test files
- **ADR-015 tension**: `conversationMaxTokens` is a reserved field (declared but not consumed). Per ADR-015 ("no reserved fields / dead code"), this is a known tech debt — either wire up its consumption (M2/M3 conversation trimming) or remove it in a subsequent increment.

**RAG model is now locked** (was "deferred" in the earlier draft of this ADR): `ONNXMiniLM_L6_V2` (all-MiniLM-L6-v2, 384-dim, cosine). Validated end-to-end during capability discovery: 3-text embed + query returned correct cosine ranking (e.g. query "代码与机器学习" → "机器学习模型的训练需要大量数据" dist=0.321 → "今天天气不错, 适合写代码" dist=0.415). Cold-load ~1.3s, warm embed ~35ms / 2 sentences, batch 100 sentences ~1.7s. Model cached at `~/.cache/chroma/onnx_models/all-MiniLM-L6-v2/`.

---

## 9. What this ADR explicitly does NOT do

- **No mcp / skill ecosystem expansion.** The mechanism exists; the ecosystem does not.
  > ⚠️ 此条已被 ADR-018 (2026-08-31) 推翻，见 docs/adr/0018-mcp-skill-extension.md
- **No `metadata` field on the 11-field schema.** Retracted explicitly.
- **No auto-injection of mailbox contents.** Hint only.
- **No auto-injection of M3 summary into the working agent's context.** Email only.
- **No cross-session databus persistence.** Databus is in-memory; state-line is the cross-session layer.
  > ⚠️ v0.17 修订 (2026-09-02)：多会话窗口 + 历史会话恢复新增了**会话级快照**（`~/.databus/sessions/<sessionId>/conversation.jsonl` + `databus.jsonl`）。该快照是 **same-session 可重建副本**，只保留 3 天（TTL），且**不成为第二 canonical 源**——ConversationMemory 仍是唯一顺序权威，StateLine 仍是唯一跨会话持久层。跨会话记忆检索仍走 state-line；会话快照仅用于同会话恢复（活跃尾部重建 + databus 投影副本）。
- **No working-agent-as-cross-session-persistent.** The working agent is a session-scoped entity. Cross-session memory flows through the state-line.

---

**Last updated**: 2026-08-29 v0.10.4 implemented (canonical ordered conversation + Databus projection + drive coordinator auto-compression; 398 tests green, 0 tsc errors)
**Next update**: production hardening phase
