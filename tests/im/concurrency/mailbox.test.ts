// 真实并发测试（场景 8）：Mailbox 并发 send / read / markRead。
//
// 机制来源（已读代码）：
//   src/im/mailbox/mailbox.ts
//     - send → deliver（同步：++nextId、inbox.push）整个调用【无 await】，
//       所以并发 send 在 JS 单线程下是原子的，不会把 nextId 或 push 交错。
//     - readOwnInbox / markRead / hasUnread 也是同步、对快照操作。
//   结论：并发安全性由「全程同步、无 await」保证（这是设计事实，本测试守护该
//   不变量；若有人把 deliver 改异步或插入 await，测试会抓到 nextId 重复/丢信）。
//
// 注意：因 send 同步，Promise.all 并不能制造真正的微任务交错——但本测试仍
// 通过真实并发入口断言「无丢失 / 无重复 id / 未读计数一致」，作为回归护栏。

import { describe, it, expect } from 'vitest'
import { Mailbox } from '../../../src/im/mailbox/index.js'

describe('concurrency: Mailbox 并发收发', () => {
  it('并发向同一收件人 send N 封：inbox 数量=N、id 全唯一、hasUnread=true', async () => {
    const mb = new Mailbox()
    const N = 50
    const ids = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        Promise.resolve().then(() => mb.send({ from: 'a', to: 'bob', subject: `s${i}`, body: `body-${i}` }))),
    )
    expect(mb.inboxSize('bob')).toBe(N)
    expect(new Set(ids).size).toBe(N) // 无重复 id（nextId 自增未被交错破坏）
    expect(mb.hasUnread('bob')).toBe(true)
    expect(ids).toHaveLength(N)
  })

  it('广播 send（to 数组）并发：每个收件人各收到一封，且 id 一致', async () => {
    const mb = new Mailbox()
    const id = await Promise.resolve().then(() =>
      mb.send({ from: 'a', to: ['x', 'y', 'z'], subject: 'hi', body: 'broadcast' }),
    )
    for (const who of ['x', 'y', 'z']) {
      const inbox = mb.readOwnInbox(who)
      expect(inbox).toHaveLength(1)
      expect(inbox[0]!.id).toBe(id) // 同一封广播，三方 id 相同
    }
  })

  it('并发 send + markRead + read：未读计数最终一致、不丢信', async () => {
    const mb = new Mailbox()
    const N = 30
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        Promise.resolve().then(() => mb.send({ from: 'a', to: 'b', subject: `s${i}`, body: `b${i}` }))),
    )
    // 读取未读（应 30），再并发标记部分为已读
    const before = mb.readOwnInbox('b', { unreadOnly: true })
    expect(before).toHaveLength(N)
    const half = before.slice(0, 15).map((m) => m.id)
    await Promise.all(half.map((id) => Promise.resolve().then(() => mb.markRead('b', [id]))))

    expect(mb.readOwnInbox('b', { unreadOnly: true })).toHaveLength(N - 15) // 剩余未读
    expect(mb.inboxSize('b')).toBe(N) // 总数不变（标记已读不是删除）
  })

  it('并发 send 到不同收件人：互不串台', async () => {
    const mb = new Mailbox()
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => mb.send({ from: 'a', to: 'u1', subject: `a${i}`, body: '1' }))),
      ...Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => mb.send({ from: 'a', to: 'u2', subject: `b${i}`, body: '2' }))),
    ])
    expect(mb.inboxSize('u1')).toBe(20)
    expect(mb.inboxSize('u2')).toBe(20)
  })
})
