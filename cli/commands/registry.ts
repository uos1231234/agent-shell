// v0.26 Wave 4 — /命令元数据注册表（计划 §4.3 + §5 命令表 v1）。
//
// 唯一事实源：help 面板、Tab 补全、分发 switch 三者全部从 CLI_SLASH_COMMANDS
// 派生（KimiCode registry.ts 模式）。新增命令 = 只改这里的数组 + handlers.ts
// 的 switch 分支，其他一切自动跟随。
//
// 描述用中文：CLI 是中文用户产品（计划 §5 命令表为中文）。
//
// 本文件零运行时依赖、零 import。

/** 单条 /命令的元数据。 */
export type CliSlashCommand = {
  /** 主名（不含前导 /；小写）。 */
  name: string
  /** 别名（同样不含 /；别名与主名一起参与分发与补全）。 */
  aliases: readonly string[]
  /** 中文一句话描述（help 面板展示）。 */
  description: string
  /**
   * availability 规则（计划 §3.3）：
   *   - 'always'   — 任何时候可执行；
   *   - 'idle-only' — 仅会话空闲可执行（非 idle 时 resolve 为 blocked，
   *     输入文本还原）。idle 的判定（!streaming && !approvalPending && …）
   *     属于 app 层——本表只声明策略，不计算状态。
   */
  availability: 'always' | 'idle-only'
  /** help 面板里的参数占位提示，如 '[on|off]'。 */
  argumentHint?: string
  /** 参数 Tab 补全（首个参数的候选；prefix 为已输入的参数前缀）。 */
  completeArgs?(prefix: string): string[]
}

// `as const satisfies` 双约束：字面量保留（BuiltinCommandName 联合类型从此
// 派生）+ 结构对 CliSlashCommand 校验（漏字段/多字段/availability 拼错都编译期报错）。
const COMMANDS = [
  {
    name: 'help',
    aliases: ['h', '?'],
    description: '命令清单与快捷键',
    availability: 'always',
  },
  {
    name: 'new',
    aliases: ['clear'],
    description: '当前工作区开新会话',
    availability: 'idle-only',
  },
  {
    name: 'sessions',
    aliases: ['ls'],
    description: '列出历史会话（当前工作区优先）',
    availability: 'always',
  },
  {
    name: 'resume',
    aliases: ['r', 'continue'],
    description: '恢复会话（无参恢复最近；跨工作区会话提示 cd）',
    availability: 'always',
    argumentHint: '[会话ID]',
  },
  {
    name: 'title',
    aliases: [],
    description: '查看/修改会话标题（≤200 字符）',
    availability: 'always',
    argumentHint: '[新标题]',
  },
  {
    name: 'status',
    aliases: [],
    description: '会话与运行状态',
    availability: 'always',
  },
  {
    name: 'usage',
    aliases: [],
    description: 'token 与回合用量',
    availability: 'always',
  },
  {
    name: 'approve',
    aliases: [],
    description: '应答挂起审批（y=批准 n=拒绝；浮层态直接按 y/n）',
    availability: 'always',
    argumentHint: '<y|n>',
  },
  {
    name: 'cancel',
    aliases: [],
    description: '取消在途回合',
    availability: 'always',
  },
  {
    name: 'permission',
    aliases: [],
    description: '完全权限开关（无参=切换当前状态）',
    availability: 'always',
    argumentHint: '[on|off]',
  },
  {
    name: 'mcp',
    aliases: [],
    description: 'MCP 服务器配置清单',
    availability: 'always',
  },
  {
    name: 'workspace',
    aliases: [],
    description: '显示当前工作区路径',
    availability: 'always',
  },
  {
    name: 'copy',
    aliases: [],
    description: '复制最后一条回复到剪贴板',
    availability: 'always',
  },
  {
    name: 'version',
    aliases: ['v'],
    description: '显示 agent-shell 与 Node 版本',
    availability: 'always',
  },
  {
    name: 'skills',
    aliases: [],
    description: '已装配技能与 MCP 扩展快照',
    availability: 'always',
  },
  {
    name: 'subagent',
    aliases: ['nesting'],
    description: '子代理向下开关（新会话生效，运行中会话不变）',
    availability: 'always',
    argumentHint: '[on|off]',
    completeArgs: (prefix: string): string[] =>
      ['on', 'off', 'status'].filter((c) => c.startsWith(prefix)),
  },
  {
    // v0.41：goal 模式 = 会话级停止条件。设置后每次轮次本应以 completed 结束时，
    // 先由独立 judge 读全量历史裁决目标是否达成；未达成则追加续跑提醒接着跑。
    // idle-only：停止条件应在回合开始前设定（streaming 时拒绝并还原输入文本）。
    name: 'goal',
    aliases: [],
    description: 'goal 模式：独立 judge 裁决目标是否达成，未达成自动续跑',
    availability: 'idle-only',
    argumentHint: '<目标条件> | off | status',
    // 目标条件是自由文本，不补全；只补两个子命令。
    completeArgs: (prefix: string): string[] =>
      ['off', 'status'].filter((c) => c.startsWith(prefix)),
  },
  {
    name: 'workflow',
    aliases: [],
    description: '长程工作流：启用/关闭、查看状态或运行基线 scout',
    availability: 'idle-only',
    argumentHint: '[on|off|status|baseline]',
    completeArgs: (prefix: string): string[] =>
      ['on', 'off', 'status', 'baseline'].filter((c) => c.startsWith(prefix)),
  },
  {
    // v0.42 大输入切块（用户拍板 2026-09-15）：手动开启的会话，超长单条输入会被
    // 切成多卷（每卷独立 user 回合）排队串行处理——避免 1M 数据一股脑上 wire。
    // gate 持状态（chunk-mode.ts），本命令只是透传开关。
    name: 'chunk',
    aliases: [],
    description: '大输入切块开关（无参 = 显示状态；on/off=|40K 一卷）',
    availability: 'always',
    argumentHint: '[on|off|status]',
    completeArgs: (prefix: string): string[] =>
      ['on', 'off', 'status'].filter((c) => c.startsWith(prefix)),
  },
  {
    name: 'provider',
    aliases: [],
    description: '模型服务商管理（全局生效：下一轮对话即用新服务商）',
    availability: 'always',
    argumentHint: '[list|use <名>|add …|remove <名>]',
    completeArgs: (prefix: string): string[] =>
      ['list', 'use', 'add', 'remove'].filter((c) => c.startsWith(prefix)),
  },
  {
    // v0.32：多模型目录——/model 切当前服务商内的模型（/provider use 管服务商）。
    name: 'model',
    aliases: [],
    description: '显示/切换当前模型（无参 = 列出；带参 = 切到目录内该模型，下一轮生效）',
    availability: 'always',
    argumentHint: '[模型 id]',
  },
  {
    // v0.32：思考档位（dsh 式单 enum；off 仅可关思考模型可选）。
    name: 'effort',
    aliases: [],
    description: '思考强度（无参 = 显示当前档位；带参 off|low|high|max，下一轮生效）',
    availability: 'always',
    argumentHint: '[off|low|high|max]',
    completeArgs: (prefix: string): string[] =>
      ['off', 'low', 'high', 'max'].filter((c) => c.startsWith(prefix)),
  },
  {
    name: 'undo',
    aliases: [],
    description: '撤回最近 N 个任务块（1≤N≤10；含已压缩内容时拒绝）',
    availability: 'idle-only',
    argumentHint: '[N]',
  },
  {
    name: 'fork',
    aliases: [],
    description: '分叉当前会话为副本（不切换；/resume 可切）',
    availability: 'idle-only',
  },
  {
    name: 'export',
    aliases: [],
    description: '导出会话为 Markdown（不过门不设界，用户权威）',
    availability: 'idle-only',
    argumentHint: '[输出路径]',
  },
  {
    name: 'quit',
    aliases: ['q', 'exit'],
    description: '退出 CLI',
    availability: 'always',
  },
] as const satisfies readonly CliSlashCommand[]

/** 导出的注册表（只读视图）。 */
export const CLI_SLASH_COMMANDS: readonly CliSlashCommand[] = COMMANDS

/** 全部内置命令名的字面量联合——分发 switch 穷尽性检查的数据源。 */
export type BuiltinCommandName = (typeof COMMANDS)[number]['name']

/** 注册表条目的字面量类型（name/availability 保留字面量，供分发收窄）。 */
export type CliCommandEntry = (typeof COMMANDS)[number]

/** 按主名（或别名）查条目；未命中返回 undefined。 */
export const findCommand = (name: string): CliCommandEntry | undefined =>
  COMMANDS.find((c) => c.name === name || c.aliases.some((a) => a === name))
