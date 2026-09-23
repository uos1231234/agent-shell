// ask-answers 纯函数单测：buildAskAnswers 的 deepseek 对齐语义——
// 单选 custom 覆盖 selected、多选 selected+custom 合并、空题返回 null（不可提交）。

import { describe, expect, it } from 'vitest'
import { buildAskAnswers, emptyDraft, type AskDraft } from '../src/components/overlays/ask-answers'
import type { AskQuestion } from '../src/api/contract'

const d = (selected: number[], custom = ''): AskDraft => ({ selected, custom })
const opts = [
  { label: 'PostgreSQL' },
  { label: 'MySQL', description: '关系库' },
  { label: 'SQLite' },
]

describe('buildAskAnswers', () => {
  it('单选：勾选 → label 字符串', () => {
    const qs: AskQuestion[] = [{ question: '用哪个库？', options: opts }]
    expect(buildAskAnswers(qs, [d([1])])).toEqual(['MySQL'])
  })

  it('单选：custom 覆盖勾选（deepseek：custom 赢）', () => {
    const qs: AskQuestion[] = [{ question: '用哪个库？', options: opts }]
    expect(buildAskAnswers(qs, [d([1], '  用 Oracle  ')])).toEqual(['用 Oracle'])
  })

  it('多选：勾选 → label 数组；custom 追加合并', () => {
    const qs: AskQuestion[] = [{ question: '要哪些？', options: opts, multiSelect: true }]
    expect(buildAskAnswers(qs, [d([0, 2])])).toEqual([['PostgreSQL', 'SQLite']])
    expect(buildAskAnswers(qs, [d([0], '加上 Redis')])).toEqual([['PostgreSQL', '加上 Redis']])
  })

  it('多选：只输入 custom → 单字符串', () => {
    const qs: AskQuestion[] = [{ question: '要哪些？', options: opts, multiSelect: true }]
    expect(buildAskAnswers(qs, [d([], '都行')])).toEqual(['都行'])
  })

  it('自由文本（无选项）：只认输入', () => {
    const qs: AskQuestion[] = [{ question: '项目叫什么名字？' }]
    expect(buildAskAnswers(qs, [d([], 'databus')])).toEqual(['databus'])
    expect(buildAskAnswers(qs, [emptyDraft()])).toBeNull()
  })

  it('任一空题 → null（整包不可提交）', () => {
    const qs: AskQuestion[] = [
      { question: 'q1', options: opts },
      { question: 'q2' },
    ]
    expect(buildAskAnswers(qs, [d([0]), emptyDraft()])).toBeNull()
    expect(buildAskAnswers(qs, [d([0]), d([], 'ok')])).toEqual(['PostgreSQL', 'ok'])
  })

  it('多题按序组装（修复逐题点击整包提交缝隙的数据面）', () => {
    const qs: AskQuestion[] = [
      { question: 'q1', options: opts },
      { question: 'q2', options: opts, multiSelect: true },
      { question: 'q3' },
    ]
    expect(buildAskAnswers(qs, [d([2]), d([0, 1], 'x'), d([], 'y')])).toEqual(['SQLite', ['PostgreSQL', 'MySQL', 'x'], 'y'])
  })
})
