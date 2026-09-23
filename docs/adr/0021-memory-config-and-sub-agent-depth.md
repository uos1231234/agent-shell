# ADR-021: MemoryConfig + maxSubAgentDepth — magic numbers become caller-configurable (v0.14)

**Status**: Active (2026-09-01)

**Context**: v0.13 评审发现两个阈值硬编码在模块常量里，所有调用方共享同一数字，无法按场景调整：

1. `MEMORY_LAYER_THRESHOLDS = { M1: 200_000, M2: 500_000, M3: 900_000 }`（memory-layers.ts）——M0–M3 记忆分层的全部边界。测试环境想用小阈值验证分层行为，生产环境想按模型窗口调大，都做不到。
2. `MAX_SUB_AGENT_DEPTH = 3`（run-subagent.ts）——子代理递归深度上限。调整需要改源码。

---

## Decision

### 1. `MemoryConfig` 是独立类型，不是 ShellConfig 的字段

```typescript
// src/shell/memory-config.ts
export type MemoryConfig = {
  m1MinTokens: number   // M0 → M1 crossing. Default 200_000
  m2MinTokens: number   // M1 → M2 crossing. Default 500_000
  m3MinTokens: number   // M2 → M3 crossing. Default 900_000
}
```

**理由**：ShellConfig 是 runtime guard 配置（token/iter/toolRate/time/errorRate，ADR-003 "shell has no business fields"）；MemoryConfig 是信息流分层配置。混在一起会把无关关注点耦合进同一类型。放在 `src/shell/` 是因为分层投影本质是 shell 层关注。

M1/M2 schema-sharing 不变式注释（原 state-line/index.ts）随类型迁移至此——阈值是决定"进哪层"的唯一旋钮，层再决定持久化 schema，而不是反过来。

### 2. `classifyMemoryLayer(tokens, config?)` 双参签名，默认 `DEFAULT_MEMORY_CONFIG`

单参调用行为不变（原子迁移：默认值 = 原常量值）。`MEMORY_LAYER_THRESHOLDS` 常量保留（测试与 `createSignalBus` 默认 bus 仍引用），不强制迁移。

`memoryConfig` 经 `IMLoopOptions` → `buildContextProjection` + `DriveSnapshot` 两处贯穿——**两个 layer 判定点必须看到同一份配置**，否则投影认为 M0 而协调器认为 M1 就会精神分裂。

### 3. `maxSubAgentDepth` 进 ShellConfig（不是 MemoryConfig）

`ShellConfig.maxSubAgentDepth: number`，`DEFAULT_CONFIG` = 3。它是递归上限（runtime guard 语义），不是信息流配置，归 ShellConfig。

深度解析优先级（run-subagent.ts execute 时点）：

```
effectiveMaxDepth = cfg.config?.maxSubAgentDepth      // 子代理自己的 override
                  ?? deps.defaultConfig?.maxSubAgentDepth  // 工作代理的 config
                  ?? DEFAULT_CONFIG.maxSubAgentDepth       // 3
```

子代理只能**调低**不能调高——`validateShellConfigOverrides`（v0.11.1 P2.4）对 `maxSubAgentDepth` 施加"正整数 ≤ DEFAULT_CONFIG"约束，与 maxTokens 等其余字段同规。

### 4. `RunSubagentDeps.defaultConfig` 是可选的

偏离 v0.14 计划草案（原要求必填）。可选 + DEFAULT_CONFIG 兜底使既有测试 helper（makeDeps / inline 构造）零改动。代价：极少数不传 defaultConfig 又自定义了 ShellConfig.maxSubAgentDepth 的 caller，其自定义值对子代理深度不生效（回退 DEFAULT 3）——登记为已知边界，修法是 caller 显式传 deps.defaultConfig。

---

## Consequences

- 测试可用 `classifyMemoryLayer(tokens, { m1MinTokens: 100, ... })` 在小数值下验证分层逻辑（新增 tests/shell/memory-config.test.ts 5 条 + tests/im/memory-layers-custom.test.ts 5 条）。
- 子代理深度可按 config 收紧（新增 tests/im/sub-agent/depth-config.test.ts 9 条：校验拒绝/通过、自定义深度生效、三级 fallback 优先级）。
- 向后兼容：不传任何新字段的 caller 行为与 v0.13 完全一致。
- `src/index.ts` 导出 `MemoryConfig` / `DEFAULT_MEMORY_CONFIG`，外部 caller（宿主应用）可为不同模型窗口配不同分层。
