// ask_user 回答组装（纯函数，QuestionDialog 的提交逻辑唯一事实源）。
//
// 对齐 deepseek 提问 composer 语义：选项勾选与"其他回答"输入并存，
// 单选下 custom 覆盖 selected（custom 赢），多选下 selected + custom 合并。
// 组装结果落进既有回包契约 answers: (string | string[])[]——零 gate 改动。

import type { AskQuestion } from '../../api/contract'

export type AskDraft = { selected: number[]; custom: string }

export const emptyDraft = (): AskDraft => ({ selected: [], custom: '' })

/**
 * 每题草稿 → 完整 answers 数组（与 questions 一一对应）。
 * 任一题既无勾选又无输入 → null（deepseek 的"请选择回答"校验：不完整不可提交）。
 */
export const buildAskAnswers = (
  questions: readonly AskQuestion[],
  drafts: readonly AskDraft[],
): (string | string[])[] | null => {
  const answers: (string | string[])[] = []
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!
    const d = drafts[i] ?? emptyDraft()
    const custom = d.custom.trim()
    const labels = (q.options ?? [])
      .filter((_, idx) => d.selected.includes(idx))
      .map((o) => o.label)
    if (q.multiSelect === true) {
      if (labels.length > 0) answers.push(custom.length > 0 ? [...labels, custom] : labels)
      else if (custom.length > 0) answers.push(custom)
      else return null
    } else {
      // 单选（含选项）或自由文本：custom 优先于 selected
      if (custom.length > 0) answers.push(custom)
      else if (labels.length > 0) answers.push(labels[0]!)
      else return null
    }
  }
  return answers
}
