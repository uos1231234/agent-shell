// 真实并发测试（场景 2）：appendCanonicalTurn 并发写入 canonical conversation。
//
// 机制来源（已读代码）：
//   src/im/turn.ts:54-63  appendCanonicalTurn
//     conversation.append(turn) 然后（仅 tool 回合） databus.append(turn)
//     —— 两个 append 之间【无任何 await】（ConversationMemory.append 是同步数组 push，
//        Databus.append 同理），所以单次调用是原子的；并发调用之间不会在
//        "conversation 已写、databus 未写" 的中间态交错。
//   src/im/conversation-memory.ts:18  append 仅 this.stored.push
//
// 关键不变量（被本测试守护，防止有人在两个 append 间插入 await 破坏配对）：
//   每个 tool 回合在 conversation 与 databus 的【同一下标】位置成对出现，
//   即 conversation.turns()[i].toolCallId === databus.turns()[i].toolCallId。

import { describe, it, expect } from 'vitest'
import { appendCanonicalTurn } from '../../../src/im/turn.js'
import { ConversationMemory } from '../../../src/im/conversation-memory.js'
import { Databus } from '../../../src/im/databus.js'

const toolTurn = (i: number) => ({
  id: `tool-${i}`,
  role: 'tool' as const,
  toolCallId: `tc-${i}`,
  content: `OUT-${i}`,
  at: i,
  sourceAgentId: 'main',
})
const userTurn = (i: number) => ({ id: `user-${i}`, role: 'user' as const, content: `U${i}`, at: i })
const assistantTurn = (i: number) => ({ id: `asst-${i}`, role: 'assistant' as const, content: `A${i}`, at: i })

describe('concurrency: appendCanonicalTurn 并发回写', () => {
  it('并发 N 次回写后：用户/助手全进 conversation，工具回合在 conversation 与 databus 同下标成对', async () => {
    const mem = new ConversationMemory()
    const bus = new Databus({ sessionId: 's' })

    // 混合：10 个 user、10 个 assistant、30 个 tool 回合，并发写入。
    const jobs: Array<() => void> = []
    for (let i = 0; i < 10; i++) {
      jobs.push(() => appendCanonicalTurn(mem, bus, userTurn(i)))
      jobs.push(() => appendCanonicalTurn(mem, bus, assistantTurn(i)))
    }
    for (let i = 0; i < 30; i++) jobs.push(() => appendCanonicalTurn(mem, bus, toolTurn(i)))

    // 用 await Promise.resolve() 制造交错（虽然被调用函数本身无 await，仍验证
    // 任意调度下配对不变量成立）。
    await Promise.all(jobs.map(async (j) => { await Promise.resolve(); j() }))

    // 数量完整
    expect(mem.turns()).toHaveLength(50)
    expect(bus.turns()).toHaveLength(30) // 仅 tool 回合进 databus
    // conversation 含 10 user + 10 assistant + 30 tool
    expect(mem.turns().filter((t) => t.role === 'user')).toHaveLength(10)
    expect(mem.turns().filter((t) => t.role === 'assistant')).toHaveLength(10)

    // 配对：同一下标 toolCallId 一致（conversation 与 databus）
    const memTools = mem.turns().filter((t) => t.role === 'tool') as unknown as Array<{ toolCallId: string }>
    const busTools = bus.turns() as unknown as Array<{ toolCallId: string }>
    expect(memTools).toHaveLength(30)
    expect(busTools).toHaveLength(30)
    for (let i = 0; i < 30; i++) {
      expect(memTools[i]!.toolCallId).toBe(busTools[i]!.toolCallId)
      expect(memTools[i]!.toolCallId).toBe(`tc-${i}`)
    }
  })

  it('并发写入下无重复 toolCallId、无丢失（每个 id 恰好出现一次）', async () => {
    const mem = new ConversationMemory()
    const bus = new Databus({ sessionId: 's' })
    const jobs: Array<() => void> = []
    for (let i = 0; i < 40; i++) jobs.push(() => appendCanonicalTurn(mem, bus, toolTurn(i)))
    await Promise.all(jobs.map(async (j) => { await Promise.resolve(); j() }))

    const ids = new Set(bus.turns().map((t) => (t as { toolCallId: string }).toolCallId))
    expect(ids.size).toBe(40) // 无重复
    expect(bus.turns()).toHaveLength(40) // 无丢失
  })
})
