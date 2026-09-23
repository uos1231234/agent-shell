import { describe, it, expect } from 'vitest'
import { Mailbox } from '../../../src/im/mailbox/index.js'

describe('im/mailbox', () => {
  it('send to a single agent creates an inbox', () => {
    const mb = new Mailbox()
    mb.send({ from: 'B', to: 'A', subject: 'hello', body: 'world' })
    expect(mb.inboxSize('A')).toBe(1)
  })

  it('send to multiple agents creates inboxes for each', () => {
    const mb = new Mailbox()
    mb.send({ from: 'C', to: ['A', 'B'], subject: 'broadcast', body: 'hi all' })
    expect(mb.inboxSize('A')).toBe(1)
    expect(mb.inboxSize('B')).toBe(1)
  })

  it('readOwnInbox returns FIFO order', () => {
    const mb = new Mailbox()
    mb.send({ from: 'B', to: 'A', subject: 'first', body: '1' })
    mb.send({ from: 'B', to: 'A', subject: 'second', body: '2' })
    mb.send({ from: 'B', to: 'A', subject: 'third', body: '3' })
    const inbox = mb.readOwnInbox('A')
    expect(inbox).toHaveLength(3)
    expect(inbox[0]!.subject).toBe('first')
    expect(inbox[1]!.subject).toBe('second')
    expect(inbox[2]!.subject).toBe('third')
  })

  it('readOwnInbox with unreadOnly excludes read items', () => {
    const mb = new Mailbox()
    mb.send({ from: 'B', to: 'A', subject: 'first', body: '1' })
    mb.send({ from: 'B', to: 'A', subject: 'second', body: '2' })
    mb.send({ from: 'B', to: 'A', subject: 'third', body: '3' })
    mb.markRead('A', [mb.readOwnInbox('A')[0]!.id])
    const unread = mb.readOwnInbox('A', { unreadOnly: true })
    expect(unread).toHaveLength(2)
    expect(unread.some((item: { subject: string }) => item.subject === 'first')).toBe(false)
  })

  it('hasUnread returns false on empty inbox', () => {
    const mb = new Mailbox()
    expect(mb.hasUnread('A')).toBe(false)
  })

  it('hasUnread returns true after an unread send', () => {
    const mb = new Mailbox()
    mb.send({ from: 'B', to: 'A', subject: 'hello', body: 'world' })
    expect(mb.hasUnread('A')).toBe(true)
  })

  it('markRead without ids marks all unread as read', () => {
    const mb = new Mailbox()
    mb.send({ from: 'B', to: 'A', subject: 'first', body: '1' })
    mb.send({ from: 'B', to: 'A', subject: 'second', body: '2' })
    mb.markRead('A')
    expect(mb.hasUnread('A')).toBe(false)
  })

  it('markRead with ids marks only the listed items', () => {
    const mb = new Mailbox()
    mb.send({ from: 'B', to: 'A', subject: 'first', body: '1' })
    mb.send({ from: 'B', to: 'A', subject: 'second', body: '2' })
    const firstId = mb.readOwnInbox('A')[0]!.id
    mb.markRead('A', [firstId])
    expect(mb.hasUnread('A')).toBe(true)
  })

  it('readOwnInbox does not mark items as read', () => {
    const mb = new Mailbox()
    mb.send({ from: 'B', to: 'A', subject: 'hello', body: 'world' })
    for (let i = 0; i < 5; i++) {
      mb.readOwnInbox('A')
    }
    expect(mb.hasUnread('A')).toBe(true)
    mb.markRead('A')
    expect(mb.hasUnread('A')).toBe(false)
  })

  it('deliver keeps the full summary (no truncation, 2026-09-12)', () => {
    const mb = new Mailbox()
    const longSummary = 'x'.repeat(300)
    mb.send({ from: 'B', to: 'A', subject: 's', body: 'b', summary: longSummary })
    const inbox = mb.readOwnInbox('A', { unreadOnly: false })
    expect(inbox[0]!.summary).toBe(longSummary)
  })

  it('send without summary leaves summary undefined', () => {
    const mb = new Mailbox()
    mb.send({ from: 'B', to: 'A', subject: 's', body: 'b' })
    const inbox = mb.readOwnInbox('A', { unreadOnly: false })
    expect(inbox[0]!.summary).toBeUndefined()
  })

  it('markRead stamps readAt', () => {
    const mb = new Mailbox()
    mb.send({ from: 'B', to: 'A', subject: 's', body: 'b' })
    const id = mb.readOwnInbox('A', { unreadOnly: false })[0]!.id
    mb.markRead('A', [id])
    const item = mb.readOwnInbox('A', { unreadOnly: false })[0]!
    expect(item.read).toBe(true)
    expect(typeof item.readAt).toBe('number')
  })

  it('sentStatus returns full status for own mail', () => {
    const mb = new Mailbox()
    const id = mb.send({ from: 'A', to: 'B', subject: 's', body: 'b', summary: 'one-liner' })
    const status = mb.sentStatus('A', id)
    expect(status.found).toBe(true)
    expect(status.read).toBe(false)
    expect(status.ageMs).toBeGreaterThanOrEqual(0)
    expect(status.sentAt).toBeGreaterThan(0)
    expect(status.readAt).toBeUndefined()
    mb.markRead('B')
    const status2 = mb.sentStatus('A', id)
    expect(status2.read).toBe(true)
    expect(status2.readAt).toBeGreaterThan(0)
  })

  it('sentStatus hides foreign mail', () => {
    const mb = new Mailbox()
    const id = mb.send({ from: 'A', to: 'B', subject: 's', body: 'b' })
    const status = mb.sentStatus('C', id)
    expect(status.found).toBe(false)
  })

  it('sentStatus unknown id -> found false', () => {
    const mb = new Mailbox()
    const status = mb.sentStatus('A', 'M-999-nope')
    expect(status.found).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// markRead 热路径回写（2026-09-11 方案 A）：read 状态经 persistence.rewrite
// 全量落盘——append-only 端口写不进 read，此前重启后已读回退未读。
// ---------------------------------------------------------------------------

describe('im/mailbox markRead persistence（方案 A）', () => {
  it('markRead 有实际变更时 rewrite 收到含 read/readAt 的全量快照', () => {
    const rewrites: { subject: string; read: boolean; readAt?: number }[][] = []
    const mb = new Mailbox(undefined, {
      persistence: {
        append: () => {},
        rewrite: (items) => { rewrites.push([...items]) },
      },
    })
    mb.send({ from: 'B', to: 'A', subject: 's', body: 'b' })
    mb.markRead('A')
    expect(rewrites).toHaveLength(1)
    expect(rewrites[0]).toHaveLength(1)
    expect(rewrites[0]![0]).toMatchObject({ subject: 's', read: true })
    expect(typeof rewrites[0]![0]!.readAt).toBe('number')
  })

  it('无变更不回写：全部已读的重复 markRead 与未知信箱都不触发 rewrite', () => {
    const rewrites: unknown[][] = []
    const mb = new Mailbox(undefined, {
      persistence: {
        append: () => {},
        rewrite: (items) => { rewrites.push([...items]) },
      },
    })
    mb.send({ from: 'B', to: 'A', subject: 's', body: 'b' })
    mb.markRead('A')
    expect(rewrites).toHaveLength(1)
    mb.markRead('A') // 全部已读 → changed=0，不回写
    mb.markRead('nobody') // 未知信箱 → 直接 return
    expect(rewrites).toHaveLength(1)
  })
})
