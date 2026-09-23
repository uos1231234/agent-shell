// v0.11: define_subagent — lets the working agent (or a user) write a
// declarative sub-agent config at runtime. toolRefs are validated against the
// registry.
//
// v0.11.3 P0-2: validation (including toolPolicy) is owned by
// SubAgentRegistry.register() — the SubAgentRegistry carries the policy from
// its constructor. This tool only assembles the raw config and delegates to
// register(); the redundant direct validateSubAgentConfig call was removed so
// the policy extension point is no longer dead code.
//
// v0.29: `ref` — 引用用户配置好的子代理（~/.databus/agents/<name>.json，
// 启动时 loadFromDisk 已入内存）。ref 提供时：
//   - name/systemPrompt/toolRefs 变为可选，缺省取被引用配置的值（name 缺省
//     即 ref 同名）；显式提供则覆盖。
//   - ref 指向不存在的配置时抛错，错误信息枚举可用清单（顺带解决"AI 不知道
//     有哪些用户子代理"的发现缺口）。
// run_subagent 本就按 name 查找，define 只是把用户配置登记进会话可引用集合
// （并可选覆盖），不复制配置文本——磁盘用户配置的单一事实源仍是
// ~/.databus/agents/（v0.30 起 AI 内联定义不再落盘，见下）。
//
// v0.30（用户拍板 2026-09-09）：AI 定义的子代理是**任务导向、会话级生命周期**。
//   - 定义只进会话内存（createdBy: 'agent'），**不落盘**——会话销毁即自然
//     回收，不会在 ~/.databus/agents/ 堆积 AI 垃圾，也不会污染用户面板。
//   - 长期使用的子代理由用户自己配置（设置面板 upsert / 手写 json 落盘），
//     或上线前预置常用款。
//   - 会话内可多次 run_subagent 复用；跨会话需 AI 重新定义或用户转正配置。

import type { SystemTool } from '../../shell/registry.js'
import type { ToolRegistry } from '../../shell/registry.js'
import type { ShellConfig } from '../../shell/config.js'
import { DEFAULT_CONFIG } from '../../shell/config.js'
import { wrapTool, toSchema, reasonField } from './helpers.js'
import { SubAgentRegistry, type SubAgentConfig } from '../sub-agent/index.js'
import { resolveCallerToolRefs } from '../sub-agent/caller-scope.js'

/**
 * 模型能力声明（v0.30 用户拍板 2026-09-09）：宿主装配层把 providers.json
 * capabilities 传进来，schema 描述据此动态拼接真实上限——AI 定义子代理时
 * 不再盲配预算（实测案例：AI 把 maxTokens 当输出预算配 12000，而 token
 * guard 按请求总量计，输入材料一进来即 trip）。未声明时回落通用文案。
 */
export type ModelCapsHint = { maxInputTokens?: number; maxOutputTokens?: number }

const configDescription = (caps?: ModelCapsHint): string => {
  const inputPart = caps?.maxInputTokens !== undefined
    ? ` Host model max input: ${caps.maxInputTokens} tokens.`
    : ''
  const outputPart = caps?.maxOutputTokens !== undefined
    ? ` Host model max output: ${caps.maxOutputTokens} tokens.`
    : ''
  return (
    'Optional guard threshold overrides. IMPORTANT semantics: maxTokens is the '
    + 'TOTAL per-request token budget (system prompt + input material + conversation '
    + 'history including tool round-trips) — it is NOT an output cap; a guard trip '
    + 'discards all sub-agent work. Size it comfortably ABOVE your expected input '
    + 'material, or omit to inherit the host default.'
    + inputPart + outputPart
  )
}

export const createDefineSubagentTool = (
  subAgentRegistry: SubAgentRegistry,
  registry: ToolRegistry,
  modelCaps?: ModelCapsHint,
): SystemTool => ({
  name: 'define_subagent',
  description:
    'Define a new sub-agent by writing a declarative config, or reference a user-configured '
    + 'sub-agent (ref field). The sub-agent can be invoked later with run_subagent. '
    + 'toolRefs must name tools already registered in the shared registry. '
    + 'Privilege non-amplification: when invoked from inside another sub-agent, the new '
    + 'sub-agent may only be given tools the CALLER already has (a subset of the caller\'s '
    + 'tools); from the top level there is no extra restriction. '
    + 'The definition lives for THIS session only (it is not persisted to disk); '
    + 'define it again in a new session, or ask the user to configure it permanently.',
  parameters: toSchema({
    ref: {
      type: 'string',
      description:
        'Optional: name of a user-configured sub-agent (~/.databus/agents/<name>.json) to reference. '
        + 'When set, name/systemPrompt/toolRefs may be omitted (they default to the referenced config); '
        + 'provided values override the referenced ones. Use a non-existent ref with no name to list available ones.',
    },
    name: {
      type: 'string',
      description: 'Unique sub-agent name (used as agentId and mailbox address); defaults to ref when ref is set',
    },
    systemPrompt: {
      type: 'string',
      description: 'System prompt for the sub-agent (defaults to the referenced config when ref is set)',
    },
    toolRefs: {
      type: 'array',
      items: { type: 'string' },
      description: 'Tool names from the shared registry that the sub-agent may call (defaults to the referenced config when ref is set)',
    },
    config: {
      type: 'object',
      description: configDescription(modelCaps),
    },
    reason: reasonField,
  }, ['reason']),
  execute: wrapTool('define_subagent', async (args, ctx) => {
    const a = args as {
      ref?: string
      name?: string
      systemPrompt?: string
      toolRefs?: string[]
      config?: Partial<ShellConfig>
      reason: string
    }

    let base: SubAgentConfig | undefined
    if (a.ref !== undefined) {
      base = subAgentRegistry.get(a.ref)
      if (base === undefined) {
        const available = subAgentRegistry.list().join(', ') || '(none)'
        throw new Error(
          `ref "${a.ref}" not found among user-configured sub-agents; available: ${available}. `
          + `Use one of the available names above or define inline without ref.`,
        )
      }
    }

    if (base === undefined) {
      // 原语义：内联定义，三个字段必填。
      if (a.name === undefined || a.systemPrompt === undefined || a.toolRefs === undefined) {
        throw new Error(
          'define_subagent: without ref, name, systemPrompt and toolRefs are all required',
        )
      }
    }

    const cfg: SubAgentConfig = {
      name: a.name ?? base!.name,
      systemPrompt: a.systemPrompt ?? base!.systemPrompt,
      toolRefs: a.toolRefs ?? base!.toolRefs,
      // v0.39: ref 路径继承被引用配置的 toolPolicy 声明——"引用"语义要求
      // 行为连续（此前新 cfg 丢掉 base 的声明，等于 AI 一引用就静默放宽）。
      // AI 不提供 policy 参数：policy 只能在 toolRefs 白名单内二次筛选，
      // 无法放大（特权不放大由 toolRefs 子集校验保证，见下）。
      ...(base?.toolPolicy !== undefined ? { toolPolicy: base.toolPolicy } : {}),
      // v0.30（用户拍板 2026-09-09）：AI 定义的子代理标记为任务导向——
      // 只进会话内存，不落盘（会话销毁即回收）。
      createdBy: 'agent',
    }
    if (a.config !== undefined) {
      // v0.30: 校验上限取 min(harness guard, 模型 maxInputTokens)——AI 把
      // maxTokens 配得比模型上下文还大时，请求会在服务商侧被截断/拒绝，
      // guard 却永远不触发（形同虚设）。这里在定义期就拒绝。
      const ceiling = modelCaps?.maxInputTokens !== undefined
        ? Math.min(DEFAULT_CONFIG.maxTokens, modelCaps.maxInputTokens)
        : DEFAULT_CONFIG.maxTokens
      if (a.config.maxTokens !== undefined && a.config.maxTokens > ceiling) {
        throw new Error(
          `define_subagent: config.maxTokens ${a.config.maxTokens} exceeds the host model's `
          + `max input tokens (${ceiling}). The token guard measures the total request size `
          + '(input material + history), not output — size the budget above your input material.',
        )
      }
      cfg.config = a.config
    }
    // v0.39 特权不放大（用户拍板 2026-09-12）：AI 创造子代理时只能授权
    // 调用者自己已经拥有的工具。顶层（工作代理）不受限——它的工具面就是
    // 共享 registry 全集，validateSubAgentConfig 的 Unknown-ref 校验已覆盖；
    // 嵌套调用（子代理里再 define）时，toolRefs 必须是调用者白名单的子集，
    // 否则一个只读子代理就能借"造孙代理"洗出写权限。反解不出调用者的
    // 工具集（fail closed，空集）时一切 ref 都算违规。
    const callerToolRefs = resolveCallerToolRefs(ctx, subAgentRegistry)
    if (callerToolRefs !== undefined) {
      const violations = cfg.toolRefs.filter((ref) => !callerToolRefs.includes(ref))
      if (violations.length > 0) {
        throw new Error(
          'define_subagent: privilege non-amplification — a sub-agent may only be given '
          + `tools its caller already has. Beyond the caller's surface: ${violations.join(', ')}. `
          + `Caller tools: ${callerToolRefs.join(', ') || '(none resolvable)'}`
          + (a.ref !== undefined
            ? ` (the referenced config "${a.ref}" was not built inside this caller's boundary)`
            : ''),
        )
      }
    }
    // v0.30: 不落盘（无 diskDir）——AI 定义 = 会话内存资产，会话销毁自然回收。
    await subAgentRegistry.register(cfg)
    return `Defined session-scoped sub-agent '${cfg.name}' with tools: ${cfg.toolRefs.join(', ') || '(none)'}`
  }),
})