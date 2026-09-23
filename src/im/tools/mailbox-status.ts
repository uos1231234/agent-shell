// mailbox_status: sender-side read receipt for a mail you sent.
// Returns delivery/read status only — never another agent's mail content.

import type { SystemTool } from '../../shell/registry.js'
import type { Mailbox } from '../mailbox/index.js'
import { wrapTool, toSchema, reasonField } from './helpers.js'

export const createMailboxStatusTool = (mailbox: Mailbox): SystemTool => ({
  name: 'mailbox_status',
  description:
    '你发出的每封信都有 id（mailbox_send 返回）。**想知道对方读没读你的信时，用它查**：'
    + '返回送达状态（found）和已读回执（read + readAt），ageMs 告诉你这封信等了多久'
    + '——回信需要时间，**等够了再决定要不要跟进**。',
  parameters: toSchema({
    mailId: { type: 'string', description: 'The mail id returned by mailbox_send (e.g. "M-3-lxyz")' },
    reason: reasonField,
  }, ['mailId', 'reason']),
  execute: wrapTool('mailbox_status', async (args, ctx) => {
    if (typeof ctx?.agentId !== 'string' || ctx.agentId.length === 0) {
      throw new Error('mailbox_status requires an agent identity in the tool context')
    }
    const a = args as { mailId: string }
    return mailbox.sentStatus(ctx.agentId, a.mailId)
  }),
})
