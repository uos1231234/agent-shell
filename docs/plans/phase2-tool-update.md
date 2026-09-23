# Phase 2 工具更新代码计划

> **创建日期**：2026-09-02
> **状态**：用户拍板，待子代理实现
> **上游**：`工具补充计划.md`（Phase 2 + Phase 3 调研）→ 本文件（实现约束 + 任务拆分）
> **前置 commit**：`63c52c7`（Phase 1: search_replace + ast_grep + fetch_output + ArtifactStore）——本计划在此基础之上增量

---

## 0. 用户决策（2026-09-02 拍板）

| # | 决策 | 内容 |
|---|---|---|
| D1 | **Phase 2 范围** | web_fetch + encoding + request_user_input 三件（**memory 跳过**，与现有 recall system agent 功能重叠） |
| D2 | **web_fetch HTML→text** | 原生 fetch + readability + linkedom（轻依赖） |
| D3 | **encoding 检测** | GBK/GB18030 round-trip 守卫；中文 Windows 高频场景 |

---

## 1. 约束（Constraints）

以下 N 条硬约束，违反即不合格：

1. **注册规范**：新工具必须在 `src/im/tools/index.ts` 的 `createBuiltinTools({cwd})` 里用 `r.registerSystemTool({ name, description, parameters: toSchema(...), category, execute: wrapTool(...) })` 注册。**不得**在别处注册。
2. **schema 规范**：参数用 `toSchema(props, required)`；每个工具 schema 必须含 `reason: reasonField`（不在 required 里）；execute 内部用 `dropReason(i)` 剥离 reason。
3. **报错规范**：工具内部 throw 干净英文句子 `Error('xxx: <msg>')` → wrapTool re-throw → loop.ts catch 格式化为 `Tool "X" failed: <msg>`（ADR-013）。**工具内不自行格式化**。
4. **安全规范（v0.16）**：所有工具调用经 registry.execute → securityRouter.check。新工具不得绕过。读工具无审批负担；写工具自动走 WriteApprovalDoor。
5. **路径规范**：读操作用 `resolvePathForRead`（含 not-found hint）；写操作用 `resolvePath`。
6. **不引入新 guard/metric/config 字段**（ADR-015）。
7. **不改动**：`src/shell/registry.ts`、`src/security/`、`src/im/loop.ts` 的循环核心、`src/im/minimal.ts`、`src/im/system-agent.ts`、`src/im/tools/run-subagent.ts`、`src/protocol/types.ts`、`src/mcp/`、`src/extensions.ts`——这些都是已 commit 的稳定面。
8. **request_user_input 是例外**：需要修改 `src/shared/tool-context.ts`（加 `requestHandler?: (...)` 字段）和 `src/im/loop.ts` ctx 构造点（注入 requestHandler）。这是**新基础设施**，是唯一需要触核心类型的工具。
9. **encoding 改动是工具内部增强**：修改 `src/im/tools/read.ts` + `src/im/tools/edit.ts`（header 与内部解码层），**不**新增独立工具、**不**改 schema（对 LLM 透明）。
10. **跨工具互不依赖**：三个工具各自独立文件，零相互 import。

---

## 2. 依赖（Dependencies）

### Compile-time Depends on
- `src/im/tools/index.ts` — 注册点
- `src/im/tools/helpers.ts` — wrapTool/toSchema/reasonField/dropReason
- `src/im/tools/path.ts` — resolvePath/resolvePathForRead
- `src/shared/tool-context.ts` — 加 `requestHandler` 字段（仅 Agent C 改）
- `src/im/loop.ts` — ctx 构造点注入 requestHandler（仅 Agent C 改）
- `package.json` — 加 `@mozilla/readability` + `linkedom` 两个轻依赖（仅 Agent A）

### Runtime Depends on
- Agent A：Node 18+ 原生 fetch + dns/promises + net.BlockList（Node 内置）
- Agent B：`iconv-lite`（新依赖，仅编码探测）
- Agent C：caller 提供的 `requestHandler` 回调（宿主应用/前端/TUI）

### Blocks
- 无（本计划不 Block 任何后续版本）

---

## 3. 架构信息（Architecture）

### 3.1 三个工具的信息流

```
┌─────────────────────────────────────────────────────────────────────┐
│ agent-shell 工具生态（v0.16.2）                                      │
│                                                                     │
│  ┌─ createBuiltinTools({cwd}) ──────────────────────────────────┐  │
│  │                                                              │  │
│  │  ┌─ web_fetch (read) ───────────────────────────────────┐   │  │
│  │  │  URL → validateUrl/SSRF → fetch → HTML              │   │  │
│  │  │  → readability + linkedom → 纯文本/markdown          │   │  │
│  │  │  → char-level 截断（≤50000）                          │   │  │
│  │  │  无 SecurityDoor（SSRF 校验是工具内部前置校验）         │   │  │
│  │  └──────────────────────────────────────────────────────┘   │  │
│  │                                                              │  │
│  │  ┌─ encoding (read 内部增强) ─────────────────────────────┐   │  │
│  │  │  read.ts: fsReadFile → Buffer → 探测 (UTF-8/GB18030)    │   │  │
│  │  │  → 标记 FileEncoding → 解码字符串                      │   │  │
│  │  │  edit.ts: 读时记下 encoding → 写时用对应 encoding       │   │  │
│  │  │  round-trip 守卫：encode(decode(bytes)) == bytes 才认定│   │  │
│  │  │  无新工具注册，零 schema 变化（对 LLM 透明）            │   │  │
│  │  └──────────────────────────────────────────────────────┘   │  │
│  │                                                              │  │
│  │  ┌─ request_user_input (command) ─────────────────────────┐   │  │
│  │  │  LLM 调用 → registry.execute → wrapTool                │   │  │
│  │  │  → await ctx.requestHandler('request_user_input', req) │   │  │
│  │  │  → user/UI 弹卡片 → 答案返回 → tool result 注入 loop │   │  │
│  │  │  无 SecurityDoor（问问题无副作用）                       │   │  │
│  │  │  需 ctx.requestHandler + IMLoopOptions.requestHandler  │   │  │
│  │  └──────────────────────────────────────────────────────┘   │  │
│  │                                                              │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  registry.execute → securityRouter.check()（v0.16 现有路径）         │
│    ├─ read 工具（web_fetch）→ 无 door 命中，放行                     │
│    ├─ read 工具（encoding 是 read.ts 内部增强）→ 走 read 路径放行    │
│    └─ command 工具（request_user_input）→ 无 door 命中，放行          │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 模块边界

| 模块 | 职责 | 不负责 |
|---|---|---|
| `web-fetch.ts` | SSRF 校验 + fetch + HTML→text 渲染 + 截断 | 不修改协议层；不引入 SecurityDoor |
| `encoding.ts` | UTF-8/GB18030 探测 + 解码 + round-trip 守卫 | 不注册为独立工具；不改 schema |
| `read.ts`（改） | 调用 encoding.ts 的解码 | 不改 schema；不改 file path 处理 |
| `edit.ts`（改） | 读时记 encoding、写时 encode | 同上 |
| `request-user-input.ts` | 工具实现（薄壳） | 不承载 UI 渲染；UI 在 宿主应用/TUI 侧 |
| `shared/tool-context.ts`（改） | 加 `requestHandler` 字段 | 不改其他字段语义 |

---

## 4. 设计原则（Principles）

1. **写操作零新工具**：encoding 不是新工具而是 read/edit 内部增强——零 schema 变化、零注册、零 SecurityDoor 触动。
2. **SSRF 校验在工具内部前置**：web_fetch 不依赖现有 SecurityDoor 体系（那是针对本地文件/命令的）。SSRF 是网络语义，与本地路径/命令正交，作为工具内部 `validateUrl`/`isSafeIp` 纯函数实现。
3. **request_user_input 走 IMLoopOptions.requestHandler 注入**：避免在 tool 层硬编码 UI；不同 host（宿主应用 /  TUI / 测试）注入不同 handler。ToolContext 字段可选，老 caller 不破坏。
4. **零新 SecurityDoor**：三个工具都不触发审批（读/问问题无副作用），不扩展 SecurityDoor 注册。
5. **依赖最小化**：web_fetch 加 2 个轻依赖（readability + linkedom）；encoding 加 iconv-lite。其余零 npm 包。
6. **高内聚低耦合**：每个工具自包含；web_fetch 不 import request_user_input，encoding 不 import web_fetch。

---

## 5. 模块化引导（Module Guidance）

### 5.1 新文件

| 文件 | 公开 API | 依赖 | 被谁依赖 |
|---|---|---|---|
| `src/im/tools/web-fetch.ts` | `validateUrl`/`isSafeIp`（纯函数）+ `webFetch(input)` | `@mozilla/readability`, `linkedom` | `index.ts` |
| `src/im/tools/encoding.ts` | `detectEncoding(buf): FileEncoding`、`decode(buf): string`、`encode(s, enc): Buffer` | `iconv-lite` | `read.ts`/`edit.ts` |
| `src/im/tools/request-user-input.ts` | `requestUserInput(input, ctx)` | `shared/tool-context.ts` | `index.ts` |
| `tests/im/tools/web-fetch.test.ts` | — | — | — |
| `tests/im/tools/encoding.test.ts` | — | — | — |
| `tests/im/tools/request-user-input.test.ts` | — | — | — |

### 5.2 修改文件

| 文件 | 改动 | 原因 |
|---|---|---|
| `src/im/tools/index.ts` | 注册 web_fetch + request_user_input（encoding 不注册新工具） | 工具注册点 |
| `src/im/tools/read.ts` | 改用 encoding.ts 解码 + 记下 FileEncoding | encoding 是 read 内部增强 |
| `src/im/tools/edit.ts` | 读时记 encoding + 写时 encode | 同上 |
| `src/shared/tool-context.ts` | 加 `requestHandler?: (kind, payload) => Promise<response>` 可选字段 | request_user_input 新基础设施 |
| `src/im/loop.ts` | ctx 构造点加 `ctx.requestHandler = opts.requestHandler` | 同上 |
| `package.json` | 加 `@mozilla/readability` + `linkedom` + `iconv-lite` | web_fetch / encoding 依赖 |

### 5.3 公开 API 签名（无实现）

```typescript
// src/im/tools/web-fetch.ts
export type WebFetchInput = {
  url: string
  format?: 'text' | 'markdown' | 'html'  // 默认 'text'
  maxChars?: number                       // 默认 50000
}
export type WebFetchResult = {
  content: string        // 渲染后的文本/markdown
  finalUrl: string        // 跟重定向后的最终 URL（用于 debug/审计）
  status: number
  contentType: string
}
export async function webFetch(input: WebFetchInput): Promise<string>
// 内部：validateUrl → SSRF check (isSafeIp + BlockList) → fetch with redirect chain → 
//        content-type sniff → readability+linkedom (HTML) or 原样 (text/json) →
//        char-level 截断
// 报错：throw Error('web_fetch: <clean message>')

// src/im/tools/encoding.ts
export type FileEncoding = 'utf8' | 'gb18030'
export function detectEncoding(buf: Buffer, filename: string): FileEncoding
export function decode(buf: Buffer, enc: FileEncoding): string
export function encode(s: string, enc: FileEncoding): Buffer
// round-trip 守卫：encode(decode(buf), enc) 与 buf 字节比对一致才认定

// src/im/tools/request-user-input.ts
export type RequestUserInputRequest = {
  question: string
  options?: { label: string; description?: string }[]  // 2-4 options
  multiSelect?: boolean
}
export type RequestUserInputInput = {
  questions: RequestUserInputRequest[]  // 1-4 questions per call
}
export async function requestUserInput(
  input: RequestUserInputInput,
  ctx: ToolContext,
): Promise<string>
// 内部：检查 ctx.requestHandler 是否存在；await handler('request_user_input', payload)；
//        返回答案 JSON 字符串；无 handler → throw 'request_user_input: no request handler configured'
```

### 5.4 注册示例（index.ts 追加）

```typescript
// web_fetch — SSRF-protected URL fetch + HTML→text rendering (read, no approval)
r.registerSystemTool({
  name: 'web_fetch',
  description: 'Fetch a URL and return rendered text. Supports http/https. SSRF-safe: blocks private/loopback/link-local IPs. HTML rendered to text/markdown; JSON/plain returned raw. Up to 50000 chars.',
  parameters: toSchema({
    url: { type: 'string', description: 'http:// or https:// URL to fetch' },
    format: { type: 'string', enum: ['text', 'markdown', 'html'], description: 'Output format (default text)' },
    maxChars: { type: 'integer', description: 'Max characters (default 50000)' },
    reason: reasonField,
  }, ['url']),
  category: 'read',
  execute: wrapTool<WebFetchInput & { reason: string }>('web_fetch', async (i) => webFetch(dropReason(i))),
})

// request_user_input — agent asks user structured questions (command, no side effect)
r.registerSystemTool({
  name: 'request_user_input',
  description: 'Ask the user 1-4 structured questions (single or multi-select) and pause for answers. Use when the agent needs user input to disambiguate a decision.',
  parameters: toSchema({
    questions: {
      type: 'array',
      description: '1-4 questions to ask',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } } } },
          multiSelect: { type: 'boolean' },
        },
        required: ['question'],
      },
    },
    reason: reasonField,
  }, ['questions']),
  category: 'command',
  execute: wrapTool<RequestUserInputInput & { reason: string }>('request_user_input', async (i, ctx) => requestUserInput(dropReason(i), ctx!)),
})
```

---

## 6. 已有变量情况（Existing Variables）

### 消费已有

| 已有 | 类型 | 用途 |
|---|---|---|
| `wrapTool` / `toSchema` / `reasonField` / `dropReason` | helpers.ts | 注册 + 报错 |
| `ToolContext`（加 1 字段） | shared/tool-context.ts | request_user_input 拿 ctx.requestHandler |
| `IMLoopOptions`（加 1 字段） | im/loop.ts | caller 注入 requestHandler |

### 新引入

| 新加 | 类型 |
|---|---|
| `WebFetchInput` / `WebFetchResult` | interface |
| `FileEncoding` (`'utf8' \| 'gb18030'`) | union type |
| `RequestUserInputRequest` / `RequestUserInputInput` | interface |
| `validateUrl` / `isSafeIp` | 纯函数 |
| 新 ToolContext 字段 `requestHandler` | optional |
| 新 IMLoopOptions 字段 `requestHandler` | optional |
| npm: `@mozilla/readability`, `linkedom`, `iconv-lite` | runtime deps |

### 不引入

| 拒绝 | 原因 |
|---|---|
| 新的 SecurityDoor | web_fetch / request_user_input / encoding 内部增强都不触发审批 |
| 新的 protocol 类型 | 不涉及消息层 |
| 新的 prompt 注入 | encoding 增强对 LLM 透明 |
| 自建 scheduler / 常驻进程 | 与 agent-shell 定位不符 |
| memory 工具 | 用户决策跳过（与 recall 重叠） |

---

## 7. 决策信息（Decisions）

### 7.1 已决定

| # | 决策 | 理由 |
|---|---|---|
| D1 | encoding 不是新工具，read/edit 内部增强 | 用户对 LLM 透明最简，不增工具配额 |
| D2 | web_fetch SSRF 校验在工具内部前置 | 不扩展 SecurityDoor 体系（那是本地语义） |
| D3 | web_fetch HTML→text 用 readability + linkedom | 提取质量高 vs AtomCode 自写 tokenizer |
| D4 | request_user_input 通过 IMLoopOptions.requestHandler 注入 | UI 在 caller 侧，tool 层不硬编码 |
| D5 | request_user_input 单独 loop 单点修改（ctx 构造 + ToolContext） | 改动面小，不动循环核心 |
| D6 | memory 跳过 | 与现有 recall system agent 功能重叠 |

### 7.2 未决（留给实现验证）

| 问题 | 默认 |
|---|---|
| web_fetch 跟重定向跳数上限 | 5（与 AtomCode 一致） |
| encoding 文本扩展名白名单 | `.txt` `.md` `.csv` `.tsv` `.json` `.yaml` `.xml` `.html` `.htm`（AtomCode 风格） |
| request_user_input 多题时返回 JSON 格式 | 数组，索引与 questions 顺序对齐 |

---

## 8. 子代理任务拆分（严格互不干扰）

### Agent A — web_fetch（读工具）

**范围**：
- `src/im/tools/web-fetch.ts` 新建（实现 `validateUrl` / `isSafeIp` / `webFetch`）
- `tests/im/tools/web-fetch.test.ts` 新建
- `package.json` 加 `@mozilla/readability` + `linkedom` 两依赖
- `src/im/tools/index.ts` 追加 `web_fetch` 注册块

**不碰**：encoding.ts / read.ts / edit.ts / shared/tool-context.ts / im/loop.ts / request-user-input.ts

**关键约束**：
- SSRF 校验：scheme 白名单（http/https）；IP 黑名单用 `node:net.BlockList`（loopback / private / link-local / CGNAT 100.64/10）；DNS 解析后 IP pinning 到 fetch（自定义 lookup 函数）；跟重定向每跳复验；IPv4-mapped-v6 解包。
- HTML→text：readability + linkedom；text/json 原样；charset 探测（Content-Type → BOM → UTF-8）。
- char-level 截断（不是 byte-level），CJK 不截断错位。
- 零调用现有 SecurityDoor（SSRF 是工具内部前置校验）。
- 测试覆盖：scheme 拒绝、loopback IP 拒绝、私有 IP 拒绝、跟重定向、HTML/text/json、截断、UTF-8 错误编码 GBK。

### Agent B — encoding（read/edit 内部增强）

**范围**：
- `src/im/tools/encoding.ts` 新建（`detectEncoding` / `decode` / `encode`）
- `tests/im/tools/encoding.test.ts` 新建
- `src/im/tools/read.ts` 修改（用 encoding 解码，记 FileEncoding）
- `src/im/tools/edit.ts` 修改（读时记 + 写时 encode）
- `package.json` 加 `iconv-lite` 依赖

**不碰**：web-fetch.ts / shared/tool-context.ts / im/loop.ts / index.ts（注册处不动）/ request-user-input.ts

**关键约束**：
- **不**注册为新工具；**不**改 read/edit 的 schema（对 LLM 透明）。
- round-trip 守卫：`encode(decode(buf), enc)` 与原 buf 字节比对一致才认定 GB18030。
- 文本扩展名白名单（AtomCode 风格）+ 文本文件优先 UTF-8 + fallback GB18030。
- binary 文件不探测（保持原有 Buffer 返回）。
- `edit` 读时记 encoding → 写时用对应 encoding；不在 schema 暴露。
- 测试覆盖：UTF-8 文件解码、GBK 文件解码、round-trip 守卫失败回退 UTF-8、二进制文件不探测。

### Agent C — request_user_input（需新基础设施）

**范围**：
- `src/im/tools/request-user-input.ts` 新建
- `tests/im/tools/request-user-input.test.ts` 新建
- `src/shared/tool-context.ts` 修改：加 `requestHandler?: (kind: string, payload: unknown) => Promise<unknown>` 字段
- `src/im/loop.ts` 修改：ctx 构造点（约 line 489）加 `requestHandler: opts.requestHandler` 注入
- `src/im/tools/index.ts` 追加 `request_user_input` 注册块

**不碰**：web-fetch.ts / encoding.ts / read.ts / edit.ts / 其他安全/协议层

**关键约束**：
- ToolContext 加字段是 optional，老 caller 不破坏。
- IMLoopOptions 加 `requestHandler?: ...` 字段，透传到 ctx。
- 工具内部 `await ctx.requestHandler(...)`；ctx.requestHandler 为 undefined → throw `request_user_input: no request handler configured`。
- **不**注册 SecurityDoor（问问题无副作用）。
- 测试覆盖：handler 注入后正常路径、无 handler 报错、questions 数组验证（1-4 个）。

### 文件所有权矩阵（防冲突）

| 文件 | 属主 | 备注 |
|---|---|---|
| `src/im/tools/web-fetch.ts` | A | 独占 |
| `src/im/tools/encoding.ts` | B | 独占 |
| `src/im/tools/request-user-input.ts` | C | 独占 |
| `src/im/tools/read.ts` | B | 仅 B 改（encoding 解码） |
| `src/im/tools/edit.ts` | B | 仅 B 改（encoding 写回） |
| `src/shared/tool-context.ts` | C | 仅 C 改（加 requestHandler 字段） |
| `src/im/loop.ts`（ctx 构造点） | C | 仅 C 改（注入 requestHandler） |
| `src/im/tools/index.ts` | A/C | **串行追加**：A 先，C 后，各自加自己的注册块，不删除/修改他人块 |
| `package.json` | A/B | **串行修改**：A 先（readability + linkedom），B 后（iconv-lite），用 `npm install --save` 添加避免行号冲突 |
| `tests/im/tools/*.test.ts` | A/B/C | 各自独占文件名 |

> **package.json 串行调度**：A 先 commit，B 后 commit；每个 agent 用 `npm install --save <pkg>` 添加，让 npm 自动合并 deps 块（避免行号冲突）。最终由主代理验证合并结果。
> **index.ts 串行调度**：A 先 commit，C 后 commit；每个 agent 只追加，不动他人块。

---

## 9. Definition of Done

- [ ] `web-fetch.ts` 实现 + 测试（SSRF、HTML/text/json、charset、截断）
- [ ] `encoding.ts` 实现 + 测试（UTF-8 / GB18030 / round-trip / 文本扩展名白名单）
- [ ] `read.ts` 改造（encoding 解码，无 schema 变化）+ 现有测试仍绿
- [ ] `edit.ts` 改造（encoding 写回，无 schema 变化）+ 现有测试仍绿
- [ ] `request-user-input.ts` 实现 + 测试（handler 注入、无 handler 报错、questions 验证）
- [ ] `shared/tool-context.ts` 加 `requestHandler` 字段（optional，不破坏现有 caller）
- [ ] `im/loop.ts` ctx 构造点注入 `requestHandler`
- [ ] `package.json` 加 `@mozilla/readability` + `linkedom` + `iconv-lite`
- [ ] `index.ts` 注册 `web_fetch` + `request_user_input`（encoding 不注册新工具）
- [ ] `npm run typecheck` — 0 错误
- [ ] `npm test` — 全绿（现有测试 + 新增测试，0 回归）
- [ ] 零信任验收：注册位置正确、安全协议未绕过、无越权改稳定面（除 ToolContext/loop ctx 构造点 / read.ts / edit.ts 这三个明确允许的修改点）

---

**上次更新**：2026-09-02（计划完成，待子代理实现）
