# agent-shell LLM 服务功能清单（DeepSWE 测试对照用）

> 日期：2026-09-12
> 用途：DeepSWE 测试时逐项对照验证——每个功能标注"测试时怎么观察它是否生效"。
> 范围：仅为 LLM 服务的功能（工具/上下文/守卫/协议），不含前端 UI。
> 落盘位置：工作区 + 评测工作区（两份）。

---

## A. 文件 / 搜索 / 执行工具（LLM 直接调用）

- [ ] **read** — 读文件（1-based 行号，offset/limit 分页；read 检查存在性 + notFoundHint）
- [ ] **write** — 写文件（自动建父目录；write 不检查存在性）
- [ ] **edit** — 精确替换（oldText 必须唯一匹配）
- [ ] **ls** — 列目录
- [ ] **find** — 文件查找
- [ ] **grep** — 内容搜索（ripgrep 硬依赖，无 Node 降级）
- [ ] **search_replace** — 跨文件批量替换
- [ ] **ast_grep** — AST 结构搜索
- [ ] **bash** — shell 命令执行
- [ ] **powershell** — Windows PowerShell 执行
- [ ] **web_fetch** — 网页抓取（SSRF 防护）
- [ ] **open_url** — 系统默认浏览器打开 URL（仅 http/https）
- [ ] **read_media** — 读图 base64 喂视觉模型（≤4MB）
- [ ] **fetch_output** — 截断输出分段回读
- [ ] **request_user_input** — 向用户提结构化问题（阻塞等回答）

**测试观察点**：databus.jsonl 里每条工具事件（toolName + args + 结果 + isError）。

## B. 系统工具（agent 基础设施）

- [ ] **state_query** — 查状态线（stamps/range/layer 元数据查询；queryText 语义查询；rawArchiveIds 深召回原文）
- [ ] **ask_recall** — 问 recall agent（scope: compressed=M1/M2 / archive=M3 / *=全部）
- [ ] **databus_query** — 查工具活动史（databus 投影）
- [ ] **databus_subscribe** — 订阅工具活动事件
- [ ] **mailbox_send** — 发跨代理邮件
- [ ] **mailbox_read** — 读邮件
- [ ] **mailbox_status** — 邮箱状态
- [ ] **mailbox_markread** — 标记已读
- [ ] **load_tools** — 渐进式工具披露（按需加载 MCP/skill 工具 schema）
- [ ] **define_subagent** — LLM 定义子代理（声明式配置，可落盘）
- [ ] **run_subagent** — 运行子代理（树形嵌套，深度 ≤3）
- [ ] **record_m3_summary** — warehouse 写 M3 十合一索引（仅 warehouse 可调）

**测试观察点**：databus.jsonl + conversation.jsonl 工具回合 + state-line jsonl 文件。

## C. 记忆分层 M0–M3（上下文工程核心）

- [ ] **M0 原始上下文** — <200K token 不压缩，直接用 canonical turns
- [ ] **M1 填充板压缩** — ≥200K 触发，compressor agent 产出 11 字段 CuratedMemory
- [ ] **M2 ⛔ 已注释下线（2026-09-12 用户拍板）** — M2 独立"摘要压缩"形态未实现（zone 元数据被 SystemAgent 忽略、compressor prompt 无 M1/M2 差异化），M1→M2 跨越派发属同机制重复且 M2 标签块有投影可见性缝隙 → **M2 跨越不再派发压缩，仅消费跨越位**；M3 sustained zone 回落 'M1'。500K-900K 区间少压的块由 M3 sustained 兜底，1M guard 不变。恢复点见 drive-coordinator.ts tick 注释
- [ ] **M3 入库归档** — ≥900K 触发，warehouse 生成十合一 summary + RAG 索引
- [ ] **drive-coordinator 自动调度** — 每轮 finalize 后 tick，检查 contextTokens 跨层 → dispatchCompression
- [ ] **raw-archive 原文保留** — 压缩逐出前，完整 ChatMessage[] 落盘 raw-archive.jsonl（服务 M3 深召回）
- [ ] **交接笔记压缩 (compaction)** — 上下文达 0.85×maxTokens 时，LLM 写第一人称笔记 + replaceRange 原位折叠
- [ ] **历史工具表折叠** — 工具回合 >热窗口 20 且 result>2000 token 的批次折叠成 markdown 表（纯算法不调 LLM）
- [ ] **压缩失败重试** — 3 次 × 15s 间隔；仍失败 → systemSend 通知工作代理
- [ ] **压缩块双写联动** — 同一 summaryStamp 同时写 curated block + raw archive（可 join 回溯）

**测试观察点**：
- `memory.activity` 信号（activity: memory.compressed / memory.archived，带 layer/stamp/taskGoal）
- drive-coordinator 日志（dispatchCompression start/ok/failed + tick(contextTokens/layer)）
- raw-archive.jsonl（被压缩的完整原文）+ curatedMemory.jsonl（压缩产物）+ index.jsonl（M3）

## D. 子代理系统

- [ ] **define_subagent 落盘** — LLM 定义的子代理写 `~/.databus/agents/<name>.json`
- [ ] **run_subagent 树形嵌套** — AgentTree 挂子节点，UUID instance id，深度守卫（≤3）
- [ ] **family bus 隔离** — 子代理投影到 parent.familyDatabus（兄弟共享）；上下文读 = [own, parent.own]
- [ ] **SubAgentToolPolicy** — 默认 deny run_subagent/define_subagent/bash/powershell/write/edit；可经装配注入自定义 policy
- [ ] **向下配置开关** — settings.json `subAgentNesting`，开 = 去 run_subagent/define_subagent 两条 deny（新会话生效）
- [ ] **sessionId/hooks 继承** — 子代理继承父会话 UUID 和 hooks

**测试观察点**：run_subagent 工具事件 + 子代理独立 loop 的 databus 条目（sourceAgentId 为 instance id）。

## E. 上下文投影（每轮 LLM 看到什么）

- [ ] **系统提示词** — buildStaticPrompt FULL 模板（编码原则 + 行动策略 + 工具清单按 exposedSystemToolRefs 白名单）
- [ ] **stateLine 状态摘要** — 每轮投当前记忆层状态
- [ ] **memory injection** — workDir 下 MEMORY.md 注入
- [ ] **architecture injection** — workDir 下 ARCHITECTURE.md 注入
- [ ] **temporal/runtime injection** — 时间/运行时信息注入
- [ ] **text skill 预注入** — .md/.txt skill 全文进 system prompt
- [ ] **MCP server summary** — 已装配 MCP server 摘要块
- [ ] **prompt injection defense** — 上游不可信时追加防注入段

**测试观察点**：system.prompt 信号（session.event）+ 每轮 composePrompt 产出。

## F. Guard 守卫（状态机保护）

- [ ] **token guard** — lastRequestTokens > maxTokens 时触发
- [ ] **iter guard** — stepCount > maxSteps 时触发
- [ ] **toolRate guard** — toolCallCount > maxToolCalls 时触发
- [ ] **time guard** — elapsedMs > maxElapsedMs 时触发
- [ ] **errorRate guard** — 连续工具错误 > maxConsecutiveToolErrors 时触发

**测试观察点**：`guard tripped` 日志 + runIMLoop 返回 reason='guard-tripped' + hits 数组。

## G. 安全门（工具执行前检查）

- [ ] **sensitive-path door** — .env / id_rsa / .ssh / .aws/credentials 等敏感路径检测
- [ ] **dangerous-command door** — rm -rf / curl|sh / dd / sudo 等危险命令递归分析
- [ ] **write-approval door** — 写文件需人类审批（300s 超时 fail-closed；grant 按路径记账）
- [ ] **browser-tools door** — 浏览器工具限制
- [ ] **wiki guard** — wiki__ 前缀工具仅 wiki agent 可调（ctx.isWikiAgent）

**测试观察点**：审批请求（Gate request 信号）+ 工具拒绝错误消息。

## H. Hook 体系（5 个干预点）

- [ ] **HOOK 1 beforeShellCall** — block/retry（注：交接笔记压缩在此前置）
- [ ] **HOOK 2 afterShellCall** — retry/terminate/synthetic 替换
- [ ] **HOOK 3 afterGuards** — forceTerminate
- [ ] **HOOK 4 beforeToolExecution** — block/synthetic tool results
- [ ] **HOOK 5 afterToolExecution** — 变换工具结果（历史工具表折叠在此执行）

**测试观察点**：装配了 hooks 时对应的日志/行为变化；默认 web-host 装配了 gateHooks + compaction。

## I. MCP / Skill 扩展

- [ ] **MCP stdio 连接** — 子进程方式（env 白名单：PATH/HOME/USERPROFILE/LANG/LC_ALL/TZ/TMPDIR/TMP/TEMP）
- [ ] **MCP http 连接** — 远程端点
- [ ] **MCP 工具注册** — server__tool 扁平名 + registerMCPServerMeta
- [ ] **module skill** — .ts/.js 模块 skill（loadSkillsFromDir + registerSkill）
- [ ] **text skill** — .md/.txt 文本 skill（registerTextSkill + 预注入）
- [ ] **load_tools 动态加载** — LLM 按需加载 MCP/skill 工具 schema（不预注入全量）
- [ ] **MCP instructions 丢弃** — 默认 discard（mcpInstructionsMode），server instructions 不进 prompt

**测试观察点**：`load_tools` 工具事件 + dynamicSchemas 注入 + server summary。

## J. 协议层（LLM 交互控制）

- [ ] **reasoning_content 解析** — ARK 流式 SSE 的 thinking delta → StreamChunk reasoning_delta（聚合不进正文）
- [ ] **thinking 强度控制** — off/low/high/max 档位（provider.thinking 强制 > reasoningEffort 选择 > defaultEffort）；glm-5 系 always-thinking 不可关
- [ ] **max_tokens 注入** — 出站请求带模型声明输出上限（消除服务商默认 ~12000 截断）
- [ ] **400 self-heal** — thinking 不支持时剔除 thinking extra 透明重试一次
- [ ] **模型目录** — 单服务商多模型（ProviderConfig.models[] + reasoningEffort 切换）
- [ ] **turn.cancel 三层真取消** — assembly signal → ToolContext.signal → 审批门竞速

**测试观察点**：metrics.usage（含 reasoning_tokens）+ 出站请求体。

## K. 可观测落盘（服务验证与深度召回）

- [ ] **conversation.jsonl** — canonical turns（user/assistant 简化文本 + tool 回合），服务恢复 + 压缩块判定
- [ ] **databus.jsonl** — 工具活动全记录（toolName + args + 结果 + isError + sourceAgentId），args 全量保留
- [ ] **raw-archive.jsonl** — 压缩前完整 ChatMessage[]（M3 深度召回原文源）
- [ ] **curatedMemory.jsonl** — M1/M2 CuratedMemory 11 字段块
- [ ] **index.jsonl** — M3 十合一 summary（含 raw_archive_ids 回指原文）
- [ ] **stamps.jsonl** — stamp → path/layer 映射
- [ ] **mailbox.jsonl** — 跨代理邮件
- [ ] **memory.activity 信号** — 压缩/归档实时可见
- [ ] **metrics.lastRequestTokens** — 每轮请求 token 数（压缩触发依据）
- [ ] **warehouse 持久会话** — `<dataDir>/<sessionId>/state/warehouse-session.jsonl`（M3 后跨 run 保留）
- [ ] **warehouse 私有 databus** — `warehouse-session-databus.jsonl`

**测试观察点**：`<dataDir>/<sessionId>/` 目录下全部 jsonl 文件。

---

## 汇总统计

| 类 | 功能条数 | 说明 |
|---|---|---|
| A 文件/搜索/执行工具 | 15 | LLM 直接调用的操作能力 |
| B 系统工具 | 12 | agent 基础设施（状态/记忆/邮箱/子代理/工具加载） |
| C 记忆分层 M0–M3 | 10 | 上下文工程核心（压缩/归档/召回） |
| D 子代理系统 | 6 | 多代理编排 |
| E 上下文投影 | 8 | 每轮 LLM 看到什么 |
| F Guard 守卫 | 5 | 状态机保护 |
| G 安全门 | 5 | 工具执行前安全检查 |
| H Hook 体系 | 5 | 状态机干预点 |
| I MCP/Skill 扩展 | 7 | 外部工具生态 |
| J 协议层 | 6 | LLM 交互控制 |
| K 可观测落盘 | 11 | 验证与深度召回 |
| **总计** | **90** | |

---

## 附录：系统提示词组装机制（详细）

> 验证压缩/上下文工程时，理解"模型每轮实际看到什么"的完整链路。全部 `[已验证]` 源码（loop.ts composePrompt / shell/compose.ts / context-projection.ts / prompt/section-builder.ts）。

### 1. 静态层——每会话组装一次（buildStaticPrompt）

```
模板选择：FULL / MINIMAL / NONE（中文模板，src/im/prompt/）
  ↓
{agent_name} 替换（working agent 名）
  ↓
{tooling_section} 替换 = buildToolingSection：
  - exposedSystemToolRefs 白名单传入 → 只列白名单内工具的 name+description
    （v0.25 修复：web-host 与 loop 同源同串；省略 → 全量 listSystemTools 兜底）
  - 有 MCP server meta / loadable skill meta 时追加"用 load_tools 按需加载"提示行
  ↓
promptInjectionDefense=true（--untrusted-upstream 或 providers.json upstreamTrusted=false）
  → 追加注入防御段（FULL/MINIMAL 各有专属版本；NONE 无对象不加）
  ↓
{dynamic_sections} 占位符保留 → 运行期 ContextInjector 消费
```

静态产物 = `opts.systemPrompt`，存进 SessionAssets，**每轮复用同一字符串**（前缀稳定，利于服务商前缀缓存）。

### 2. 每轮动态组装（composePrompt，顺序固定不可变）

```
① system part
   = opts.systemPrompt（静态层产物）
   + projection.systemSuffix（buildContextProjection 产出）：
     · [mailbox] you have N unread（有未读邮件时）
     · [context overflow] M3 available via state_query/ask_recall（仅 M3 层，
       按该 agent 实际拥有的工具定制措辞——子代理没有 ask_recall 就只提 state_query）

② afterSystem injections（ContextInjector，position='afterSystem'）
   · runtime.ts — 运行时信息
   · temporal.ts — 时间信息
   · mcp-summary.ts — MCP server 摘要

③ conversation history
   = conversationMemory.turns() 逐条 turnToMessage
   （canonical 顺序：user → assistant(tool_calls) → tool → … → assistant）

④ userTemplate = 本轮用户消息

⑤ afterUser injections（position='afterUser'）
   · memory.ts — workDir/MEMORY.md 注入
   · architecture.ts — workDir/ARCHITECTURE.md 注入

⑥ stateLinePart（buildContextProjection 产出，非 null 时插入）
   = selectStateLineBlocks：按当前记忆层选块
     · M0 → 无块（不压缩无产物）
     · M1 → query({layer:'M1'})
     · M2 → 方案 B：双查 M1+M2 合并，预算对半
     · M3 → query({layer:'M3'})（M3 summaries）
   formatStateLinePrompt 格式化为一条 system part

⑦ systemTool parts = systemToolRefs 白名单逐个 registry.getSystemTool(ref)
   → schema 推入 tools[]（OpenAI function 数组）——LLM 可调用的静态工具全集

⑧ mcpServerSummary part → 原地追加到最后一条 system 消息（server/skill 概览）

⑨ dynamicSchema parts = 本轮 load_tools 加载的 MCP/skill 工具 schema
   → 带扩展 tools 字段的 system 消息（wire 契约：provider 读该字段的工具本轮可调）

⑩ skillText parts（injectTextSkills!==false 时）
   = registry.getTextSkills() 逐个追加到最后一条 system 消息（空行分隔）
```

**组装顺序是信息流架构的核心不变式**：system → afterSystem → history → user → afterUser → stateLine → tools → serverSummary → dynamicSchemas → skillText。hook 和投影只能**加内容**，不能**改顺序**。

### 3. 渲染层（compose.ts：parts → wire 格式）

| part 类型 | 渲染目标 |
|---|---|
| system / userTemplate / turn | messages[]（ChatMessage 序列） |
| systemTool / dynamicSchema | tools[]（function schema 数组） |
| mcpServerSummary / skillText | 原地追加到最后一条 system 消息的 content |
| turn(tool) | assistant(tool_calls) + role:'tool' 结果消息严格配对（孤儿 tool_call → 400） |

### 4. 测试观察点

- **静态层**：`session.event system.prompt` 信号携带 systemPrompt 全文（web-host 每会话 emit）——核对工具清单是否 = exposedToolRefs 白名单、注入防御段是否在
- **动态层**：每轮实际 prompt = ①-⑩ 的顺序拼接；`metrics.lastRequestTokens` 反映总大小；压缩后对比 stateLinePart（⑥）出现 curated 块摘要、history（③）变短
- **工具面**：tools[] = ⑦静态白名单 + ⑨动态加载；**提示词宣传的清单（静态层 tooling_section）必须与 tools[] 一致**（v0.25 修复的脱节问题）
