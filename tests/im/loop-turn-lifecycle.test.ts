// v0.17.x test supplement batch 5: turn lifecycle boundaries.
//
// 4 tests covering cross-step usage accumulation, max_tokens, assistant
// turn ordering, and lastRequestTokens propagation.

import { describe, it, expect } from 'vitest'
import { runIMLoop, type IMLoopOptions } from '../../src/im/loop.js'
import { ToolRegistry } from '../../src/shell/registry.js'
import { createConfig } from '../../src/shell/config.js'
import { createMetrics } from '../../src/shell/metrics.js'
import { Databus } from '../../src/im/databus.js'
import { ConversationMemory } from '../../src/im/conversation-memory.js'
import { Mailbox } from '../../src/im/mailbox/index.js'
import { createNoopStateLine } from '../../src/im/state-line/index.js'
import type { SystemAgent } from '../../src/im/system-agent.js'
import type { StreamChunk, ChatCompletionResponse } from '../../src/protocol/types.js'

const noopSystemAgent: SystemAgent = {
  run: async () => { throw new Error('noop') },
  stop() {},
  send() {},
}

const scriptedStreamChat = (responses: ChatCompletionResponse[]): IMLoopOptions['streamChat'] => {
  let i = 0
  return async function* (_url, _request): AsyncIterable<StreamChunk> {
    const r = responses[i++]
    if (!r) return
    const msg = r.choices[0]?.message
    if (typeof msg?.content === 'string' && msg.content.length > 0) {
      yield { type: 'content_delta', text: msg.content }
    }
    if (msg?.tool_calls) {
      for (let k = 0; k < msg.tool_calls.length; k += 1) {
        const tc = msg.tool_calls[k]!
        yield { type: 'tool_call_delta', index: k, id: tc.id, name: tc.function.name }
        yield { type: 'tool_call_delta', index: k, arguments_delta: tc.function.arguments }
      }
    }
    yield { type: 'finish', reason: r.choices[0]?.finish_reason ?? 'stop' }
    if (r.usage) yield { type: 'usage', usage: r.usage }
    yield { type: 'done' }
  }
}

const baseOptions = (overrides: Partial<IMLoopOptions> = {}): IMLoopOptions => {
  const registry = new ToolRegistry()
  registry.registerSystemTool({
    name: 'echo', description: 'echo',
    parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } as const,
    execute: async (args) => ({ echo: (args as { x: string }).x }),
  })
  return {
    config: createConfig(),
    registry,
    databus: new Databus(),
    conversationMemory: new ConversationMemory(),
    workingAgentId: 'main',
    mailbox: new Mailbox(),
    systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
    stateLine: createNoopStateLine(),
    initialMetrics: createMetrics(),
    streamChat: scriptedStreamChat([]),
    url: 'https://x',
    model: 'gpt-4',
    systemPrompt: 'SYS',
    userTemplate: 'TEMPLATE',
    systemToolRefs: ['echo'],
    mcpRefs: [],
    skillRefs: [],
    ...overrides,
  }
}

// 1. multi-step turn — tool_use then end_turn — completes normally
describe('lifecycle 1 — multi-step turn with tool_use then end_turn', () => {
  it('tool_use → end_turn produces a completed turn', async () => {
    const opts = baseOptions({
      streamChat: scriptedStreamChat([
        {
          id: 'r1', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'tc-1', type: 'function' as const,
              function: { name: 'echo', arguments: '{"x":"first"}' } }],
          }, finish_reason: 'tool_calls' }],
        },
        { id: 'r2', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: 'final' },
                     finish_reason: 'stop' }] },
      ]),
    })
    const result = await runIMLoop(opts)
    expect(result.reason).toBe('completed')
    // tool_result + final assistant content all present
    const turns = opts.conversationMemory.turns()
    expect(turns.filter(t => t.role === 'tool')).toHaveLength(1)
    expect(turns.filter(t => t.role === 'assistant')).toHaveLength(2)
  })
})

// 2. assistant turn is appended BEFORE tool execution
describe('lifecycle 2 — assistant turn ordering', () => {
  it('assistant turn with tool_calls is appended before any tool result', async () => {
    const opts = baseOptions({
      streamChat: scriptedStreamChat([
        {
          id: 'r1', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'tc-1', type: 'function' as const,
              function: { name: 'echo', arguments: '{"x":"hi"}' } }],
          }, finish_reason: 'tool_calls' }],
        },
        { id: 'r2', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' },
                     finish_reason: 'stop' }] },
      ]),
    })
    await runIMLoop(opts)
    const turns = opts.conversationMemory.turns()
    // Find positions of assistant-with-tool_calls and first tool result
    const assistantIdx = turns.findIndex(t => t.role === 'assistant' && (t as { toolCalls?: unknown[] }).toolCalls)
    const toolIdx = turns.findIndex(t => t.role === 'tool')
    expect(assistantIdx).toBeGreaterThanOrEqual(0)
    expect(toolIdx).toBeGreaterThan(assistantIdx)
  })
})

// 3. lastRequestTokens is set after each LLM call (for next-round context size)
describe('lifecycle 3 — lastRequestTokens propagation', () => {
  it('metrics.lastRequestTokens is non-zero after a tool_use round', async () => {
    const opts = baseOptions({
      streamChat: scriptedStreamChat([
        {
          id: 'r1', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'tc-1', type: 'function' as const,
              function: { name: 'echo', arguments: '{}' } }],
          }, finish_reason: 'tool_calls' }],
        },
        { id: 'r2', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' },
                     finish_reason: 'stop' }] },
      ]),
    })
    const result = await runIMLoop(opts)
    expect(result.metrics.lastRequestTokens).toBeGreaterThan(0)
  })
})

// 4. step count accumulates across multiple tool_use rounds
describe('lifecycle 4 — metrics.stepCount accumulates across rounds', () => {
  it('stepCount grows with each LLM call', async () => {
    const opts = baseOptions({
      streamChat: scriptedStreamChat([
        {
          id: 'r1', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'tc-1', type: 'function' as const,
              function: { name: 'echo', arguments: '{}' } }],
          }, finish_reason: 'tool_calls' }],
        },
        {
          id: 'r2', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'tc-2', type: 'function' as const,
              function: { name: 'echo', arguments: '{}' } }],
          }, finish_reason: 'tool_calls' }],
        },
        { id: 'r3', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' },
                     finish_reason: 'stop' }] },
      ]),
    })
    const result = await runIMLoop(opts)
    expect(result.metrics.stepCount).toBeGreaterThanOrEqual(2)
    expect(result.reason).toBe('completed')
  })
})

// 5. 流式 turnId 跨 runIMLoop 唯一（2026-09-08 真实事故回归：turnId 曾是
// `turn-${turns}` 每轮重置的短编号，webapp/CLI 以它为流式条目 key，跨轮撞车
// 把新轮正文合并进旧轮条目——前端 items.length 不变不滚动，用户看到"没有回应"）。
describe('lifecycle 5 — stream turnId is unique across runIMLoop invocations', () => {
  it('two separate runs never share a turnId', async () => {
    const collect = async (): Promise<string[]> => {
      const seen: string[] = []
      const opts = baseOptions({
        streamChat: scriptedStreamChat([
          { id: 'r1', model: 'gpt-4',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hello' },
                       finish_reason: 'stop' }] },
        ]),
        onStreamChunk: (turnId) => { seen.push(turnId) },
      })
      const result = await runIMLoop(opts)
      expect(result.reason).toBe('completed')
      expect(seen.length).toBeGreaterThan(0)
      return seen
    }
    const run1 = await collect()
    const run2 = await collect()
    for (const id of run1) expect(run2).not.toContain(id)
    // 同一轮内 turnId 一致（delta 与 hook/tool 信号归属同轮）——去重后恰为一组
    expect(new Set(run1).size).toBe(1)
  })
})
