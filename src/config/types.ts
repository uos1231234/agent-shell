/**
 * Provider 配置类型 — 用户注册模型服务商的 json 文档。
 *
 * 文件位置由 resolveConfigPath 决定（默认 ~/.agent-shell/providers.json，
 * AGENT_SHELL_HOME 可覆盖）。对齐 KimiCode 的 config.toml 模式，但用
 * JSON（Node 原生解析，库核心零依赖）。
 */

/**
 * 模型能力声明（用户拍板 2026-09-09）：服务商没有"查询模型上限"的 API，
 * 上限数据来自用户声明（providers.json 填充后由装配层引用）。两个消费点：
 *   - define_subagent 工具 schema 动态描述 + 子代理 maxTokens 校验上限
 *     （AI 配子代理预算时不再盲配——v0.30 实测案例：AI 把 maxTokens 当输出
 *     预算配了 12000，token guard 按请求总量计，材料一进来即 trip）
 *   - 出站请求 max_tokens（消除服务商默认输出截断，实测 ARK 默认 ~12000）
 *   - v0.41 D19：strictAlternation → 出站前合并相邻 role:'user' 消息
 */
export type ModelCapabilities = {
  /** 模型最大输入（上下文）token 数，如 deepseek-v4-flash = 1000000。 */
  maxInputTokens?: number | undefined
  /** 模型最大输出 token 数，如 deepseek-v4-flash = 384000。 */
  maxOutputTokens?: number | undefined
  /**
   * provider 是否要求**严格角色交替**（v0.41 D19，用户拍板"只要开关，不加自愈"）。
   *
   * true → shell/call.ts 出站前合并相邻的 role:'user' 消息
   * （src/protocol/messages.ts 的 normalizeStrictAlternation）。
   *
   * 缺省 false（宽松）：既有 OpenAI 兼容会话的 wire 形状逐字节不变。代价是
   * 未声明的严格 provider（如 Anthropic）会 400，需要用户在此显式声明——
   * 这是 D19 明知代价后选择的取舍：不做 400 自愈，避免把"猜测 provider 语义"
   * 的逻辑埋进 llm-adapter。
   *
   * 相邻 user 的两个已知来源：压缩信封（mem-）紧邻 goal 续跑提醒（goal-）；
   * 系统智能体请求尾部的空 userTemplate（createSystemAgent 硬编码 ''）。
   */
  strictAlternation?: boolean | undefined
}

/** 思考强度（DeepSeek 官方 thinking.reasoning_effort 档位：low/high/max，
 *  文档明确 medium 被映射到 high）。默认 'max'（用户拍板 2026-09-09：只有
 *  能够完成任务才具备意义，思考不足的失败会被用户归因于 harness）。
 *  档位语义（用户澄清 2026-09-09）：high = 官方默认的正常模式强度，max =
 *  最大思考——UI 文案须区分。 */
export type ThinkingEffort = 'max' | 'high' | 'low' | 'off'

/** 思考档位词汇表（load 校验与 UI 渲染共用，一处事实源）。 */
export const THINKING_EFFORTS = ['max', 'high', 'low', 'off'] as const

/**
 * 单模型的能力目录条目（v0.32，dsh reasoning.efforts 方法论）。reasoning
 * 声明该模型支持的思考档位——UI 只渲染声明过的档位，未知模型不发思考
 * 字段（保守，对齐 AtomCode/KimiCode/dsh 三家：ARK 实测 glm-5 系
 * thinking:disabled 直接 400，能力不能一刀切）。
 */
export type ModelReasoning = {
  /** 支持的档位（含 'off' = 可关思考；不含 = always-thinking）。 */
  efforts: ThinkingEffort[]
  /** 用户未选择时的默认档（缺省 = 解析链尾 'max' 兜底）。 */
  defaultEffort?: ThinkingEffort | undefined
}

export type ProviderModel = {
  /** 模型 id（即 wire 上的 model 名）。 */
  id: string
  /** 思考能力（缺省 = 查内置 KNOWN_MODELS 表；未知 → 不支持思考字段）。 */
  reasoning?: ModelReasoning | undefined
}

/** 单个模型服务商条目。upstreamTrusted 缺省视为 true（官方/可信上游）。 */
export type ProviderConfig = {
  /** 完整 chat-completions endpoint URL。 */
  url: string
  /** API key / bearer token。 */
  apiKey?: string | undefined
  /**
   * 当前选中模型（v0.32 语义升级：多模型目录下的"选择"；单模型旧配置
   * 语义不变）。
   */
  model: string
  /**
   * 模型目录（v0.32：单服务商多模型）。缺省 = [model] 单模型目录，能力查
   * 内置表。选中 model 必须是目录成员（有 models 时由 load 校验）。
   */
  models?: ProviderModel[] | undefined
  /**
   * 当前选中模型的思考档位（undefined = 跟随模型 defaultEffort）。
   * 解析优先级：thinking（provider 级强制覆盖）> reasoningEffort（选择）
   * > defaultEffort（模型声明/内置表）> 'max'（终极缺省）。
   */
  reasoningEffort?: ThinkingEffort | undefined
  /**
   * 上游是否可信。false = 第三方中转站（非官方转发服务）→ 装配层将
   * promptInjectionDefense 置 true（系统提示词追加注入防御段）。
   * 缺省 true：信任是默认，风险由用户主动声明（opt-in）。
   */
  upstreamTrusted?: boolean | undefined
  /** 模型能力声明（可选；声明后被装配层引用，见 ModelCapabilities 注释）。 */
  capabilities?: ModelCapabilities | undefined
  /**
   * 思考强度。缺省 'max'（注入 thinking:{type:'enabled',reasoning_effort:'max'}）；
   * 'off' 注入 thinking:{type:'disabled'}。换非 DeepSeek 上游且其拒绝 thinking
   * 参数时，显式声明以免 400（参数格式来自 DeepSeek 官方 API，火山方舟同构）。
   */
  thinking?: ThinkingEffort | undefined
}

/** providers.json 顶层结构。active 指向 providers 里生效的条目。 */
export type AgentShellConfig = {
  active?: string | undefined
  providers?: Record<string, ProviderConfig> | undefined
}

/** loadProviderConfig 的返回：active 条目 + 实际加载的配置路径。 */
export type LoadedProviderConfig = {
  provider: ProviderConfig
  /** providers 里的 key（即 active 名）。 */
  name: string
  configPath: string
}

/** write 路径（upsert/delete/activate）的返回：写后的完整配置 + 路径。 */
export type WriteResult = {
  configPath: string
  config: AgentShellConfig
}

/** provider.list 的返回：配置文件全量快照（Gate provider.list 命令的回执）。 */
export type ProviderListResult = {
  exists: boolean
  configPath: string
  active: string | undefined
  providers: Record<string, ProviderConfig>
  /**
   * 派生目录（v0.32，可选——宿主 gate handler 填充；纯 config 层
   * listProviders 不填）：每条目的有效思考能力已解析（声明覆盖/内置表），
   * 前端/CLI 只渲染不推导。
   */
  catalog?: ProviderCatalogEntry[] | undefined
}

/**
 * provider.list 的派生目录条目（v0.32）：宿主已解析好有效思考能力（声明
 * 覆盖/内置表合并），前端只渲染不推导——UI 永远选不出模型不支持的档位
 * （dsh segmentsFor 语义）。
 */
export type ProviderCatalogEntry = {
  /** providers 里的 key。 */
  name: string
  /** 是否 active 条目。 */
  active: boolean
  /** 当前选中模型（provider.model）。 */
  selectedModel: string
  /** 当前选中档位（provider.reasoningEffort；undefined = 跟随 defaultEffort）。 */
  reasoningEffort: ThinkingEffort | undefined
  models: Array<{ id: string; reasoning?: ModelReasoning | undefined }>
}

/**
 * 解析 thinking 的最终档位（v0.32）。返回 undefined = 不注入任何思考字段
 * （未知且未声明的模型，保守方案）。解析链：
 * thinking（provider 级强制）> reasoningEffort（选择）> defaultEffort > 无。
 */
export type ResolvedThinking = ThinkingEffort | undefined

/**
 * provider.changed 广播的目录快照（v0.32）：宿主解析好全部有效思考能力，
 * 前端零推导（能力门控与 wire 编码同源）。
 */
export type ProviderCatalog = {
  exists: boolean
  configPath: string
  active: string | undefined
  providers: ProviderCatalogEntry[]
}
