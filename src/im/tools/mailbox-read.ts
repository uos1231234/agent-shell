// mailbox_read: reads the caller's own mailbox inbox.
// Uses the shared Mailbox instance directly via closure.
// The agentId is read from ctx.agentId (P2: no longer a closure param).
//
// 50 封/批上限（用户拍板 2026-09-22）：判据是**实际返回条数**而非 limit
// 参数——不传 limit 的全量读才是打爆上下文的真正敞口。超限报错并给出
// 可执行出路：offset 分页 / mailbox_markread 推进未读队列 / 委派召回代理
// （ask_recall → 召回代理用 mailbox_read_any 跨邮箱分页代读，只回摘要）。

import type { SystemTool } from '../../shell/registry.js'
import { MAX_MAILS_PER_READ, type Mailbox } from '../mailbox/index.js'
import { wrapTool, toSchema, reasonField } from './helpers.js'

export const createMailboxReadTool = (mailbox: Mailbox): SystemTool => ({
  name: 'mailbox_read',
  description:
    '**系统提示"you have N unread"或你刚向别的代理问过话时，来这里读——压缩通知、失败告警和代理的回信都落在这里。**'
    + `返回 { now, mails }——now 是系统时钟（模型不知道墙上时间；与每封邮件的 sentAt 对比判断等了多久）。单次最多 ${MAX_MAILS_PER_READ} 封，超限报错：用 limit+offset 分页，批量/跨邮箱阅读委派给召回代理（ask_recall）。`
    + '**读信不会标已读**；确认邮件（同时产生发件人可见的已读回执）要调 mailbox_markread。',
  parameters: toSchema({
    unreadOnly: { type: 'boolean', description: 'If true, return only unread messages (default: true)' },
    limit: { type: 'integer', description: `Maximum number of messages to return (max ${MAX_MAILS_PER_READ} per call)` },
    offset: { type: 'integer', description: `Skip this many messages first (paging; combine with limit<=${MAX_MAILS_PER_READ})` },
    reason: reasonField,
  }, ['reason']),
  execute: wrapTool('mailbox_read', async (args, ctx) => {
    if (typeof ctx?.agentId !== 'string' || ctx.agentId.length === 0) {
      throw new Error('mailbox_read requires an agent identity in the tool context')
    }
    const a = args as { unreadOnly?: boolean; limit?: number; offset?: number }
    const opts: { unreadOnly?: boolean; limit?: number; offset?: number } = {}
    if (a.unreadOnly !== undefined) opts.unreadOnly = a.unreadOnly
    if (a.limit !== undefined) opts.limit = a.limit
    if (a.offset !== undefined) opts.offset = a.offset
    const mails = mailbox.readOwnInbox(ctx.agentId, opts)
    if (mails.length > MAX_MAILS_PER_READ) {
      throw new Error(
        `一次最多读 ${MAX_MAILS_PER_READ} 封邮件（本次命中 ${mails.length} 封）。两条出路：`
        + `① 分页——mailbox_read({ limit: ${MAX_MAILS_PER_READ}, offset: ${MAX_MAILS_PER_READ} }) 逐页读（读完可用 mailbox_markread 推进未读队列）；`
        + '② 批量或跨邮箱阅读请委派召回代理——ask_recall 提问，召回代理会用 mailbox_read_any 分页读完相关邮箱，只回你摘要与证据。',
      )
    }
    return { now: Date.now(), mails }
  }),
})
