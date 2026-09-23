// mailbox_markread: acknowledges mail in YOUR OWN inbox. Marks items read
// (stamping readAt, which the senders of those mails can see as a read
// receipt via mailbox_status). Privacy: only your own inbox is touched.

import type { SystemTool } from '../../shell/registry.js'
import type { Mailbox } from '../mailbox/index.js'
import { wrapTool, toSchema, reasonField } from './helpers.js'

export const createMailboxMarkReadTool = (mailbox: Mailbox): SystemTool => ({
  name: 'mailbox_markread',
  description:
    '**读完信、确认处理完毕后把消息标为已读**——这一步会向发件人送达已读回执'
    + '（他们查状态时看到"已读"），信箱也随之保持干净。不带参数标全部，带 ids 只标列出的。',
  parameters: toSchema({
    ids: { type: 'array', items: { type: 'string' }, description: 'Optional: specific mail ids to mark read; omit to mark all unread mail read' },
    reason: reasonField,
  }, ['reason']),
  execute: wrapTool('mailbox_markread', async (args, ctx) => {
    if (typeof ctx?.agentId !== 'string' || ctx.agentId.length === 0) {
      throw new Error('mailbox_markread requires an agent identity in the tool context')
    }
    const a = args as { ids?: string[] }
    if (a.ids !== undefined) {
      mailbox.markRead(ctx.agentId, a.ids)
    } else {
      mailbox.markRead(ctx.agentId)
    }
    return 'Mail marked as read.'
  }),
})
