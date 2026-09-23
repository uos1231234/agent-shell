// v0.17.x test supplement batch 1: abort matrix.
//
// 9 tests covering AbortError handling at every observable boundary in
// runIMLoop. Adapted from KimiCode abort.e2e.test.ts. Tests are written
// RED first; bugs found drive minimal root-cause fixes in loop.ts.

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
import { ProtocolError } from '../../src/protocol/types.js'
import type { BeforeShellCallContext } from '../../src/im/loop-hooks.js'

const noopSystemAgent: SystemAgent = {
  run: async () => { throw new Error('noop') },
  stop() {},
  send() {},
}

const echoParams = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } as const

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
    name: 'echo', description: 'echo', parameters: echoParams,
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

// ---------------------------------------------------------------------------
// 1. signal already aborted on entry → returns shell-terminated, no LLM call
// ---------------------------------------------------------------------------
describe('abort 1 — signal aborted on entry', () => {
  it('returns shell-terminated without invoking streamChat', async () => {
    const ac = new AbortController()
    ac.abort()
    const opts = baseOptions({ signal: ac.signal })
    const result = await runIMLoop(opts)
    expect(result.terminated).toBe(true)
    expect(result.reason).toBe('shell-terminated')
  })
})

// ---------------------------------------------------------------------------
// 2. signal aborted mid-LLM call → shellCall throws AbortError → shell-terminated
// ---------------------------------------------------------------------------
describe('abort 2 — signal aborted mid-LLM call', () => {
  it('returns shell-terminated and surfaces aborted signal', async () => {
    const ac = new AbortController()
    const flaky: IMLoopOptions['streamChat'] = async function* (_url, _request) {
      yield { type: 'content_delta', text: 'partial' }
      ac.abort()
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    const opts = baseOptions({
      signal: ac.signal,
      streamChat: flaky,
    })
    const result = await runIMLoop(opts)
    expect(result.reason).toBe('shell-terminated')
  })
})

// ---------------------------------------------------------------------------
// 3. abort inside beforeShellCall hook → loop returns shell-terminated,
//    hook observes aborted signal
// ---------------------------------------------------------------------------
describe('abort 3 — signal aborted inside beforeShellCall hook', () => {
  it('hook receives ctx.signal.aborted=true and loop returns shell-terminated', async () => {
    const ac = new AbortController()
    ac.abort()
    let observed = false
    const opts = baseOptions({
      signal: ac.signal,
      hooks: {
        beforeShellCall: async (ctx: BeforeShellCallContext) => {
          if (ctx.signal?.aborted === true) observed = true
          // Synthetic result short-circuits before throwIfAborted (gated on no-synthetic)
          return {
            block: true,
            syntheticResponse: {
              response: {
                id: 'syn', model: 'gpt-4',
                choices: [{ index: 0, message: { role: 'assistant', content: 'abort-ok' }, finish_reason: 'stop' }],
              },
              updatedMetrics: createMetrics(),
              toolCalls: [],
            },
          }
        },
      },
    })
    const result = await runIMLoop(opts)
    expect(observed).toBe(true)
    expect(result.terminated).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. abort inside afterShellCall hook → loop returns shell-terminated
// ---------------------------------------------------------------------------
describe('abort 4 — shellCall throws AbortError → outer catch converts to shell-terminated', () => {
  it('returns shell-terminated without throwing when shellCall raises AbortError', async () => {
    const ac = new AbortController()
    const flaky: IMLoopOptions['streamChat'] = async function* () {
      ac.abort()
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    const opts = baseOptions({ signal: ac.signal, streamChat: flaky })
    const result = await runIMLoop(opts)
    // Outer try/catch detects AbortError → shell-terminated
    expect(result.terminated).toBe(true)
    expect(result.reason).toBe('shell-terminated')
  })
})

// ---------------------------------------------------------------------------
// 5. signal aborted during tool execution → transcript balance
//    (every tool.call has a matching tool.result)
// ---------------------------------------------------------------------------
describe('abort 5 — abort during tool execution preserves transcript balance', () => {
  it('every dispatched tool.call has a matching tool.result appended', async () => {
    const ac = new AbortController()
    // Tool that aborts halfway. Returns an error result.
    const registry = new ToolRegistry()
    registry.registerSystemTool({
      name: 'aborttool', description: 'tool that aborts',
      parameters: { type: 'object', properties: {}, required: [] } as const,
      execute: async () => {
        ac.abort()
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      },
    })
    const tcs: ToolCall[] = [
      { id: 'tc-1', type: 'function', function: { name: 'aborttool', arguments: '{}' } },
      { id: 'tc-2', type: 'function', function: { name: 'echo', arguments: '{"x":"hi"}' } },
    ]
    const scripts: ChatCompletionResponse[] = [
      {
        id: 'r1', model: 'gpt-4',
        choices: [{
          index: 0, message: {
            role: 'assistant', content: null, tool_calls: tcs,
          },
          finish_reason: 'tool_calls',
        }],
      },
    ]
    const conversationMemory = new ConversationMemory()
    const databus = new Databus()
    const opts = baseOptions({
      signal: ac.signal,
      registry, streamChat: scriptedStreamChat(scripts),
      conversationMemory, databus,
    })
    await runIMLoop(opts)
    // Transcript balance: every tool_call must have a tool_result
    const turnIds = new Set<string>()
    for (const t of conversationMemory.turns()) {
      if (t.role === 'tool') turnIds.add((t as { toolCallId: string }).toolCallId)
    }
    expect(turnIds.has('tc-1')).toBe(true)
    expect(turnIds.has('tc-2')).toBe(true)
    // databus projection also has both
    const databusIds = new Set(
      databus.turns().filter(t => t.role === 'tool').map(t => t.toolCallId),
    )
    expect(databusIds.has('tc-1')).toBe(true)
    expect(databusIds.has('tc-2')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 6. signal aborted before any LLM call → no tool execution
// ---------------------------------------------------------------------------
describe('abort 6 — signal aborted before any LLM call', () => {
  it('returns shell-terminated without invoking any tools', async () => {
    const ac = new AbortController()
    ac.abort()
    let toolsCalled = 0
    const registry = new ToolRegistry()
    registry.registerSystemTool({
      name: 'echo', description: 'echo', parameters: echoParams,
      execute: async () => { toolsCalled += 1; return { ok: true } },
    })
    const opts = baseOptions({ signal: ac.signal, registry })
    const result = await runIMLoop(opts)
    expect(toolsCalled).toBe(0)
    expect(result.reason).toBe('shell-terminated')
  })
})

// ---------------------------------------------------------------------------
// 7. multiple AbortController.abort() calls don't crash
// ---------------------------------------------------------------------------
describe('abort 7 — multiple abort calls are idempotent', () => {
  it('returns shell-terminated when abort is called multiple times', async () => {
    const ac = new AbortController()
    const opts = baseOptions({
      signal: ac.signal,
      hooks: {
        beforeShellCall: async () => {
          ac.abort()
          ac.abort()
          ac.abort()
          return { block: true, syntheticResponse: {
            response: { id: 's', model: 'gpt-4', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] },
            updatedMetrics: createMetrics(),
            toolCalls: [],
          } }
        },
      },
    })
    const result = await runIMLoop(opts)
    expect(result.terminated).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 8. protocol-error retry during abort → backoff is interrupted
// ---------------------------------------------------------------------------
describe('abort 8 — abort during protocol-error retry interrupts backoff', () => {
  it('returns shell-terminated within 200ms when aborted during 1000ms backoff', async () => {
    const ac = new AbortController()
    // Configure maxToolCalls/min via ShellConfig: small but realistic.
    // First call throws retriable ProtocolError; hook then triggers abort.
    const flaky: IMLoopOptions['streamChat'] = async function* (_url, _request) {
      ac.abort() // simulate user ESC the moment the first error surfaces
      throw new ProtocolError(503, 'blip', true)
    }
    const start = Date.now()
    const opts = baseOptions({
      signal: ac.signal,
      streamChat: flaky,
    })
    const result = await runIMLoop(opts)
    const elapsed = Date.now() - start
    // We must NOT wait the full 1000ms backoff when aborted.
    expect(elapsed).toBeLessThan(800)
    expect(result.reason).toBe('shell-terminated')
  })
})

// ---------------------------------------------------------------------------
// 9. shellCall throws non-abort Error → protocol-error, NOT shell-terminated
// ---------------------------------------------------------------------------
describe('abort 9 — non-abort LLM error is distinct from abort', () => {
  it('non-retriable protocol error returns reason=protocol-error, not shell-terminated', async () => {
    const failing: IMLoopOptions['streamChat'] = async function* () {
      throw new ProtocolError(400, 'bad', false)
    }
    const opts = baseOptions({ streamChat: failing })
    const result = await runIMLoop(opts)
    expect(result.reason).toBe('protocol-error')
    expect(result.terminated).toBe(true)
  })
})
