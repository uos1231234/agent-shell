// v0.41 G1 — 确定性本地合并（纯函数）测试。
//
// 钉住的核心性质：
//  (1) conclusion 逐字全量、**不设任何上限**（D9）——这是"字数限制本质是截断
//      信息"的直接落点，60K 的回答必须原样进信封；
//  (2) 压缩率只来自丢掉输入材料，材料锚按 inputKeepTokens 截头并留标记；
//  (3) 空数组字段（无工具时的 causal_steps、本地合并无从判断的三个
//      working_state 数组）必须通过 validateCuratedMemory —— 这是"换生产者
//      不换 schema"（约束 7）能成立的前提；
//  (4) 触发线 A/B 的边界与优先级。

import { describe, it, expect } from 'vitest'
import {
  mergeGoalBlock,
  shouldMergeGoalBlock,
  estimateBlockTokens,
  finalConclusionOf,
  causalStepsOf,
  evidenceFragmentsOf,
} from '../../../src/im/goal/block-merge.js'
import { findNextTaskBlock, type TaskBlock } from '../../../src/im/system-agents/drive-coordinator.js'
import { validateCuratedMemory } from '../../../src/im/state-line/index.js'
import { estimateTokens } from '../../../src/shared/token-estimate.js'
import { ConversationMemory } from '../../../src/im/conversation-memory.js'
import { Databus, type ToolTurn } from '../../../src/im/databus.js'
import { appendCanonicalTurn } from '../../../src/im/turn.js'
import type { ConversationTurn } from '../../../src/im/conversation-memory.js'
import type { ToolCall } from '../../../src/protocol/types.js'

const CONDITION = '在工作区写出 a.txt 与 b.txt，两个文件都存在才算完成'
const VERDICT_REASON = 'b.txt 的写入证据缺失：历史里没有对应的 write 工具调用'

let n = 0
const id = (p: string): string => `${p}-${n++}`

const user = (content: string, idPrefix = 'user'): ConversationTurn =>
  ({ id: id(idPrefix), role: 'user', content, at: n })
const assistant = (content: string | null, toolCalls?: ToolCall[]): ConversationTurn => {
  const t: ConversationTurn = { id: id('assistant'), role: 'assistant', content, at: n }
  if (toolCalls !== undefined) t.toolCalls = toolCalls
  return t
}
const tool = (toolCallId: string, content: string, toolName: string, args?: unknown, isError?: true): ConversationTurn => {
  const t: ToolTurn = { id: id('tool'), role: 'tool', toolCallId, content, sourceAgentId: 'main', at: n, toolName }
  if (args !== undefined) t.args = args
  if (isError === true) t.isError = true
  return t
}
const tc = (callId: string, name = 'write'): ToolCall =>
  ({ id: callId, type: 'function', function: { name, arguments: '{}' } })

/** 用真实的 findNextTaskBlock 取块，避免手搓 TaskBlock 与生产逻辑漂移。 */
const blockOf = (turns: ConversationTurn[]): TaskBlock => {
  const conv = new ConversationMemory()
  const bus = new Databus()
  for (const t of turns) appendCanonicalTurn(conv, bus, t)
  const block = findNextTaskBlock(conv.turns())
  if (block === undefined) throw new Error('测试构造失败：这些回合没有形成已关闭块（缺右边界 user 回合？）')
  return block
}

/** 一个已关闭块 = [起始 user … 工作 …] + 右边界 user（下一轮的提醒或新请求）。 */
const closedBlock = (body: ConversationTurn[]): TaskBlock =>
  blockOf([...body, user('右边界')])

const merge = (block: TaskBlock, inputKeepTokens = 1_000) =>
  mergeGoalBlock({ block, condition: CONDITION, verdictReason: VERDICT_REASON, inputKeepTokens })

describe('G1 — conclusion 逐字全量，不设上限（D9）', () => {
  it('60K token 的回答原样进 conclusion，一个字符都不截', () => {
    const huge = 'x'.repeat(240_000) // ASCII → estimateTokens = 60_000
    expect(estimateTokens(huge)).toBe(60_000)

    const memory = merge(closedBlock([user('分析这份材料'), assistant(huge)]))

    expect(memory.conclusion).toBe(huge)
    expect(memory.conclusion).toHaveLength(240_000)
    expect(memory.conclusion).not.toContain('截断')
  })

  it('取最后一个 content 非空的 assistant 回合', () => {
    const memory = merge(closedBlock([
      user('问题'),
      assistant('中间推理，会被丢弃'),
      assistant('最终结论'),
    ]))
    expect(memory.conclusion).toBe('最终结论')
  })

  it('跳过 content 为 null 或空串的 assistant 回合', () => {
    const memory = merge(closedBlock([
      user('问题'),
      assistant('真正的结论'),
      assistant(null, [tc('c1')]),
      tool('c1', 'ok', 'read'),
      assistant('   '),
    ]))
    expect(memory.conclusion).toBe('真正的结论')
  })

  it('全是 null/空 assistant 时 conclusion 为空串（不编造）', () => {
    const memory = merge(closedBlock([user('问题'), assistant(null), assistant('')]))
    expect(memory.conclusion).toBe('')
  })

  it('finalConclusionOf 对空块返回空串', () => {
    expect(finalConclusionOf([])).toBe('')
  })
})

describe('G1 — 输入材料锚', () => {
  it('真实用户输入按 inputKeepTokens 截头并带截断标记', () => {
    const material = 'M'.repeat(40_000) // 10_000 token
    const memory = merge(closedBlock([user(material), assistant('结论')]), 1_000)

    expect(memory.evidence_fragments).toHaveLength(1)
    const frag = memory.evidence_fragments[0]!
    expect(frag.source).toBe('user')
    expect(frag.relevance).toContain('raw-archive')
    // 截断到约 1000 token（4000 ASCII 字符）+ 标记，而不是原样 40000
    expect(frag.fragment.length).toBeLessThan(5_000)
    expect(frag.fragment).toContain('…（截断）')
    expect(frag.fragment.startsWith('MMMM')).toBe(true)
  })

  it('材料短于预算时逐字保留、不加截断标记', () => {
    const memory = merge(closedBlock([user('短问题'), assistant('结论')]), 1_000)
    expect(memory.evidence_fragments[0]!.fragment).toBe('短问题')
    expect(memory.evidence_fragments[0]!.fragment).not.toContain('截断')
  })

  it('goal- 续跑提醒开头的块 → evidence_fragments 为空（内容与 task_goal/next_action 完全重复）', () => {
    const reminder = '#GOAL_CONTINUATION\n#OBJECTIVE 目标\n#ROUND 2/24\n#VERDICT not_met\n#END_GOAL'
    const memory = merge(closedBlock([user(reminder, 'goal'), assistant('结论')]))
    expect(memory.evidence_fragments).toEqual([])
  })

  it('用户输入为空串时 evidence_fragments 为空（不放空片段）', () => {
    const memory = merge(closedBlock([user(''), assistant('结论')]))
    expect(memory.evidence_fragments).toEqual([])
  })

  it('evidenceFragmentsOf 对空回合列表返回空数组', () => {
    expect(evidenceFragmentsOf([], 1_000)).toEqual([])
  })
})

describe('G1 — 工具链箭头表示', () => {
  it('每个工具回合一条 causal_steps，含工具名/参数摘要/结果首行', () => {
    const memory = merge(closedBlock([
      user('写入两个文件'),
      assistant('我先写 a.txt', [tc('c1')]),
      tool('c1', '已写入 a.txt\n第二行不该出现', 'write', { path: 'a.txt' }),
      assistant('再写 b.txt', [tc('c2')]),
      tool('c2', '写入失败', 'write', { path: 'b.txt' }, true),
      assistant('完成'),
    ]))

    expect(memory.causal_steps).toHaveLength(2)
    expect(memory.causal_steps[0]).toEqual({
      intent: '我先写 a.txt',
      tool_action: 'write({"path":"a.txt"})',
      result: '已写入 a.txt',
    })
    // 错误标记必须保留：judge 与后续轮次都要能看出这一步失败了
    expect(memory.causal_steps[1]!.result).toBe('写入失败（错误）')
  })

  it('无工具的块 → causal_steps 为空数组（不编造 intent/result）', () => {
    const memory = merge(closedBlock([user('纯信息分析'), assistant('分析结论')]))
    expect(memory.causal_steps).toEqual([])
  })

  it('工具回合前没有 assistant 正文时 intent 为空串', () => {
    const steps = causalStepsOf([
      user('q'),
      assistant(null, [tc('c1')]),
      tool('c1', 'out', 'read'),
    ])
    expect(steps).toEqual([{ intent: '', tool_action: 'read()', result: 'out' }])
  })

  it('缺 args 时 tool_action 不带参数括号内容；缺 toolName 时回落 "tool"', () => {
    const steps = causalStepsOf([tool('c1', 'out', undefined as unknown as string)])
    expect(steps[0]!.tool_action).toBe('tool()')
  })

  it('超长参数与多行结果被压成一行摘要（全文在 databus，不在信封里重复）', () => {
    const steps = causalStepsOf([
      tool('c1', `第一行\n${'y'.repeat(5_000)}`, 'bash', { command: 'z'.repeat(5_000) }),
    ])
    expect(steps[0]!.tool_action).not.toContain('\n')
    expect(steps[0]!.tool_action.length).toBeLessThan(200)
    expect(steps[0]!.result).toBe('第一行')
  })
})

describe('G1 — 11 字段映射与 schema 兼容（约束 7）', () => {
  it('无工具的纯信息块通过 validateCuratedMemory（空数组合法）', () => {
    const memory = merge(closedBlock([user('纯信息分析'), assistant('分析结论')]))
    expect(() => validateCuratedMemory(memory)).not.toThrow()
  })

  it('有工具的块同样通过', () => {
    const memory = merge(closedBlock([
      user('q'), assistant('做', [tc('c1')]), tool('c1', 'ok', 'read'), assistant('结论'),
    ]))
    expect(() => validateCuratedMemory(memory)).not.toThrow()
  })

  it('字段映射逐项正确', () => {
    const memory = merge(closedBlock([user('q'), assistant('结论')]))
    expect(memory.task_goal).toBe(CONDITION)
    expect(memory.next_action).toBe(VERDICT_REASON)
    expect(memory.working_state.current_goal).toBe(CONDITION)
    expect(memory.working_state.remaining_work).toEqual([VERDICT_REASON])
    // 本地合并无从判断的三项留空——编造等于把噪音写进长期记忆
    expect(memory.working_state.effective_decisions).toEqual([])
    expect(memory.working_state.rejected_decisions).toEqual([])
    expect(memory.working_state.architecture_boundaries).toEqual([])
    // goal 未达成才会走到 G1
    expect(memory.status_hint).toBe('PENDING')
  })
})

describe('G1 — 触发线 A/B/C（D6 + D14 + v0.41 后续补丁 (a) floor + C3 压力阀）', () => {
  // 三条线里只有 C 依赖层分类，且判据由调用方算好传入（纯函数不认识
  // MemoryConfig）——尺寸用例一律显式关掉它。
  const base = { blockMinTokens: 80_000, floorTokens: 10_000, m1MinTokens: 200_000, pressure: false }

  it('A：块 ≥ 80K 触发 size', () => {
    expect(shouldMergeGoalBlock({ ...base, blockTokens: 80_000, contextTokens: 0 })).toBe('size')
    expect(shouldMergeGoalBlock({ ...base, blockTokens: 90_000, contextTokens: 10 })).toBe('size')
  })

  it('A 边界下方不触发（块 79_999 + 上下文也很小）', () => {
    expect(shouldMergeGoalBlock({ ...base, blockTokens: 79_999, contextTokens: 199_999 })).toBe('none')
  })

  it('B：块 ≥ floor 且上下文 ≥ m1MinTokens 触发 watermark', () => {
    // 这条线存在的理由：只有 A 时"小块多轮"（30K × 20 轮）永不触发，而跨越
    // 驱动又被 D7 互斥关掉，上下文会无界增长直到撞 1M token guard。
    expect(shouldMergeGoalBlock({ ...base, blockTokens: 30_000, contextTokens: 200_000 })).toBe('watermark')
    expect(shouldMergeGoalBlock({ ...base, blockTokens: 10_000, contextTokens: 900_000 })).toBe('watermark')
  })

  it('B floor：块 < 10K 时 watermark 不触发（过滤净膨胀小块）', () => {
    // v0.41 后续补丁 (a)：探针实测 5K 纯回答块 ratio=0.84x 膨胀，floor=10K 过滤。
    // 这层过滤的唯一例外是 C 线（下方）——M3 之下不为小块合并。
    expect(shouldMergeGoalBlock({ ...base, blockTokens: 9_999, contextTokens: 900_000 })).toBe('none')
    expect(shouldMergeGoalBlock({ ...base, blockTokens: 1, contextTokens: 900_000 })).toBe('none')
  })

  it('两条线同时满足时报 size（A 更精确地指出"这一块值得压"）', () => {
    expect(shouldMergeGoalBlock({ ...base, blockTokens: 100_000, contextTokens: 300_000 })).toBe('size')
  })

  it('两条线都不满足 → none', () => {
    expect(shouldMergeGoalBlock({ ...base, blockTokens: 0, contextTokens: 0 })).toBe('none')
  })

  it('阈值可配（宿主只能透传，事实源在 goal/types.ts）', () => {
    expect(shouldMergeGoalBlock({ blockTokens: 500, contextTokens: 0, blockMinTokens: 500, floorTokens: 100, m1MinTokens: 1_000, pressure: false })).toBe('size')
  })

  it('C（C3 压力阀）：命中时忽略两条尺寸线，连 1 token 的块也合并', () => {
    // goal 模式下跨越驱动整段关闭（D7），M3 之上只有 G1/G2 在出货——小块也必须
    // 排干。(a) 的净膨胀在这里是刻意接受的代价。
    expect(shouldMergeGoalBlock({ ...base, blockTokens: 9_999, contextTokens: 900_000, pressure: true })).toBe('pressure')
    expect(shouldMergeGoalBlock({ ...base, blockTokens: 1, contextTokens: 900_000, pressure: true })).toBe('pressure')
  })

  it('C 只兜底：A/B 命中时报告更精确的那条线', () => {
    expect(shouldMergeGoalBlock({ ...base, blockTokens: 100_000, contextTokens: 900_000, pressure: true })).toBe('size')
    expect(shouldMergeGoalBlock({ ...base, blockTokens: 30_000, contextTokens: 900_000, pressure: true })).toBe('watermark')
  })
})

describe('G1 — estimateBlockTokens 口径', () => {
  it('与 loop 的 estimateContextTokens 同源：wire 形态序列化后 CJK 感知估算', () => {
    const block = closedBlock([user('中文材料'.repeat(100)), assistant('中文结论'.repeat(100))])
    const tokens = estimateBlockTokens(block)
    // CJK 感知：中文约 1 字符 1 token，而不是 chars/4（那会低估 3-6 倍）
    expect(tokens).toBeGreaterThan(700)
    expect(tokens).toBe(estimateTokens(block.messages.map((m) => JSON.stringify(m)).join('')))
  })

  it('空块为 0（shouldMergeGoalBlock 的 blockTokens > 0 前提）', () => {
    expect(estimateBlockTokens({ startIndex: 0, endIndexExclusive: 0, startUserTurnId: '', boundaryUserTurnId: '', turns: [], messages: [], toolTurnIds: [] })).toBe(0)
  })
})
