// C1 接线验收（2026-09-17）：'recall' 并发桶必须是**生产注册表里真实生效的路由**，
// 不只是 registry.ts 的一个常量。断言三件事：
//   1. CONCURRENCY_LIMITS.recall === 1（深度召回一轮最多一个并发）
//   2. registerSystemAgentTools 装配后的 registry 把 state_query 归到 'recall' 桶
//   3. databus_query（压缩后工具戳召回主通路）仍在 'read' 桶——限流它会削弱方案 A
// 另加 loop 级并发峰值断言：recall 桶 3 个调用的实测峰值恰为 1（串行）。

import { describe, it, expect } from 'vitest'
import { runIMLoop } from '../../../src/im/loop.js'
import { ToolRegistry, CONCURRENCY_LIMITS } from '../../../src/shell/registry.js'
import { createConfig } from '../../../src/shell/config.js'
import { createMetrics } from '../../../src/shell/metrics.js'
import { Databus } from '../../../src/im/databus.js'
import { ConversationMemory } from '../../../src/im/conversation-memory.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import { createNoopStateLine } from '../../../src/im/state-line/index.js'
import { registerSystemAgentTools } from '../../../src/im/system-agents/register.js'
import type { SystemAgent } from '../../../src/im/system-agent.js'
import { createScriptedStreamChat, type ScriptStep } from '../../harness/index.js'

const noopAgent: SystemAgent = { run: async () => { throw new Error('noop') }, stop() {}, send() {} }

describe('recall 并发桶（state_query 深度召回串行化）', () => {
  it('CONCURRENCY_LIMITS 落地 recall = 1', () => {
    expect(CONCURRENCY_LIMITS.recall).toBe(1)
  })

  it('生产装配注册表：state_query → recall 桶，databus_query → read 桶', () => {
    const registry = new ToolRegistry()
    registerSystemAgentTools(
      registry,
      new Mailbox(),
      { warehouse: noopAgent, compressor: noopAgent, recall: noopAgent },
    )
    expect(registry.getToolCategory('state_query')).toBe('recall')
    expect(registry.getToolCategory('databus_query')).toBe('read')
    // 未声明 category 的系统工具仍回落到最保守的 command 桶（回归保护）。
    expect(registry.getToolCategory('mailbox_read')).toBe('command')
  })

  it('loop 实测：同轮 3 个 recall 工具调用的并发峰值恰为 1（逐条串行）', async () => {
    let current = 0
    let peak = 0
    const registry = new ToolRegistry()
    registry.registerSystemTool({
      name: 'recall_like',
      description: 'd',
      category: 'recall',
      parameters: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] },
      execute: async (args) => {
        current += 1
        peak = Math.max(peak, current)
        await Promise.resolve()
        await Promise.resolve()
        current -= 1
        return `OUT:${(args as { tag: string }).tag}`
      },
    })

    const specs = [{ tag: 'a' }, { tag: 'b' }, { tag: 'c' }]
    const round: ScriptStep = {
      kind: 'raw',
      chunks: [
        ...specs.flatMap((s, i) => [
          { type: 'tool_call_delta' as const, index: i, id: `call_0_${i}`, name: 'recall_like' },
          { type: 'tool_call_delta' as const, index: i, arguments_delta: JSON.stringify({ tag: s.tag }) },
        ]),
        { type: 'finish' as const, reason: 'tool_calls' },
        { type: 'usage' as const, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
        { type: 'done' as const },
      ],
    }
    const scripted = createScriptedStreamChat([round, { kind: 'text', content: 'DONE' }])

    await runIMLoop({
      config: createConfig({ maxSteps: 50 }),
      registry,
      databus: new Databus(),
      conversationMemory: new ConversationMemory(),
      workingAgentId: 'main',
      mailbox: new Mailbox(),
      systemAgents: { warehouse: noopAgent, compressor: noopAgent, recall: noopAgent },
      stateLine: createNoopStateLine(),
      initialMetrics: createMetrics(),
      streamChat: scripted,
      url: 'https://x',
      model: 'gpt-4',
      systemPrompt: 'SYS',
      userTemplate: 'TEMPLATE',
      systemToolRefs: ['recall_like'],
      mcpRefs: [],
      skillRefs: [],
    })

    expect(peak).toBe(1)
    // 配对仍然正确：串行执行不改变结果与 tool_call_id 的对应关系。
    const toolMsgs = scripted.captured[1]!.request.messages.filter((m) => m.role === 'tool') as
      Array<{ tool_call_id: string; content: string }>
    expect(toolMsgs.map((m) => m.content)).toEqual(['OUT:a', 'OUT:b', 'OUT:c'])
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['call_0_0', 'call_0_1', 'call_0_2'])
  })
})
