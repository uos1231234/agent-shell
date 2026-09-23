// 真实并发测试（场景 1）：loop 工具调用按 category 分桶并发 + parallelSafe 独立桶
// + 工具结果配对正确性。
//
// 机制来源（已亲自读代码，未猜）：
//   src/im/loop.ts:323-391  executeToolCalls
//     - parallelSafe 调用 → parallelSafeItems 单独成桶，全部同时执行（不受 limit）
//     - 其余按 getToolCategory 分组，每组按 CONCURRENCY_LIMITS[category] 切批
//       Promise.all 并发执行，结果按原始 idx 写回 turns[idx]（配对正确性来源）
//   src/shell/registry.ts:34-38  CONCURRENCY_LIMITS = { read:5, write:3, command:3 }
//   src/im/loop.ts:683-388   分桶之间是「顺序」执行（await runBatch 串起各桶），
//                             不是并行——这是与任务假设「不同桶之间并行」不符的事实，见报告。
//
// 确定性构造：用 scripted harness 的 raw chunk 在一轮里产出 N 个 tool_call（多 index），
// 真实跑 runIMLoop。假工具在被调用时同步递增共享 current 计数并记录峰值与进入顺序，
// 然后 await Promise.resolve() 让同批其它工具也完成同步前置——这样在下一个 await 前
// current 已到达本批并发峰值，无需 sleep 即可确定性观测分桶并发上限。

import { describe, it, expect } from 'vitest'
import { runIMLoop } from '../../../src/im/loop.js'
import { ToolRegistry } from '../../../src/shell/registry.js'
import { createConfig } from '../../../src/shell/config.js'
import { createMetrics } from '../../../src/shell/metrics.js'
import { Databus } from '../../../src/im/databus.js'
import { ConversationMemory } from '../../../src/im/conversation-memory.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import { createNoopStateLine } from '../../../src/im/state-line/index.js'
import type { SystemAgent } from '../../../src/im/system-agent.js'
import { CONCURRENCY_LIMITS } from '../../../src/shell/registry.js'
import { createScriptedStreamChat, type ScriptStep, type ScriptedStreamChat } from '../../harness/index.js'

const noopSystemAgent: SystemAgent = { run: async () => { throw new Error('noop') }, stop() {}, send() {} }

// 并发观测器：每个假工具进入时同步递增 current、刷新峰值、记录进入顺序；
// 然后 await Promise.resolve() 让同批其它工具的同步前置先跑完（current 已到峰值）。
type Cat = 'parallelSafe' | 'read' | 'write' | 'command'
const makeTracker = () => {
  const state = { current: 0, max: { parallelSafe: 0, read: 0, write: 0, command: 0 } as Record<Cat, number>, order: [] as Cat[] }
  return state
}

const track = (t: ReturnType<typeof makeTracker>, cat: Cat): void => {
  t.current += 1
  t.max[cat] = Math.max(t.max[cat], t.current)
  t.order.push(cat)
}

// 构造假工具。parallelSafe=true 的工具进入独立桶（不受 limit）。
const mkTool = (name: string, cat: Cat, tracker: ReturnType<typeof makeTracker>, ps = false) => ({
  name,
  category: (ps ? 'read' : cat) as 'read' | 'write' | 'command',
  ...(ps ? { parallelSafe: () => true } : {}),
  parameters: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] } as const,
  execute: async (args: unknown) => {
    const c: Cat = ps ? 'parallelSafe' : (cat as Cat)
    track(tracker, c)
    await Promise.resolve() // 让同批其它工具的同步前置先完成（峰值已记录）
    tracker.current -= 1
    return `OUT:${(args as { tag: string }).tag}`
  },
})

// 一轮里产出 N 个 tool_call 的 raw chunk 序列（连续 index）。
const multiToolRound = (specs: Array<{ name: string; tag: string }>): ScriptStep => ({
  kind: 'raw',
  chunks: [
    ...specs.flatMap((s, i) => [
      { type: 'tool_call_delta', index: i, id: `call_0_${i}`, name: s.name } as const,
      { type: 'tool_call_delta', index: i, arguments_delta: JSON.stringify({ tag: s.tag }) } as const,
    ]),
    { type: 'finish', reason: 'tool_calls' } as const,
    { type: 'usage', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } as const,
    { type: 'done' } as const,
  ],
})

const buildSpecs = () => {
  const specs: Array<{ name: string; tag: string }> = []
  for (let i = 0; i < 4; i++) specs.push({ name: `ps${i}`, tag: `t_ps${i}` }) // parallelSafe
  for (let i = 0; i < 7; i++) specs.push({ name: `r${i}`, tag: `t_r${i}` }) // read ×7 → 5+2
  for (let i = 0; i < 3; i++) specs.push({ name: `w${i}`, tag: `t_w${i}` }) // write ×3 → 1 批
  for (let i = 0; i < 5; i++) specs.push({ name: `c${i}`, tag: `t_c${i}` }) // command ×5 → 3+2
  return specs // 共 19 个调用
}

describe('concurrency: loop 工具分桶并发 + parallelSafe + 配对', () => {
  it('同一 category 桶并发数不超过 CONCURRENCY_LIMITS，parallelSafe 不受限且独立并发', async () => {
    const tracker = makeTracker()
    const specs = buildSpecs()
    const registry = new ToolRegistry()
    for (const s of specs) {
      const cat: Cat = s.name.startsWith('ps') ? 'parallelSafe' : s.name.startsWith('r') ? 'read' : s.name.startsWith('w') ? 'write' : 'command'
      registry.registerSystemTool(mkTool(s.name, cat, tracker, s.name.startsWith('ps')) as never)
    }
    // 工具名全部进白名单（真实装配语义）。
    const refs = specs.map((s) => s.name)

    const scripted: ScriptedStreamChat = createScriptedStreamChat([
      multiToolRound(specs),
      { kind: 'text', content: 'DONE' },
    ])

    await runIMLoop({
      config: createConfig({ maxSteps: 50 }),
      registry,
      databus: new Databus(),
      conversationMemory: new ConversationMemory(),
      workingAgentId: 'main',
      mailbox: new Mailbox(),
      systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
      stateLine: createNoopStateLine(),
      initialMetrics: createMetrics(),
      streamChat: scripted,
      url: 'https://x',
      model: 'gpt-4',
      systemPrompt: 'SYS',
      userTemplate: 'TEMPLATE',
      systemToolRefs: refs,
      mcpRefs: [],
      skillRefs: [],
    })

    // (1) 同桶并发不超过阈值
    expect(tracker.max.read).toBeLessThanOrEqual(CONCURRENCY_LIMITS.read)
    expect(tracker.max.write).toBeLessThanOrEqual(CONCURRENCY_LIMITS.write)
    expect(tracker.max.command).toBeLessThanOrEqual(CONCURRENCY_LIMITS.command)
    // read 桶 7 个调用被切成 5+2 两批 → 峰值精确等于 5
    expect(tracker.max.read).toBe(CONCURRENCY_LIMITS.read)
    // write 桶恰好 3 个 → 峰值精确等于 3
    expect(tracker.max.write).toBe(CONCURRENCY_LIMITS.write)
    // command 桶 5 个切成 3+2 → 峰值精确等于 3
    expect(tracker.max.command).toBe(CONCURRENCY_LIMITS.command)

    // (2) parallelSafe 独立桶：全部同时执行（4 个一起），不受任何 category 上限约束
    expect(tracker.max.parallelSafe).toBe(4)
  })

  it('不同 category 桶是顺序执行（非并行），且 parallelSafe 最先行', async () => {
    const tracker = makeTracker()
    const specs = buildSpecs()
    const registry = new ToolRegistry()
    for (const s of specs) {
      const cat: Cat = s.name.startsWith('ps') ? 'parallelSafe' : s.name.startsWith('r') ? 'read' : s.name.startsWith('w') ? 'write' : 'command'
      registry.registerSystemTool(mkTool(s.name, cat, tracker, s.name.startsWith('ps')) as never)
    }
    const refs = specs.map((s) => s.name)
    const scripted = createScriptedStreamChat([multiToolRound(specs), { kind: 'text', content: 'DONE' }])
    await runIMLoop({
      config: createConfig({ maxSteps: 50 }),
      registry,
      databus: new Databus(),
      conversationMemory: new ConversationMemory(),
      workingAgentId: 'main',
      mailbox: new Mailbox(),
      systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
      stateLine: createNoopStateLine(),
      initialMetrics: createMetrics(),
      streamChat: scripted,
      url: 'https://x',
      model: 'gpt-4',
      systemPrompt: 'SYS',
      userTemplate: 'TEMPLATE',
      systemToolRefs: refs,
      mcpRefs: [],
      skillRefs: [],
    })

    const order = tracker.order
    const lastOf = (c: Cat) => order.lastIndexOf(c)
    const firstOf = (c: Cat) => order.indexOf(c)
    // 事实：parallelSafe 先整批跑完 → 然后 read 批次 → write → command。
    // 即任意两个不同桶之间不交错（顺序执行，非并行）。
    expect(firstOf('read')).toBeGreaterThan(lastOf('parallelSafe'))
    expect(firstOf('write')).toBeGreaterThan(lastOf('read'))
    expect(firstOf('command')).toBeGreaterThan(lastOf('write'))
  })

  it('工具结果与 tool_call_id 严格配对：数量/集合/顺序无错配（竞争典型缺陷对照）', async () => {
    const tracker = makeTracker()
    const specs = buildSpecs()
    const registry = new ToolRegistry()
    for (const s of specs) {
      const cat: Cat = s.name.startsWith('ps') ? 'parallelSafe' : s.name.startsWith('r') ? 'read' : s.name.startsWith('w') ? 'write' : 'command'
      registry.registerSystemTool(mkTool(s.name, cat, tracker, s.name.startsWith('ps')) as never)
    }
    const refs = specs.map((s) => s.name)
    const scripted = createScriptedStreamChat([multiToolRound(specs), { kind: 'text', content: 'DONE' }])
    await runIMLoop({
      config: createConfig({ maxSteps: 50 }),
      registry,
      databus: new Databus(),
      conversationMemory: new ConversationMemory(),
      workingAgentId: 'main',
      mailbox: new Mailbox(),
      systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
      stateLine: createNoopStateLine(),
      initialMetrics: createMetrics(),
      streamChat: scripted,
      url: 'https://x',
      model: 'gpt-4',
      systemPrompt: 'SYS',
      userTemplate: 'TEMPLATE',
      systemToolRefs: refs,
      mcpRefs: [],
      skillRefs: [],
    })

    // 第二轮请求里包含第一轮的工具结果（role:'tool'）。
    const req = scripted.captured[1]!.request
    const toolMsgs = req.messages.filter((m) => m.role === 'tool') as Array<{ role: 'tool'; tool_call_id: string; content: string }>
    // 数量完整：19 个工具调用 → 19 个工具结果，无丢失无重复
    expect(toolMsgs).toHaveLength(specs.length)
    // 顺序与配对：第 i 个工具结果的 tool_call_id 与 content 必须与 call_0_i / OUT:t_... 对应
    const expectedTags = specs.map((s) => s.tag)
    const actualTags = toolMsgs.map((m) => m.content.replace('OUT:', ''))
    expect(actualTags).toEqual(expectedTags) // 集合+顺序一致
    toolMsgs.forEach((m, i) => {
      expect(m.tool_call_id).toBe(`call_0_${i}`) // 每个结果正确配回发起它的 tool_call
    })
    // 找出携带 tool_calls 的 assistant 消息，交叉验证 tool_calls 参数 tag 与结果一致
    const assistantWithCalls = req.messages.find((m) => m.role === 'assistant' && (m as { tool_calls?: unknown[] }).tool_calls) as
      | { tool_calls: Array<{ id: string; function: { arguments: string } }> }
      | undefined
    expect(assistantWithCalls).toBeDefined()
    assistantWithCalls!.tool_calls.forEach((tc, i) => {
      const argTag = JSON.parse(tc.function.arguments).tag
      expect(tc.id).toBe(`call_0_${i}`)
      expect(argTag).toBe(expectedTags[i])
    })
  })
})
