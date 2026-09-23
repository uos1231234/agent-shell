import { describe, it, expect } from 'vitest'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import { AgentTree } from '../../../src/im/sub-agent/tree.js'

// v0.30 (用户拍板 2026-09-09，修法 A)：系统智能体注册进 agentTree 后，
// mailbox 路由不再 fail-closed 拒绝它们的邮件。
describe('im/mailbox: system agents registered in the agent tree (v0.30 A)', () => {
  it('before registration a system agent send is rejected (fail-closed)', () => {
    const tree = new AgentTree({ rootId: 'main' })
    const mb = new Mailbox(tree)
    expect(() => mb.send({ from: 'warehouse', to: 'main', subject: 's', body: 'b' }))
      .toThrow(/route rejected/i)
  })

  it('after registerChild the system agent can mail the working agent', () => {
    const tree = new AgentTree({ rootId: 'main' })
    tree.registerChild('main', 'warehouse')
    const mb = new Mailbox(tree)
    const id = mb.send({ from: 'warehouse', to: 'main', subject: 'M3 归档完成', body: '已归档 3 块' })
    expect(mb.inboxSize('main')).toBe(1)
    expect(mb.readOwnInbox('main')[0]!.subject).toBe('M3 归档完成')
  })

  it('system agents can mail each other (siblings)', () => {
    const tree = new AgentTree({ rootId: 'main' })
    tree.registerChild('main', 'warehouse')
    tree.registerChild('main', 'recall')
    const mb = new Mailbox(tree)
    expect(() => mb.send({ from: 'recall', to: 'warehouse', subject: 'stamp?', body: '关于 X 块的 stamp？' }))
      .not.toThrow()
    expect(mb.inboxSize('warehouse')).toBe(1)
  })

  it('sub-agents (also root children) can mail system agents', () => {
    const tree = new AgentTree({ rootId: 'main' })
    tree.registerChild('main', 'warehouse')
    tree.registerChild('main', 'sub-abc')
    const mb = new Mailbox(tree)
    expect(() => mb.send({ from: 'sub-abc', to: 'warehouse', subject: 'hi', body: '问题' }))
      .not.toThrow()
  })

  it('per-session trees isolate system agents across sessions', () => {
    const treeA = new AgentTree({ rootId: 'main-a' })
    const treeB = new AgentTree({ rootId: 'main-b' })
    treeA.registerChild('main-a', 'warehouse')
    treeB.registerChild('main-b', 'warehouse')
    const mbA = new Mailbox(treeA)
    const mbB = new Mailbox(treeB)
    // 各自会话内的 warehouse 给各自工作代理发信都通
    expect(() => mbA.send({ from: 'warehouse', to: 'main-a', subject: 's', body: 'b' })).not.toThrow()
    expect(() => mbB.send({ from: 'warehouse', to: 'main-b', subject: 's', body: 'b' })).not.toThrow()
  })
})