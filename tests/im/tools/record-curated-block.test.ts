// record_curated_block tool tests.
//
// v0.12.4: record_curated_block is retired (no longer registered). The
// compressor now returns CuratedMemory JSON as its final reply and the
// drive-coordinator persists it atomically. These tests keep the retired
// tool's basic behavior covered (it still compiles as a reference
// implementation): appendBlock is called with layer 'M1' (default, no
// compressZone threading) and no explicit stamp (appendBlock generates one
// internally). The compressZone/compressStamp threading was removed along
// with the retirement.

import { describe, it, expect } from 'vitest'
import { createRecordCuratedBlockTool } from '../../../src/im/tools/record-curated-block.js'
import type { ToolContext } from '../../../src/shared/tool-context.js'
import type { StateLine, CuratedMemory } from '../../../src/im/state-line/types.js'

const validBlock: CuratedMemory = {
  task_goal: 'goal',
  causal_steps: [],
  evidence_fragments: [],
  conclusion: 'c',
  next_action: 'na',
  working_state: {
    current_goal: 'g',
    effective_decisions: [],
    rejected_decisions: [],
    architecture_boundaries: [],
    remaining_work: [],
  },
}

// Captures every appendBlock invocation: (block, layer, stamp?).
const createCapturingStateLine = (): StateLine & {
  calls: Array<{ layer: 'M1' | 'M2'; stamp?: string }>
} => {
  const calls: Array<{ layer: 'M1' | 'M2'; stamp?: string }> = []
  return {
    compressor: {
      async appendBlock(_block: CuratedMemory, layer: 'M1' | 'M2' = 'M2', stamp?: string) {
        // Record only set fields so the captured object matches the
        // { layer; stamp?: string } shape under exactOptionalPropertyTypes.
        const entry: { layer: 'M1' | 'M2'; stamp?: string } = { layer }
        if (stamp !== undefined) entry.stamp = stamp
        calls.push(entry)
      },
    },
    warehouse: {
      async appendSummary() {},
      async queryM3() { return { ok: false, error: 'mock' } },
    },
    rawArchive: {
      async append() {},
      async query() { return [] },
    },
    query: () => [],
    subscribe: () => () => {},
    close() {},
    calls,
  }
}

describe('im/tools/record-curated-block (retired reference — v0.12.4)', () => {
  it('calls appendBlock with default layer M1 and no explicit stamp', async () => {
    const sl = createCapturingStateLine()
    const tool = createRecordCuratedBlockTool()
    const ctx: ToolContext = { stateLine: sl }

    const result = await tool.execute({ block: validBlock, reason: 'retired reference path' }, ctx)

    expect(result).toEqual({ ok: true, layer: 'M1' })
    expect(sl.calls).toHaveLength(1)
    expect(sl.calls[0]!.layer).toBe('M1')
    // No stamp threaded (compressStamp removed) → appendBlock generates internally.
    expect(sl.calls[0]!.stamp).toBeUndefined()
  })

  it('throws when stateLine is missing from ctx', async () => {
    const tool = createRecordCuratedBlockTool()
    await expect(
      tool.execute({ block: validBlock, reason: 'no stateLine' }),
    ).rejects.toThrow('record_curated_block requires a stateLine in the tool context')
  })
})
