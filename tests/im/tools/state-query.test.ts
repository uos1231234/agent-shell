import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStateLine } from '../../../src/im/state-line/index.js'
import { createStateQueryTool } from '../../../src/im/tools/state-query.js'
import type { CuratedMemory, M3Summary, StateLine, RawArchiveRecord } from '../../../src/im/state-line/types.js'
import type { ToolContext } from '../../../src/shared/tool-context.js'

const validBlock: CuratedMemory = {
  task_goal: 'goal',
  causal_steps: [{ intent: 'i', tool_action: 'a', result: 'r' }],
  evidence_fragments: [{ source: 's', fragment: 'f', relevance: 'rel' }],
  conclusion: 'c',
  next_action: 'n',
  working_state: {
    current_goal: 'g',
    effective_decisions: ['d'],
    rejected_decisions: [],
    architecture_boundaries: [],
    remaining_work: [],
  },
}

describe('im/tools/state-query', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'state-query-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('state_query({stamps}) returns matching M3 block', async () => {
    const sl = createStateLine({ databusPath: tmpDir })
    const { appendJsonl } = await import('../../../src/im/state-line/jsonl-writer.js')
    const { appendStamp } = await import('../../../src/im/state-line/append-stamp.js')
    const indexPath = join(tmpDir, 'state', 'index.jsonl')
    const stampsPath = join(tmpDir, 'state', 'stamps.jsonl')

    const summary: M3Summary = {
      stamp: 'S-query-1',
      m1_stamp: 'M1-0',
      summary_text: 'test summary',
      layer: 'M3',
      at: Date.now(),
    }
    await appendJsonl(indexPath, summary)
    await appendStamp(stampsPath, 'S-query-1', 'index.jsonl', 'M3')

    const tool = createStateQueryTool()
    const ctx: ToolContext = { stateLine: sl }
    const result = await tool.execute({ stamps: ['S-query-1'], reason: 'test' }, ctx)

    const parsed = JSON.parse(result as string)
    expect(parsed.results.length).toBe(1)
    expect(parsed.results[0].stamp).toBe('S-query-1')
  })

  it('state_query({layer:"M3"}) returns all M3 summaries', async () => {
    const sl = createStateLine({ databusPath: tmpDir })
    const { appendJsonl } = await import('../../../src/im/state-line/jsonl-writer.js')
    const { appendStamp } = await import('../../../src/im/state-line/append-stamp.js')
    const indexPath = join(tmpDir, 'state', 'index.jsonl')
    const stampsPath = join(tmpDir, 'state', 'stamps.jsonl')

    for (let i = 0; i < 3; i++) {
      const s: M3Summary = {
        stamp: `S-${i}`,
        m1_stamp: 'M1-0',
        summary_text: `summary ${i}`,
        layer: 'M3',
        at: Date.now(),
      }
      await appendJsonl(indexPath, s)
      await appendStamp(stampsPath, `S-${i}`, 'index.jsonl', 'M3')
    }

    const tool = createStateQueryTool()
    const ctx: ToolContext = { stateLine: sl }
    const result = await tool.execute({ layer: 'M3', reason: 'list M3' }, ctx)

    const parsed = JSON.parse(result as string)
    expect(parsed.results.length).toBe(3)
  })

  it('state_query({queryText}) routes to chromadb RAG', async () => {
    // Create a stateLine with mocked queryM3.
    const sl = createStateLine({ databusPath: tmpDir })
    // Override queryM3 to return a canned response.
    const mockSl: StateLine = {
      ...sl,
      warehouse: {
        ...sl.warehouse,
        queryM3: async () => ({
          ok: true,
          results: [{ stamp: 'S-rag-1', distance: 0.3, document: 'rag result' }],
        }),
      },
    }

    const tool = createStateQueryTool()
    const ctx: ToolContext = { stateLine: mockSl }
    const result = await tool.execute({ queryText: 'find something', limit: 5, reason: 'rag' }, ctx)

    const parsed = JSON.parse(result as string)
    expect(parsed.ok).toBe(true)
    expect(parsed.results[0].stamp).toBe('S-rag-1')
    expect(parsed.results[0].distance).toBe(0.3)
  })

  it('state_query without stateLine returns "not configured" message', async () => {
    const tool = createStateQueryTool()
    // No ctx — stateLine is undefined.
    const result = await tool.execute({ reason: 'test' })
    expect(result).toBe('state-line not configured; provide a StateLine instance to enable state_query')
  })

  it('empty reason is rejected', async () => {
    const tool = createStateQueryTool()
    // P0: wrapTool re-throws; loop.ts formats the sentence.
    await expect(tool.execute({ reason: '' })).rejects.toThrow('state_query requires a "reason"')
  })

  // Stage 2b: raw-archive query via rawArchiveIds / rawSummaryStamps.
  it('state_query({ rawArchiveIds }) returns original archived messages', async () => {
    const sl = createStateLine({ databusPath: tmpDir })
    const { appendJsonl } = await import('../../../src/im/state-line/jsonl-writer.js')
    const rawPath = join(tmpDir, 'state', 'raw-archive.jsonl')

    // Seed a raw archive record with full original messages.
    const record: RawArchiveRecord = {
      archiveId: 'RA-test-1',
      sourceTurnIds: ['turn-1', 'turn-2'],
      messages: [
        { role: 'user', content: 'original user message' },
        { role: 'assistant', content: 'original assistant response' },
      ],
      layer: 'M1',
      at: 12345,
      summaryStamp: 'S-cm-1',
    }
    await appendJsonl(rawPath, record)

    const tool = createStateQueryTool()
    const ctx: ToolContext = { stateLine: sl }
    const result = await tool.execute({ rawArchiveIds: ['RA-test-1'], reason: 'deep recall' }, ctx)

    const parsed = JSON.parse(result as string)
    expect(parsed.rawArchive).toHaveLength(1)
    expect(parsed.rawArchive[0].archiveId).toBe('RA-test-1')
    expect(parsed.rawArchive[0].messages).toHaveLength(2)
    expect(parsed.rawArchive[0].messages[0].content).toBe('original user message')
    expect(parsed.rawArchive[0].messages[1].content).toBe('original assistant response')
  })

  it('state_query({ rawSummaryStamps }) returns raw records by summaryStamp', async () => {
    const sl = createStateLine({ databusPath: tmpDir })
    const { appendJsonl } = await import('../../../src/im/state-line/jsonl-writer.js')
    const rawPath = join(tmpDir, 'state', 'raw-archive.jsonl')

    await appendJsonl(rawPath, {
      archiveId: 'RA-a', sourceTurnIds: ['t1'], messages: [{ role: 'user', content: 'msg-a' }],
      layer: 'M1', at: 100, summaryStamp: 'S-cm-a',
    })
    await appendJsonl(rawPath, {
      archiveId: 'RA-b', sourceTurnIds: ['t2'], messages: [{ role: 'user', content: 'msg-b' }],
      layer: 'M2', at: 200, summaryStamp: 'S-cm-b',
    })

    const tool = createStateQueryTool()
    const ctx: ToolContext = { stateLine: sl }
    const result = await tool.execute({ rawSummaryStamps: ['S-cm-b'], reason: 'stamp recall' }, ctx)

    const parsed = JSON.parse(result as string)
    expect(parsed.rawArchive).toHaveLength(1)
    expect(parsed.rawArchive[0].archiveId).toBe('RA-b')
    expect(parsed.rawArchive[0].messages[0].content).toBe('msg-b')
  })

  it('state_query({ rawArchiveIds }) with no match returns empty array', async () => {
    const sl = createStateLine({ databusPath: tmpDir })
    const tool = createStateQueryTool()
    const ctx: ToolContext = { stateLine: sl }
    const result = await tool.execute({ rawArchiveIds: ['RA-nonexistent'], reason: 'miss' }, ctx)

    const parsed = JSON.parse(result as string)
    expect(parsed.rawArchive).toHaveLength(0)
  })
})
