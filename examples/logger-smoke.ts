// v0.14 logger smoke test.
//
// Demonstrates the minimal wiring an external caller (宿主应用, custom
// frontend) needs to see structured NDJSON log records from a running
// agent-shell loop:
//   1. setLevel('info') so info+ records are emitted (default is 'warn').
//   2. Build a one-tool registry + scripted streamChat + runIMLoop.
//   3. The loop's `runIMLoop start` / `runIMLoop completed` records land
//      on stderr as NDJSON (the logger's default sink).
//
// Run:  npx tsx examples/logger-smoke.ts
// Expect: several `{"ts":...,"level":"info",...}` lines on stderr, then
// `result reason: completed` on stdout.

import { setLevel } from '../src/shared/logger.js'
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

// 1. Turn on info-level logging so the loop's start/complete records emit.
setLevel('info')

const noopSystemAgent: SystemAgent = {
  run: async () => { throw new Error('no system agents configured') },
  stop() {},
  send() {},
}

// 2. One echo tool + a scripted single-turn response (no network).
const registry = new ToolRegistry()
registry.registerSystemTool({
  name: 'echo',
  description: 'echoes its argument',
  parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } as const,
  execute: async (args) => ({ echo: (args as { x: string }).x }),
})

const fakeStream = (resp: ChatCompletionResponse) =>
  async function* (): AsyncIterable<StreamChunk> {
    const msg = resp.choices[0]?.message
    if (typeof msg?.content === 'string' && msg.content.length > 0) {
      yield { type: 'content_delta', text: msg.content }
    }
    yield { type: 'finish', reason: resp.choices[0]?.finish_reason ?? 'stop' }
    if (resp.usage) yield { type: 'usage', usage: resp.usage }
    yield { type: 'done' }
  }

const conversationMemory = new ConversationMemory()
conversationMemory.append({ id: 'user-1', role: 'user', content: 'Hello', at: Date.now() })

// 3. Run the loop — structured records flow to stderr via defaultLogger.
const result = await runIMLoop({
  config: createConfig(),
  registry,
  databus: new Databus(),
  conversationMemory,
  workingAgentId: 'main',
  mailbox: new Mailbox(),
  systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
  stateLine: createNoopStateLine(),
  initialMetrics: createMetrics(),
  streamChat: fakeStream({
    id: 'r1', model: 'gpt-4',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hi back.' }, finish_reason: 'stop' }],
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

console.log('result reason:', result.reason)
