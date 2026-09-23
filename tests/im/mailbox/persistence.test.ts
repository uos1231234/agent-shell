// v0.34 D5/D10（用户拍板 2026-09-10）：mailbox 落盘 + 恢复 + 「读后不删」。
//
// 背景：mailbox 此前是纯内存 Map、模块内零 IO（src/im/mailbox/* 无任何
// writeFile/appendFile），进程重启后**整封信都没了**——不只是未读状态丢失。
// 后台委托任务以邮件为触发，重启即静默丢弃。
//
// 落盘端口是 fire-and-forget（Mailbox 的发送 API 是同步的），所以测试里把
// append 返回的 promise 收集起来 await——不用 sleep，确定性等待。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import type { MailItem } from '../../../src/im/mailbox/types.js'
import { SessionStore } from '../../../src/im/session/session-store.js'
import type { SessionInfo } from '../../../src/im/session/types.js'

describe('mailbox 落盘（v0.34 D10）', () => {
  it('send 后经 persistence 端口追加一条（含 from/to/subject/body/sentAt/read）', () => {
    const appended: MailItem[] = []
    const mb = new Mailbox(undefined, { persistence: { append: (item) => appended.push(item), rewrite: () => {} } })

    mb.send({ from: 'B', to: 'A', subject: 'hello', body: 'world' })

    expect(appended).toHaveLength(1)
    expect(appended[0]).toMatchObject({ from: 'B', to: 'A', subject: 'hello', body: 'world', read: false })
    expect(typeof appended[0]!.sentAt).toBe('number')
  })

  it('systemSend 同样落盘（后台委托任务走的就是这条）', () => {
    const appended: MailItem[] = []
    const mb = new Mailbox(undefined, { persistence: { append: (item) => appended.push(item), rewrite: () => {} } })

    mb.systemSend({ from: 'drive-coordinator', to: 'compressor', subject: 'compact', body: 'go' })

    expect(appended).toHaveLength(1)
    expect(appended[0]).toMatchObject({ from: 'drive-coordinator', to: 'compressor' })
  })

  it('多收件人：同一 id 为每个收件人各写一行，to 字段区分归属', () => {
    const appended: MailItem[] = []
    const mb = new Mailbox(undefined, { persistence: { append: (item) => appended.push(item), rewrite: () => {} } })

    mb.send({ from: 'C', to: ['A', 'B'], subject: 'broadcast', body: 'hi all' })

    expect(appended).toHaveLength(2)
    expect(appended.map((m) => m.to).sort()).toEqual(['A', 'B'])
    expect(new Set(appended.map((m) => m.id)).size).toBe(1)
  })

  it('读后不删（D5）：markRead 只置 read/readAt，邮件仍在信箱里', () => {
    const mb = new Mailbox()
    mb.send({ from: 'B', to: 'A', subject: 's', body: 'b' })

    mb.markRead('A')

    // 默认只读未读 → 空
    expect(mb.readOwnInbox('A')).toHaveLength(0)
    // 全量读 → 仍在，且 read=true、readAt 已盖章
    const all = mb.readOwnInbox('A', { unreadOnly: false })
    expect(all).toHaveLength(1)
    expect(all[0]!.read).toBe(true)
    expect(typeof all[0]!.readAt).toBe('number')
    expect(mb.inboxSize('A')).toBe(1)
  })

  it('restore 保留 read/readAt，且跳过重复 id', () => {
    const mb = new Mailbox()
    const item: MailItem = {
      id: 'M-3-abc', from: 'B', to: 'A', subject: 's', body: 'b',
      sentAt: Date.now(), read: true, readAt: 123,
    }
    expect(mb.restore([item, item])).toBe(1) // 同 (信箱, id) 只装一次
    const all = mb.readOwnInbox('A', { unreadOnly: false })
    expect(all).toHaveLength(1)
    expect(all[0]!.read).toBe(true)
    expect(all[0]!.readAt).toBe(123)
  })

  it('restore 推进 nextId：恢复后新邮件的序号不与历史冲突', () => {
    const mb = new Mailbox()
    mb.restore([{
      id: 'M-7-hist', from: 'B', to: 'A', subject: 'old', body: 'b',
      sentAt: Date.now(), read: false,
    }])
    mb.send({ from: 'B', to: 'A', subject: 'new', body: 'b' })
    const ids = mb.readOwnInbox('A', { unreadOnly: false }).map((m) => m.id)
    expect(ids.some((id) => id.startsWith('M-8-'))).toBe(true)
  })
})

describe('mailbox 落盘 → 重启恢复（端到端，真实 SessionStore）', () => {
  let baseDir: string
  let store: SessionStore
  const sessionId = 'sess-mail'

  const info: SessionInfo = {
    id: sessionId, title: 'mail', workingAgentId: 'main',
    createdAt: Date.now(), lastActiveAt: Date.now(),
    turnCount: 0, layer: 'M0', snapshotExpired: false,
  }

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'mailbox-persist-'))
    store = new SessionStore({ basePath: baseDir })
    await store.writeInfo(info)
  })

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true })
  })

  it('写盘后新实例恢复：邮件与 read 标记都还在（markRead 热路径回写，方案 A）', async () => {
    // 与装配（assembly.ts）同款的写串行队列：append（增量）与 rewrite（全量）
    // 是两类文件写，交错会坏行/丢行——这里复刻队列保证测试语义与生产一致。
    let chain: Promise<void> = Promise.resolve()
    const before = new Mailbox(undefined, {
      persistence: {
        append: (item) => { chain = chain.then(() => store.appendMail(sessionId, item)) },
        rewrite: (items) => { chain = chain.then(() => store.rewriteMails(sessionId, items)) },
      },
      ttlDays: store.ttlDays,
    })

    before.systemSend({ from: 'drive-coordinator', to: 'compressor', subject: 'compact', body: 'go' })
    before.send({ from: 'B', to: 'A', subject: 'note', body: 'hi' })
    before.markRead('A') // 读掉那封 note —— 热路径触发全量 rewrite

    // 确定性等待：markRead 的 rewrite 落盘后，文件里 note 的 read=true。
    // （旧版本靠"markRead 恰落在 append 序列化前的微任务窗口"通过——那是
    // 竞态不是语义；方案 A 让 read 状态的落盘成为显式保证。）
    await vi.waitFor(async () => {
      const persisted = await store.readMails(sessionId)
      const note = persisted.find((m) => m.subject === 'note')
      expect(note?.read).toBe(true)
    }, { timeout: 5000 })

    // ---- 模拟进程重启：全新 Mailbox，从磁盘回灌 ----
    const persisted = await store.readMails(sessionId)
    expect(persisted).toHaveLength(2)

    const after = new Mailbox(undefined, { ttlDays: store.ttlDays })
    expect(after.restore(persisted)).toBe(2)

    // 未读的那封（给 compressor 的委托任务）仍在且仍算未读
    expect(after.hasUnread('compressor')).toBe(true)
    expect(after.readOwnInbox('compressor').map((m) => m.subject)).toEqual(['compact'])
    // 已读的那封也在，read 标记被保留（不再重复计入未读）
    const aAll = after.readOwnInbox('A', { unreadOnly: false })
    expect(aAll).toHaveLength(1)
    expect(aAll[0]!.read).toBe(true)
    expect(aAll[0]!.readAt).toBeTypeOf('number')
  })

  it('启动回写：磁盘上有过期条目时回写清理后的集合，文件不再只增不减', async () => {
    const stale: MailItem = {
      id: 'M-99-old', from: 'B', to: 'A', subject: 'stale', body: 'b',
      sentAt: Date.now() - 10 * 24 * 60 * 60 * 1000, read: false,
    }
    await store.appendMail(sessionId, stale)
    await store.appendMail(sessionId, {
      id: 'M-100-fresh', from: 'B', to: 'A', subject: 'fresh', body: 'b',
      sentAt: Date.now(), read: false,
    })

    const persisted = await store.readMails(sessionId)
    const mb = new Mailbox(undefined, { ttlDays: store.ttlDays })
    const loaded = mb.restore(persisted)

    // restore 跳过过期 → 数量不符 → 宿主回写清理后的集合
    expect(loaded).toBe(1)
    if (loaded !== persisted.length) {
      await store.rewriteMails(sessionId, mb.dump())
    }

    const afterRewrite = await store.readMails(sessionId)
    expect(afterRewrite).toHaveLength(1)
    expect(afterRewrite[0]!.id).toBe('M-100-fresh')
  })

  it('会话被删除后不再写邮件（复用 deletedIds 守卫）', async () => {
    await store.deleteSessionDir(sessionId)
    await store.appendMail(sessionId, {
      id: 'M-1-x', from: 'B', to: 'A', subject: 's', body: 'b', sentAt: Date.now(), read: false,
    })
    expect(existsSync(store.sessionDir(sessionId))).toBe(false)
  })
})
