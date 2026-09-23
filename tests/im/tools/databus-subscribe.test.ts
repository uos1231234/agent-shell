import { describe, it, expect } from 'vitest'
import { createDatabusSubscribeTool, SUBSCRIBE_DEFAULT_TTL_MS, SUBSCRIBE_DEFAULT_MAX_EVENTS } from '../../../src/im/tools/databus-subscribe.js'
import { Databus } from '../../../src/im/databus.js'
import type { ToolTurn } from '../../../src/im/databus.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import type { ToolContext } from '../../../src/shared/tool-context.js'

const toolTurn = (overrides: Partial<ToolTurn> = {}): ToolTurn => ({
  id: 't1',
  role: 'tool',
  toolCallId: 'tc-1',
  content: 'result',
  sourceAgentId: 'main',
  at: 1,
  ...overrides,
})

describe('im/tools/databus-subscribe', () => {
  it('delivers matched events as mailbox notes and expires at event cap', async () => {
    const databus = new Databus()
    const mailbox = new Mailbox()
    const tool = createDatabusSubscribeTool(mailbox)
    const ctx: ToolContext = { databus, agentId: 'recall' }

    const result = await tool.execute({ sourceAgentIds: ['main'], maxEvents: 2, reason: 'monitor' }, ctx)
    expect(result).toContain('Subscribed to main')

    // Append 3 matching turns — only 2 should be delivered, then a cap notice.
    databus.append(toolTurn({ id: 'e1', sourceAgentId: 'main', content: 'event-1', at: 1 }))
    databus.append(toolTurn({ id: 'e2', sourceAgentId: 'main', content: 'event-2', at: 2 }))
    databus.append(toolTurn({ id: 'e3', sourceAgentId: 'main', content: 'event-3', at: 3 }))

    const inbox = mailbox.readOwnInbox('recall', { unreadOnly: false })
    // 2 event notifications + 1 cap-reached termination notice
    expect(inbox).toHaveLength(3)
    expect(inbox[0]!.from).toBe('databus')
    expect(inbox[0]!.subject).toContain('tool event from main')
    expect(inbox[1]!.subject).toContain('tool event from main')
    expect(inbox[2]!.subject).toContain('subscription ended')
    expect(inbox[2]!.subject).toContain('event cap reached')
  })

  it('expires by TTL (lazy check on next event)', async () => {
    const databus = new Databus()
    const mailbox = new Mailbox()
    const tool = createDatabusSubscribeTool(mailbox)
    // ttlMs: -1 means expiresAt is already in the past at registration time.
    const ctx: ToolContext = { databus, agentId: 'recall' }

    await tool.execute({ sourceAgentIds: ['main'], ttlMs: -1, reason: 'short ttl' }, ctx)

    // The next matching event should only produce the expiry notice, no delivery.
    databus.append(toolTurn({ id: 'e1', sourceAgentId: 'main', content: 'event-1', at: 1 }))

    const inbox = mailbox.readOwnInbox('recall', { unreadOnly: false })
    expect(inbox).toHaveLength(1)
    expect(inbox[0]!.subject).toContain('subscription ended')
    expect(inbox[0]!.subject).toContain('expired')
  })

  it('wildcard subscription receives events from any sourceAgentId', async () => {
    const databus = new Databus()
    const mailbox = new Mailbox()
    const tool = createDatabusSubscribeTool(mailbox)
    const ctx: ToolContext = { databus, agentId: 'recall' }

    // No sourceAgentIds → subscribes to '*' (all agents)
    await tool.execute({ maxEvents: 10, reason: 'all agents' }, ctx)

    databus.append(toolTurn({ id: 'e1', sourceAgentId: 'main', content: 'from-main', at: 1 }))
    databus.append(toolTurn({ id: 'e2', sourceAgentId: 'warehouse', content: 'from-warehouse', at: 2 }))

    const inbox = mailbox.readOwnInbox('recall', { unreadOnly: false })
    expect(inbox).toHaveLength(2)
    expect(inbox[0]!.subject).toContain('from main')
    expect(inbox[1]!.subject).toContain('from warehouse')
  })

  it('truncates event body to BODY_LIMIT', async () => {
    const databus = new Databus()
    const mailbox = new Mailbox()
    const tool = createDatabusSubscribeTool(mailbox)
    const ctx: ToolContext = { databus, agentId: 'recall' }

    await tool.execute({ sourceAgentIds: ['main'], maxEvents: 1, reason: 'big event' }, ctx)
    const longContent = 'x'.repeat(600)
    databus.append(toolTurn({ id: 'e1', sourceAgentId: 'main', content: longContent, at: 1 }))

    const inbox = mailbox.readOwnInbox('recall', { unreadOnly: false })
    expect(inbox[0]!.body).toContain('...[truncated]')
    expect(inbox[0]!.body.length).toBeLessThan(longContent.length)
  })

  it('throws when ctx.databus is missing', async () => {
    const mailbox = new Mailbox()
    const tool = createDatabusSubscribeTool(mailbox)
    await expect(tool.execute({ reason: 'subscribe' })).rejects.toThrow('databus_subscribe requires a databus')
  })

  it('throws when ctx.agentId is missing', async () => {
    const databus = new Databus()
    const mailbox = new Mailbox()
    const tool = createDatabusSubscribeTool(mailbox)
    const ctx: ToolContext = { databus }
    await expect(tool.execute({ reason: 'subscribe' }, ctx)).rejects.toThrow('databus_subscribe requires an agent identity')
  })

  it('exports default TTL and max events constants', () => {
    expect(SUBSCRIBE_DEFAULT_TTL_MS).toBe(10 * 60 * 1000)
    expect(SUBSCRIBE_DEFAULT_MAX_EVENTS).toBe(20)
  })

})
