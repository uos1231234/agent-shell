// 思维链全量落盘（2026-09-12 用户拍板）：call.ts 聚合 reasoning_delta →
// ShellCallResult.reasoning → finalizeRound 写入 canonical assistant 回合 →
// persistTurn 原样落盘。同时锁死 wire 纪律：turnToMessage 刻意不投影
// reasoning——思维链是回包词汇，请求绝不回显，严格服务商也拒收多余字段。

import { describe, it, expect } from 'vitest'
import { runIMLoop, type IMLoopOptions } from '../../src/im/loop.js'
import { ToolRegistry } from '../../src/shell/registry.js'
import { createConfig } from '../../src/shell/config.js'
import { Databus } from '../../src/im/databus.js'
import { ConversationMemory } from '../../src/im/conversation-memory.js'
import { Mailbox } from '../../src/im/mailbox/index.js'
import { createNoopStateLine } from '../../src/im/state-line/index.js'
import { turnToMessage } from '../../src/im/turn.js'
import type { SystemAgent } from '../../src/im/system-agent.js'
import type { ConversationTurn } from '../../src/im/conversation-memory.js'
import type { StreamChunk } from '../../src/protocol/types.js'

const noopSystemAgent: SystemAgent = {
  run: async () => { throw new Error('noop') },
  stop() {},
  send() {},
}

// 与生产一致的 chunk 顺序：先思维链增量，后正文增量（ARK 实测形态）。
const reasoningStreamChat = (): IMLoopOptions['streamChat'] =>
  async function* (_url, _request): AsyncIterable<StreamChunk> {
    yield { type: 'reasoning_delta', text: '分析请求：' }
    yield { type: 'reasoning_delta', text: '直接回答即可。' }
    yield { type: 'content_delta', text: '答案是 42。' }
    yield { type: 'finish', reason: 'stop' }
    yield { type: 'usage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
    yield { type: 'done' }
  }

const baseOptions = (overrides: Partial<IMLoopOptions> = {}): IMLoopOptions => ({
  config: createConfig(),
  registry: new ToolRegistry(),
  databus: new Databus(),
  conversationMemory: new ConversationMemory(),
  workingAgentId: 'main',
  mailbox: new Mailbox(),
  systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
  stateLine: createNoopStateLine(),
  streamChat: reasoningStreamChat(),
  url: 'https://x',
  model: 'gpt-4',
  systemPrompt: 'SYS',
  userTemplate: 'hi',
  systemToolRefs: [],
  mcpRefs: [],
  skillRefs: [],
  // persistReasoning 缺省 false（= 子代理/系统智能体形态）；需要落盘语义的
  // 测试显式传 true（与宿主装配 assembly.ts 工作代理同款）。
  ...overrides,
})

describe('思维链全量落盘（2026-09-12）', () => {
  it('reasoning_delta 聚合进 assistant 回合并经 persistTurn 落盘，正文不受影响', async () => {
    const persisted: ConversationTurn[] = []
    const opts = baseOptions({ persistReasoning: true, persistTurn: async (t) => { persisted.push(t) } })

    await runIMLoop(opts)

    const assistant = persisted.find((t): t is Extract<ConversationTurn, { role: 'assistant' }> => t.role === 'assistant')
    expect(assistant).toBeDefined()
    expect(assistant!.reasoning).toBe('分析请求：直接回答即可。')
    expect(assistant!.content).toBe('答案是 42。')

    // canonical memory 与落盘同一对象语义（appendCanonicalTurn 直存）。
    const memoryAssistant = opts.conversationMemory.turns()
      .find((t): t is Extract<ConversationTurn, { role: 'assistant' }> => t.role === 'assistant')
    expect(memoryAssistant!.reasoning).toBe('分析请求：直接回答即可。')
  })

  it('无思维链的回合不产生 reasoning 字段（undefined，非空串）', async () => {
    const persisted: ConversationTurn[] = []
    const plainStreamChat = async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'content_delta', text: 'no thinking' }
      yield { type: 'finish', reason: 'stop' }
      yield { type: 'done' }
    }
    const opts = baseOptions({ streamChat: plainStreamChat, persistTurn: async (t) => { persisted.push(t) } })

    await runIMLoop(opts)

    const assistant = persisted.find((t): t is Extract<ConversationTurn, { role: 'assistant' }> => t.role === 'assistant')
    expect(assistant!.reasoning).toBeUndefined()
  })

  it('wire 纪律：turnToMessage 不投影 reasoning（请求体不含思维链）', async () => {
    const turn: ConversationTurn = {
      id: 'assistant-1', role: 'assistant', content: '答案', reasoning: 'SECRET_CHAIN_OF_THOUGHT', at: 1,
    }
    const wire = turnToMessage(turn)
    expect(wire.role).toBe('assistant')
    expect(wire.content).toBe('答案')
    expect(JSON.stringify(wire)).not.toContain('SECRET_CHAIN_OF_THOUGHT')
    expect(JSON.stringify(wire)).not.toContain('reasoning')
  })

  it('赋值面 = 落盘面：未开启 persistReasoning 的 loop（子代理/系统智能体形态）不赋值', async () => {
    const opts = baseOptions()
    await runIMLoop(opts)
    const assistant = opts.conversationMemory.turns()
      .find((t): t is Extract<ConversationTurn, { role: 'assistant' }> => t.role === 'assistant')
    // reasoning delta 确实流过（live thinking.delta 信号路径不受影响），
    // 但 canonical 回合不携带——不落盘的会话不赋值。
    expect(assistant!.reasoning).toBeUndefined()
    expect(assistant!.content).toBe('答案是 42。')
  })
})
