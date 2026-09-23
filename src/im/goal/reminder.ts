// v0.41 goal 模式 — 续跑提醒构造（纯函数，无 IO）。
//
// 提醒是一条 role:'user' 的 canonical 回合，由 loop 的 beforeComplete hook
// 返回、loop 负责 append + persist。它经既有 history 投影（loop.ts:244）自动
// 上 wire，compose 层零改动。
//
// 格式与压缩信封的 # 标记族一致（drive-coordinator.ts:244-260 的
// #STAMP/#LAYER/#STATUS/#NOTE/#END_BLOCK），让模型看到的两种 harness 生成
// 回合是同一种视觉语言。

import type { GoalVerdictResult } from './types.js'

/**
 * 信封标记族的行首匹配。用于剥掉 judge 输出里抄进来的标记行。
 *
 * 这不是防御性代码，是一个有实证的失败模式：参考实现 context-amplifier 的
 * stripBlockMarkers（pipeline.ts:595-603）注释写着「压缩模型常把
 * #STAMP/#STATUS 抄进输出，不去重会在同一个块里出现两遍，**模型可能读到
 * 矛盾的 #STATUS**」。judge 的 reason 同样是 LLM 产出、同样会被嵌进标记块。
 *
 * 只剥 judge 的 reason，不剥用户的 condition：condition 是用户亲手写的
 * （§6.16 的信任边界内），且 D23 要求逐字重述——改它反而违背拍板。
 */
const ENVELOPE_MARKER_LINE =
  /^\s*#(?:STAMP|LAYER|STATUS|NOTE|LINEAGE|END_BLOCK|GOAL_CONTINUATION|OBJECTIVE|ROUND|VERDICT|JUDGE_REASON|END_GOAL)\b.*$/gim

const stripMarkerLines = (text: string): string =>
  text.replace(ENVELOPE_MARKER_LINE, '').replace(/\n{3,}/g, '\n\n').trim()

/**
 * judge 未跑成时的 #NOTE 措辞必须与"判定为未达成"区分开——否则模型会把一个
 * 根本没发生的裁决当成真实反馈去纠正方向（D15 的"如实写失败"要求，同样适用
 * 于面向模型的文本，不只面向用户）。
 */
const NOTE_NOT_MET =
  '本回合由 harness 生成，不是用户发言。目标尚未达成，请继续推进；'
  + '不要重复已完成的步骤，不要重新陈述目标。'
  + '若细节已被压缩或换出：查 mailbox 的换出墓碑（含戳与召回方式），'
  + '或 state_query({rawSummaryStamps:[…]})/ask_recall 取回原文——'
  + '“窗口里没有 ≠ 不存在”，不要凭印象省略日期、文档 ID 或条文序号。'

const NOTE_JUDGE_FAILED =
  '本回合由 harness 生成，不是用户发言。本轮的完成判定**未能跑成**（原因见 #JUDGE_REASON），'
  + '所以无法确认目标是否达成——这不是"判定你没做完"。请按目标继续推进；'
  + '如果你确信已完成，请给出可验证的证据（文件内容、命令输出、具体数值），不要只重复结论。'
  + '若细节已被压缩或换出：查 mailbox 的换出墓碑（含戳与召回方式），'
  + '或 state_query({rawSummaryStamps:[…]})/ask_recall 取回原文——不要凭印象省略日期、文档 ID 或条文序号。'

export const buildGoalReminder = (input: {
  condition: string
  /** 从 1 起算的当前分歧循环序号（即本次续跑是第几次）。 */
  round: number
  maxRounds: number
  verdict: GoalVerdictResult
}): string => {
  const note = input.verdict.verdict === 'judge_failed' ? NOTE_JUDGE_FAILED : NOTE_NOT_MET
  return [
    '#GOAL_CONTINUATION',
    // #OBJECTIVE 每轮逐字重述是承重设计（D23）：原始用户回合所在的块会被压缩
    // 逐出，goal 条件靠提醒活在 canonical 的**不可关闭尾部**——最后一个提醒
    // 之后的跨度没有右边界，findNextTaskBlock 返回 undefined，永不被压。
    `#OBJECTIVE ${input.condition}`,
    `#ROUND ${input.round}/${input.maxRounds}`,
    `#VERDICT ${input.verdict.verdict}`,
    `#JUDGE_REASON ${stripMarkerLines(input.verdict.reason)}`,
    `#NOTE ${note}`,
    '#END_GOAL',
  ].join('\n')
}
