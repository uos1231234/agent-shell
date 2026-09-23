import { describe, it, expect } from 'vitest'
import { ConversationMemory } from '../../../src/im/conversation-memory.js'
import type { ConversationTurn } from '../../../src/im/conversation-memory.js'
import { foldOversizeToolTurns } from '../../../src/im/tools/history-tool-table.js'
import { stampOfToolTurn } from '../../../src/im/databus.js'
import { estimateTokens } from '../../../src/shared/token-estimate.js'

const userTurn = (id: string, content: string): ConversationTurn => ({ id, role: 'user', content, at: 1 })
const assistantWithCalls = (id: string, callIds: string[], content: string | null = null): ConversationTurn => ({
  id,
  role: 'assistant',
  content,
  toolCalls: callIds.map(cid => ({ id: cid, type: 'function' as const, function: { name: 'read', arguments: '{"reason":"查看文件内容以确认结构","path":"a.txt"}' } })),
  at: 2,
})
const toolResult = (id: string, callId: string, content: string): ConversationTurn => ({
  id,
  role: 'tool',
  toolCallId: callId,
  content,
  sourceAgentId: 'main',
  toolName: 'read',
  args: { reason: '查看文件内容以确认结构', path: 'a.txt' },
  at: 3,
})

const namedToolResult = (id: string, callId: string, toolName: string, content: string): ConversationTurn => ({
  id,
  role: 'tool',
  toolCallId: callId,
  content,
  sourceAgentId: 'main',
  toolName,
  at: 3,
})

// v0.39：ceiling 2000，bigResult 要 >2000 token，且 head/tail 可区分（验证保头保尾）。
const bigResult = (n = 2500): string => 'HEAD-MARKER ' + '历史压缩算法的实现细节讨论。'.repeat(Math.ceil(n / 14)) + ' TAIL-MARKER'
const smallResult = 'ok'

describe('im/tools/history-tool-table (v0.38 原位截断 + 戳召回)', () => {
  it('returns undefined when tool turns do not exceed the hot window', () => {
    const cm = new ConversationMemory()
    cm.append(userTurn('u1', '任务'))
    for (let i = 0; i < 5; i++) {
      cm.append(assistantWithCalls(`a${i}`, [`c${i}`]))
      cm.append(toolResult(`t${i}`, `c${i}`, bigResult()))
    }
    expect(foldOversizeToolTurns(cm)).toBeUndefined()
    expect(cm.turns()).toHaveLength(11)
  })

  it('truncates oversize tool results in place with a stamp marker (no table turn)', () => {
    const cm = new ConversationMemory()
    cm.append(userTurn('u1', '任务'))
    // 25 个批次，前 10 个大 result（>500 token），后 15 个在热区。
    for (let i = 0; i < 25; i++) {
      cm.append(assistantWithCalls(`a${i}`, [`c${i}`]))
      cm.append(toolResult(`t${i}`, `c${i}`, i < 10 ? bigResult() : smallResult))
    }
    const before = cm.turns().length
    const result = foldOversizeToolTurns(cm)
    expect(result).toBeDefined()
    // 25 个工具，热区保留最近 20 → 溢出 5 个（t0..t4，全是大 result）→ 候选 5 个
    expect(result!.folded).toBe(5)

    const turns = cm.turns()
    // 原位截断不删 turn：长度不变
    expect(turns).toHaveLength(before)
    // 不再产生表格 turn（废弃表格载体）
    expect(turns.find(t => t.role === 'user' && typeof t.content === 'string' && t.content.includes('| reason | tool | result |'))).toBeUndefined()
    // 被截断的 tool turn 现在带戳标记
    const t0 = turns.find(t => t.role === 'tool' && t.toolCallId === 'c0')!
    const stamp = stampOfToolTurn({ toolCallId: 'c0', toolName: 'read', content: bigResult() })
    expect(t0.content as string).toContain(`戳 ${stamp}`)
    expect(t0.content as string).toContain(`databus_query({stamp:'${stamp}'})`)
    expect(t0.content as string).toContain('截断 2000→')
    // 保头：HEAD-MARKER 在截断后的头部
    expect(t0.content as string).toContain('HEAD-MARKER')
    // 保尾：TAIL-MARKER 在截断后的尾部（保头弃尾会丢这个）
    expect(t0.content as string).toContain('TAIL-MARKER')
    // 标记固定在内容**末尾**（2026-09-12 用户拍板）：头尾拼接后，戳在最后
    expect((t0.content as string).endsWith(`databus_query({stamp:'${stamp}'}) 取回全文）`)).toBe(true)
    expect((t0.content as string).indexOf('TAIL-MARKER')).toBeLessThan((t0.content as string).indexOf('截断 2000→'))
    // 热区 tool turn 未被截断（仍是原始 smallResult）
    const t20 = turns.find(t => t.role === 'tool' && t.toolCallId === 'c20')!
    expect(t20.content).toBe(smallResult)
  })

  it('keeps small results (<500 tokens) outside the hot window untouched', () => {
    const cm = new ConversationMemory()
    cm.append(userTurn('u1', '任务'))
    for (let i = 0; i < 25; i++) {
      cm.append(assistantWithCalls(`a${i}`, [`c${i}`]))
      cm.append(toolResult(`t${i}`, `c${i}`, smallResult))
    }
    expect(foldOversizeToolTurns(cm)).toBeUndefined()
    expect(cm.turns().filter(t => t.role === 'tool')).toHaveLength(25)
  })

  it('per-turn judgement: a small result co-located with a big one is NOT folded (no batch co-folding)', () => {
    const cm = new ConversationMemory()
    cm.append(userTurn('u1', '任务'))
    for (let i = 0; i < 25; i++) {
      if (i < 10) {
        // 一批两个 tool call：一个大 result 一个小 result
        cm.append(assistantWithCalls(`a${i}`, [`cbig${i}`, `csmall${i}`]))
        cm.append(toolResult(`tbig${i}`, `cbig${i}`, bigResult()))
        cm.append(toolResult(`tsmall${i}`, `csmall${i}`, smallResult))
      } else {
        cm.append(assistantWithCalls(`a${i}`, [`c${i}`]))
        cm.append(toolResult(`t${i}`, `c${i}`, smallResult))
      }
    }
    const result = foldOversizeToolTurns(cm)
    expect(result).toBeDefined()
    // 35 个工具，热区 20 → 溢出 15 个（tbig0..tbig6, tsmall0..tsmall6, tbig7, tsmall7）
    // 候选 = 溢出中的大 result（tbig0..tbig7，8 个）→ 只截断这 8 个
    // 小 result（tsmall0..tsmall7）即使和大 result 同批次，也不连坐
    expect(result!.folded).toBe(8)
    const turns = cm.turns()
    // 小 result 仍是原始 smallResult（未被截断）
    const ts0 = turns.find(t => t.role === 'tool' && t.toolCallId === 'csmall0')!
    expect(ts0.content).toBe(smallResult)
    // 大 result 被截断带戳
    const tb0 = turns.find(t => t.role === 'tool' && t.toolCallId === 'cbig0')!
    expect(tb0.content as string).toContain('戳 ')
  })

  it('truncates orphan tool turns too (no batch-pair protection needed)', () => {
    const cm = new ConversationMemory()
    cm.append(userTurn('u1', '任务'))
    // 孤儿 tool（无 assistant 声明）+ 足量热区
    cm.append({ id: 'orphan', role: 'tool', toolCallId: 'never-declared', content: bigResult(), sourceAgentId: 'main', toolName: 'read', at: 5 })
    for (let i = 0; i < 25; i++) {
      cm.append(assistantWithCalls(`a${i}`, [`c${i}`]))
      cm.append(toolResult(`t${i}`, `c${i}`, smallResult))
    }
    // 26 个 tool，热区 20 → 溢出 6 个。孤儿是溢出之一且是大 result → 被截断
    const result = foldOversizeToolTurns(cm)
    expect(result).toBeDefined()
    expect(result!.folded).toBe(1) // 只有孤儿是大 result，其余溢出的是 smallResult
    const orphan = cm.turns().find(t => t.role === 'tool' && t.toolCallId === 'never-declared')!
    expect(orphan.content as string).toContain('戳 ')
  })

  it('truncated content stays within ceiling + marker overhead', () => {
    const cm = new ConversationMemory()
    cm.append(userTurn('u1', '任务'))
    for (let i = 0; i < 25; i++) {
      cm.append(assistantWithCalls(`a${i}`, [`c${i}`]))
      cm.append(toolResult(`t${i}`, `c${i}`, i === 0 ? bigResult(5000) : smallResult))
    }
    foldOversizeToolTurns(cm)
    const t0 = cm.turns().find(t => t.role === 'tool' && t.toolCallId === 'c0')!
    // 截断后 content（含标记）远小于原始 5000-token result；ceiling 2000 + 保头保尾各 1000 + 标记
    expect(estimateTokens(String(t0.content))).toBeLessThan(2500)
  })

  it('does not fold recall-tool results, while ordinary tool results still fold', () => {
    const cm = new ConversationMemory()
    cm.append(userTurn('u1', '任务'))

    cm.append(assistantWithCalls('a-recall', ['c-recall']))
    cm.append(namedToolResult('t-recall', 'c-recall', 'state_query', bigResult(5000)))
    cm.append(assistantWithCalls('a-ordinary', ['c-ordinary']))
    cm.append(namedToolResult('t-ordinary', 'c-ordinary', 'read', bigResult(5000)))

    for (let i = 0; i < 20; i += 1) {
      cm.append(assistantWithCalls(`a${i}`, [`c${i}`]))
      cm.append(namedToolResult(`t${i}`, `c${i}`, 'read', smallResult))
    }

    const result = foldOversizeToolTurns(cm)
    expect(result).toBeDefined()
    expect(result!.folded).toBe(1)

    const recall = cm.turns().find(t => t.role === 'tool' && t.toolCallId === 'c-recall')!
    expect(recall.content).toBe(bigResult(5000))

    const ordinary = cm.turns().find(t => t.role === 'tool' && t.toolCallId === 'c-ordinary')!
    expect(ordinary.content as string).toContain('截断 2000→')
  })
})
