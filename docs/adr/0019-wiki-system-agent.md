# ADR-019: Wiki System Agent — code-domain knowledge base (v0.13.1)

**Status**: Active (2026-08-31)

**Context**: agent-shell v0.13 落地了 MCP/skill 扩展系统（ADR-018），agent 不再限于内置 8+7 工具。但在"后端制造代码领域 wiki 知识库"这一具体场景上，仍缺少一个**专用 system agent**——能扫描代码仓库、生成 wiki 卡片、渲染 Markdown，且这些能力被隔离在单一 agent 身份内（不扩散到 working agent / 其他 system agent）。

用户在 `本地文学 wiki-mcp` 已有一个**文学领域**的 wiki-mcp 实现（server + lib + data + visualizer 四层，MCP stdio 连接，零外部依赖）。它提供了可复用的架构骨架：server.js 的 MCP 主循环、lib/ 的 store/search/config 分层、visualizer/export-md.js 的 MD 渲染管线。v0.13.1 的工作是把这套骨架**领域适配**到代码领域（module/interface/function/class/pattern/concept 6 类型），并接入 agent-shell 作为 wiki system agent。

同时，v0.13 的 `SubAgentToolPolicy` 管的是"子代理能调哪些工具"（命名空间治理），但没有"哪个 agent 身份能调某类工具"的机制。wiki-mcp 工具如果注册在全局 registry，所有 agent 都能调——这违反了"wiki 能力隔离在 wiki agent 内"的意图。需要一个**身份级守卫**。

On 2026-08-31 the user made six decisions that collectively define the wiki system agent:

1. **独立进程**：wiki-mcp server 是独立进程，通过 MCP stdio 连接，不把 wiki 逻辑混入 harness 核心 loop。
2. **上下文注入守卫**：wiki-mcp 工具注册在全局 registry，但 `registry.execute()` 对 `wiki__` 前缀工具检查 `ctx.isWikiAgent`。仅 wiki agent 可通过。
3. **命名空间隔离**：工具名前缀 `wiki__` 做命名空间隔离，与 system tool / 其他 MCP server 工具不冲突。
4. **轻量扫描**：`scan_codebase` 提供路径指针能力（文件名 + 导出 + 注释），AST 解析留未来。
5. **MD 渲染复用**：复用 literature wiki-mcp 的 `visualizer/export-md.js` 管线，模板改为代码领域。
6. **前端契约先行**：wiki agent 暴露的工具 schema 即为未来前端 REST/WebSocket API 的契约，文档中明确标注。

This ADR records those decisions and their consequences.

---

## Decision

### 1. wiki-mcp server 独立进程，MCP stdio 连接

`src/mcp-servers/wiki-mcp/server.js` 是独立 Node.js 进程，通过 MCP stdio 协议与 harness 通信。复用 literature wiki-mcp 的 server.js 主循环模式（~400 行）：注册 15 核心工具 + 2 新工具（`scan_codebase` + `render_md`），工具名前缀 `wiki__`。harness 侧通过 `bootMcpServers`（v0.13 已落地）连接此 server，工具经 `McpConnection.callTool` 执行。

wiki-mcp server 保持**零外部依赖**（纯 Node.js 内置模块），与 literature wiki-mcp 一致。领域类型映射从文学（character/artifact/event/location/organization/concept）改为代码（module/interface/function/class/pattern/concept）。

### 2. 上下文注入守卫（ctx.isWikiAgent）

`registry.execute()` 入口对 `wiki__` 前缀工具检查 `ctx.isWikiAgent`：

```typescript
const WIKI_TOOL_PREFIX = 'wiki__'
if (name.startsWith(WIKI_TOOL_PREFIX) && !ctx?.isWikiAgent) {
  throw new Error(`Tool "${name}" is restricted to the wiki system agent`)
}
```

`IMLoopOptions` 加 `isWikiAgent?: boolean`；`createSystemAgent` 在 name==='wiki' 时设 `isWikiAgent: true`。wiki agent 的 `runIMLoop` 实例通过 ctx 传递此标记。

**为什么用上下文注入而非接线层**：wiki-mcp 工具注册在全局 registry（所有 agent 都能"看见" schema），但只有 wiki agent 能"执行"。这避免了在 toolRefs 层做过滤导致的"schema 不可见"问题——working agent 需要知道 wiki agent 能做什么（才能委托），但不应该能直接调用。

守卫是 throw → `loop.ts` 的 catch → 干净英文句子给 LLM，走既有错误流，**不新增熔断统计**（ADR-015：不引入新的 guard/metric/config 字段）。

### 3. 工具名前缀 `wiki__` 做命名空间隔离

所有 wiki-mcp 工具名以 `wiki__` 开头（如 `wiki__scan_codebase` / `wiki__add_card` / `wiki__render_md` / `wiki__search_cards` / `wiki__get_card`）。这与 v0.13 的 MCP server 工具命名（`serverName__toolName`）一致，但 `wiki__` 前缀同时是**守卫的判别依据**——`registry.execute()` 用 `name.startsWith('wiki__')` 识别需要身份守卫的工具。

### 4. scan_codebase 工具提供路径指针能力

`wiki__scan_codebase` 是 wiki-mcp 的**新工具**（literature wiki-mcp 无此工具）：递归扫描代码仓库文件夹，读取关键文件（README / package.json / 入口文件），生成 wiki 卡片（module/function/class 等类型）。当前实现是**轻量扫描**（文件名 + 导出语句 + 注释），AST 解析留未来。这与 literature wiki-mcp 的"人工录入卡片"模式不同——code-domain 需要自动化路径指针。

### 5. MD 渲染复用 literature wiki-mcp 管线

`src/mcp-servers/wiki-mcp/visualizer/export-md.js` 复用 literature wiki-mcp 的 `visualizer/export-md.js` 渲染管线，模板改为代码领域（module/interface/function/class/pattern/concept 各自的 MD 模板）。`wiki__render_md` 工具读 data/ 目录下的 JSON 数据 → 经 export-md.js → 写 output/wiki/ 目录下的 .md 文件。

### 6. 前端 API 契约 = 工具 schema，文档标注

wiki agent 暴露的工具 schema 即为未来前端 REST/WebSocket API 的契约。计划文档（`docs/plans/v0.13.1-wiki-system-agent.md` §3）中明确标注映射关系：

| 工具 | 未来前端 API | 方法 |
|---|---|---|
| `wiki__scan_codebase` | `/api/wiki/scan` | POST |
| `wiki__generate_wiki` | `/api/wiki/generate` | POST |
| `wiki__render_md` | `/api/wiki/render/:cardId` | GET |
| `wiki__search_cards` | `/api/wiki/search` | GET |
| `wiki__get_card` | `/api/wiki/cards/:cardId` | GET |

这保证前端实现时不需要重新设计接口——工具 schema 已定义了输入/输出契约。

---

## Consequences

**Positive**

- **代码领域 wiki 能力**：agent-shell 获得了"扫描代码仓库 → 生成 wiki 卡片 → 渲染 MD"的完整链路，作为专用 system agent 提供。Working agent 可通过 `run_subagent({name:"wiki", ...})` 委托此能力。
- **身份级隔离**：`ctx.isWikiAgent` 守卫保证 wiki-mcp 工具不会被其他 agent 误调（即使 schema 全局可见）。这是 v0.13 `SubAgentToolPolicy`（命名空间治理）之外的**正交**身份治理——policy 管"工具集"，ctx 守卫管"身份"。
- **架构复用**：wiki-mcp server 复用 literature wiki-mcp 的成熟架构（server/lib/data/visualizer 四层），领域适配仅需改枚举和模板，核心逻辑不变。
- **前端契约先行**：工具 schema 即 API 契约，前端实现时无需重新设计接口。
- **零新依赖**：wiki-mcp server 纯 Node.js 内置模块；harness 侧复用 v0.13 的 `McpConnection` + `bootMcpServers`，无新依赖。

**Negative**

- **+N 文件**：`src/mcp-servers/wiki-mcp/` 新增 server.js + lib/ (4 文件) + visualizer/ + data/ + tests/，以及 harness 侧 `src/im/system-agents/wiki-agent.ts`。`registry.ts` / `loop.ts` / `system-agents/index.ts` / `system-agent.ts` 需修改。
- **wiki agent 独立功能**：wiki agent 是独立 `runIMLoop` 实例，有自己的 canonical conversation + tool projection。这增加了运行时开销（多一个 LLM 调用循环），但隔离了 wiki 逻辑不污染 working agent。
- **前端接口预留**：当前无前端实现，仅工具 schema 定义了契约。前端实现时需保证与 schema 对齐——这是文档约束，非代码强制。
- **scan_codebase 轻量**：当前仅文件名 + 导出 + 注释，不解析 AST。复杂代码结构（嵌套类、动态导出、装饰器）可能漏识别。AST 解析留未来增量。

---

## 与既有 ADR 的关系

- **ADR-015**：不引入新的 guard/metric/config 字段。wiki 守卫是 throw → 既有错误流，不新增熔断统计。
- **ADR-018**：wiki-mcp server 通过 v0.13 的 `McpConnection` + `bootMcpServers` 连接，复用 MCP 安全壳子（SDK 隔离在 `src/mcp/`）。wiki-mcp server 本身在 `src/mcp-servers/`（不在 `src/mcp/`），是 MCP server 的**实现**而非 SDK 触点。
- **ADR-016 §3**：wiki agent 是第四个 system agent（warehouse / compressor / recall 之外），通过 `createSystemAgent` factory 创建，复用既有 system agent 架构。

---

**Last updated**: 2026-08-31 (v0.13.1 plan landed: `docs/plans/v0.13.1-wiki-system-agent.md` + this ADR; code implementation pending)
