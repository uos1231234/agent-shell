import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runIMLoop, type IMLoopOptions, type IMLoopResult } from '../../src/im/loop.js'
import { ToolRegistry } from '../../src/shell/registry.js'
import { createConfig } from '../../src/shell/config.js'
import { createMetrics } from '../../src/shell/metrics.js'
import { Databus } from '../../src/im/databus.js'
import { ConversationMemory } from '../../src/im/conversation-memory.js'
import { Mailbox } from '../../src/im/mailbox/index.js'
import { wrapTool } from '../../src/im/tools/helpers.js'
import { createNoopStateLine, createStateLine } from '../../src/im/state-line/index.js'
import type { CuratedMemory, StateLine, StateLineQueryFilter } from '../../src/im/state-line/types.js'
import type { SystemAgent } from '../../src/im/system-agent.js'
import type { ConversationTurn } from '../../src/im/conversation-memory.js'
import type { StreamChunk, ChatCompletionResponse, ToolCall } from '../../src/protocol/types.js'
import { ProtocolError } from '../../src/protocol/types.js'
import { ShellTerminatedError } from '../../src/shell/gate.js'
import { appendCanonicalTurn, turnToMessage } from '../../src/im/turn.js'
import { estimateTokensDeepSeek } from '../../src/shared/token-estimate.js'

const noopSystemAgent: SystemAgent = {
  run: async () => { throw new Error('noop') },
  stop() {},
  send() {},
}

const echoParams = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } as const

// A scripted stream chat that returns the given sequence of responses, one per call.
// Each "call" yields a series of StreamChunks that produce one ChatCompletionResponse.
const scriptedStreamChat = (responses: ChatCompletionResponse[]): IMLoopOptions['streamChat'] => {
  let i = 0
  return async function* (_url, _request): AsyncIterable<StreamChunk> {
    const r = responses[i++]
    if (!r) {
      // Stream ends with no content.
      return
    }
    // Yield content deltas if any.
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

describe('im/loop', () => {
  describe('happy path: LLM responds with text only', () => {
    it('appends an assistant turn and terminates', async () => {
      const databus = new Databus()
      const conversationMemory = new ConversationMemory()
      const opts = baseOptions({
        databus,
        conversationMemory,
        streamChat: scriptedStreamChat([{
          id: 'r1', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        }]),
      })
      const result: IMLoopResult = await runIMLoop(opts)
      expect(result.terminated).toBe(true)
      expect(result.reason).toBe('completed')
      expect(databus.turns()).toHaveLength(0)
      // v0.27：user 回合同样入 canonical memory（修复"用户输入用一次就丢"）。
      // userTemplate 文本 == 第一轮用户消息，id 前缀 user-。
      expect(conversationMemory.turns()).toHaveLength(2)
      expect(conversationMemory.turns()[0]).toMatchObject({ role: 'user', content: opts.userTemplate })
      expect(conversationMemory.turns()[0]!.id.startsWith('user-')).toBe(true)
      expect(conversationMemory.turns()[1]).toMatchObject({ role: 'assistant', content: 'done' })
    })
  })

  describe('tool call path: LLM calls a tool, then a second turn finishes', () => {
    it('appends assistant tool-call turn, tool-result turn, and final assistant turn', async () => {
      const databus = new Databus()
      const conversationMemory = new ConversationMemory()
      const tc: ToolCall = { id: 'tc-1', type: 'function', function: { name: 'echo', arguments: '{"x":"hi","reason":"verify echo"}' } }
      const opts = baseOptions({
        databus,
        conversationMemory,
        streamChat: scriptedStreamChat([
          {
            id: 'r1', model: 'gpt-4',
            choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [tc] }, finish_reason: 'tool_calls' }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          },
          {
            id: 'r2', model: 'gpt-4',
            choices: [{ index: 0, message: { role: 'assistant', content: 'finished' }, finish_reason: 'stop' }],
            usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
          },
        ]),
      })
      const result = await runIMLoop(opts)
      expect(result.reason).toBe('completed')
      // v0.10.4: conversationMemory is the canonical ordered sequence —
      // it contains user → assistant(tool_calls) → tool → assistant in exact
      // append order（v0.27 起 user 回合也在列：用户输入不再用一次就丢）。
      const cmTurns = conversationMemory.turns()
      expect(cmTurns).toHaveLength(4)
      expect(cmTurns[0]).toMatchObject({ role: 'user', content: opts.userTemplate })
      expect(cmTurns[1]).toMatchObject({ role: 'assistant', toolCalls: [tc] })
      expect(cmTurns[2]).toMatchObject({ role: 'tool', toolCallId: 'tc-1', content: '{"echo":"hi"}' })
      expect(cmTurns[3]).toMatchObject({ role: 'assistant', content: 'finished' })
      // databus is a tool-only projection copy — only the tool turn appears here
      const dbTurns = databus.turns()
      expect(dbTurns).toHaveLength(1)
      expect(dbTurns[0]).toMatchObject({ role: 'tool', toolCallId: 'tc-1', content: '{"echo":"hi"}' })
    })
  })

  describe('guard trip', () => {
    it('terminates with reason "guard-tripped" when shell.call returns hits', async () => {
      // Pre-load the databus with so many tokens that the next call trips the token guard.
      const databus = new Databus()
      const opts = baseOptions({
        databus,
        config: createConfig({ maxTokens: 5 }),
        streamChat: scriptedStreamChat([{
          id: 'r1', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: 'big' }, finish_reason: 'stop' }],
          usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
        }]),
      })
      const result = await runIMLoop(opts)
      expect(result.terminated).toBe(true)
      expect(result.reason).toBe('guard-tripped')
      expect(result.hits.length).toBeGreaterThan(0)
    })
  })

  describe('time guard: last-round blind spot (regression)', () => {
    it('trips the time guard on a SLOW FINAL round, not just before the next round', async () => {
      // A single slow round that answers with plain content (no tool calls)
      // used to return 'completed': shellCall computed hits before the IM
      // applied `advanceElapsed`, and the completed path never re-checked.
      // The IM now re-runs runGuards on the elapsed-updated metrics.
      const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
      const streamChat: IMLoopOptions['streamChat'] = async function* () {
        await sleep(60)  // one round, far past maxElapsedMs
        yield { type: 'content_delta', text: 'slow final answer' }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'done' }
      }
      const opts = baseOptions({
        config: createConfig({ maxElapsedMs: 25 }),
        streamChat,
      })
      const result = await runIMLoop(opts)
      expect(result.reason).toBe('guard-tripped')
      expect(result.hits.some(h => h.id === 'time')).toBe(true)
    })

    it('a fast single round still completes normally', async () => {
      const opts = baseOptions({
        config: createConfig({ maxElapsedMs: 60_000 }),
        streamChat: scriptedStreamChat([{
          id: 'r1', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }]),
      })
      const result = await runIMLoop(opts)
      expect(result.reason).toBe('completed')
    })
  })

  describe('protocol error', () => {
    it('terminates with reason "protocol-error" when streamChat throws', async () => {
      const streamChat: IMLoopOptions['streamChat'] = async function* () {
        throw new ProtocolError(500, 'server error', false)
      }
      const opts = baseOptions({ streamChat })
      const result = await runIMLoop(opts)
      expect(result.reason).toBe('protocol-error')
    })
  })

  describe('shell terminated', () => {
    it('terminates with reason "shell-terminated" when the shell throws ShellTerminatedError', async () => {
      const streamChat: IMLoopOptions['streamChat'] = async function* () {
        throw new ShellTerminatedError('Tripped', [{ id: 'token', reason: 'over' }])
      }
      const opts = baseOptions({ streamChat })
      const result = await runIMLoop(opts)
      expect(result.reason).toBe('shell-terminated')
    })
  })

  describe('state transitions', () => {
    it('keeps the state Running through the loop unless guards trip', async () => {
      const opts = baseOptions({
        streamChat: scriptedStreamChat([{
          id: 'r1', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        }]),
      })
      const result = await runIMLoop(opts)
      expect(result.finalState).toBe('Running')
    })

    it('ends in Tripped state when the guard trips', async () => {
      const opts = baseOptions({
        config: createConfig({ maxTokens: 5 }),
        streamChat: scriptedStreamChat([{
          id: 'r1', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
          usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
        }]),
      })
      const result = await runIMLoop(opts)
      expect(result.finalState).toBe('Tripped')
    })
  })

  describe('max-steps guard', () => {
    it('terminates when the iter guard trips after too many turns', async () => {
      // Each shell call advances stepCount by 1 unconditionally (see
      // shell.call.ts). With maxSteps=2, after 3 calls the iter guard must
      // trip. We deliberately do NOT send a `usage` chunk in the response
      // — this exercises the real-world path where some providers
      // (vllm / ollama / local inference servers) never emit usage, and
      // proves the iter guard is not silently coupled to a usage chunk.
      const alwaysToolCall: ChatCompletionResponse = {
        id: 'r', model: 'gpt-4',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'tc', type: 'function', function: { name: 'echo', arguments: '{"x":"1","reason":"loop"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        // NO usage field.
      }
      const opts = baseOptions({
        config: createConfig({ maxSteps: 2 }),
        streamChat: scriptedStreamChat([alwaysToolCall, alwaysToolCall, alwaysToolCall, alwaysToolCall]),
      })
      const result = await runIMLoop(opts)
      expect(result.reason).toBe('guard-tripped')
      expect(result.hits.some(h => h.id === 'iter')).toBe(true)
    })
  })

  describe('errorRate guard (ADR-014 end-to-end producer chain)', () => {
    // The errorRate guard's producer chain is:
    //   im/loop.ts:executeToolCalls catches per-call throws
    //   -> increments an internal errorCount
    //   -> im/loop.ts calls addToolError(metrics) ONCE PER ROUND (not per
    //      failing call within the round)
    //   -> shell/guards.ts:runGuards reads metrics.consecutiveToolErrors
    //   -> trips when > maxConsecutiveToolErrors (default 10, strict >)
    //
    // The pure-function unit test in tests/shell/guards.test.ts already
    // covers the read side. These tests are the ADR-014 end-to-end pin:
    // they wire a real tool that throws into a real runIMLoop and assert
    // that the counter moves and the guard actually trips the session.

    const failParams = { type: 'object', properties: {}, required: [] } as const

    const toolCallResponse = (id: string): ChatCompletionResponse => ({
      id: 'r', model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name: 'failing', arguments: '{"reason":"test"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    })

    const finalResponse: ChatCompletionResponse = {
      id: 'r', model: 'gpt-4',
      choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
    }

    const makeOptions = (toolResponses: ChatCompletionResponse[], maxConsecutiveToolErrors: number) => {
      const registry = new ToolRegistry()
      registry.registerSystemTool({
        name: 'failing', description: 'always throws', parameters: failParams,
        execute: async () => { throw new Error('boom') },
      })
      return {
        config: createConfig({ maxConsecutiveToolErrors }),
        registry,
        databus: new Databus(),
        conversationMemory: new ConversationMemory(),
        workingAgentId: 'main',
        mailbox: new Mailbox(),
        systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
        stateLine: createNoopStateLine(),
        initialMetrics: createMetrics(),
        streamChat: scriptedStreamChat(toolResponses),
        url: 'https://x',
        model: 'gpt-4',
        systemPrompt: 'SYS',
        userTemplate: 'TEMPLATE',
        systemToolRefs: ['failing'],
        mcpRefs: [],
        skillRefs: [],
      } as IMLoopOptions
    }

    it('trips after enough consecutive error rounds', async () => {
      // 11 tool-call rounds each failing once; the 11th should trip the
      // guard. The default maxConsecutiveToolErrors is 10, strict >.
      const responses = Array.from({ length: 12 }, (_, i) => toolCallResponse(`tc-${i}`))
      responses.push(finalResponse)
      const opts = makeOptions(responses, 10)
      const result = await runIMLoop(opts)
      expect(result.reason).toBe('guard-tripped')
      expect(result.hits.some(h => h.id === 'errorRate')).toBe(true)
    })

    it('does NOT trip when failures alternate with successes (counter resets per round)', async () => {
      // Counter is reset on any successful round (im/loop.ts:
      // `errorCount > 0 ? addToolError : resetToolErrors`). So alternating
      // fail/success never trips, even past 10 rounds. This pins the
      // known-limit noted in src/shell/config.ts.
      const responses: ChatCompletionResponse[] = []
      for (let i = 0; i < 30; i += 1) {
        if (i % 2 === 0) responses.push(toolCallResponse(`tc-fail-${i}`))  // round fails
        else responses.push(finalResponse)                                  // round succeeds, counter resets
        if (i % 2 === 1) responses.push(toolCallResponse(`tc-fail-${i}-b`))  // and we try again, fails again
      }
      // The loop will exit when it sees the finalResponse without tool calls.
      // 30 rounds, none with consecutive errors — never trip.
      const opts = makeOptions(responses, 10)
      const result = await runIMLoop(opts)
      expect(result.reason).not.toBe('guard-tripped')
    })

    it('counts a round with N failing tool calls as ONE error, not N', async () => {
      // The producer chain in im/loop.ts calls addToolError at most once
      // per round, regardless of how many tools in the batch failed. A
      // single round with 5 parallel failing tools is still +1. To prove
      // the count is "1 per round, not N", we set up three rounds that
      // each fail with 5 tools, and require maxConsecutiveToolErrors=2
      // to trip on the third round (3 > 2, strict). If the producer
      // chain were counting per failing call, 5+5+5=15 would trip much
      // earlier; the assertion is on the counter, not the trip point.
      const batchResponse = (idPrefix: string, n: number): ChatCompletionResponse => ({
        id: 'r', model: 'gpt-4',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: Array.from({ length: n }, (_, k) => ({
              id: `${idPrefix}-${k}`,
              type: 'function' as const,
              function: { name: 'failing', arguments: '{"reason":"test"}' },
            })),
          },
          finish_reason: 'tool_calls',
        }],
      })
      const responses = [batchResponse('a', 5), batchResponse('b', 5), batchResponse('c', 5), finalResponse]
      const opts = makeOptions(responses, 2)
      const result = await runIMLoop(opts)
      expect(result.reason).toBe('guard-tripped')
      expect(result.hits.some(h => h.id === 'errorRate')).toBe(true)
    })

    it('WRAPPED tool that throws also trips errorRate (not just raw-throw tools)', async () => {
      // P0 regression: wrapTool used to catch exceptions and return a
      // formatted string, making loop.ts:executeToolCalls' catch block
      // unreachable for every wrapped (production) tool. errorCount stayed
      // 0 and the errorRate guard never tripped on real tool failures.
      // This test wires a wrapTool-wrapped tool that throws, asserting the
      // guard still trips — proving wrapTool now re-throws.
      const responses = Array.from({ length: 12 }, (_, i) => toolCallResponse(`tc-${i}`))
      responses.push(finalResponse)
      const registry = new ToolRegistry()
      registry.registerSystemTool({
        name: 'wrapped_failing', description: 'wrapped tool that throws', parameters: failParams,
        execute: wrapTool('wrapped_failing', async () => {
          throw new Error('wrapped boom')
        }),
      })
      const opts: IMLoopOptions = {
        config: createConfig({ maxConsecutiveToolErrors: 10 }),
        registry,
        databus: new Databus(),
        conversationMemory: new ConversationMemory(),
        workingAgentId: 'main',
        mailbox: new Mailbox(),
        systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
        stateLine: createNoopStateLine(),
        initialMetrics: createMetrics(),
        streamChat: scriptedStreamChat(responses.map(r => {
          // Rewrite tool name from 'failing' to 'wrapped_failing' in each response
          if (r.choices[0]?.message.tool_calls) {
            return {
              ...r,
              choices: [{
                ...r.choices[0],
                message: {
                  ...r.choices[0].message,
                  tool_calls: r.choices[0].message.tool_calls.map(tc => ({
                    ...tc,
                    function: { ...tc.function, name: 'wrapped_failing' },
                  })),
                },
              }],
            }
          }
          return r
        })),
        url: 'https://x',
        model: 'gpt-4',
        systemPrompt: 'SYS',
        userTemplate: 'TEMPLATE',
        systemToolRefs: ['wrapped_failing'],
        mcpRefs: [],
        skillRefs: [],
      }
      const result = await runIMLoop(opts)
      expect(result.reason).toBe('guard-tripped')
      expect(result.hits.some(h => h.id === 'errorRate')).toBe(true)
    })
  })

  describe('v0.10.1a: databus narrowing — turn routing', () => {
    it('assistant turn lands in conversationMemory, tool turn lands in databus', async () => {
      const databus = new Databus()
      const conversationMemory = new ConversationMemory()
      const tc: ToolCall = { id: 'tc-1', type: 'function', function: { name: 'echo', arguments: '{"x":"hi"}' } }
      const opts = baseOptions({
        databus,
        conversationMemory,
        streamChat: scriptedStreamChat([
          {
            id: 'r1', model: 'gpt-4',
            choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [tc] }, finish_reason: 'tool_calls' }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          },
          {
            id: 'r2', model: 'gpt-4',
            choices: [{ index: 0, message: { role: 'assistant', content: 'all done' }, finish_reason: 'stop' }],
            usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
          },
        ]),
      })
      const result = await runIMLoop(opts)
      expect(result.reason).toBe('completed')
      // databus has only tool turns (projection copy)
      const dbTurns = databus.turns()
      expect(dbTurns).toHaveLength(1)
      expect(dbTurns.every(t => t.role === 'tool')).toBe(true)
      expect(dbTurns[0]).toMatchObject({ toolCallId: 'tc-1', sourceAgentId: 'main' })
      // v0.10.4: conversationMemory is the canonical ordered sequence —
      // user → assistant(tool_calls) → tool → assistant, all in exact append
      // order（v0.27 起 user 回合在列）。
      const cmTurns = conversationMemory.turns()
      expect(cmTurns).toHaveLength(4)
      expect(cmTurns[0]).toMatchObject({ role: 'user', content: opts.userTemplate })
      expect(cmTurns[1]).toMatchObject({ role: 'assistant', toolCalls: [tc] })
      expect(cmTurns[2]).toMatchObject({ role: 'tool', toolCallId: 'tc-1' })
      expect(cmTurns[3]).toMatchObject({ role: 'assistant', content: 'all done' })
    })
  })

  describe('v0.10.1c: system agent tools wiring', () => {
    it('end-to-end: working agent can call databus_query (deterministic, no LLM)', async () => {
      // v0.10.3.2 (P5): databus_query now reads directly from ctx.databus
      // instead of delegating to warehouse.run(). This eliminates the
      // infinite recursion where warehouse's toolRefs include databus_query.
      // The tool returns JSON of matching ToolTurn objects.
      const databus = new Databus()
      const conversationMemory = new ConversationMemory()
      const mailbox = new Mailbox()
      const registry = new ToolRegistry()

      // Pre-load the databus with some tool turns so databus_query has data.
      databus.append({
        id: 'pre-1', role: 'tool', toolCallId: 'pre-tc-1',
        content: 'pre-loaded event', sourceAgentId: 'main', at: 100,
      })

      // Register the databus_query tool (no warehouse parameter — reads ctx.databus)
      const { createDatabusQueryTool } = await import('../../src/im/tools/databus-query.js')
      registry.registerSystemTool(createDatabusQueryTool())

      // The working agent's streamChat: first call returns a tool_call
      // for databus_query, second call returns final text.
      const tc: ToolCall = {
        id: 'tc-dq-1',
        type: 'function',
        function: { name: 'databus_query', arguments: '{"reason":"check events"}' },
      }
      const opts: IMLoopOptions = {
        config: createConfig(),
        registry,
        databus,
        conversationMemory,
        workingAgentId: 'main',
        mailbox,
        systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
        stateLine: createNoopStateLine(),
        initialMetrics: createMetrics(),
        streamChat: scriptedStreamChat([
          {
            id: 'r1', model: 'gpt-4',
            choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [tc] }, finish_reason: 'tool_calls' }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          },
          {
            id: 'r2', model: 'gpt-4',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
          },
        ]),
        url: 'https://x',
        model: 'gpt-4',
        systemPrompt: 'SYS',
        userTemplate: 'TEMPLATE',
        systemToolRefs: ['databus_query'],
        mcpRefs: [],
        skillRefs: [],
      }

      const result = await runIMLoop(opts)
      expect(result.reason).toBe('completed')
      // The databus has 2 tool turns: the pre-loaded one + the databus_query result
      const dbTurns = databus.turns()
      expect(dbTurns).toHaveLength(2)
      // The second turn is the databus_query result — it should be JSON containing the pre-loaded event
      expect(dbTurns[1]).toMatchObject({ role: 'tool', toolCallId: 'tc-dq-1' })
      const parsed = JSON.parse(dbTurns[1]!.content)
      expect(parsed).toHaveLength(1)
      expect(parsed[0].id).toBe('pre-1')
    })
  })

  describe('v0.10.2.1: concurrency cap = 2 per round', () => {
    it('executes 4 tool calls in 2 batches (high-water mark ≤ 3, command category)', async () => {
      // v0.10.5: the global cap=2 was replaced by per-category limits
      // (read=5, write/command=3). This tool has no category → defaults to
      // 'command' → cap 3. With 4 calls, the high-water mark must never
      // exceed 3. Register a tool that tracks concurrent in-flight calls;
      // it sleeps briefly so overlaps are observable.
      const registry = new ToolRegistry()
      let inFlight = 0
      let highWater = 0
      const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

      registry.registerSystemTool({
        name: 'slow_echo',
        description: 'slow echo for concurrency test',
        parameters: { type: 'object', properties: { x: { type: 'string' } }, required: [] } as const,
        execute: async (args: unknown) => {
          const a = args as { x?: string; reason?: string }
          inFlight += 1
          if (inFlight > highWater) highWater = inFlight
          await sleep(30)
          inFlight -= 1
          return { echo: a.x ?? 'ok' }
        },
      })

      const databus = new Databus()
      const conversationMemory = new ConversationMemory()
      const tc = (id: string, val: string): ToolCall => ({
        id,
        type: 'function',
        function: { name: 'slow_echo', arguments: JSON.stringify({ x: val, reason: 'concurrency test' }) },
      })

      const opts: IMLoopOptions = {
        config: createConfig({ maxSteps: 5 }),
        registry,
        databus,
        conversationMemory,
        workingAgentId: 'main',
        mailbox: new Mailbox(),
        systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
        stateLine: createNoopStateLine(),
        initialMetrics: createMetrics(),
        streamChat: scriptedStreamChat([
          {
            id: 'r1', model: 'gpt-4',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [tc('tc-1', 'a'), tc('tc-2', 'b'), tc('tc-3', 'c'), tc('tc-4', 'd')],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          },
          {
            id: 'r2', model: 'gpt-4',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
          },
        ]),
        url: 'https://x',
        model: 'gpt-4',
        systemPrompt: 'SYS',
        userTemplate: 'TEMPLATE',
        systemToolRefs: ['slow_echo'],
        mcpRefs: [],
        skillRefs: [],
      }

      const result = await runIMLoop(opts)
      expect(result.reason).toBe('completed')
      // v0.10.5: command-category cap is 3 (was 2). The high-water mark
      // never exceeds 3.
      expect(highWater).toBeLessThanOrEqual(3)
      // All 4 tool results landed in the databus
      const dbTurns = databus.turns()
      expect(dbTurns).toHaveLength(4)
      // Result order matches input order (tc-1 → tc-4)
      expect(dbTurns[0]!.toolCallId).toBe('tc-1')
      expect(dbTurns[1]!.toolCallId).toBe('tc-2')
      expect(dbTurns[2]!.toolCallId).toBe('tc-3')
      expect(dbTurns[3]!.toolCallId).toBe('tc-4')
    })

    it('a round with 1 tool call works normally (no unnecessary batching overhead)', async () => {
      const registry = new ToolRegistry()
      registry.registerSystemTool({
        name: 'simple',
        description: 'simple tool',
        parameters: { type: 'object', properties: {}, required: [] } as const,
        execute: async () => 'ok',
      })

      const tc: ToolCall = {
        id: 'tc-solo',
        type: 'function',
        function: { name: 'simple', arguments: '{"reason":"solo"}' },
      }
      const opts = baseOptions({
        registry,
        systemToolRefs: ['simple'],
        streamChat: scriptedStreamChat([
          {
            id: 'r1', model: 'gpt-4',
            choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [tc] }, finish_reason: 'tool_calls' }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          },
          {
            id: 'r2', model: 'gpt-4',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
          },
        ]),
      })

      const result = await runIMLoop(opts)
      expect(result.reason).toBe('completed')
    })

    it('read-category tools run up to 5 concurrent (high-water mark ≤ 5)', async () => {
      // v0.10.5: read tools get a higher concurrency cap (5). Register a
      // read-category system tool and fire 6 calls — the high-water mark
      // must never exceed 5, and all 6 results must land in input order.
      const registry = new ToolRegistry()
      let inFlight = 0
      let highWater = 0
      const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

      registry.registerSystemTool({
        name: 'slow_read',
        description: 'slow read-only tool',
        parameters: { type: 'object', properties: { x: { type: 'string' } }, required: [] } as const,
        category: 'read',
        execute: async (args: unknown) => {
          const a = args as { x?: string; reason?: string }
          inFlight += 1
          if (inFlight > highWater) highWater = inFlight
          await sleep(30)
          inFlight -= 1
          return { echo: a.x ?? 'ok' }
        },
      })

      const databus = new Databus()
      const conversationMemory = new ConversationMemory()
      const tc = (id: string, val: string): ToolCall => ({
        id,
        type: 'function',
        function: { name: 'slow_read', arguments: JSON.stringify({ x: val, reason: 'read concurrency test' }) },
      })

      const opts: IMLoopOptions = {
        config: createConfig({ maxSteps: 5 }),
        registry,
        databus,
        conversationMemory,
        workingAgentId: 'main',
        mailbox: new Mailbox(),
        systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
        stateLine: createNoopStateLine(),
        initialMetrics: createMetrics(),
        streamChat: scriptedStreamChat([
          {
            id: 'r1', model: 'gpt-4',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [tc('tc-1', 'a'), tc('tc-2', 'b'), tc('tc-3', 'c'), tc('tc-4', 'd'), tc('tc-5', 'e'), tc('tc-6', 'f')],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          },
          {
            id: 'r2', model: 'gpt-4',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
          },
        ]),
        url: 'https://x',
        model: 'gpt-4',
        systemPrompt: 'SYS',
        userTemplate: 'TEMPLATE',
        systemToolRefs: ['slow_read'],
        mcpRefs: [],
        skillRefs: [],
      }

      const result = await runIMLoop(opts)
      expect(result.reason).toBe('completed')
      // read-category cap is 5; 6 calls → batches of 5 + 1. High-water ≤ 5.
      expect(highWater).toBeLessThanOrEqual(5)
      // All 6 tool results landed in the databus in input order.
      const dbTurns = databus.turns()
      expect(dbTurns).toHaveLength(6)
      expect(dbTurns[0]!.toolCallId).toBe('tc-1')
      expect(dbTurns[1]!.toolCallId).toBe('tc-2')
      expect(dbTurns[2]!.toolCallId).toBe('tc-3')
      expect(dbTurns[3]!.toolCallId).toBe('tc-4')
      expect(dbTurns[4]!.toolCallId).toBe('tc-5')
      expect(dbTurns[5]!.toolCallId).toBe('tc-6')
    })

    it('write-category tools run up to 3 concurrent (high-water mark ≤ 3)', async () => {
      // v0.10.5: write tools share the command cap (3). Register a
      // write-category system tool and fire 4 calls — high-water ≤ 3.
      const registry = new ToolRegistry()
      let inFlight = 0
      let highWater = 0
      const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

      registry.registerSystemTool({
        name: 'slow_write',
        description: 'slow write tool',
        parameters: { type: 'object', properties: { x: { type: 'string' } }, required: [] } as const,
        category: 'write',
        execute: async (args: unknown) => {
          const a = args as { x?: string; reason?: string }
          inFlight += 1
          if (inFlight > highWater) highWater = inFlight
          await sleep(30)
          inFlight -= 1
          return { wrote: a.x ?? 'ok' }
        },
      })

      const databus = new Databus()
      const conversationMemory = new ConversationMemory()
      const tc = (id: string, val: string): ToolCall => ({
        id,
        type: 'function',
        function: { name: 'slow_write', arguments: JSON.stringify({ x: val, reason: 'write concurrency test' }) },
      })

      const opts: IMLoopOptions = {
        config: createConfig({ maxSteps: 5 }),
        registry,
        databus,
        conversationMemory,
        workingAgentId: 'main',
        mailbox: new Mailbox(),
        systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
        stateLine: createNoopStateLine(),
        initialMetrics: createMetrics(),
        streamChat: scriptedStreamChat([
          {
            id: 'r1', model: 'gpt-4',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [tc('tc-1', 'a'), tc('tc-2', 'b'), tc('tc-3', 'c'), tc('tc-4', 'd')],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          },
          {
            id: 'r2', model: 'gpt-4',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
          },
        ]),
        url: 'https://x',
        model: 'gpt-4',
        systemPrompt: 'SYS',
        userTemplate: 'TEMPLATE',
        systemToolRefs: ['slow_write'],
        mcpRefs: [],
        skillRefs: [],
      }

      const result = await runIMLoop(opts)
      expect(result.reason).toBe('completed')
      // write-category cap is 3; 4 calls → batches of 3 + 1. High-water ≤ 3.
      expect(highWater).toBeLessThanOrEqual(3)
      const dbTurns = databus.turns()
      expect(dbTurns).toHaveLength(4)
      expect(dbTurns[0]!.toolCallId).toBe('tc-1')
      expect(dbTurns[1]!.toolCallId).toBe('tc-2')
      expect(dbTurns[2]!.toolCallId).toBe('tc-3')
      expect(dbTurns[3]!.toolCallId).toBe('tc-4')
    })

    it('mixed-category batch: read tools finish in their own group, order preserved', async () => {
      // v0.10.5: when a single round has mixed categories, each category
      // runs in its own group with its own cap. Groups run sequentially
      // relative to each other. Results land in input order regardless of
      // which category finished first. Here we interleave read (cap 5) and
      // command (cap 3) calls and assert order preservation.
      const registry = new ToolRegistry()
      const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

      registry.registerSystemTool({
        name: 'r_tool',
        description: 'read tool',
        parameters: { type: 'object', properties: {}, required: [] } as const,
        category: 'read',
        execute: async () => { await sleep(20); return 'r' },
      })
      registry.registerSystemTool({
        name: 'c_tool',
        description: 'command tool',
        parameters: { type: 'object', properties: {}, required: [] } as const,
        // no category → defaults to 'command'
        execute: async () => { await sleep(20); return 'c' },
      })

      const databus = new Databus()
      const conversationMemory = new ConversationMemory()
      const tcR = (id: string): ToolCall => ({
        id, type: 'function',
        function: { name: 'r_tool', arguments: JSON.stringify({ reason: 'mixed-read' }) },
      })
      const tcC = (id: string): ToolCall => ({
        id, type: 'function',
        function: { name: 'c_tool', arguments: JSON.stringify({ reason: 'mixed-cmd' }) },
      })

      const opts: IMLoopOptions = {
        config: createConfig({ maxSteps: 5 }),
        registry,
        databus,
        conversationMemory,
        workingAgentId: 'main',
        mailbox: new Mailbox(),
        systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
        stateLine: createNoopStateLine(),
        initialMetrics: createMetrics(),
        streamChat: scriptedStreamChat([
          {
            id: 'r1', model: 'gpt-4',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                // Interleaved: r, c, r, c, r — order must be preserved in output.
                tool_calls: [tcR('tc-1'), tcC('tc-2'), tcR('tc-3'), tcC('tc-4'), tcR('tc-5')],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          },
          {
            id: 'r2', model: 'gpt-4',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
          },
        ]),
        url: 'https://x',
        model: 'gpt-4',
        systemPrompt: 'SYS',
        userTemplate: 'TEMPLATE',
        systemToolRefs: ['r_tool', 'c_tool'],
        mcpRefs: [],
        skillRefs: [],
      }

      const result = await runIMLoop(opts)
      expect(result.reason).toBe('completed')
      const dbTurns = databus.turns()
      expect(dbTurns).toHaveLength(5)
      // Order matches the LLM's tool_call order, not category-execution order.
      expect(dbTurns[0]!.toolCallId).toBe('tc-1')
      expect(dbTurns[1]!.toolCallId).toBe('tc-2')
      expect(dbTurns[2]!.toolCallId).toBe('tc-3')
      expect(dbTurns[3]!.toolCallId).toBe('tc-4')
      expect(dbTurns[4]!.toolCallId).toBe('tc-5')
    })

    it('v0.20 parallelSafe: arg-safe calls bypass the category cap (all run concurrently)', async () => {
      // ADR-025 T8: a tool declaring parallelSafe runs its safe calls in a
      // dedicated unbounded bucket. Fire 8 calls that the predicate deems safe
      // on a command-category tool (cap 3) — the high-water mark must reach 8,
      // proving the category cap was bypassed.
      const registry = new ToolRegistry()
      let inFlight = 0
      let highWater = 0
      const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

      registry.registerSystemTool({
        name: 'ps_read',
        description: 'command-category tool with parallelSafe predicate',
        parameters: { type: 'object', properties: { x: { type: 'string' } }, required: [] } as const,
        category: 'command',
        parallelSafe: (args) => (args as { mode?: string }).mode === 'safe',
        execute: async (args: unknown) => {
          const a = args as { x?: string }
          inFlight += 1
          if (inFlight > highWater) highWater = inFlight
          await sleep(30)
          inFlight -= 1
          return { echo: a.x ?? 'ok' }
        },
      })

      const databus = new Databus()
      const conversationMemory = new ConversationMemory()
      const tc = (id: string): ToolCall => ({
        id, type: 'function',
        function: { name: 'ps_read', arguments: JSON.stringify({ mode: 'safe', reason: 'ps test' }) },
      })

      const opts: IMLoopOptions = {
        config: createConfig({ maxSteps: 5 }),
        registry,
        databus,
        conversationMemory,
        workingAgentId: 'main',
        mailbox: new Mailbox(),
        systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
        stateLine: createNoopStateLine(),
        initialMetrics: createMetrics(),
        streamChat: scriptedStreamChat([
          {
            id: 'r1', model: 'gpt-4',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: ['tc-1', 'tc-2', 'tc-3', 'tc-4', 'tc-5', 'tc-6', 'tc-7', 'tc-8'].map(tc),
              },
              finish_reason: 'tool_calls',
            }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          },
          {
            id: 'r2', model: 'gpt-4',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
          },
        ]),
        url: 'https://x',
        model: 'gpt-4',
        systemPrompt: 'SYS',
        userTemplate: 'TEMPLATE',
        systemToolRefs: ['ps_read'],
        mcpRefs: [],
        skillRefs: [],
      }

      const result = await runIMLoop(opts)
      expect(result.reason).toBe('completed')
      // 8 parallel-safe calls all ran at once — category cap (3) bypassed.
      expect(highWater).toBe(8)
      // All 8 results landed in input order.
      const dbTurns = databus.turns()
      expect(dbTurns).toHaveLength(8)
      expect(dbTurns.map(t => t.toolCallId)).toEqual(['tc-1', 'tc-2', 'tc-3', 'tc-4', 'tc-5', 'tc-6', 'tc-7', 'tc-8'])
    })

    it('v0.20 parallelSafe: predicate=false or unsafe args falls back to the category bucket', async () => {
      // Same tool, same cap-3 category — but the predicate returns false for
      // mode:'unsafe'. These calls must go through the normal category bucket
      // (high-water ≤ 3), proving parallelSafe is a precise override, not a
      // blanket exemption.
      const registry = new ToolRegistry()
      let inFlight = 0
      let highWater = 0
      const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

      registry.registerSystemTool({
        name: 'ps_mixed',
        description: 'command-category tool, predicate only allows mode=safe',
        parameters: { type: 'object', properties: { x: { type: 'string' } }, required: [] } as const,
        category: 'command',
        parallelSafe: (args) => (args as { mode?: string }).mode === 'safe',
        execute: async (args: unknown) => {
          const a = args as { x?: string }
          inFlight += 1
          if (inFlight > highWater) highWater = inFlight
          await sleep(30)
          inFlight -= 1
          return { echo: a.x ?? 'ok' }
        },
      })

      const databus = new Databus()
      const conversationMemory = new ConversationMemory()
      const tc = (id: string): ToolCall => ({
        id, type: 'function',
        function: { name: 'ps_mixed', arguments: JSON.stringify({ mode: 'unsafe', reason: 'fallback test' }) },
      })

      const opts: IMLoopOptions = {
        config: createConfig({ maxSteps: 5 }),
        registry,
        databus,
        conversationMemory,
        workingAgentId: 'main',
        mailbox: new Mailbox(),
        systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
        stateLine: createNoopStateLine(),
        initialMetrics: createMetrics(),
        streamChat: scriptedStreamChat([
          {
            id: 'r1', model: 'gpt-4',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: ['tc-1', 'tc-2', 'tc-3', 'tc-4', 'tc-5', 'tc-6'].map(tc),
              },
              finish_reason: 'tool_calls',
            }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          },
          {
            id: 'r2', model: 'gpt-4',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
          },
        ]),
        url: 'https://x',
        model: 'gpt-4',
        systemPrompt: 'SYS',
        userTemplate: 'TEMPLATE',
        systemToolRefs: ['ps_mixed'],
        mcpRefs: [],
        skillRefs: [],
      }

      const result = await runIMLoop(opts)
      expect(result.reason).toBe('completed')
      // Predicate returned false → category cap (3) applies; 6 calls → 3 + 3.
      expect(highWater).toBeLessThanOrEqual(3)
      const dbTurns = databus.turns()
      expect(dbTurns).toHaveLength(6)
      expect(dbTurns.map(t => t.toolCallId)).toEqual(['tc-1', 'tc-2', 'tc-3', 'tc-4', 'tc-5', 'tc-6'])
    })

    it('v0.20 parallelSafe: tools without the field behave exactly as before', async () => {
      // Backward-compat: a tool with no parallelSafe never enters the safe
      // bucket, even in bulk. The command-category cap (3) still applies.
      const registry = new ToolRegistry()
      let inFlight = 0
      let highWater = 0
      const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

      registry.registerSystemTool({
        name: 'plain_cmd',
        description: 'no parallelSafe declared',
        parameters: { type: 'object', properties: { x: { type: 'string' } }, required: [] } as const,
        category: 'command',
        execute: async (args: unknown) => {
          const a = args as { x?: string }
          inFlight += 1
          if (inFlight > highWater) highWater = inFlight
          await sleep(30)
          inFlight -= 1
          return { echo: a.x ?? 'ok' }
        },
      })

      const databus = new Databus()
      const conversationMemory = new ConversationMemory()
      const tc = (id: string): ToolCall => ({
        id, type: 'function',
        function: { name: 'plain_cmd', arguments: JSON.stringify({ x: 'v', reason: 'compat test' }) },
      })

      const opts: IMLoopOptions = {
        config: createConfig({ maxSteps: 5 }),
        registry,
        databus,
        conversationMemory,
        workingAgentId: 'main',
        mailbox: new Mailbox(),
        systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
        stateLine: createNoopStateLine(),
        initialMetrics: createMetrics(),
        streamChat: scriptedStreamChat([
          {
            id: 'r1', model: 'gpt-4',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: ['tc-1', 'tc-2', 'tc-3', 'tc-4', 'tc-5'].map(tc),
              },
              finish_reason: 'tool_calls',
            }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          },
          {
            id: 'r2', model: 'gpt-4',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
          },
        ]),
        url: 'https://x',
        model: 'gpt-4',
        systemPrompt: 'SYS',
        userTemplate: 'TEMPLATE',
        systemToolRefs: ['plain_cmd'],
        mcpRefs: [],
        skillRefs: [],
      }

      const result = await runIMLoop(opts)
      expect(result.reason).toBe('completed')
      expect(highWater).toBeLessThanOrEqual(3)
      const dbTurns = databus.turns()
      expect(dbTurns).toHaveLength(5)
      expect(dbTurns.map(t => t.toolCallId)).toEqual(['tc-1', 'tc-2', 'tc-3', 'tc-4', 'tc-5'])
    })
  })

  describe('v0.10.3: context projection e2e', () => {
    it('unread mail hint appears in system prompt', async () => {
      const mailbox = new Mailbox()
      mailbox.send({ from: 'other', to: 'main', subject: 'hello', body: 'world' })
      mailbox.send({ from: 'other', to: 'main', subject: 'hello2', body: 'world2' })

      // Capture the messages sent to streamChat
      let capturedMessages: { role: string; content: string }[] | null = null
      const captureStreamChat: IMLoopOptions['streamChat'] = async function* (_url, request) {
        capturedMessages = request.messages as { role: string; content: string }[]
        yield { type: 'content_delta', text: 'ok' }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'done' }
      }

      const opts = baseOptions({
        mailbox,
        streamChat: captureStreamChat,
      })
      await runIMLoop(opts)
      expect(capturedMessages).not.toBeNull()
      const sysMsg = capturedMessages!.find(m => m.role === 'system')
      expect(sysMsg).toBeDefined()
      expect(sysMsg!.content).toContain('[mailbox] you have 2 unread')
    })

    it('M1 state-line block injected when promptTokens in M1 range', async () => {
      const m1Block: CuratedMemory & { _stamp: string } = {
        task_goal: 'injected M1 goal',
        causal_steps: [{ intent: 'do', tool_action: 'act', result: 'res' }],
        evidence_fragments: [{ source: 's', fragment: 'f', relevance: 'r' }],
        conclusion: 'done',
        next_action: 'next',
        working_state: {
          current_goal: 'goal',
          effective_decisions: ['d1'],
          rejected_decisions: ['d2'],
          architecture_boundaries: ['b1'],
          remaining_work: ['w1'],
        },
        _stamp: 'S-M1-e2e',
      }
      const stubStateLine: StateLine = {
        query: vi.fn((filter: StateLineQueryFilter) => {
          if (filter.layer === 'M1') return [m1Block]
          return []
        }),
        compressor: { async appendBlock() { throw new Error('stub') } },
        warehouse: {
          async appendSummary() { throw new Error('stub') },
          async queryM3() { return { ok: false as const, error: 'stub' } },
        },
        rawArchive: {
          async append() { throw new Error('stub') },
          async query() { return [] },
        },
        subscribe: () => () => {},
        close() {},
      }

      let capturedMessages: { role: string; content: string }[] | null = null
      const captureStreamChat: IMLoopOptions['streamChat'] = async function* (_url, request) {
        capturedMessages = request.messages as { role: string; content: string }[]
        yield { type: 'content_delta', text: 'ok' }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'done' }
      }

      const opts = baseOptions({
        stateLine: stubStateLine,
        // 分层已去上游化：不再看 initialMetrics.promptTokens，改由本地 DeepSeek
        // 加权计数决定。撑大 systemPrompt 把计数推进 M1 band（'x'.repeat(1e6)
        // ≈ 0.3×1e6 = 300K，落在 [200K,500K)）。
        systemPrompt: 'x'.repeat(1_000_000),
        streamChat: captureStreamChat,
      })
      await runIMLoop(opts)
      expect(capturedMessages).not.toBeNull()
      const sysMessages = capturedMessages!.filter(m => m.role === 'system')
      const stateLineContent = sysMessages.find(m => m.content.includes('### M1'))
      expect(stateLineContent).toBeDefined()
      expect(stateLineContent!.content).toContain('injected M1 goal')
      // 验证 state-line system 消息在 userTemplate 之后
      const stateLineIndex = capturedMessages!.findIndex(m => m.role === 'system' && m.content.includes('### M1'))
      const userTemplateIndex = capturedMessages!.findIndex(m => m.role === 'user')
      expect(stateLineIndex).toBeGreaterThan(userTemplateIndex)
      // state-line 应该紧随 userTemplate，中间没有其他消息
      expect(stateLineIndex).toBe(userTemplateIndex + 1)
    })

    it('M2 state-line blocks injected when promptTokens in M2 range', async () => {
      const m1Block: CuratedMemory & { _stamp: string } = {
        task_goal: 'M2 test M1 goal',
        causal_steps: [{ intent: 'do', tool_action: 'act', result: 'res' }],
        evidence_fragments: [{ source: 's', fragment: 'f', relevance: 'r' }],
        conclusion: 'done',
        next_action: 'next',
        working_state: {
          current_goal: 'goal',
          effective_decisions: ['d1'],
          rejected_decisions: ['d2'],
          architecture_boundaries: ['b1'],
          remaining_work: ['w1'],
        },
        _stamp: 'S-M1-001',
      }
      const m2Block: CuratedMemory & { _stamp: string } = {
        task_goal: 'M2 test M2 goal',
        causal_steps: [{ intent: 'do', tool_action: 'act', result: 'res' }],
        evidence_fragments: [{ source: 's', fragment: 'f', relevance: 'r' }],
        conclusion: 'done',
        next_action: 'next',
        working_state: {
          current_goal: 'goal',
          effective_decisions: ['d1'],
          rejected_decisions: ['d2'],
          architecture_boundaries: ['b1'],
          remaining_work: ['w1'],
        },
        _stamp: 'S-M2-001',
      }
      const stubStateLine: StateLine = {
        query: vi.fn((filter: StateLineQueryFilter) => {
          if (filter.layer === 'M1') return [m1Block]
          if (filter.layer === 'M2') return [m2Block]
          return []
        }),
        compressor: { async appendBlock() { throw new Error('stub') } },
        warehouse: {
          async appendSummary() { throw new Error('stub') },
          async queryM3() { return { ok: false as const, error: 'stub' } },
        },
        rawArchive: {
          async append() { throw new Error('stub') },
          async query() { return [] },
        },
        subscribe: () => () => {},
        close() {},
      }

      let capturedMessages: { role: string; content: string }[] | null = null
      const captureStreamChat: IMLoopOptions['streamChat'] = async function* (_url, request) {
        capturedMessages = request.messages as { role: string; content: string }[]
        yield { type: 'content_delta', text: 'ok' }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'done' }
      }

      const opts = baseOptions({
        stateLine: stubStateLine,
        // 本地 DeepSeek 计数驱动分层：'x'.repeat(2.2e6) ≈ 660K，落在 M2 [500K,900K)。
        systemPrompt: 'x'.repeat(2_200_000),
        streamChat: captureStreamChat,
      })
      await runIMLoop(opts)
      expect(capturedMessages).not.toBeNull()
      // 验证同时包含 ### M1 和 ### M2
      const sysMessages = capturedMessages!.filter(m => m.role === 'system')
      const m1Content = sysMessages.find(m => m.content.includes('### M1'))
      const m2Content = sysMessages.find(m => m.content.includes('### M2'))
      expect(m1Content).toBeDefined()
      expect(m2Content).toBeDefined()
      expect(m1Content!.content).toContain('M2 test M1 goal')
      expect(m2Content!.content).toContain('M2 test M2 goal')
      // 验证 state-line 消息位置在 userTemplate 之后
      const userTemplateIndex = capturedMessages!.findIndex(m => m.role === 'user')
      const stateLineIndex = capturedMessages!.findIndex(m =>
        m.role === 'system' && (m.content.includes('### M1') || m.content.includes('### M2')),
      )
      expect(stateLineIndex).toBeGreaterThan(userTemplateIndex)
      expect(stateLineIndex).toBe(userTemplateIndex + 1)
    })

    it('M3 overflow suffix added when promptTokens in M3 range, no state-line blocks', async () => {
      let capturedMessages: { role: string; content: string }[] | null = null
      const captureStreamChat: IMLoopOptions['streamChat'] = async function* (_url, request) {
        capturedMessages = request.messages as { role: string; content: string }[]
        yield { type: 'content_delta', text: 'ok' }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'done' }
      }

      const opts = baseOptions({
        // 本地 DeepSeek 计数驱动分层：'x'.repeat(3.4e6) ≈ 1.02M，落在 M3 [900K,∞)。
        systemPrompt: 'x'.repeat(3_400_000),
        streamChat: captureStreamChat,
      })
      await runIMLoop(opts)
      expect(capturedMessages).not.toBeNull()
      const sysMsg = capturedMessages!.find(m => m.role === 'system')
      expect(sysMsg).toBeDefined()
      expect(sysMsg!.content).toContain('[context overflow]')
      // No state-line blocks at M3
      const hasStateLine = capturedMessages!.some(m =>
        m.role === 'system' && (m.content.includes('### M1') || m.content.includes('### M2')),
      )
      expect(hasStateLine).toBe(false)
    })

    it('P4: 分层用本地 DeepSeek 计数，与 provider usage 解耦', async () => {
      // 修复核心回归（2026-09-16）：层判定不再读 usage.promptTokens——relay 在
      // prompt 缓存命中时低报 usage，旧逻辑会把内存层钉死在 M1、M3 持续压缩永不
      // 启动。本测试让本地计数落在 M1（systemPrompt 撑到 ~300K），同时 mock usage
      // 报 950K（若仍用 usage 会判成 M3）。断言投影是 M1（注入 M1 块、无 M3
      // overflow 后缀），证明分层只认本地计数、与上游 usage 完全解耦。
      const m1Block: CuratedMemory & { _stamp: string } = {
        task_goal: 'P4 M1 goal',
        causal_steps: [{ intent: 'do', tool_action: 'act', result: 'res' }],
        evidence_fragments: [{ source: 's', fragment: 'f', relevance: 'r' }],
        conclusion: 'done',
        next_action: 'next',
        working_state: {
          current_goal: 'goal',
          effective_decisions: ['d1'],
          rejected_decisions: ['d2'],
          architecture_boundaries: ['b1'],
          remaining_work: ['w1'],
        },
        _stamp: 'S-P4-M1',
      }
      const stubStateLine: StateLine = {
        query: vi.fn((filter: StateLineQueryFilter) => {
          if (filter.layer === 'M1') return [m1Block]
          return []
        }),
        compressor: { async appendBlock() { throw new Error('stub') } },
        warehouse: {
          async appendSummary() { throw new Error('stub') },
          async queryM3() { return { ok: false as const, error: 'stub' } },
        },
        rawArchive: {
          async append() { throw new Error('stub') },
          async query() { return [] },
        },
        subscribe: () => () => {},
        close() {},
      }

      let capturedMessages: { role: string; content: string }[] | null = null
      const captureStreamChat: IMLoopOptions['streamChat'] = async function* (_url, request) {
        capturedMessages = request.messages as { role: string; content: string }[]
        yield { type: 'content_delta', text: 'done' }
        yield { type: 'finish', reason: 'stop' }
        // usage 报 950K（M3 量级）——若分层仍读 usage 会判成 M3。
        yield { type: 'usage', usage: { promptTokens: 950_000, completionTokens: 5, totalTokens: 950_005 } }
        yield { type: 'done' }
      }

      const opts = baseOptions({
        stateLine: stubStateLine,
        systemPrompt: 'x'.repeat(1_000_000), // 本地 DeepSeek 计数 ~300K → M1
        streamChat: captureStreamChat,
      })
      await runIMLoop(opts)
      expect(capturedMessages).not.toBeNull()
      const hasM1 = capturedMessages!.some(m => m.role === 'system' && m.content.includes('### M1'))
      const hasOverflow = capturedMessages!.some(m => m.role === 'system' && m.content.includes('[context overflow]'))
      expect(hasM1).toBe(true)        // 本地计数 M1 → 注入 M1 块
      expect(hasOverflow).toBe(false) // usage 950K 被无视 → 没有判成 M3
    })
  })

  describe('v0.10.4: canonical ordering regression', () => {
    it('multi-step tool flow preserves exact protocol order in streamChat request', async () => {
      // Plan §5.10 item 4: capture the request passed to streamChat after a
      // multi-step tool flow and assert exact protocol order
      // user -> assistant(tool_calls) -> tool -> assistant.
      // Assert every tool appears once in canonical memory and once in Databus projection.
      const databus = new Databus()
      const conversationMemory = new ConversationMemory()
      const tc: ToolCall = { id: 'tc-1', type: 'function', function: { name: 'echo', arguments: '{"x":"hi","reason":"verify"}' } }

      // Capture messages from round 2 (after the tool call round).
      let round2Messages: any[] | null = null
      let callCount = 0
      const captureStreamChat: IMLoopOptions['streamChat'] = async function* (_url, request) {
        callCount += 1
        if (callCount === 2) {
          round2Messages = request.messages as any[]
        }
        if (callCount === 1) {
          yield { type: 'tool_call_delta', index: 0, id: tc.id, name: tc.function.name }
          yield { type: 'tool_call_delta', index: 0, arguments_delta: tc.function.arguments }
          yield { type: 'finish', reason: 'tool_calls' }
          yield { type: 'usage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
          yield { type: 'done' }
          return
        }
        yield { type: 'content_delta', text: 'all done' }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'usage', usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } }
        yield { type: 'done' }
      }

      const opts = baseOptions({
        databus,
        conversationMemory,
        streamChat: captureStreamChat,
      })
      const result = await runIMLoop(opts)
      expect(result.reason).toBe('completed')

      // Canonical memory has 4 turns: user → assistant(tool_calls) → tool →
      // assistant（v0.27 起 user 回合在列）。
      const cmTurns = conversationMemory.turns()
      expect(cmTurns).toHaveLength(4)
      expect(cmTurns[0]).toMatchObject({ role: 'user', content: opts.userTemplate })
      expect(cmTurns[1]).toMatchObject({ role: 'assistant', toolCalls: [tc] })
      expect(cmTurns[2]).toMatchObject({ role: 'tool', toolCallId: 'tc-1' })
      expect(cmTurns[3]).toMatchObject({ role: 'assistant', content: 'all done' })

      // Databus projection has exactly 1 tool turn
      const dbTurns = databus.turns()
      expect(dbTurns).toHaveLength(1)
      expect(dbTurns[0]).toMatchObject({ role: 'tool', toolCallId: 'tc-1', sourceAgentId: 'main' })

      // The round-2 protocol request must preserve the protocol-safe order:
      // ... user → assistant(tool_calls) → tool → (当前用户文本作为最后一个
      // canonical 回合；userTemplate part 被去重跳过——v0.27)。
      // The request sent to streamChat in round 2 contains the conversation
      // turns from canonical memory (user + assistant(tool_calls) + tool).
      expect(round2Messages).not.toBeNull()
      const msgRoles = round2Messages!.map(m => m.role)
      // Find the assistant with tool_calls followed by tool
      const assistantToolCallsIdx = msgRoles.findIndex(r => r === 'assistant')
      expect(assistantToolCallsIdx).toBeGreaterThanOrEqual(0)
      // The message right after assistant(tool_calls) must be 'tool'
      expect(msgRoles[assistantToolCallsIdx + 1]).toBe('tool')
      // The tool message's tool_call_id must match
      const toolMsg = round2Messages!.find(m => m.role === 'tool')
      expect(toolMsg).toBeDefined()
      expect(toolMsg!.tool_call_id).toBe('tc-1')
      // No duplicate tool messages in the request
      const toolMsgCount = round2Messages!.filter(m => m.role === 'tool').length
      expect(toolMsgCount).toBe(1)
    })
  })

  describe('round-1 context estimate = 本地 DeepSeek 计数', () => {
    it('喂给 coordinator 的是 canonical 的本地计数（非 provider usage），且 Databus 副本不被双计', async () => {
      const databus = new Databus()
      const conversationMemory = new ConversationMemory()

      // Seed a prior exchange: user -> assistant(tool_calls) -> tool result.
      // appendCanonicalTurn mirrors the tool turn into the Databus projection,
      // which is exactly the duplication the estimate must not count twice.
      appendCanonicalTurn(conversationMemory, databus, {
        id: 'user-seed', role: 'user', content: 'do the thing', at: 1,
      })
      appendCanonicalTurn(conversationMemory, databus, {
        id: 'assistant-seed', role: 'assistant', content: null, at: 2,
        toolCalls: [{ id: 'tc-seed', type: 'function', function: { name: 'echo', arguments: '{}' } }],
      })
      appendCanonicalTurn(conversationMemory, databus, {
        id: 'tool-seed', role: 'tool', toolCallId: 'tc-seed',
        content: 'seeded tool result', sourceAgentId: 'main', at: 3,
      })
      expect(databus.turns()).toHaveLength(1)

      // 期望的轮-1 本地计数 = DeepSeek 估算（systemPrompt + canonical wire 形态）。
      // canonical 在轮 1 = 3 个 seed 回合 + loop 入口落下的 userTemplate u1（去重，
      // 只经 u1 计一次）。估算只读 conversationMemory——databus 里的 tool-seed 副本
      // 不计入；若双计，captured[0] 会显著大于 expected1。
      const seedTurns = [...conversationMemory.turns()]
      const u1: ConversationTurn = { id: 'user-t', role: 'user', content: 'TEMPLATE', at: 4 }
      const expected1 = estimateTokensDeepSeek(
        'SYS' + [...seedTurns, u1].map(t => JSON.stringify(turnToMessage(t))).join(''),
      )

      // Probe coordinator captures the contextTokens the loop computes each round.
      const captured: number[] = []
      const probeCoordinator = {
        async tick(snapshot: { contextTokens: number }) { captured.push(snapshot.contextTokens) },
        nextEligibleBlock: () => undefined,
        stop() {},
        async drain() {},
      }

      const tc: ToolCall = { id: 'tc-1', type: 'function', function: { name: 'echo', arguments: '{"x":"hi","reason":"verify estimate"}' } }
      const opts = baseOptions({
        databus,
        conversationMemory,
        driveCoordinator: probeCoordinator,
        streamChat: scriptedStreamChat([
          {
            id: 'r1', model: 'gpt-4',
            choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [tc] }, finish_reason: 'tool_calls' }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          },
          {
            id: 'r2', model: 'gpt-4',
            choices: [{ index: 0, message: { role: 'assistant', content: 'finished' }, finish_reason: 'stop' }],
            usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
          },
        ]),
      })
      delete opts.initialMetrics

      const result = await runIMLoop(opts)
      expect(result.reason).toBe('completed')

      // 每轮 finalize 后 fire 一次；喂值 = 本地 DeepSeek 计数（去上游化，2026-09-16），
      // **不再是 provider usage [10,20]**。轮 1 精确等于 canonical-only 的本地估算
      // （证明 databus 副本未双计），轮 2 canonical 增长 → 计数更大。
      expect(captured).toHaveLength(2)
      expect(captured).not.toEqual([10, 20])
      expect(captured[0]).toBe(expected1)
      expect(captured[1]!).toBeGreaterThan(captured[0]!)
    })

    it('v0.30 B3: falls back to the wire-format estimate when the provider reports no usage', async () => {
      const conversationMemory = new ConversationMemory()
      appendCanonicalTurn(conversationMemory, new Databus(), {
        id: 'user-seed', role: 'user', content: 'do the thing', at: 1,
      })
      const captured: number[] = []
      const probeCoordinator = {
        async tick(snapshot: { contextTokens: number }) { captured.push(snapshot.contextTokens) },
        nextEligibleBlock: () => undefined,
        stop() {},
        async drain() {},
      }
      const opts = baseOptions({
        conversationMemory,
        driveCoordinator: probeCoordinator,
        // 无 usage 的 provider（ollama/vllm 类）：metrics.lastRequestTokens 走
        // call.ts 的 wire-format 估算（JSON.stringify(request.messages).length / 4）。
        streamChat: scriptedStreamChat([
          {
            id: 'r1', model: 'gpt-4',
            choices: [{ index: 0, message: { role: 'assistant', content: 'finished' }, finish_reason: 'stop' }],
          },
        ]),
      })
      delete opts.initialMetrics
      const result = await runIMLoop(opts)
      expect(result.reason).toBe('completed')
      expect(captured).toHaveLength(1)
      expect(captured[0]!).toBeGreaterThan(0)
    })
  })

  describe('v0.27: user turn enters canonical history + persists', () => {
    it('multi-round run: user text appears exactly once per request; canonical + persisted turns include the user turn', async () => {
      const databus = new Databus()
      const conversationMemory = new ConversationMemory()
      const persisted: ConversationTurn[] = []

      // Record how many times the user text appears in each round's request.
      const userTextCounts: number[] = []
      const requestRoles: string[][] = []
      const tc: ToolCall = { id: 'tc-1', type: 'function', function: { name: 'echo', arguments: '{"x":"1"}' } }
      const spyStreamChat: IMLoopOptions['streamChat'] = async function* (_url, request) {
        const msgs = request.messages
        requestRoles.push(msgs.map(m => m.role))
        userTextCounts.push(msgs.filter(m => m.role === 'user' && m.content === 'DO THE TASK').length)
        const r = userTextCounts.length === 1
          ? { id: 'r1', model: 'gpt-4', choices: [{ index: 0, message: { role: 'assistant' as const, content: null, tool_calls: [tc] }, finish_reason: 'tool_calls' as const }] }
          : { id: 'r2', model: 'gpt-4', choices: [{ index: 0, message: { role: 'assistant' as const, content: 'finished' }, finish_reason: 'stop' as const }] }
        const msg = r.choices[0]!.message
        if (typeof msg.content === 'string' && msg.content.length > 0) yield { type: 'content_delta', text: msg.content }
        if ('tool_calls' in msg && msg.tool_calls) {
          for (let k = 0; k < msg.tool_calls.length; k += 1) {
            yield { type: 'tool_call_delta', index: k, id: msg.tool_calls[k]!.id, name: msg.tool_calls[k]!.function.name }
            yield { type: 'tool_call_delta', index: k, arguments_delta: msg.tool_calls[k]!.function.arguments }
          }
        }
        yield { type: 'finish', reason: r.choices[0]!.finish_reason }
        yield { type: 'done' }
      }

      const opts = baseOptions({
        databus,
        conversationMemory,
        userTemplate: 'DO THE TASK',
        persistTurn: async (t) => { persisted.push(t) },
        streamChat: spyStreamChat,
      })

      const result = await runIMLoop(opts)
      expect(result.reason).toBe('completed')

      // Both rounds saw the user text exactly once (not zero, not duplicated
      // by history-u1 + trailing template part).
      expect(userTextCounts).toEqual([1, 1])
      // Round 1: user is the last message (entry-appended u1, template part
      // omitted). Round 2: history carries u1 mid-conversation; no trailing
      // duplicate user message after the tool result.
      expect(requestRoles[0]!.at(-1)).toBe('user')
      expect(requestRoles[1]!.at(-1)).toBe('tool')
      expect(requestRoles[1]!.filter(r => r === 'user')).toHaveLength(1)

      // Canonical memory and the persisted journal both carry the user turn.
      const memUser = conversationMemory.turns().filter(t => t.role === 'user')
      expect(memUser).toHaveLength(1)
      expect(memUser[0]!.content).toBe('DO THE TASK')
      expect(persisted.some(t => t.role === 'user' && t.content === 'DO THE TASK')).toBe(true)
      // Databus projection stays tool-only (user/assistant never enter it) —
      // here exactly the one tc-1 tool turn, nothing else.
      expect(databus.turns().map(t => t.toolCallId)).toEqual(['tc-1'])
    })
  })

  describe('v0.12.4: fire-and-forget driveCoordinator.tick — loop does not block on compression', () => {
    it('loop returns before the background tick completes (not awaited)', async () => {
      // The drive coordinator's tick is fire-and-forget (void, not awaited).
      // The working agent never blocks on background compression. We prove
      // this with a tick mock whose returned promise is gated on a deferred
      // we control: if the loop awaited tick, runIMLoop would hang until we
      // resolve the deferred. Instead the loop completes immediately.
      const conv = new ConversationMemory()
      const databus = new Databus()
      const mailbox = new Mailbox()

      // Seed one complete task block + a boundary user turn so the loop has
      // turns to work with.
      const tc1: ToolCall = { id: 'tc-seed-1', type: 'function', function: { name: 'echo', arguments: '{}' } }
      appendCanonicalTurn(conv, databus, { id: 'seed-u1', role: 'user', content: 'u1', at: 1 })
      appendCanonicalTurn(conv, databus, { id: 'seed-a1', role: 'assistant', content: null, at: 2, toolCalls: [tc1] })
      appendCanonicalTurn(conv, databus, { id: 'seed-t1', role: 'tool', toolCallId: 'tc-seed-1', content: 'r1', sourceAgentId: 'main', at: 3 })
      appendCanonicalTurn(conv, databus, { id: 'seed-a2', role: 'assistant', content: 'a2', at: 4 })
      appendCanonicalTurn(conv, databus, { id: 'seed-u2', role: 'user', content: 'u2', at: 5 })

      let tickStarted = false
      let tickResolve: (() => void) | null = null
      // A tick promise that never resolves on its own — gated on tickResolve.
      const hangingTick = new Promise<void>((resolve) => { tickResolve = resolve })
      const hangingCoordinator = {
        async tick() {
          tickStarted = true
          await hangingTick
        },
        nextEligibleBlock: () => undefined,
        stop() {},
        async drain() {},
      }

      const registry = new ToolRegistry()
      registry.registerSystemTool({
        name: 'echo', description: 'echo', parameters: { type: 'object', properties: { x: { type: 'string' } }, required: [] } as const,
        execute: async (args) => ({ echo: (args as { x?: string }).x ?? 'ok' }),
      })

      let callCount = 0
      const captureStreamChat: IMLoopOptions['streamChat'] = async function* (_url, _request) {
        callCount += 1
        if (callCount === 1) {
          yield { type: 'tool_call_delta', index: 0, id: 'tc-live-1', name: 'echo' }
          yield { type: 'tool_call_delta', index: 0, arguments_delta: '{"x":"live","reason":"trigger tick"}' }
          yield { type: 'finish', reason: 'tool_calls' }
          yield { type: 'usage', usage: { promptTokens: 250_000, completionTokens: 5, totalTokens: 250_005 } }
          yield { type: 'done' }
          return
        }
        yield { type: 'content_delta', text: 'done' }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'done' }
      }

      const opts: IMLoopOptions = {
        config: createConfig(),
        registry,
        databus,
        conversationMemory: conv,
        workingAgentId: 'main',
        mailbox,
        systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
        stateLine: createNoopStateLine(),
        driveCoordinator: hangingCoordinator,
        initialMetrics: { ...createMetrics(), promptTokens: 250_000 },
        streamChat: captureStreamChat,
        url: 'https://x',
        model: 'gpt-4',
        systemPrompt: 'SYS',
        userTemplate: 'TEMPLATE',
        systemToolRefs: ['echo'],
        mcpRefs: [],
        skillRefs: [],
      }

      // If the loop awaited tick, this await would hang (hangingTick never
      // resolves on its own). The loop must complete first.
      const result = await runIMLoop(opts)
      expect(result.reason).toBe('completed')

      // The tick was dispatched (fire-and-forget) but has not completed.
      expect(tickStarted).toBe(true)

      // Now release the hanging tick so the process can exit cleanly.
      tickResolve!()

      // Await the hanging tick to avoid unhandled-rejection noise.
      await hangingTick
    })
  })

  // ---------- v0.10.6: text-skill pre-injection (injectTextSkills) ----------

  describe('v0.10.6: text-skill pre-injection into the system prompt', () => {
    it('default (injectTextSkills unset): text skill body appears in the system message', async () => {
      // The loop emits skillText parts from registry.getTextSkills() by default.
      // compose appends each body to the system message. We capture the request
      // to verify the body landed in messages[0].content (the system message).
      const registry = new ToolRegistry()
      registry.registerSystemTool({
        name: 'echo', description: 'echo', parameters: echoParams,
        execute: async (args) => ({ echo: (args as { x: string }).x }),
      })
      registry.registerTextSkill('style-guide', '每行不超过 12 字', '用户要求写诗时')

      let capturedRequest: { messages?: unknown[] } | null = null
      const captureStreamChat: IMLoopOptions['streamChat'] = async function* (_url, request) {
        capturedRequest = request
        yield { type: 'content_delta', text: 'done' }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'usage', usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 } }
        yield { type: 'done' }
      }

      const opts: IMLoopOptions = {
        ...baseOptions({ registry, streamChat: captureStreamChat }),
        // injectTextSkills deliberately NOT set — defaults to true.
      }
      const result = await runIMLoop(opts)
      expect(result.reason).toBe('completed')

      // The system message (messages[0]) must contain both the base system
      // prompt AND the injected skill body + when_to_use comment.
      const msgs = (capturedRequest as unknown as { messages: Array<{ role: string; content: string }> }).messages
    })

    it('injectTextSkills: false omits text skill body from the system message', async () => {
      // System agents (warehouse/compressor/recall) set injectTextSkills:false
      // so they never receive user skill content. Verify the body is absent.
      const registry = new ToolRegistry()
      registry.registerSystemTool({
        name: 'echo', description: 'echo', parameters: echoParams,
        execute: async (args) => ({ echo: (args as { x: string }).x }),
      })
      registry.registerTextSkill('style-guide', 'SECRET USER CONTENT')

      let capturedRequest: { messages?: unknown[] } | null = null
      const captureStreamChat: IMLoopOptions['streamChat'] = async function* (_url, request) {
        capturedRequest = request
        yield { type: 'content_delta', text: 'done' }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'usage', usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 } }
        yield { type: 'done' }
      }

      const opts: IMLoopOptions = {
        ...baseOptions({ registry, streamChat: captureStreamChat }),
        injectTextSkills: false,
      }
      const result = await runIMLoop(opts)
      expect(result.reason).toBe('completed')

      const msgs = (capturedRequest as unknown as { messages: Array<{ role: string; content: string }> }).messages
      expect(msgs[0]!.role).toBe('system')
      expect(msgs[0]!.content).toBe('SYS')
      expect(msgs[0]!.content).not.toContain('SECRET USER CONTENT')
    })

    it('text skill without when_to_use injects body without a comment prefix', async () => {
      const registry = new ToolRegistry()
      registry.registerSystemTool({
        name: 'echo', description: 'echo', parameters: echoParams,
        execute: async (args) => ({ echo: (args as { x: string }).x }),
      })
      registry.registerTextSkill('plain-guide', 'plain body text')

      let capturedRequest: { messages?: unknown[] } | null = null
      const captureStreamChat: IMLoopOptions['streamChat'] = async function* (_url, request) {
        capturedRequest = request
        yield { type: 'content_delta', text: 'done' }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'usage', usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 } }
        yield { type: 'done' }
      }

      const opts: IMLoopOptions = {
        ...baseOptions({ registry, streamChat: captureStreamChat }),
      }
      await runIMLoop(opts)

      const msgs = (capturedRequest as unknown as { messages: Array<{ role: string; content: string }> }).messages
      expect(msgs[0]!.content).toContain('plain body text')
      expect(msgs[0]!.content).not.toContain('when_to_use')
    })
  })
})
