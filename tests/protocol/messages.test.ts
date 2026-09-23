// v0.41 D19 — 出站 wire 规范化（相邻 user 合并）测试。
//
// 两条承重性质：
//  (1) **无损**：合并是拼接，任何非空内容都不得消失（这不是截断机制，
//      AGENTS.md 铁律）；
//  (2) **只动 user**：tool / assistant / system 一律不合并，每个排除都有具体
//      理由（tool 合并会摧毁 tool_call_id 配对；assistant 合并有 tool_calls
//      配对风险；多条 system part 是刻意的注入分层）。

import { describe, it, expect } from 'vitest'
import { normalizeStrictAlternation, hasAdjacentUserMessages } from '../../src/protocol/messages.js'
import type { ChatMessage, ContentPart, ToolCall } from '../../src/protocol/types.js'

const sys = (content: string): ChatMessage => ({ role: 'system', content })
const u = (content: string | ContentPart[]): ChatMessage => ({ role: 'user', content })
const a = (content: string | null, toolCalls?: ToolCall[]): ChatMessage =>
  toolCalls === undefined
    ? { role: 'assistant', content }
    : { role: 'assistant', content, tool_calls: toolCalls }
const tl = (toolCallId: string, content: string): ChatMessage => ({ role: 'tool', tool_call_id: toolCallId, content })

const tc = (id: string, name = 'write') => ({ id, type: 'function' as const, function: { name, arguments: '{}' } })

const text = (m: ChatMessage): string => {
  if (m.role === 'tool') return m.content
  if (m.role === 'assistant') return m.content ?? ''
  if (typeof m.content === 'string') return m.content
  return m.content.map((p) => (p.type === 'text' ? p.text : '<image>')).join('')
}

describe('normalizeStrictAlternation — 无相邻 user 时不改动', () => {
  it('严格交替的序列原样通过', () => {
    const messages: ChatMessage[] = [sys('S'), u('问题'), a('回答'), u('追问'), a('再答')]
    expect(normalizeStrictAlternation(messages)).toEqual(messages)
  })

  it('assistant(tool_calls) → tool → tool → assistant 的标准工具轮不被触碰', () => {
    const messages: ChatMessage[] = [
      u('写两个文件'),
      a(null, [tc('c1'), tc('c2')]),
      tl('c1', '写入 a.txt'),
      tl('c2', '写入 b.txt'),
      a('都写好了'),
    ]
    expect(normalizeStrictAlternation(messages)).toEqual(messages)
  })

  it('空序列与单条消息', () => {
    expect(normalizeStrictAlternation([])).toEqual([])
    expect(normalizeStrictAlternation([u('只有一条')])).toEqual([u('只有一条')])
  })

  it('hasAdjacentUserMessages 与转写结果一致', () => {
    const ok: ChatMessage[] = [u('a'), a('b'), u('c')]
    const bad: ChatMessage[] = [u('a'), u('b')]
    expect(hasAdjacentUserMessages(ok)).toBe(false)
    expect(hasAdjacentUserMessages(bad)).toBe(true)
  })
})

describe('normalizeStrictAlternation — 合并相邻 user', () => {
  it('两条相邻 user 合并成一条，用两个换行分隔', () => {
    const out = normalizeStrictAlternation([u('#STAMP S-1 的信封'), u('#GOAL_CONTINUATION 提醒')])
    expect(out).toHaveLength(1)
    expect(out[0]!.role).toBe('user')
    expect(text(out[0]!)).toBe('#STAMP S-1 的信封\n\n#GOAL_CONTINUATION 提醒')
  })

  it('三条及以上连续 user 全部并入一条', () => {
    const out = normalizeStrictAlternation([u('甲'), u('乙'), u('丙'), a('答')])
    expect(out).toHaveLength(2)
    expect(text(out[0]!)).toBe('甲\n\n乙\n\n丙')
    expect(out[1]!.role).toBe('assistant')
  })

  it('goal 模式的真实形状：信封紧邻续跑提醒', () => {
    // AGENTS.md §6.27 ④：压缩后 canonical 是 [mem- 信封 user][goal- 提醒 user]，
    // OpenAI 兼容栈容忍，Anthropic 严格交替会 400。goal 模式下每次块合并必发。
    const out = normalizeStrictAlternation([
      sys('SYS'),
      u('#STAMP S-1\n#LAYER M1\n[结论] 旧结论\n#END_BLOCK'),
      u('#GOAL_CONTINUATION\n#OBJECTIVE 写出 a.txt\n#END_GOAL'),
      a(null, [tc('c1')]),
      tl('c1', 'ok'),
      a('做完了'),
    ])
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant'])
    expect(text(out[1]!)).toContain('#STAMP S-1')
    expect(text(out[1]!)).toContain('#GOAL_CONTINUATION')
  })

  it('合并后不再存在相邻 user（幂等的前提）', () => {
    const out = normalizeStrictAlternation([u('a'), u('b'), u('c'), u('d')])
    expect(hasAdjacentUserMessages(out)).toBe(false)
  })

  it('幂等：对已规范化的序列再跑一次结果不变', () => {
    const once = normalizeStrictAlternation([sys('S'), u('a'), u('b'), a('x'), u('c'), u('d')])
    expect(normalizeStrictAlternation(once)).toEqual(once)
  })

  it('非 user 消息的相对位置与内容完全不变', () => {
    const out = normalizeStrictAlternation([
      sys('S1'), sys('S2'), u('a'), u('b'), a(null, [tc('c1')]), tl('c1', 'r1'), a('x'), u('c'),
    ])
    // 多条 system 刻意不合并（系统提示词 + 注入是分层设计）
    expect(out[0]).toEqual(sys('S1'))
    expect(out[1]).toEqual(sys('S2'))
    expect(text(out[2]!)).toBe('a\n\nb')
    expect(out[3]!.role).toBe('assistant')
    expect(out[4]).toEqual(tl('c1', 'r1'))
    expect(text(out[5]!)).toBe('x')
    expect(text(out[6]!)).toBe('c')
  })
})

describe('normalizeStrictAlternation — 空白段处理（系统智能体的空 userTemplate）', () => {
  it('空字符串段被跳过，不留下多余分隔符', () => {
    // createSystemAgent 硬编码 userTemplate: ''，而 omitUserTemplatePart 对空
    // 模板返回 false，所以 judge/compressor 的请求尾部总跟着一条空 user 消息。
    const out = normalizeStrictAlternation([sys('S'), u('#GOAL_CONDITION 目标'), u('')])
    expect(out).toHaveLength(2)
    expect(text(out[1]!)).toBe('#GOAL_CONDITION 目标')
  })

  it('纯空白段同样跳过', () => {
    const out = normalizeStrictAlternation([u('正文'), u('   \n  ')])
    expect(text(out[0]!)).toBe('正文')
  })

  it('多条非空 + 多条空白混合时只保留非空的，顺序不变', () => {
    const out = normalizeStrictAlternation([u(''), u('甲'), u('  '), u('乙'), u('')])
    expect(out).toHaveLength(1)
    expect(text(out[0]!)).toBe('甲\n\n乙')
  })

  it('全空白的 run 合并成空串（不丢弃这条消息，保持消息数可预期）', () => {
    const out = normalizeStrictAlternation([u(''), u('  ')])
    expect(out).toHaveLength(1)
    expect(text(out[0]!)).toBe('')
  })

  it('单条空 user 不进入合并路径，原样保留', () => {
    const out = normalizeStrictAlternation([sys('S'), u(''), a('x')])
    expect(out).toEqual([sys('S'), u(''), a('x')])
  })
})

describe('normalizeStrictAlternation — ContentPart（图片）内容', () => {
  const img = (url: string): ContentPart => ({ type: 'image_url', image_url: { url } })
  const txt = (s: string): ContentPart => ({ type: 'text', text: s })

  it('全是字符串时产出仍是字符串（不无谓升级成 parts）', () => {
    const out = normalizeStrictAlternation([u('甲'), u('乙')])
    expect(typeof out[0]!.role === 'string' && (out[0] as { content: unknown }).content).toBeTypeOf('string')
  })

  it('任一条带 parts 时产出 parts，字符串段转成 text part', () => {
    const out = normalizeStrictAlternation([u('看图'), u([img('data:image/png;base64,AAA')])])
    expect(out).toHaveLength(1)
    const content = (out[0] as { content: ContentPart[] }).content
    expect(content).toEqual([txt('看图'), img('data:image/png;base64,AAA')])
  })

  it('两条都是 parts 时按序拼接，图片一张不少', () => {
    const out = normalizeStrictAlternation([
      u([img('A'), txt('说明甲')]),
      u([txt('说明乙'), img('B')]),
    ])
    const content = (out[0] as { content: ContentPart[] }).content
    expect(content).toEqual([img('A'), txt('说明甲'), txt('说明乙'), img('B')])
  })

  it('parts 与空字符串混合时空段被跳过', () => {
    const out = normalizeStrictAlternation([u(''), u([img('A')])])
    const content = (out[0] as { content: ContentPart[] }).content
    expect(content).toEqual([img('A')])
  })
})

describe('normalizeStrictAlternation — 刻意不合并的角色', () => {
  it('连续 tool 消息不合并（合并会摧毁 tool_call_id ↔ 结果的配对）', () => {
    const messages: ChatMessage[] = [
      a(null, [tc('c1'), tc('c2'), tc('c3')]),
      tl('c1', 'r1'), tl('c2', 'r2'), tl('c3', 'r3'),
    ]
    const out = normalizeStrictAlternation(messages)
    expect(out).toHaveLength(4)
    expect(out.slice(1).map((m) => (m as { tool_call_id: string }).tool_call_id)).toEqual(['c1', 'c2', 'c3'])
  })

  it('连续 system 消息不合并（系统提示词 + runtime/temporal + MEMORY.md 是刻意分层）', () => {
    const out = normalizeStrictAlternation([sys('提示词'), sys('运行时注入'), sys('MEMORY.md'), u('q')])
    expect(out).toHaveLength(4)
    expect(out.slice(0, 3).map((m) => text(m))).toEqual(['提示词', '运行时注入', 'MEMORY.md'])
  })

  it('连续 assistant 不合并（tool_calls 配对风险；且 canonical 不产出相邻 assistant）', () => {
    const out = normalizeStrictAlternation([u('q'), a('甲'), a('乙')])
    expect(out).toHaveLength(3)
    expect(text(out[1]!)).toBe('甲')
    expect(text(out[2]!)).toBe('乙')
  })

  it('assistant 的 tool_calls 原样保留，不被转写触碰', () => {
    const calls = [tc('c1'), tc('c2')]
    const out = normalizeStrictAlternation([u('a'), u('b'), a(null, calls)])
    expect((out[1] as { tool_calls?: unknown }).tool_calls).toEqual(calls)
  })
})

describe('normalizeStrictAlternation — 无损性', () => {
  it('所有非空内容都出现在输出里（逐段检查）', () => {
    const chunks = ['材料甲', '材料乙', '结论丙', '后续丁', '末尾戊']
    const messages: ChatMessage[] = [
      sys('S'),
      u(chunks[0]!), u(chunks[1]!),
      a(chunks[2]!),
      u(chunks[3]!), u('', ), u(chunks[4]!),
    ]
    const out = normalizeStrictAlternation(messages)
    const joined = out.map(text).join('\n')
    for (const c of chunks) expect(joined).toContain(c)
  })

  it('合并只减少消息条数，不减少字符总量（除被跳过的空白）', () => {
    const messages: ChatMessage[] = [u('A'.repeat(100)), u('B'.repeat(100)), u('C'.repeat(100))]
    const out = normalizeStrictAlternation(messages)
    expect(out).toHaveLength(1)
    // 300 个内容字符 + 2 个分隔符（各 2 个换行）
    expect(text(out[0]!).length).toBe(300 + 2 * 2)
  })
})
