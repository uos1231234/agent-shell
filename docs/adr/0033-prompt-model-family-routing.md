# ADR-033: 提示词模型族路由（唯一基底 + 两个可注入槽位）

> Status: Active
> Date: 2026-09-12
> Context: v0.37。上一版"整份模板变体"（`PROMPT_DEEPSEEK_FULL` / `PROMPT_GLM_FULL`，
> +199 行）在审查中被判不合格——死代码、架构/记忆契约丢失、安全规则被削。用户拍板：
> 可照搬 MiMoCode 的只有**人格设定**与**workflow**两样；工具双披露、安全设计、
> 文件注入与维护机制一律保留自研；实现方式为"路由 + 段落级注入"。

---

## Context

### 上一版为什么不合格

MiMoCode（`mimo-cli/packages/opencode/`）的做法是：每个模型族一份**完整** `.txt` 提示词
（`src/session/prompt/*.txt`，15 份，最长 226 行、最短 39 行），由 `src/session/system.ts`
的 `provider()` 按 model id 子串返回**整份**。我们照此写了两份整份变体，审查发现三个问题：

1. **死代码**：`assembly.ts` 的 `buildStaticPrompt` 从不传 `modelId`，路由条件恒为
   `undefined` → 两份变体（148 行）零消费者。这是本项目接线纪律的**第 6 次**重演。
2. **功能回退**：变体是从通用模板**复制后改**的。复制时漏掉 `# Architecture Management`
   与 `# Memory Management` 两节契约——这两节只存在于提示词里，而注入源
   （`src/im/hooks/injections/{memory,architecture}.ts`）只裸贴文件内容、**不带任何
   "请维护此文档"的指令**，兜不住；安全规则同时从 7 条被削到 5 / 4 条，并丢掉了
   "后台命令必须前台 + timeout 并清理""不改生产配置"两条。
3. **结构病根**：MiMo 的变体之间**不共享任何片段**，改一条共用规则要改 N 份；派生副本
   在源变更后会静默漂移。**派生式变体必然漂移。**

### 决策前提（用户 2026-09-12 拍板）

- **可照搬**：人格设定、workflow 阶段结构。
- **必须保留自研**：工具双披露（`{tooling_section}` 清单 + 工具 schema 两处披露，用户
  判断"表现更好，模型更清楚自己具备什么能力"）、安全设计、文件注入与维护机制。
- **实现方式**：路由 + 段落级注入（匹配到就填槽，未匹配保持通用版）。

---

## Decisions

### D1 — 提示词只有一份基底，模型族差异只允许落在两个槽位

`FULL_PROMPT_TEMPLATE` 是唯一一份，首行 `{persona_section}`、工具披露之后
`{workflow_section}`。其余段落——安全 7 条 / 编码原则 / 代码信息驱动编程 /
**双工具披露** / 行动策略 / 架构与记忆契约 / 注入防御——**只有一份，变体结构上碰不到**。

**理由**：把"变体不许削安全、不许丢契约"从**纪律**变成**结构约束**。上一版三类问题中
有两类（契约丢失、安全被削）在新结构下**不可能发生**——没有第二个副本可以走样。
这与项目既有铁律同源：状态机 guard 全局一视同仁，不因前端/宿主而异。

### D2 — 槽位用显式占位符，不用标题锚点匹配

位置写在模板里（`{persona_section}` / `{workflow_section}`），填槽由
`selectPromptTemplate(mode, modelId)` 完成。

**理由**：挪位置 = 改模板一行，不必同步改匹配逻辑；标题锚点方案（按 `# Persona` 找到
段落替换）在模板改标题时**静默失效**。占位符还可被测试直接断言（"填槽后无残留"）。

### D3 — 路由输入是 model id 子串；未命中的模型也用升级后的通用段

`resolvePromptVariants(modelId)` 对 id 小写化后做子串匹配：命中 `deepseek` → DeepSeek 段；
命中 `glm` → GLM 段；其余（含无 id）→ 通用段。

通用段本身也是 **minimax 提炼版**——因此未被路由的模型族（kimi / qwen / 未来的族）一并
享受人格与 workflow 升级，而不是只有被路由的两族受益。

**实测依据**：model 字段取值是模型名（`deepseek-v4-flash` / `glm-5.3-flash`），与
`config/model-capabilities.ts` 的 `KNOWN_MODELS`（`/^deepseek-v4/i`、`/^glm-5/i`）同源，
子串匹配可靠。

### D4 — 素材照搬文本，但必须剥掉 MiMo 专属约束

人格与 workflow 取自 MiMoCode 的 `prompt/minimax.txt`（该族人格写得最强：
"You are not a chatbot. You are an engineer with a keyboard and a deadline."）。

**剥掉的**：`Bun` / `CLAUDE.md` / `packages/opencode` / `question`·`actor`·`task` 工具名 /
"powered by minimax"。**理由**：照抄会教模型调用本仓库不存在的工具，比不写更糟。

### D5 — 不搬数字硬限，"有界探索"改成可检查条件

MiMo 只在 `deepseek.txt` 里写了"Explore 限 15 次工具调用"，且该数字无依据。我们改为
条件式规则："同一文件或同一 region 读了两次、或同一搜索只做微小变化重复执行 → 已有足够
上下文，停止探索。"

**理由**：可核对的条件比拍脑袋的数字更能被执行；也不与状态机 guard（`maxSteps` 500）
形成第二套互相矛盾的阈值。

### D6 — 扩展规则：新增模型族只允许写这两个段

新增一族的成本 = 一份 `PERSONA_*`（必要时加 `WORKFLOW_*`）+ 路由里一行。

**明确禁止**："这个族的安全规则/工具清单要单独写一份"。若某族确实需要不同的安全策略，
应改**唯一那份**安全段（全族生效），而不是开新副本——**安全策略不因模型族而异**。

---

## Consequences

**正面**

- 三类历史问题中被结构消除两类：契约丢失、安全规则被削**不可能**再发生。
- 新增族成本极低（一个常量 + 一行路由）。
- 填槽可测：测试断言"统一段对每个族都恰好出现一次"，把保证写进 CI。
- 未命中的模型族照样享受人格/workflow 升级。

**代价与已知边界**

- 模型 id 判定现有**两处**独立实现：`config/model-capabilities.ts` 的 `KNOWN_MODELS`
  （前缀正则，判**思考能力**）与 `static-prompt.ts` 的 `resolvePromptVariants`（子串，判
  **人格/workflow**）。**未来新增族要改两处**。规模小、语义不同，暂可接受；若要统一，
  应抽 `resolveModelFamily(modelId)` 同源。
- 路由依赖用户在 `providers.json` 填的 `model` 字符串含族名。若用户给模型起了不含族名的
  别名（如 `my-fast-model`），会静默落到通用段——**降级而非报错**。这是刻意的：提示词不该
  因为命名而让会话不可用。

---

## 明确不做（本轮）

- **Git Safety 段**：MiMo 的 `# Git Safety` 有若干好条目（`git add -A` 风险、`-i` 交互
  旗标），但用户裁定只搬人格 + workflow，故未搬。现有通用模板本就没有该段。
- **minimal 模式路由**：子代理模板不参与路由（`selectPromptTemplate` 直接返回
  `MINIMAL_PROMPT_TEMPLATE`）。子代理人格是否分族，待有实证需求再议。
- **kimi / minimax / qwen 等族**：暂走通用段；加族按 D6 规则。
- **`buildToolingSection` 的中文输出头**（`你可以使用以下工具完成任务：`）：属 benchmark
  临时英文线遗留。**用户 2026-09-12 判断：英文里一句中文反而醒目，对工具提示是加分，
  保持不动。**
