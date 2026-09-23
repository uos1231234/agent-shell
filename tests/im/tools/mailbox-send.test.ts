import { describe, it, expect } from 'vitest'
import { createMailboxSendTool } from '../../../src/im/tools/mailbox-send.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'

describe('im/tools/mailbox-send', () => {
  it('mailbox_send writes to the mailbox with implicit from (ctx.agentId)', async () => {
    const mailbox = new Mailbox()
    const tool = createMailboxSendTool(mailbox)
    const result = await tool.execute(
      { to: 'warehouse', subject: 'hello', body: 'world', reason: 'notify' },
      { agentId: 'main' },
    )

    expect(result).toMatch(/^Message sent, id: /)
    // The warehouse inbox should have the message with from='main' (from ctx.agentId)
    const inbox = mailbox.readOwnInbox('warehouse', { unreadOnly: false })
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({ from: 'main', subject: 'hello', body: 'world' })
  })

  it('uses ctx.agentId as sender identity, not a closure param', async () => {
    const mailbox = new Mailbox()
    const tool = createMailboxSendTool(mailbox)
    await tool.execute(
      { to: 'recall', subject: 'from warehouse', body: 'hi', reason: 'test identity' },
      { agentId: 'warehouse' },
    )
    const inbox = mailbox.readOwnInbox('recall', { unreadOnly: false })
    expect(inbox[0]).toMatchObject({ from: 'warehouse' })
  })

  it('throws when ctx.agentId is missing (no identity)', async () => {
    const mailbox = new Mailbox()
    const tool = createMailboxSendTool(mailbox)
    await expect(
      tool.execute({ to: 'recall', subject: 'x', body: 'y', reason: 'no identity' }),
    ).rejects.toThrow('mailbox_send requires an agent identity')
  })

  it('passes summary through to the delivered mail item', async () => {
    const mailbox = new Mailbox()
    const tool = createMailboxSendTool(mailbox)
    await tool.execute(
      { to: 'warehouse', subject: 'hello', body: 'world', summary: 'a one-liner', reason: 'with summary' },
      { agentId: 'main' },
    )
    const inbox = mailbox.readOwnInbox('warehouse', { unreadOnly: false })
    expect(inbox[0]!.summary).toBe('a one-liner')
  })
})
