# ADR-022: Tool Security + Search Enhancement — SystemSecurityHook, rg hard dependency, MCP instructions discard (v0.15)

**Status**: Active (2026-09-01)

**Context**: v0.14 评审发现 agent-shell 的工具安全是系统性短板：
1. 系统工具（bash/write/edit/read 等）完全绕过 SecurityHook，无敏感文件检测、无危险命令分类、无人类审批。
2. grep 工具使用 Node RegExp + 自写 walk，大代码库性能不足，且无二进制检测、无 not-found hint。
3. MCP server instructions 无净化/丢弃机制，恶意 server 可注入 system prompt。

用户在 2026-09-01 拍板六个决策（D1-D6）并在实现过程中做出两项调整（A1-A2）。

**参考来源**：考察了 AtomCode（Rust）、Kimi Code（TypeScript）、DeepSeek Harness（TypeScript）三个项目的工具安全设计，综合取舍后形成本方案。

---

## Decision

### 1. SystemSecurityHook — 独立的系统工具安全钩子数组

**问题**：现有 `SecurityHook` 只覆盖 MCP/skill 工具，系统工具绕过它。测试 `securityHook does NOT apply to system tools` 明确固化了这一契约。

**决策**：新增独立的 `SystemSecurityHook` 类型 + `systemSecurityHooks: SystemSecurityHook[]` 数组 + `registerSystemSecurityHook()` 方法。在 `ToolRegistry.execute()` 的系统工具分支运行。

```typescript
// src/shell/registry.ts
export type SystemSecurityHook = (
  args: unknown,
  ctx: ToolContext | undefined,
  toolName: string,
) => void | Error | Promise<void | Error>
```

**理由**：
- 不违反现有契约：MCP/skill 的 `securityHooks` 行为完全不变
- 异步支持：审批 hook 需要 round-trip 等待用户决策
- 独立数组：两套钩子互不干扰，各自独立演进

**约束**：未来新增系统工具安全检查必须通过 `registerSystemSecurityHook` 注册，不得走 `wrapTool` 或 `executeGuarded`。

### 2. 读写路径分离 — resolvePath vs resolvePathForRead

**问题**：`resolvePath` 被 write（创建新文件，文件不存在）和 read（文件必须存在）共用。不能简单加存在性检查。

**决策**：
- `resolvePath(cwd, input)` — 纯解析 + escape 检查，不检查存在性（write 工具用）
- `resolvePathForRead(cwd, input)` — 调用 `resolvePath` + 存在性检查 + not-found hint（read/ls/find/grep/edit 用）

```typescript
export const resolvePath = (cwd: string, input: string): string => {
  const abs = isAbsolute(input) ? normalize(input) : normalize(join(cwd, input))
  const rel = relative(cwd, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path escapes working directory: ${input}`)
  }
  return abs  // 不检查存在性
}

export const resolvePathForRead = (cwd: string, input: string): string => {
  const abs = resolvePath(cwd, input)
  if (!existsSync(abs)) {
    throw new Error(`Path not found: ${input}${notFoundHint(abs)}`)
  }
  return abs
}
```

### 3. 敏感文件检测 — isSensitivePath()

**纯函数**：`isSensitivePath(path: string): boolean`，零依赖。

**检测规则**（按优先级）：
1. 豁免：`.env.example/.sample/.template/.dist/.defaults`、`id_*.pub` 公钥 → `false`
2. 精确 basename：`.env`、`id_rsa/id_ed25519/id_ecdsa/id_dsa`、`credentials`、`.netrc/.git-credentials/.npmrc/.pypirc`
3. `.env.*` 变体（`.env.local`、`.env.production` 等）
4. basename 前缀变体：`id_rsa.bak`、`id_rsa-old`（`-`/`_` 分隔），排除 `id_rsafoo`
5. 路径后缀：`.aws/credentials`、`.gcp/credentials`
6. 敏感目录段：`.ssh`、`.gnupg`、`.kube`、`secrets` 作为独立路径段
7. 证书扩展名：`.pem/.p12/.pfx/.key/.der/.crt/.cer`

**参考**：Kimi Code `sensitive.ts`（82 行）的逻辑，用 TypeScript 重写。

### 4. 危险命令分类器 — checkDangerousCommand()

**纯函数**：`checkDangerousCommand(cmd: string): { dangerous: boolean; reason: string } | null`。

**策略**：strip 注释 → lowercase → 递归 unwrap wrappers / subshells / eval / pipe-to-shell → 模式匹配。

**检测范围**：
- `rm -rf`（排除 artifact 清理：`node_modules/`, `dist/`, `build/`, `target/`, `.cache/`, `__pycache__/`, `venv/`, `.venv/`）
- `dd` 设备写入、`chmod 777`、`curl|sh`/`wget|sh`、`sudo`/`doas`、fork bomb
- `git push --force`/`-f`、`git reset --hard`、`find -delete`/`-exec rm`
- `shred`/`truncate`/`mkfs`、`mv`/`cp` 覆盖关键文件（`/etc/passwd` 等）

**参考**：AtomCode `bash.rs:check_destructive_command`（~400 行 Rust → ~150 行 TS）。

### 5. 人类审批机制 — ApprovalStore + createApprovalHook()

**触发条件**（任一命中即审批）：
- 工具调用引用敏感路径（`isSensitivePath`）
- bash 命令被分类为危险（`checkDangerousCommand`）
- write/edit 工具（总是触发）

**Grant scope 差异化**：
- write/edit → `write:/abs/path`（文件级，同文件后续写自动放行）
- bash → `bash`（session 级，整个会话 bash 自动放行）
- 敏感路径读 → 不记录 grant（每次读 .env 都提示，避免泛化授权）

**Fail-closed**：
- 审批超时（默认 300s）→ Deny
- handler 断开/throw → Deny
- 唯一通过路径：handler 明确返回 `'approved'`

**参考**：Kimi Code `requestToolApproval` + AtomCode `approval.rs` 的 fail-closed。

### 6. ripgrep 硬依赖

**决策**：rg 是搜索能力的硬依赖，无 Node RegExp 降级路径。

**理由**：
- agent-shell 面向大代码库（上下文放大机制的核心场景）
- 两套代码（rg + Node）是重复维护负担
- rg 性能优势在大仓库显著（10-100x）

**解析顺序**：系统 PATH → 捆绑包（未来）→ 下载（未来）。找不到则抛 `RgNotFoundError` 含安装指引。

**约束**：grep 工具对外接口不变（`GrepInput → string`），内部完全使用 rg。

### 7. MCP Instructions 默认丢弃

**决策**：`mcpInstructionsMode` 配置，默认 `'discard'`（丢弃 server instructions），可选 `'allow'`（允许注入）。

**理由**：
- 恶意/被入侵的 MCP server 可通过 instructions 注入 system prompt
- Kimi Code 做法：完全不 surfacing server instructions，100% 安全
- 保留 `allow` 选项用于未来需要 server 指导的场景

**实现**：单点门控 `McpConnection.getInstructions()`，仅 `allow` 模式返回内容。

### 8. not-found hint — 全局模式

**决策**：`notFoundHint(missing)` 全局模式（突破 cwd 限制），但排除 home 目录。

**理由**：用户选择更友好的全局提示。home 目录排除防止信息泄漏。

**实现**：从 missing 路径向上遍历找最近存在祖先 → 列出子条目（目录优先、跳过 SKIP_DIRS/SKIPS_EXTS、上限 40 条）。

---

## Consequences

### Positive
- 系统工具首次拥有完整安全检查层
- 搜索能力从 Node RegExp 升级到 rg，大仓库性能质的飞跃
- MCP instructions 默认安全，消除注入风险
- 读写路径分离消除 write 工具的 false positive

### Negative
- rg 是硬依赖，用户必须安装（但报错信息清晰）
- 审批 hook 增加系统工具调用延迟（但 grant scope 缓解）
- 新增 6 个源文件 + 8 个测试文件（维护面增加）

### Risks
- 审批 handler 的 `TODO` stub 需要未来接线（SSE/websocket/CLI prompt）
- rg 自动下载功能留未来（当前仅 PATH 查找）

---

**Commit**: 待用户确认后提交
