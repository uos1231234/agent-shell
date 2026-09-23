// 僵尸目录防护（v0.34 B）——用户拍板 2026-09-10。
//
// 问题：deleteSession = 整目录 rm，但在途回合不知道会话被删，随后仍调 append*；
// 而 appendJsonl 写前会 mkdir -p，于是把刚删掉的目录重建出来 —— 留下只有一行
// jsonl、没有 session.json 的僵尸目录。
//
// 守卫在 SessionStore（存储层）：一切会 mkdir 的写入路径，对已删除会话一律
// no-op。用进程内集合（僵尸只可能同进程内产生）。
//
// 关键防回归：pruneExpiredSnapshots 只删快照文件、保留 session.json 与 state/，
// 会话仍存在 —— prune 之后的 append 必须照常重建快照。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { SessionStore } from '../../../src/im/session/session-store.js'
import type { SessionInfo } from '../../../src/im/session/types.js'
import type { ConversationTurn } from '../../../src/im/conversation-memory.js'
import type { ToolTurn } from '../../../src/im/databus.js'

const userTurn = (id: string): ConversationTurn => ({ id, role: 'user', content: `turn-${id}`, at: Date.now() })

const toolTurn = (id: string): ToolTurn => ({
  id,
  role: 'tool',
  toolCallId: `call-${id}`,
  content: 'ok',
  sourceAgentId: 'main',
  at: Date.now(),
})

const infoFor = (id: string, lastActiveAt: number): SessionInfo => ({
  id,
  title: 'zombie test',
  workingAgentId: 'main',
  createdAt: lastActiveAt,
  lastActiveAt,
  turnCount: 0,
  layer: 'M0',
  snapshotExpired: false,
})

const lineCount = (file: string): number =>
  readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim().length > 0).length

describe('SessionStore — 已删除会话不得被写入重建（v0.34 B）', () => {
  let baseDir: string
  let store: SessionStore

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'zombie-dir-'))
    store = new SessionStore({ basePath: baseDir, ttlDays: 1 })
  })

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true })
  })

  it('删除后 append 被丢弃：会话目录不被重建（防僵尸目录）', async () => {
    const id = 'sess-deleted'
    await store.writeInfo(infoFor(id, Date.now()))
    await store.appendConversationTurn(id, userTurn('t1'))
    expect(existsSync(store.conversationFile(id))).toBe(true)

    await store.deleteSessionDir(id)
    expect(existsSync(store.sessionDir(id))).toBe(false)

    // 在途回合在这之后才落盘 —— 必须被丢弃，而不是把目录重建出来
    await store.appendConversationTurn(id, userTurn('t2'))
    await store.appendDatabusTurn(id, toolTurn('t3'))

    expect(existsSync(store.sessionDir(id))).toBe(false)
    expect(existsSync(store.conversationFile(id))).toBe(false)
    expect(existsSync(store.databusFile(id))).toBe(false)
  })

  it('删除后 writeInfo / copySnapshot 也被丢弃（同为会 mkdir 的写入路径）', async () => {
    const id = 'sess-deleted-info'
    await store.writeInfo(infoFor(id, Date.now()))
    await store.deleteSessionDir(id)

    await store.writeInfo(infoFor(id, Date.now()))
    await store.copySnapshot('some-source', id)

    expect(existsSync(store.sessionDir(id))).toBe(false)
  })

  it('防回归：pruneExpiredSnapshots 之后 append 必须照常重建快照', async () => {
    const id = 'sess-pruned'
    const stale = Date.now() - 2 * 24 * 60 * 60 * 1000 // 超过 ttlDays=1
    await store.writeInfo(infoFor(id, stale))
    await store.appendConversationTurn(id, userTurn('t1'))
    await store.appendDatabusTurn(id, toolTurn('t2'))
    expect(existsSync(store.conversationFile(id))).toBe(true)

    const pruned = await store.pruneExpiredSnapshots()
    expect(pruned).toBe(1)
    // prune 只删快照文件，会话本身仍在（session.json + state/ 保留）
    expect(existsSync(store.conversationFile(id))).toBe(false)
    expect(existsSync(store.sessionFile(id))).toBe(true)

    // 会话仍存在 —— 写入必须照常，快照是可重建副本（session-store.ts 头部契约）
    await store.appendConversationTurn(id, userTurn('t3'))
    expect(existsSync(store.conversationFile(id))).toBe(true)
    expect(lineCount(store.conversationFile(id))).toBe(1)
    expect(JSON.parse(readFileSync(store.conversationFile(id), 'utf-8').trim()).id).toBe('t3')
  })

  it('未删除的会话写入不受影响（守卫不误伤）', async () => {
    const id = 'sess-alive'
    await store.writeInfo(infoFor(id, Date.now()))
    await store.appendConversationTurn(id, userTurn('t1'))
    await store.appendConversationTurn(id, userTurn('t2'))
    await store.appendDatabusTurn(id, toolTurn('t3'))

    expect(lineCount(store.conversationFile(id))).toBe(2)
    expect(lineCount(store.databusFile(id))).toBe(1)
    expect(await store.listSessionIds()).toEqual([id])
  })

  it('删除只影响被删的那个会话，其他会话照常写', async () => {
    const [victim, survivor] = ['sess-victim', 'sess-survivor']
    await store.writeInfo(infoFor(victim, Date.now()))
    await store.writeInfo(infoFor(survivor, Date.now()))

    await store.deleteSessionDir(victim)

    await store.appendConversationTurn(victim, userTurn('v1'))
    await store.appendConversationTurn(survivor, userTurn('s1'))

    expect(existsSync(store.sessionDir(victim))).toBe(false)
    expect(existsSync(store.conversationFile(survivor))).toBe(true)
    expect(lineCount(store.conversationFile(survivor))).toBe(1)
  })
})
