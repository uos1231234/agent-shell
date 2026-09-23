import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStateLine } from '../../../src/im/state-line/index.js'
import { buildContextProjection } from '../../../src/im/context-projection.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import type { CuratedMemory } from '../../../src/im/state-line/types.js'

const validBlock: CuratedMemory = {
  task_goal: 'integration test goal',
  causal_steps: [{ intent: 'do', tool_action: 'act', result: 'res' }],
  evidence_fragments: [{ source: 's', fragment: 'f', relevance: 'r' }],
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

describe('im/state-line stamp integration', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'stamp-integ-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('query() returns _stamp, projection header contains stamp value (not "undefined")', async () => {
    const sl = createStateLine({ databusPath: tmpDir })

    // Write an M1 block
    await sl.compressor.appendBlock(validBlock, 'M1')

    // Query returns entry with _stamp
    const results = sl.query({ layer: 'M1' })
    expect(results.length).toBe(1)

    const entry = results[0] as CuratedMemory & { _stamp?: string }
    expect(entry._stamp).toBeDefined()
    expect(typeof entry._stamp).toBe('string')
    expect(entry._stamp!.length).toBeGreaterThan(0)

    // Pass query results through buildContextProjection
    const mailbox = new Mailbox()

    // Wrap the real stateLine so query returns our stamped entry
    const result = buildContextProjection({
      stateLine: sl,
      mailbox,
      workingAgentId: 'main',
      estimatedTokens: 250_000, // M1 range
    })

    expect(result.stateLinePart).not.toBeNull()
    expect(result.stateLinePart?.type).toBe('system')
    const content = result.stateLinePart!.type === 'system' ? result.stateLinePart!.content : ''
    expect(content).toContain('### M1 block stamp=')
    expect(content).not.toContain('stamp=undefined')
    expect(content).toContain(entry._stamp!)
  })
})

describe('im/state-line readJsonl corruption recovery', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-recovery-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('query() skips corrupted jsonl lines and returns valid entries', () => {
    const sl = createStateLine({ databusPath: tmpDir })
    const stateDir = join(tmpDir, 'state')
    mkdirSync(stateDir, { recursive: true })

    const cmPath = join(stateDir, 'curatedMemory.jsonl')
    const stampsPath = join(stateDir, 'stamps.jsonl')

    // Write: valid line + corrupted line + valid line
    const block1 = { ...validBlock, _stamp: 'S-good-1' }
    const block2 = { ...validBlock, _stamp: 'S-good-2', task_goal: 'second goal' }
    const lines = [
      JSON.stringify(block1),
      '{broken',
      JSON.stringify(block2),
    ].join('\n')
    writeFileSync(cmPath, lines)

    // Write matching stamp records so query can find layer
    const stamp1 = { stamp: 'S-good-1', path: 'curatedMemory.jsonl', layer: 'M1', written_at: Date.now() }
    const stamp2 = { stamp: 'S-good-2', path: 'curatedMemory.jsonl', layer: 'M1', written_at: Date.now() }
    writeFileSync(stampsPath, [JSON.stringify(stamp1), JSON.stringify(stamp2)].join('\n'))

    const results = sl.query({ layer: 'M1' })
    expect(results.length).toBe(2)
    const entries = results as Array<CuratedMemory & { _stamp?: string }>
    expect(entries[0]!.task_goal).toBe('integration test goal')
    expect(entries[1]!.task_goal).toBe('second goal')
  })
})
