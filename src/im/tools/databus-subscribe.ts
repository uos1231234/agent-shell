// databus_subscribe: registers a buffered, self-expiring subscription.
// Matched tool turns are delivered one-by-one as mailbox notes from the
// reserved system sender 'databus'; the subscription expires by TTL or
// event cap (checked lazily on each event — no timers).

import type { SystemTool } from '../../shell/registry.js'
import type { Databus, AgentId } from '../databus.js'
import type { Mailbox } from '../mailbox/index.js'
import type { ToolContext } from '../../shared/tool-context.js'
import { wrapTool, toSchema, reasonField } from './helpers.js'

// TTL 是独立常量（10 min，硬编码）：per-run 时间上限已取消（maxElapsedMs =
// Infinity，v0.29），"1/3 session budget" 的原始推导不再成立——TTL 现在只是
// "订阅存活 10 分钟后视为陈旧" 的经验值。Cap = 20 events: with
// maxToolCalls 1000 over maxSteps 500 (~2 calls/round), one subscription
// should not absorb more than ~10 rounds of dense tool traffic.
export const SUBSCRIBE_DEFAULT_TTL_MS = 10 * 60 * 1000
export const SUBSCRIBE_DEFAULT_MAX_EVENTS = 20

const BODY_LIMIT = 500

export const createDatabusSubscribeTool = (mailbox: Mailbox): SystemTool => ({
  name: 'databus_subscribe',
  description:
    'Subscribe to NEW tool events from specific agents on the shared databus (push, real-time). '
    + 'Matched events arrive as mailbox notes (content capped at 500 chars for the note); '
    + 'the subscription expires automatically by TTL or event cap. '
    + 'This is for live monitoring of ongoing work (e.g. a sub-agent you dispatched). '
    + 'To recall the FULL content of PAST events use databus_query (pull) instead — subscribe only delivers the note preview, not the full record.',
  parameters: toSchema({
    sourceAgentIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'Agent IDs to subscribe to. Omit for all agents.',
    },
    ttlMs: {
      type: 'integer',
      description: 'Optional subscription lifetime in milliseconds (default 600000)',
    },
    maxEvents: {
      type: 'integer',
      description: 'Optional cap on delivered events (default 20)',
    },
    reason: reasonField,
  }, ['reason']),
  execute: wrapTool('databus_subscribe', async (args, ctx) => {
    if (!ctx?.databus) {
      throw new Error('databus_subscribe requires a databus in the tool context')
    }
    if (typeof ctx?.agentId !== 'string' || ctx.agentId.length === 0) {
      throw new Error('databus_subscribe requires an agent identity in the tool context')
    }
    const databus = ctx.databus as Databus
    const subscriberId: AgentId = ctx.agentId
    const a = args as { sourceAgentIds?: string[]; ttlMs?: number; maxEvents?: number }
    const ttlMs = a.ttlMs ?? SUBSCRIBE_DEFAULT_TTL_MS
    const maxEvents = a.maxEvents ?? SUBSCRIBE_DEFAULT_MAX_EVENTS
    const expiresAt = Date.now() + ttlMs
    let delivered = 0
    let closed = false

    const expire = (why: string): void => {
      if (closed) return
      closed = true
      for (const u of unsubs) u()
      mailbox.systemSend({
        from: 'databus',
        to: subscriberId,
        subject: `[databus] subscription ended (${why})`,
        body: `delivered ${delivered} of max ${maxEvents} events`,
      })
    }

    const onEvent = (turn: { sourceAgentId: AgentId; content: string }): void => {
      if (closed) return
      if (Date.now() >= expiresAt) { expire('expired'); return }
      if (delivered >= maxEvents) { expire('event cap reached'); return }
      delivered += 1
      mailbox.systemSend({
        from: 'databus',
        to: subscriberId,
        subject: `[databus] tool event from ${turn.sourceAgentId}`,
        body: turn.content.length > BODY_LIMIT
          ? turn.content.slice(0, BODY_LIMIT) + '...[truncated]'
          : turn.content,
      })
    }

    const unsubs: Array<() => void> = a.sourceAgentIds && a.sourceAgentIds.length > 0
      ? a.sourceAgentIds.map(id => databus.subscribe(id, onEvent))
      : [databus.subscribe('*', onEvent)]

    return `Subscribed to ${a.sourceAgentIds?.length ? a.sourceAgentIds.join(', ') : 'all agents'}. `
      + `Events arrive as mailbox notes for ${ttlMs}ms or up to ${maxEvents} events, whichever comes first.`
  }),
})
