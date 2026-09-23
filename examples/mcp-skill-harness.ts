// v0.13 Batch 3: MCP + Skill extension harness.
//
// End-to-end verification (no network) of the v0.13 extension system:
//   Stage 0: bootstrapExtensions — stdio echo-srv subprocess + a .js skill
//            module written into a temp dir. Prints the assembly manifest.
//   Stage 1: working agent calls echo-srv__echo directly (registry.execute).
//   Stage 2: working agent calls the greet skill directly (registry.execute).
//   Stage 3: run_subagent spawns a sub-agent whose toolRefs include both
//            echo-srv__echo and greet (default policy allows both); a scripted
//            LLM drives the sub-agent to call both tools.
//
// Three verification points each print ✅/❌, matching the output style of
// examples/sub-agent-harness.ts. Closes every connection at the end.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { ToolRegistry } from '../src/shell/registry.js'
import { Mailbox } from '../src/im/mailbox/index.js'
import { createNoopStateLine } from '../src/im/state-line/index.js'
import { SubAgentRegistry } from '../src/im/sub-agent/index.js'
import { createRunSubagentTool } from '../src/im/tools/run-subagent.js'
import { bootstrapExtensions } from '../src/extensions.js'
import type { SystemAgent } from '../src/im/system-agent.js'
import type { StreamChunk, ChatCompletionResponse, ToolCall } from '../src/protocol/types.js'

const here = dirname(fileURLToPath(import.meta.url))
const echoFixture = join(here, '..', 'tests', 'fixtures', 'echo-mcp-server.mjs')

const noopSystemAgent: SystemAgent = {
  run: async () => { throw new Error('system agents not configured in this harness') },
  stop() {},
  send() {},
}

// --- Scripted LLM (shared pattern from sub-agent-harness.ts) ---
let activeSequence: ChatCompletionResponse[] = []
let activeIndex = 0

const setSequence = (responses: ChatCompletionResponse[]): void => {
  activeSequence = responses
  activeIndex = 0
}

const streamChat = async function* (_url: string, _request: unknown): AsyncIterable<StreamChunk> {
  const r = activeSequence[activeIndex++]
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

// --- Stage 0: bootstrapExtensions ---
const registry = new ToolRegistry()
const skillsDir = mkdtempSync(join(tmpdir(), 'mcp-skill-harness-'))

// Write a greet skill: returns `Hello from skill: ${args.text}`.
writeFileSync(
  join(skillsDir, 'greet.js'),
  `export default {
  name: 'greet',
  description: 'Greet with a text argument',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  execute: async (args) => 'Hello from skill: ' + args.text,
};
`,
)

console.log('=== Stage 0: bootstrapExtensions ===')
const ext = await bootstrapExtensions({
  registry,
  mcpServers: [
    { name: 'echo-srv', transport: 'stdio', command: process.execPath, args: [echoFixture], timeoutMs: 15000 },
  ],
  skillsDir,
})
console.log('  servers:', ext.servers)
console.log('  tools:  ', ext.tools)
console.log('  skills: ', ext.skills)

// --- Stage 1: working agent calls echo-srv__echo directly ---
console.log('\n=== Stage 1: working agent calls echo-srv__echo ===')
const mcpResult = await registry.execute('echo-srv__echo', { text: 'stage-1-mcp' })
console.log('  echo-srv__echo result:', mcpResult)
if (mcpResult === 'stage-1-mcp') {
  console.log('✅ MCP tool echo verified')
} else {
  console.log('❌ MCP tool echo FAILED: expected "stage-1-mcp", got', mcpResult)
}

// --- Stage 2: working agent calls greet skill directly ---
console.log('\n=== Stage 2: working agent calls greet skill ===')
const skillResult = await registry.execute('greet', { text: 'stage-2' })
console.log('  greet result:', skillResult)
if (skillResult === 'Hello from skill: stage-2') {
  console.log('✅ Skill tool greet verified')
} else {
  console.log('❌ Skill tool greet FAILED: expected "Hello from skill: stage-2", got', skillResult)
}

// --- Stage 3: run_subagent sub-agent calls both tools via scripted LLM ---
console.log('\n=== Stage 3: run_subagent sub-agent (echo-srv__echo + greet) ===')
const subAgentRegistry = new SubAgentRegistry({ registry })
await subAgentRegistry.register({
  name: 'hybrid-bot',
  systemPrompt: 'You call echo-srv__echo then greet.',
  toolRefs: ['echo-srv__echo', 'greet'],
})

// Scripted responses in call order:
//   1. sub-agent round 1: calls echo-srv__echo(text="sub-mcp")
//   2. sub-agent round 2: calls greet(text="sub-skill")
//   3. sub-agent round 3: final text "both done"
setSequence([
  {
    id: 's1', model: 'gpt-4',
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: null,
        tool_calls: [{
          id: 'tc-1', type: 'function',
          function: { name: 'echo-srv__echo', arguments: '{"text":"sub-mcp","reason":"call echo"}' },
        } as ToolCall],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  },
  {
    id: 's2', model: 'gpt-4',
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: null,
        tool_calls: [{
          id: 'tc-2', type: 'function',
          function: { name: 'greet', arguments: '{"text":"sub-skill","reason":"call greet"}' },
        } as ToolCall],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
  },
  {
    id: 's3', model: 'gpt-4',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'both done' },
      finish_reason: 'stop',
    }],
    usage: { promptTokens: 30, completionTokens: 5, totalTokens: 35 },
  },
])

const runSubagentTool = createRunSubagentTool(subAgentRegistry, {
  llmStreamChat: streamChat as unknown as Parameters<typeof createRunSubagentTool>[1]['llmStreamChat'],
  url: 'https://x',
  model: 'gpt-4',
  mailbox: new Mailbox(subAgentRegistry.agentTree),
  registry,
  stateLine: createNoopStateLine(),
})

const subResult = await runSubagentTool.execute(
  { name: 'hybrid-bot', input: 'call both tools', reason: 'stage 3' },
  { agentId: 'main', databus: subAgentRegistry.agentTree.root.ownDatabus },
) as { output: string; status: string }

console.log('  run_subagent result:', subResult)

// Verify the sub-agent's tool turns projected into root.familyDatabus carry
// both the MCP echo result and the skill result.
const familyBus = subAgentRegistry.agentTree.root.familyDatabus
const botEvents = familyBus.turns().filter((e) => e.sourceAgentId?.startsWith('hybrid-bot-'))
const echoTurn = botEvents.find((e) => e.toolCallId === 'tc-1')
const greetTurn = botEvents.find((e) => e.toolCallId === 'tc-2')

console.log('  sub-agent echo turn content:', echoTurn?.content)
console.log('  sub-agent greet turn content:', greetTurn?.content)

const bothCalled =
  subResult.status === 'completed' &&
  typeof echoTurn?.content === 'string' && echoTurn.content.includes('sub-mcp') &&
  typeof greetTurn?.content === 'string' && greetTurn.content.includes('Hello from skill: sub-skill')

if (bothCalled) {
  console.log('✅ Sub-agent called both MCP + skill tools (default policy allows both)')
} else {
  console.log('❌ Sub-agent dual-tool call FAILED')
  console.log('   status:', subResult.status)
  console.log('   echoTurn:', echoTurn?.content)
  console.log('   greetTurn:', greetTurn?.content)
}

// --- Cleanup ---
console.log('\n=== Cleanup ===')
await ext.close()
rmSync(skillsDir, { recursive: true, force: true })
console.log('=== Harness complete ===')

// Silence the unused import lint for noopSystemAgent (kept for parity with
// sub-agent-harness.ts; this harness does not configure real system agents).
void noopSystemAgent
