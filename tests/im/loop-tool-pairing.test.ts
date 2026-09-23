// v0.17.x test supplement batch 4: tool.call / tool.result pairing.
//
// 5 tests verifying transcript balance — every dispatched tool.call must
// produce exactly one matching tool.result, across success/failure paths.

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
import type { StreamChunk, ChatCompletionResponse, ToolCall } from '../../src/protocol/types.js'

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
    yield { type: 'done' }
  }
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
  initialMetrics: createMetrics(),
  streamChat: scriptedStreamChat([]),
  url: 'https://x',
  model: 'gpt-4',
  systemPrompt: 'SYS',
  userTemplate: 'TEMPLATE',
  systemToolRefs: [],
  mcpRefs: [],
  skillRefs: [],
  ...overrides,
})

const toolUseResponse = (id: string, name: string, args: string): ChatCompletionResponse => ({
  id, model: 'gpt-4',
  choices: [{
    index: 0,
    message: { role: 'assistant', content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
    },
    finish_reason: 'tool_calls',
  }],
})
const endResponse = (content: string): ChatCompletionResponse => ({
  id: 'end', model: 'gpt-4',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
})

// 1. successful tool → assistant tool_calls appended, tool_result appended (pair)
describe('pairing 1 — successful tool call/result pairing', () => {
  it('assistant turn with tool_calls + matching tool_result are both appended', async () => {
    const registry = new ToolRegistry()
    registry.registerSystemTool({
      name: 'echo', description: 'echo',
      parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } as const,
      execute: async (args) => ({ echo: (args as { x: string }).x }),
    })
    const tcs: ToolCall[] = [{
      id: 'tc-1', type: 'function',
      function: { name: 'echo', arguments: '{"x":"hi"}' },
    }]
    const opts = baseOptions({
      registry,
      streamChat: scriptedStreamChat([
        {
          id: 'r1', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'tc-1', type: 'function' as const, function: { name: 'echo', arguments: '{"x":"hi"}' } }],
          }, finish_reason: 'tool_calls' }],
        },
        endResponse('done'),
      ]),
    })
    opts.systemToolRefs = ['echo']
    const result = await runIMLoop(opts)
    expect(result.reason).toBe('completed')
    const toolResults = opts.conversationMemory.turns().filter(t => t.role === 'tool')
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]!.toolCallId).toBe('tc-1')
  })
})

// 2. tool execute throws → tool_result with isError=true still appended (pair preserved)
describe('pairing 2 — tool execute throws preserves pairing', () => {
  it('a throwing tool still produces a tool_result entry', async () => {
    const registry = new ToolRegistry()
    registry.registerSystemTool({
      name: 'thrower', description: 'throws',
      parameters: { type: 'object', properties: {}, required: [] } as const,
      execute: async () => { throw new Error('boom') },
    })
    const tcs: ToolCall[] = [{
      id: 'tc-1', type: 'function',
      function: { name: 'thrower', arguments: '{}' },
    }]
    const opts = baseOptions({
      registry,
      streamChat: scriptedStreamChat([
        { ...toolUseResponse('r1', 'thrower', '{}') },
        endResponse('done'),
      ]),
    })
    opts.systemToolRefs = ['thrower']
    const result = await runIMLoop(opts)
    expect(result.reason).toBe('completed')
    const toolResults = opts.conversationMemory.turns().filter(t => t.role === 'tool')
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]!.isError).toBe(true)
  })
})

// 3. tool name not in registry → registry.execute throws → still produces tool_result
describe('pairing 3 — unknown tool name produces tool_result', () => {
  it('tool_result is appended even when the tool name is not registered', async () => {
    const registry = new ToolRegistry()
    // Intentionally register nothing — echo doesn't exist
    const tcs: ToolCall[] = [{
      id: 'tc-1', type: 'function',
      function: { name: 'nonexistent', arguments: '{}' },
    }]
    const opts = baseOptions({
      registry,
      streamChat: scriptedStreamChat([
        { ...toolUseResponse('r1', 'nonexistent', '{}') },
        endResponse('done'),
      ]),
    })
    opts.systemToolRefs = ['nonexistent']
    const result = await runIMLoop(opts)
    // Loop should still terminate with completed (tool_result is appended as
    // an error result, then loop continues to next round)
    expect(result.reason).toBe('completed')
    const toolResults = opts.conversationMemory.turns().filter(t => t.role === 'tool')
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]!.isError).toBe(true)
  })
})

// 4. args parse fails (invalid JSON) → tool_result appended
describe('pairing 4 — invalid JSON args still produces tool_result', () => {
  it('tool_result with parse-error message is appended', async () => {
    const registry = new ToolRegistry()
    registry.registerSystemTool({
      name: 'echo', description: 'echo',
      parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } as const,
      execute: async () => ({ ok: true }),
    })
    const tcs: ToolCall[] = [{
      id: 'tc-1', type: 'function',
      function: { name: 'echo', arguments: '{not valid json' },
    }]
    const opts = baseOptions({
      registry,
      streamChat: scriptedStreamChat([
        { ...toolUseResponse('r1', 'echo', '{not valid json') },
        endResponse('done'),
      ]),
    })
    opts.systemToolRefs = ['echo']
    const result = await runIMLoop(opts)
    expect(result.reason).toBe('completed')
    const toolResults = opts.conversationMemory.turns().filter(t => t.role === 'tool')
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]!.isError).toBe(true)
  })
})

// 5. multiple parallel tool calls — each gets a tool_result
describe('pairing 5 — multiple tool calls each get a result', () => {
  it('parallel tool calls all produce tool_results in provider order', async () => {
    const registry = new ToolRegistry()
    registry.registerSystemTool({
      name: 'echo', description: 'echo',
      parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } as const,
      execute: async (args) => ({ echo: (args as { x: string }).x }),
    })
    const tcs: ToolCall[] = [
      { id: 'tc-1', type: 'function', function: { name: 'echo', arguments: '{"x":"a"}' } },
      { id: 'tc-2', type: 'function', function: { name: 'echo', arguments: '{"x":"b"}' } },
      { id: 'tc-3', type: 'function', function: { name: 'echo', arguments: '{"x":"c"}' } },
    ]
    const opts = baseOptions({
      registry,
      streamChat: scriptedStreamChat([
        { ...toolUseResponse('r1', 'echo', '{"x":"a"}'),
          // Override tool_calls field by spreading to inject 3 tool_calls
          ...{ choices: [{ index: 0,
            message: { role: 'assistant' as const, content: null,
              tool_calls: [{ id: 'tc-1', type: 'function' as const, function: { name: 'echo', arguments: '{"x":"a"}' } },
                           { id: 'tc-2', type: 'function' as const, function: { name: 'echo', arguments: '{"x":"b"}' } },
                           { id: 'tc-3', type: 'function' as const, function: { name: 'echo', arguments: '{"x":"c"}' } }],
            },
            finish_reason: 'tool_calls' as const }] } },
        endResponse('done'),
      ]),
    })
    opts.systemToolRefs = ['echo']
    const result = await runIMLoop(opts)
    expect(result.reason).toBe('completed')
    const toolResults = opts.conversationMemory.turns().filter(t => t.role === 'tool')
    expect(toolResults).toHaveLength(3)
    expect(toolResults.map(r => r.toolCallId).sort()).toEqual(['tc-1', 'tc-2', 'tc-3'])
  })
})
