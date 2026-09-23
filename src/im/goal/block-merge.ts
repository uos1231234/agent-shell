// v0.41 goal 模式 — G1 确定性本地合并（无 LLM、无字数上限、不会失败）。
//
// 为什么第一档压缩**不该**有提示词（计划 D10 / 原则 4）：参考实现
// context-amplifier 已用实测证明——pipeline.ts:849-852 的注释写着「L1：本地
// 合并同类项。**不调 LLM**、不查缓存、不走自报/curator。理由：PROMPT_L1 要求
// "保留完整问答 + 工具链"，是确定性结构化操作；**走 LLM 反而被模型压成短
// 摘要**」。对信息分析块，价值恰恰在正文；LLM 摘要会精确地毁掉需要保留的东西。
//
// G1 的压缩率**只来自丢掉输入材料**（原文进 raw-archive，可按戳召回）。所以
// "大材料 + 短回答"的块比例很高（80K→3K ≈ 25:1），而"短问题 + 长回答"的块
// 几乎不压（1:1）——这是准确的边界，不是缺陷。比例下界由 G2 的 N→1 提供。
//
// 输出仍是 11 字段 CuratedMemory（计划约束 7：换生产者，不换 schema）：
// `[已验证]` validateCuratedMemory 只校验字段存在性，空数组合法；
// renderEnvelopeBody 对空数组自动跳过渲染。所以本地合并产出的块能原样通过
// 既有的 appendBlock / 信封渲染 / 投影 / state_query 召回 / M3 归档全链路。

import type { CuratedMemory } from '../state-line/types.js'
import type { ConversationTurn } from '../conversation-memory.js'
import { estimateBlockTokens } from '../system-agents/drive-coordinator.js'
import type { TaskBlock } from '../system-agents/drive-coordinator.js'
import { truncateToTokens } from '../../shared/token-estimate.js'
import { GOAL_TURN_ID_PREFIX } from './types.js'

// 块尺寸口径由 drive-coordinator 的 estimateBlockTokens 统一提供（与 TaskBlock
// 类型同住一处），本模块只转发，避免两处公式漂移。
export { estimateBlockTokens }

/** 输入材料的头部定位锚上限之外的部分：原文进 raw-archive，按戳可召回。 */
const INPUT_ANCHOR_MARKER = '本轮输入材料（全文经 raw-archive 保留，按信封 #STAMP 召回）'

/** 工具动作一行摘要的上限。全文在 databus（方案 A 保留），不在信封里重复。 */
const TOOL_ACTION_MAX_CHARS = 160
/** 工具结果一行摘要的上限。同上。 */
const TOOL_RESULT_MAX_CHARS = 200

const isGoalReminder = (t: ConversationTurn): boolean =>
  t.role === 'user' && t.id.startsWith(`${GOAL_TURN_ID_PREFIX}-`)

const textOf = (content: string | readonly unknown[] | null | undefined): string => {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  return JSON.stringify(content)
}

const oneLine = (text: string, maxChars: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat
}

const firstLine = (text: string): string => {
  const nl = text.indexOf('\n')
  return (nl === -1 ? text : text.slice(0, nl)).trim()
}

/**
 * 块的最终结论 = 最后一个 content 非空的 assistant 回合正文，**逐字全量、
 * 不设上限**（D9：用户拍板删掉 conclusionMaxTokens，字数限制本质是截断信息）。
 *
 * 中间 assistant 正文（过程性推理）**不进信封**——它们是过程，最终回答应当已经
 * 吸收了其结论。这是 G1 唯一的"丢"，也是它叫**合并**而不叫复制的原因；原文
 * 逐条在 raw-archive 里，按戳可召回。
 */
export const finalConclusionOf = (turns: readonly ConversationTurn[]): string => {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i]!
    if (t.role !== 'assistant') continue
    const text = textOf(t.content).trim()
    if (text.length > 0) return text
  }
  return ''
}

/**
 * 工具链箭头表示（宿主应用 buildToolTrace 同思路）：每个 tool 回合一条
 * causal_steps。**无工具则返回 `[]`**——空数组是诚实的，编造 intent/result
 * 等于把噪音写进记忆。
 *
 * `[已验证]` 不会二次折叠：>2000 token 的工具结果早被 history-tool-table 折过
 * （history-tool-table.ts:62-65 的 `…（截断` 幂等守卫），这里看到的是已折叠
 * 形态，取首行即可。
 */
export const causalStepsOf = (
  turns: readonly ConversationTurn[],
): CuratedMemory['causal_steps'] => {
  const steps: CuratedMemory['causal_steps'] = []
  for (let i = 0; i < turns.length; i += 1) {
    const t = turns[i]!
    if (t.role !== 'tool') continue

    // intent 取前一个 assistant 正文的首行——那是发起这次调用的理由。
    let intent = ''
    for (let j = i - 1; j >= 0; j -= 1) {
      const p = turns[j]!
      if (p.role === 'assistant') {
        intent = firstLine(textOf(p.content))
        break
      }
    }

    const argsText = t.args === undefined ? '' : oneLine(JSON.stringify(t.args), TOOL_ACTION_MAX_CHARS)
    steps.push({
      intent: oneLine(intent, TOOL_ACTION_MAX_CHARS),
      tool_action: `${t.toolName ?? 'tool'}(${argsText})`,
      // 错误标记必须保留：judge 与后续轮次都要能看出这一步失败了。
      result: `${oneLine(firstLine(t.content), TOOL_RESULT_MAX_CHARS)}${t.isError === true ? '（错误）' : ''}`,
    })
  }
  return steps
}

/**
 * 输入材料锚。
 *
 * 只对**真实用户回合**取头部锚；对 `goal-` 续跑提醒返回 `[]`——提醒的内容
 * （#OBJECTIVE / #ROUND / #VERDICT / #JUDGE_REASON）已经逐项落在 task_goal /
 * next_action / status_hint 里，再抄一遍只是让信封变大。
 */
export const evidenceFragmentsOf = (
  turns: readonly ConversationTurn[],
  inputKeepTokens: number,
): CuratedMemory['evidence_fragments'] => {
  const first = turns[0]
  if (first === undefined || first.role !== 'user') return []
  if (isGoalReminder(first)) return []
  const text = textOf(first.content).trim()
  if (text.length === 0) return []
  return [{
    source: 'user',
    fragment: truncateToTokens(text, inputKeepTokens),
    relevance: INPUT_ANCHOR_MARKER,
  }]
}

export type MergeGoalBlockInput = {
  /** 由 findNextTaskBlock 定位的已关闭块（最旧优先）。 */
  block: TaskBlock
  /** goal 条件原文，逐字进 task_goal 与 working_state.current_goal。 */
  condition: string
  /** judge 的理由（或收尾事实的如实陈述），逐字进 next_action 与 remaining_work。 */
  verdictReason: string
  /**
   * 信封的 status_hint。缺省 'PENDING' = goal 轮未达成、还会续跑（not_met /
   * judge_failed 分支）。收尾分支必须显式传值，否则信封撒谎：
   * met → 'DONE'（目标已达成，该块不再有未完成工作）；
   * impossible / rounds_exhausted → 'UNKNOWN'（尝试终止，未完成项既非待办也
   * 非已完成，DONE 会把"放弃"伪装成"做完"）。
   */
  statusHint?: CuratedMemory['status_hint']
  inputKeepTokens: number
}

/**
 * G1：把一个已关闭的 goal 块确定性地合并成 11 字段 CuratedMemory。
 *
 * 纯函数、无 IO、无 LLM、不抛错（输入是 canonical 回合，全部字段都有合法空值）。
 *
 * 字段映射（计划 §5.3 表）：
 * - task_goal / working_state.current_goal ← goal 条件逐字
 * - causal_steps                          ← 工具链箭头表示（无工具则 []）
 * - evidence_fragments                    ← 真实用户输入的头部锚（提醒则 []）
 * - conclusion                            ← 最终 assistant 正文，逐字全量无上限
 * - next_action / remaining_work          ← judge 的未达成理由
 * - effective/rejected_decisions、architecture_boundaries ← [] （本地合并无从判断）
 * - status_hint                           ← input.statusHint ?? 'PENDING'（收尾分支显式传值）
 */
export const mergeGoalBlock = (input: MergeGoalBlockInput): CuratedMemory => ({
  task_goal: input.condition,
  causal_steps: causalStepsOf(input.block.turns),
  evidence_fragments: evidenceFragmentsOf(input.block.turns, input.inputKeepTokens),
  conclusion: finalConclusionOf(input.block.turns),
  next_action: input.verdictReason,
  working_state: {
    current_goal: input.condition,
    // 三个数组留空是诚实的：本地合并无从判断"哪些决策生效/被否决/有哪些架构
    // 边界"，编造等于把噪音写进长期记忆。G2（LLM 保守合并）才有能力填它们——
    // 它的提示词要求把 N 个块的 rejected_decisions 并集保留。
    effective_decisions: [],
    rejected_decisions: [],
    architecture_boundaries: [],
    // DONE 时留空是语义必然：目标已判定达成，"剩余工作"不该再装着达成理由。
    // 其余状态（PENDING / UNKNOWN）逐字保留 reason——它是"当时卡在哪"的唯一记录。
    remaining_work: input.statusHint === 'DONE' ? [] : [input.verdictReason],
  },
  status_hint: input.statusHint ?? 'PENDING',
})

export type GoalBlockTrigger = 'size' | 'watermark' | 'pressure' | 'none'

/**
 * 触发判定。**三条线**（计划 D14 / 原则 6 + C3 用户拍板 2026-09-17）：
 * - 触发 A（size）：块自身 ≥ blockMinTokens（默认 80K，D6）。处理"大块少轮"。
 * - 触发 B（watermark）：上下文 ≥ m1MinTokens（默认 200K，复用既有阈值常量，
 *   不新增）**且**块自身 ≥ floorTokens（默认 10K，v0.41 后续补丁 (a)）。
 *   处理"小块多轮"——若只有 A，30K × 20 轮的形状永不触发，而跨越
 *   驱动又被 D7 互斥关掉了，上下文会无界增长直到撞 1M token guard。
 *   floorTokens 过滤掉"信封固定开销 > 小块本体"的净膨胀场景（探针实测
 *   5K 纯回答块 ratio=0.84x 膨胀）。
 * - 触发 C（pressure）：上下文已进 M3 层（≥ m3MinTokens）。**忽略两条尺寸线**
 *   强制合并一个块——goal 模式下跨越驱动整段关闭，M3 之上只有 G1/G2 在出货，
 *   小块也要排干。这里刻意接受 (a) 的净膨胀：900K 之上一个 5K 块涨到 8K 与
 *   "上下文停在 900K 不动"相比不是同一量级的风险，且合并后的信封下一轮就进
 *   G2 的 N→1 区间。
 *
 * A 优先（它更精确地指出"这一块值得压"），其次 B，C 只兜底：三者同时满足时
 * 报 'size'。
 *
 * 只返回 trigger 而不额外返回布尔 fire：`fire` 与 `trigger !== 'none'` 完全
 * 等价，两个独立字段会让调用方在 `if (!fire)` 之后拿到的 trigger 仍是含
 * 'none' 的宽类型、无法直接放进 GoalEvent。判 'none' 即判不触发，之后类型
 * 自动窄化为 'size' | 'watermark' | 'pressure'。
 */
export const shouldMergeGoalBlock = (input: {
  blockTokens: number
  contextTokens: number
  blockMinTokens: number
  /** v0.41 后续补丁 (a)：watermark 线的最小块门槛，块 < 此值时 watermark 不触发。 */
  floorTokens: number
  m1MinTokens: number
  /** C3 压力阀：调用方按 classifyMemoryLayer(...)==='M3' 算好传入（必需字段，tsc 强制表态）。 */
  pressure: boolean
}): GoalBlockTrigger => {
  if (input.blockTokens >= input.blockMinTokens) return 'size'
  // watermark 线加 floor 前置门：块太小时信封固定开销 > 块本体，合并反而膨胀。
  if (input.contextTokens >= input.m1MinTokens && input.blockTokens >= input.floorTokens) return 'watermark'
  if (input.pressure) return 'pressure'
  return 'none'
}
