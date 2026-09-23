// Minimal example: register one tool, run a single IM turn, get a response.
// This is the "hello world" of agent-shell. It uses a fake streamChat (no network).

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

// Fake streamChat: returns one scripted response.
const fakeStreamChat = (resp: ChatCompletionResponse) =>
  async function* (): AsyncIterable<StreamChunk> {
    const msg = resp.choices[0]?.message
    if (typeof msg?.content === 'string' && msg.content.length > 0) {
      yield { type: 'content_delta', text: msg.content }
    }
    yield { type: 'finish', reason: resp.choices[0]?.finish_reason ?? 'stop' }
    if (resp.usage) yield { type: 'usage', usage: resp.usage }
    yield { type: 'done' }
  }

// 1. Build the registry, databus, config.
const registry = new ToolRegistry()
registry.registerSystemTool({
  name: 'echo',
  description: 'echoes its argument',
  parameters: echoParams,
  execute: async (args) => ({ echo: (args as { x: string }).x }),
})

const databus = new Databus()

const conversationMemory = new ConversationMemory()
conversationMemory.append({ id: 'user-1', role: 'user', content: 'Hello, who are you?', at: Date.now() })

// 2. Configure and run the loop.
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
  streamChat: fakeStreamChat({
    id: 'r1',
    model: 'gpt-4',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'I am an agent-shell.' },
      finish_reason: 'stop',
    }],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  }),
  url: 'https://api.example.com/v1/chat/completions',
  model: 'gpt-4',
  systemPrompt: 'You are a helpful assistant.',
  userTemplate: 'TEMPLATE',
  systemToolRefs: ['echo'],
  mcpRefs: [],
  skillRefs: [],
})

console.log('result:', result)
console.log('databus turns:', databus.turns())
console.log('conversationMemory turns:', conversationMemory.turns())
