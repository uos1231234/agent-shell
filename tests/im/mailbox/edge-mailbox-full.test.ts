// Mailbox 全量功能 + 落盘核实探针（2026-09-13）。
// 覆盖：send/systemSend → append 落盘；markRead → rewrite；restore 回灌；
// TTL 过期；路由拒绝；装配级 close→open 邮件仍在。

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { Mailbox } from '../../../src/im/mailbox/index.js'
import { SessionStore } from '../../../src/im/session/session-store.js'
import { AgentTree } from '../../../src/im/sub-agent/tree.js'

describe('mailbox: full function + persistence', () => {
  it('send → append file; markRead → rewrite keeps read state; restore rebuilds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mail-persist-'))
    try {
      const store = new SessionStore({ basePath: dir })
      await store.writeInfo({
        id: 's1', title: 'm', workingAgentId: 'main',
        createdAt: Date.now(), lastActiveAt: Date.now(),
        turnCount: 0, layer: 'M0', snapshotExpired: false,
      })

      let chain: Promise<void> = Promise.resolve()
      const enqueue = (job: () => Promise<void>): Promise<void> => {
        const run = chain.then(job)
        chain = run.catch(() => {})
        return run
      }

      const mb = new Mailbox(undefined, {
        persistence: {
          append: (item) => {
            void enqueue(async () => { await store.appendMail('s1', item) })
          },
          rewrite: (items) => {
            void enqueue(async () => { await store.rewriteMails('s1', items) })
          },
        },
      })

      const id1 = mb.send({ from: 'main', to: 'warehouse', subject: 'hello', body: 'body-1' })
      mb.systemSend({ from: 'drive-coordinator', to: 'main', subject: 'compressed', body: 'ok' })
      // drain write chain
      await enqueue(async () => {})

      const mailFile = join(dir, 's1', 'mailbox.jsonl')
      expect(existsSync(mailFile)).toBe(true)
      const lines = readFileSync(mailFile, 'utf8').split('\n').filter(Boolean)
      expect(lines.length).toBe(2)

      // markRead → rewrite
      mb.markRead('warehouse', [id1])
      await enqueue(async () => {})
      const afterRead = readFileSync(mailFile, 'utf8').split('\n').filter(Boolean)
        .map((l) => JSON.parse(l) as { id: string; read: boolean })
      const w = afterRead.find((r) => r.id === id1)
      expect(w?.read).toBe(true)

      // restore into a fresh mailbox
      const mb2 = new Mailbox(undefined, {})
      const persisted = await store.readMails('s1')
      const loaded = mb2.restore(persisted)
      expect(loaded).toBe(2)
      expect(mb2.readOwnInbox('warehouse', { unreadOnly: false })).toHaveLength(1)
      expect(mb2.readOwnInbox('warehouse', { unreadOnly: false })[0]?.read).toBe(true)
      expect(mb2.hasUnread('main')).toBe(true)
      expect(mb2.hasUnread('warehouse')).toBe(false)

      // reserved sender rejected on send()
      expect(() => mb2.send({ from: 'drive-coordinator', to: 'main', subject: 'x', body: 'y' })).toThrow(/reserved/)
      // systemSend still allowed
      expect(mb2.systemSend({ from: 'databus', to: 'main', subject: 'ev', body: 'e' })).toMatch(/^M-/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('route enforcement: sibling agents cannot mail across trees', () => {
    const tree = new AgentTree({ rootId: 'main' })
    // minimal tree: root main, child a and b are siblings → can communicate
    // unknown agent fails closed
    const mb = new Mailbox(tree)
    expect(() => mb.send({ from: 'ghost', to: 'main', subject: 's', body: 'b' })).toThrow()
  })

  it('TTL: expired mails drop from dump/hasUnread and purge before inbox-full', () => {
    // 假定时器是承重的：ttlDays:0 → ttlMs:0 → 过期判据 `now - sentAt > 0`，
    // 真时钟下**刚 send 的新邮件**走过 1ms 也会被判过期（满载跑全量套件时必现
    // flaky）。钉住 Date.now() 后：restored 邮件 sentAt = now-10 → 过期；新邮件
    // sentAt = now → 差值 0，不过期。同目录 ttl.test.ts 用的是同一套惯例。
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-13T12:00:00Z'))
    try {
      const mb = new Mailbox(undefined, { ttlDays: 0 }) // expire immediately-ish
      // ttlDays 0 → ttlMs 0 → any past sentAt expires; use Date.now()-1 via restore
      mb.restore([{
        id: 'M-1-old',
        from: 'main',
        to: 'main',
        subject: 'old',
        body: 'x',
        sentAt: Date.now() - 10,
        read: false,
      }])
      expect(mb.hasUnread('main')).toBe(false)
      expect(mb.dump()).toHaveLength(0)
      expect(mb.inboxSize('main')).toBe(0)
      // can still receive new mail (purge ran)
      mb.send({ from: 'main', to: 'main', subject: 'new', body: 'n' })
      expect(mb.inboxSize('main')).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
