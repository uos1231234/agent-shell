import { describe, it, expect } from 'vitest'
import { createMailboxReadTool } from '../../../src/im/tools/mailbox-read.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'

describe('im/tools/mailbox-read', () => {
  it('mailbox_read returns the agent\'s own inbox with implicit agentId (ctx)', async () => {
    const mailbox = new Mailbox()
    mailbox.send({ from: 'main', to: 'warehouse', subject: 's1', body: 'b1' })
    mailbox.send({ from: 'compressor', to: 'warehouse', subject: 's2', body: 'b2' })

    const tool = createMailboxReadTool(mailbox)
    const result = await tool.execute(
      { reason: 'check inbox' },
      { agentId: 'warehouse' },
    ) as { now: number; mails: readonly { id: string; from: string; subject: string }[] }

    expect(typeof result.now).toBe('number')
    const items = result.mails
    expect(items).toHaveLength(2)
    expect(items.some((i) => i.from === 'main' && i.subject === 's1')).toBe(true)
    expect(items.some((i) => i.from === 'compressor' && i.subject === 's2')).toBe(true)
  })

  it('uses ctx.agentId to scope inbox, not a closure param', async () => {
    const mailbox = new Mailbox()
    mailbox.send({ from: 'main', to: 'recall', subject: 'for recall', body: 'b' })
    mailbox.send({ from: 'main', to: 'warehouse', subject: 'for warehouse', body: 'b' })

    const tool = createMailboxReadTool(mailbox)
    const result = await tool.execute(
      { reason: 'check recall inbox' },
      { agentId: 'recall' },
    ) as { now: number; mails: readonly { id: string; from: string; subject: string }[] }
    const items = result.mails
    expect(items).toHaveLength(1)
    expect(items[0]!.subject).toBe('for recall')
  })

  it('throws when ctx.agentId is missing (no identity)', async () => {
    const mailbox = new Mailbox()
    const tool = createMailboxReadTool(mailbox)
    await expect(
      tool.execute({ reason: 'no identity' }),
    ).rejects.toThrow('mailbox_read requires an agent identity')
  })
})

describe('im/tools/mailbox-read — 50 封/批上限（2026-09-22 拍板）', () => {
  const seed = (mailbox: Mailbox, to: string, n: number): void => {
    for (let i = 0; i < n; i += 1) {
      mailbox.send({ from: 'main', to, subject: `s${i}`, body: `b${i}` })
    }
  }

  it('实际返回 51 封 → 报错，且错误含分页与委派召回两条出路', async () => {
    const mailbox = new Mailbox()
    seed(mailbox, 'warehouse', 51)
    const tool = createMailboxReadTool(mailbox)
    // 不传 limit 的全量读才是真正的敞口——判据必须落在实际返回条数上。
    await expect(tool.execute({ reason: 'read all' }, { agentId: 'warehouse' }))
      .rejects.toThrow(/一次最多读 50 封邮件（本次命中 51 封）[\s\S]*ask_recall[\s\S]*mailbox_read_any/)
  })

  it('恰好 50 封 → 正常返回', async () => {
    const mailbox = new Mailbox()
    seed(mailbox, 'warehouse', 50)
    const tool = createMailboxReadTool(mailbox)
    const result = await tool.execute({ reason: 'read' }, { agentId: 'warehouse' }) as { mails: unknown[] }
    expect(result.mails).toHaveLength(50)
  })

  it('limit>50 但实际不足 50 封 → 不报错（按实际条数判）', async () => {
    const mailbox = new Mailbox()
    seed(mailbox, 'warehouse', 10)
    const tool = createMailboxReadTool(mailbox)
    const result = await tool.execute({ reason: 'read', limit: 100 }, { agentId: 'warehouse' }) as { mails: unknown[] }
    expect(result.mails).toHaveLength(10)
  })

  it('offset 分页：60 封、limit 50 → 首页 50，offset 50 → 第二页 10', async () => {
    const mailbox = new Mailbox()
    seed(mailbox, 'warehouse', 60)
    const tool = createMailboxReadTool(mailbox)
    const page1 = await tool.execute({ reason: 'page1', limit: 50 }, { agentId: 'warehouse' }) as { mails: { subject: string }[] }
    expect(page1.mails).toHaveLength(50)
    expect(page1.mails[0]!.subject).toBe('s0')
    const page2 = await tool.execute({ reason: 'page2', limit: 50, offset: 50 }, { agentId: 'warehouse' }) as { mails: { subject: string }[] }
    expect(page2.mails).toHaveLength(10)
    expect(page2.mails[0]!.subject).toBe('s50')
  })
})
