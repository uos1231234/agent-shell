import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { Databus, stampOfToolTurn, type ToolTurn } from '../../src/im/databus.js'
import type { ChatMessage } from '../../src/protocol/types.js'
import { parseLargeRecallReport, runLargeRecall } from '../../src/im/system-agents/large-recall.js'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

const requestedRange = { startToken: 0, endToken: 250_000 }

const validReportJson = JSON.stringify({
  facts: [
    {
      claim: 'The retry path double-writes chunk 7',
      evidenceStamps: ['S-1-aaaaaa'],
      coveredRanges: [{ startToken: 0, endToken: 20_000 }],
      confidence: 'verified',
    },
  ],
  uncoveredRanges: [{ startToken: 20_000, endToken: 250_000 }],
  openQuestions: ['Whether chunk 7 predates the crash window'],
})

describe('parseLargeRecallReport', () => {
  it('parses a plain JSON report into structured facts', () => {
    const report = parseLargeRecallReport(validReportJson, requestedRange)
    expect(report.mode).toBe('delegated')
    expect(report.status).toBe('completed')
    expect(report.extractionMode).toBe('plain-json')
    expect(report.facts).toEqual([{
      claim: 'The retry path double-writes chunk 7',
      evidenceStamps: ['S-1-aaaaaa'],
      coveredRanges: [{ startToken: 0, endToken: 20_000 }],
      confidence: 'verified',
    }])
    expect(report.uncoveredRanges).toEqual([{ startToken: 20_000, endToken: 250_000 }])
    expect(report.openQuestions).toEqual(['Whether chunk 7 predates the crash window'])
    expect(report.requestedRange).toEqual(requestedRange)
    expect(report.rawOutputPath).toBeUndefined()
  })

  it('extracts fenced JSON wrapped in prose', () => {
    const raw = `I have read the range. Here is the report.\n\n\`\`\`json\n${validReportJson}\n\`\`\`\n\nReport to parent agent: done.`
    const report = parseLargeRecallReport(raw, requestedRange)
    expect(report.status).toBe('completed')
    expect(report.extractionMode).toBe('fenced-json')
    expect(report.facts).toHaveLength(1)
  })

  it('extracts embedded JSON between prose', () => {
    const raw = `Findings below.\n${validReportJson}\nEnd of findings.`
    const report = parseLargeRecallReport(raw, requestedRange)
    expect(report.status).toBe('completed')
    expect(report.extractionMode).toBe('embedded-json')
  })

  it('returns invalid-report when the output carries no JSON', () => {
    const report = parseLargeRecallReport('I found the relevant section but have no time to detail it.', requestedRange)
    expect(report.status).toBe('invalid-report')
    expect(report.facts).toEqual([])
    expect(report.extractionMode).toBe('invalid')
    expect(report.openQuestions[0]).toContain('not valid structured JSON')
  })

  it('returns invalid-report when facts are empty — a bare "found it" is not a hit', () => {
    const report = parseLargeRecallReport(JSON.stringify({ facts: [], openQuestions: [] }), requestedRange)
    expect(report.status).toBe('invalid-report')
    expect(report.extractionMode).toBe('invalid')
  })

  it('tolerates object evidence, bad confidence and malformed ranges with warnings', () => {
    const raw = JSON.stringify({
      facts: [{
        claim: 'claim',
        evidenceStamps: [{ stamp: 'S-2-bbbbbb' }, { evidenceStamp: 'S-3-cccccc' }, 42],
        coveredRanges: [{ startToken: 0, endToken: 100 }, { startToken: 'x' }],
        confidence: 'certain',
      }],
      uncoveredRanges: 'not-an-array',
      openQuestions: [{ question: 'q1' }, 'q2'],
    })
    const report = parseLargeRecallReport(raw, requestedRange)
    expect(report.status).toBe('completed')
    expect(report.facts[0]!.evidenceStamps).toEqual(['S-2-bbbbbb', 'S-3-cccccc'])
    expect(report.facts[0]!.confidence).toBe('unknown')
    expect(report.facts[0]!.coveredRanges).toEqual([{ startToken: 0, endToken: 100 }])
    expect(report.uncoveredRanges).toEqual([])
    expect(report.openQuestions).toEqual(['q1', 'q2'])
    expect(report.warnings?.length).toBeGreaterThan(0)
  })
})

const makeTurn = (content: string): ToolTurn => ({
  id: `tool-${content.length}`,
  role: 'tool',
  toolCallId: `call-${content.length}`,
  toolName: 'read',
  sourceAgentId: 'main',
  at: 1,
  content,
})

const fakeRecallAgent = (output: unknown, reason: 'completed' | 'guard-tripped' = 'completed') => {
  const calls: Array<{ messages: ChatMessage[]; metadata?: Record<string, unknown> }> = []
  return {
    calls,
    run: async (input: { messages: ChatMessage[]; metadata?: Record<string, unknown> }) => {
      calls.push(input)
      return { output, metrics: undefined as never, finalState: undefined as never, reason, hits: [] }
    },
  }
}

describe('runLargeRecall', () => {
  it('parses the structured report, persists the raw output and narrows the tool surface', async () => {
    const root = mkdtempSync(join(tmpdir(), 'large-recall-'))
    roots.push(root)
    const rawOutputDir = join(root, 'state', 'large-recall')
    const turn = makeTurn('x'.repeat(100))
    const agent = fakeRecallAgent(validReportJson)
    const report = await runLargeRecall(
      {
        question: 'what does the retry path do',
        stamp: stampOfToolTurn(turn),
        requestedRange,
        sourceDatabus: { turns: () => [turn] },
      },
      { recallAgent: agent, sessionId: 'sess-1', rawOutputDir },
    )
    expect(report.status).toBe('completed')
    expect(report.facts).toHaveLength(1)
    expect(report.rawOutputPath).toBeDefined()
    expect(existsSync(report.rawOutputPath!)).toBe(true)
    expect(readFileSync(report.rawOutputPath!, 'utf8')).toBe(validReportJson)

    const call = agent.calls[0]!
    const meta = call.metadata!
    expect(meta.toolRefsOverride).toEqual(['databus_query', 'state_query'])
    expect(meta.directRecallLimitTokens).toBe(Number.POSITIVE_INFINITY)
    expect((meta.contextDatabus as Databus).turns()).toHaveLength(1)
    const payload = JSON.parse(call.messages[0]!.content as string) as Record<string, unknown>
    expect(payload.kind).toBe('large-databus-recall')
    expect(payload.question).toBe('what does the retry path do')
    expect(payload.stamp).toBe(stampOfToolTurn(turn))
    expect(String(payload.instruction)).toContain('databus_query')
  })

  it('reports guard-tripped and still persists the raw output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'large-recall-'))
    roots.push(root)
    const agent = fakeRecallAgent('partial output before the guard tripped', 'guard-tripped')
    const report = await runLargeRecall(
      { question: 'q', requestedRange, sourceDatabus: { turns: () => [] } },
      { recallAgent: agent, sessionId: 'sess-2', rawOutputDir: join(root, 'raw') },
    )
    expect(report.status).toBe('guard-tripped')
    expect(report.facts).toEqual([])
    expect(report.openQuestions[0]).toContain('guard')
    expect(existsSync(report.rawOutputPath!)).toBe(true)
    expect(readFileSync(report.rawOutputPath!, 'utf8')).toBe('partial output before the guard tripped')
  })
})
