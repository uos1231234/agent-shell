// mailbox_send: sends a message to another agent's mailbox.
// Uses the shared Mailbox instance directly via closure.
// The `from` field is read from ctx.agentId (P2: no longer a closure param).

import type { SystemTool } from '../../shell/registry.js'
import type { Mailbox } from '../mailbox/index.js'
import { wrapTool, toSchema, reasonField } from './helpers.js'

export const createMailboxSendTool = (mailbox: Mailbox): SystemTool => ({
  name: 'mailbox_send',
  description:
    '**当你需要的信息恰好在另一个代理的视野里——例如 warehouse 刚归档了记忆块、你想问它要对应的 stamp，'
    + '或兄弟子代理刚探索完你没看过的区域——用这条通道开口。**'
    + '给另一个代理的收件箱发消息，**送达是同步的**：调用成功返回时邮件已在收件人收件箱里。'
    + '发完之后等待、用 mailbox_status 查询；回信需要时间，距上封信足够久才值得发跟进。'
    + '提供一行 summary 让收件人一眼分诊。',
  parameters: toSchema({
    to: {
      type: 'string',
      description: 'Recipient agent ID (or array of IDs)',
    },
    subject: { type: 'string', description: 'Message subject' },
    body: { type: 'string', description: 'Message body' },
    summary: { type: 'string', description: 'Optional one-line overview of the message (max 200 chars, truncated if longer) shown to the recipient before they read the full body' },
    replyTo: { type: 'string', description: 'Optional: ID of the message this is a reply to' },
    reason: reasonField,
  }, ['to', 'subject', 'body', 'reason']),
  execute: wrapTool('mailbox_send', async (args, ctx) => {
    if (typeof ctx?.agentId !== 'string' || ctx.agentId.length === 0) {
      throw new Error('mailbox_send requires an agent identity in the tool context')
    }
    const a = args as { to: string | string[]; subject: string; body: string; replyTo?: string; summary?: string }
    const msg: { from: string; to: string | string[]; subject: string; body: string; replyTo?: string; summary?: string } = {
      from: ctx.agentId, to: a.to, subject: a.subject, body: a.body,
    }
    if (a.replyTo !== undefined) msg.replyTo = a.replyTo
    if (a.summary !== undefined) msg.summary = a.summary
    const id = mailbox.send(msg)
    const recipients = Array.isArray(a.to) ? a.to : [a.to]
    return `Message sent, id: ${id} — delivered to ${recipients.length} recipient(s). Check read status with mailbox_status.`
  }),
})
