// End-to-end demo: a real tool flow.
// The LLM first calls `read_file` (returns "hello world"), then a second turn answers
// the user. This shows the IM loop iterating through tool calls and the databus growing.

import { runIMLoop } from '../src/im/loop.js'
import { Databus } from '../src/im/databus.js'
import { ConversationMemory } from '../src/im/conversation-memory.js'
import { Mailbox } from '../src/im/mailbox/index.js'
import { ToolRegistry } from '../src/shell/registry.js'
import { createConfig } from '../src/shell/config.js'
import { createMetrics } from '../src/shell/metrics.js'
import { createNoopStateLine } from '../src/im/state-line/index.js'
import type { SystemAgent } from '../src/im/system-agent.js'
import type { StreamChunk, ChatCompletionResponse } from '../src/protocol/types.js'

const noopSystemAgent: SystemAgent = {
  run: async () => { throw new Error('system agents not configured in this example') },
  stop() {},
  send() {},
}

const echoParams = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } as const

// Scripted stream chat: first call returns a tool_call, second returns text.
const callTool = (name: string, args: string): ChatCompletionResponse => ({
  id: 'r', model: 'gpt-4',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'tc-1', type: 'function', function: { name, arguments: args } }],
    },
    finish_reason: 'tool_calls',
  }],
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
})
const finishWithText = (text: string): ChatCompletionResponse => ({
  id: 'r', model: 'gpt-4',
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
})

const responses: ChatCompletionResponse[] = [
  callTool('echo', '{"x":"hello","reason":"read foo.txt"}'),
  finishWithText('The file contains: hello'),
]
let i = 0
const streamChat = async function* (): AsyncIterable<StreamChunk> {
  const r = responses[i++]
  if (!r) return
  const msg = r.choices[0]?.message
  if (typeof msg?.content === 'string' && msg.content.length > 0) {
    yield { type: 'content_delta', text: msg.content }
  }
  if (msg?.tool_calls) {
    for (const tc of msg.tool_calls) {
      yield { type: 'tool_call_delta', index: 0, id: tc.id, name: tc.function.name }
      yield { type: 'tool_call_delta', index: 0, arguments_delta: tc.function.arguments }
    }
  }
  yield { type: 'finish', reason: r.choices[0]?.finish_reason ?? 'stop' }
  if (r.usage) yield { type: 'usage', usage: r.usage }
  yield { type: 'done' }
}

const registry = new ToolRegistry()
registry.registerSystemTool({
  name: 'echo',
  description: 'echo back the argument',
  parameters: echoParams,
  execute: async (args) => ({ echo: (args as { x: string }).x }),
})

const databus = new Databus()

const conversationMemory = new ConversationMemory()
conversationMemory.append({ id: 'user-1', role: 'user', content: 'Read foo.txt', at: Date.now() })

const result = await runIMLoop({
  config: createConfig(),
  registry,
  databus,
  conversationMemory,
  workingAgentId: 'main',
  mailbox: new Mailbox(),
  systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
  stateLine: createNoopStateLine(),
  initialMetrics: createMetrics(),
  streamChat,
  url: 'https://x',
  model: 'gpt-4',
  systemPrompt: 'You are a helpful assistant with access to tools.',
  userTemplate: 'TEMPLATE',
  systemToolRefs: ['echo'],
  mcpRefs: [],
  skillRefs: [],
})

console.log('result:', result)
console.log('databus (tool) turns:')
for (const t of databus.turns()) {
  console.log(' -', t.role, JSON.stringify(t.content))
}
console.log('conversationMemory (user/assistant) turns:')
for (const t of conversationMemory.turns()) {
  const summary =
    t.role === 'assistant' ? (t.content ?? JSON.stringify(t.toolCalls))
    : t.content
  console.log(' -', t.role, JSON.stringify(summary))
}
