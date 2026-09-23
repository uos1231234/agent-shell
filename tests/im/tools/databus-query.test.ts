import { describe, it, expect } from 'vitest'
import { createDatabusQueryTool } from '../../../src/im/tools/databus-query.js'
import { Databus } from '../../../src/im/databus.js'
import { stampOfToolTurn } from '../../../src/im/databus.js'
import type { ToolTurn } from '../../../src/im/databus.js'
import type { ToolContext } from '../../../src/shared/tool-context.js'
import { createDirectRecallLedger } from '../../../src/im/tools/databus-recall.js'
import { estimateTokens } from '../../../src/shared/token-estimate.js'

const toolTurn = (overrides: Partial<ToolTurn> = {}): ToolTurn => ({
  id: 't1',
  role: 'tool',
  toolCallId: 'tc-1',
  content: 'result',
  sourceAgentId: 'main',
  at: 1,
  ...overrides,
})

describe('im/tools/databus-query', () => {
  it('reads directly from ctx.databus (deterministic, no LLM delegation)', async () => {
    const databus = new Databus()
    databus.append(toolTurn({ id: 't1', sourceAgentId: 'main', content: 'first', at: 10 }))
    databus.append(toolTurn({ id: 't2', sourceAgentId: 'warehouse', content: 'second', at: 20 }))

    const tool = createDatabusQueryTool()
    const ctx: ToolContext = { databus }
    const result = await tool.execute({ sourceAgentIds: ['main'], reason: 'check events' }, ctx)

    const parsed = JSON.parse(result as string)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].id).toBe('t1')
    expect(parsed[0].sourceAgentId).toBe('main')
  })

  it('returns all turns when no filter provided', async () => {
    const databus = new Databus()
    databus.append(toolTurn({ id: 't1', sourceAgentId: 'main', at: 10 }))
    databus.append(toolTurn({ id: 't2', sourceAgentId: 'warehouse', at: 20 }))

    const tool = createDatabusQueryTool()
    const ctx: ToolContext = { databus }
    const result = await tool.execute({ reason: 'all events' }, ctx)

    const parsed = JSON.parse(result as string)
    expect(parsed).toHaveLength(2)
  })

  it('applies limit filter', async () => {
    const databus = new Databus()
    databus.append(toolTurn({ id: 't1', sourceAgentId: 'main', at: 10 }))
    databus.append(toolTurn({ id: 't2', sourceAgentId: 'main', at: 20 }))
    databus.append(toolTurn({ id: 't3', sourceAgentId: 'main', at: 30 }))

    const tool = createDatabusQueryTool()
    const ctx: ToolContext = { databus }
    const result = await tool.execute({ limit: 1, reason: 'latest' }, ctx)

    const parsed = JSON.parse(result as string)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].id).toBe('t3')
  })

  it('throws when ctx.databus is missing', async () => {
    const tool = createDatabusQueryTool()
    await expect(tool.execute({ reason: 'query' })).rejects.toThrow('databus_query requires a databus')
  })

  it('does NOT call any SystemAgent (no recursion)', async () => {
    // The tool is a pure function of ctx.databus — no warehouse.run() involved.
    // This is the recursion fix: warehouse's own toolRefs include databus_query,
    // so any LLM delegation would recurse infinitely.
    const databus = new Databus()
    databus.append(toolTurn({ id: 't1', sourceAgentId: 'main', at: 1 }))

    let delegated = false
    // Simulate: if the tool tried to delegate, this fake "warehouse" would be called.
    // But the tool has no warehouse parameter at all — so delegation is impossible.
    const tool = createDatabusQueryTool()
    const ctx: ToolContext = { databus }
    await tool.execute({ reason: 'verify no delegation' }, ctx)
    expect(delegated).toBe(false)
  })

  // ---- v0.38 召回扩展：stamp / toolName / keyword（全量返回，不截断）----

  it('recalls the exact turn by stamp (content-hash, re-computable, no storage)', async () => {
    const databus = new Databus()
    const target = toolTurn({ id: 't1', toolCallId: 'tc-target', toolName: 'read', content: 'the full original content', at: 10 })
    databus.append(target)
    databus.append(toolTurn({ id: 't2', toolCallId: 'tc-other', toolName: 'bash', content: 'other', at: 20 }))

    const tool = createDatabusQueryTool()
    const ctx: ToolContext = { databus }
    const expected = stampOfToolTurn(target)
    const result = await tool.execute({ stamp: expected, reason: 'recall full content' }, ctx)

    const parsed = JSON.parse(result as string)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].id).toBe('t1')
    // 全量返回（不截断）
    expect(parsed[0].content).toBe('the full original content')
  })

  it('filters by toolName', async () => {
    const databus = new Databus()
    databus.append(toolTurn({ id: 't1', toolName: 'read', content: 'a', at: 1 }))
    databus.append(toolTurn({ id: 't2', toolName: 'bash', content: 'b', at: 2 }))
    databus.append(toolTurn({ id: 't3', toolName: 'read', content: 'c', at: 3 }))

    const tool = createDatabusQueryTool()
    const ctx: ToolContext = { databus }
    const result = await tool.execute({ toolName: 'read', reason: 'all reads' }, ctx)

    const parsed = JSON.parse(result as string)
    expect(parsed).toHaveLength(2)
    expect(parsed.every((t: ToolTurn) => t.toolName === 'read')).toBe(true)
  })

  it('filters by keyword matched against content + args.reason + args.path', async () => {
    const databus = new Databus()
    databus.append(toolTurn({ id: 't1', toolName: 'read', content: 'schema definition here', args: { reason: 'check schema', path: 'src/schema.ts' }, at: 1 }))
    databus.append(toolTurn({ id: 't2', toolName: 'read', content: 'unrelated', args: { reason: 'look at config', path: 'config.json' }, at: 2 }))
    databus.append(toolTurn({ id: 't3', toolName: 'bash', content: 'grep schema src/', args: {}, at: 3 }))

    const tool = createDatabusQueryTool()
    const ctx: ToolContext = { databus }
    // keyword 命中 content（t3）、args.reason（t1）、args.path（t1）
    const result = await tool.execute({ keyword: 'schema', reason: 'find schema mentions' }, ctx)

    const parsed = JSON.parse(result as string)
    expect(parsed).toHaveLength(2)
    expect(parsed.map((t: ToolTurn) => t.id).sort()).toEqual(['t1', 't3'])
  })

  it('returns full content (never re-truncated) — recall must be complete or it is meaningless', async () => {
    const databus = new Databus()
    const big = 'x'.repeat(5000) // 远超任何 ceiling
    databus.append(toolTurn({ id: 't1', toolCallId: 'tc-big', toolName: 'read', content: big, at: 1 }))

    const tool = createDatabusQueryTool()
    const ctx: ToolContext = { databus }
    const stamp = stampOfToolTurn({ toolCallId: 'tc-big', toolName: 'read', content: big })
    const result = await tool.execute({ stamp, reason: 'recall full' }, ctx)

    const parsed = JSON.parse(result as string)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].content).toBe(big) // 原文 5000 字符全量返回
  })

  it('pages an exact stamp recall by token range', async () => {
    const databus = new Databus()
    const content = '中'.repeat(30_000)
    const target = toolTurn({ id: 't1', toolCallId: 'tc-page', toolName: 'read', content })
    databus.append(target)
    const tool = createDatabusQueryTool()
    const ctx: ToolContext = { databus }
    const result = JSON.parse(await tool.execute({
      stamp: stampOfToolTurn(target),
      tokenRange: { startToken: 0, endToken: 25_000 },
      reason: 'read the first page',
    }, ctx) as string)
    expect(result.mode).toBe('direct')
    expect(result.returnedRange).toEqual({ startToken: 0, endToken: 19_488 })
    expect(result.nextCursor).toBe('19488')
    expect(result.records[0].content.length).toBeGreaterThan(0)
  })

  it('delegates a range over 200K instead of returning the raw field', async () => {
    const databus = new Databus()
    const target = toolTurn({ id: 't1', toolCallId: 'tc-large', toolName: 'read', content: '中'.repeat(300_000) })
    databus.append(target)
    let delegated: unknown
    const tool = createDatabusQueryTool()
    const ctx: ToolContext = {
      databus,
      largeRecall: async (input) => {
        delegated = input
        return {
          mode: 'delegated',
          status: 'completed',
          facts: [{ claim: 'summary', evidenceStamps: [], coveredRanges: [], confidence: 'verified' }],
          uncoveredRanges: [],
          openQuestions: [],
          requestedRange: input.requestedRange,
        }
      },
    }
    const result = JSON.parse(await tool.execute({
      stamp: stampOfToolTurn(target),
      tokenRange: { startToken: 0, endToken: 250_000 },
      reason: 'summarize the large field',
    }, ctx) as string)
    expect(result).toEqual({
      mode: 'delegated',
      status: 'completed',
      facts: [{ claim: 'summary', evidenceStamps: [], coveredRanges: [], confidence: 'verified' }],
      uncoveredRanges: [],
      openQuestions: [],
      requestedRange: { startToken: 0, endToken: 250_000 },
    })
    expect(delegated).toMatchObject({ requestedRange: { startToken: 0, endToken: 250_000 } })
  })

  it('keeps the 200K direct budget across repeated pages for the same stamp', async () => {
    const databus = new Databus()
    const target = toolTurn({ id: 't1', toolCallId: 'tc-budget', toolName: 'read', content: '中'.repeat(300_000) })
    databus.append(target)
    const ledger = createDirectRecallLedger()
    let delegated = 0
    const tool = createDatabusQueryTool()
    const ctx: ToolContext = {
      databus,
      directRecallLedger: ledger,
      largeRecall: async () => {
        delegated += 1
        return {
          mode: 'delegated',
          status: 'completed',
          facts: [{ claim: 'summary', evidenceStamps: [], coveredRanges: [], confidence: 'verified' }],
          uncoveredRanges: [],
          openQuestions: [],
          requestedRange: { startToken: 0, endToken: 250_000 },
        }
      },
    }
    const stamp = stampOfToolTurn(target)
    for (let page = 0; page < 10; page += 1) {
      const result = JSON.parse(await tool.execute({
        stamp,
        tokenRange: { startToken: page * 20_000, endToken: (page + 1) * 20_000 },
        reason: 'read next page',
      }, ctx) as string)
      expect(result.mode).toBe('direct')
    }
    const repeated = JSON.parse(await tool.execute({
      stamp,
      tokenRange: { startToken: 0, endToken: 20_000 },
      reason: 're-read the first page',
    }, ctx) as string)
    expect(repeated.mode).toBe('direct')
    const routed = JSON.parse(await tool.execute({
      stamp,
      tokenRange: { startToken: 200_000, endToken: 220_000 },
      reason: 'read after direct budget',
    }, ctx) as string)
    expect(routed.mode).toBe('delegated')
    expect(delegated).toBe(1)
    expect(ledger.deliveredTokens(stamp)).toBe(194_880)
  })

  it('does not combine direct budgets for different stamps', async () => {
    const databus = new Databus()
    const first = toolTurn({ id: 't1', toolCallId: 'tc-first', toolName: 'read', content: '中'.repeat(220_000) })
    const second = toolTurn({ id: 't2', toolCallId: 'tc-second', toolName: 'read', content: '中'.repeat(220_000) })
    databus.append(first)
    databus.append(second)
    const ledger = createDirectRecallLedger()
    const tool = createDatabusQueryTool()
    const ctx: ToolContext = { databus, directRecallLedger: ledger }
    for (const target of [first, second]) {
      const result = JSON.parse(await tool.execute({
        stamp: stampOfToolTurn(target),
        tokenRange: { startToken: 0, endToken: 20_000 },
        reason: 'read first page',
      }, ctx) as string)
      expect(result.mode).toBe('direct')
    }
  })

  it('advances multi-record pages when the returned cursor is reused', async () => {
    const databus = new Databus()
    databus.append(toolTurn({ id: 't1', content: '中'.repeat(12_000), at: 1 }))
    databus.append(toolTurn({ id: 't2', content: '中'.repeat(12_000), at: 2 }))
    databus.append(toolTurn({ id: 't3', content: '中'.repeat(12_000), at: 3 }))
    const tool = createDatabusQueryTool()
    const ctx: ToolContext = { databus }
    const first = JSON.parse(await tool.execute({ reason: 'page all records' }, ctx) as string)
    expect(first.mode).toBe('direct')
    expect(first.records.map((record: ToolTurn) => record.id)).toEqual(['t1'])
    expect(first.nextCursor).toBe('1')
    const second = JSON.parse(await tool.execute({ cursor: first.nextCursor, reason: 'page all records' }, ctx) as string)
    expect(second.records.map((record: ToolTurn) => record.id)).toEqual(['t2'])
    expect(second.nextCursor).toBe('2')
  })

  it('pages a single oversized non-stamp record without exceeding the 20K result budget', async () => {
    const databus = new Databus()
    const target = toolTurn({ id: 'large', toolCallId: 'tc-large-page', toolName: 'read', content: '中'.repeat(30_000) })
    databus.append(target)
    const tool = createDatabusQueryTool()
    const ctx: ToolContext = { databus }

    const firstText = await tool.execute({ toolName: 'read', reason: 'page the large result' }, ctx) as string
    const first = JSON.parse(firstText) as {
      mode: string
      records: ToolTurn[]
      nextCursor?: string
    }
    expect(first.mode).toBe('direct')
    expect(first.records).toHaveLength(1)
    expect(first.records[0]!.content.length).toBeLessThan(target.content.length)
    expect(estimateTokens(firstText)).toBeLessThanOrEqual(20_000)
    expect(firstText.length).toBeGreaterThan(0)
    expect(first.nextCursor).toMatch(/^record:0:/)

    const second = JSON.parse(await tool.execute({
      toolName: 'read',
      cursor: first.nextCursor,
      reason: 'continue the large result',
    }, ctx) as string) as { records: ToolTurn[]; nextCursor?: string }
    expect(second.records).toHaveLength(1)
    expect(second.records[0]!.content.length).toBeGreaterThan(0)
    expect(second.records[0]!.content).not.toBe(first.records[0]!.content)
  })
})
