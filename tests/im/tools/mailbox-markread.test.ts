import { describe, it, expect } from 'vitest'
import { createMailboxMarkReadTool } from '../../../src/im/tools/mailbox-markread.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'

describe('im/tools/mailbox-markread', () => {
  it('with ids marks only the listed mail (others stay unread)', async () => {
    const mailbox = new Mailbox()
    const id1 = mailbox.send({ from: 'main', to: 'warehouse', subject: 's1', body: 'b1' })
    mailbox.send({ from: 'main', to: 'warehouse', subject: 's2', body: 'b2' })
    const tool = createMailboxMarkReadTool(mailbox)
    await tool.execute(
      { ids: [id1], reason: 'ack first' },
      { agentId: 'warehouse' },
    )
    // second mail still unread
    expect(mailbox.hasUnread('warehouse')).toBe(true)
    // first mail read
    const inbox = mailbox.readOwnInbox('warehouse', { unreadOnly: false })
    const first = inbox.find((m) => m.id === id1)!
    expect(first.read).toBe(true)
  })

  it('without ids marks all unread mail read', async () => {
    const mailbox = new Mailbox()
    mailbox.send({ from: 'main', to: 'warehouse', subject: 's1', body: 'b1' })
    mailbox.send({ from: 'main', to: 'warehouse', subject: 's2', body: 'b2' })
    const tool = createMailboxMarkReadTool(mailbox)
    await tool.execute(
      { reason: 'ack all' },
      { agentId: 'warehouse' },
    )
    expect(mailbox.hasUnread('warehouse')).toBe(false)
  })

  it('marking read produces a read receipt the sender can see via sentStatus', async () => {
    const mailbox = new Mailbox()
    const id = mailbox.send({ from: 'main', to: 'warehouse', subject: 's', body: 'b' })
    const tool = createMailboxMarkReadTool(mailbox)
    await tool.execute(
      { ids: [id], reason: 'ack' },
      { agentId: 'warehouse' },
    )
    const status = mailbox.sentStatus('main', id)
    expect(status.read).toBe(true)
    expect(status.readAt).toBeGreaterThan(0)
  })

  it('throws when ctx.agentId is missing (no identity)', async () => {
    const mailbox = new Mailbox()
    const tool = createMailboxMarkReadTool(mailbox)
    await expect(
      tool.execute({ reason: 'no identity' }),
    ).rejects.toThrow('mailbox_markread requires an agent identity')
  })
})
