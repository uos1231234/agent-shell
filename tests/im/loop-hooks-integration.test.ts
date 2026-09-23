// v0.17: loop-hook integration tests.
//
// These exercise the real runIMLoop end-to-end with a hook installed
// via IMLoopOptions.hooks. They use scriptedStreamChat so no network is
// touched. The hook path is the primary regression surface for the
// v0.17 refactor (plan §9 step 6).

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
import type { BeforeShellCallResult, AfterShellCallResult, AfterGuardsResult, LoopHooks } from '../../src/im/loop-hooks.js'

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
// beforeShellCall — block=true with syntheticResponse short-circuits the round
// ---------------------------------------------------------------------------

describe('beforeShellCall — syntheticResponse short-circuits the round', () => {
  it('uses the hook-provided response as the round output and terminates with completed', async () => {
    let calls = 0
    const hooks: LoopHooks = {
      beforeShellCall: async () => {
        calls += 1
        const synthetic = {
          response: {
            id: 'syn-1', model: 'gpt-4',
            choices: [{ index: 0, message: { role: 'assistant', content: 'synthetic answer' }, finish_reason: 'stop' as const }],
          },
          updatedMetrics: { ...createMetrics() } as never,
          toolCalls: [],
        }
        return { block: true, syntheticResponse: synthetic } as BeforeShellCallResult
      },
    }
    // No scripted responses — the synthetic one supplies the answer.
    const opts = baseOptions({ hooks, streamChat: scriptedStreamChat([]) })
    const result = await runIMLoop(opts)
    expect(calls).toBe(1)
    expect(result.terminated).toBe(true)
    expect(result.reason).toBe('completed')
    expect(result.metrics).toBeDefined()
    // The synthetic assistant turn should be appended to the conversation.
    const turns = opts.conversationMemory.turns()
    const lastAssistant = [...turns].reverse().find(t => t.role === 'assistant')
    expect(lastAssistant?.content).toBe('synthetic answer')
  })
})

// ---------------------------------------------------------------------------
// afterShellCall — retry=true short-circuits the default protocol-error backoff
// ---------------------------------------------------------------------------

describe('afterShellCall — retry=true short-circuits default protocol-error handling', () => {
  it('skips the default retry/backoff and proceeds to the next round', async () => {
    // First scripted response: throw a retriable ProtocolError.
    // Hook returns retry=true with a tiny delay → we skip the default
    // exponential backoff and re-enter the next round.
    // Second scripted response: clean completion.
    let callCount = 0
    const scripts: ChatCompletionResponse[] = [
      {
        id: 'r1', model: 'gpt-4',
        choices: [{
          index: 0, message: { role: 'assistant', content: 'final answer' },
          finish_reason: 'stop',
        }],
      },
    ]
    const flaky: IMLoopOptions['streamChat'] = async function* (_url, _request): AsyncIterable<StreamChunk> {
      callCount += 1
      if (callCount === 1) {
        throw new ProtocolError(503, 'net blip', true)
      }
      const r = scripts[0]!
      const msg = r.choices[0]?.message
      yield { type: 'content_delta', text: msg?.content ?? '' }
      yield { type: 'finish', reason: 'stop' }
      yield { type: 'done' }
    }

    const hooks: LoopHooks = {
      afterShellCall: async () => {
        return { retry: true, retryDelayMs: 5 } as AfterShellCallResult
      },
    }
    const opts = baseOptions({ hooks, streamChat: flaky })
    const result = await runIMLoop(opts)
    // Hook intercepts the first round's error → no ProtocolError termination.
    expect(result.terminated).toBe(true)
    expect(result.reason).toBe('completed')
    // Second round completed cleanly.
    expect(callCount).toBe(2)
  })

  // Minimal ProtocolError stub (we throw it from the stream function above,
  // but ProtocolError is exported from protocol/types — import here for the
  // thrown-on-protocol-error test below).
  it('default behavior (no hook) still terminates on non-retriable ProtocolError', async () => {
    let called = 0
    const failing: IMLoopOptions['streamChat'] = async function* () {
      called += 1
      throw new ProtocolError(400, 'bad request', false)
    }
    const opts = baseOptions({ streamChat: failing })
    const result = await runIMLoop(opts)
    expect(result.terminated).toBe(true)
    expect(result.reason).toBe('protocol-error')
    expect(called).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// afterGuards — forceTerminate halts the loop without a guard hit
// ---------------------------------------------------------------------------

describe('afterGuards — forceTerminate halts the loop', () => {
  it('terminates with the hook-provided reason even when no guard hit', async () => {
    const scripts: ChatCompletionResponse[] = [
      {
        id: 'r1', model: 'gpt-4',
        choices: [{
          index: 0, message: { role: 'assistant', content: 'plain answer' },
          finish_reason: 'stop',
        }],
      },
    ]
    let calls = 0
    const hooks: LoopHooks = {
      afterGuards: async () => {
        calls += 1
        return { forceTerminate: true, reason: 'shell-terminated' } as AfterGuardsResult
      },
    }
    const opts = baseOptions({ hooks, streamChat: scriptedStreamChat(scripts) })
    const result = await runIMLoop(opts)
    expect(calls).toBe(1)
    expect(result.terminated).toBe(true)
    expect(result.reason).toBe('shell-terminated')
  })
})

// ---------------------------------------------------------------------------
// beforeToolExecution — block=true with syntheticToolResults substitutes the batch
// ---------------------------------------------------------------------------

describe('beforeToolExecution — block=true with syntheticToolResults substitutes the batch', () => {
  it('skips actual tool execution and appends the synthetic tool turn', async () => {
    const toolCalls = [{
      id: 'tc-1', type: 'function' as const,
      function: { name: 'echo', arguments: '{"x":"hi"}' },
    }]
    const scripts: ChatCompletionResponse[] = [
      {
        id: 'r1', model: 'gpt-4',
        choices: [{
          index: 0, message: {
            role: 'assistant', content: null,
            tool_calls: toolCalls,
          },
          finish_reason: 'tool_calls',
        }],
      },
      {
        id: 'r2', model: 'gpt-4',
        choices: [{
          index: 0, message: { role: 'assistant', content: 'done' },
          finish_reason: 'stop',
        }],
      },
    ]
    let realEchoCalled = 0
    const registry = new ToolRegistry()
    registry.registerSystemTool({
      name: 'echo', description: 'echo', parameters: echoParams,
      execute: async (args) => { realEchoCalled += 1; return { echo: (args as { x: string }).x } },
    })
    const databus = new Databus()
    const conversationMemory = new ConversationMemory()
    const hooks: LoopHooks = {
      beforeToolExecution: async () => {
        return {
          block: true,
          syntheticToolResults: [{
            id: 'synthetic-1', role: 'tool', toolCallId: 'tc-1',
            content: 'synthetic output', sourceAgentId: 'main', at: Date.now(),
          }],
        }
      },
    }
    const opts: IMLoopOptions = {
      ...baseOptions({ hooks, streamChat: scriptedStreamChat(scripts) }),
      registry, databus, conversationMemory,
    }
    const result = await runIMLoop(opts)
    expect(result.reason).toBe('completed')
    // Real echo was NOT called because the synthetic results replaced the batch.
    expect(realEchoCalled).toBe(0)
    // Synthetic tool result was appended to the databus.
    const events = databus.turns()
    expect(events.some(e => e.content === 'synthetic output')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Hook is NOT called when not provided — backward compat regression
// ---------------------------------------------------------------------------

describe('no hooks — backward compat (pre-v0.17 behavior unchanged)', () => {
  it('completes normally without invoking any hook', async () => {
    const scripts: ChatCompletionResponse[] = [
      {
        id: 'r1', model: 'gpt-4',
        choices: [{
          index: 0, message: { role: 'assistant', content: 'hello' },
          finish_reason: 'stop',
        }],
      },
    ]
    const opts = baseOptions({ streamChat: scriptedStreamChat(scripts) })
    const result = await runIMLoop(opts)
    expect(result.terminated).toBe(true)
    expect(result.reason).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// ProtocolError import (local, kept last so the file's describe blocks read top-down)
// ---------------------------------------------------------------------------

import { ProtocolError } from '../../src/protocol/types.js'

// ===========================================================================
// v0.17.x regression suite: hooks must not silently bypass guards or leak
// state. These tests were added after a zero-trust review of the v0.17
// refactor — each one targets a specific bug the v0.17 release shipped.
// They are RED today (they fail) and must be made GREEN by the fix pass.
// ===========================================================================

describe('regression P0-1 — beforeShellCall block without synthetic must terminate, not continue', () => {
  it('does not silently consume turns when block=true with no synthetic', async () => {
    let hookCalls = 0
    const hooks: LoopHooks = {
      beforeShellCall: async () => {
        hookCalls += 1
        return { block: true } // no syntheticResponse
      },
    }
    const opts = baseOptions({ hooks })
    const result = await runIMLoop(opts)
    // Hook should fire exactly once; the loop must terminate immediately
    // rather than burn turns with continue (KimiCode pattern: throw, not loop).
    expect(hookCalls).toBe(1)
    expect(result.terminated).toBe(true)
    // No guard actually hit — the termination reason must reflect that.
    // (Acceptable: 'guard-tripped' with empty hits OR a dedicated reason.)
    expect(result.hits).toEqual([])
  })
})

describe('regression P0-2 — afterGuards forceTerminate sets state consistent with reason', () => {
  it('state stays Running when forceTerminate reason is "completed"', async () => {
    const scripts: ChatCompletionResponse[] = [
      {
        id: 'r1', model: 'gpt-4',
        choices: [{
          index: 0, message: { role: 'assistant', content: 'answer' },
          finish_reason: 'stop',
        }],
      },
    ]
    const hooks: LoopHooks = {
      afterGuards: async () => {
        return { forceTerminate: true, reason: 'completed' }
      },
    }
    const opts = baseOptions({ hooks, streamChat: scriptedStreamChat(scripts) })
    const result = await runIMLoop(opts)
    expect(result.terminated).toBe(true)
    expect(result.reason).toBe('completed')
    // The bug: state was hardcoded to 'Tripped' even when reason='completed'.
    // Final state must reflect actual lifecycle status.
    expect(result.finalState).not.toBe('Tripped')
  })
})

describe('regression P1-3 — hook retry must respect MAX_PROTOCOL_ERROR_RETRIES', () => {
  it('does not retry indefinitely when the hook returns retry=true forever', async () => {
    let hookCalls = 0
    const hooks: LoopHooks = {
      afterShellCall: async () => {
        hookCalls += 1
        return { retry: true, retryDelayMs: 0 }
      },
    }
    // streamChat throws a retriable ProtocolError on every call.
    const failing: IMLoopOptions['streamChat'] = async function* () {
      throw new ProtocolError(503, 'always', true)
    }
    const opts = baseOptions({ hooks, streamChat: failing })
    const result = await runIMLoop(opts)
    // The hook must NOT bypass the global retry cap (default 3).
    expect(hookCalls).toBeLessThanOrEqual(4) // ≤ MAX(3) + initial call
    expect(result.terminated).toBe(true)
    expect(result.reason).toBe('protocol-error')
  })
})

describe('regression P1-5 — callHook emits a structured logger record, not console.warn', () => {
  it('failed hooks log via the loop logger (preserves component binding)', async () => {
    const calls: Array<{ component?: string; level?: string }> = []
    const capturingLogger = {
      child: () => capturingLogger,
      info: (..._args: unknown[]) => {},
      warn: (...args: unknown[]) => { calls.push({ level: 'warn' }) },
      error: (...args: unknown[]) => { calls.push({ level: 'error' }) },
      trace: () => {},
      debug: () => {},
    } as unknown as IMLoopOptions['logger']

    const hooks: LoopHooks = {
      beforeShellCall: async () => {
        throw new Error('hook-failure-test')
      },
    }
    const opts = baseOptions({ hooks, logger: capturingLogger })
    const result = await runIMLoop(opts)
    expect(result.terminated).toBe(true)
    // Some warn record must have been emitted via the logger, not console.
    expect(calls.some(c => c.level === 'warn')).toBe(true)
  })
})

describe('regression P1-6 — abort signal propagates between hook calls', () => {
  // SKIPPED until stage 2 wires AbortController into loop.ts. Without the
  // fix, this test loops forever because the loop never observes the signal.
  // Re-enable after stage 2 lands.
  it('aborts mid-loop when signal is already triggered (and ctx.signal is observable to hooks)', async () => {
    let observedAborted = false
    const ac = new AbortController()
    ac.abort() // pre-trigger

    const hooks: LoopHooks = {
      beforeShellCall: async (ctx) => {
        if (ctx.signal?.aborted === true) observedAborted = true
        // Stop the loop after observing — without this the aborted signal
        // surfaces, the loop throws AbortError, and runIMLoop returns; but
        // giving the hook a chance to terminate cleanly (forceTerminate path)
        // is also valid. We terminate by returning block:true + synthetic
        // so the loop exits via the "completed" path with one round.
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
    }
    const opts = baseOptions({ hooks, signal: ac.signal })
    const result = await runIMLoop(opts)
    // The hook observed the aborted signal AND the loop completed.
    expect(observedAborted).toBe(true)
    expect(result.terminated).toBe(true)
  })
})

describe('regression P1-7 — synthetic response skips compose + tool execution', () => {
  it('does not re-compose or re-execute tools when beforeShellCall supplies a synthetic', async () => {
    let realToolCalled = 0
    const hooks: LoopHooks = {
      beforeShellCall: async () => {
        return {
          block: true,
          syntheticResponse: {
            response: {
              id: 'syn', model: 'gpt-4',
              choices: [{ index: 0, message: { role: 'assistant', content: 'fast' }, finish_reason: 'stop' }],
            },
            updatedMetrics: createMetrics(),
            toolCalls: [],
          } as never,
        }
      },
    }
    const registry = new ToolRegistry()
    registry.registerSystemTool({
      name: 'echo', description: 'echo', parameters: echoParams,
      execute: async (args) => { realToolCalled += 1; return { echo: (args as { x: string }).x } },
    })
    const opts = baseOptions({ hooks, registry })
    const result = await runIMLoop(opts)
    expect(result.reason).toBe('completed')
    // The bug: even with a synthetic response, compose() and tool execution
    // still ran. The fix: skip both when syntheticResponse is supplied.
    expect(realToolCalled).toBe(0)
  })
})
