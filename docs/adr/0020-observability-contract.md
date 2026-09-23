# ADR-020: Observability Contract — structured logger as a first-class harness surface (v0.14)

**Status**: Active (2026-09-01)

**Context**: v0.13 评审发现 agent-shell 的可观测性是系统性短板。最严重的一条：`runIMLoop` 以 fire-and-forget 方式调用 `driveCoordinator.tick()`（`void` 丢弃 Promise），压缩管线的所有失败只能靠 `mailbox.systemSend` 通知 working agent——而 mailbox 投递本身可能失败（inbox 满 / route 被拒），失败时**整条压缩事件静默丢失**。此外全库无 structured logging（仅 3 处 `console.warn`），无 trace ID，无法回答"哪一轮 token 突增""压缩为何没生效""M3 archive 是否跑过"这类运行时问题。

用户在 2026-09-01 拍板三个治理原则：Logger 锁入公开 API；`IMLoopResult` 不加 `rounds` 字段（trace 级日志已够，79 个测试文件不动）；MCP stdio env 白名单取最小集。

---

## Decision

### 1. Logger 是依赖图最底层的 shared 模块

`src/shared/logger.ts` 与 `json-schema.ts` / `tool-context.ts` 平级——零 import，任何层可用，不破坏三层职责。设计刻意最小：5 级（trace/debug/info/warn/error）+ 数值阈值过滤 + 可替换 sink（默认 stderr NDJSON）+ pino 风格 `child(bindings)`。sink 抛错被吞（日志绝不打断主循环）。

### 2. `level` / `ts` / `msg` 三个字段永远由 emit 函数控制

即使 caller 在 bindings 或 per-call fields 里传 `level`，最终记录的 level 仍是调用的方法名（`.info()` → `info`）。这防住"buggy 或恶意的 caller 把 debug 记录伪造成 error"。有专门测试覆盖此契约。

### 3. 必保事件清单（本 ADR 固化，删除即违反）

| 子系统 | 事件 | 级别 |
|---|---|---|
| runIMLoop | `runIMLoop start` / `runIMLoop completed` | info |
| runIMLoop | `guard tripped`（含 hits 数组 + finalMetrics） | warn |
| runIMLoop | `protocol error` / `shell terminated` | warn |
| runIMLoop | `tool errors in round`（errorCount / consecutiveToolErrors） | warn |
| runIMLoop | `driveCoordinator.tick unhandled rejection` | error |
| driveCoordinator | `tick` / `dispatchCompression start/ok/failed/skipped` | trace/info/error |
| driveCoordinator | `M3 archive dispatch start` / `warehouse run ok` / `failed` | info/error |
| driveCoordinator | `mailbox notice failed (…)` — mailbox 投递失败兜底 | error |
| stateLine | `appendBlock ok/failed` / `appendSummary ok/failed` / `rawArchive.append ok/failed` | debug/error |

**规则**：后续 PR 不得删除或降级以上事件；新增子系统时必须至少 emits 一条结构化记录（评审 checklist 项）。

### 4. mailbox 与 logger 双轨制

mailbox 通知是 **user-facing**（working agent 能读的提示），logger 记录是 **dev-facing**（排错证据）。所有 `systemSend` 调用点包 try/catch：mailbox 失败 → `logger.error('mailbox notice failed')` → 主流程不受影响。这关闭了"通知链单点故障导致静默丢错"的路径。

### 5. `IMLoopOptions.logger?: Logger` 可选注入，默认 `defaultLogger`

未传 logger 的 caller 行为完全不变（默认阈值 `warn`，几乎无输出）。注入的 logger 自动获得 `child({ component: 'im-loop', workingAgentId })` 绑定。DriveCoordinator 的 `DriveDeps.logger` 同理。

### 6. Logger 公开导出（Q1 = YES）

`src/index.ts` re-export `Logger` / `LogLevel` / `LogRecord` / `LogFields`（类型）与 `defaultLogger` / `createSilentLogger` / `setLevel` / `setSink` / `getLevel`（函数）。外部 caller（宿主应用、自研前端）可把 harness 日志接进自己的 ELK / pino / OpenTelemetry，无需 monkey-patch 模块全局。

### 7. `IMLoopResult` 不加 `rounds` 字段（Q2 = NO）

需要每轮 metrics 快照的 caller 注入 trace 级 logger 自行聚合（`round start` / `round shellCall ok` 已带 turn/elapsedMs/lastRequestTokens）。保持 79 个测试文件的 expect 模式不动。

---

## Consequences

- **正面**：压缩/归档管线全程可观测；fire-and-forget 不再静默丢错（顶层 `.catch` + 内部 catch 双保险）；guard trip / tool error / protocol error 有结构化现场（含 errStack）。
- **正面**：测试 899 → 974，其中 48 条直接验证 logger 契约（logger.test.ts 13 + loop-logger 6 + drive-logger 8 + state-line-logger 8 + stdio-env/turn-id/index-exports 13）。
- **代价**：测试期 stderr 出现大量 error 级记录（error 路径测试的预期输出）。测试 fixture 应 `setSink(() => {})` 静默——已在 logger 测试套件中约定。
- **已知残留**（记录在案，不阻塞）：state-line 的 stamp/block 双文件写入仍是两次独立 `appendFile`（进程被 SIGKILL 时可能留下孤儿 stamp），logger 现在能让这种不一致被观测到，但根治需要 fsync + 二阶段提交，属 v0.15。
