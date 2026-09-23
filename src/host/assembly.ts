// v0.26 宿主装配层 —— 把 examples/web-host.ts 内联的"最后一公里"装配收进库层。
//
// v0.21 交付了 Signal Gate + webshell + per-session 接线原语（wireSessionToGate），
// v0.22 的 examples/web-host.ts 是把它们与真实 SessionManager / ToolRegistry
// 组装起来的那段"最后一公里"。v0.26 把这段装配迁入库层（纯移动，行为不变），
// web-host 退化为薄 web 入口（CLI 解析 + webshell server + 生命周期打印）。
//
// 装配结构（信号关是唯一前后端中转站——本层不开端口、不开第二条数据面）：
//   SessionManager ──attachSession──▶ wireSessionToGate ──▶ SignalGate
//   RenderingBase(bus/base/store) ◀─handleSignal（autoSubscribe:false，bus→Gate→base 顺序）
//   ToolRegistry(per-session) + 4 doors（approvalHandler = wiring 产物）
//   createSignalGate({handlers}) ◀──command── 宿主入口（webshell / CLI）
//
// 依赖纪律：只依赖 src/**；不 import src/webshell（web 传输层在宿主入口），
// 不 import examples/，不读 process.argv（所有旋钮经 HostAssemblyOptions）。

import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 仓库根定位：src/host/assembly.ts → src/host/ → src/ → agent-shell/。
// skillsDir 缺省回落仓库内 skills/（web_search 等 module skill 开箱即用）。
// 导出供测试（回落解析逻辑可独立验证）。
export const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/** 仓库内 skills/ 目录（存在才启用；不存在返回 undefined = 不回落）。 */
export const defaultRepoSkillsDir = (): string | undefined => {
  const dir = join(repoRoot, 'skills')
  return existsSync(dir) ? dir : undefined
}

import { createBuiltinTools } from '../im/tools/index.js'
import { createFileHistory } from '../im/tools/file-history.js'
import { createWriteApprovalDoor } from '../security/doors/write-approval.js'
import { createSensitivePathDoor } from '../security/doors/sensitive-path.js'
import { createDangerousCommandDoor } from '../security/doors/dangerous-command.js'
import { createBrowserToolsDoor } from '../security/doors/browser-tools.js'
import { ApprovalStore } from '../im/tools/security/approval-store.js'
import { setLevel } from '../shared/logger.js'
import { buildStaticPrompt } from '../im/prompt/section-builder.js'
import { loadPromptLayers } from '../im/prompt/file-loader.js'
import { buildLayeredPrompt } from '../im/prompt/layer-builder.js'
import { ContextInjector } from '../im/hooks/context-injection.js'
import { createRuntimeInjection } from '../im/hooks/injections/runtime.js'
import { createTemporalInjection } from '../im/hooks/injections/temporal.js'
import { createWhenToReadInjection } from '../im/hooks/injections/when-to-read.js'
import { createConfig } from '../shell/config.js'
import { runIMLoop } from '../im/loop.js'
import type { IMLoopResult } from '../im/loop.js'
import { createSessionManager, SessionStore } from '../im/session/index.js'
import type { SessionHandle } from '../im/session/index.js'
import { appendCanonicalTurn, buildUserStopMarkerTurn } from '../im/turn.js'
import { createRealLLMStreamChat } from './llm-adapter.js'
import type { StreamChunk } from '../protocol/types.js'
import { createMockStreamChat } from './mock.js'
import { createRenderingSignalBus } from '../rendering/signal-bus.js'
import { createRenderingBase } from '../rendering/base.js'
import { createProducedMdRule } from '../rendering/rules/produced-md.js'
import { createRenderingLoopHook } from '../rendering/hooks/rendering-loop-hook.js'
import { ArtifactStore } from '../im/tools/artifact-store.js'
import { createSignalGate, wireLogSinkToGate, wireSessionToGate, mergeLoopHooks } from '../signals/index.js'
import type { SignalGate, SignalGateHandlers, SessionGateWiring } from '../signals/index.js'
import type { LoopHooks } from '../im/loop-hooks.js'
import { foldOversizeToolTurns } from '../im/tools/history-tool-table.js'
import { activateProvider, deleteProvider, listProviders, loadProviderConfig, loadProviderConfigByName, resolveModelReasoning, selectProviderModel, upsertProvider, readDatabusSettings, writeDatabusSettings } from '../config/index.js'
import type { ProviderCatalogEntry, ProviderListResult } from '../config/types.js'
import {
  connectToServer,
  registerMcpConnection,
  listMcpServers,
  upsertMcpServer,
  deleteMcpServer,
} from '../mcp/index.js'
import type { McpServerConfig, McpConnection } from '../mcp/index.js'
import { loadSkillsFromDir, loadTextSkillsFromDir } from '../skills/index.js'
import { registerWikiGuard } from '../extensions.js'
import { DEFAULT_SUB_AGENT_TOOL_POLICY, PERMISSIVE_SUB_AGENT_POLICY } from '../im/sub-agent/index.js'
import type { SubAgentToolPolicy } from '../im/sub-agent/index.js'
import { createNoopStateLine } from '../im/state-line/index.js'
import { Mailbox } from '../im/mailbox/index.js'
import { createSystemAgents, createOverflowCompressor } from '../im/system-agents/index.js'
import type { SystemAgent } from '../im/system-agent.js'
import { runLargeRecall } from '../im/system-agents/large-recall.js'
import { createDriveCoordinator } from '../im/system-agents/drive-coordinator.js'
import { createSignalBus } from '../im/memory-layers.js'
import type { MemoryConfig } from '../shell/memory-config.js'
import { registerSystemAgentTools } from '../im/system-agents/register.js'
import { createSubAgentRegistry, defaultAgentsDir } from '../im/minimal.js'
import { readWorkspaceEntry } from './workspace-read.js'
import { buildToolsPayload } from './tools-payload.js'
import { undoTaskBlocks } from './session-undo.js'
import { rewindSessionFiles, REWIND_MAX_ENTRIES } from './session-rewind.js'
import { createWikiPool } from './wiki-pool.js'
import { createWikiGenerateManager } from './wiki-generate.js'
import { renderMarkdown } from '../rendering/render-md.js'
import type { WikiCardSummary } from '../signals/index.js'
import { LongHorizonWorkflow } from './workflow/index.js'
import type { WorkflowRunEvent, WorkflowState } from './workflow/index.js'
import { createDirectRecallLedger } from '../im/tools/databus-recall.js'
import { resolveTokenCounter, type TokenCounter } from '../shared/token-counter.js'
// v0.41 goal 模式：goal 语义全住 src/im/goal/，装配层只负责三件事——建会话级
// 状态、建 beforeComplete hook、把事件接进信号关。阈值事实源在 goal/types.ts
// （铁律「不准因为前端动后端」：宿主只透传 maxRounds，不改写任何语义）。
import {
  createGoalSessionState,
  createGoalHooks,
  createGoalJudge,
  createDistiller,
  resolveGoalConfig,
  DEFAULT_GOAL_MAX_ROUNDS,
} from '../im/goal/index.js'
import type { GoalSessionState } from '../im/goal/index.js'

/** 系统提示词的 agentName（v0.19 官方中文模板的标识）。 */
const SYSTEM_PROMPT_NAME = 'agent-shell'

/** 会话标题上限（/title 校验口径，CLI 与前端同走此门）。 */
const MAX_SESSION_TITLE_CHARS = 200

// ---------------------------------------------------------------------------
// LLM 解析：providers.json 优先，回落 ARK 环境变量。
// 注入防御：untrustedUpstream 强制开；否则看 providers.json 的 upstreamTrusted=false。
//
// Wave B1 热切换：解析不再绑定启动时刻——每次 runPrompt / attachSession 都现调
// resolveLLMPlan（providers.json 是磁盘事实源，/provider use 改 active 后下一
// 轮即生效）。streamChat 实例按 url+key+model 缓存（同 provider 连续轮次复用，
// 不每轮重建）；文件解析失败 throw 干净错误（load.ts fail-fast 纪律：静默回落
// env 会让"填了配置为什么没用"无从排查）。
// ---------------------------------------------------------------------------

export type LLMPlan = {
  useMock: boolean
  url: string
  model: string
  apiKey: string | undefined
  /** providers.json 的 active 条目名（无 providers.json 时 undefined）。 */
  providerName: string | undefined
  /** providers.json 的 upstreamTrusted（缺省视为可信）。 */
  trusted: boolean
  needInjectionDefense: boolean
  /** 模型能力声明（providers.json capabilities，缺省 undefined = 未声明）。
   *  消费点：define_subagent schema 动态描述 + 出站 max_tokens。 */
  modelCaps: { maxInputTokens?: number; maxOutputTokens?: number } | undefined
  /** 思考档位（v0.32 解析链，见 resolveLLMPlan）。undefined = 不注入任何
   *  思考字段（未知且未声明能力的模型，保守方案——ARK 实测 glm-5 系
   *  thinking:disabled 直接 400）。缺省链尾仍是 'max'（v0.30 用户拍板）。 */
  thinking: 'max' | 'high' | 'low' | 'off' | undefined
  /** 出站严格交替转写（v0.41 D19）。来源 providers.json 的
   *  capabilities.strictAlternation，缺省 false = 不转写——既有 OpenAI 兼容
   *  会话的 wire 形状逐字节不变。true 时 call.ts 在构造请求体前合并相邻 user
   *  消息（goal 块合并与压缩信封都会产生 [envelope-user, next-user] 序列，
   *  Anthropic 一类严格交替的 provider 会 400）。
   *  它不进 streamChatKey：转写发生在 call.ts 而非 adapter 闭包，改开关下一轮
   *  即生效，不存在 v0.32 F1 那类缓存粘滞。 */
  strictAlternation: boolean
  /** Provider/model-specific local counter used before upstream usage exists. */
  tokenCounter: TokenCounter
}

/**
 * providers.json 的定位参数（测试注入临时目录；缺省 AGENT_SHELL_HOME /
 * ~/.agent-shell + process.env）。
 */
export type ProviderLookup = {
  configPath?: string | undefined
  homeDir?: string | undefined
  env?: Record<string, string | undefined>
}

/** runIMLoop / 系统智能体共用的 streamChat 形状（loop.ts IMLoopOptions 的结构投影）。 */
export type HostStreamChat = (
  url: string,
  request: { model: string; messages: unknown[]; tools?: unknown[]; [k: string]: unknown },
) => AsyncIterable<StreamChunk>

/**
 * 解析 LLM 目标。装配层与宿主入口（启动横幅打印）共用这一个事实源，
 * 两边看到同一份 useMock/url/model，不各算各的。热切换语义下它描述的是
 * "此刻磁盘上的 active provider"，不是进程生命周期内的常量。
 */
export const resolveLLMPlan = (opts: {
  mock?: boolean
  untrustedUpstream?: boolean
  /** providers.json 定位（缺省 AGENT_SHELL_HOME / ~/.agent-shell）。 */
  lookup?: ProviderLookup | undefined
  /**
   * 按名解析指定 provider（不走 active）。系统智能体固定默认用——工作代理
   * 可 /provider use 热切换，系统智能体锚定此条目不跟随。缺省 undefined =
   * 沿用 active（逐字节向后兼容）。
   */
  providerName?: string | undefined
}): LLMPlan => {
  const providerCfg = opts.providerName !== undefined && opts.providerName !== ''
    ? loadProviderConfigByName({
        ...(opts.lookup?.configPath !== undefined ? { configPath: opts.lookup.configPath } : {}),
        ...(opts.lookup?.homeDir !== undefined ? { homeDir: opts.lookup.homeDir } : {}),
        ...(opts.lookup?.env !== undefined ? { env: opts.lookup.env } : {}),
        providerName: opts.providerName,
      })
    : loadProviderConfig(opts.lookup ?? { env: process.env })
  if (opts.providerName !== undefined && opts.providerName !== '' && providerCfg === undefined) {
    throw new Error(`Provider "${opts.providerName}" was not found in the configured providers.json`)
  }
  // env 快照：lookup.env（测试注入）优先，缺省进程 env——providers.json 与
  // ARK 回落共用同一份 env 事实源，测试不读进程真实凭据。
  const env = opts.lookup?.env ?? process.env
  const CFG_URL = providerCfg?.provider.url
  const CFG_KEY = providerCfg?.provider.apiKey
  const CFG_MODEL = providerCfg?.provider.model
  const CFG_TRUSTED = providerCfg?.provider.upstreamTrusted ?? true
  const CFG_CAPS = providerCfg?.provider.capabilities
  const CFG_URL_MODEL = providerCfg?.provider.models
  // thinking 解析链（v0.32，用户拍板保守方案）：
  //   provider.thinking（provider 级强制覆盖，最高优先）
  //   > provider.reasoningEffort（用户选择；须 ∈ 模型有效档位）
  //   > 模型 defaultEffort（models[].reasoning 声明 ?? 内置 KNOWN_MODELS 表）
  //   > undefined（未知且未声明 → 不注入任何思考字段）。
  // 注意 provider.thinking 显式声明时跳过能力表（用户知道自己在上游开了什么，
  // 对齐旧字段"换上游拒绝 thinking 参数时显式声明"的语义）。
  const CFG_THINKING_FORCED = providerCfg?.provider.thinking
  const CFG_REASONING_SELECTED = providerCfg?.provider.reasoningEffort

  const ARK_KEY = env['ARK_KEY']
  const ARK_URL = env['ARK_URL'] ?? 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions'
  const ARK_MODEL = env['ARK_MODEL'] ?? 'glm-5.3-flash'

  const url = CFG_URL ?? ARK_URL
  const apiKey = CFG_KEY ?? ARK_KEY
  const model = CFG_MODEL ?? ARK_MODEL

  const effectiveThinking = ((): 'max' | 'high' | 'low' | 'off' | undefined => {
    if (CFG_THINKING_FORCED !== undefined) return CFG_THINKING_FORCED
    const declared = providerCfg?.provider.models?.find((m) => m.id === model)?.reasoning
    const reasoning = resolveModelReasoning(model, declared)
    if (reasoning === undefined) return undefined
    if (CFG_REASONING_SELECTED !== undefined && reasoning.efforts.includes(CFG_REASONING_SELECTED)) {
      return CFG_REASONING_SELECTED
    }
    return reasoning.defaultEffort ?? 'max'
  })()

  return {
    // --mock 显式开启；否则 auto：解析不到 API key 就用 mock。
    useMock: opts.mock ?? (apiKey === undefined),
    url,
    model,
    apiKey,
    providerName: providerCfg?.name,
    trusted: CFG_TRUSTED,
    needInjectionDefense: opts.untrustedUpstream === true || CFG_TRUSTED === false,
    modelCaps: CFG_CAPS !== undefined
      ? {
          ...(CFG_CAPS.maxInputTokens !== undefined ? { maxInputTokens: CFG_CAPS.maxInputTokens } : {}),
          ...(CFG_CAPS.maxOutputTokens !== undefined ? { maxOutputTokens: CFG_CAPS.maxOutputTokens } : {}),
        }
      : undefined,
    thinking: effectiveThinking,
    // v0.41 D19：只有显式声明 true 才转写。缺省宽松——未声明的严格 provider
    // 会持续 400 直到手动声明（用户拍板"只要开关，不加自愈"）。
    strictAlternation: CFG_CAPS?.strictAlternation === true,
    tokenCounter: resolveTokenCounter({ model, providerName: providerCfg?.name }),
  }
}

// ---------------------------------------------------------------------------
// 公开装配面
// ---------------------------------------------------------------------------

export type HostAssemblyOptions = {
  /** 会话持久化目录（SessionManager basePath）。 */
  dataDir: string
  /** 强制 mock；缺省 auto —— 解析不到 LLM key 即 mock。 */
  mock?: boolean
  /** 上游为第三方中转站 → 系统提示词追加注入防御段。 */
  untrustedUpstream?: boolean
  /** 日志信号的 component 身份；缺省 'host'（web-host 传 'web-host' 保持原样）。 */
  logComponent?: string
  /** JS/TS 模块 skill 目录（缺省回落 ~/.databus/settings.json 的 skillsDir）。 */
  skillsDir?: string
  /** 文本 skill 目录（缺省回落 ~/.databus/settings.json 的 textSkillsDir）。 */
  textSkillsDir?: string
  /**
   * 记忆分层阈值（M0→M1→M2→M3），透传给每轮 loop 与 drive coordinator。
   * 缺省 DEFAULT_MEMORY_CONFIG（200K/500K/900K）。测试用小阈值验证压缩管线。
   */
  memoryConfig?: MemoryConfig
  /**
   * 覆盖 LLM 版压缩智能体（e2e 测试缝：mock LLM 无法产出合法 CuratedMemory
   * JSON，注入 fake 后小阈值下可端到端验证压缩管线：切块→压缩→落盘→驱逐）。
   * 缺省用 createSystemAgents 产出的真实 compressor。
   */
  compressorOverride?: SystemAgent
  /**
   * 系统智能体（compressor/warehouse/recall）的固定默认 provider 名（providers.json
   * 条目 key）。给出时系统智能体锚定该 provider，**不随工作代理 /provider use
   * 热切换**——工作代理用 active，系统智能体用此固定条目的 url/model/streamChat。
   * 缺省 undefined = 系统智能体沿用 active（向后兼容）。
   */
  systemAgentProvider?: string
  /**
   * 是否保留 logger 的 stderr 原始 JSON 输出（log-sink 默认 true，不破坏既有
   * 日志习惯）。TUI 宿主（he-cli）应传 false——原始 JSON 会打碎终端 UI。
   */
  logToStderr?: boolean
  /**
   * Wave B1 热切换：providers.json 定位（测试注入临时目录；缺省
   * AGENT_SHELL_HOME / ~/.agent-shell）。同时作用于每轮 LLM 解析与
   * provider.* gate 命令——两边看到同一份配置文件。
   */
  providerLookup?: ProviderLookup | undefined
  /**
   * 测试缝：真 provider（useMock=false）的 streamChat 构建器。缺省用
   * createRealLLMStreamChat；测试注入录制版以断言每轮解析出的 url/model，
   * 不发真 HTTP。mock 路径不受它影响（恒用内部 mock streamChat）。
   */
  llmStreamChatFactory?: (plan: LLMPlan) => HostStreamChat
  /**
   * AGENTS.md 层叠的 user 层定位（loadPromptLayers 的 userPath）。缺省
   * HOME/USERPROFILE 下的 ~/.agent-shell/PROMPT.md；测试注入不存在路径，
   * 保证封闭性（不读真实用户目录）。
   */
  promptLayerUserPath?: string | undefined
  /**
   * ~/.databus/ 的定位覆盖（settings.json 的 homeDir）。缺省 = 真实用户
   * 家目录（生产路径不变）；测试注入临时目录，保证封闭性。v0.40 委托授权
   * 的提示词条件与 toolPolicy 判定经同一入口读取——同源由构造保证。
   */
  settingsHomeDir?: string | undefined
  /**
   * 装配层剔除全部联网通道——DeepSWE 空网评测用：①系统工具 web_fetch/
   * open_url 不进 exposedToolRefs；②skills 与 text skills 不装配（module
   * skill 可执行任意 JS 联网、text skill 引导联网）；③MCP 连接池不建（MCP
   * 工具任意联网）。机制层禁用：提示词清单与 tools 数组同源同步消失，不存在
   * "提示词说不能上网、工具列表却有"的自相矛盾。仅影响本装配暴露面，不改
   * 状态机/registry。
   */
  noNetworkTools?: boolean
  /**
   * 工作代理系统工具白名单（实验/评测用）。缺省不过滤；设置后
   * exposedToolRefs 只保留名单内工具——提示词清单与 tools 数组同源同步。
   * 仅装配层过滤，不改 loop/guard/registry 登记。
   */
  allowedToolRefs?: readonly string[] | undefined
}

/** 每个会话一整套 per-session 资产（registry/doors/rendering/wiring）。 */
export type SessionAssets = {
  handle: SessionHandle
  wiring: SessionGateWiring
  registry: ReturnType<typeof createBuiltinTools>
  /** v0.36: 本会话的快照层实例（registry 内工具共用它写留底；rewind handler 用它回滚）。 */
  fileHistory: ReturnType<typeof createFileHistory>
  bus: ReturnType<typeof createRenderingSignalBus>
  base: ReturnType<typeof createRenderingBase>
  store: ArtifactStore
  /** v0.19 中文系统提示词（FULL 模板 + 本会话 registry 的工具清单）——
   *  per-session 因为 tooling_section 从本会话 registry 生成。
   *  v0.41: 改为 getter——goal 模式可运行中切换（`/goal on|off`），
   *  每轮 resolve 取当前值（goal OFF → 原段；goal ON → 目标锚点段）。 */
  prompt: () => string
  /** v0.25: 每会话一个 Mailbox，跨轮复用（修此前 buildLoopOptions 每轮
   *  prompt 隐式 new Mailbox() 导致邮箱状态跨轮丢失的隐患）。 */
  mailbox: Mailbox
  /** v0.25: 暴露给工作代理的系统工具白名单——同源双喂 buildStaticPrompt
   *  （提示词宣传）与 buildLoopOptions（模型实际拿到）。 */
  exposedToolRefs: string[]
  /** v0.30: 宿主 own hooks（工具级压缩 = 历史工具表折叠）。runPromptOnce
   *  用 mergeLoopHooks(own, gateHooks) 合并——own 先跑，gate 后跑。 */
  toolTableHooks: LoopHooks
  /** v0.33: 渲染转发 hooks（ToolTurn → 渲染 bus，.md 产物自动渲染）。 */
  renderingHooks: LoopHooks
  /** v0.31 接线：ContextInjector（runtime/temporal afterSystem + memory/
   *  architecture afterUser 四源）。loop.composePrompt 每轮消费（loop.ts 的
   *  opts.contextInjector 分支），workDir 由 buildLoopOptions 透传到注入 ctx。 */
  contextInjector: ContextInjector
  /**
   * v0.41: 会话级 goal 状态（`current === undefined` = goal 未激活，此时
   * beforeComplete 第一行弃权，loop 行为与没装这个 hook 逐字节相同）。
   * 状态持有者就是这里——gate 只做路由，set/clear 生效后由宿主 emit
   * goal.changed（permission.full → permission.changed 同模式）。
   * 生命周期 = SessionAssets 生命周期：detachSession 从 openHandles 删掉
   * assets，goal 随之消失（§6.20 AI 子代理的会话级回收语义，零清理代码）。
   */
  goal: GoalSessionState
  /** v0.41: goal 的 beforeComplete hook（judge → G1 → G2 → 续跑提醒）。 */
  goalHooks: LoopHooks
  /** 当前会话的 LongHorizon 工作流事实源与恢复状态。 */
  workflow: LongHorizonWorkflow
  /** LongHorizon 观察 hook；关闭时内部严格 no-op。 */
  workflowHooks: LoopHooks
  /** Session-scoped delegated recall entry point. */
  largeRecall: NonNullable<import('../im/loop.js').IMLoopOptions['largeRecall']>
  directRecallLedger: import('../im/tools/databus-recall.js').DirectRecallLedger
}

export type HostAssembly = {
  gate: SignalGate
  handlers: SignalGateHandlers
  /**
   * 创建一个会话并完整接入信号关（幂等：openHandles 按 sessionId 缓存，
   * 对 SessionManager.openSession 不幂等的对策）。workDir 必填——工作区是
   * 权限边界。
   */
  attachSession(workDir: string): Promise<SessionAssets>
  detachSession(id: string): Promise<void>
  /** 关闭 MCP 连接池 + detach/close 全部活跃会话（宿主入口再自行关 server）。 */
  shutdown(): Promise<void>
}

/**
 * 组装宿主装配体：session-manager、LLM 解析、启动期功能配置（skills 预载 +
 * MCP 连接池 + 校验 registry）、SignalGate 及其全部 handlers、per-session
 * attach/detach 与 shutdown。行为与 v0.25 的 examples/web-host.ts main() 逐字节一致。
 */
export async function createHostAssembly(opts: HostAssemblyOptions): Promise<HostAssembly> {
  mkdirSync(opts.dataDir, { recursive: true })

  const sessionManager = createSessionManager({ basePath: opts.dataDir })
  // session.json 的直读直写视图（session.rename 用）。与 SessionManager 内部
  // store 同 basePath——文件是唯一事实源，两个实例只共享路径不共享状态。
  const sessionStore = new SessionStore({ basePath: opts.dataDir })
  // v0.29: 宿主不覆盖任何 guard 阈值——状态机 guard 是全局固有行为（DEFAULT_CONFIG），
  // 不因前端形态（CLI/web-host）不同而不同。前端的"时间权"通过用户主动
  // 关闭（[q]/Ctrl-C/turn.cancel → ctx.signal → 子进程 kill）实现，不是配置覆盖。
  const config = createConfig()

  // ---- Wave B1 热切换：LLM 目标每次调用时解析 ----
  // providerLookup：provider.* gate 命令与每轮解析共用同一份定位（测试可注入
  // 临时目录；显式字段覆盖 env 缺省）。
  const providerLookup: ProviderLookup = { env: process.env, ...opts.providerLookup }
  const resolveCurrentPlan = (): LLMPlan =>
    resolveLLMPlan({
      ...(opts.mock !== undefined ? { mock: opts.mock } : {}),
      ...(opts.untrustedUpstream !== undefined ? { untrustedUpstream: opts.untrustedUpstream } : {}),
      lookup: providerLookup,
    })

  // mock streamChat 单实例（mock 的 callCount 脚本语义依赖同一闭包）；
  // 真 streamChat 按 url+apiKey+model 缓存——同 provider 连续轮次复用，不同
  // provider 切换时各自持有实例。key 不用 providerName：同名条目被 upsert 改
  // 换 url/key 后旧缓存必须失效，连接参数本身才是身份。
  const mockStreamChat = createMockStreamChat()
  const streamChatCache = new Map<string, HostStreamChat>()
  // F1（v0.32）：缓存键必须含 extras 的全部来源——extras 在 createRealLLMStreamChat
  // 构建时固定（闭包），键里只有 url|key|model 的话，同 provider 改 thinking/
  // maxOutputTokens 会命中带旧 extras 的缓存实例（改档位要重启才生效的真实缺陷）。
  const streamChatKey = (plan: LLMPlan): string =>
    `${plan.url}|${plan.apiKey}|${plan.model}|${plan.thinking ?? '-'}|${plan.modelCaps?.maxOutputTokens ?? '-'}`
  /**
   * 出站请求增强（v0.30 用户拍板）：providers.json capabilities/thinking →
   * 宿主侧组装 requestExtras，adapter 纯透传合并。max_tokens 用模型声明输出
   * 上限（消除服务商默认 ~12000 截断）；thinking 按 v0.32 解析链——undefined
   * （未知且未声明能力的模型）不注入任何思考字段（保守方案），'off' 注入
   * thinking:{type:'disabled'}（ARK 实测 off 直发 reasoning_effort 是 400），
   * 其余注入 thinking:{type:'enabled', reasoning_effort}（DeepSeek 官方参数
   * 格式，火山方舟同构）。
   */
  const buildRequestExtras = (plan: LLMPlan): Record<string, unknown> => ({
    ...(plan.modelCaps?.maxOutputTokens !== undefined ? { max_tokens: plan.modelCaps.maxOutputTokens } : {}),
    ...(plan.thinking === undefined
      ? {}
      : plan.thinking === 'off'
        ? { thinking: { type: 'disabled' } }
        : { thinking: { type: 'enabled', reasoning_effort: plan.thinking } }),
  })
  const resolveStreamChat = (plan: LLMPlan): HostStreamChat => {
    if (plan.useMock || plan.apiKey === undefined) return mockStreamChat
    const key = streamChatKey(plan)
    let sc = streamChatCache.get(key)
    if (sc === undefined) {
      sc = (opts.llmStreamChatFactory ?? ((p: LLMPlan) =>
        createRealLLMStreamChat({
          url: p.url, apiKey: p.apiKey!, model: p.model,
          requestExtras: buildRequestExtras(p),
        })))(plan)
      streamChatCache.set(key, sc)
    }
    return sc
  }
  // 系统智能体（compressor/warehouse/run_subagent）在 attach 期捕获 streamChat
  // 引用——给它一个委托包装，每次调用转发到"当前 plan 的 streamChat"，使子
  // 代理与主循环跟随同一份热切换（不改 src/im 签名）。
  const delegatingStreamChat: HostStreamChat = (url, request) =>
    resolveStreamChat(resolveCurrentPlan())(url, request)

  // ---- 会话资产表（attachSession 填充；gate handlers 闭包调用时解引用）----
  // openHandles 的 map 缓存是对 SessionManager.openSession 不幂等的对策：
  // create / open / history 三条路径都经 attachSession，绝不产生平行实例。
  const openHandles = new Map<string, SessionAssets>()
  const cancelSignals = new Map<string, AbortController>()
  // 用户停止标记登记表（2026-09-17 用户拍板）：turn.cancel 入站时若回合在飞
  // （cancelSignals 有 controller），登记意图；runPromptOnce 的 finally 在 loop
  // unwind 完成后落插标记回合。不直接在 cancel 处落插的原因：在飞工具的
  // error ToolTurn 尚未落盘，标记插在 assistant(tool_calls) 与 tool(结果) 中间
  // 会违反 wire 序列（tool 结果必须紧跟 assistant）→ 服务商 400。
  const pendingStopMarker = new Set<string>()

  // ===========================================================================
  // v0.25 Wave B: 启动期功能配置装配（~/.databus —— 用户拍板"功能配置与凭据
  // 分离"，凭据仍在 ~/.agent-shell/providers.json）。
  // ===========================================================================

  /**
   * 子代理向下开关 → registry 级 fallback policy（v0.39 语义，用户拍板：
   * 全局、新会话生效——attachSession 与 subagent handler 每次现读
   * settings.json 注入；运行中会话不变）。
   *
   * v0.39：per-config 的 toolPolicy（制造时声明，随配置落盘）取代了旧的
   * "环境 policy 作用于所有子代理"。这个函数只剩一个职责：为【没有自带
   * policy 的配置】提供注册期环境回退——
   *   OFF（缺省）= DEFAULT_SUB_AGENT_TOOL_POLICY（保守：deny 写类/shell 类/
   *                recursion 类——未声明 policy 的用户配置仍受历史约束）
   *   ON         = PERMISSIVE_SUB_AGENT_POLICY（白名单即边界）
   * 自带 toolPolicy 的配置（含内置 editor）不受此开关影响——那是它自己的
   * 声明。运行期边界与此开关正交：toolRefs 白名单 + 特权不放大钳制
   * （define_subagent / run_subagent 的嵌套子集校验）+ 深度守卫
   * maxSubAgentDepth=3 兜底递归，对两种开关状态一律生效。
   */
  // v0.40: settings.json 的唯一读取入口（settingsHomeDir 仅供测试注入；
  // 生产缺省 = 真实家目录，行为零变化）。toolPolicy 判定、提示词委托授权
  // 条件、Gate settings.get 全部经它——同源由构造保证，不存在"开关与
  // 提示词各读各的"的漂移面。
  const readSettings = () => readDatabusSettings({ homeDir: opts.settingsHomeDir })

  const resolveSubAgentToolPolicy = (): SubAgentToolPolicy => {
    if (readSettings().subAgentNesting !== true) return DEFAULT_SUB_AGENT_TOOL_POLICY
    return PERMISSIVE_SUB_AGENT_POLICY
  }

  // 目录解析：opts 优先（宿主入口解析后的值），settings.json 兜底，最后回落
  // 仓库内 skills/（module skill 开箱即用，进渐进式披露清单）。测试环境
  // （vitest）跳过回落——host 测试不加载仓库 skills，避免 module runner 副作用。
  // noNetworkTools（DeepSWE 空网评测）：外部网络通道一律不装配——module skill
  // 可执行任意 JS 联网、text skill 引导联网；置 undefined 后连仓库回落也跳过，
  // 与 web_fetch/open_url 剔除同源语义（机制层禁，提示词无联网入口）。
  const startupSettings = readSettings()
  const skillsDir = opts.noNetworkTools
    ? undefined
    : (opts.skillsDir ??
      startupSettings.skillsDir ??
      (process.env.VITEST ? undefined : defaultRepoSkillsDir()))
  const textSkillsDir = opts.noNetworkTools ? undefined : (opts.textSkillsDir ?? startupSettings.textSkillsDir)
  const { memoryConfig, compressorOverride } = opts

  // 校验用参考 registry（启动期一次）：覆盖所有合法 toolRef——内置工具 +
  // 系统工具（含 define/run_subagent）+ skills + MCP flat 名。subagent.upsert
  // 的落盘校验靠它（scratch SubAgentRegistry 拿它当 registry）。
  const validationRegistry = createBuiltinTools({ cwd: '.' })
  const validationMailbox = new Mailbox()

  // skills 预载清单（供 extensions.info + toolRef 校验覆盖）。目录配错 →
  // loader throw 干净错误 → 宿主起不来（fail-fast）。
  let preloadSkills: string[] = []
  let preloadTextSkills: string[] = []
  if (skillsDir !== undefined) {
    const defs = await loadSkillsFromDir(skillsDir, { registry: validationRegistry })
    for (const def of defs) validationRegistry.registerSkill(def)
    preloadSkills = defs.map((d) => d.name)
  }
  if (textSkillsDir !== undefined) {
    const textDefs = await loadTextSkillsFromDir(textSkillsDir, { registry: validationRegistry })
    for (const def of textDefs) {
      // text-loader 对 form:'text' 恒置 body；此分支只在手造 def 缺 body 时触发
      // （extensions.ts 同款防御）。
      if (def.body === undefined) {
        throw new Error(`Text skill "${def.name}" has no body (form:'text' requires body)`)
      }
      validationRegistry.registerTextSkill(def.name, def.body, def.when_to_use)
    }
    preloadTextSkills = textDefs.map((d) => d.name)
  }

  // MCP 连接池（宿主级共享）：mcp.json 有配置才连接；fail-fast——一个失败
  // 关掉已开的全部再 throw。连接常驻宿主（进程句柄贵），每会话 attachSession
  // 时注册进会话 registry（registry 条目便宜，审批 door 按 sessionId 隔离不受影响）。
  // noNetworkTools 时跳过连接（MCP 工具任意联网，空网评测不得装配）。
  const mcpPool: { cfg: McpServerConfig; conn: McpConnection }[] = []
  const mcpServersOnDisk = opts.noNetworkTools ? [] : listMcpServers().servers
  if (mcpServersOnDisk.length > 0) {
    try {
      for (const cfg of mcpServersOnDisk) {
        const conn = await connectToServer(cfg)
        mcpPool.push({ cfg, conn })
        // 校验 registry 同步登记 MCP flat 名 + server meta：使引用 MCP 工具的
        // 子代理配置能通过 toolRef 校验（v0.13 D7：子代理可引用 MCP 工具）。
        await registerMcpConnection(validationRegistry, conn)
        const rawToolNames = (await conn.listTools()).map((t) => t.name)
        validationRegistry.registerMCPServerMeta(
          cfg.name,
          cfg.description ?? `MCP server: ${cfg.name}`,
          rawToolNames,
        )
      }
    } catch (e) {
      await Promise.all(mcpPool.map((p) => p.conn.close().catch(() => undefined)))
      throw e
    }
  }

  // define/run_subagent 也是合法 toolRef（nesting 开启时）——registerSystemAgentTools
  // 传 scratch SubAgentRegistry 即把它们注册进校验 registry（register.ts 同款路径）。
  const validationSubAgents = await createSubAgentRegistry({ registry: validationRegistry })
  registerSystemAgentTools(
    validationRegistry,
    validationMailbox,
    createSystemAgents({
      llmStreamChat: delegatingStreamChat,
      url: resolveCurrentPlan().url,
      model: resolveCurrentPlan().model,
      mailbox: validationMailbox,
      registry: validationRegistry,
      stateLine: createNoopStateLine(),
    }),
    validationSubAgents,
    {
      llmStreamChat: delegatingStreamChat,
      url: resolveCurrentPlan().url,
      model: resolveCurrentPlan().model,
      stateLine: createNoopStateLine(),
      modelCaps: resolveCurrentPlan().modelCaps,
      tokenCounter: () => resolveCurrentPlan().tokenCounter,
    },
  )

  /**
   * 把一个 SessionHandle 完整接入信号关（幂等：已接线直接返回）。
   */
  async function attachHandle(handle: SessionHandle, workDir: string): Promise<SessionAssets> {
    const sessionId = handle.info.id
    const existing = openHandles.get(sessionId)
    if (existing !== undefined) return existing

    // per-session registry：工具有 cwd 闭包（workDir），门禁的 approvalHandler
    // 是本会话 wiring 的产物（gate.request 的 sessionId 由此标注）。
    // v0.36: 快照层 per-session 创建（dataRoot 跟宿主 dataDir），实例同时
    // 交给 SessionAssets——session.rewind 的 handler 要用同一实例回滚。
    const fileHistory = createFileHistory({ dataRoot: join(opts.dataDir, 'file-history'), cwd: workDir })
    const registry = createBuiltinTools({ cwd: workDir, fileHistory })

    // ---- v0.25 Wave B: 会话级扩展注册（在 subAgentRegistry 之前——loadFromDisk
    // 要对 registry 校验 toolRefs，MCP/skill 引用必须已可解析）----
    registerWikiGuard(registry)
    // MCP：宿主级连接池共享、会话级注册（每会话重复 listTools 可接受）。
    for (const { cfg, conn } of mcpPool) {
      await registerMcpConnection(registry, conn)
      const rawToolNames = (await conn.listTools()).map((t) => t.name)
      registry.registerMCPServerMeta(
        cfg.name,
        cfg.description ?? `MCP server: ${cfg.name}`,
        rawToolNames,
      )
    }
    // Skills：目录在启动期已解析；此处目录消失 → loader throw → 会话创建失败
    // （fail-fast，带清晰错误）。text def.body 缺失为手造数据错误，throw 不跳过。
    if (skillsDir !== undefined) {
      const defs = await loadSkillsFromDir(skillsDir, { registry })
      for (const def of defs) registry.registerSkill(def)
    }
    if (textSkillsDir !== undefined) {
      const textDefs = await loadTextSkillsFromDir(textSkillsDir, { registry })
      for (const def of textDefs) {
        if (def.body === undefined) {
          throw new Error(`Text skill "${def.name}" has no body (form:'text' requires body)`)
        }
        registry.registerTextSkill(def.name, def.body, def.when_to_use)
      }
    }

    // ---- v0.25 Wave A 装配补全 ----
    // 此前宿主从不注册系统工具、从不传 systemToolRefs，真实 LLM 会话的
    // tools 数组为空（模型发起不了任何工具调用）。依赖链顺序：
    // registry → MCP/skills 注册 → subAgentRegistry(开关产物 policy) → rebindRoot
    // → mailbox(带树) → systemAgents → registerSystemAgentTools → 暴露清单
    // → buildStaticPrompt。
    // toolPolicy 现读 settings.json（向下开关：新会话生效——拍板语义）。
    const subAgentRegistry = await createSubAgentRegistry({
      diskDir: defaultAgentsDir(),
      registry,
      toolPolicy: resolveSubAgentToolPolicy(),
      // v0.38: 注册内置 explore / editor 预置角色（开箱可用，无需用户手写）。
      builtinRoles: true,
    })
    // 树根绑定：run_subagent 运行期要在 agentTree 里找到当前代理（minimal.ts
    // createMinimalIM 同款先例）。rootOwnDatabus = 会话 runtime 的 databus，
    // 子代理的 ctxDatabus 由此看到工作代理的工具事件。
    subAgentRegistry.agentTree.rebindRoot({
      rootId: handle.info.workingAgentId,
      sessionId,
      rootOwnDatabus: handle.runtime.databus,
    })
    // 每会话一个 Mailbox。传入 agentTree 使 mailbox 路由校验生效（minimal.ts
    // 的 caller-supplied mailbox 约定：调用方自带 mailbox 时负责树的接线）。
    //
    // v0.34 D10/D12（用户拍板 2026-09-10）：邮件落盘 `mailbox.jsonl` + 恢复回灌。
    // 此前 mailbox 是纯内存 Map、模块内零 IO，进程重启后**整封信都没了**（不只是
    // 未读状态）——后台委托任务以邮件为触发，重启即静默丢弃。
    // TTL 传 store.ttlDays（会话快照与邮件同口径，单一事实源）。
    // 写串行队列（2026-09-11 方案 A）：append（appendFile 增量）与 rewrite
    // （全量重写）是两类文件写，并发交错会坏行/丢行；队列保证写顺序 = 调用
    // 顺序，fire-and-forget 语义不变（同步返回，错误留痕且不断链）。
    let mailWriteChain: Promise<void> = Promise.resolve()
    const mailbox = new Mailbox(subAgentRegistry.agentTree, {
      persistence: {
        // 发送路径是同步 API，故此处 fire-and-forget：不 await，但失败要留痕
        // （静默丢信比慢一点糟得多）。catch 后链条继续（单次失败不阻塞后续写）。
        append: (item) => {
          mailWriteChain = mailWriteChain
            .then(() => sessionStore.appendMail(sessionId, item))
            .catch((e: unknown) => {
              console.warn('[mailbox] persist failed', {
                sessionId,
                mailId: item.id,
                err: e instanceof Error ? e.message : String(e),
              })
            })
        },
        // markRead 的全量回写（方案 A）：排在队列尾，与 append 串行。
        rewrite: (items) => {
          mailWriteChain = mailWriteChain
            .then(() => sessionStore.rewriteMails(sessionId, items))
            .catch((e: unknown) => {
              console.warn('[mailbox] rewrite failed', {
                sessionId,
                err: e instanceof Error ? e.message : String(e),
              })
            })
        },
      },
      ttlDays: sessionStore.ttlDays,
    })
    // 恢复 + 启动清过期（D11 双保险之一；另一重是读取时的惰性过滤）。
    {
      const persisted = await sessionStore.readMails(sessionId)
      const loaded = mailbox.restore(persisted)
      // 落盘里有过期/重复条目才回写——正常情况不产生多余写。
      if (loaded !== persisted.length) {
        await sessionStore.rewriteMails(sessionId, mailbox.dump())
      }
    }
    // v0.30 (用户拍板 2026-09-09，修法 A)：系统智能体注册进本会话的
    // agentTree（root 的子节点）——mailbox 路由校验（verifyRoute → tree.
    // canCommunicate）对未知节点 fail-closed，此前三智能体"不在三界之内"，
    // LLM-facing mailbox_send 全被拒绝（回复邮件根本发不出）。注册后：
    // 系统智能体 ↔ 工作代理（parent-child）、系统智能体互发（sibling）、
    // 系统智能体 ↔ 子代理（sibling）均可通信；per-session tree 保证并发
    // 会话互不串扰。
    for (const sysName of ['warehouse', 'compressor', 'recall'] as const) {
      subAgentRegistry.agentTree.registerChild(handle.info.workingAgentId, sysName)
    }
    // attach 期现解析 plan（热切换：新会话拿当前 active provider 的注入防御
    // 判定；url/model 是系统智能体 loop 的占位参数，请求体由 streamChat 实例
    // 强制为 provider 配置值）。
    const attachPlan = resolveCurrentPlan()
    // v0.30: warehouse 持久会话落盘路径——<dataDir>/<sessionId>/state/
    // warehouse-session.jsonl（格式与加载语义见 system-agent-persistence.ts
    // 顶部注释）。sessionStore 经 sessionManager 同 basePath 创建。
    const warehousePersistPath = join(sessionStore.stateDir(sessionId), 'warehouse-session.jsonl')

    // ---- v0.34 D13（用户拍板 2026-09-10）：工作区级上下文**提前装配** ----
    //
    // 为什么提前：子代理也要拿到这两样（见下方 registerSystemAgentTools 的传参）。
    // 此前子代理只拿 WORK_DIR_RULE + 角色 prompt——看不到 AGENTS.md 与四类注入，
    // 而工作代理看得到 → 上下文不对称，子代理会违反项目约定。
    //
    // AGENTS.md 层叠（v0.19 D1 资产，v0.31 首次接入生产装配）：managed →
    // user → project(AGENTS.md) → local 四层按 priority 合并。attach 时拼一次，
    // 跨轮稳定（prompt cache 友好）；缺文件静默跳过（safeRead）。
    // user 层路径可用 promptLayerUserPath 覆盖（测试封闭缝）。
    const layered = buildLayeredPrompt(
      await loadPromptLayers({
        basePath: workDir,
        ...(opts.promptLayerUserPath !== undefined ? { userPath: opts.promptLayerUserPath } : {}),
      }),
    )

    // ContextInjector 注入（v0.19 D11 资产，v0.31 首次接入生产装配）：
    // runtime/temporal 落 system 消息之后（afterSystem），when-to-read（v0.42，
    // 合并原 memory/architecture 两源）落 user 消息之后（afterUser）。注入源读
    // ctx.workDir（buildLoopOptions 经 info.workDir 透传 → loop composePrompt
    // 传给注入 ctx）。单源抛错由 ContextInjector 记警告跳过，不击穿整轮 turn。
    //
    // 实例跨 agent 共享（工作代理 + 子代理 + system agent）：inject(ctx) 的
    // agentId/workDir/sessionId 由各自的 loop 提供，互不串扰。
    //
    // ⚠️ compose 的 mcpServerSummary 合并逻辑是"追加到 messages 里最后一条
    // system 消息"（compose.ts:100-110）。接入本注入器后，最后一条 system
    // 消息可能是注入消息（MEMORY.md 存在时为其注入消息；无记忆文档时可能是
    // afterUser 注入或 temporal 消息），不再是 stateLine/主系统提示词——摘要
    // 落点随会话文档情况漂移属预期（内容与 role 不变、均为每轮重算），排查
    // prompt 组装时不要以"固定落点"为前提。
    const contextInjector = new ContextInjector()
    contextInjector.register(createRuntimeInjection())
    contextInjector.register(createTemporalInjection())
    contextInjector.register(createWhenToReadInjection())
    // 系统智能体固定默认 provider（用户拍板 2026-09-15）：给出时系统智能体
    // 锚定该 providers.json 条目，不随工作代理 /provider use 热切换——streamChat
    // 用固定实例，url/model 也取该条目的值。缺省 = 沿用 active（委派跟随）。
    const systemAgentPlan = opts.systemAgentProvider !== undefined
      ? resolveLLMPlan({ ...(opts.mock !== undefined ? { mock: opts.mock } : {}), lookup: providerLookup, providerName: opts.systemAgentProvider })
      : undefined
    const systemAgentChat: HostStreamChat = systemAgentPlan !== undefined
      ? resolveStreamChat(systemAgentPlan)
      : delegatingStreamChat
    const systemAgentDeps = {
      llmStreamChat: systemAgentChat,
      url: systemAgentPlan?.url ?? attachPlan.url,
      model: systemAgentPlan?.model ?? attachPlan.model,
      tokenCounter: systemAgentPlan?.tokenCounter ?? (() => resolveCurrentPlan().tokenCounter),
      mailbox,
      registry,
      stateLine: handle.runtime.stateLine,
      warehousePersistPath,
      // v0.30: 压缩失败上报的接收方（工作代理）。
      workingAgentId: handle.info.workingAgentId,
      // v0.41 D19 覆盖面扩展：attach 时快照（与同处的 url/model 同语义——系统
      // 智能体的 provider 本就是 attach 期定死的，/provider use 切换只影响下一次
      // attach 与工作代理的逐轮热解析）。
      ...(systemAgentPlan?.strictAlternation ? { strictAlternation: true } : {}),
    }
    const systemAgents = createSystemAgents(systemAgentDeps)
    const directRecallLedger = createDirectRecallLedger()
    // D5（ADR-036）：大召回转交的结构化可审计报告。临时代理复用 recall 系统
    // 智能体 + 调用级只读 toolRefs/policy（由 runLargeRecall 固定）；原始输出
    // 落盘到 <stateDir>/large-recall/，主代理只收到结构化摘要（再经 turn.ts
    // 的 20K 投影）。拆分前这里是内联实现，逻辑与 v0.44 计划 §5.3 一致。
    const largeRecall: NonNullable<import('../im/loop.js').IMLoopOptions['largeRecall']> = async (input) =>
      runLargeRecall(input, {
        recallAgent: systemAgents.recall,
        sessionId,
        rawOutputDir: join(sessionStore.stateDir(sessionId), 'large-recall'),
      })
    // e2e 测试缝（见 HostAssemblyOptions.compressorOverride）：mock LLM 无法
    // 产出合法 CuratedMemory JSON，测试注入 fake 后小阈值下验证压缩管线。
    const compressor = compressorOverride ?? systemAgents.compressor
    // C3（用户拍板 2026-09-17）：第二压缩机实例 → drive-coordinator 的压缩池
    // 并行度提到 2（M3 压力阀一波压两个块）。测试缝下**不造**第二实例：注入的
    // 单个 fake 不可重入（submitted 是逐实例闭包状态，run 开头重置），并行度
    // 恒 1 = v0.42 行为，既有 e2e 断言不受本次升级影响。
    const compressorOverflow = compressorOverride === undefined
      ? createOverflowCompressor(systemAgentDeps)
      : undefined

    // ---- v0.41 goal 模式装配 ----
    // 三件事：会话级状态 + judge/distiller（D18：都用当前激活 provider，每轮
    // 热解析，跟随 /provider use 切换）+ beforeComplete hook。hook 挂在
    // runPromptOnce 合并链的末端，与折叠/渲染/gate 三组并列——mergeLoopHooks
    // 逐字段真合并，而 beforeComplete 只有 goal 一家产出，链式 ?? 不会遮蔽。
    //
    // resolveDriveCoordinator 必须是 getter：下面紧接着才把 runtime 的 noop
    // coordinator 覆盖成真 coordinator，持值版本会静默拿到 noop → G1 永不落盘。
    const goal = createGoalSessionState()
    // strictAlternation 一并解出：judge 把全量 canonical 逐字铺进请求，goal 模式下
    // 其中会有相邻 user（G1 信封 mem- 紧邻续跑提醒 goal-），不转写则严格交替
    // provider 在**裁决调用**上 400 → judge_failed → fail-open 空转（D19 想防的
    // 失败换个位置发生）。distiller 忽略这个字段（它的请求只有一条自造 user 消息）。
      const resolveGoalLlm = (): {
      url: string
      model: string
      streamChat: HostStreamChat
      strictAlternation: boolean
      tokenCounter: TokenCounter
    } => {
      const plan = resolveCurrentPlan()
      return {
        url: plan.url,
        model: plan.model,
        streamChat: resolveStreamChat(plan),
        strictAlternation: plan.strictAlternation,
        tokenCounter: plan.tokenCounter,
      }
    }
    const goalHooks = createGoalHooks({
      state: goal,
      judge: createGoalJudge({
        resolveLlm: resolveGoalLlm,
        mailbox,
        registry,
        stateLine: handle.runtime.stateLine,
      }),
      distiller: createDistiller({
        resolveLlm: resolveGoalLlm,
        mailbox,
        registry,
        stateLine: handle.runtime.stateLine,
      }),
      resolveDriveCoordinator: () => handle.runtime.driveCoordinator,
      config: resolveGoalConfig(),
      ...(memoryConfig !== undefined ? { memoryConfig } : {}),
      onEvent: (event) => gate.emit({ kind: 'goal.changed', sessionId, event }),
    })

    // ---- 压缩调度接线（v0.27 后置条件补齐）----
    // 此前生产装配的 driveCoordinator 恒为 noop：session-manager 的 create
    // 路径硬编码 noop、open 路径的 compression 口子从未有宿主传过——M1/M2/M3
    // 压缩与 M3 入库永不调度，语义召回（state_query queryText → chroma）查到的
    // 永远是空库。attachHandle 是 create/open/history 三条路径的唯一装配点，
    // 此处用真实 deps 覆盖 runtime 的 noop；buildLoopOptions 读 runtime 引用
    // （非闭包快照），装配后的每一轮 fireDriveCoordinator 即走真调度。
    // mailbox 必须与 loop 同实例——coordinator 的 systemSend 通知（压缩成功/
    // 失败）发给 workingAgentId，工作代理经 mailbox_read 读到的是这个实例。
    handle.runtime.driveCoordinator = createDriveCoordinator({
      bus: createSignalBus(),
      compressor,
      warehouse: systemAgents.warehouse,
      stateLine: handle.runtime.stateLine,
      mailbox,
      workingAgentId: handle.info.workingAgentId,
      tokenCounter: systemAgentPlan?.tokenCounter ?? (() => resolveCurrentPlan().tokenCounter),
      // 原位信封落盘（2026-09-13 用户拍板）：压缩成功后把含信封的内存快照
      // 原子重写到 conversation.jsonl/databus.jsonl——磁盘 ≡ 模型所见，跨重启
      // 信封不消失。经 runtime.enqueueSnapshotWrite 走会话级写串行队列（与
      // persistTurn append 同队列，防 fire-and-forget tick 交错）。
      rewriteSnapshot: (conversation, databus) =>
        handle.runtime.enqueueSnapshotWrite(conversation, databus),
      // v0.41 D7：goal 激活时块压缩交给 goal 路径（G1 本地合并 + G2 信封
      // 折叠），跨越驱动派发互斥关闭；M3 归档与 lastLayer 记账保留（守卫放在
      // 归档驱动之后，见 drive-coordinator tick）。getter 形式因为 /goal 可以
      // 在运行中开关——持值快照会让开关对已 attach 的会话失效。
      goalModeActive: () => goal.current !== undefined,
      // C3：压缩池第二实例（undefined = 并行度 1）。池大小只在 M3 层放开第二
      // 个槽位（tick 的 waveCount），落盘仍按领取次序 FIFO，戳序不变。
      ...(compressorOverflow !== undefined ? { compressorOverflow } : {}),
    })
    registerSystemAgentTools(
      registry,
      mailbox,
      systemAgents,
      subAgentRegistry,
      // workDir 透传：run_subagent 创建的子代理 systemPrompt 前置工作区声明
      // + 子代理 loop runtime 注入 WorkDir（与主代理对称，权限边界语义）。
      // v0.34 D13：再加上工作区级上下文——AGENTS.md 层叠 + 四类注入。此前子代理
      // 看不到它们而主代理看得到（上下文不对称）；对话历史/databus/state-line
      // 仍严格隔离（ADR-0017 子代理-databus 边界）。
      {
        llmStreamChat: delegatingStreamChat, url: attachPlan.url, model: attachPlan.model,
        stateLine: handle.runtime.stateLine, workDir, modelCaps: attachPlan.modelCaps,
        tokenCounter: () => resolveCurrentPlan().tokenCounter,
        contextInjector, layeredPrompt: layered,
        // v0.41 D19 覆盖面扩展：子代理同样经 createSystemAgent 构造，请求尾部
        // 带一条空 user 消息（messages.ts 来源之二）。
        ...(attachPlan.strictAlternation ? { strictAlternation: true } : {}),
      },
    )

    // LongHorizon is a session asset, not a global mode. It observes the
    // existing hook points and injects its skill only while enabled; it never
    // changes canonical history, goal state, guards or prompt ordering.
    const workflow = await LongHorizonWorkflow.open({
      sessionId,
      workDir,
      dataDir: opts.dataDir,
      subAgentRegistry,
      scoutDeps: {
        llmStreamChat: systemAgentChat,
        url: attachPlan.url,
        model: attachPlan.model,
        mailbox,
        registry,
        stateLine: handle.runtime.stateLine,
        defaultConfig: config,
        workDir,
        tokenCounter: () => resolveCurrentPlan().tokenCounter,
        contextInjector,
        layeredPrompt: layered,
        ...(attachPlan.strictAlternation ? { strictAlternation: true } : {}),
      },
      onEvent: (event: WorkflowRunEvent) => {
        gate.emit({ kind: 'workflow.run', sessionId, event })
      },
    })
    contextInjector.register(workflow.injection())
    const workflowHooks = workflow.hooks()

    // 暴露清单只算一次（白名单事实源单一）。系统智能体私有工具永不进工作代理
    // 白名单；noNetworkTools 时再剔除联网工具（DeepSWE 空网评测：机制层禁，
    // 提示词与 tools 数组同源同步消失）。
    const exposedToolRefs = registry
      .listSystemTools()
      .filter((n) => n !== 'record_m3_summary' && n !== 'submit_curated_memory')
      .filter((n) => !(opts.noNetworkTools === true && (n === 'web_fetch' || n === 'open_url')))
      .filter((n) => opts.allowedToolRefs === undefined || opts.allowedToolRefs.includes(n))

    const bus = createRenderingSignalBus()
    const store = new ArtifactStore()
    // autoSubscribe:false（v0.21 拍板）：bus → Gate → base.handleSignal 顺序，
    // 转发由 wireRenderingToGate 负责。
    const base = createRenderingBase(bus, { store, autoSubscribe: false })
    // 通用渲染规则归装配（wiki 规则归 wiki-agent 自注册）：工作代理 write/
    // edit/search_replace 产出的 .md 自动渲染进产物区（用户拍板 2026-09-10）。
    // 路径解析锚定本会话工作区（与 write 工具同一 resolver）。
    bus.registerRule(createProducedMdRule(store, workDir))
    // 渲染转发 hook 必须装进工作代理的 hook 链（此前只装在 wiki-agent 的
    // loop 里——工作代理的工具回合从未到达 bus，规则永不触发）。
    const renderingHooks: LoopHooks = {
      afterToolExecution: createRenderingLoopHook(bus),
    }

    const wiring = wireSessionToGate({
      gate,
      sessionId,
      rendering: { bus, base },
      stateLine: handle.runtime.stateLine,
    })

    // v0.30（用户拍板 2026-09-09）：工具级压缩——工具回合数超过热窗口（20）后，
    // 窗口外 result > 100 token 的批次折叠成"历史工具表"（纯算法，不调 LLM；
    // databus 不动，细节靠关键字召回）。经 HOOK 5 afterToolExecution 执行
    // （工具执行后、本轮结果 append 前），canonical 修改权经用户确认。
    // 宿主 own hooks 与 gate hooks 合并：own 先跑（折叠改变后续 ctx 无影响
    // ——gate 只观察转发本轮 toolResults）。
    const toolTableHooks: LoopHooks = {
      afterToolExecution: async (ctx) => {
        if (ctx.conversationMemory !== undefined) {
          foldOversizeToolTurns(ctx.conversationMemory, {
            ...(ctx.tokenCounter !== undefined ? { tokenCounter: ctx.tokenCounter } : {}),
          })
        }
        return undefined
      },
    }

    registry.registerDoor(createSensitivePathDoor())
    registry.registerDoor(createDangerousCommandDoor())
    registry.registerDoor(createBrowserToolsDoor())
    registry.registerDoor(createWriteApprovalDoor({ handler: wiring.approvalHandler, timeoutMs: 300_000 }))

    // 系统提示词：v0.19 的官方中文模板（FULL 模式）+ 本会话 registry 的工具
    // 清单（tooling_section）。此前这里是装配层手写的英文占位——用户指出
    // "我写的系统提示词是中文的"，正确的资产一直是 src/im/prompt/。
    // v0.25: 传 exposedSystemToolRefs——提示词宣传的工具清单 = 模型实际
    // 拿到的白名单（同源，不各算各的）。
    // 注入防御段默认关闭；上游为第三方中转站时（--untrusted-upstream，等效
    // 服务商 json 里"上游有风险 = 是"）才追加，避免正常文档也被当成不可信。
    //
    // v0.41: goal 模式可运行中切换（`/goal on|off`），提示词每轮 resolve。
    // 构建两版（goal OFF / goal ON），getter 根据 goal.current 选版。
    const promptCommon = {
      mode: 'full' as const,
      agentName: SYSTEM_PROMPT_NAME,
      registry,
      modelId: attachPlan.model,
      exposedSystemToolRefs: exposedToolRefs,
      promptInjectionDefense: attachPlan.needInjectionDefense,
      delegationAuthorization: readSettings().subAgentNesting === true,
      workDir,
    }
    const staticPromptOff = buildStaticPrompt(promptCommon)
    const staticPromptOn = buildStaticPrompt({ ...promptCommon, goal: true })

    // AGENTS.md 层叠已在 attach 早期装配（见上方 D13 注释），此处只负责把它拼到
    // 静态模板尾部。不占 {dynamic_sections}——那是 ContextInjector 的运行时位置
    // （注入的是独立消息，不是系统提示词文本）。attach 时拼一次，跨轮稳定
    // （prompt cache 友好）。
    const layeredOff = layered.length > 0 ? `${staticPromptOff}\n\n${layered}` : staticPromptOff
    const layeredOn = layered.length > 0 ? `${staticPromptOn}\n\n${layered}` : staticPromptOn

    // ContextInjector 四类注入已在 attach 早期装配（见上方 D13 注释）——
    // 装配早于 registerSystemAgentTools，子代理因此能共享同一实例。

    // v0.41: getter 每轮 resolve——goal OFF → 原段（G1/G2 与既有压缩行为一致）；
    // goal ON → 目标锚点段（G1/G2 确定性 + #OBJECTIVE 每轮重述）。
    const prompt = () => goal.current !== undefined ? layeredOn : layeredOff

    const assets: SessionAssets = {
      handle, wiring, registry, bus, base, store, prompt,
      mailbox, exposedToolRefs, toolTableHooks, renderingHooks, contextInjector,
      fileHistory, goal, goalHooks, workflow, workflowHooks, largeRecall, directRecallLedger,
    }
    openHandles.set(sessionId, assets)

    // 信源透明（系统提示词部分）：装配层手里有 systemPrompt 原文，emit 给前端。
    // context 注入内容由 loop 内部读取，v0.23 加 prompt.assembled 信号再做全量。
    gate.emit({ kind: 'session.event', sessionId, event: 'system.prompt', data: { text: prompt() } })
    // 信源透明（工具自描述部分，v0.28）：工具清单 = 暴露白名单的 name +
    // description（纪律载体，与 schema/提示词清单三处同源于 registry）。
    gate.emit({ kind: 'session.event', sessionId, event: 'tools', data: buildToolsPayload(registry, exposedToolRefs) })
    gate.emit({ kind: 'workflow.changed', sessionId, state: workflow.state })
    return assets
  }

  /**
   * 创建会话并接入信号关（公开入口）。workDir 必填（工作区 = 权限边界，
   * 用户拍板 2026-09-06）：没有显式工作区就没有文件操作边界，敏感路径检测 /
   * 写审批记账都无从谈起。库层不强制此策略（payload.workDir 类型保持
   * optional），宿主装配层执行它。
   */
  async function attachSession(workDir: string): Promise<SessionAssets> {
    const trimmed = workDir.trim()
    if (trimmed.length === 0) {
      throw new Error('session.create requires a workDir — the workspace is the permission boundary')
    }
    mkdirSync(trimmed, { recursive: true })
    const handle = await sessionManager.createSession({
      title: 'web session',
      workingAgentId: 'main',
      workDir: trimmed,
    })
    return attachHandle(handle, trimmed)
  }

  async function detachSession(id: string): Promise<void> {
    const assets = openHandles.get(id)
    if (assets === undefined) return
    assets.wiring.dispose()
    cancelSignals.get(id)?.abort()
    cancelSignals.delete(id)
    openHandles.delete(id)
    await assets.handle.close()
  }

  /**
   * per-session 命令的会话查找：openHandles 是唯一事实源，未 attach 一律抛
   * 干净错误（runPromptOnce 与 goal.* 共用，文案不两处漂移）。
   */
  const requireOpenAssets = (sessionId: string): SessionAssets => {
    const assets = openHandles.get(sessionId)
    if (assets === undefined) {
      throw new Error(`session "${sessionId}" is not open; call session.open first`)
    }
    return assets
  }

  // ---- Signal Gate：唯一前后端中转站 ----
  // turn.end 在 runPromptOnce 末尾手动 emit（v0.21 的 wrapRunPromptWithTurnEnd
  // deps 类型带 per-session getSessionId，与跨会话 runPrompt 不匹配——见计划 §7）。
  const runPromptOnce = async (sessionId: string, text: string): Promise<IMLoopResult> => {
    const assets = requireOpenAssets(sessionId)
    const workflowState = assets.workflow.state
    if (workflowState.enabled && workflowState.baseline.status !== 'completed') {
      throw new Error(
        'LongHorizon workflow baseline is not completed; run workflow.baseline successfully before user.prompt',
      )
    }
    // Wave B1 热切换：每轮现解析 provider（providers.json 磁盘事实源）——
    // /provider use 写完 active 后，下一个 runPrompt 即用新 url/model/key。
    const plan = resolveCurrentPlan()
    const controller = new AbortController()
    cancelSignals.set(sessionId, controller)
    try {
      const loopOpts = assets.handle.buildLoopOptions({
        config,
        registry: assets.registry,
        streamChat: resolveStreamChat(plan),
        url: plan.url,
        model: plan.model,
        // v0.41 D19：provider 声明严格交替时，call.ts 在构造请求体前合并相邻
        // user 消息（压缩信封与 goal 块合并都会产生 [envelope-user, next-user]
        // 连续 user）。缺省 false 不转写，既有会话 wire 形状逐字节不变。
        ...(plan.strictAlternation ? { strictAlternation: true } : {}),
        systemPrompt: assets.prompt(),
        userTemplate: text,
        // v0.25: 会话级 Mailbox（跨轮复用）+ 系统工具白名单——与
        // buildStaticPrompt 同源的 exposedToolRefs。缺失这两项是此前
        // "真实 LLM 会话 tools 数组为空"的根因。
        mailbox: assets.mailbox,
        systemToolRefs: assets.exposedToolRefs,
        // v0.31 接线：四类上下文注入（runtime/temporal/memory/architecture）。
        // loop.composePrompt 每轮消费（system → afterSystem 注入 → history →
        // user → afterUser 注入）；workDir 由 buildLoopOptions 经 info.workDir
        // 透传进注入 ctx。缺了它 = MEMORY.md/ARCHITECTURE.md 永不进上下文。
        contextInjector: assets.contextInjector,
        // hook 链顺序：折叠（宿主）→ 渲染转发 → gate（tool.result 出站）→
        // goal（beforeComplete）。渲染转发此前只装在 wiki-agent 的 loop 里，
        // 工作代理永不触发——典型"实现了但没接线"缺陷，v0.33 修复（用户拍板
        // 2026-09-10）。v0.41 加第四路：goal 只产出 beforeComplete，与前三路
        // 的字段零重叠，所以合并顺序不改语义（mergeLoopHooks 逐字段链式）。
        hooks: mergeLoopHooks(
          mergeLoopHooks(
            mergeLoopHooks(assets.toolTableHooks, assets.renderingHooks),
            assets.wiring.gateHooks,
          ),
          mergeLoopHooks(assets.goalHooks, assets.workflowHooks),
        ),
        onStreamChunk: assets.wiring.onStreamChunk,
        // 思维链落盘（2026-09-12 用户拍板，赋值面 = 落盘面）：工作代理经
        // persistTurn 落 conversation.jsonl，reasoning 随 assistant 回合持久化。
        persistReasoning: true,
        requestHandler: assets.wiring.requestHandler,
        rendering: { bus: assets.bus, base: assets.base, store: assets.store },
        // 取消信号必须真正进 loop（v0.17 P1-6 的 signal 参数）：此前
        // controller 只存在于本闭包，turn.cancel 的 abort() 是 no-op——
        // CLI Ctrl-C 取消回合、前端取消按钮、headless 取消全部无效。
        signal: controller.signal,
        largeRecall: assets.largeRecall,
        directRecallLedger: assets.directRecallLedger,
        tokenCounter: plan.tokenCounter,
        // 记忆分层阈值（e2e 测试用小阈值触发压缩；缺省 DEFAULT_MEMORY_CONFIG
        // 由 loop/coordinator 各自兜底）。
        ...(memoryConfig !== undefined ? { memoryConfig } : {}),
      })
      const result = await runIMLoop(loopOpts)
      // 只有 completed（回合真正干完活）才撤销取消登记——晚到的 cancel 竞态
      // 不产生"被停止"标记。注意 shell-terminated 也是 runIMLoop 的**正常
      // 返回**（AbortError 在 loop 内部 catch，loop.ts:1139-1149），不能当
      // "正常收尾"撤销，否则取消标记永远不落插。
      if (result.reason === 'completed') pendingStopMarker.delete(sessionId)
      return result
    } finally {
      cancelSignals.delete(sessionId)
      // 用户停止标记落插（2026-09-17 用户拍板"入站登记 + 回合收尾落插"）：
      // 此刻 loop 已 unwind——在飞工具的 error ToolTurn 已 append + persist，
      // 标记 user 回合插在它们之后，wire 序列合法。标记进 canonical + 落盘
      // conversation.jsonl（与普通 user 回合同路径，走会话写串行队列）。
      if (pendingStopMarker.delete(sessionId)) {
        const runtime = assets.handle.runtime
        const marker = buildUserStopMarkerTurn()
        appendCanonicalTurn(runtime.conversationMemory, runtime.databus, marker)
        await runtime.persistTurn(marker)
      }
    }
  }

  /**
   * 当前会话权限快照 → permission.changed 推送。session.open/create 完成后
   * 调用——前端（含新开标签页/刷新重连）据此初始化该会话的权限显示，不本地
   * 乐观猜状态。已打开会话重复 open 同样推送（幂等信号，值不变无副作用）。
   */
  const emitPermissionChanged = (sessionId: string): void => {
    const assets = openHandles.get(sessionId)
    // SessionSecurityState.fullPermission 类型可选（undefined = 未设置 = 审批模式）。
    const full = (assets !== undefined
      ? assets.registry.getOrCreateSession(sessionId).fullPermission
      : false) ?? false
    gate.emit({ kind: 'permission.changed', sessionId, full })
  }

  /**
   * providers.json 快照 → 派生目录（v0.32）：每条目解析有效思考能力
   * （models[].reasoning 声明覆盖内置 KNOWN_MODELS 表），前端/CLI 零推导——
   * 能力门控与 wire 编码同源（计划 §4 原则 2）。
   */
  const buildProviderCatalog = (r: ProviderListResult): ProviderCatalogEntry[] =>
    Object.entries(r.providers).map(([name, p]) => ({
      name,
      active: name === r.active,
      selectedModel: p.model,
      reasoningEffort: p.reasoningEffort,
      models: (p.models ?? [{ id: p.model }]).map((m) => {
        const reasoning = resolveModelReasoning(m.id, m.reasoning)
        return { id: m.id, ...(reasoning !== undefined ? { reasoning } : {}) }
      }),
    }))

  /** provider.* 写命令成功后广播新目录（permission.changed 同模式——多客户端同步）。 */
  const emitProviderChanged = (): void => {
    const r = listProviders(providerLookup)
    gate.emit({ kind: 'provider.changed', catalog: { exists: r.exists, configPath: r.configPath, active: r.active, providers: buildProviderCatalog(r) } })
  }

  // v0.33b 知识卡片：全局单库 wiki 子进程（懒启动，首次 wiki.* 命令时起）。
  const wikiPool = createWikiPool()
  // v0.33b 第二轮：工作区知识库生成任务（wiki agent 阅读工作区后产卡）。
  // 状态经 gate 出站信号推送；宿主 shutdown 时停在跑任务。
  const wikiGenerate = createWikiGenerateManager({
    pool: wikiPool,
    resolveLlm: () => {
      const plan = resolveCurrentPlan()
      return {
        url: plan.url,
        model: plan.model,
        streamChat: resolveStreamChat(plan),
        strictAlternation: plan.strictAlternation,
      }
    },
    onStatus: (status) => gate.emit({ kind: 'wiki.generateStatus', status }),
    onChanged: () => gate.emit({ kind: 'wiki.changed' }),
  })

  const handlers: SignalGateHandlers = {
    runPrompt: async (sessionId, text) => {
      const result = await runPromptOnce(sessionId, text)
      gate.emit({ kind: 'turn.end', sessionId, result })
      return result
    },
    session: {
      create: async (createOpts) => {
        // 工作区必选（用户拍板 2026-09-06）：没有显式工作区就没有文件操作
        // 边界，敏感路径检测 / 写审批记账都无从谈起。库层不强制此策略
        // （payload.workDir 类型保持 optional），宿主装配层执行它。
        const workDir = createOpts?.workDir?.trim()
        if (workDir === undefined || workDir.length === 0) {
          throw new Error('session.create requires a workDir — the workspace is the permission boundary')
        }
        mkdirSync(workDir, { recursive: true })
        const handle = await sessionManager.createSession({
          title: createOpts?.title ?? 'web session',
          workingAgentId: createOpts?.workingAgentId ?? 'main',
          workDir,
        })
        await attachHandle(handle, workDir)
        emitPermissionChanged(handle.info.id)
        return handle
      },
      open: async (id) => {
        const existing = openHandles.get(id)
        if (existing !== undefined) {
          emitPermissionChanged(id)
          return existing.handle
        }
        const handle = await sessionManager.openSession(id)
        // 会话创建时 workDir 必存；无 workDir 的旧数据拒绝恢复（不静默给默认目录）。
        const workDir = handle.info.workDir
        if (workDir === undefined || workDir.length === 0) {
          throw new Error(`session "${id}" has no workDir recorded; it predates the workspace requirement`)
        }
        mkdirSync(workDir, { recursive: true })
        await attachHandle(handle, workDir)
        emitPermissionChanged(id)
        return handle
      },
      list: () => sessionManager.listSessions(),
      close: async (id) => {
        await detachSession(id)
        await sessionManager.closeSession(id)
      },
      delete: async (id) => {
        await detachSession(id)
        await sessionManager.deleteSession(id)
      },
      history: async (id) => {
        const existing = openHandles.get(id)
        if (existing !== undefined) return existing.handle.runtime.conversationMemory.turns()
        const handle = await sessionManager.openSession(id)
        const workDir = handle.info.workDir
        if (workDir === undefined || workDir.length === 0) {
          throw new Error(`session "${id}" has no workDir recorded; it predates the workspace requirement`)
        }
        await attachHandle(handle, workDir)
        return handle.runtime.conversationMemory.turns()
      },
      rename: async (id, title) => {
        const trimmed = title.trim()
        if (trimmed === '') {
          throw new Error('session.rename requires a non-empty title')
        }
        if ([...trimmed].length > MAX_SESSION_TITLE_CHARS) {
          throw new Error(`session title must be at most ${MAX_SESSION_TITLE_CHARS} characters`)
        }
        // session.json 为事实源：readInfo → writeInfo（不要求会话处于打开态）。
        // 已打开的句柄同步其内存投影（saveInfo 同款 Object.assign 语义）。
        const info = await sessionStore.readInfo(id)
        if (info === null) {
          throw new Error(`session "${id}" not found`)
        }
        await sessionStore.writeInfo({ ...info, title: trimmed })
        const assets = openHandles.get(id)
        if (assets !== undefined) assets.handle.info.title = trimmed
      },
      // v0.29 Wave B2（/fork）：会话分叉（不切换）。复制与落盘在
      // session-manager.forkSession（conversation.jsonl + databus.jsonl 字节级
      // copyFile，state/ 梯度不复制）；本 handler 只取 SessionInfo 返回。
      // 不 attach：fork 副本不进 openHandles、不接入信号关——续聊走 session.open
      // （recoverSession 按副本快照重建 runtime）。forkSession 返回的 handle
      // 携带为"可直接续聊"重建的 runtime；装配层不使用它，当场 close 释放
      // stateLine（open 时会重建），不留悬空文件句柄。
      fork: async (id) => {
        const handle = await sessionManager.forkSession(id)
        const info = { ...handle.info }
        await handle.close()
        return info
      },
      // v0.29 Wave B2（/undo）：撤回最近 blocks 个任务块。会话必须已打开
      //（撤回操作活跃 runtime 的内存 canonical + databus 投影）；范围/块数
      // 校验与 raw-archive 守卫在 undoTaskBlocks（src/host/session-undo.ts）。
      undo: async (id, blocks) => {
        const assets = openHandles.get(id)
        if (assets === undefined) {
          throw new Error(`session "${id}" is not open; call session.open first`)
        }
        return undoTaskBlocks(
          {
            sessionId: id,
            conversationMemory: assets.handle.runtime.conversationMemory,
            databus: assets.handle.runtime.databus,
            stateLine: assets.handle.runtime.stateLine,
            // sessionStore 与 SessionManager 内部 store 同 basePath——文件是
            // 唯一事实源，journal 的读-改-写直接走它。
            store: sessionStore,
          },
          blocks,
        )
      },
      // v0.36（/rewind）：把 AI 改过的文件还原到改动之前。会话必须已打开
      //（快照层实例是 per-session registry 的产物）。范围校验、索引读取、
      // 还原/删除与 unbacked 上报都在 rewindSessionFiles（src/host/session-rewind.ts）。
      rewind: async (id, entries) => {
        const assets = openHandles.get(id)
        if (assets === undefined) {
          throw new Error(`session "${id}" is not open; call session.open first`)
        }
        return rewindSessionFiles(
          { sessionId: id, fileHistory: assets.fileHistory },
          entries,
        )
      },
    },
    cancel: (sessionId) => {
      // 入站登记（2026-09-17 用户拍板）：仅当回合在飞（cancelSignals 有
      // controller = runPromptOnce 进行中）才登记——空闲时 cancel 是 no-op，
      // 不产生标记。标记本体由 runPromptOnce 的 finally 在 unwind 后落插。
      if (cancelSignals.has(sessionId)) pendingStopMarker.add(sessionId)
      cancelSignals.get(sessionId)?.abort()
    },
    // 权限门面（per-session，用户拍板 2026-09-07：全局广播已删除——每个会话
    // 的权限独立，切换只作用于目标会话）。getOrCreateSession(sessionId) 即该
    // registry 的唯一安全状态；生效后 emit permission.changed 推送新状态（UI
    // 是信号的忠实投影，前端不本地乐观猜状态）。没有 revoke 命令（用户拍板
    // 2026-09-06）：对话中的授权是软机制——LLM 上下文里"曾被批准"的事实无法
    // 用 API 抹掉，revoke 只会制造虚假安全感；deepseek 官方 UI 同样没有
    // revoke 按钮。
    setFullPermission: (sessionId, enabled) => {
      const assets = openHandles.get(sessionId)
      if (assets === undefined) {
        throw new Error(`session "${sessionId}" is not open; call session.open first`)
      }
      const state = assets.registry.getOrCreateSession(sessionId)
      state.fullPermission = enabled
      if (enabled) state.approvalStore.grant(ApprovalStore.keyForFullPermission())
      else state.approvalStore.revoke(ApprovalStore.keyForFullPermission())
      gate.emit({ kind: 'permission.changed', sessionId, full: enabled })
    },
    getArtifact: async (artifactId) => {
      // artifactId 由 per-session ArtifactStore 生成（uuid），逐会话查找命中者。
      for (const assets of openHandles.values()) {
        const html = assets.base.getHtml(artifactId)
        if (html !== undefined) {
          const handle = assets.base.handles().find((h) => h.id === artifactId)
          return {
            id: artifactId,
            kind: handle?.kind ?? 'html',
            title: handle?.title ?? artifactId,
            html,
          }
        }
      }
      throw new Error(`artifact "${artifactId}" not found`)
    },
    // v0.24: workspace.read——前端内嵌只读查看器。工作区是权限边界（用户拍板
    // 52315b1）：包含性检查与 fs 读取都收敛在 readWorkspaceEntry（src/host，
    // 可单测），这里只做会话查找与委托（getArtifact 同款结构）。
    readWorkspaceFile: async (sessionId, path) => {
      const assets = openHandles.get(sessionId)
      if (assets === undefined) {
        throw new Error(`session "${sessionId}" not found; call session.open first`)
      }
      const workDir = assets.handle.info.workDir
      if (workDir === undefined || workDir.length === 0) {
        throw new Error(`session "${sessionId}" has no workDir recorded; it predates the workspace requirement`)
      }
      return readWorkspaceEntry(workDir, path)
    },
    // 服务商管理（v0.23；Wave B1 起支持热切换）：settings 面板 / CLI /provider
    // 经 Gate 命令读写 providers.json。文件是唯一事实源；写入后**下一轮
    // runPrompt 即生效**（每轮现解析——热切换语义），新会话的注入防御判定
    // 也随 attach 期现解析更新。
    provider: {
      list: async () => {
        const r = listProviders(providerLookup)
        return { ...r, catalog: buildProviderCatalog(r) }
      },
      upsert: async (name, provider) => {
        const r = upsertProvider({ name, provider, ...providerLookup })
        emitProviderChanged()
        return r
      },
      delete: async (name) => {
        const r = deleteProvider({ name, ...providerLookup })
        emitProviderChanged()
        return r
      },
      activate: async (name) => {
        const r = activateProvider({ name, ...providerLookup })
        emitProviderChanged()
        return r
      },
      // v0.32：模型/档位选择（dsh selectModel 语义；写路径校验在 config/write.ts）。
      select: async (cmd) => {
        const r = selectProviderModel({ ...cmd, ...providerLookup })
        emitProviderChanged()
        return r
      },
    },
    // MCP / 子代理 / 宿主设置 / 扩展清单（v0.25 Wave B）：~/.databus 功能配置。
    mcp: {
      list: async () => listMcpServers(),
      upsert: async (server) => upsertMcpServer({ server }),
      delete: async (name) => deleteMcpServer({ name }),
    },
    subagent: {
      // 磁盘为事实源：每次现读（scratch registry + loadFromDisk）。校验用
      // 参考 registry + 当前开关产物（用 DEFAULT 会在 nesting ON 时误杀
      // 引用 run_subagent 的合法 toolRef）。
      list: async () => {
        const dir = defaultAgentsDir()
        const scratch = await createSubAgentRegistry({
          registry: validationRegistry,
          toolPolicy: resolveSubAgentToolPolicy(),
        })
        await scratch.loadFromDisk(dir, validationRegistry)
        return {
          dir,
          agents: scratch.list().flatMap((n) => {
            const cfg = scratch.get(n)
            return cfg ? [cfg] : []
          }),
        }
      },
      // register 内部做 validateSubAgentConfig 校验 + 原子落盘（校验失败 throw）。
      upsert: async (agent) => {
        const dir = defaultAgentsDir()
        const scratch = await createSubAgentRegistry({
          registry: validationRegistry,
          toolPolicy: resolveSubAgentToolPolicy(),
        })
        await scratch.register(agent, dir)
        return { dir }
      },
      delete: async (name) => {
        // 防路径穿越：name 将拼进文件路径，先过与 validateSubAgentConfig
        // 同款的名字模式。
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
          throw new Error(`sub-agent name "${name}" must be 1-64 characters of [a-zA-Z0-9_-]`)
        }
        const dir = defaultAgentsDir()
        const path = join(dir, `${name}.json`)
        if (!existsSync(path)) {
          throw new Error(`sub-agent config "${name}" does not exist in ${dir}`)
        }
        unlinkSync(path)
        return { dir }
      },
    },
    // settings.set 的子代理向下开关对运行中会话不生效（新会话生效——拍板
    // 语义，UI 提示负责）；skillsDir/textSkillsDir 重启生效（启动期解析）。
    settings: {
      get: async () => readSettings(),
      set: async (patch) => writeDatabusSettings(patch, { homeDir: opts.settingsHomeDir }),
    },
    extensions: {
      // 启动期预载清单快照（配置变更经重启/新会话反映，不做运行期热插拔——
      // ADR-018 D6）。
      info: async () => ({
        skills: preloadSkills,
        textSkills: preloadTextSkills,
        servers: mcpPool.map((p) => p.cfg.name),
        ...(skillsDir !== undefined ? { skillsDir } : {}),
        ...(textSkillsDir !== undefined ? { textSkillsDir } : {}),
      }),
    },
    // v0.33b 知识卡片：全局单库 wiki 子进程（wiki-pool），数据面只在宿主侧，
    // 不进任何会话 registry（LLM 工具面不变）。addCard 成功后广播 wiki.changed。
    wiki: {
      listCards: async () => {
        const conn = await wikiPool.connection()
        const raw = await conn.callTool('list_cards', {})
        const parsed = JSON.parse(raw) as { count: number; results: WikiCardSummary[] }
        return { cards: parsed.results }
      },
      addCard: async (card) => {
        const conn = await wikiPool.connection()
        // id 由宿主生成（wiki server 校验格式：小写字母/数字/连字符）；
        // workspace 标签由前端附加进 card.tags，宿主不加工。
        const id = `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        await conn.callTool('add_card', { card: { ...card, id } })
        gate.emit({ kind: 'wiki.changed' })
        return { id }
      },
      renderCard: async (cardId) => {
        const conn = await wikiPool.connection()
        const cardRaw = await conn.callTool('get_card', { card_id: cardId })
        const card = JSON.parse(cardRaw) as { id: string; title: string }
        const mdRaw = await conn.callTool('render_md', { mode: 'card', card_id: cardId })
        const md = JSON.parse(mdRaw) as { markdown: string }
        return { cardId, title: card.title, html: renderMarkdown(md.markdown) }
      },
      // v0.33b 第二轮：启动生成任务（异步，立即返回；进度走 wiki.generateStatus）。
      generate: async (workDir) => {
        wikiGenerate.start(workDir)
      },
    },
    // v0.41 goal 模式：状态持有者是 attachHandle 建的 per-session
    // GoalSessionState，gate 纯路由；set/clear 生效后由这里 emit goal.changed
    // （permission.full → permission.changed 同模式：谁持有状态谁发信号，
    // 前端不本地乐观猜状态）。maxRounds 缺省用 goal/types.ts 的
    // DEFAULT_GOAL_MAX_ROUNDS——宿主只透传，不改写阈值语义。
    goal: {
      set: async (sessionId, condition, maxRounds) => {
        const assets = requireOpenAssets(sessionId)
        const rounds = maxRounds ?? DEFAULT_GOAL_MAX_ROUNDS
        // 重设即重置：roundsUsed 归零、lastVerdict 丢弃（新目标与旧目标的裁决
        // 不可混用）。一次命令恰好一个事件，不额外补发 cleared。
        assets.goal.current = { condition, maxRounds: rounds, roundsUsed: 0 }
        gate.emit({
          kind: 'goal.changed',
          sessionId,
          event: { status: 'set', condition, maxRounds: rounds },
        })
      },
      clear: async (sessionId) => {
        const assets = requireOpenAssets(sessionId)
        assets.goal.current = undefined
        // 幂等：本来就没有 goal 也回 cleared——用户按下"关闭"就该拿到确认，
        // 而不是静默无事发生。
        gate.emit({ kind: 'goal.changed', sessionId, event: { status: 'cleared' } })
      },
      // 未设置 goal 返回 undefined（"没有目标"是正常状态，不是错误）。
      get: async (sessionId) => requireOpenAssets(sessionId).goal.current,
    },
    workflow: {
      enable: async (sessionId): Promise<WorkflowState> => {
        const assets = requireOpenAssets(sessionId)
        const state = await assets.workflow.enable()
        gate.emit({ kind: 'workflow.changed', sessionId, state })
        return state
      },
      disable: async (sessionId): Promise<WorkflowState> => {
        const assets = requireOpenAssets(sessionId)
        const state = await assets.workflow.disable()
        gate.emit({ kind: 'workflow.changed', sessionId, state })
        return state
      },
      status: async (sessionId): Promise<WorkflowState> =>
        requireOpenAssets(sessionId).workflow.state,
      baseline: async (sessionId) => {
        const assets = requireOpenAssets(sessionId)
        return assets.workflow.runBaseline()
      },
    },
  }

  const gate: SignalGate = createSignalGate({ handlers })

  // 日志 sink 随 gate 走（v0.26 起归装配层）：logger → gate log 信号（stderr
  // 保留可关——TUI 宿主传 logToStderr:false，原始 JSON 会打碎终端 UI）。
  // level 提到 info：日志面板默认展示 info+（v0.22 拍板），logger 默认
  // warn 会把 info 滤掉。component 身份由 logComponent 决定（web-host 传
  // 'web-host' 保持原日志身份；其他宿主缺省 'host'）。
  setLevel('info')
  wireLogSinkToGate({ gate, component: opts.logComponent ?? 'host', ...(opts.logToStderr === false ? { keepStderr: false } : {}) })

  const shutdown = async (): Promise<void> => {
    for (const id of [...openHandles.keys()]) await detachSession(id)
    // 宿主级 MCP 连接池随宿主退出关闭（连接常驻宿主，见启动期装配）。
    await Promise.all(mcpPool.map((p) => p.conn.close().catch(() => undefined)))
    // wiki 全局单库子进程同属宿主自有资产；在跑的生成任务一并停止。
    wikiGenerate.shutdown()
    await wikiPool.close()
  }

  return { gate, handlers, attachSession, detachSession, shutdown }
}
