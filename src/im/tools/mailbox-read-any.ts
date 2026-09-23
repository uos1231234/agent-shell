// mailbox_read_any: 跨邮箱分页读信——**仅召回代理可用**（用户拍板 2026-09-22）。
//
// 存在理由：主代理的 mailbox_read 被 50 封/批上限挡住时，批量阅读（尤其是
// 换出墓碑邮件——它们发往 main 自己的信箱）要委派给召回代理代读：读信发生在
// 召回代理自己的上下文里，主代理只收到摘要与证据，窗口不被邮件全文打爆。
//
// 双保险隔离：
//   1. toolRefs——本工具只登记在 recall 的 toolRefs（system-agents/index.ts），
//      主代理的 DEFAULT_WORKING_AGENT_TOOL_REFS 是 allowlist，不含本工具；
//   2. ctx 身份——execute 内硬校验 ctx.agentId === 'recall'，即使日后有人误把
//      工具加进别人的 toolRefs 也拒执行（P2 路由隔离的工具层延伸）。
//
// 同 50 封/批上限 + offset 翻页：召回代理自己也是 LLM 上下文，无上限代读
// 只是把爆炸换个屋子炸。

import type { SystemTool } from '../../shell/registry.js'
import { MAX_MAILS_PER_READ, type Mailbox } from '../mailbox/index.js'
import { wrapTool, toSchema, reasonField } from './helpers.js'

export const createMailboxReadAnyTool = (mailbox: Mailbox): SystemTool => ({
  name: 'mailbox_read_any',
  description:
    '（仅召回代理可用）跨邮箱分页读取任意代理的信箱——主代理 mailbox_read 超 50 封报错时会把批量阅读委派给你。'
    + `返回 { now, agentId, mails }。单次最多 ${MAX_MAILS_PER_READ} 封，用 offset 翻页读完。`
    + '读完把结论写进 answer、把 mail id + sentAt 当证据写进 evidence 回报调用方——不要把邮件原文整段转抄回去。',
  parameters: toSchema({
    agentId: { type: 'string', description: 'Target inbox owner (e.g. "main")' },
    unreadOnly: { type: 'boolean', description: 'If true, return only unread messages (default: true)' },
    limit: { type: 'integer', description: `Maximum number of messages to return (max ${MAX_MAILS_PER_READ} per call)` },
    offset: { type: 'integer', description: `Skip this many messages first (paging; combine with limit<=${MAX_MAILS_PER_READ})` },
    reason: reasonField,
  }, ['agentId', 'reason']),
  execute: wrapTool('mailbox_read_any', async (args, ctx) => {
    if (ctx?.agentId !== 'recall') {
      throw new Error('mailbox_read_any is reserved for the recall agent; the working agent must delegate via ask_recall')
    }
    const a = args as { agentId?: string; unreadOnly?: boolean; limit?: number; offset?: number }
    if (typeof a.agentId !== 'string' || a.agentId.length === 0) {
      throw new Error('mailbox_read_any requires a target agentId (e.g. "main")')
    }
    const opts: { unreadOnly?: boolean; limit?: number; offset?: number } = {}
    if (a.unreadOnly !== undefined) opts.unreadOnly = a.unreadOnly
    if (a.limit !== undefined) opts.limit = a.limit
    if (a.offset !== undefined) opts.offset = a.offset
    const mails = mailbox.readOwnInbox(a.agentId, opts)
    if (mails.length > MAX_MAILS_PER_READ) {
      throw new Error(
        `一次最多读 ${MAX_MAILS_PER_READ} 封邮件（目标信箱 ${a.agentId} 本次命中 ${mails.length} 封）。`
        + `用 mailbox_read_any({ agentId: '${a.agentId}', limit: ${MAX_MAILS_PER_READ}, offset: ${Number(a.offset ?? 0) + MAX_MAILS_PER_READ} }) 翻页继续，或收窄 unreadOnly。`,
      )
    }
    return { now: Date.now(), agentId: a.agentId, mails }
  }),
})
