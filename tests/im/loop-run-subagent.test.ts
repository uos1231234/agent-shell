// v0.11.2 G1: real working-agent loop calling run_subagent via tool_call.
//
// This is the end-to-end chain test that was missing in v0.11.1: a working
// agent loop (runIMLoop) where the LLM emits a run_subagent tool_call, the
// sub-agent actually runs its own loop, and the sub-agent's output is fed
// back as a tool result to the working agent's final round.
//
// The scriptedStreamChat must supply responses in call order:
//   1. Working agent round 1: emits run_subagent tool_call
//   2. Sub-agent round(s): the sub-agent's own LLM calls (consumed inside
//      createSystemAgent → runIMLoop, using the SAME llmStreamChat closure)
//   3. Working agent round 2: final text answer (no tool calls → 'completed')

import { describe, it, expect } from 'vitest'
import { runIMLoop, type IMLoopOptions } from '../../src/im/loop.js'
import { ToolRegistry } from '../../src/shell/registry.js'
import { createConfig } from '../../src/shell/config.js'
import { createMetrics } from '../../src/shell/metrics.js'
import { Databus, type AgentId } from '../../src/im/databus.js'
import { ConversationMemory } from '../../src/im/conversation-memory.js'
import { Mailbox } from '../../src/im/mailbox/index.js'
import { createNoopStateLine } from '../../src/im/state-line/index.js'
import { registerSystemAgentTools, type RegisterSystemAgentToolDeps } from '../../src/im/system-agents/register.js'
import { SubAgentRegistry } from '../../src/im/sub-agent/index.js'
import type { SystemAgent } from '../../src/im/system-agent.js'
import type { StreamChunk, ChatCompletionResponse, ToolCall } from '../../src/protocol/types.js'

const noopSystemAgent: SystemAgent = {
  run: async () => { throw new Error('noop') },
  stop() {},
  send() {},
}

// Reuse the scriptedStreamChat pattern from loop.test.ts — one response per
// LLM call, yielded as StreamChunk deltas. The same closure is shared by the
// working agent's loop and the sub-agent's loop (run_subagent closes over it).
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

describe('G1: working agent loop calls run_subagent via real tool_call', () => {
  it('runs sub-agent, feeds output back, and completes the working agent loop', async () => {
    // Scripted responses in call order:
    // 1. Working agent round 1: calls run_subagent(name=reviewer, input="check this")
    // 2. Sub-agent round 1: calls echo(x="hello")
    // 3. Sub-agent round 2: final text "review complete" (no tool calls)
    // 4. Working agent round 2: final text "done" (no tool calls)
    const responses: ChatCompletionResponse[] = [
      {
        id: 'w1', model: 'gpt-4',
        choices: [{
          index: 0,
          message: {
            role: 'assistant', content: null,
            tool_calls: [{
              id: 'tc-1', type: 'function',
              function: { name: 'run_subagent', arguments: '{"name":"reviewer","input":"check this","reason":"delegate review"}' },
            } as ToolCall],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        id: 's1', model: 'gpt-4',
        choices: [{
          index: 0,
          message: {
            role: 'assistant', content: null,
            tool_calls: [{
              id: 'tc-2', type: 'function',
              function: { name: 'echo', arguments: '{"x":"hello","reason":"verify"}' },
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
          message: { role: 'assistant', content: 'review complete' },
          finish_reason: 'stop',
        }],
        usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
      },
      {
        id: 'w2', model: 'gpt-4',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'done' },
          finish_reason: 'stop',
        }],
        usage: { promptTokens: 30, completionTokens: 5, totalTokens: 35 },
      },
    ]

    const sharedStreamChat = scriptedStreamChat(responses)

    const registry = new ToolRegistry()
    registry.registerSystemTool({
      name: 'echo',
      description: 'echoes input',
      parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } as const,
      execute: async (args) => ({ echo: (args as { x: string }).x }),
    })

    // v0.12: when a subAgentRegistry is supplied, createMinimalIM forces the
    // working agent's databus to the tree root's ownDatabus. But this test
    // constructs IMLoopOptions directly (not via createMinimalIM), so we must
    // wire the root bus ourselves so run_subagent can resolve ctx.agentId
    // 'main' in the tree and so the working agent's tool events land where
    // children can read them.
    const subAgentRegistry = new SubAgentRegistry()
    const workingDatabus = subAgentRegistry.agentTree.root.ownDatabus
    // v0.12 P0-fix: inject the tree into the Mailbox so family route checks
    // are enforced (run_subagent internally does NOT call mailbox.send, but
    // the sub-agent's own loop may, so the tree must be wired for parity with
    // the createMinimalIM production path).
    const mailbox = new Mailbox(subAgentRegistry.agentTree)
    const conversationMemory = new ConversationMemory()
    const stateLine = createNoopStateLine()

    // Pre-register a sub-agent that can call echo.
    await subAgentRegistry.register({
      name: 'reviewer',
      systemPrompt: 'You are a reviewer. Use echo to verify.',
      toolRefs: ['echo'],
    })

    // Register system agent tools including run_subagent + define_subagent.
    // The shared scripted streamChat is passed here so run_subagent closes
    // over the same response sequence as the working agent's loop.
    // Cast: IMLoopOptions streamChat and RunSubagentDeps llmStreamChat have
    // structurally incompatible `tools` types (optional vs required, OpenAITool
    // vs unknown); the scripted function ignores the request anyway.
    registerSystemAgentTools(
      registry,
      mailbox,
      { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
      subAgentRegistry,
      {
        llmStreamChat: sharedStreamChat as unknown as RegisterSystemAgentToolDeps['llmStreamChat'],
        url: 'https://x',
        model: 'gpt-4',
        stateLine,
      },
    )

    const opts: IMLoopOptions = {
      config: createConfig(),
      registry,
      databus: workingDatabus,
      conversationMemory,
      workingAgentId: 'main',
      mailbox,
      systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
      stateLine,
      initialMetrics: createMetrics(),
      streamChat: sharedStreamChat,
      url: 'https://x',
      model: 'gpt-4',
      systemPrompt: 'You are the working agent.',
      userTemplate: 'User: {{user}}',
      systemToolRefs: ['run_subagent'],
      mcpRefs: [],
      skillRefs: [],
      // ctxDatabus: [root.ownDatabus, root.familyDatabus] so the working agent
      // sees its own tool history plus all its children's events (D5).
      ctxDatabus: [workingDatabus, subAgentRegistry.agentTree.root.familyDatabus],
    }

    const result = await runIMLoop(opts)

    // Working agent loop completed
    expect(result.terminated).toBe(true)
    expect(result.reason).toBe('completed')

    // The working agent's conversation memory should have:
    // turn 0: assistant(run_subagent tool_call)
    // turn 1: tool result (sub-agent output)
    // turn 2: assistant final text "done"
    const turns = conversationMemory.turns()
    expect(turns.length).toBeGreaterThanOrEqual(3)

    // The tool result turn should contain the sub-agent's output. Since
    // v0.11.3 P1-1 the tool returns a structured object, executeToolCalls
    // JSON.stringifies it before appending, so the content is the JSON form
    // of SubAgentRunResult: { "output": "review complete", "status": "completed" }.
    const toolTurn = turns.find((t) => t.role === 'tool')
    expect(toolTurn).toBeDefined()
    const parsed = JSON.parse(toolTurn!.content as string)
    expect(parsed.output).toContain('review complete')
    expect(parsed.status).toBe('completed')

    // The final assistant turn should be "done"
    const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant')
    expect(lastAssistant?.content).toBe('done')

    // v0.12: the sub-agent's tool events project into root.familyDatabus
    // (the child's ownDatabus), under the reviewer instance id (`reviewer-<uuid>`).
    // Filter by prefix since each run mints a fresh UUID.
    const subEvents = subAgentRegistry.agentTree.root.familyDatabus.turns() as ReadonlyArray<{ sourceAgentId?: AgentId }>
    const reviewerEvents = subEvents.filter((e) => e.sourceAgentId?.startsWith('reviewer-'))
    expect(reviewerEvents.length).toBeGreaterThan(0)
  })
})
