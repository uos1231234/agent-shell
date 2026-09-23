# ADR-024: 提示词工程设计决策

> Status: Active
> Date: 2026-09-03
> Context: v0.19 提示词工程改进（对标 Claude Code / KimiCode / Codex / OpenClaw）
> 编号说明：本 ADR 落盘时初编为 ADR-023，与 2026-09-02 落盘的 ADR-023（v0.16 Security Extension）撞号；2026-09-11 统一为 **ADR-024**（文件名同步为 `0024-prompt-engineering-decisions.md`），DECISIONS.md 的登记编号一直就是 024。

---

## Context

对标 6 个业界项目（KimiCode / AtomCode / pi-agent / Claude Code / Codex / OpenClaw）后，用户做出以下提示词工程设计决策。这些决策构成 agent-shell v0.19 提示词系统的核心设计方向。

---

## Decisions

### D1 — 分层配置注入（来自 Claude Code）

系统提示词支持四层配置，从广到窄加载，后层覆盖前层：

| 层 | 路径 | 用途 | 谁维护 |
|---|---|---|---|
| **Managed** | `~/.agent-shell/global-prompt.md` | 全局策略（只读，如"禁止删除 .env"） | 管理员 |
| **User** | `~/.agent-shell/PROMPT.md` | 用户偏好（如"用中文回答"） | 个人 |
| **Project** | `./AGENTS.md` 或 `./.agent-shell/PROMPT.md` | 项目约定 + **架构描述** | 团队 |
| **Local** | `./local.md`（gitignored） | 临时覆盖（如"今天临时用 jest"） | 个人 |

**合并规则**：local > project > user > managed。

**关键设计**：CLAUDE.md 的经验表明，配置层注入为 **user message** 而非 system prompt，模型遵循但保留判断空间。安全规则（如工具安全策略）保持在 system prompt。

### D2 — 架构描述是运行时功能（用户决策）

架构描述**不是静态提示词段落**，而是 harness 的运行时功能：

```
用户启动会话 → LLM 扫描用户代码库 → 生成架构描述 → 注入上下文
```

**与 v0.13.1 scan_codebase 的关系**：scan_codebase 扫描代码库生成卡片（6 种类型），架构描述是它的摘要视图——提取模块结构、核心依赖、可升级点、可扩展点。

**注入方式**：扫描完成后，架构描述作为 `role: 'system'` 消息注入对话历史（与 v0.18 动态 schema 注入模式一致）。

**理由**：harness 上线后面对的是用户的代码库，不是 agent-shell 自身。模型需要根据用户项目的情况动态生成架构描述，而不是注入一个固定的模板。

**架构描述模板**（由 LLM 生成）：
```markdown
## 项目架构

### 模块结构
- src/module-a/ — {功能描述}
- src/module-b/ — {功能描述}

### 核心依赖
- module-a → module-b（{依赖原因}）

### 可升级点
- {接口名} 可替换为 {替代方案}

### 可扩展点
- {位置} 可新增 {类型} 实现
```

### D3 — 系统提示词强制：高内聚、低耦合（用户决策）

系统提示词中必须包含以下强制指令：

```
写代码时必须符合高内聚、低耦合原则：
- 同一模块内的代码职责集中，不分散到多个文件
- 模块间通过明确的接口通信，不直接依赖内部实现
- 新增功能优先在现有模块内扩展，不新建模块（除非确有必要）
- 修改一个模块时，检查是否有同模式的问题在其他模块中存在
```

**理由**：LLM 倾向于"能跑就行"，不考虑模块边界。明确的架构约束让 LLM 在写代码时自觉遵守项目架构。

### D4 — 系统提示词强制：基于代码信息编程（用户决策）

系统提示词中必须包含以下强制指令：

```
写代码时必须基于代码信息编程：
- 遇到不确定的 API 行为，先用 grep/read_file 查看源码，不猜测
- 遇到不确定的类型定义，先读类型文件，不假设
- 遇到不确定的调用关系，先用 grep 找引用，不凭记忆
- 每次修改代码前，先 read_file 看过原文，不凭印象编辑
- commit 前必须跑 tsc --noEmit 和 vitest run，不凭"应该可以"
```

**理由**：LLM 最大的风险是"自信地犯错"——基于训练数据中的知识猜测 API 行为，而不是基于实际代码。强制基于代码信息编程，从源头消除这类错误。

### D5 — 系统提示词段落化

系统提示词拆分为独立段落，**不刻意维护缓存边界**。

**理由**：我们用 OpenAI 兼容 API（ARK），没有 Anthropic 的 prompt caching 功能。我们的 system prompt 结构——固定部分在前、动态部分在后——天然保持前缀稳定，不需要像 OpenClaw 那样显式画缓存边界。

**段落结构**（按逻辑顺序，非缓存顺序）：

1. **Safety** — 安全规则（禁止做什么）
2. **Architecture** — 项目架构描述（分层、模块、接口、可升级/可扩展配置）
3. **Tooling** — 工具使用指南（load_tools 协议、工具格式）
4. **Coding Principles** — 编码原则（高内聚低耦合、基于代码信息编程）
5. **Execution Bias** — 行动导向（继续直到完成/阻塞）
6. **Runtime Context** — 运行时信息（工作目录、session ID）
7. **Temporal Context** — 时间信息（日期、时区）

**三种 Prompt 模式**：
- `full`（主代理）：完整段落
- `minimal`（子代理）：省略 Architecture、Execution Bias
- `none`：仅基础身份行

### D6 — Auto Memory 系统（来自 Claude Code）

新增跨会话结构化记忆系统，与 M1/M2/M3 压缩互补：

| 维度 | M1/M2/M3 | Auto Memory |
|---|---|---|
| 目的 | 压缩长对话（解决 token 上限） | 跨会话记忆（解决知识保留） |
| 内容 | 对话摘要 | 结构化笔记 |
| 持久化 | jsonl + chromadb | markdown 文件 |
| 结构 | 11 字段 curated memory | 4 种笔记类型 |

**4 种笔记类型**：

| 类型 | 内容 | 什么时候写入 |
|---|---|---|
| `user` | 用户的角色和偏好 | 用户纠正或表达偏好时 |
| `feedback` | 用户纠正过的错误 | 用户说"不对"或"应该是"时 |
| `project` | 项目进度和决策 | 完成里程碑或做决策时 |
| `reference` | 外部信息位置 | 遇到外部资源时 |

**新增工具**：
- `memory_read` — 读取记忆笔记（按 type 或关键词）
- `memory_write` — 写入记忆笔记
- `memory_search` — 搜索记忆笔记

**存储**：`~/.agent-shell/memory/<project>/MEMORY.md`（索引）+ 主题文件

### D7 — 工具自描述扩展（小改进，非核心）

在现有 `SecurityDoor` 基础上，扩展 `ToolDefinition` 可选字段：

```typescript
type ToolDefinition = {
  // 现有字段...
  // 新增（可选）
  parallelSafe?: (args: unknown) => boolean  // arg-aware 并发安全
}
```

`executeToolCalls` 根据 `parallelSafe` 动态分组：safe 的并行，unsafe 的串行。当前全局 `MAX_CONCURRENT_TOOL_CALLS = 2` 仍作为上限。

**不引入新概念**，只扩展现有 `ToolDefinition` 类型。

### D8 — 通用事件钩子（纳入 v0.19 计划）

通用事件钩子（`SessionStart` / `PreToolUse` / `PostToolUse` / `SessionEnd` 等），可观测性是 agent-shell 走向 production 的必要能力。

**价值**：
1. **可观测性注入点**：自动记录工具调用耗时和结果摘要
2. **动态上下文注入**：工具执行后发现文件变化，自动注入提示给下一轮
3. **错误恢复策略**：连续失败后自动注入"换个方法试试"
4. **审计日志**：每个会话的工具调用历史

**设计**：

```typescript
type HookEvent = 'SessionStart' | 'PreToolUse' | 'PostToolUse' | 'SessionEnd'

type HookHandler = {
  event: HookEvent
  handler: (context: HookContext) => Promise<void | boolean>
  // PreToolUse 返回 false 可阻止工具执行
}

// 注册在 ToolRegistry 上，与 SecurityHook 并行
registry.registerHook({
  event: 'PostToolUse',
  handler: async (ctx) => {
    // 记录审计日志
    auditLog.push({ tool: ctx.toolName, duration: ctx.duration, result: ctx.result })
  },
})
```

**与现有 SecurityHook 的关系**：
- `SecurityHook`：安全检查（拦截/拒绝），只覆盖 MCP/skill 工具
- `SystemSecurityHook`：系统工具安全检查
- `HookSystem`：通用事件钩子，覆盖所有工具 + 会话生命周期

三者并行，不互相替代。

**实现位置**：`src/im/hooks/hook-system.ts` + `src/im/hooks/types.ts`

### D9 — 系统提示词语言风格（用户决策）

系统提示词**纯中文**，工具名和代码术语保留英文。

**理由**：用户选择中文作为系统提示词语言。

### D10 — 行动导向策略（用户决策）

行动导向为**均衡**模式：
- 对于明确的指令，直接执行，不要反复确认
- 遇到架构变更、文件删除、生产配置修改等破坏性操作时，停下来确认
- 每次修改都附"为什么改 + 改了什么 + 影响范围"三句话总结
- 遇到阻塞时，不要原地打转，写清楚原因给用户两个选项

### D11 — 上下文注入 Hook 化（用户决策）

所有动态内容的注入从 loop.ts 硬编码改为 `ContextInjector` hook 驱动。

**理由**：当前 loop.ts 在每轮 compose 时硬编码注入 mcpServerSummary、dynamicSchema、stateLine projection、mailbox hint 等。每新增一种动态内容就要改 loop.ts，违背"不补丁式插入"原则。Hook 化后，loop.ts 只调用 `injector.inject(ctx)` 获取消息列表，新增注入源 = 新增文件 + register()，不改 loop.ts。

**内置注入源**：

| 注入源 | priority | 来源 |
|---|---|---|
| `runtime_context` | 10 | 新增（工作目录、session ID） |
| `temporal_context` | 20 | 新增（日期、时区） |
| `mcp_server_summary` | 30 | 从 loop.ts 迁移（v0.18） |
| `loaded_dynamic_tools` | 40 | 从 loop.ts 迁移（v0.18） |
| `architecture_desc` | 50 | 新增（运行时扫描生成） |
| `memory_context` | 60 | 新增（Auto Memory 摘要） |

**迁移原则**：逐个迁移，每迁移一个跑回归。不一次性重写 loop.ts。

---

## Rationale

这些决策基于对 6 个业界项目的对标分析：

- **Claude Code**：分层配置注入 + Auto Memory + 指令分层（system vs user message）
- **KimiCode**：渐进式工具披露（已在 v0.18 实现）+ 公告即账本
- **OpenClaw**：系统提示词段落化 + 缓存边界
- **Codex**：可配置块 + Personality 系统
- **AtomCode**：工具自描述（部分借鉴）

核心理念：**提示词不是静态文本，而是分层、可配置、可记忆的系统**。

---

## Consequence

- `src/im/prompt-layers.ts` — 分层提示词构建器（新增）
- `src/im/prompt-sections.ts` — 段落定义和构建器（新增）
- `src/im/memory/auto-memory.ts` — Auto Memory 系统（新增）
- `src/im/tools/memory-*.ts` — 记忆工具（新增）
- `src/shared/tool-context.ts` — 扩展 `parallelSafe` 字段（可选）
- 系统提示词模板更新（新增安全规则、架构描述、编码原则）
