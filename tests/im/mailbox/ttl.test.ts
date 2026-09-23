// v0.34 D5/D11/D12：mailbox 过期语义单测。
//
// 用户拍板（2026-09-10）：
//   - 邮件**读完不删除**（markRead 只置 read/readAt）——见 persistence.test.ts
//   - **3 天后过期自动删除**，按 `sentAt` 计（与会话快照 TTL 同口径）
//   - 过期执行 = 启动 prune + 读取惰性过滤（双保险）
//
// 用假时钟控制 Date.now，从而在不 sleep 的前提下跨越 TTL 边界。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import type { MailItem } from '../../../src/im/mailbox/types.js'

const DAY_MS = 24 * 60 * 60 * 1000

const mail = (over: Partial<MailItem> = {}): MailItem => ({
  id: 'M-1-abc',
  from: 'B',
  to: 'A',
  subject: 's',
  body: 'b',
  sentAt: Date.now(),
  read: false,
  ...over,
})

describe('mailbox TTL（v0.34 D5/D11/D12）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('3 天内不过期；读取惰性过滤在过期后立刻生效（无需任何写操作）', () => {
    const mb = new Mailbox()
    mb.send({ from: 'B', to: 'A', subject: 's', body: 'b' })

    expect(mb.readOwnInbox('A', { unreadOnly: false })).toHaveLength(1)
    expect(mb.inboxSize('A')).toBe(1)
    expect(mb.hasUnread('A')).toBe(true)

    // 跨过 TTL 边界：没有发生任何 send/restore，纯靠读取惰性过滤
    vi.setSystemTime(new Date(Date.now() + 3 * DAY_MS + 1))

    expect(mb.readOwnInbox('A', { unreadOnly: false })).toHaveLength(0)
    expect(mb.readOwnInbox('A')).toHaveLength(0)
    expect(mb.inboxSize('A')).toBe(0)
    expect(mb.hasUnread('A')).toBe(false)
    expect(mb.dump()).toHaveLength(0)
  })

  it('边界：正好 3 天不算过期（比较是 ">"）', () => {
    const mb = new Mailbox()
    mb.send({ from: 'B', to: 'A', subject: 's', body: 'b' })
    vi.setSystemTime(new Date(Date.now() + 3 * DAY_MS))
    expect(mb.inboxSize('A')).toBe(1)

    vi.setSystemTime(new Date(Date.now() + 1))
    expect(mb.inboxSize('A')).toBe(0)
  })

  it('ttlDays 可覆盖（宿主传 store.ttlDays，保持单一事实源）', () => {
    const mb = new Mailbox(undefined, { ttlDays: 1 })
    mb.send({ from: 'B', to: 'A', subject: 's', body: 'b' })
    vi.setSystemTime(new Date(Date.now() + 1 * DAY_MS + 1))
    expect(mb.inboxSize('A')).toBe(0)
  })

  it('写入前回收过期容量：信箱被过期邮件占满后仍能收到新邮件', () => {
    const mb = new Mailbox()
    // 填满到容量上限（MAX_INBOX_SIZE = 1000）
    for (let i = 0; i < 1000; i++) {
      mb.send({ from: 'B', to: 'A', subject: `s${i}`, body: 'b' })
    }
    expect(() => mb.send({ from: 'B', to: 'A', subject: 'overflow', body: 'b' })).toThrow(/is full/)

    // 放 4 天：全部过期 → 下一次 send 应先回收容量再判定满
    vi.setSystemTime(new Date(Date.now() + 4 * DAY_MS))
    expect(() => mb.send({ from: 'B', to: 'A', subject: 'after-expiry', body: 'b' })).not.toThrow()
    expect(mb.inboxSize('A')).toBe(1)
  })

  it('restore 跳过过期邮件（启动 prune 的内存侧）', () => {
    const mb = new Mailbox()
    const now = Date.now()
    const loaded = mb.restore([
      mail({ id: 'M-1-x', sentAt: now - 1 * DAY_MS }), // 新鲜
      mail({ id: 'M-2-x', sentAt: now - 4 * DAY_MS }), // 过期
    ])
    expect(loaded).toBe(1)
    expect(mb.inboxSize('A')).toBe(1)
    expect(mb.readOwnInbox('A', { unreadOnly: false })[0]!.id).toBe('M-1-x')
  })

  it('pruneExpired 物理清掉内存中的过期项，返回条数', () => {
    const mb = new Mailbox()
    const now = Date.now()
    mb.restore([
      mail({ id: 'M-1-x', sentAt: now }),
      mail({ id: 'M-2-x', sentAt: now }),
    ])
    vi.setSystemTime(new Date(now + 4 * DAY_MS))
    expect(mb.pruneExpired()).toBe(2)
    expect(mb.pruneExpired()).toBe(0) // 幂等
  })
})
