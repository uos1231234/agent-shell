# Architecture

## Data flow

```
┌──────────────────────────────────────────────────────────┐
│  Application (e.g. 宿主应用)                              │
│                                                          │
│  1. Build ToolRegistry, register tools/MCPs/skills.     │
│  2. Build Databus, seed it with initial turns.          │
│  3. Create ShellConfig with thresholds.                  │
│  4. Call runIMLoop({ registry, databus, config, ... }).  │
│                                                          │
│  runIMLoop drives:                                       │
│     loop:                                               │
│       compose(parts) → FinalPrompt                       │
│       shellCall(deps, FinalPrompt) →                     │
│           gate(state)                                    │
│             ↓                                           │
│           streamChat(url, request) →                     │
│             withRetry(fetch, 429/503, 5x)                │
│             parseSSEStream → StreamChunk                 │
│           metrics ← addStep / addUsage / addToolCalls    │
│           ← { response, updatedMetrics, toolCalls }      │
│       advanceElapsed(metrics, loopStart, now)   (IM)     │
│       runGuards(metrics, config) → GuardHit[]   (IM)     │
│       if hits.length > 0 → terminate as 'guard-tripped'  │
│       if toolCalls.length > 0 →                          │
│         executeToolCalls(toolCalls, registry)            │
│           parse JSON args, try registry.execute         │
│             on success → role:'tool' content = result    │
│             on throw   → role:'tool' content =           │
│                           'Tool "<name>" failed: <msg>'   │
  │         update metrics.consecutiveToolErrors             │
  │         append assistant turn to canonical conversation   │
  │         append tool results via canonical + Databus      │
  │           projection write path                           │
  │       else → terminate as 'completed'                    │
└──────────────────────────────────────────────────────────┘
```

**v0.10.4 contract correction (planned)**: the source currently remains at the
v0.10.3.1 split-store implementation until the plan is implemented. The
contract below is the required target: one canonical ordered conversation and
three projections. It must not be implemented by concatenating two histories.

```
Canonical conversation and projections (ADR-016, v0.10.4 correction):
  ┌─ Canonical ConversationMemory ───────────────────────────┐
  │  ordered role:'user' | 'assistant' | 'tool' sequence      │
  │  sole ordering authority for working/system prompts      │
  │  task blocks are cut from user through before next user   │
  └───────────────────────────────────────────────────────────┘
                         │ tool turns copied once
                         ▼
  ┌─ Databus projection ─────────────────────────────────────┐
  │  role:'tool' only, cross-agent query/subscribe             │
  │  projection copy; never a second prompt-history source     │
  │  never appended to the working prompt                      │
  └───────────────────────────────────────────────────────────┘
  ┌─ StateLine projection ────────────────────────────────────┐
  │  persistent M1/M2 curated memory and M3 archive/index      │
  │  injected selectively by the context projection            │
  └───────────────────────────────────────────────────────────┘
  ┌─ Mailbox projection ──────────────────────────────────────┐
  │  private FIFO per AgentId; unread-count hint only          │
  │  content is pulled explicitly with mailbox_read            │
  └───────────────────────────────────────────────────────────┘
```


ADR-013 决定：tool 错误是 `role: 'tool'` 里的普通英文句子（deepseek-harness 风格），**不**有 `error: ` 前缀，**不**有 `isError` 字段。详见 `docs/DECISIONS.md` ADR-013。

ADR-014 决定：每个 guard 在 happy path 上都必须是**可达**的。三个此前不可达的 guard 修好了：

- `time` guard：`src/im/loop.ts` 在循环开始记录 `loopStart = Date.now()`，每次 `shellCall` 之后调用 `advanceElapsed(metrics, loopStart, Date.now())` 推进 `metrics.elapsedMs`。该 helper 在 `im/loop.ts` 中 export，以便测试直接 import 验证 producer 链未断。
- `iter` guard：`src/shell/call.ts` 把 `stepCount` 的推进从 `if (usage)` 块里**挪出**——`addStep(deps.metrics)` 永远执行，与 provider 是否发 usage chunk 无关。
- `token` guard：`src/protocol/client.ts:streamChat` 自动注入 `stream: true` + `stream_options: { include_usage: true }`（除非 caller 显式覆盖）——OpenAI 默认不发 SSE 也不发 usage，必须 opt-in。`stream: true` 是协议契约（不带则 API 返回单段 JSON 而非 SSE，IM 拿到 0 个 chunk 就 `'completed'` 静默结束）。

详见 `docs/DECISIONS.md` ADR-014。

ADR-015 决定：guard 的评估点**只有一个**——IM 在 `advanceElapsed` 之后调 `runGuards`（含最后一轮）。`shellCall` 只负责 entry gate 和 metrics 更新，不再自行评估 guards。同时禁止"保留字段"：每个 metric 字段必须有 producer 和 reader（guard），没有就删。

## Module boundaries

- `src/shell/` — pure, no I/O, no business knowledge. Knows about: state, metrics, config, guards, gate, registry, compose, call.
- `src/protocol/` — knows about: OpenAI request/response schema, SSE parsing, retry policy, fetch.
- `src/im/` — knows about: the canonical ordered user/assistant/tool turns, the Databus tool projection, mailbox, tool execution, system-agent factory, the loop, and context projection.
- `src/shared/` — pure types used by both `shell` and `protocol` (e.g. `JSONSchema`). No layer logic.

**v0.10.1 new IM sub-modules** (ADR-016):
- `src/im/databus.ts` — tool-only projection; `query()` / `subscribe()` / `turns()` API plus exact projection eviction in v0.10.4
- `src/im/conversation-memory.ts` — canonical ordered `role: 'user' | 'assistant' | 'tool'` sequence; deterministic range eviction in v0.10.4
- `src/im/mailbox/` — `Mailbox` class; private FIFO per `AgentId`; no cross-inbox read
- `src/im/system-agent.ts` — `createSystemAgent` factory; 8-field signature (mailbox injected directly)
- `src/im/system-agents/` — `createSystemAgents(deps)` + `registerSystemAgentTools(registry, mailbox, workingAgentId, systemAgents)`
- `src/im/prompts/` — 4 agent system-prompt .md files + `index.ts` loader
- `src/im/minimal.ts` — `createMinimalIM(opts)` one-line factory with defaults

**v0.10.2 new IM sub-module** (ADR-016 §4):
- `src/im/state-line/` — filesystem-persistent layered view (M1/M2/M3 archive; M0 is in-memory only and never persisted); `createStateLine(config?)` factory returns `{compressor, warehouse, query, subscribe, close}`; `compressor.appendBlock()` writes `curatedMemory.jsonl` + `stamps.jsonl`; `warehouse.appendSummary()` writes `index.jsonl` + `stamps.jsonl` + chromadb RAG via `embed.py` spawn; `query()` reads jsonl directly (no LLM); single-writer per slot enforced at type level (compressor vs warehouse on different sub-objects)

**v0.18 new IM sub-modules** (Progressive Tool Disclosure):
- `src/im/tools/load-tools.ts` — `load_tools` system tool; loads MCP server/skill tools into dynamic context; applies sub-agent policy filtering via `ctx.toolPolicy`
- `src/im/dynamic-tool-context.ts` — dynamic schema message types (`DynamicToolSchemaMessage`); construction (`buildDynamicToolSchemaMessage`); collection (`collectLoadedSources`); server summary rendering (`buildServerSummary`); load result rendering (`renderLoadResult`)
- `src/shell/registry.ts` extended — `mcpServerMeta` storage (server name → description + tool names) + `loadableSkillMeta` storage (skill name → description) + corresponding `register*`/`get*`/`list*` methods
- `src/shell/compose.ts` extended — `mcpServerSummary` prompt part (server/skill descriptions for system prompt) + `dynamicSchema` prompt part (already-loaded tool schemas)
- `src/shared/tool-context.ts` extended — `toolPolicy?: SubAgentToolPolicy` field for runtime policy filtering

The shell **may** import from `src/protocol/types.ts` and `src/shared/json-schema.js` (pure data types). The shell does **not** import from `src/im/`.

The protocol layer does **not** import from `src/shell/` or `src/im/`. The protocol is reusable in any context that needs OpenAI streaming.

The IM imports from both shell and protocol — that is its role.

## Progressive Tool Disclosure (v0.18)

v0.18 引入渐进式工具披露机制，解决全量披露的 token 浪费问题。核心思想：MCP 工具和 module skill 默认不进入顶层 `tools[]`，LLM 通过 `load_tools` 工具按需加载。

### Design Principles

1. **Server is the disclosure granularity**: MCP tools are grouped by server. Loading a server loads all its tools. This avoids repeated `load_tools` calls for collaborative tool sets.
2. **Dynamic schema injection in conversation history**: Loaded tool schemas are injected as `role:'system'` messages with a `tools` field, not in the top-level `tools[]`. After compaction, schemas naturally disappear.
3. **Server summary in system prompt**: MCP server descriptions and skill descriptions are injected into the system prompt via `<mcp_servers>` block, so the LLM knows what's available.
4. **Unified load_tools for MCP and skill**: `load_tools` accepts mixed sources — MCP server names and skill names — for single-round loading.
5. **load_tools is the only always-present dynamic disclosure tool**: In progressive mode, top-level `tools[]` only contains system tools (including `load_tools`) + loaded dynamic schemas.
6. **Dynamic schema participates in compaction input**: Unlike KimiCode (strip), agent-shell preserves dynamic schemas in compaction input because the compressor LLM needs to see tool definitions to write meaningful curated memory.
7. **Tool source attribution**: Loaded MCP tools carry `source: { kind: 'mcp', server }`, skills carry `source: { kind: 'skill' }`.

### Implementation Mechanism

```
Bootstrap:
  bootMcpServers → registry registers MCP tools (mcpRefs gated)
  + registry stores server metadata (description + tool names)
  + registry stores loadable skill metadata (name, description)
  + registry registers load_tools system tool

Per-round compose:
  → systemToolRefs pushed to tools[] (unchanged)
  → load_tools pushed to tools[] (always present)
  → server/skill summary injected into system message
  → already-loaded dynamic schemas injected into conversation history

LLM calls load_tools({ sources: [{type:'mcp', server:'wiki'}, {type:'skill', name:'ast-grep'}] }):
  → registry checks server/skill existence
  → applies ctx.toolPolicy filtering (sub-agent policy)
  → injects selected tool schemas into dynamic context
  → returns "Loaded: wiki (3 tools), ast-grep (1 tool)"
  → next round compose automatically includes these tools
```

### Security Boundaries

1. **Registration-side gating (mcpRefs)**: Determines which MCP tools are registered to registry. No longer controls what LLM sees.
2. **Sub-agent policy runtime check**: `load_tools` execute applies `ctx.toolPolicy` to filter denied tools. Tools denied by policy are silently skipped.
3. **SecurityRouter integration**: `load_tools` is a system tool, goes through `wrapTool → requireReason + SecurityRouter.check()` path.
4. **No sensitive info leak**: Server summary only includes server name, description, and tool list — no passwords, secrets, or internal implementation details.
5. **System-agent-private names are reserved globally**: A private system tool name (currently `submit_curated_memory`) must not be claimable by a module skill, MCP flat name, or text skill. `toolRefs` omission and the runtime identity guard are separate protections; neither guarantees invisibility because the server summary and `load_tools` enumerate global loadable metadata. Collision handling must be registration-order independent, including the production order where skills load before system tools.

### Module Responsibilities

| Module | Responsibility |
|---|---|
| `src/im/tools/load-tools.ts` | `load_tools` tool — loads MCP server/skill tools into dynamic context |
| `src/im/dynamic-tool-context.ts` | Dynamic schema message types, construction, collection, rendering |
| `src/shell/registry.ts` | Extended with `mcpServerMeta` and `loadableSkillMeta` storage |
| `src/shell/compose.ts` | Extended with `mcpServerSummary` and `dynamicSchema` prompt parts |
| `src/im/loop.ts` | Collects dynamic schemas after tool execution, injects into next compose |
| `src/shared/tool-context.ts` | Extended with `toolPolicy?: SubAgentToolPolicy` field |

### Comparison with KimiCode

| Aspect | KimiCode | agent-shell v0.18 | Rationale |
|---|---|---|---|
| Disclosure granularity | Single tool | MCP server group | Reduces round-trips |
| Dynamic schema injection | Conversation history | Conversation history | Consistent |
| Post-compaction handling | Strip (B) | Preserve (A) | Compressor LLM needs tool definitions |
| Sub-agent control | Unknown | ToolContext.toolPolicy | Explicit |
| Unified entry point | select_mcp_servers | load_tools | Consistent |

See `docs/plans/v0.18-progressive-tool-disclosure.md` for detailed design rationale.

## Invariants (enforced by tests)

1. shell has no business fields. Only state, metrics, config, hits.
2. The state of a Tripped / Dead shell never enters the prompt. The loop's termination result (`IMLoopResult.finalState` / `hits`) is a control signal for the caller only.
3. Tools are registered, not hot-pluggable. `register*()` is called at startup.
4. protocol layer retries only 429 and 503, exactly 5 times, with exponential backoff.
5. tools and skills are exposed to the LLM in OpenAI native format (`{ type: 'function', function: { name, description, parameters } }`).
6. tool results are appended to the canonical ordered conversation and copied to the Databus projection through one write path. The wire message remains a `role: 'tool'` message with exactly `{ role, tool_call_id, content }`; no `isError` field is serialized. The Databus projection is not appended separately to the working prompt.
7. The IM loop terminates on: completion, guard trip, protocol error, or shell termination. There is no infinite loop escape hatch.
8. **Every guard is reachable on the happy path** (ADR-014). `metrics.elapsedMs` is produced by `advanceElapsed` in the IM loop, `metrics.stepCount` is produced by `addStep` in `shell.call` regardless of usage, and `metrics.totalTokens` is opt-in via `stream_options.include_usage` at the protocol layer. Each guard has a test that exercises the producer chain end-to-end.
9. **Guards are evaluated at exactly one point per round** (ADR-015): in the IM, after `advanceElapsed`. This covers the final round too — a slow last response still trips the `time` guard (regression-tested in `tests/im/loop.test.ts`). Every metric field has a producer and a guard reader; "reserved" fields are forbidden.
10. **ConversationMemory is the canonical ordered sequence** (v0.10.4 correction): it stores user, assistant, and tool turns in append order and is the only source for working/system-agent prompt order. **Databus remains `role: 'tool'` only** and is a cross-agent-readable projection copy, never a second prompt-history source.
11. **Mailbox is private FIFO** (ADR-016): A cannot read B's inbox. The runtime injects only a "you have N unread" hint; content is pulled by `mailbox_read`. No auto-injection of mailbox contents.
12. **Three system agents are full `runIMLoop` instances** (ADR-016): not single-shot LLM calls. They reuse v0.9's `streamChat` adapter, `ToolRegistry`, and guard infrastructure. Only `systemPrompt`, `toolRefs`, and input source differ.
13. **No auto-injection of M3 into context** (ADR-016): the M3 index never enters the working agent's context. The warehouse agent emails a hint when new M3 blocks are available. (v0.10.3 implements context dynamic projection; v0.10.1 ships the plumbing, v0.10.2 ships the state-line filesystem.)
14. **State-line is the only cross-session persistent layer** (ADR-016 §4, v0.10.2): `curatedMemory.jsonl` + `index.jsonl` + `stamps.jsonl` + chromadb vectors survive across sessions. Databus and mailbox are in-memory, ephemeral. **v0.17 exception**: multi-session windows add a **same-session snapshot** (`~/.databus/sessions/<sessionId>/conversation.jsonl` + `databus.jsonl`, 3-day TTL) as a reconstructable copy for resume — it is NOT a second canonical source and does NOT replace StateLine for cross-session memory; see ADR-016 §9 note.
15. **State-line single-writer per slot** (ADR-016 §2.2, v0.10.2): `compressor.appendBlock()` and `warehouse.appendSummary()` are on different sub-objects — the compressor cannot write `index.jsonl`, the warehouse cannot write `curatedMemory.jsonl`. Enforced at type level, not runtime gating.
16. **`state_query` never invokes an LLM** (ADR-016 §7.2 #1, v0.10.2): `stamps`/`range`/`layer` → jsonl direct read; `queryText` → chromadb cosine RAG via `embed.py`. LLM-mediated synthesis is `ask_recall`'s job, not `state_query`'s.
17. **Progressive tool disclosure** (v0.18): MCP tools and module skills default to NOT entering the top-level `tools[]`. The LLM loads them on-demand via `load_tools`. Loaded tool schemas are injected as `role:'system'` messages with `tools` field (dynamic schema injection). After compaction, schemas naturally disappear — the LLM must re-load. Server is the minimum disclosure granularity (not single tool). Sub-agent policy filtering is applied at `load_tools` execute time via `ctx.toolPolicy`.
18. **Private system-tool names are a reserved namespace**: Every system-agent-private tool name must be reserved against all public tool sources before registration. A registration-order collision that exposes the name through `buildServerSummary` or `load_tools` is a naming/visibility defect even when `ToolRegistry.execute()` still resolves the real system tool and the identity guard rejects the call. Runtime rejection is defense in depth, not a substitute for the reserved-name contract.

## Hook philosophy: information-flow seams, not a plugin API (user decision 2026-09-05)

本 harness 的 hook（`src/im/loop-hooks.ts` 的 5 个触发点）与 SignalBus **都不是插件系统**——没有任何第三方扩展消费者，唯一消费者是 harness 自身（SignalBus 接线、rendering、error recovery）。这是与 Claude Code Hooks（用户插件 API）、KimiCode LoopHooks（host 注入点）的根本区别：**它们面向外部扩展者，我们的 hook 面向内部信息流**。

三条推论（后续 AI 阅读与修改时必须遵守）：

1. **解耦的目的是信息管理，不是功能/代码管理**。每个 hook 点是状态机信息流的分支缝：主循环在该点把一部分信息流分岔到支流（如 `afterToolExecution` → `RenderingSignalBus` → ArtifactSignal → 前端），主循环自身的上下文工程（compose / projection / canonical conversation）保持完整、不被支流污染。判断"该不该加 hook"的标准不是"代码是否更长"，而是"这里是否出现了一条需要与主流分离的信息支流"。
2. **Helper 保留在 loop.ts 内，不迁移进 hook，也不做 KimiCode 式文件拆分**。helper（composePrompt / finalizeRound / executeSingleTool 等）是"状态机为 IM 服务"的本体，是上下文工程所在；AtomCode（agent.rs 单文件 5,497 行、helper 同文件自由函数区）与 KimiCode（按阶段拆文件但全部留在 loop/ 内、hook 仅 6 个 host 缝）在这一点上一致：hook 从不吸收循环内部逻辑。我们选择最保守也最自洽的形态——helper 同文件，hook 只做信息流支流的接缝。
3. **不新增面向外部用户的 hook，不把 hook 当扩展点宣传**。`IMLoopOptions` 的 hooks 字段是 harness 内部接线手段（`createMinimalIM` / rendering-base / error-recovery 注册），宿主应用传入 hooks 属于高级用法而非设计承诺；API 稳定性承诺只覆盖 `runIMLoop` 的输入输出与 `src/index.ts` 公开面。

## Testing strategy

Every module has unit tests at the boundary. The `tests/im/loop.test.ts` file is the integration test for the whole flow. Examples in `examples/` are smoke tests that print to stdout.

## Known gaps: planned but not implemented (audited 2026-09-22, code-verified)

本节是**已计划未实现**的权威清单，目的是防止"以为已经有了"。这里只列**架构层面会影响后续设计决策**的几项。

### 1. 后台任务：能力不存在（不是"待接线"，是从未实现）

`list_processes` / `kill_process`（v0.29）是**单次同步调用期间的进程监督**：`ProcessRegistry` 在 `onSpawn` 时 track、命令结束即 untrack，因此**没有"脱离调用存活的后台任务"概念**。工具描述与系统提示词明确禁止 `&` / `nohup` / `Start-Process` 后台化（2026-09-18 用户拍板：长任务必须前台执行）。bash 前台超时上限已放宽到 `BASH_TIMEOUT_CAP = 3600s`。

**架构含义**：若将来引入后台任务，必须回答三个本文件未提供答案的问题——
- **完成通知通道**：`Databus` 是 tool-only projection（ADR-016 §2.1），`Mailbox` 是 agent↔agent 私有 FIFO，**不存在"系统→工作代理"的异步注入通道**。KimiCode 用合成 User 消息回灌，那会在 canonical conversation 上开一个新写入源，冲击"唯一生产写路径 `appendCanonicalTurn`"不变量。
- **guard 语义**：跨回合存活的任务让 `elapsedMs` / `stepCount` 算不算它、`turn.cancel` 要不要连带杀它全部需要重新定义并重新测试。
- **会话串行化**：`src/signals/session-queue.ts` 同会话回合串行化，"后台跑构建同时读代码"在当前回合模型下本就不成立。

窄方案（poll-based：`run_in_background` + detached spawn + 日志文件 + `fetch_output` 游标读）不触碰上述三条，是成本更低的替代路径。

### 2. 测试不在 CI 的两块

- **`webapp/` 前端 11 个测试（含 5 个 `.tsx`）跑在 webapp 自己的 vitest 下**，根 `vitest.config.ts` 的 include 只覆盖 `tests/**`，根 `npm test` 完全不跑它们
- **`src/mcp-servers/wiki-mcp/` 只有 `tests/smoke.js`**（`.js` 不在 vitest include 内），`connection-adapter.ts` 无单测——整个 wiki-mcp server 不进 CI

### 3. 零消费者符号（8 个）

`tests/meta/zero-consumer.test.ts` 白名单：`HookSystem`、`createAuditHook`、`createErrorRecoveryHook`、`createMcpSummaryInjection`、`createApprovalHook`、`onLayerEnter`、`emitLayerSignal`、`isDynamicToolSchemaMessage`。其中 `HookSystem` 是 §Hook philosophy 讨论的"未接线 hook 系统"——要接还是删，是待决策项，不是遗漏。

### 4. 跨平台缺口（全平台上线前必修）

- `src/im/state-line/chroma-bridge.ts:21` 的 `DEFAULT_PYTHON_PATH` 硬编码 `D:\trae\runtime\python\python.exe`，macOS/Linux 上 chroma RAG 不可用
- `launcher/`（`he.cmd` / `he.ps1` / `make-desktop-shortcut.ps1`）与 `scripts/build-portable.mjs` 的包名 `agent-shell-win-x64`（硬编码 3 处）全是 Windows-only
- 好消息：核心 `src/` 已普遍使用 `node:os` `homedir()` 与 `node:path` `join()`，`ast-grep.ts` / `open-url.ts` / `rg-resolver.ts` / `write.ts` / `session-store.ts` 已有 `process.platform === 'win32'` 分支，`shell.ts` 文件头自述跨平台中立
