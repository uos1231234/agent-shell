// v0.14: state-line logger coverage.
//
// createStateLine now accepts an optional `logger` (defaults to defaultLogger).
// appendBlock / appendSummary / rawArchive.append emit structured records:
//   - success → debug('appendBlock ok' | 'appendSummary ok' | 'rawArchive.append ok')
//   - failure → error('appendBlock failed' | ...) with err field, then rethrow
//
// These tests capture records via a custom logger + sink, verify the success
// fields (stamp/path/layer) and the failure path (err + rethrow).
//
// Note: appendSummary also calls embedM3 (Python spawn). To keep these tests
// hermetic we only exercise appendBlock and rawArchive.append (pure jsonl IO).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, platform } from 'node:os'
import { createStateLine } from '../../../src/im/state-line/index.js'
import type { CuratedMemory, RawArchiveRecord } from '../../../src/im/state-line/types.js'
import type { Logger, LogRecord } from '../../../src/shared/logger.js'

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

const makeCaptureLogger = (): { logger: Logger; records: LogRecord[] } => {
  const records: LogRecord[] = []
  const logger: Logger = {
    trace: () => {},
    debug: (msg, fields) => { records.push({ ts: Date.now(), level: 'debug', msg, ...(fields ?? {}) }) },
    info: (msg, fields) => { records.push({ ts: Date.now(), level: 'info', msg, ...(fields ?? {}) }) },
    warn: (msg, fields) => { records.push({ ts: Date.now(), level: 'warn', msg, ...(fields ?? {}) }) },
    error: (msg, fields) => { records.push({ ts: Date.now(), level: 'error', msg, ...(fields ?? {}) }) },
    child: (extra) => {
      const childRecords = records
      const childLogger: Logger = {
        trace: () => {},
        debug: (m, f) => { childRecords.push({ ts: Date.now(), level: 'debug', msg: m, ...extra, ...(f ?? {}) }) },
        info: (m, f) => { childRecords.push({ ts: Date.now(), level: 'info', msg: m, ...extra, ...(f ?? {}) }) },
        warn: (m, f) => { childRecords.push({ ts: Date.now(), level: 'warn', msg: m, ...extra, ...(f ?? {}) }) },
        error: (m, f) => { childRecords.push({ ts: Date.now(), level: 'error', msg: m, ...extra, ...(f ?? {}) }) },
        child: (e2) => makeCaptureLoggerInner(childRecords, { ...extra, ...e2 }),
      }
      return childLogger
    },
  }
  return { logger, records }
}

// helper to allow nested child() to keep capturing into the same array
const makeCaptureLoggerInner = (records: LogRecord[], bindings: Record<string, unknown>): Logger => {
  return {
    trace: () => {},
    debug: (m, f) => { records.push({ ts: Date.now(), level: 'debug', msg: m, ...bindings, ...(f ?? {}) }) },
    info: (m, f) => { records.push({ ts: Date.now(), level: 'info', msg: m, ...bindings, ...(f ?? {}) }) },
    warn: (m, f) => { records.push({ ts: Date.now(), level: 'warn', msg: m, ...bindings, ...(f ?? {}) }) },
    error: (m, f) => { records.push({ ts: Date.now(), level: 'error', msg: m, ...bindings, ...(f ?? {}) }) },
    child: (e2) => makeCaptureLoggerInner(records, { ...bindings, ...e2 }),
  }
}

describe('im/state-line — logger coverage (v0.14)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'state-line-logger-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('appendBlock success emits a debug "appendBlock ok" record with stamp/path/layer', async () => {
    const { logger, records } = makeCaptureLogger()
    const sl = createStateLine({ databusPath: tmpDir, logger })

    await sl.compressor.appendBlock(validBlock, 'M2', 'S-test-stamp')

    const ok = records.find((r) => r.msg === 'appendBlock ok')
    expect(ok).toBeDefined()
    expect(ok!.level).toBe('debug')
    expect(ok!.stamp).toBe('S-test-stamp')
    expect(ok!.path).toBe('curatedMemory.jsonl')
    expect(ok!.layer).toBe('M2')
  })

  it('appendBlock failure emits an error "appendBlock failed" record then rethrows', async () => {
    const { logger, records } = makeCaptureLogger()
    // Make the state directory unwritable so appendJsonl fails.
    // On Windows chmod is largely a no-op for the owner; use a path under a
    // file (not a directory) to force ENOTDIR instead.
    const blockedDir = join(tmpDir, 'blocked-file')
    // Create a regular file where a directory is expected → mkdir fails / append fails.
    const fs = await import('node:fs')
    fs.writeFileSync(blockedDir, 'not a directory')
    const sl = createStateLine({ databusPath: blockedDir, logger })

    await expect(sl.compressor.appendBlock(validBlock, 'M2', 'S-fail-stamp'))
      .rejects.toThrow()

    const fail = records.find((r) => r.msg === 'appendBlock failed')
    expect(fail).toBeDefined()
    expect(fail!.level).toBe('error')
    expect(fail!.stamp).toBe('S-fail-stamp')
    expect(fail!.path).toBe('curatedMemory.jsonl')
    expect(fail!.layer).toBe('M2')
    expect(typeof fail!.err).toBe('string')
    expect((fail!.err as string).length).toBeGreaterThan(0)
  })

  it('rawArchive.append success emits a debug "rawArchive.append ok" record', async () => {
    const { logger, records } = makeCaptureLogger()
    const sl = createStateLine({ databusPath: tmpDir, logger })

    const record: RawArchiveRecord = {
      archiveId: 'arch-1',
      sourceTurnIds: ['t1', 't2'],
      messages: [{ role: 'user', content: 'hi' }],
      layer: 'M2',
      at: Date.now(),
      summaryStamp: 'S-arch-stamp',
    }
    await sl.rawArchive.append(record)

    const ok = records.find((r) => r.msg === 'rawArchive.append ok')
    expect(ok).toBeDefined()
    expect(ok!.level).toBe('debug')
    expect(ok!.archiveId).toBe('arch-1')
    expect(ok!.path).toBe('raw-archive.jsonl')
    expect(ok!.layer).toBe('M2')
    expect(ok!.summaryStamp).toBe('S-arch-stamp')
  })

  it('rawArchive.append failure emits an error record then rethrows', async () => {
    const { logger, records } = makeCaptureLogger()
    const fs = await import('node:fs')
    const blockedDir = join(tmpDir, 'blocked-file2')
    fs.writeFileSync(blockedDir, 'not a directory')
    const sl = createStateLine({ databusPath: blockedDir, logger })

    const record: RawArchiveRecord = {
      archiveId: 'arch-fail',
      sourceTurnIds: ['t1'],
      messages: [{ role: 'user', content: 'hi' }],
      layer: 'M1',
      at: Date.now(),
      summaryStamp: 'S-fail-arch',
    }
    await expect(sl.rawArchive.append(record)).rejects.toThrow()

    const fail = records.find((r) => r.msg === 'rawArchive.append failed')
    expect(fail).toBeDefined()
    expect(fail!.level).toBe('error')
    expect(fail!.archiveId).toBe('arch-fail')
    expect(fail!.path).toBe('raw-archive.jsonl')
    expect(fail!.layer).toBe('M1')
    expect(fail!.summaryStamp).toBe('S-fail-arch')
    expect(typeof fail!.err).toBe('string')
  })

  it('defaults to defaultLogger when no logger is passed (smoke: no throw)', async () => {
    // No logger field → uses defaultLogger. We don't capture here; just
    // confirm the success path completes without error.
    const sl = createStateLine({ databusPath: tmpDir })
    await sl.compressor.appendBlock(validBlock, 'M1', 'S-default-stamp')
    // If we got here without throwing, the default-logger path works.
    expect(true).toBe(true)
  })
})
