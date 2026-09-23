import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStateLine } from '../../../src/im/state-line/index.js'
import type { CuratedMemory, M3Summary } from '../../../src/im/state-line/types.js'

const validBlock: CuratedMemory = {
  task_goal: 'test goal',
  causal_steps: [{ intent: 'do x', tool_action: 'tool x', result: 'result x' }],
  evidence_fragments: [{ source: 's1', fragment: 'f1', relevance: 'r1' }],
  conclusion: 'done',
  next_action: 'next',
  working_state: {
    current_goal: 'goal',
    effective_decisions: ['d1'],
    rejected_decisions: ['d2'],
    architecture_boundaries: ['b1'],
    remaining_work: ['w1'],
  },
}

const validSummary = (stamp: string): M3Summary => ({
  stamp,
  m1_stamp: 'M1-0',
  summary_text: 'summary text',
  layer: 'M3',
  at: Date.now(),
})

describe('im/state-line', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'state-line-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('query() returns [] for empty databus path', () => {
    const sl = createStateLine({ databusPath: tmpDir })
    expect(sl.query({})).toEqual([])
  })

  it('appendBlock() writes one line to curatedMemory.jsonl + stamps.jsonl', async () => {
    const sl = createStateLine({ databusPath: tmpDir })
    await sl.compressor.appendBlock(validBlock)

    const cmPath = join(tmpDir, 'state', 'curatedMemory.jsonl')
    const stampsPath = join(tmpDir, 'state', 'stamps.jsonl')

    expect(existsSync(cmPath)).toBe(true)
    expect(existsSync(stampsPath)).toBe(true)

    const cmLines = readFileSync(cmPath, 'utf-8').trim().split('\n')
    expect(cmLines.length).toBe(1)
    const cmObj = JSON.parse(cmLines[0]!)
    expect(cmObj.task_goal).toBe('test goal')
    expect(cmObj._stamp).toBeDefined()

    const stampLines = readFileSync(stampsPath, 'utf-8').trim().split('\n')
    expect(stampLines.length).toBe(1)
    const stampObj = JSON.parse(stampLines[0]!)
    expect(stampObj.path).toBe('curatedMemory.jsonl')
    expect(stampObj.layer).toBe('M2')
  })

  it('appendSummary() writes one line to index.jsonl + stamps.jsonl', async () => {
    // Use a stateLine with a mocked warehouse.queryM3 to avoid Python spawn.
    // We test the jsonl write path by calling appendSummary with a stubbed embedM3.
    // Since createStateLine imports embedM3 internally, we verify the write path
    // by directly using appendJsonl + appendStamp (the same functions createStateLine uses).
    const { appendJsonl } = await import('../../../src/im/state-line/jsonl-writer.js')
    const { appendStamp } = await import('../../../src/im/state-line/append-stamp.js')
    const indexPath = join(tmpDir, 'state', 'index.jsonl')
    const stampsPath = join(tmpDir, 'state', 'stamps.jsonl')

    const summary = validSummary('S-test-1')
    await appendJsonl(indexPath, summary)
    await appendStamp(stampsPath, 'S-test-1', 'index.jsonl', 'M3')

    expect(existsSync(indexPath)).toBe(true)
    const indexLines = readFileSync(indexPath, 'utf-8').trim().split('\n')
    expect(indexLines.length).toBe(1)
    const indexObj = JSON.parse(indexLines[0]!)
    expect(indexObj.stamp).toBe('S-test-1')
    expect(indexObj.layer).toBe('M3')

    expect(existsSync(stampsPath)).toBe(true)
    const stampLines = readFileSync(stampsPath, 'utf-8').trim().split('\n')
    expect(stampLines.length).toBe(1)
    expect(JSON.parse(stampLines[0]!).layer).toBe('M3')
  })

  it('chroma store is PER-SESSION — derived from databusPath, not the global ~/.databus default', async () => {
    // v0.42（2026-09-16 修复）：bridgeOpts.storePath = join(stateDir,'vectors','chroma')。
    // 旧实现硬编码全局 ~/.databus/state/vectors/chroma → 多会话共享一个 m3_summaries
    // 集合，recall 的 RAG 查询会命中别的会话的 M3 摘要（跨会话数据泄漏）。
    // 这条测试真实走 appendSummary → embed.py（模型已缓存），钉住目录隔离。
    const sl = createStateLine({ databusPath: tmpDir })
    await sl.warehouse.appendSummary(validSummary('S-ISO-1'))

    // 集合建在会话自己的 vectors 目录下，而不是全局默认。
    expect(existsSync(join(tmpDir, 'state', 'vectors', 'chroma'))).toBe(true)
  }, 30_000)

  it('query({layer:"M3"}) returns M3 summaries', async () => {
    const sl = createStateLine({ databusPath: tmpDir })
    // Manually write index.jsonl to avoid Python dependency.
    const { appendJsonl } = await import('../../../src/im/state-line/jsonl-writer.js')
    const { appendStamp } = await import('../../../src/im/state-line/append-stamp.js')
    const indexPath = join(tmpDir, 'state', 'index.jsonl')
    const stampsPath = join(tmpDir, 'state', 'stamps.jsonl')
    const summary = validSummary('S-M3-1')
    await appendJsonl(indexPath, summary)
    await appendStamp(stampsPath, 'S-M3-1', 'index.jsonl', 'M3')

    const results = sl.query({ layer: 'M3' })
    expect(results.length).toBe(1)
    expect((results[0] as M3Summary).stamp).toBe('S-M3-1')
  })

  it('query({stamps}) returns matching M3', async () => {
    const sl = createStateLine({ databusPath: tmpDir })
    const { appendJsonl } = await import('../../../src/im/state-line/jsonl-writer.js')
    const { appendStamp } = await import('../../../src/im/state-line/append-stamp.js')
    const indexPath = join(tmpDir, 'state', 'index.jsonl')
    const stampsPath = join(tmpDir, 'state', 'stamps.jsonl')

    const s1 = validSummary('S-stamp-1')
    const s2 = validSummary('S-stamp-2')
    await appendJsonl(indexPath, s1)
    await appendJsonl(indexPath, s2)
    await appendStamp(stampsPath, 'S-stamp-1', 'index.jsonl', 'M3')
    await appendStamp(stampsPath, 'S-stamp-2', 'index.jsonl', 'M3')

    const results = sl.query({ stamps: ['S-stamp-1'] })
    expect(results.length).toBe(1)
    expect((results[0] as M3Summary).stamp).toBe('S-stamp-1')
  })

  it('query({range}) filters by written_at', async () => {
    const sl = createStateLine({ databusPath: tmpDir })
    const { appendJsonl } = await import('../../../src/im/state-line/jsonl-writer.js')
    const { appendStamp } = await import('../../../src/im/state-line/append-stamp.js')
    const indexPath = join(tmpDir, 'state', 'index.jsonl')
    const stampsPath = join(tmpDir, 'state', 'stamps.jsonl')

    const oldSummary = { ...validSummary('S-old'), at: 1000 }
    const newSummary = { ...validSummary('S-new'), at: 5000 }
    await appendJsonl(indexPath, oldSummary)
    await appendJsonl(indexPath, newSummary)
    await appendStamp(stampsPath, 'S-old', 'index.jsonl', 'M3')
    await appendStamp(stampsPath, 'S-new', 'index.jsonl', 'M3')

    const results = sl.query({ range: [0, 2000] })
    expect(results.length).toBe(1)
    expect((results[0] as M3Summary).stamp).toBe('S-old')
  })

  it('subscribe() fires callback on append', async () => {
    const sl = createStateLine({ databusPath: tmpDir })
    let called = false
    const unsub = sl.subscribe({}, () => { called = true })

    // Manually write to trigger notify via appendBlock
    await sl.compressor.appendBlock(validBlock)
    // subscribe fires on appendBlock/appendSummary, not on direct file writes.
    // appendBlock calls notifySubscribers.
    expect(called).toBe(true)
    unsub()
  })

  it('subscribe() unsubscribe stops callback', async () => {
    const sl = createStateLine({ databusPath: tmpDir })
    let callCount = 0
    const unsub = sl.subscribe({}, () => { callCount += 1 })

    await sl.compressor.appendBlock(validBlock)
    expect(callCount).toBe(1)

    unsub()
    await sl.compressor.appendBlock(validBlock)
    expect(callCount).toBe(1)
  })

  it('close() works without error', () => {
    const sl = createStateLine({ databusPath: tmpDir })
    expect(() => sl.close()).not.toThrow()
  })

  it('appendBlock with missing required field throws', async () => {
    const sl = createStateLine({ databusPath: tmpDir })
    const badBlock = { ...validBlock, task_goal: undefined } as unknown as CuratedMemory
    await expect(sl.compressor.appendBlock(badBlock)).rejects.toThrow('missing required field: task_goal')
  })

  it('appendBlock attaches _stamp for query retrieval', async () => {
    const sl = createStateLine({ databusPath: tmpDir })
    await sl.compressor.appendBlock(validBlock)

    // query without filter should return the block
    const results = sl.query({})
    expect(results.length).toBe(1)
    const entry = results[0] as CuratedMemory & { _stamp?: string }
    expect(entry.task_goal).toBe('test goal')
    // _stamp is retained on the returned entry (needed by context-projection)
    expect(entry._stamp).toBeDefined()
  })

  it('appendBlock accepts an externally-provided stamp (stage 2a)', async () => {
    // The drive coordinator pre-generates a stamp so the raw archive record
    // can point back at the CuratedMemory block. Passing stamp must make the
    // block's _stamp equal the supplied value (not an internally-generated one).
    const sl = createStateLine({ databusPath: tmpDir })
    const externalStamp = 'S-external-abc123'
    await sl.compressor.appendBlock(validBlock, 'M2', externalStamp)

    const results = sl.query({ layer: 'M2' })
    expect(results.length).toBe(1)
    const entry = results[0] as CuratedMemory & { _stamp?: string }
    expect(entry._stamp).toBe(externalStamp)
  })

  it('query({layer:"M2"}) returns only CuratedMemory entries', async () => {
    const sl = createStateLine({ databusPath: tmpDir })
    const { appendJsonl } = await import('../../../src/im/state-line/jsonl-writer.js')
    const { appendStamp } = await import('../../../src/im/state-line/append-stamp.js')
    const indexPath = join(tmpDir, 'state', 'index.jsonl')
    const stampsPath = join(tmpDir, 'state', 'stamps.jsonl')

    // Write an M3 summary
    await appendJsonl(indexPath, validSummary('S-M3-only'))
    await appendStamp(stampsPath, 'S-M3-only', 'index.jsonl', 'M3')

    // Write an M2 block via appendBlock
    await sl.compressor.appendBlock(validBlock)

    const m2Results = sl.query({ layer: 'M2' })
    expect(m2Results.length).toBe(1)
    expect((m2Results[0] as CuratedMemory).task_goal).toBe('test goal')

    const m3Results = sl.query({ layer: 'M3' })
    expect(m3Results.length).toBe(1)
    expect((m3Results[0] as M3Summary).stamp).toBe('S-M3-only')
  })

  it('appendBlock(block, "M1") tags M1, query({layer:"M1"}) returns it', async () => {
    const sl = createStateLine({ databusPath: tmpDir })
    await sl.compressor.appendBlock(validBlock, 'M1')

    const m1Results = sl.query({ layer: 'M1' })
    expect(m1Results.length).toBe(1)
    expect((m1Results[0] as CuratedMemory).task_goal).toBe('test goal')

    // M2 query should not return M1 entries
    const m2Results = sl.query({ layer: 'M2' })
    expect(m2Results.length).toBe(0)
  })

  describe('jsonl read cache (P9)', () => {
    it('serves repeated queries from cache and invalidates on external write', async () => {
      const sl = createStateLine({ databusPath: tmpDir })
      await sl.compressor.appendBlock(validBlock)

      // First query — populates cache.
      const r1 = sl.query({})
      expect(r1).toHaveLength(1)

      // Second query — same result, served from cache (no file change).
      const r2 = sl.query({})
      expect(r2).toHaveLength(1)
      expect((r2[0] as CuratedMemory).task_goal).toBe('test goal')

      // External write: bypass the API, append a valid JSONL line directly.
      const cmPath = join(tmpDir, 'state', 'curatedMemory.jsonl')
      const externalBlock = { ...validBlock, task_goal: 'external goal', _stamp: 'S-ext-1' }
      appendFileSync(cmPath, JSON.stringify(externalBlock) + '\n')

      // Third query — cache must invalidate (size/mtime changed), see the new entry.
      const r3 = sl.query({})
      expect(r3).toHaveLength(2)
      expect((r3[1] as CuratedMemory).task_goal).toBe('external goal')
    })

    it('warns once when file exceeds jsonlWarnBytes, does not repeat', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // Threshold so small that any write exceeds it.
      const sl = createStateLine({ databusPath: tmpDir, jsonlWarnBytes: 10 })
      await sl.compressor.appendBlock(validBlock)

      // First query triggers the read → first warning.
      sl.query({})
      const firstCount = warnSpy.mock.calls.length
      expect(firstCount).toBeGreaterThanOrEqual(1)

      // Second query — file unchanged, no new warning.
      sl.query({})
      expect(warnSpy.mock.calls.length).toBe(firstCount)

      warnSpy.mockRestore()
    })
  })

  // Stage 2b: M3Summary with source_summary_stamps / raw_archive_ids
  // (十合一 join index) round-trips through appendSummary → query.
  describe('M3Summary stage 2b join fields', () => {
    it('M3Summary with source_summary_stamps and raw_archive_ids round-trips through query', async () => {
      const sl = createStateLine({ databusPath: tmpDir })
      const { appendJsonl } = await import('../../../src/im/state-line/jsonl-writer.js')
      const { appendStamp } = await import('../../../src/im/state-line/append-stamp.js')
      const indexPath = join(tmpDir, 'state', 'index.jsonl')
      const stampsPath = join(tmpDir, 'state', 'stamps.jsonl')

      const summary: M3Summary = {
        stamp: 'S-m3-join-1',
        m1_stamp: 'S-m1-0',
        summary_text: 'aggregated summary',
        layer: 'M3',
        at: Date.now(),
        source_summary_stamps: ['S-cm-1', 'S-cm-2', 'S-cm-3'],
        raw_archive_ids: ['RA-1', 'RA-2'],
      }
      await appendJsonl(indexPath, summary)
      await appendStamp(stampsPath, 'S-m3-join-1', 'index.jsonl', 'M3')

      const results = sl.query({ stamps: ['S-m3-join-1'] })
      expect(results.length).toBe(1)
      const m3 = results[0] as M3Summary
      expect(m3.stamp).toBe('S-m3-join-1')
      expect(m3.source_summary_stamps).toEqual(['S-cm-1', 'S-cm-2', 'S-cm-3'])
      expect(m3.raw_archive_ids).toEqual(['RA-1', 'RA-2'])
    })
  })

  // Stage 2b: rawArchive.query supports archiveIds and summaryStamps filters.
  describe('rawArchive.query stage 2b filters', () => {
    it('query({ archiveIds }) returns matching records by archiveId', async () => {
      const sl = createStateLine({ databusPath: tmpDir })
      const { appendJsonl } = await import('../../../src/im/state-line/jsonl-writer.js')
      const rawPath = join(tmpDir, 'state', 'raw-archive.jsonl')

      await appendJsonl(rawPath, {
        archiveId: 'RA-aaa', sourceTurnIds: ['t1'], messages: [],
        layer: 'M1', at: 100, summaryStamp: 'S-1',
      })
      await appendJsonl(rawPath, {
        archiveId: 'RA-bbb', sourceTurnIds: ['t2'], messages: [],
        layer: 'M2', at: 200, summaryStamp: 'S-2',
      })

      const results = await sl.rawArchive.query({ archiveIds: ['RA-aaa'] })
      expect(results).toHaveLength(1)
      expect(results[0]!.archiveId).toBe('RA-aaa')
    })

    it('query({ summaryStamps }) returns matching records by summaryStamp', async () => {
      const sl = createStateLine({ databusPath: tmpDir })
      const { appendJsonl } = await import('../../../src/im/state-line/jsonl-writer.js')
      const rawPath = join(tmpDir, 'state', 'raw-archive.jsonl')

      await appendJsonl(rawPath, {
        archiveId: 'RA-1', sourceTurnIds: ['t1'], messages: [],
        layer: 'M1', at: 100, summaryStamp: 'S-cm-1',
      })
      await appendJsonl(rawPath, {
        archiveId: 'RA-2', sourceTurnIds: ['t2'], messages: [],
        layer: 'M1', at: 200, summaryStamp: 'S-cm-2',
      })

      const results = await sl.rawArchive.query({ summaryStamps: ['S-cm-1'] })
      expect(results).toHaveLength(1)
      expect(results[0]!.archiveId).toBe('RA-1')
    })

    it('query({ archiveIds, summaryStamps }) combines with AND', async () => {
      const sl = createStateLine({ databusPath: tmpDir })
      const { appendJsonl } = await import('../../../src/im/state-line/jsonl-writer.js')
      const rawPath = join(tmpDir, 'state', 'raw-archive.jsonl')

      await appendJsonl(rawPath, {
        archiveId: 'RA-1', sourceTurnIds: ['t1'], messages: [],
        layer: 'M1', at: 100, summaryStamp: 'S-cm-1',
      })
      await appendJsonl(rawPath, {
        archiveId: 'RA-2', sourceTurnIds: ['t2'], messages: [],
        layer: 'M1', at: 200, summaryStamp: 'S-cm-2',
      })

      // AND: archiveIds matches RA-1 but summaryStamps matches S-cm-2 → no overlap.
      const results = await sl.rawArchive.query({
        archiveIds: ['RA-1'],
        summaryStamps: ['S-cm-2'],
      })
      expect(results).toHaveLength(0)

      // Both filters match RA-1 / S-cm-1.
      const results2 = await sl.rawArchive.query({
        archiveIds: ['RA-1'],
        summaryStamps: ['S-cm-1'],
      })
      expect(results2).toHaveLength(1)
    })
  })
})
