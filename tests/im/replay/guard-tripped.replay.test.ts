// 确定性重放测试 (A)：guard 在真实多轮演进中触发。
//
// 动机：单元测试常手工喂一个 metrics 快照给 runGuards，从不让 loop 真跑多轮。
// 这里用 scripted harness 连续返回工具调用，驱动真实 runIMLoop，断言：
//   1) loop 在预期轮次因 iter guard 终止（reason === 'guard-tripped'）；
//   2) captured.length 等于实际发生的 LLM 轮次数（harness 捕获完整、无假绿）；
//   3) 终止前最后一轮请求里包含前面轮次的工具结果（上下文真的累积了）。
//
// 阈值来源（已核实，未猜）：
//   src/shell/config.ts:36  maxSteps: 500（iter guard 默认，v0.29 起；本测试显式
//                           传 maxSteps=MAX_STEPS，不依赖默认值）
//   src/shell/guards.ts:21  iter guard: trip if metrics.stepCount > maxSteps
//   src/shell/call.ts:123   addStep 每轮 shellCall 无条件 +1（stepCount === 轮次）
// 故设 maxSteps=29 → 第 30 轮 stepCount=30 > 29 → 该轮 guard 检查触发。

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
import { createScriptedStreamChat, type ScriptStep } from '../../harness/index.js'

const noopSystemAgent: SystemAgent = {
  run: async () => { throw new Error('noop') },
  stop() {},
  send() {},
}

const TOOL_CALLS = 30
const MAX_STEPS = 29 // 第 30 轮触发 iter guard

const buildScript = (n: number): ScriptStep[] =>
  Array.from({ length: n }, (_, i) => ({ kind: 'tool', name: 'bash', args: { round: i } }) as const)

describe('replay: guard 在真实轮次演进中触发', () => {
  it('连续 30 步工具调用驱动 runIMLoop，在预期轮次因 iter guard 终止，上下文已累积', async () => {
    const registry = new ToolRegistry()
    registry.registerSystemTool({
      name: 'bash',
      description: 'bash',
      parameters: { type: 'object', properties: { round: { type: 'number' } }, required: ['round'] } as const,
      execute: async (args) => `TOOL_OUT round=${(args as { round: number }).round}`,
    })

    const scripted = createScriptedStreamChat(buildScript(TOOL_CALLS))

    const result = await runIMLoop({
      config: createConfig({ maxSteps: MAX_STEPS }),
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
      systemToolRefs: ['bash'],
      mcpRefs: [],
      skillRefs: [],
    })

    // (1) 在预期轮次因 iter guard 终止
    expect(result.reason).toBe('guard-tripped')
    expect(result.hits.some((h) => h.id === 'iter')).toBe(true)
    // 触发于第 30 轮（stepCount 从 0 起，每轮+1，第 30 轮 = 30 > 29）
    expect(result.turns).toBe(TOOL_CALLS)

    // (2) captured 覆盖全部 LLM 轮次：第 30 步被第 30 轮消费，该轮 guard 检查触发。
    //     若 loop 跑了第 31 轮（脚本耗尽），harness 会抛错而非静默假绿。
    expect(scripted.captured.length).toBe(TOOL_CALLS)

    // (3) 终止前最后一轮请求确实累积了前面轮次的工具结果。
    //     第 30 轮请求发生在第 30 轮工具执行之前，应已含第 1..29 轮的工具结果。
    const lastReq = scripted.captured[scripted.captured.length - 1]!.request
    const toolMsgs = lastReq.messages.filter((m) => m.role === 'tool')
    // 29 个前置工具结果应在上下文里（断言 >=10 留足余量，但仍验证"数量级真实累积"）
    expect(toolMsgs.length).toBeGreaterThanOrEqual(10)
    const flat = toolMsgs.map((m) => (m as { content: string }).content).join('\n')
    // 最早一轮与接近末端一轮的工具结果都还在上下文
    expect(flat).toContain('TOOL_OUT round=0')
    expect(flat).toContain('TOOL_OUT round=28')
    // system 消息始终位于第 0 位（组成顺序：system → history → ...）
    expect(lastReq.messages[0]!.role).toBe('system')
  })
})
