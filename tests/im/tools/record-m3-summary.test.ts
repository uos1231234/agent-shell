// record_m3_summary tool tests (stage 2b).
//
// Verifies:
//  - When ctx.archiveSourceStamps / ctx.archiveRawArchiveIds are set, they
//    are merged into the persisted M3Summary as source_summary_stamps /
//    raw_archive_ids, overriding anything the LLM put in the summary object.
//  - When ctx archive metadata is absent, the summary is passed through as-is
//    (backward compatible — no join fields added).
//  - The returned stamp matches the summary's stamp.

import { describe, it, expect } from 'vitest'
import { createRecordM3SummaryTool } from '../../../src/im/tools/record-m3-summary.js'
import type { ToolContext } from '../../../src/shared/tool-context.js'
import type { StateLine, M3Summary } from '../../../src/im/state-line/types.js'

// Captures every appendSummary invocation: the M3Summary that was persisted.
const createCapturingStateLine = (): StateLine & {
  captured: M3Summary[]
} => {
  const captured: M3Summary[] = []
  return {
    compressor: {
      async appendBlock() {},
    },
    warehouse: {
      async appendSummary(summary: M3Summary) { captured.push(summary) },
      async queryM3() { return { ok: false, error: 'mock' } },
    },
    rawArchive: {
      async append() {},
      async query() { return [] },
    },
    query: () => [],
    subscribe: () => () => {},
    close() {},
    captured,
  }
}

const baseSummary = (stamp: string): M3Summary => ({
  stamp,
  m1_stamp: 'S-m1-0',
  summary_text: 'test summary',
  layer: 'M3',
  at: 1000,
})

describe('im/tools/record-m3-summary (stage 2b Node-side metadata merge)', () => {
  it('merges ctx.archiveSourceStamps and ctx.archiveRawArchiveIds into the summary', async () => {
    const sl = createCapturingStateLine()
    const tool = createRecordM3SummaryTool()
    const ctx: ToolContext = {
      stateLine: sl,
      archiveSourceStamps: ['S-cm-1', 'S-cm-2'],
      archiveRawArchiveIds: ['RA-1', 'RA-2'],
    }
    // The LLM-supplied summary has NO join fields (and even if it did, they
    // would be overridden by the ctx values).
    const result = await tool.execute(
      { summary: baseSummary('S-m3-1'), reason: 'archive' },
      ctx,
    )

    expect(sl.captured).toHaveLength(1)
    const persisted = sl.captured[0]!
    expect(persisted.stamp).toBe('S-m3-1')
    expect(persisted.source_summary_stamps).toEqual(['S-cm-1', 'S-cm-2'])
    expect(persisted.raw_archive_ids).toEqual(['RA-1', 'RA-2'])
    // summary_text and other LLM-filled fields are preserved.
    expect(persisted.summary_text).toBe('test summary')
    expect(persisted.layer).toBe('M3')

    expect(result).toEqual({ ok: true, stamp: 'S-m3-1' })
  })

  it('overrides LLM-supplied join fields with ctx values (Node is authoritative)', async () => {
    const sl = createCapturingStateLine()
    const tool = createRecordM3SummaryTool()
    const ctx: ToolContext = {
      stateLine: sl,
      archiveSourceStamps: ['S-correct-1'],
      archiveRawArchiveIds: ['RA-correct-1'],
    }
    // The LLM fabricated wrong join fields — the system must override them.
    const llmSummary: M3Summary = {
      ...baseSummary('S-m3-2'),
      source_summary_stamps: ['S-WRONG'],
      raw_archive_ids: ['RA-WRONG'],
    }
    await tool.execute({ summary: llmSummary, reason: 'archive' }, ctx)

    const persisted = sl.captured[0]!
    expect(persisted.source_summary_stamps).toEqual(['S-correct-1'])
    expect(persisted.raw_archive_ids).toEqual(['RA-correct-1'])
  })

  it('passes summary through as-is when ctx has no archive metadata (backward compatible)', async () => {
    const sl = createCapturingStateLine()
    const tool = createRecordM3SummaryTool()
    const ctx: ToolContext = { stateLine: sl }
    const summary = baseSummary('S-m3-3')
    await tool.execute({ summary, reason: 'archive' }, ctx)

    const persisted = sl.captured[0]!
    expect(persisted.stamp).toBe('S-m3-3')
    // No join fields added — exactOptionalPropertyTypes compatible.
    expect(persisted.source_summary_stamps).toBeUndefined()
    expect(persisted.raw_archive_ids).toBeUndefined()
  })

  it('merges only archiveSourceStamps when archiveRawArchiveIds is absent', async () => {
    const sl = createCapturingStateLine()
    const tool = createRecordM3SummaryTool()
    const ctx: ToolContext = {
      stateLine: sl,
      archiveSourceStamps: ['S-cm-1'],
    }
    await tool.execute({ summary: baseSummary('S-m3-4'), reason: 'archive' }, ctx)

    const persisted = sl.captured[0]!
    expect(persisted.source_summary_stamps).toEqual(['S-cm-1'])
    expect(persisted.raw_archive_ids).toBeUndefined()
  })

  it('throws when stateLine is not in ctx', async () => {
    const tool = createRecordM3SummaryTool()
    await expect(
      tool.execute({ summary: baseSummary('S-m3-5'), reason: 'archive' }),
    ).rejects.toThrow('record_m3_summary requires a stateLine in the tool context')
  })

  it('empty reason is rejected', async () => {
    const sl = createCapturingStateLine()
    const tool = createRecordM3SummaryTool()
    const ctx: ToolContext = { stateLine: sl }
    await expect(
      tool.execute({ summary: baseSummary('S-m3-6'), reason: '' }, ctx),
    ).rejects.toThrow('record_m3_summary requires a "reason"')
  })
})
