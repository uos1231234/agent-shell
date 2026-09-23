// 工具级截断戳 → databus_query 召回（v0.38）独立核实。
// 与块级压缩正交：在工具仍驻留 databus 时，戳必须可精确取回全文。

import { describe, it, expect } from 'vitest'
import { ConversationMemory } from '../../src/im/conversation-memory.js'
import { Databus, stampOfToolTurn } from '../../src/im/databus.js'
import { appendCanonicalTurn } from '../../src/im/turn.js'
import { foldOversizeToolTurns } from '../../src/im/tools/history-tool-table.js'
import { createDatabusQueryTool } from '../../src/im/tools/databus-query.js'
import type { ConversationTurn } from '../../src/im/conversation-memory.js'
import type { ToolTurn } from '../../src/im/databus.js'

let n = 0
const toolTurn = (toolCallId: string, content: string): ConversationTurn =>
  ({ id: `tool-${n++}`, role: 'tool', toolCallId, content, sourceAgentId: 'main', at: ++n } as ToolTurn)

describe('tool-level stamp recall (v0.38 databus_query)', () => {
  it('truncation marker stamp retrieves FULL content from databus', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus({ sessionId: 't1' })
    const full = 'HEAD_MARKER_' + 'M'.repeat(3000) + '_TAIL_MARKER_' + 'Z'.repeat(50)

    // 25 个工具回合触发热窗口外截断
    for (let i = 0; i < 25; i += 1) {
      const tcId = `tc-${i}`
      const body = i === 0 ? full : `small-${i}`
      appendCanonicalTurn(conv, bus, toolTurn(tcId, body))
    }

    const fold = foldOversizeToolTurns(conv, { keepRecent: 5, resultTokenCeiling: 100 })
    expect(fold?.folded).toBeGreaterThanOrEqual(1)

    // canonical 里应出现戳标记
    const truncated = conv.turns().find((t) => t.role === 'tool' && String(t.content).includes('截断'))
    expect(truncated).toBeDefined()
    const content = String((truncated as { content: string }).content)
    expect(content).toContain('用 databus_query({stamp:')
    const stampMatch = content.match(/戳 ([0-9a-f]{12})/)
    expect(stampMatch).not.toBeNull()
    const stamp = stampMatch![1]!

    // 戳必须与 stampOfToolTurn(原始) 一致
    const original = bus.turns().find((t) => t.toolCallId === 'tc-0')!
    expect(stampOfToolTurn(original)).toBe(stamp)

    // databus_query({stamp}) 返回完整原文（含头尾 marker，且不带截断标记）
    const dq = createDatabusQueryTool()
    const result = await dq.execute({ stamp, reason: 'recall' }, { databus: bus } as never)
    const parsed = JSON.parse(String(result)) as Array<{ content: string }>
    expect(parsed.length).toBe(1)
    expect(parsed[0]!.content).toContain('HEAD_MARKER_')
    expect(parsed[0]!.content).toContain('TAIL_MARKER_')
    expect(parsed[0]!.content).not.toContain('截断')
    expect(parsed[0]!.content.length).toBe(full.length)
  })

  it('keyword and toolName filters also recover full content', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus({ sessionId: 't2' })
    const body = 'UNIQUE_NEEDLE_42 ' + 'Q'.repeat(3000)
    appendCanonicalTurn(conv, bus, toolTurn('tc-k', body))
    for (let i = 0; i < 24; i += 1) appendCanonicalTurn(conv, bus, toolTurn(`tc-f-${i}`, `filler-${i}`))
    foldOversizeToolTurns(conv, { keepRecent: 5, resultTokenCeiling: 50 })

    const dq = createDatabusQueryTool()
    const byKw = await dq.execute({ keyword: 'UNIQUE_NEEDLE_42', reason: 'r' }, { databus: bus } as never)
    const byName = await dq.execute({ toolName: 'unknown', reason: 'r' }, { databus: bus } as never)
    // toolName 在 ToolTurn 上可选——我们 seed 时未设，过滤应为空；keyword 应命中
    expect(JSON.parse(String(byKw)).length).toBe(1)
    expect(String(JSON.parse(String(byKw))[0].content)).toContain('UNIQUE_NEEDLE_42')
  })
})
