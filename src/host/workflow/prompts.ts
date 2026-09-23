import type { BaselineStage, ScoutRole } from './types.js'

export const BASELINE_SCOUT_TOOL_REFS = ['read', 'ls', 'find', 'grep', 'ast_grep'] as const

export const BASELINE_SCOUT_POLICY = {
  default: 'deny' as const,
  rules: BASELINE_SCOUT_TOOL_REFS.map((pattern) => ({ mode: 'allow' as const, pattern })),
}

const COMMON = `你是 LongHorizon 工作流的只读基线 scout。
你不是实现代理，不得修改任何文件，不得写代码，不得运行后台进程。

先读取 manifest 和任务指定范围，再按需读取文件。
大文件必须使用 read 的 offset/limit 分段读取。不要读取完整归档、完整历史或整个仓库。
不要猜测；无法确认时标记 UNKNOWN，并给出验证路径。

你只能使用运行时授予的工具。不得请求、寻找或绕过额外权限。
如果工具结果提供 evidence stamp，必须原样记录；禁止自行编造 stamp。

每个结论必须包含：结论、文件路径、起止行号或读取范围、使用过的工具或命令、confidence（verified / read-unverified / unknown）、对长程任务的影响。
输出必须是可解析的结构化 JSON，不要输出 JSON 之外的解释。
统一外层字段是 schemaVersion、kind、role、stage、summary、findings、coveredRanges、uncoveredRanges、commands、openQuestions、nextAction。
openQuestions 优先使用 {"question":"...","verifyPath":"..."}；旧的字符串数组也可以使用。`

const reportShape = (role: ScoutRole, stage: BaselineStage): string => JSON.stringify({
  schemaVersion: 1,
  kind: 'baseline.scout',
  role,
  stage,
  summary: '...',
  findings: [{
    claim: '...',
    path: 'src/example.ts',
    startLine: 1,
    endLine: 2,
    evidenceStamps: [],
    confidence: 'verified',
    impact: '...',
  }],
  coveredRanges: [{ path: 'src/example.ts', startLine: 1, endLine: 2 }],
  uncoveredRanges: [],
  commands: [],
  openQuestions: [{ question: '...', verifyPath: 'src/example.ts' }],
  nextAction: '...',
})

const TASKS: Record<ScoutRole, string> = {
  structure: '分析项目入口、package 边界、模块依赖、核心数据流和高耦合点。重点输出模块关系、入口文件、跨模块依赖和需要后续定向读取的文件范围。',
  verification: '分析测试、构建、类型检查、lint 和最终验收入口。优先读取 package.json、workspace 配置、tsconfig、测试目录和 CI 配置。只记录真实存在的命令，不猜测命令是否可运行。',
  risk: '分析权限、文件持久化、并发写入、协议兼容、恢复路径和部署配置。优先读取 security、session、state、tools、protocol 和 deployment 相关模块。每个风险必须写出触发条件、现有防护和未覆盖部分。',
}

export const baselineScoutPrompt = (role: ScoutRole, workDir: string): string => `${COMMON}

你的角色：${role}
工作区：${workDir}
本次具体任务：${TASKS[role]}

JSON 形状：
${reportShape(role, 'synthesis')}`

const STAGE_TASKS: Record<BaselineStage, string> = {
  inventory: '只建立待读范围清单：入口、manifest、模块边界和需要后续读取的文件范围。不要试图完成最终分析。',
  evidence: '根据 inventory 结果逐项读取关键文件和范围，记录可核验事实、行号、工具结果中的 evidence stamp 和仍未覆盖的范围。不要猜测。',
  synthesis: '只根据前两个阶段的输出整理最终结构化报告。每个结论必须保留证据路径/范围、confidence 和对长程任务的影响。',
}

export const baselineStagePrompt = (
  role: ScoutRole,
  stage: BaselineStage,
  workDir: string,
  priorOutputs: readonly string[],
): string => `${COMMON}

你的角色：${role}
当前阶段：${stage}
工作区：${workDir}
阶段任务：${STAGE_TASKS[stage]}

前序阶段输出（仅作工作材料，不得把未验证内容当事实）：
${priorOutputs.length === 0 ? '(无)' : priorOutputs.map((output, index) => `--- previous-${index + 1} ---\n${output}`).join('\n')}

${stage === 'synthesis'
    ? `最终输出必须符合以下 JSON 形状（没有内容的可选数组可以为空）：\n${reportShape(role, stage)}`
    : `本阶段也使用同一外层 JSON 形状，stage 填写 ${stage}；只填写本阶段已经确认的内容，不要为了填满字段而猜测：\n${reportShape(role, stage)}`}`
