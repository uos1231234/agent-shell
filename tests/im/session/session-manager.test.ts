// v0.17 session-manager tests: create/open/close/delete/list + buildLoopOptions + persistTurn.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { createSessionManager } from '../../../src/im/session/session-manager.js'
import { SessionStore } from '../../../src/im/session/session-store.js'
import { createBuiltinTools } from '../../../src/im/tools/index.js'
import { createConfig } from '../../../src/shell/config.js'
import { ToolRegistry } from '../../../src/shell/registry.js'
import { setLevel, setSink, getLevel, type LogRecord } from '../../../src/shared/logger.js'
import type { ConversationTurn } from '../../../src/im/conversation-memory.js'
import type { ToolTurn } from '../../../src/im/databus.js'

let baseDir: string

const convTurn = (
  id: string,
  role: 'user' | 'assistant',
  at: number,
): ConversationTurn => ({ id, role, content: `${role}-${id}`, at })

const toolTurn = (id: string, at: number): ToolTurn => ({
  id,
  role: 'tool',
  toolCallId: `tc-${id}`,
  content: `result-${id}`,
  sourceAgentId: 'main',
  at,
})

// Minimal streamChat stub: never invoked in these tests (we don't run the loop).
const streamChat = (async function* () {
  /* never called */
})() as unknown as (
  url: string,
  req: { model: string; messages: unknown[]; tools?: unknown },
) => AsyncIterable<unknown>

describe('im/session/session-manager', () => {
  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'session-manager-'))
  })

  it('createSession produces correct info + runtime + buildLoopOptions merges session fields', async () => {
    const mgr = createSessionManager({ basePath: baseDir })
    const handle = await mgr.createSession({ title: 't1', workingAgentId: 'worker-1' })

    expect(handle.info.title).toBe('t1')
    expect(handle.info.workingAgentId).toBe('worker-1')
    expect(handle.info.turnCount).toBe(0)
    expect(handle.info.layer).toBe('M0')
    expect(handle.info.snapshotExpired).toBe(false)
    expect(handle.info.id).toBe(handle.runtime.sessionId)
    expect(handle.info.createdAt).toBeGreaterThan(0)
    expect(handle.info.lastActiveAt).toBeGreaterThanOrEqual(handle.info.createdAt)

    // runtime objects present
    expect(handle.runtime.conversationMemory).toBeDefined()
    expect(handle.runtime.databus).toBeDefined()
    expect(handle.runtime.stateLine).toBeDefined()
    expect(handle.runtime.subAgentRegistry).toBeDefined()
    expect(handle.runtime.driveCoordinator).toBeDefined()
    expect(typeof handle.runtime.persistTurn).toBe('function')

    // buildLoopOptions merges session-scoped fields
    const registry = createBuiltinTools({ cwd: baseDir })
    const opts = handle.buildLoopOptions({
      config: createConfig(),
      registry,
      streamChat: streamChat as never,
      url: 'http://x',
      model: 'm',
      systemPrompt: 'sp',
      userTemplate: 'ut',
    })
    expect(opts.sessionId).toBe(handle.info.id)
    expect(opts.databus).toBe(handle.runtime.databus)
    expect(opts.conversationMemory).toBe(handle.runtime.conversationMemory)
    expect(opts.stateLine).toBe(handle.runtime.stateLine)
    expect(opts.workingAgentId).toBe('worker-1')
    expect(opts.persistTurn).toBe(handle.runtime.persistTurn)
    expect(opts.systemToolRefs).toEqual([])
    expect(opts.mailbox).toBeDefined()
    expect(opts.systemAgents).toBeDefined()

    handle.runtime.stateLine.close()
  })

  it('persistTurn writes conversation.jsonl; tool turns also write databus.jsonl', async () => {
    const mgr = createSessionManager({ basePath: baseDir })
    const handle = await mgr.createSession()
    const store = new SessionStore({ basePath: baseDir })

    await handle.runtime.persistTurn(convTurn('c1', 'user', 1))
    await handle.runtime.persistTurn(toolTurn('d1', 2))

    const conv = await store.readConversation(handle.info.id)
    expect(conv.map(t => t.id)).toEqual(['c1', 'd1'])

    const data = await store.readDatabus(handle.info.id)
    expect(data.map(t => t.id)).toEqual(['d1'])

    handle.runtime.stateLine.close()
  })

  it('closeSession unregisters bus; reopen re-registers and restores turns', async () => {
    const mgr = createSessionManager({ basePath: baseDir })
    const h1 = await mgr.createSession({ title: 'reopen-test' })
    const sid = h1.info.id

    await h1.runtime.persistTurn(convTurn('c1', 'user', 1))
    await h1.runtime.persistTurn(convTurn('c2', 'assistant', 2))
    await h1.runtime.persistTurn(toolTurn('d1', 3))

    await mgr.closeSession(sid)

    // Reopen: recovery reads the snapshot, conversation memory restored.
    const h2 = await mgr.openSession(sid)
    const convIds = h2.runtime.conversationMemory.turns().map(t => t.id)
    expect(convIds).toEqual(['c1', 'c2', 'd1'])
    const toolIds = h2.runtime.databus.turns().map(t => t.id)
    expect(toolIds).toEqual(['d1'])

    // lastActiveAt refreshed
    expect(h2.info.lastActiveAt).toBeGreaterThanOrEqual(h1.info.lastActiveAt)

    h2.runtime.stateLine.close()
  })

  it('listSessions returns multiple sessions sorted by lastActiveAt desc', async () => {
    const mgr = createSessionManager({ basePath: baseDir })
    const a = await mgr.createSession({ title: 'a' })
    const b = await mgr.createSession({ title: 'b' })
    // bump b's lastActiveAt by saving a newer info
    await a.saveInfo({ lastActiveAt: 1000 })
    await b.saveInfo({ lastActiveAt: 2000 })

    const list = await mgr.listSessions()
    expect(list).toHaveLength(2)
    expect(list[0]!.id).toBe(b.info.id)
    expect(list[1]!.id).toBe(a.info.id)

    a.runtime.stateLine.close()
    b.runtime.stateLine.close()
  })

  it('deleteSession removes dir + unregisters; listSessions no longer contains it', async () => {
    const mgr = createSessionManager({ basePath: baseDir })
    const h = await mgr.createSession({ title: 'to-delete' })
    const sid = h.info.id
    const dir = join(baseDir, sid)
    expect(existsSync(dir)).toBe(true)

    await mgr.deleteSession(sid)
    expect(existsSync(dir)).toBe(false)
    const list = await mgr.listSessions()
    expect(list.find(i => i.id === sid)).toBeUndefined()
  })

  it('openSession throws on missing session', async () => {
    const mgr = createSessionManager({ basePath: baseDir })
    await expect(mgr.openSession('does-not-exist')).rejects.toThrow(/Session not found/)
  })

  it('pruneExpiredSnapshots is forwarded to the store', async () => {
    const mgr = createSessionManager({ basePath: baseDir })
    const h = await mgr.createSession({ title: 'will-expire' })
    // mark very old
    await h.saveInfo({ lastActiveAt: Date.now() - 10 * 24 * 60 * 60 * 1000 })
    // write a snapshot so prune has something to remove
    await h.runtime.persistTurn(convTurn('c1', 'user', 1))
    h.runtime.stateLine.close()

    const pruned = await mgr.pruneExpiredSnapshots()
    expect(pruned).toBe(1)
  })
})

// v0.25: empty systemToolRefs warn — assembly-omission detection. Warn once
// per session handle, never throw, never change the returned options.
describe('im/session/session-manager — empty systemToolRefs warn (v0.25)', () => {
  let records: LogRecord[]
  let prevLevel: ReturnType<typeof getLevel>
  let prevSink: (rec: LogRecord) => void

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'session-manager-warn-'))
    records = []
    prevLevel = getLevel()
    // Replica of the module-default stderr sink, used to restore afterwards
    // (logger.ts exposes setSink but no getter).
    prevSink = (rec) => { process.stderr.write(JSON.stringify(rec) + '\n') }
    setLevel('warn')
    setSink((rec) => { records.push(rec) })
  })

  afterEach(() => {
    setLevel(prevLevel)
    setSink(prevSink)
  })

  it('warns exactly once when refs are empty and the registry has system tools; idempotent per handle', async () => {
    const mgr = createSessionManager({ basePath: baseDir })
    const handle = await mgr.createSession()
    const registry = createBuiltinTools({ cwd: baseDir })
    const base = {
      config: createConfig(),
      registry,
      streamChat: streamChat as never,
      url: 'http://x',
      model: 'm',
      systemPrompt: 'sp',
      userTemplate: 'ut',
    }

    handle.buildLoopOptions(base)
    handle.buildLoopOptions(base)

    const warns = records.filter((r) => r.level === 'warn' && r.component === 'session-manager')
    expect(warns).toHaveLength(1)
    expect(warns[0]!.msg).toContain('empty systemToolRefs')
    // Return value unchanged: refs still resolve to [] (warn is non-blocking).
    expect(handle.buildLoopOptions(base).systemToolRefs).toEqual([])
    handle.runtime.stateLine.close()
  })

  it('does not warn when systemToolRefs is non-empty', async () => {
    const mgr = createSessionManager({ basePath: baseDir })
    const handle = await mgr.createSession()
    const registry = createBuiltinTools({ cwd: baseDir })

    handle.buildLoopOptions({
      config: createConfig(),
      registry,
      streamChat: streamChat as never,
      url: 'http://x',
      model: 'm',
      systemPrompt: 'sp',
      userTemplate: 'ut',
      systemToolRefs: ['read'],
    })

    expect(records.filter((r) => r.level === 'warn')).toHaveLength(0)
    handle.runtime.stateLine.close()
  })

  it('does not warn when the registry has no system tools', async () => {
    const mgr = createSessionManager({ basePath: baseDir })
    const handle = await mgr.createSession()

    handle.buildLoopOptions({
      config: createConfig(),
      registry: new ToolRegistry(),
      streamChat: streamChat as never,
      url: 'http://x',
      model: 'm',
      systemPrompt: 'sp',
      userTemplate: 'ut',
    })

    expect(records.filter((r) => r.level === 'warn')).toHaveLength(0)
    handle.runtime.stateLine.close()
  })

  it('warns again for a different session handle (per-session flag, not global)', async () => {
    const mgr = createSessionManager({ basePath: baseDir })
    const h1 = await mgr.createSession()
    const h2 = await mgr.createSession()
    const registry = createBuiltinTools({ cwd: baseDir })
    const base = {
      config: createConfig(),
      registry,
      streamChat: streamChat as never,
      url: 'http://x',
      model: 'm',
      systemPrompt: 'sp',
      userTemplate: 'ut',
    }

    h1.buildLoopOptions(base)
    h2.buildLoopOptions(base)

    const warns = records.filter((r) => r.level === 'warn' && r.component === 'session-manager')
    expect(warns).toHaveLength(2)
    h1.runtime.stateLine.close()
    h2.runtime.stateLine.close()
  })
})
