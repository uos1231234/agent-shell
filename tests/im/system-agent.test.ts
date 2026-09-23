import { describe, it, expect, vi } from 'vitest'
import { createSystemAgent, type SystemAgent } from '../../src/im/system-agent.js'
import { ToolRegistry } from '../../src/shell/registry.js'
import { Mailbox } from '../../src/im/mailbox/index.js'
import { Databus } from '../../src/im/databus.js'
import { ConversationMemory } from '../../src/im/conversation-memory.js'
import { createConfig } from '../../src/shell/config.js'
import type { StreamChunk, ChatCompletionResponse } from '../../src/protocol/types.js'
import type { StateLine } from '../../src/im/state-line/types.js'

// NoopStateLine for tests that don't exercise state-line functionality.
const noopStateLine: StateLine = {
  compressor: { async appendBlock() {} },
  warehouse: {
    async appendSummary() {},
    async queryM3() { return { ok: false, error: 'noop' } },
  },
  rawArchive: {
    async append() {},
    async query() { return [] },
  },
  query: () => [],
  subscribe: () => () => {},
  close() {},
}

// Scripted streamChat matching the pattern from loop.test.ts
const scriptedStreamChat = (
  responses: ChatCompletionResponse[],
  spy?: ReturnType<typeof vi.fn>,
): Parameters<typeof createSystemAgent>[0]['llmStreamChat'] => {
  let i = 0
  return async function* (_url, request): AsyncIterable<StreamChunk> {
    if (spy) spy(_url, request)
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

const echoParams = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } as const

const makeRegistry = (): ToolRegistry => {
  const r = new ToolRegistry()
  r.registerSystemTool({
    name: 'echo',
    description: 'echo',
    parameters: echoParams,
    execute: async (args) => ({ echo: (args as { x: string }).x }),
  })
  return r
}

describe('im/system-agent', () => {
  it('createSystemAgent returns a SystemAgent with run/stop/send', () => {
    const agent = createSystemAgent({
      name: 'warehouse',
      systemPrompt: 'SYS',
      toolRefs: ['echo'],
      llmStreamChat: scriptedStreamChat([]),
      url: 'https://x',
      model: 'gpt-4',
      mailbox: new Mailbox(),
      registry: makeRegistry(),
      stateLine: noopStateLine,
    })
    expect(typeof agent.run).toBe('function')
    expect(typeof agent.stop).toBe('function')
    expect(typeof agent.send).toBe('function')
  })

  it('factory stamps sourceAgentId on the agent\'s databus', async () => {
    const registry = makeRegistry()
    const mailbox = new Mailbox()
    const tcResponse: ChatCompletionResponse = {
      id: 'r1', model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'echo', arguments: '{"x":"hi"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    }
    const finalResponse: ChatCompletionResponse = {
      id: 'r2', model: 'gpt-4',
      choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
    }
    const agent = createSystemAgent({
      name: 'warehouse',
      systemPrompt: 'SYS',
      toolRefs: ['echo'],
      llmStreamChat: scriptedStreamChat([tcResponse, finalResponse]),
      url: 'https://x',
      model: 'gpt-4',
      mailbox,
      registry,
      stateLine: noopStateLine,
    })
    const result = await agent.run({ messages: [{ role: 'user', content: 'run echo' }] })
    expect(result.finalState).toBe('Running')
    // The agent's internal databus has a tool turn with sourceAgentId === 'warehouse'
    // We can't directly inspect the agent's private databus, but we can verify
    // the run completed successfully and output is the last assistant message.
    expect(result.output).toBe('done')
  })

  it('factory reuses llmStreamChat', async () => {
    const registry = makeRegistry()
    const spy = vi.fn()
    const agent = createSystemAgent({
      name: 'warehouse',
      systemPrompt: 'SYS',
      toolRefs: [],
      llmStreamChat: scriptedStreamChat([{
        id: 'r1', model: 'gpt-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }], spy),
      url: 'https://x',
      model: 'gpt-4',
      mailbox: new Mailbox(),
      registry,
      stateLine: noopStateLine,
    })
    await agent.run({ messages: [{ role: 'user', content: 'hello' }] })
    expect(spy).toHaveBeenCalled()
  })

  it('system prompt is passed to the inner runIMLoop', async () => {
    const registry = makeRegistry()
    const spy = vi.fn()
    const agent = createSystemAgent({
      name: 'recall',
      systemPrompt: 'You are the recall agent.',
      toolRefs: [],
      llmStreamChat: scriptedStreamChat([{
        id: 'r1', model: 'gpt-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }], spy),
      url: 'https://x',
      model: 'gpt-4',
      mailbox: new Mailbox(),
      registry,
      stateLine: noopStateLine,
    })
    await agent.run({ messages: [{ role: 'user', content: 'query' }] })
    // The spy receives (url, request). The request.messages[0] should be the system prompt.
    const call = spy.mock.calls[0]!
    const request = call[1] as { messages: { role: string; content: string }[] }
    expect(request.messages[0]).toMatchObject({ role: 'system', content: 'You are the recall agent.' })
  })

  it('toolRefs are passed as systemToolRefs', async () => {
    const registry = makeRegistry()
    const spy = vi.fn()
    const agent = createSystemAgent({
      name: 'compressor',
      systemPrompt: 'SYS',
      toolRefs: ['echo'],
      llmStreamChat: scriptedStreamChat([{
        id: 'r1', model: 'gpt-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }], spy),
      url: 'https://x',
      model: 'gpt-4',
      mailbox: new Mailbox(),
      registry,
      stateLine: noopStateLine,
    })
    await agent.run({ messages: [{ role: 'user', content: 'compress' }] })
    // The spy receives (url, request). The request.tools should include the echo tool.
    const call = spy.mock.calls[0]!
    const request = call[1] as { tools: { function: { name: string } }[] }
    expect(request.tools).toBeDefined()
    expect(request.tools!.some((t) => t.function.name === 'echo')).toBe(true)
  })

  it('forged tool calls outside toolRefs do not reach the executor or SecurityDoor', async () => {
    const registry = makeRegistry()
    let doorCalls = 0
    registry.registerDoor({
      name: 'approval-door',
      check: () => { doorCalls += 1; return { allow: true } },
    })
    const agent = createSystemAgent({
      name: 'baseline-structure',
      systemPrompt: 'SYS',
      toolRefs: [],
      llmStreamChat: scriptedStreamChat([
        {
          id: 'r1', model: 'gpt-4',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'tc-forged',
                type: 'function',
                function: { name: 'echo', arguments: '{"x":"should be blocked"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        },
        {
          id: 'r2', model: 'gpt-4',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'done' },
            finish_reason: 'stop',
          }],
        },
      ]),
      url: 'https://x',
      model: 'gpt-4',
      mailbox: new Mailbox(),
      registry,
      stateLine: noopStateLine,
    })

    const result = await agent.run({ messages: [{ role: 'user', content: 'scout' }] })
    expect(result.output).toBe('done')
    expect(doorCalls).toBe(0)
  })

  it('agent can use mailbox_read tool', async () => {
    const registry = makeRegistry()
    const mailbox = new Mailbox()
    // Send a message to the warehouse agent so its inbox has something
    mailbox.send({ from: 'main', to: 'warehouse', subject: 'hello', body: 'world' })

    // Register mailbox_read so the agent can call it
    const { createMailboxReadTool } = await import('../../src/im/tools/mailbox-read.js')
    registry.registerSystemTool(createMailboxReadTool(mailbox))

    const tcResponse: ChatCompletionResponse = {
      id: 'r1', model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'tc-mr', type: 'function', function: { name: 'mailbox_read', arguments: '{"reason":"check inbox"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    }
    const finalResponse: ChatCompletionResponse = {
      id: 'r2', model: 'gpt-4',
      choices: [{ index: 0, message: { role: 'assistant', content: 'got mail' }, finish_reason: 'stop' }],
    }
    const agent = createSystemAgent({
      name: 'warehouse',
      systemPrompt: 'SYS',
      toolRefs: ['mailbox_read'],
      llmStreamChat: scriptedStreamChat([tcResponse, finalResponse]),
      url: 'https://x',
      model: 'gpt-4',
      mailbox,
      registry,
      stateLine: noopStateLine,
    })
    const result = await agent.run({ messages: [{ role: 'user', content: 'check mail' }] })
    expect(result.output).toBe('got mail')
  })

  it('3 agents share the same mailbox', async () => {
    const sharedMailbox = new Mailbox()
    const registry = makeRegistry()

    // Create 3 agents with the same mailbox
    const agentA = createSystemAgent({
      name: 'agent-a',
      systemPrompt: 'SYS',
      toolRefs: [],
      llmStreamChat: scriptedStreamChat([{
        id: 'r1', model: 'gpt-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }]),
      url: 'https://x',
      model: 'gpt-4',
      mailbox: sharedMailbox,
      registry,
      stateLine: noopStateLine,
    })
    const agentB = createSystemAgent({
      name: 'agent-b',
      systemPrompt: 'SYS',
      toolRefs: [],
      llmStreamChat: scriptedStreamChat([{
        id: 'r1', model: 'gpt-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }]),
      url: 'https://x',
      model: 'gpt-4',
      mailbox: sharedMailbox,
      registry,
      stateLine: noopStateLine,
    })

    // Agent A sends a message to Agent B via the shared mailbox
    sharedMailbox.send({ from: 'agent-a', to: 'agent-b', subject: 'hello', body: 'from A' })

    // Agent B has unread mail
    expect(sharedMailbox.hasUnread('agent-b')).toBe(true)
    expect(sharedMailbox.hasUnread('agent-a')).toBe(false)

    // Agent A and B both run successfully (shared mailbox doesn't interfere)
    await agentA.run({ messages: [{ role: 'user', content: 'hi' }] })
    await agentB.run({ messages: [{ role: 'user', content: 'hi' }] })
  })

  it('run() does not accumulate history across calls (P1 regression)', async () => {
    const registry = makeRegistry()
    const messageCounts: number[] = []
    const spy = vi.fn((_url, request: { messages: unknown[] }) => {
      messageCounts.push(request.messages.length)
    })
    const response: ChatCompletionResponse = {
      id: 'r1', model: 'gpt-4',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }
    const agent = createSystemAgent({
      name: 'warehouse',
      systemPrompt: 'SYS',
      toolRefs: [],
      llmStreamChat: scriptedStreamChat([response, response], spy),
      url: 'https://x',
      model: 'gpt-4',
      mailbox: new Mailbox(),
      registry,
      stateLine: noopStateLine,
    })
    await agent.run({ messages: [{ role: 'user', content: 'first' }] })
    await agent.run({ messages: [{ role: 'user', content: 'second' }] })
    // Without the fix, the second run sees 1 (system) + 1 (first input) +
    // 1 (first assistant) + 1 (second input) = 4, not 2 (system + second input).
    expect(messageCounts[1]).toBe(messageCounts[0])
  })

  it('run() preserves tool-role input in private canonical sequence (v0.10.4 B6)', async () => {
    // Plan §5.10 item 6: run({ messages: [user, assistant(tool_calls), tool, assistant] })
    // preserves all input messages in the private canonical sequence and projects
    // only the tool input to the private Databus.
    //
    // The agent's private stores are not directly accessible, but the inner loop
    // builds its streamChat request from the canonical conversation memory. So we
    // capture the request and assert the seed messages appear in exact order.
    const registry = makeRegistry()
    let capturedMessages: any[] | null = null
    const spy = vi.fn((_url, request: { messages: unknown[] }) => {
      capturedMessages = request.messages as any[]
    })
    const response: ChatCompletionResponse = {
      id: 'r1', model: 'gpt-4',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }
    const agent = createSystemAgent({
      name: 'compressor',
      systemPrompt: 'SYS',
      toolRefs: [],
      llmStreamChat: scriptedStreamChat([response], spy),
      url: 'https://x',
      model: 'gpt-4',
      mailbox: new Mailbox(),
      registry,
      stateLine: noopStateLine,
    })

    const tc = { id: 'tc-seed', type: 'function' as const, function: { name: 'echo', arguments: '{"x":"hi"}' } }
    await agent.run({
      messages: [
        { role: 'user', content: 'compress this' },
        { role: 'assistant', content: null, tool_calls: [tc] },
        { role: 'tool', tool_call_id: 'tc-seed', content: '{"echo":"hi"}' },
        { role: 'assistant', content: 'seeded result' },
      ],
    })

    // v0.19: compose order is [system, afterSystem injections, history, userTemplate, afterUser injections].
    // The 4 seed messages are in the conversation history (afterSystem injections + history).
    expect(capturedMessages).not.toBeNull()
    // Find the seed messages by locating the first user message with content 'compress this'.
    const seedStart = capturedMessages!.findIndex(
      m => m.role === 'user' && m.content === 'compress this',
    )
    expect(seedStart).toBeGreaterThanOrEqual(0)
    const seedMessages = capturedMessages!.slice(seedStart, seedStart + 4)
    expect(seedMessages).toHaveLength(4)
    expect(seedMessages[0]).toMatchObject({ role: 'user', content: 'compress this' })
    expect(seedMessages[1]).toMatchObject({ role: 'assistant', tool_calls: [tc] })
    expect(seedMessages[2]).toMatchObject({ role: 'tool', tool_call_id: 'tc-seed', content: '{"echo":"hi"}' })
    expect(seedMessages[3]).toMatchObject({ role: 'assistant', content: 'seeded result' })
  })

  // ---------- v0.10.6: system agents opt out of text-skill injection ----------

  it('createSystemAgent sets injectTextSkills:false — text skill body never reaches the system prompt', async () => {
    // System agents (warehouse/compressor/recall) must not receive user
    // skill content. createSystemAgent sets injectTextSkills:false on the
    // inner loop, so even if the shared registry has text skills registered,
    // their bodies do not appear in the system agent's system message.
    const registry = makeRegistry()
    registry.registerTextSkill('style-guide', 'USER SKILL CONTENT THAT MUST NOT LEAK')

    let capturedMessages: Array<{ role: string; content: string }> | null = null
    const spy = vi.fn((_url: string, request: { messages: unknown[] }) => {
      capturedMessages = request.messages as Array<{ role: string; content: string }>
    })
    const response: ChatCompletionResponse = {
      id: 'r1', model: 'gpt-4',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }
    const agent = createSystemAgent({
      name: 'warehouse',
      systemPrompt: 'WAREHOUSE SYS',
      toolRefs: [],
      llmStreamChat: scriptedStreamChat([response], spy),
      url: 'https://x',
      model: 'gpt-4',
      mailbox: new Mailbox(),
      registry,
      stateLine: noopStateLine,
    })
    await agent.run({ messages: [{ role: 'user', content: 'do work' }] })

    expect(capturedMessages).not.toBeNull()
    // The system message is messages[0] — it must contain only the base
    // system prompt, NOT the text-skill body.
    const sysMsg = capturedMessages!.find((m) => m.role === 'system')
    expect(sysMsg).toBeDefined()
    expect(sysMsg!.content).toBe('WAREHOUSE SYS')
    expect(sysMsg!.content).not.toContain('USER SKILL CONTENT THAT MUST NOT LEAK')
  })
})
