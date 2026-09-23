// v0.12 sub-agent harness: end-to-end verification of tree-structured bus sharing.
//
// Scenario:
//   1. The working agent (root, depth 0) defines two sub-agent templates:
//      "writer" (calls echo) and "reader" (calls databus_query).
//   2. The working agent runs "writer" first. run_subagent mints a unique
//      instance id (writer-<uuid>), registers a child node under root, and
//      the writer's echo tool turn projects into root.familyDatabus (which is
//      the child's ownDatabus — siblings share it).
//   3. The working agent runs "reader". The reader is also a child of root,
//      so its ownDatabus is the SAME root.familyDatabus — it calls
//      databus_query and sees the writer's echo event.
//   4. The working agent itself can read sub-agent events via its own
//      ctxDatabus = [root.ownDatabus, root.familyDatabus] (D5), auto-wired
//      by createMinimalIM when a subAgentRegistry is provided.
//
// This harness uses scripted LLM responses (no network) to make the flow
// deterministic and repeatable.

import { createMinimalIM } from '../src/im/minimal.js'
import { runIMLoop } from '../src/im/loop.js'
import { Databus } from '../src/im/databus.js'
import { ConversationMemory } from '../src/im/conversation-memory.js'
import { Mailbox } from '../src/im/mailbox/index.js'
import { ToolRegistry } from '../src/shell/registry.js'
import { createConfig } from '../src/shell/config.js'
import { createMetrics } from '../src/shell/metrics.js'
import { createNoopStateLine } from '../src/im/state-line/index.js'
import { SubAgentRegistry } from '../src/im/sub-agent/index.js'
import { registerSystemAgentTools } from '../src/im/system-agents/register.js'
import { createDatabusQueryTool } from '../src/im/tools/databus-query.js'
import { createNoopDriveCoordinator } from '../src/im/system-agents/drive-coordinator.js'
import type { SystemAgent } from '../src/im/system-agent.js'
import type { StreamChunk, ChatCompletionResponse } from '../src/protocol/types.js'

const noopSystemAgent: SystemAgent = {
  run: async () => { throw new Error('system agents not configured in this harness') },
  stop() {},
  send() {},
}

// --- Scripted LLM ---
// We need separate response sequences for the working agent, writer, and reader.
// Each call to streamChat picks the next response from the active sequence.
let activeSequence: ChatCompletionResponse[] = []
let activeIndex = 0

const setSequence = (responses: ChatCompletionResponse[]): void => {
  activeSequence = responses
  activeIndex = 0
}

const streamChat = async function* (): AsyncIterable<StreamChunk> {
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

// --- Setup ---
const registry = new ToolRegistry()
const mailbox = new Mailbox()
const subAgentRegistry = new SubAgentRegistry()
// v0.12: the working agent's private bus is the tree root's ownDatabus.
// createMinimalIM rebinds databus to this bus when a subAgentRegistry is
// supplied, so we hold the same reference here for direct tool invocation.
const workingDatabus = subAgentRegistry.agentTree.root.ownDatabus

// Register echo + databus_query as system tools so sub-agents can use them.
registry.registerSystemTool({
  name: 'echo',
  description: 'echoes its argument',
  parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
  execute: async (args) => ({ echo: (args as { x: string }).x }),
})
registry.registerSystemTool(createDatabusQueryTool())

// Register run_subagent + define_subagent so the working agent can spawn sub-agents.
registerSystemAgentTools(
  registry, mailbox,
  { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
  subAgentRegistry,
  {
    llmStreamChat: streamChat as unknown as Parameters<typeof registerSystemAgentTools>[4] extends infer T
      ? T extends { llmStreamChat: infer F } ? F : never : never,
    url: 'https://x',
    model: 'gpt-4',
    stateLine: createNoopStateLine(),
  },
)

// Pre-define the sub-agents (simulating what define_subagent would do).
subAgentRegistry.register({ name: 'writer', systemPrompt: 'You write via echo.', toolRefs: ['echo'] })
subAgentRegistry.register({ name: 'reader', systemPrompt: 'You query the databus.', toolRefs: ['databus_query'] })

// --- Phase 1: Run "writer" — it calls echo, projecting into root.familyDatabus ---
// run_subagent mints a unique instance id (writer-<uuid>), registers a child
// node under root. The child's ownDatabus = root.familyDatabus (siblings share
// it). The writer's echo tool turn projects into this bus with sourceAgentId
// = the instance id, NOT the template name "writer".
console.log('=== Phase 1: Run writer sub-agent ===')
setSequence([
  {
    id: 'w1', model: 'gpt-4',
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'tc-w', type: 'function', function: { name: 'echo', arguments: '{"x":"hello-from-writer","reason":"write"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  },
  {
    id: 'w2', model: 'gpt-4',
    choices: [{ index: 0, message: { role: 'assistant', content: 'writer done' }, finish_reason: 'stop' }],
  },
])

// Run the writer via run_subagent tool directly (simulating working agent's call).
const runSubagentTool = registry.getSystemTool('run_subagent')!
const writerResult = await runSubagentTool.execute(
  { name: 'writer', input: 'write hello', reason: 'phase 1' },
  { agentId: 'main', databus: workingDatabus },
)
console.log('writer output:', writerResult)

// v0.12: the writer's events are in root.familyDatabus (shared with siblings),
// but the sourceAgentId is the unique instance id (writer-<uuid>), not the
// template name "writer". We query with no filter to see all events.
const familyBus = subAgentRegistry.agentTree.root.familyDatabus
const allFamilyEvents = familyBus.turns()
console.log('root.familyDatabus events:', allFamilyEvents.length)
for (const e of allFamilyEvents) {
  console.log('  -', e.sourceAgentId, e.content.slice(0, 60))
}

// --- Phase 2: Run "reader" — it calls databus_query for writer's events ---
// The reader is also a child of root, so its ownDatabus is the same
// root.familyDatabus. It can see the writer's echo event there.
// v0.12 note: the reader's databus_query tool sees root.familyDatabus as its
// ctxDatabus (since child.ownDatabus = parent.familyDatabus). The query
// arguments from the scripted LLM ask for sourceAgentIds: ["writer"], but
// the actual sourceAgentId is the instance id (writer-<uuid>). The reader's
// query will return all events from the bus (no filter match = empty if
// filtered, all if unfiltered). The scripted reader response says it saw
// the events regardless — the harness verifies the bus contents directly.
console.log('\n=== Phase 2: Run reader sub-agent ===')

// Capture the writer's instance id before running the reader, so we can
// verify cross-sibling visibility after the reader runs.
const writerInstanceId = allFamilyEvents.find(e => e.sourceAgentId.startsWith('writer-'))?.sourceAgentId
console.log('writer instance id:', writerInstanceId)

setSequence([
  {
    id: 'r1', model: 'gpt-4',
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'tc-r', type: 'function', function: { name: 'databus_query', arguments: `{"sourceAgentIds":["${writerInstanceId}"],"reason":"read writer events"}` } }],
      },
      finish_reason: 'tool_calls',
    }],
  },
  {
    id: 'r2', model: 'gpt-4',
    choices: [{ index: 0, message: { role: 'assistant', content: 'reader saw writer events' }, finish_reason: 'stop' }],
  },
])

const readerResult = await runSubagentTool.execute(
  { name: 'reader', input: 'query writer', reason: 'phase 2' },
  { agentId: 'main', databus: workingDatabus },
)
console.log('reader output:', readerResult)

// Verify cross-sibling visibility: the reader's databus_query turn should be
// in root.familyDatabus, and its content should contain the writer's echo data.
const readerEvents = familyBus.turns().filter(e => e.sourceAgentId.startsWith('reader-'))
console.log('familyDatabus reader events:', readerEvents.length)
for (const e of readerEvents) {
  console.log('  -', e.sourceAgentId, e.content.slice(0, 80))
}

// The reader's query result (stored as a tool turn in the bus) should contain
// the writer's echo event content.
const readerQueryTurn = readerEvents.find(e => e.toolCallId === 'tc-r')
if (readerQueryTurn && readerQueryTurn.content.includes('hello-from-writer')) {
  console.log('\n✅ Cross-sibling databus visibility VERIFIED: reader saw writer\'s echo event')
} else {
  console.log('\n❌ FAILED: reader did not see writer\'s echo event')
  console.log('   reader query result:', readerQueryTurn?.content)
}

// --- Phase 3: Working agent reads sub-agent events via its own ctxDatabus ---
// The root's ctxDatabus = [root.ownDatabus, root.familyDatabus] (D5), so the
// working agent can see its own events plus all children's events.
console.log('\n=== Phase 3: Working agent reads sub-agent events ===')
setSequence([
  {
    id: 'm1', model: 'gpt-4',
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'tc-m', type: 'function', function: { name: 'databus_query', arguments: '{"reason":"read all sub-agent events"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  },
  {
    id: 'm2', model: 'gpt-4',
    choices: [{ index: 0, message: { role: 'assistant', content: 'working agent saw all events' }, finish_reason: 'stop' }],
  },
])

const workingConvMem = new ConversationMemory()
workingConvMem.append({ id: 'user-1', role: 'user', content: 'Query the databus for all events', at: Date.now() })

const loopOpts = createMinimalIM({
  config: createConfig(),
  registry,
  streamChat: streamChat as unknown as Parameters<typeof createMinimalIM>[0]['streamChat'],
  url: 'https://x',
  model: 'gpt-4',
  systemPrompt: 'You are a working agent with sub-agents.',
  userTemplate: '',
  databus: workingDatabus,
  conversationMemory: workingConvMem,
  workingAgentId: 'main',
  mailbox,
  systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
  subAgentRegistry,
  systemToolRefs: ['databus_query'],
  // v0.11.2 G3: driveCoordinator is pass-through — the caller constructs it.
  // Here we use the noop coordinator since this harness doesn't test drive logic.
  driveCoordinator: createNoopDriveCoordinator(),
})

console.log('working agent ctxDatabus buses:', (loopOpts.ctxDatabus as readonly Databus[]).length)

const result = await runIMLoop(loopOpts)
console.log('working agent loop result:', result.reason)

// The working agent's tool events are in root.ownDatabus (its private bus).
const workingToolEvents = workingDatabus.query({ sourceAgentIds: ['main'] })
console.log('root.ownDatabus main events:', workingToolEvents.length)
const mainQueryTurn = workingToolEvents.find(e => e.toolCallId === 'tc-m')
// The working agent's databus_query sees root.familyDatabus (children's events)
// via MultiDatabus. Its query result should contain writer/reader events.
if (mainQueryTurn && (mainQueryTurn.content.includes('writer') || mainQueryTurn.content.includes('hello-from-writer'))) {
  console.log('✅ Working agent VERIFIED: saw sub-agent events via MultiDatabus (D5: [own, family])')
} else {
  console.log('❌ Working agent FAILED: did not see sub-agent events')
  console.log('   main query result:', mainQueryTurn?.content?.slice(0, 120))
}

console.log('\n=== Harness complete ===')
