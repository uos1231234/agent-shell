# ADR-025: Hook 体系修复 — 死代码复活、并发分桶、渲染基座缺陷修复

**Status**: Active (2026-09-04)

**Context**: v0.20 系列修复了 agent-shell hook 体系的系统性短板：
1. `executeToolCalls` 用硬编码 `MAX_CONCURRENT_TOOL_CALLS = 2` 覆盖了 `ToolCategory` 自描述系统（read=5/write=3/command=3 的设计值从未落地）
2. `SessionLoopBase` 缺少 hooks/hookSystem/contextInjector 字段，导致三个 hook 机制全部断线（结构性无法接线）
3. 渲染基座存在 P1（双 store 404）、P2（reminder 击穿 JSON）、P3（重复 handle）三个缺陷
4. `renderInline` 存在 XSS 漏洞（`javascript:` 链接未过滤）
5. `systemSecurityHooks` 是 v0.15→v0.16 迁移后的空壳（注册方法已注释，循环永远空转）

用户在 2026-09-04 拍板修复并做出三项关键判断（J1-J3）。

**参考来源**：考察了 KimiCode（PermissionManager 优先级链）、AtomCode（ToolMiddleware 责任链）的 door 机制，确认三种安全语义（deny-override / priority-chain / chain-of-responsibility）各有适用场景。

---

## Decision

### 1. 并发分桶：把注释变成代码

**问题**：`registry.ts:22-25` 注释声明了 read=5/write=3/command=3 的分桶设计，但 `executeToolCalls` 用硬编码 2 完全覆盖了它。`getToolCategory` + `ToolCategory` 系统建于 v0.10.5，从未被调用（死代码）。

**决策**：废除硬编码 2 的全局覆盖，`executeToolCalls` 读 `registry.getToolCategory(name)` 按类别分桶并发。

```typescript
// src/shell/registry.ts
export const CONCURRENCY_LIMITS: Record<ToolCategory, number> = {
  read: 5,
  write: 3,
  command: 3,
}
```

```typescript
// src/im/loop.ts executeToolCalls
const byCategory = new Map<ToolCategory, Array<{ idx: number; tc: ToolCall }>>()
for (let idx = 0; idx < toolCalls.length; idx++) {
  const tc = toolCalls[idx]!
  const category = registry.getToolCategory(tc.function.name)
  // ... 分组
}
for (const [category, items] of byCategory) {
  const limit = CONCURRENCY_LIMITS[category]
  for (let i = 0; i < items.length; i += limit) {
    // 批内 Promise.all 并行，批间串行
  }
}
```

**理由**：
- 工具自描述（category 字段）是注册时的静态属性，getToolCategory 是运行时读取
- 分桶是把自描述转化为并发行为的必经路径
- 输出 turns 按原始下标排序，保证与输入顺序一致（LLM 配对依赖此顺序）

**验证**：read 工具 5 并发、write 3 并发、command 3 并发；输出顺序与输入一致；errorCount 计数正确。

### 2. SessionLoopBase 字段补全：打通 hook 接线通道

**问题**：`SessionLoopBase`（生产会话的 caller 输入类型）缺少 hooks/hookSystem/contextInjector 三个字段，导致 `buildLoopOptions` 无法转发，三个 hook 机制全部断线。

**决策**：SessionLoopBase 新增三个 hook 字段 + 补全 8 个 drift 字段（dynamicSchemas/toolPolicy/compressZone/signal 等），buildLoopOptions 转发所有新增字段。

```typescript
// src/im/session/types.ts SessionLoopBase
hooks?: LoopHooks
hookSystem?: HookSystem
contextInjector?: ContextInjector
// + 8 drift fields
```

**理由**：
- 缺失字段会导致走 SessionManager 的会话静默丢失 hook 能力
- 加可选字段是向后兼容的最小改动
- buildLoopOptions 显式合并字段，不转发 = 静默丢失

### 3. 渲染基座 P1/P2/P3 + XSS 修复

**P1（双 store）**：wiki-agent.ts 给 rule 新建 ArtifactStore，base 自建另一个 → artifact-ref 永久 404。
修复：共享 `deps.rendering.store`，rule 和 base 使用同一实例。

**P2（reminder 击穿）**：wiki_server.js 每 8 次调用追加 reminder text block → connection.ts join('\n') 后 JSON.parse 失败。
修复：`signal-bus.ts` 的 `parseResult` 添加恢复逻辑——先尝试直接 parse（快路径）；失败时，从字符串开头提取第一个合法的 JSON 对象（花括号匹配，忽略字符串内的花括号）。

```typescript
function parseResult(_toolName: string, content: string): unknown {
  try { return JSON.parse(content) } catch { /* continue */ }
  // 恢复：提取第一个合法 JSON
  const trimmed = content.trimStart()
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return undefined
  const closeChar = trimmed[0] === '{' ? '}' : ']'
  let depth = 0, inString = false, escape = false
  for (let i = 0; i < trimmed.length; i++) {
    // ... 花括号匹配逻辑
  }
}
```

**P3（重复 handle）**：base.ts onSignal 无去重 → 重复 emit 产生重复 handle。
修复：`hasHandle(id)` 检查，同 id 不重复 push。

**XSS（javascript: 链接）**：renderInline 不过滤链接 scheme。
修复：`safeHref()` 函数——entity-decode → lowercase → 白名单（http/https/mailto/#/相对路径）→ 其余变 `#`。

### 4. systemSecurityHooks 空壳清理

**问题**：`systemSecurityHooks` 是 v0.15→v0.16 迁移后的空壳——注册方法已注释掉（registry.ts:305-308），循环永远空转（原 :449），字段 private readonly 无外部引用。

**决策**：删除字段 + 删除 commented-out 注册方法 + 删除 dead loop。

**理由**：
- private readonly → 无外部代码可访问
- 注册方法已注释 → 无法添加 hook
- 循环遍历空数组 → no-op
- 保留只会迷惑未来开发者（以为这里可以注册 hook，实际应走 SecurityDoor）

### 5. wiki guard 双注册：保留，修正注释

**矛盾点**：`extensions.ts:173` 注释声称 "wiki-agent.ts no longer registers its own hook"，但 `wiki-agent.ts:134` 实际注册了同谓词 hook。

**决策**：保留两处注册，修正 extensions.ts 注释。

**理由**：
- extensions.ts:175 只在 bootstrapExtensions() 被调用时注册
- wiki-agent.ts:134 在 createWikiAgent() 被调用时必定注册
- 移除 wiki-agent.ts 的注册会造成安全缺口（创建 wiki agent 但未走 bootstrapExtensions 的调用方失去安全门）
- 两处注册谓词完全相同，重复无害（第二个 hook 不会阻断第一个已允许的调用）

### 6. powershell 超时 cap 对齐

**问题**：bash.ts 有 `BASH_TIMEOUT_CAP = 600`，powershell.ts 无 cap（timeout 无限透传）。

**决策**：powershell.ts 新增 `POWERSHELL_TIMEOUT_CAP = 600`，逻辑与 bash.ts 一致（full-permission session 可绕过）。

---

## Security Door 机制对比（研究结论）

| 维度 | AtomCode | KimiCode | agent-shell |
|---|---|---|---|
| **模式** | Chain-of-Responsibility | Priority Chain | Deny-Override |
| **语义** | middleware 可 Proceed/Allow/Deny，Allow 短路剩余 | policy 按序跑，第一个非 undefined 胜出 | 全跑全查，任意 deny 阻断 |
| **状态归属** | Agent.middlewares[] | Agent.permission | SecurityRouter（独立类） |

**关键发现**：三种模式各有适用场景，互不否定。agent-shell 的 deny-override（所有 door 都跑，任意一个 deny 就阻断）是最保守的——适用于"多个安全维度（敏感路径/危险命令/写审批/浏览器并发）任意一个不通过就阻断"的场景。

**T7 简化方向**：不是删除 router 层（会破坏 deny-override 语义），而是把 router 的状态（sessions map + doors array）下沉到 ToolRegistry，保持"全跑全查"语义不变。

---

## 后续任务

### T7: SecurityRouter 简化（保留安全语义，消除独立层）
- 把 sessions map + doors array 迁移到 ToolRegistry
- registry.execute 内直接遍历 securityDoors[]，保持 deny-override 语义
- 删除 SecurityRouter 类

### T8: parallelSafe(args) 扩展（保留不删除）
- ToolDefinition 新增可选 `parallelSafe?: (args: unknown) => boolean`
- category 桶是默认/保守值，parallelSafe 是精确覆盖
- 仿 AtomCode `parallel_safe(&self, args)` 逐参数判定

### 7. PostToolUse 失败路径：不重复做功

**问题**：`executeSingleTool` 的 catch 块原本会 emit `PostToolUse` 事件（含 error），但工具层 `wrapTool` 已经做了错误兜底（catch → 干净英文句子）+ error turn 记录（`isError: true`）+ errorCount 计数（errorRate guard）。Hook 再观察一次是重复做功。

**决策**：失败路径不 emit PostToolUse。工具层已穿透状态机，hook 无需重复观察。状态机通过 isError turn + errorRate guard 感知失败。

```ts
// loop.ts executeSingleTool catch 块
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  // 工具层（wrapTool）已处理错误兜底 + error turn 记录 + errorCount 计数。
  // 失败路径不 emit PostToolUse：工具层已穿透状态机，hook 无需重复观察。
  return { id: mintTurnId('tool'), role: 'tool', toolCallId: tc.id, isError: true, content: `Tool "${tc.function.name}" failed: ${msg}` }
}
```

**理由**：
- 成功路径 emit PostToolUse：有价值（audit、error-recovery 观察结果）
- 失败路径 emit PostToolUse：重复（wrapTool 已处理），且 handler 抛错会击穿循环
- 两层各司其职：工具层管错误处理，hook 层管成功观察

---

## 验收

| 维度 | 结果 |
|---|---|
| 全量测试 | 1714/1714 绿（+5 新增：P2×3 + P3×2） |
| tsc --noEmit | 0 错误 |
| 渗透测试 | 20/20 PASS（发现并修复 1 个真实 XSS） |
| 前端视觉 | 23/23 PASS（中文无乱码、mermaid 安全透传、50 并发无丢失） |
