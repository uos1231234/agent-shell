// v0.10.1c: createSystemAgents — wires the 3 system agents with their
// prompts and toolRefs. The caller provides the shared deps (llmStreamChat,
// url, model, mailbox, registry); this function creates the agents.
//
// The agents share the working agent's ToolRegistry. Each agent sees a
// subset of tools via systemToolRefs — the registry has all tools, the
// agent's runIMLoop call only exposes the ones listed in toolRefs.
//
// v0.13.1: createSystemAgents stays synchronous and returns the original 3
// agents (warehouse/compressor/recall). The wiki agent is async (it spawns
// a wiki-mcp server child process + registers its tools), so it lives in a
// separate factory `createSystemAgentsWithWiki` below. Callers that don't
// need a wiki agent use createSystemAgents unchanged; callers that do use
// createSystemAgentsWithWiki and get all four.

import { createSystemAgent } from '../system-agent.js'
import { WAREHOUSE_AGENT_PROMPT, COMPRESSOR_AGENT_PROMPT, RECALL_AGENT_PROMPT } from '../prompts/index.js'
import { createWikiAgent } from './wiki-agent.js'
import type { SystemAgent } from '../system-agent.js'
import type { WikiSystemAgent } from './wiki-agent.js'
import type { Mailbox } from '../mailbox/index.js'
import type { ToolRegistry } from '../../shell/registry.js'
import type { RenderingSignalBus } from '../../rendering/signal-bus.js'
import type { RenderingBase } from '../../rendering/base.js'
import { ArtifactStore } from '../../im/tools/artifact-store.js'
import type { StreamChunk, ChatMessage } from '../../protocol/types.js'
import type { StateLine } from '../state-line/types.js'
import type { McpConnection } from '../../mcp/connection.js'
import type { TokenCounter } from '../../shared/token-counter.js'

export type { SystemAgent } from '../system-agent.js'
export type { WikiSystemAgent } from './wiki-agent.js'

export type SystemAgentDeps = {
  llmStreamChat: (
    url: string,
    request: { model: string; messages: ChatMessage[]; tools: unknown[]; [k: string]: unknown },
  ) => AsyncIterable<StreamChunk>
  url: string
  model: string
  mailbox: Mailbox
  registry: ToolRegistry
  stateLine: StateLine
  /**
   * v0.30: warehouse 持久会话的落盘路径（JSONL 全量快照，每次 run 原子重写）。
   * 由宿主装配层用 sessionStore.stateDir(sessionId) 计算：
   * <dataDir>/<sessionId>/state/warehouse-session.jsonl（格式与加载语义见
   * system-agent-persistence.ts 顶部注释）。缺省 = warehouse 仅进程内持久。
   */
  warehousePersistPath?: string
  /** v0.30: 压缩失败上报的接收方（工作代理 id，见 system-agent.ts）。 */
  workingAgentId?: string
  /**
   * v0.41 D19 覆盖面扩展（用户拍板 2026-09-14："扩到全部系统智能体与子代理"）：
   * provider 要求严格角色交替时置 true。系统智能体同样是相邻 user 的来源——
   * createSystemAgent 硬编码 `userTemplate: ''`，请求尾部总跟一条空 user 消息
   * （`src/protocol/messages.ts:6-8` 记录的来源之二），严格交替 provider 会 400。
   * 缺省 undefined = 不转写（OpenAI 兼容栈容忍相邻 user，行为逐字节不变）。
   */
  strictAlternation?: boolean | undefined
  tokenCounter?: TokenCounter | (() => TokenCounter)
}

// v0.13.1: extended deps for the wiki-inclusive factory. Adds the optional
// injected wiki connection (tests pass a fake; production lets createWikiAgent
// spawn its own) and serverPath override. All other deps are shared with the
// 3 sync agents.
export type SystemAgentsWithWikiDeps = SystemAgentDeps & {
  wikiConnection?: McpConnection
  wikiServerPath?: string
  // v0.20: per-session 渲染基座（bus + base + store 三件套）。
  // 多会话隔离：每个会话独立的 bus/base/store，避免跨会话 artifact 泄漏。
  rendering?: {
    bus: RenderingSignalBus
    base: RenderingBase
    store: ArtifactStore
  }
}

// v0.13.1: the 4-agent bundle. wiki is a WikiSystemAgent (adds closeConnection)
// so callers can tear down the spawned server process.
export type SystemAgentsWithWiki = {
  warehouse: SystemAgent
  compressor: SystemAgent
  recall: SystemAgent
  wiki: WikiSystemAgent
}

// compressor 的规格（C3 抽成 helper：一个规格，两个实例）。
//
// 为什么并行需要**第二个实例**而不是复用同一个：SystemAgent 的提交捕获是逐实例
// 闭包状态（`let submitted`，每次 run 开头重置），一个实例同时跑两次 run 会互相
// 覆盖对方的 CuratedMemory——第二个块的产物会被第一个块读到。
//
// 为什么第二个实例**同名** 'compressor'（刻意，不是笔误）：① `submit_curated_memory`
// 的身份守卫按 `ctx.agentId !== 'compressor'` 判定，换名即拒执行；② agentTree 的
// 系统代理子节点按固定名字列表注册，换名要多改一处注册面；③ 对工作代理而言它
// 就是同一个压缩机（同 prompt、同工具面、同 provider）。
const compressorSpec = (deps: SystemAgentDeps) => ({
  name: 'compressor',
  systemPrompt: COMPRESSOR_AGENT_PROMPT,
  // v0.42（用户拍板 2026-09-16）：提交协议对齐参考实现——
  // 压缩机经 submit_curated_memory 工具提交 11 字段（服务端 schema 约束），
  // 不再回复自由文本 JSON。coordinator 从 result.submitted 取生产结果并原子
  // 持久化（appendBlock → rawArchive → evict）。
  toolRefs: ['databus_query', 'state_query', 'mailbox_send', 'mailbox_read', 'submit_curated_memory'],
  // 捕获最后一次 submit_curated_memory 的 memory 参数 → run 结果 submitted。
  submitToolName: 'submit_curated_memory',
  llmStreamChat: deps.llmStreamChat,
  url: deps.url,
  model: deps.model,
  mailbox: deps.mailbox,
  registry: deps.registry,
  stateLine: deps.stateLine,
  ...(deps.strictAlternation === true ? { strictAlternation: true } : {}),
  ...(deps.tokenCounter !== undefined ? { tokenCounter: deps.tokenCounter } : {}),
})

/**
 * C3（用户拍板 2026-09-17）：M3 压力阀的第二压缩机实例。drive-coordinator 收到
 * 它即把并行度提到 2（一波最多同时压两个块）；不传则并行度恒 1，行为与 v0.42
 * 逐字节相同。per-session 创建，无外部副作用（不 spawn 进程、不落自己的会话盘）。
 */
export const createOverflowCompressor = (deps: SystemAgentDeps): SystemAgent =>
  createSystemAgent(compressorSpec(deps))

export const createSystemAgents = (deps: SystemAgentDeps): {
  warehouse: SystemAgent
  compressor: SystemAgent
  recall: SystemAgent
} => ({
  warehouse: createSystemAgent({
    name: 'warehouse',
    systemPrompt: WAREHOUSE_AGENT_PROMPT,
    toolRefs: ['databus_query', 'databus_subscribe', 'mailbox_send', 'mailbox_read', 'record_m3_summary', 'state_query'],
    llmStreamChat: deps.llmStreamChat,
    url: deps.url,
    model: deps.model,
    mailbox: deps.mailbox,
    registry: deps.registry,
    stateLine: deps.stateLine,
    // v0.30（用户拍板 2026-09-09）：warehouse 是仓库管理员——被多次唤醒
    // （每次 M3 归档）且要经 mailbox 与工作代理往来，必须跨唤醒保持清醒
    // （读到询问 → 回复的对话上下文）。持久会话 + 落盘 + 交接笔记压缩
    // （防持久历史无限增长）。
    persistent: true,
    ...(deps.warehousePersistPath !== undefined ? { persistPath: deps.warehousePersistPath } : {}),
    compaction: {},
    ...(deps.workingAgentId !== undefined ? { workingAgentId: deps.workingAgentId } : {}),
    ...(deps.strictAlternation === true ? { strictAlternation: true } : {}),
    ...(deps.tokenCounter !== undefined ? { tokenCounter: deps.tokenCounter } : {}),
  }),
  compressor: createSystemAgent(compressorSpec(deps)),
  recall: createSystemAgent({
    name: 'recall',
    systemPrompt: RECALL_AGENT_PROMPT,
    // mailbox_read_any（2026-09-22）：跨邮箱分页代读——主代理 mailbox_read 超
    // 50 封报错时把批量阅读委派到这里，读信发生在 recall 自己的上下文里，
    // 只回摘要与证据给主代理。仅此处登记（主代理是 allowlist 不含它）。
    toolRefs: ['databus_query', 'state_query', 'mailbox_send', 'mailbox_read', 'mailbox_read_any'],
    llmStreamChat: deps.llmStreamChat,
    url: deps.url,
    model: deps.model,
    mailbox: deps.mailbox,
    registry: deps.registry,
    stateLine: deps.stateLine,
    // v0.30（用户拍板 2026-09-09）：recall 保持单发，但 deep-recall 链
    // （M3 → raw_archive_ids → 原始 turns）单次 run 可拉入大量内容——
    // 装交接笔记压缩兜底（0.85 × maxTokens 触发，run 内折叠后继续）。
    compaction: {},
    ...(deps.workingAgentId !== undefined ? { workingAgentId: deps.workingAgentId } : {}),
    ...(deps.strictAlternation === true ? { strictAlternation: true } : {}),
    ...(deps.tokenCounter !== undefined ? { tokenCounter: deps.tokenCounter } : {}),
  }),
})

/**
 * v0.13.1: create the 3 sync system agents PLUS the wiki agent. Async because
 * createWikiAgent spawns a wiki-mcp server child process and registers its 17
 * tools into the shared registry before the agent can run.
 *
 * The caller MUST hold the returned `wiki` agent and call `wiki.closeConnection()`
 * (or `wiki.stop()`) when done to kill the spawned server process. The other
 * three agents have no such lifecycle — they're pure closures over the shared
 * registry.
 *
 * `wikiConnection` (optional): inject a fake McpConnection for tests. When
 * omitted, createWikiAgent spawns a real server via createWikiMcpConnection.
 */
export const createSystemAgentsWithWiki = async (
  deps: SystemAgentsWithWikiDeps,
): Promise<SystemAgentsWithWiki> => {
  const base = createSystemAgents(deps)
  const wiki = await createWikiAgent({
    registry: deps.registry,
    stateLine: deps.stateLine,
    llmStreamChat: deps.llmStreamChat,
    url: deps.url,
    model: deps.model,
    mailbox: deps.mailbox,
    ...(deps.wikiConnection !== undefined ? { connection: deps.wikiConnection } : {}),
    ...(deps.wikiServerPath !== undefined ? { serverPath: deps.wikiServerPath } : {}),
    // v0.20: 透传 per-session 渲染基座
    ...(deps.rendering !== undefined ? { rendering: deps.rendering } : {}),
    ...(deps.strictAlternation === true ? { strictAlternation: true } : {}),
    ...(deps.tokenCounter !== undefined ? { tokenCounter: deps.tokenCounter } : {}),
  })
  return {
    warehouse: base.warehouse,
    compressor: base.compressor,
    recall: base.recall,
    wiki,
  }
}
