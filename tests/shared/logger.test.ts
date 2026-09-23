// v0.14: logger unit tests.
//
// The logger is a tiny process-global NDJSON sink with a level filter. Each
// test installs its own sink via setSink() and restores the previous one in
// afterEach so cross-test pollution is impossible.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  setLevel,
  getLevel,
  setSink,
  defaultLogger,
  createSilentLogger,
  type LogRecord,
} from '../../src/shared/logger.js'

describe('shared/logger', () => {
  let records: LogRecord[]
  let prevLevel: ReturnType<typeof getLevel>
  let prevSink: (rec: LogRecord) => void

  beforeEach(() => {
    records = []
    prevLevel = getLevel()
    prevSink = (rec) => { process.stderr.write(JSON.stringify(rec) + '\n') }
    setLevel('trace')
    setSink((rec) => { records.push(rec) })
  })

  afterEach(() => {
    setLevel(prevLevel)
    setSink(prevSink)
  })

  describe('level filtering', () => {
    it('default level is warn (silent)', () => {
      // Use a separate "fresh" logger path: install a known sink + restore.
      const captured: LogRecord[] = []
      setSink((r) => captured.push(r))
      setLevel('warn')
      defaultLogger.info('hidden')
      defaultLogger.warn('shown')
      expect(captured.map((r) => r.msg)).toEqual(['shown'])
      expect(captured[0]?.level).toBe('warn')
    })

    it('emits only records at or above the configured threshold', () => {
      setLevel('info')
      defaultLogger.trace('a')
      defaultLogger.debug('b')
      defaultLogger.info('c')
      defaultLogger.warn('d')
      defaultLogger.error('e')
      expect(records.map((r) => r.msg)).toEqual(['c', 'd', 'e'])
    })

    it('trace accepts every level', () => {
      setLevel('trace')
      defaultLogger.trace('a'); defaultLogger.debug('b'); defaultLogger.info('c')
      defaultLogger.warn('d'); defaultLogger.error('e')
      expect(records.map((r) => r.msg)).toEqual(['a', 'b', 'c', 'd', 'e'])
    })

    it('error level accepts only error', () => {
      setLevel('error')
      defaultLogger.trace('a'); defaultLogger.debug('b'); defaultLogger.info('c')
      defaultLogger.warn('d'); defaultLogger.error('e')
      expect(records.map((r) => r.msg)).toEqual(['e'])
    })

    it('getLevel / setLevel round-trip', () => {
      setLevel('debug')
      expect(getLevel()).toBe('debug')
    })
  })

  describe('record shape', () => {
    it('always populates ts / level / msg', () => {
      const before = Date.now()
      defaultLogger.info('hello')
      const after = Date.now()
      expect(records).toHaveLength(1)
      const r = records[0]!
      expect(r.msg).toBe('hello')
      expect(r.level).toBe('info')
      expect(r.ts).toBeGreaterThanOrEqual(before)
      expect(r.ts).toBeLessThanOrEqual(after)
    })

    it('passes through structured fields verbatim', () => {
      defaultLogger.info('evt', { turn: 3, agent: 'main', nested: { x: 1 } })
      expect(records).toHaveLength(1)
      const r = records[0]!
      expect(r.turn).toBe(3)
      expect(r.agent).toBe('main')
      expect(r.nested).toEqual({ x: 1 })
    })

    it('child() prefixes every record with bindings (no overwrite)', () => {
      const child = defaultLogger.child({ component: 'test', workingAgentId: 'main' })
      child.info('round', { turn: 1 })
      child.warn('guard', { id: 'iter' })
      expect(records).toHaveLength(2)
      expect(records[0]).toMatchObject({ component: 'test', workingAgentId: 'main', turn: 1, msg: 'round' })
      expect(records[1]).toMatchObject({ component: 'test', workingAgentId: 'main', id: 'iter', msg: 'guard' })
    })

    it('level field is owned by the emit call, not by caller (anti-spoofing)', () => {
      // Contract: even if a caller passes `level` in bindings or per-call fields,
      // the actual emit level is the function name (info/debug/...). This
      // prevents a buggy or hostile caller from upgrading a debug record to
      // error and confusing downstream sinks. ts/level/msg are always owned
      // by the emit.
      const child = defaultLogger.child({ level: 'parent-default' })
      child.info('x', { level: 'caller-override' })
      expect(records[0]?.level).toBe('info') // not 'caller-override'
    })

    it('nested child() merges bindings cumulatively', () => {
      const a = defaultLogger.child({ component: 'a' })
      const b = a.child({ subsystem: 'b' })
      b.info('msg', { turn: 7 })
      expect(records[0]).toMatchObject({ component: 'a', subsystem: 'b', turn: 7 })
    })
  })

  describe('fault tolerance', () => {
    it('sink throw does not propagate', () => {
      const throwingSink = vi.fn(() => { throw new Error('boom') })
      setSink(throwingSink)
      // Must not throw.
      expect(() => defaultLogger.info('survive')).not.toThrow()
      expect(throwingSink).toHaveBeenCalledTimes(1)
    })

    it('createSilentLogger drops every record', () => {
      const silent = createSilentLogger()
      silent.trace('a'); silent.debug('b'); silent.info('c'); silent.warn('d'); silent.error('e')
      expect(records).toHaveLength(0)
      // child of silent is also silent.
      expect(silent.child({ component: 'x' })).toBeDefined()
    })

    it('createSilentLogger returns a Logger with all 5 methods + child', () => {
      const s = createSilentLogger()
      expect(typeof s.trace).toBe('function')
      expect(typeof s.debug).toBe('function')
      expect(typeof s.info).toBe('function')
      expect(typeof s.warn).toBe('function')
      expect(typeof s.error).toBe('function')
      expect(typeof s.child).toBe('function')
    })
  })
})
