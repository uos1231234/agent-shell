/**
 * Static prompt section builder — v0.19 D5/D9/D10
 *
 * Builds the static system prompt from template + registry tool listing.
 * Dynamic sections ({dynamic_sections}) are preserved for ContextInjector.
 */

import type { PromptMode } from './types.js'
import {
  selectPromptTemplate,
  FULL_PROMPT_INJECTION_DEFENSE,
  MINIMAL_PROMPT_INJECTION_DEFENSE,
  GOAL_COMPRESSION_SECTION,
} from './static-prompt.js'
import type { ToolRegistry } from '../../shell/registry.js'

export function buildStaticPrompt(opts: {
  mode: PromptMode
  agentName: string
  registry: ToolRegistry
  /**
   * v0.37: model id for family routing. In 'full' mode selectPromptTemplate
   * fills both slot sections — persona and workflow; in 'minimal' mode
   * (v0.39) it fills the workflow slot only, so sub-agents get the
   * family-tuned action discipline while their identity stays anchored by
   * cfg.systemPrompt. Every other section is shared by all families and
   * cannot be affected by routing.
   * Omitted → the base persona and workflow sections are used.
   */
  modelId?: string
  toolingContent?: string
  /**
   * 提示词注入防御开关。API 上游为第三方中转站（非官方转发服务）
   * 时置 true，向系统提示词追加注入防御段；默认 false（官方上游
   * 或自托管时不必牺牲可用性）。
   */
  promptInjectionDefense?: boolean
  /**
   * v0.40: 委托授权（嵌套）状态。true → FULL 在人格段之后注入委托授权段
   * （授权声明 + 树规则），MINIMAL 把嵌套禁止行换成委托教学；false/缺省 →
   * FULL 不注入、MINIMAL 保留禁止行。调用方必须传运行时实际授予的判定
   * （主代理 = 开关；子代理 = toolRefs + effectiveToolPolicy）——提示词
   * 不得声称运行时拒绝的能力。
   */
  delegationAuthorization?: boolean
  /**
   * v0.25: 暴露给工作代理的系统工具白名单。提供时 tooling_section 的
   * 工具清单只列这些 ref（与 buildLoopOptions 的 systemToolRefs 同源——
   * 提示词宣传 = 模型实际拿到）；ref 在 registry 中不存在时跳过。
   * 未提供时保持现状：全量 listSystemTools()。
   */
  exposedSystemToolRefs?: readonly string[]
  /**
   * 当前工作区绝对路径。提供时替换模板里的 {work_dir} 占位符
   * （工作区 = 权限边界，LLM 需要知道它才能遵守"在指定工作区工作"）；
   * 未提供时移除占位符行，避免把字面 {work_dir} 暴露给模型。
   */
  workDir?: string
  /**
   * v0.41: goal 模式激活时，替换 `# Context Compression & Recall` 段为
   * goal 模式专用文本（G1/G2 确定性压缩 + `#OBJECTIVE` 目标锚点指引）。
   * 仅 full 模式有效；minimal/none 模式忽略。
   */
  goal?: boolean
}): string {
  let template = selectPromptTemplate(opts.mode, opts.modelId, opts.delegationAuthorization)

  let result = template.replace(/\{agent_name\}/g, opts.agentName)

  // 工作区路径：占位符替换（双保险之一：静态模板）。workDir 缺省时整行
  // 移除——库层不强制工作区，但宿主必须传（权限边界，v0.25 拍板语义）。
  // \r?\n? 兼容 CRLF 落盘（autocrlf clone 场景），避免残留空行。
  if (opts.workDir) {
    result = result.replace(/\{work_dir\}/g, opts.workDir)
  } else {
    result = result.replace(/^.*\{work_dir\}.*\r?\n?/gm, '')
  }

  if (opts.promptInjectionDefense) {
    if (opts.mode === 'full') result += FULL_PROMPT_INJECTION_DEFENSE
    else if (opts.mode === 'minimal') result += MINIMAL_PROMPT_INJECTION_DEFENSE
    // none 模式无可注入对象，忽略开关
  }

  if (result.includes('{tooling_section}')) {
    const tooling = opts.toolingContent
      ?? buildToolingSection(opts.registry, opts.mode, opts.exposedSystemToolRefs)
    result = result.replace('{tooling_section}', tooling)
  }

  // v0.41: goal 模式替换压缩段——前提：使用方法不同（G1/G2 确定性，模型不需
  // 主动触发），精确微调。正则锚点：从 `# Context Compression & Recall` 到
  // `# 记忆管理` 之前（两个标题都是我方固定文本，不存在 LLM 变异）。
  if (opts.goal && opts.mode === 'full') {
    result = result.replace(
      /# Context Compression & Recall[\s\S]*?(?=\n# 记忆管理)/,
      GOAL_COMPRESSION_SECTION.trimStart(),
    )
  }

  // {dynamic_sections} is preserved for ContextInjector at runtime
  return result
}

function buildToolingSection(registry: ToolRegistry, mode: PromptMode, exposed?: readonly string[]): string {
  if (mode === 'minimal' || mode === 'none') return ''

  // v0.25: exposed 提供时只列白名单 ref（逐个 getSystemTool 取 name +
  // description，ref 不存在就跳过）；未提供时保持现状——全量 listSystemTools()。
  const toolNames = exposed ?? registry.listSystemTools()
  const mcpMetas = registry.listMCPServerMetas()
  const skillMetas = registry.listLoadableSkillMetas()

  const lines = ['你可以使用以下工具完成任务：']
  for (const name of toolNames) {
    const tool = registry.getSystemTool(name)
    if (tool) lines.push(`- ${name}：${tool.description}`)
  }
  if (mcpMetas.size > 0 || skillMetas.size > 0) {
    lines.push('')
    lines.push('使用 load_tools 工具按需加载 MCP server 和 skill 的工具定义。')
    lines.push('可用的 MCP server 和 skill 列表见动态注入的上下文。')
  }
  return lines.join('\n')
}
