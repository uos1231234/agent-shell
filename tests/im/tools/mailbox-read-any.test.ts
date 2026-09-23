// mailbox_read_any — 跨邮箱分页读信（2026-09-22 拍板）。
//
// 三条承重性质：
//  (1) 仅 recall 可调：ctx 身份硬校验（toolRefs 是第一道，这里是第二道）；
//  (2) 主代理的 allowlist 不含本工具（隔离在装配层也成立）；
//  (3) 同 50 封/批上限 + offset 翻页；recall 提示词已登记该工具职责。

import { describe, it, expect } from 'vitest'
import { createMailboxReadAnyTool } from '../../../src/im/tools/mailbox-read-any.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import { DEFAULT_WORKING_AGENT_TOOL_REFS } from '../../../src/im/minimal.js'
import { RECALL_AGENT_PROMPT } from '../../../src/im/prompts/index.js'

const seed = (mailbox: Mailbox, to: string, n: number): void => {
  for (let i = 0; i < n; i += 1) {
    mailbox.send({ from: 'main', to, subject: `s${i}`, body: `b${i}` })
  }
}

describe('im/tools/mailbox_read_any', () => {
  it('recall 身份可读任意代理的信箱（代读换出墓碑的主场景）', async () => {
    const mailbox = new Mailbox()
    seed(mailbox, 'main', 3)
    const tool = createMailboxReadAnyTool(mailbox)
    const result = await tool.execute(
      { agentId: 'main', reason: 'read tombstones for caller' },
      { agentId: 'recall' },
    ) as { now: number; agentId: string; mails: { subject: string }[] }
    expect(result.agentId).toBe('main')
    expect(result.mails).toHaveLength(3)
    expect(result.mails[0]!.subject).toBe('s0')
  })

  it('非 recall 身份 → 拒绝（第二道保险：即使误加进别人的 toolRefs）', async () => {
    const mailbox = new Mailbox()
    seed(mailbox, 'main', 1)
    const tool = createMailboxReadAnyTool(mailbox)
    for (const agentId of ['main', 'warehouse', 'compressor']) {
      await expect(
        tool.execute({ agentId: 'main', reason: 'x' }, { agentId }),
      ).rejects.toThrow(/reserved for the recall agent/)
    }
  })

  it('缺目标 agentId → 报错', async () => {
    const tool = createMailboxReadAnyTool(new Mailbox())
    await expect(
      tool.execute({ reason: 'x' }, { agentId: 'recall' }),
    ).rejects.toThrow(/requires a target agentId/)
  })

  it('同 50 封/批上限：51 封报错且错误含 offset 翻页指引', async () => {
    const mailbox = new Mailbox()
    seed(mailbox, 'main', 51)
    const tool = createMailboxReadAnyTool(mailbox)
    await expect(
      tool.execute({ agentId: 'main', reason: 'bulk read' }, { agentId: 'recall' }),
    ).rejects.toThrow(/一次最多读 50 封邮件（目标信箱 main 本次命中 51 封）[\s\S]*offset: 50/)
  })

  it('offset 翻页可读完大信箱', async () => {
    const mailbox = new Mailbox()
    seed(mailbox, 'main', 60)
    const tool = createMailboxReadAnyTool(mailbox)
    const p1 = await tool.execute(
      { agentId: 'main', limit: 50, reason: 'p1' }, { agentId: 'recall' },
    ) as { mails: { subject: string }[] }
    const p2 = await tool.execute(
      { agentId: 'main', limit: 50, offset: 50, reason: 'p2' }, { agentId: 'recall' },
    ) as { mails: { subject: string }[] }
    expect(p1.mails).toHaveLength(50)
    expect(p2.mails).toHaveLength(10)
    expect(p2.mails[0]!.subject).toBe('s50')
  })

  it('隔离面：主代理 allowlist 不含本工具；recall 提示词已登记其职责', () => {
    expect(DEFAULT_WORKING_AGENT_TOOL_REFS).not.toContain('mailbox_read_any')
    expect(RECALL_AGENT_PROMPT).toContain('mailbox_read_any')
    expect(RECALL_AGENT_PROMPT).toContain('Your five tools')
  })
})
