import { describe, expect, it } from 'vitest'
import { ConversationMemory } from '../../../src/im/conversation-memory.js'
import { Databus } from '../../../src/im/databus.js'
import { appendToolResultWithProjection } from '../../../src/im/turn.js'
import { projectToolResult } from '../../../src/im/tools/result-budget.js'
import type { ToolTurn } from '../../../src/im/databus.js'
import { DEEPSEEK_TOKEN_COUNTER } from '../../../src/shared/token-counter.js'

const toolTurn = (content: string): ToolTurn => ({
  id: 'tool-1',
  role: 'tool',
  toolCallId: 'call-1',
  toolName: 'read',
  sourceAgentId: 'main',
  at: 1,
  content,
})

describe('bounded model-visible tool results', () => {
  it('keeps the marker inside the 20K budget and preserves the recall stamp', () => {
    const result = projectToolResult({ content: 'x'.repeat(100_000), stamp: 'abc123def456' })
    expect(result.truncated).toBe(true)
    expect(result.visibleTokens).toBeLessThanOrEqual(20_000)
    expect(result.originalTokens).toBeGreaterThan(result.visibleTokens)
    expect(result.visibleContent).toContain('abc123def456')
    expect(result.visibleContent).toContain('当前内容不是全文')
  })

  it('stores the full tool result in Databus and only the projection in ConversationMemory', () => {
    const conversation = new ConversationMemory()
    const databus = new Databus()
    const full = toolTurn('x'.repeat(100_000))
    const { projectedTurn } = appendToolResultWithProjection(conversation, databus, full)

    expect(databus.turns()[0]?.content).toBe(full.content)
    expect(conversation.turns()[0]?.content).toBe(projectedTurn.content)
    expect(String(conversation.turns()[0]?.content).length).toBeLessThan(full.content.length)
  })

  it('uses the selected model counter for both slicing and omission ranges', () => {
    const content = `HEAD-${'a'.repeat(50_000)}-MIDDLE-${'b'.repeat(50_000)}-TAIL`
    const result = projectToolResult({
      content,
      stamp: 'deepseek-stamp',
      tokenCounter: DEEPSEEK_TOKEN_COUNTER,
    })

    expect(result.truncated).toBe(true)
    expect(result.visibleTokens).toBeLessThanOrEqual(20_000)
    const omitted = result.omittedRanges[0]!
    const total = DEEPSEEK_TOKEN_COUNTER.count(content)
    const expectedHead = DEEPSEEK_TOKEN_COUNTER.slice(content, 0, omitted.startToken)
    const expectedTail = DEEPSEEK_TOKEN_COUNTER.slice(content, omitted.endToken, total)
    expect(result.visibleContent.startsWith(expectedHead)).toBe(true)
    expect(result.visibleContent).toContain(expectedTail)
  })
})
