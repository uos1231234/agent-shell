# ADR-034: 委托授权段——提示词镜像运行时授权（subAgentNesting）

> Status: Active
> Date: 2026-09-13
> Context: v0.40。用户在 `subAgentNesting`（"子代理向下配置开关"）开启后，
> 运行时允许子代理嵌套创建子代理，但提示词侧有两个脱节点：MINIMAL 模板
> 仍**无条件禁止**嵌套（"Do not spawn further sub-agents"），FULL 模板没有
> 任何授权与树规则声明。**提示词比运行时更严 = 授权静默失效**：模型是文字
> 动物，被运行时授予了工具却被告知禁止，弱模型会照做拒绝嵌套。

---

## Context

### 现有机制的三个事实（[已验证]）

1. `static-prompt.ts:227`（v0.40 前）MINIMAL 模板无条件禁止嵌套，无任何开关能翻转。
2. 开关只控制运行时工具面：`assembly.ts:419` `resolveSubAgentToolPolicy()` ——
   `subAgentNesting !== true` → `DEFAULT_SUB_AGENT_TOOL_POLICY`（deny
   run_subagent/define_subagent + 写类 + shell 类）；`=== true` →
   `PERMISSIVE_SUB_AGENT_POLICY`（边界 = 各级子代理自己的 toolRefs 白名单）。
3. 深度守卫 `maxSubAgentDepth=3` 正交兜底（`run-subagent.ts:134-146`），
   对两种开关状态一律生效——提示词承诺的能力绝不能越过它。

### 决策前提（用户拍板）

- **方向确认**（2026-09-12）：开关开启时提示词侧注入授权段（FULL 在人格段
  之后；MINIMAL 的禁止行条件化）。
- **修订**（2026-09-12）：**触发授权的子代理必须同时拿到完整委托教学（向
  FULL 看齐），不是一句"你被授权了"**——授权而不会用，等于把"无限读代码
  不写码"的失败模式传染给每个子代理。
- 措辞纪律：**不用"无限"**，写真实守卫（深度 3、独立 loop/上下文、
  define_subagent 会话级）；铁律：提示词只能声称运行时实际授予的能力。

---

## Decisions

### D1 — 提示词只镜像"运行时实际授予的能力"，两个面读各自面的最终事实

- FULL 侧条件 = `readSettings().subAgentNesting === true`（主代理没有 config
  policy 层，开关是其递归能力的唯一决定因素）。
- MINIMAL 侧条件 = **该子代理是否真持有 run_subagent**：
  `cfg.toolRefs.includes('run_subagent') && applyToolPolicy('run_subagent',
  effectiveToolPolicy(cfg))`——与子代理 loop 的 load_tools 过滤**同构**。
- **子代理侧不读全局开关**：v0.39 起 per-config toolPolicy 生效
  （`EDITOR_TOOL_POLICY` deny 递归），读开关会在"开关 ON + 编辑器角色"
  场景下向子代理谎报授权；读 effectivePolicy 是"把开关沿授权链解算后的
  最终事实"，任何配置组合下都不会撒谎。

**理由**：提示词-运行时脱节是本项目反复踩的坑（v0.25 exposedSystemToolRefs
"提示词宣传 = 模型实际拿到"、§5 接线验收纪律）。判定谓词与运行时过滤同构，
从结构上消灭"提示词说有、运行时没有"的窗口。

### D2 — 同源单入口 `readSettings()`，漂移面为零

`createHostAssembly` 新增一个 settings.json 读取入口（`settingsHomeDir` 仅供
测试注入，生产缺省 = 真实家目录，行为零变化），**toolPolicy 判定、提示词
委托授权条件、Gate settings.get 三处共用**。不存在"开关与提示词各读各的"。

### D3 — MINIMAL 禁止行条件化，授权 = 教学而非许可

原 `- Do not spawn further sub-agents...` 一行改为 `{delegation_section}`
槽位：

- 触发 → 注入 `DELEGATION_AUTHORIZATION_MINIMAL`：授权声明（深度 3、从主代理
  计数）+ **完整委托教学**（并行化/隔离重活/保护上下文/怎么写 brief/结果按
  报备链返回）+ define_subagent 会话级条款；
- 未触发 → 注入 `MINIMAL_DELEGATION_PROHIBITION` **逐字原文**——行为与
  v0.39 完全一致，向后兼容有测试断言。

FULL 侧 `{delegation_section}` 槽位在人格段之后；未授权时**整行移除**，
模板与 v0.39 字节一致（有 `toBe` 断言）。

### D4 — 教学内容单一事实源

FULL/MINIMAL 两个授权段常量同文件定义（`static-prompt.ts`），核心教学理念
一致（何时委派/怎么写 brief/不写"基于你的发现修复 bug"）；MINIMAL 变体只
追加子代理特定条款（你本身是子代理、报备链、深度从父链累计）。教学与既有
"Delegating to Sub-agents" 段互补：授权块回答"你能否/多深"，教学段回答
"怎么委派"。

### D5 — 信号关零新增通道；新会话生效语义保持

- 开关写入 = 既有 Gate `settings.set` 命令 → 落盘 settings.json → attach 读取；
- 结果送达前端 = 既有 `session.event system.prompt` 出站事件；
- **没有新增任何命令/路由/事件/旁路**；
- 系统提示词是 attach 快照（拼一次、跨轮稳定），settings 变化只对**新 attach
  的会话**生效（v0.25 拍板语义，v0.40 保持）；**不是热更新**——运行中进程
  的模块内存不变，需重启 host 才吃新代码。

---

## Consequence

- 提示词与运行时授权的三类脱节（宣传过头 / 宣传不足 / 各读各的）在此特性上
  全部被结构约束消除。
- 新增 `settingsHomeDir` 测试缝（沿用 `promptLayerUserPath` 先例），host 层
  e2e 可在隔离家目录验证"Gate 写盘 → 新会话生效"全链。
- 验证：全量 2619 tests / 231 文件绿，tsc 0 错；三条 host e2e 覆盖 ON 三面
  可见（assets.prompt / LLM 请求体 / Gate system.prompt 事件）、OFF 无泄漏、
  Gate 写盘 → 新会话生效。