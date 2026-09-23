import { describe, it, expect } from 'vitest'
import { createMailboxStatusTool } from '../../../src/im/tools/mailbox-status.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'

describe('im/tools/mailbox-status', () => {
  it('returns found:true for a mail the caller sent', async () => {
    const mailbox = new Mailbox()
    const id = mailbox.send({ from: 'main', to: 'warehouse', subject: 's', body: 'b' })
    const tool = createMailboxStatusTool(mailbox)
    const result = await tool.execute(
      { mailId: id, reason: 'check receipt' },
      { agentId: 'main' },
    )
    const status = result as { found: boolean; read: boolean }
    expect(status.found).toBe(true)
    expect(status.read).toBe(false)
  })

  it('returns found:false when caller is not the sender', async () => {
    const mailbox = new Mailbox()
    const id = mailbox.send({ from: 'main', to: 'warehouse', subject: 's', body: 'b' })
    const tool = createMailboxStatusTool(mailbox)
    const result = await tool.execute(
      { mailId: id, reason: 'snoop' },
      { agentId: 'other' },
    )
    const status = result as { found: boolean }
    expect(status.found).toBe(false)
  })

  it('throws when ctx.agentId is missing (no identity)', async () => {
    const mailbox = new Mailbox()
    const tool = createMailboxStatusTool(mailbox)
    await expect(
      tool.execute({ mailId: 'M-1-x', reason: 'no identity' }),
    ).rejects.toThrow('mailbox_status requires an agent identity')
  })
})
