// Tool-registration iron rule (v0.12.2): the ToolRegistry holds ONLY
// LLM-callable tools (tools with a schema + description exposed to a model
// via systemToolRefs). Framework-internal capabilities — compressor.run(),
// warehouse.run(), recall.run(), drive-coordinator — are plain function
// calls and must NEVER be registered as tools. compress_block is retired
// (see below) because drive-coordinator now drives compression directly.
//
// v0.10.1c + v0.11: registerSystemAgentTools — registers all system-agent-backed
// tools with the working agent's ToolRegistry. Each tool factory captures
// its dependency via closure. databus_query and databus_subscribe read directly
// from ctx (databus + sharedDatabus + agentId), no longer delegate to
// warehouse.run() — eliminating the recursion where warehouse's own toolRefs
// included databus_query.

import type { ToolRegistry } from '../../shell/registry.js'
import type { Mailbox } from '../mailbox/index.js'
import type { SystemAgent } from '../system-agent.js'
import type { StateLine } from '../state-line/types.js'
import type { ContextInjector } from '../hooks/context-injection.js'
import type { StreamChunk, ChatMessage } from '../../protocol/types.js'
import { createDatabusQueryTool } from '../tools/databus-query.js'
import { createDatabusSubscribeTool } from '../tools/databus-subscribe.js'
import { createStateQueryTool } from '../tools/state-query.js'
// v0.12.2: createCompressBlockTool import retired — compress_block is no longer
// registered (drive-coordinator drives compression directly). The tool file
// (tools/compress-block.ts) is kept for reference only.
// import { createCompressBlockTool } from '../tools/compress-block.js'
import { createAskRecallTool } from '../tools/ask-recall.js'
import { createMailboxSendTool } from '../tools/mailbox-send.js'
import { createMailboxReadTool } from '../tools/mailbox-read.js'
import { createMailboxReadAnyTool } from '../tools/mailbox-read-any.js'
import { createMailboxStatusTool } from '../tools/mailbox-status.js'
import { createMailboxMarkReadTool } from '../tools/mailbox-markread.js'
// v0.12.4: createRecordCuratedBlockTool import retired — record_curated_block
// is no longer registered. v0.42（用户拍板 2026-09-16）：压缩协议对齐参考实现
// curator-client.ts 的 function-calling 方案——不再是"回复自由文本 JSON、协调器
// 事后解析"，而是压缩机调用 submit_curated_memory 提交（服务端 schema 约束），
// 校验失败作为 tool result 回传、同一对话内修复。工具文件
// （tools/record-curated-block.ts）仍保留仅供参考，**不要重新注册**。
// import { createRecordCuratedBlockTool } from '../tools/record-curated-block.js'
import { createSubmitCuratedMemoryTool } from '../tools/submit-curated-memory.js'
import { createRecordM3SummaryTool } from '../tools/record-m3-summary.js'
import { createDefineSubagentTool } from '../tools/define-subagent.js'
import { createRunSubagentTool, type RunSubagentDeps } from '../tools/run-subagent.js'
import { createLoadToolsTool } from '../tools/load-tools.js'
import { DEFAULT_CONFIG } from '../../shell/config.js'
import { SubAgentRegistry } from '../sub-agent/index.js'
import type { TokenCounter } from '../../shared/token-counter.js'

export type RegisterSystemAgentToolDeps = {
  llmStreamChat: (
    url: string,
    request: { model: string; messages: ChatMessage[]; tools: unknown[]; [k: string]: unknown },
  ) => AsyncIterable<StreamChunk>
  url: string
  model: string
  stateLine: StateLine
  // 会话工作区（权限边界）。透传给 run_subagent deps → 子代理 systemPrompt
  // 前置工作区声明 + 子代理 loop 的 runtime 注入。缺省不前置（测试/旧调用方）。
  workDir?: string
  // v0.30（用户拍板 2026-09-09）：模型能力声明（providers.json capabilities）。
  // 透传给 define_subagent：schema 描述带宿主模型真实输入/输出上限（AI 配
  // 子代理预算不再盲配）+ maxTokens 校验上限收紧到模型 maxInputTokens。
  // 缺省 undefined = 未声明（描述回落通用文案，校验上限保持 harness guard）。
  modelCaps?: { maxInputTokens?: number; maxOutputTokens?: number } | undefined
  /**
   * v0.34 D13（用户拍板 2026-09-10）：子代理共享的工作区级上下文。
   * 透传给 run_subagent deps → 子代理拿到 AGENTS.md 层叠与四类注入
   * （此前只有 WORK_DIR_RULE + 角色 prompt，与工作代理不对称）。
   * 只共享工作区级事实；对话历史/databus/state-line 仍严格隔离（ADR-0017）。
   */
  contextInjector?: ContextInjector
  /** v0.34 D13：AGENTS.md 四级层叠文本，由装配层在 workDir 上加载一次传入。 */
  layeredPrompt?: string
  /**
   * v0.41 D19 覆盖面扩展（用户拍板 2026-09-14）：provider 严格角色交替开关，
   * 透传给 run_subagent deps → 子代理 loop。子代理与系统智能体同因需要它
   * （createSystemAgent 硬编码 userTemplate: '' → 请求尾部一条空 user 消息）。
   */
  strictAlternation?: boolean | undefined
  tokenCounter?: TokenCounter | (() => TokenCounter)
  // v0.12: workingDatabus removed; the working agent's bus is discovered via
  // subAgentRegistry.agentTree (root node bound by createMinimalIM).
}

export const registerSystemAgentTools = (
  registry: ToolRegistry,
  mailbox: Mailbox,
  systemAgents: { warehouse: SystemAgent; compressor: SystemAgent; recall: SystemAgent },
  subAgentRegistry?: SubAgentRegistry,
  subAgentDeps?: RegisterSystemAgentToolDeps,
): void => {
  // 召回两兄弟分属两个并发桶（2026-09-17 用户拍板）：
  // - databus_query：内存内确定性工具事件召回（无 LLM、无子进程），是"方案 A 压缩后
  //   工具戳仍可召回"的主通路，限流会直接削弱召回能力 → 'read' 桶（5）。
  // - state_query：读磁盘 curated/raw-archive + chroma RAG，回执体量与剩余预算无关
  //   → 'recall' 桶（1），一轮最多一个深度召回，防止并发把整段历史灌进窗口。
  registry.registerSystemTool({ ...createDatabusQueryTool(), category: 'read' })
  registry.registerSystemTool(createDatabusSubscribeTool(mailbox))
  registry.registerSystemTool({ ...createStateQueryTool(), category: 'recall' })
  // v0.12.2: compress_block is retired — drive-coordinator drives compression
  // by calling compressor.run() directly (drive-coordinator.ts:189). The tool
  // file (tools/compress-block.ts) is kept but no longer registered.
  // registry.registerSystemTool(createCompressBlockTool(systemAgents.compressor))
  registry.registerSystemTool(createAskRecallTool(systemAgents.recall))
  registry.registerSystemTool(createMailboxSendTool(mailbox))
  registry.registerSystemTool(createMailboxReadTool(mailbox))
  // mailbox_read_any：跨邮箱读信，**仅 recall 的 toolRefs 引用**（toolRefs 才是
  // 暴露面——registry 注册不等于可见）+ execute 内 ctx 身份双保险（2026-09-22）。
  registry.registerSystemTool(createMailboxReadAnyTool(mailbox))
  registry.registerSystemTool(createMailboxStatusTool(mailbox))
  registry.registerSystemTool(createMailboxMarkReadTool(mailbox))
  // v0.10.4 record tools: compressor-only and warehouse-only persistence.
  // v0.12.4: record_curated_block retired. v0.42: 压缩改提交协议——
  // submit_curated_memory（compressor 唯一消费者，校验+对话内修复，
  // 持久化仍归 coordinator）。record_m3_summary remains（warehouse 仍以工具
  // 写 M3 摘要）。见 tools/record-curated-block.ts 的退役说明（仅供参考）。
  // registry.registerSystemTool(createRecordCuratedBlockTool())
  registry.registerSystemTool(createSubmitCuratedMemoryTool())
  registry.registerSystemTool(createRecordM3SummaryTool())

  // v0.18: progressive tool disclosure — register load_tools and loadable skill metadata.
  registry.registerSystemTool(createLoadToolsTool(registry))
  // Register loadable skill metadata for each module-form skill in the registry.
  // This enables load_tools to find and load skill tools by name.
  for (const skillName of registry.listSkills()) {
    const skill = registry.getSkill(skillName)
    if (skill) {
      registry.registerLoadableSkillMeta(skillName, skill.description)
    }
  }

  // v0.11: user-defined sub-agent tools.
  if (subAgentRegistry && subAgentDeps) {
    const runDeps: RunSubagentDeps = {
      llmStreamChat: subAgentDeps.llmStreamChat,
      url: subAgentDeps.url,
      model: subAgentDeps.model,
      mailbox,
      registry,
      stateLine: subAgentDeps.stateLine,
      ...(subAgentDeps.workDir !== undefined ? { workDir: subAgentDeps.workDir } : {}),
      // v0.34 D13：工作区级上下文（AGENTS.md 层叠 + 四类注入）传给子代理。
      ...(subAgentDeps.contextInjector !== undefined ? { contextInjector: subAgentDeps.contextInjector } : {}),
      ...(subAgentDeps.layeredPrompt !== undefined ? { layeredPrompt: subAgentDeps.layeredPrompt } : {}),
      ...(subAgentDeps.strictAlternation === true ? { strictAlternation: true } : {}),
      ...(subAgentDeps.tokenCounter !== undefined ? { tokenCounter: subAgentDeps.tokenCounter } : {}),
      // v0.14: thread DEFAULT_CONFIG so run_subagent's depth check uses the
      // canonical maxSubAgentDepth (3). Sub-agent config overrides (lower
      // values only) take precedence inside the tool.
      defaultConfig: DEFAULT_CONFIG,
    }
    // v0.30（用户拍板 2026-09-09）：define_subagent 无 diskDir——AI 定义的
    // 子代理是会话级资产（不落盘，会话销毁即回收）；长期子代理走用户配置
    // （面板 upsert / 手写 ~/.databus/agents/*.json，由 SubAgentRegistry
    // .register(cfg, dir) 的用户路径落盘）。
    registry.registerSystemTool(createDefineSubagentTool(subAgentRegistry, registry, subAgentDeps.modelCaps))
    registry.registerSystemTool(createRunSubagentTool(subAgentRegistry, runDeps))
  }
}
