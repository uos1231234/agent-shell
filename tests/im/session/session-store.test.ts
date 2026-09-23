// v0.17 session-store tests: on-disk layout for sessions.
//
// Covers path helpers, info round-trip, conversation/databus jsonl appends +
// reads, listSessionIds (only dirs with session.json), deleteSessionDir,
// pruneExpiredSnapshots (removes conversation.jsonl + databus.jsonl, keeps
// session.json with snapshotExpired=true, keeps state/), hasSnapshot.

import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { SessionStore } from '../../../src/im/session/session-store.js'
import type { SessionInfo } from '../../../src/im/session/types.js'
import type { ConversationTurn } from '../../../src/im/conversation-memory.js'

import type { ToolTurn as ToolTurnType } from '../../../src/im/databus.js'

let baseDir: string

const makeInfo = (id: string, overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  title: `session-${id}`,
  workingAgentId: 'main',
  createdAt: 1000,
  lastActiveAt: 1000,
  turnCount: 0,
  layer: 'M0',
  snapshotExpired: false,
  ...overrides,
})

const makeConvTurn = (id: string, role: ConversationTurn['role'], at: number): ConversationTurn => {
  if (role === 'user') return { id, role: 'user', content: `user-${id}`, at }
  if (role === 'assistant') return { id, role: 'assistant', content: `asst-${id}`, at }
  return { id, role: 'tool', toolCallId: `tc-${id}`, content: `tool-${id}`, sourceAgentId: 'main', at }
}

const makeToolTurn = (id: string, at: number): ToolTurnType => ({
  id,
  role: 'tool',
  toolCallId: `tc-${id}`,
  content: `result-${id}`,
  sourceAgentId: 'main',
  at,
})

describe('im/session/session-store', () => {
  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'session-store-'))
  })

  afterAll(async () => {
    // tmpdir entries get cleaned by the OS; nothing to do here explicitly.
  })

  it('writeInfo → readInfo round-trips all fields', async () => {
    const store = new SessionStore({ basePath: baseDir })
    const info = makeInfo('s1', {
      title: 'my title',
      workingAgentId: 'worker-1',
      createdAt: 12345,
      lastActiveAt: 67890,
      turnCount: 42,
      layer: 'M2',
      snapshotExpired: false,
    })
    await store.writeInfo(info)
    const got = await store.readInfo('s1')
    expect(got).not.toBeNull()
    expect(got).toMatchObject(info)
  })

  it('readInfo returns null when session.json missing', async () => {
    const store = new SessionStore({ basePath: baseDir })
    expect(await store.readInfo('nope')).toBeNull()
  })

  it('path helpers produce expected layout', () => {
    const store = new SessionStore({ basePath: baseDir })
    expect(store.sessionDir('s1')).toBe(join(baseDir, 's1'))
    expect(store.sessionFile('s1')).toBe(join(baseDir, 's1', 'session.json'))
    expect(store.conversationFile('s1')).toBe(join(baseDir, 's1', 'conversation.jsonl'))
    expect(store.databusFile('s1')).toBe(join(baseDir, 's1', 'databus.jsonl'))
    expect(store.stateDir('s1')).toBe(join(baseDir, 's1', 'state'))
  })

  it('appendConversationTurn ×3 → readConversation returns 3 in order', async () => {
    const store = new SessionStore({ basePath: baseDir })
    await store.writeInfo(makeInfo('s1'))
    const t1 = makeConvTurn('c1', 'user', 1)
    const t2 = makeConvTurn('c2', 'assistant', 2)
    const t3 = makeConvTurn('c3', 'tool', 3)
    await store.appendConversationTurn('s1', t1)
    await store.appendConversationTurn('s1', t2)
    await store.appendConversationTurn('s1', t3)
    const turns = await store.readConversation('s1')
    expect(turns).toHaveLength(3)
    expect(turns.map(t => t.id)).toEqual(['c1', 'c2', 'c3'])
  })

  it('appendDatabusTurn → readDatabus returns tool turns', async () => {
    const store = new SessionStore({ basePath: baseDir })
    await store.writeInfo(makeInfo('s1'))
    await store.appendDatabusTurn('s1', makeToolTurn('d1', 10))
    await store.appendDatabusTurn('s1', makeToolTurn('d2', 20))
    const turns = await store.readDatabus('s1')
    expect(turns).toHaveLength(2)
    expect(turns[0]!.id).toBe('d1')
    expect(turns[1]!.content).toBe('result-d2')
  })

  it('readConversation returns [] when file missing', async () => {
    const store = new SessionStore({ basePath: baseDir })
    await store.writeInfo(makeInfo('s1'))
    expect(await store.readConversation('s1')).toEqual([])
  })

  it('listSessionIds only returns dirs with session.json', async () => {
    const store = new SessionStore({ basePath: baseDir })
    await store.writeInfo(makeInfo('alpha'))
    await store.writeInfo(makeInfo('beta'))
    // a bare dir without session.json
    await mkdir(join(baseDir, 'gamma'), { recursive: true })
    const ids = await store.listSessionIds()
    expect(ids).toEqual(['alpha', 'beta'])
  })

  it('listSessionIds returns [] when basePath missing', async () => {
    const store = new SessionStore({ basePath: join(baseDir, 'does-not-exist') })
    expect(await store.listSessionIds()).toEqual([])
  })

  it('deleteSessionDir removes the dir and listSessionIds no longer contains it', async () => {
    const store = new SessionStore({ basePath: baseDir })
    await store.writeInfo(makeInfo('alpha'))
    await store.appendConversationTurn('alpha', makeConvTurn('c1', 'user', 1))
    expect(existsSync(store.sessionDir('alpha'))).toBe(true)
    await store.deleteSessionDir('alpha')
    expect(existsSync(store.sessionDir('alpha'))).toBe(false)
    expect(await store.listSessionIds()).toEqual([])
  })

  it('hasSnapshot reflects conversation.jsonl existence', async () => {
    const store = new SessionStore({ basePath: baseDir })
    await store.writeInfo(makeInfo('s1'))
    expect(await store.hasSnapshot('s1')).toBe(false)
    await store.appendConversationTurn('s1', makeConvTurn('c1', 'user', 1))
    expect(await store.hasSnapshot('s1')).toBe(true)
  })

  it('pruneExpiredSnapshots removes conversation+databus, keeps session.json+state/, marks snapshotExpired', async () => {
    // ttlDays=3, lastActiveAt 5 days ago → expired
    const store = new SessionStore({ basePath: baseDir, ttlDays: 3 })
    const old = Date.now() - 5 * 24 * 60 * 60 * 1000
    await store.writeInfo(makeInfo('old-session', { lastActiveAt: old }))
    await store.appendConversationTurn('old-session', makeConvTurn('c1', 'user', 1))
    await store.appendDatabusTurn('old-session', makeToolTurn('d1', 2))
    // create state/ dir with a file inside (durable gradient must survive)
    await mkdir(store.stateDir('old-session'), { recursive: true })
    await writeFile(join(store.stateDir('old-session'), 'curatedMemory.jsonl'), '{}\n', 'utf-8')

    // fresh session must NOT be pruned
    const fresh = Date.now()
    await store.writeInfo(makeInfo('fresh-session', { lastActiveAt: fresh }))
    await store.appendConversationTurn('fresh-session', makeConvTurn('f1', 'user', 1))

    const pruned = await store.pruneExpiredSnapshots()
    expect(pruned).toBe(1)

    // conversation.jsonl + databus.jsonl removed
    expect(existsSync(store.conversationFile('old-session'))).toBe(false)
    expect(existsSync(store.databusFile('old-session'))).toBe(false)
    // session.json still there and flagged
    const info = await store.readInfo('old-session')
    expect(info).not.toBeNull()
    expect(info!.snapshotExpired).toBe(true)
    // state/ dir still there
    expect(existsSync(store.stateDir('old-session'))).toBe(true)

    // fresh session untouched
    expect(existsSync(store.conversationFile('fresh-session'))).toBe(true)
    const freshInfo = await store.readInfo('fresh-session')
    expect(freshInfo!.snapshotExpired).toBe(false)
  })

  it('pruneExpiredSnapshots returns 0 when nothing expired', async () => {
    const store = new SessionStore({ basePath: baseDir, ttlDays: 3 })
    await store.writeInfo(makeInfo('s1', { lastActiveAt: Date.now() }))
    await store.appendConversationTurn('s1', makeConvTurn('c1', 'user', 1))
    const pruned = await store.pruneExpiredSnapshots()
    expect(pruned).toBe(0)
  })
})
