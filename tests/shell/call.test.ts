import { describe, it, expect } from 'vitest'
import { shellCall, type ShellDeps } from '../../src/shell/call.js'
import { ToolRegistry } from '../../src/shell/registry.js'
import { createConfig, type ShellConfig } from '../../src/shell/config.js'
import { createMetrics, type Metrics } from '../../src/shell/metrics.js'
import type { FinalPrompt } from '../../src/shell/compose.js'
import type { StreamChunk } from '../../src/protocol/types.js'
import { ProtocolError } from '../../src/protocol/types.js'
import type { State } from '../../src/shell/state.js'
import { ShellTerminatedError } from '../../src/shell/gate.js'
import { runGuards } from '../../src/shell/guards.js'
import { compose } from '../../src/shell/compose.js'

const fakeStreamChat = (chunks: StreamChunk[]) =>
  async function* (
    _url: string,
    _request: { model: string; messages: FinalPrompt['messages']; tools?: FinalPrompt['tools'] },
  ): AsyncIterable<StreamChunk> {
    for (const c of chunks) yield c
  }

const echoParams = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } as const

const setup = (overrides: Partial<{
  initialMetrics: Partial<Metrics>
  config: Partial<ShellConfig>
  state: State
  streamChat: ShellDeps['streamChat']
}> = {}): { deps: ShellDeps; request: FinalPrompt } => {
  const registry = new ToolRegistry()
  registry.registerSystemTool({ name: 'echo', description: 'echo', parameters: echoParams, execute: async (a) => a })

  const config = createConfig(overrides.config ?? {})
  const initialMetrics = { ...createMetrics(), ...overrides.initialMetrics }
  const streamChat = overrides.streamChat ?? fakeStreamChat([
    { type: 'content_delta', text: 'Hello ' },
    { type: 'content_delta', text: 'world' },
    { type: 'finish', reason: 'stop' },
    { type: 'usage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    { type: 'done' },
  ])

  const deps: ShellDeps = {
    config,
    registry,
    state: overrides.state ?? 'Running',
    metrics: initialMetrics,
    streamChat,
    url: 'https://api.example.com/v1/chat/completions',
    model: 'gpt-4',
  }
  const request: FinalPrompt = compose(registry, [
    { type: 'system', content: 'SYS' },
    { type: 'userTemplate', content: 'hi' },
  ])
  return { deps, request }
}

describe('shell/call', () => {
  describe('happy path', () => {
    it('aggregates content from content_deltas into a ChatCompletionResponse', async () => {
      const { deps, request } = setup()
      const result = await shellCall(deps, request)
      expect(result.response.choices[0]?.message.content).toBe('Hello world')
      expect(result.response.choices[0]?.finish_reason).toBe('stop')
    })

    it('returns the updated metrics with the call\'s usage added', async () => {
      const { deps, request } = setup()
      const result = await shellCall(deps, request)
      expect(result.updatedMetrics.totalTokens).toBe(15)
      expect(result.updatedMetrics.promptTokens).toBe(10)
      expect(result.updatedMetrics.completionTokens).toBe(5)
      expect(result.updatedMetrics.stepCount).toBe(1)
    })

    it('returns the usage in the response', async () => {
      const { deps, request } = setup()
      const result = await shellCall(deps, request)
      expect(result.response.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })
    })

    it('aggregates tool_calls from tool_call_deltas', async () => {
      const streamChat = fakeStreamChat([
        { type: 'content_delta', text: 'I will read that file.' },
        { type: 'tool_call_delta', index: 0, id: 'tc-1', name: 'echo' },
        { type: 'tool_call_delta', index: 0, arguments_delta: '{"x":"hi"}' },
        { type: 'finish', reason: 'tool_calls' },
        { type: 'usage', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } },
        { type: 'done' },
      ])
      const { deps, request } = setup({ streamChat })
      const result = await shellCall(deps, request)
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0]?.function.name).toBe('echo')
      expect(result.toolCalls[0]?.function.arguments).toBe('{"x":"hi"}')
      expect(result.response.choices[0]?.finish_reason).toBe('tool_calls')
    })

    it('returns no tool_calls when the model responds with content only', async () => {
      const { deps, request } = setup()
      const result = await shellCall(deps, request)
      expect(result.toolCalls).toEqual([])
    })
  })

  describe('step counting without usage', () => {
    it('advances stepCount by 1 even when the response has no usage chunk', async () => {
      // A real-world provider (vllm / ollama) may never emit a usage
      // chunk. The `iter` guard is `stepCount > maxSteps`, so it must
      // still trip after enough rounds. This test pins the contract.
      const streamChat: ShellDeps['streamChat'] = async function* () {
        yield { type: 'content_delta', text: 'no-usage world' }
        yield { type: 'finish', reason: 'stop' }
        // No 'usage' chunk.
        yield { type: 'done' }
      }
      const { deps, request } = setup({ streamChat })
      const result = await shellCall(deps, request)
      expect(result.updatedMetrics.stepCount).toBe(1)
      expect(result.updatedMetrics.totalTokens).toBe(0)
    })

    it('does not advance stepCount when the gate short-circuits the call', async () => {
      // Tripped/Dead state must NOT consume a step — the loop should
      // terminate before the wire is touched. (We assert `called === false`
      // to prove the protocol was never reached, and the rejection to
      // prove the gate fired.)
      let called = false
      const streamChat: ShellDeps['streamChat'] = async function* () {
        called = true
        yield { type: 'done' }
      }
      const { deps, request } = setup({ state: 'Tripped', streamChat })
      const before = { ...deps.metrics }
      await expect(shellCall(deps, request)).rejects.toBeInstanceOf(ShellTerminatedError)
      expect(called).toBe(false)
      // The metrics object held by deps is unchanged (the function threw
      // before mutating anything). We do NOT use `toBe` here because
      // `setup` may spread a fresh object from `createMetrics()`; we
      // compare by value.
      expect(deps.metrics).toEqual(before)
    })
  })

  describe('gate', () => {
    it('throws ShellTerminatedError without calling protocol when state is Tripped', async () => {
      let called = false
      const streamChat: ShellDeps['streamChat'] = async function* () {
        called = true
        yield { type: 'done' }
      }
      const { deps, request } = setup({ state: 'Tripped', streamChat })
      await expect(shellCall(deps, request)).rejects.toBeInstanceOf(ShellTerminatedError)
      expect(called).toBe(false)
    })

    it('throws ShellTerminatedError without calling protocol when state is Tripped', async () => {
      let called = false
      const streamChat: ShellDeps['streamChat'] = async function* () {
        called = true
        yield { type: 'done' }
      }
      const { deps, request } = setup({ state: 'Tripped', streamChat })
      await expect(shellCall(deps, request)).rejects.toBeInstanceOf(ShellTerminatedError)
      expect(called).toBe(false)
    })
  })

  describe('metrics returned after the call (guards are evaluated by the IM)', () => {
    it('applies the call\'s usage so the token guard can fire on the returned metrics', async () => {
      const streamChat = fakeStreamChat([
        { type: 'content_delta', text: 'big response' },
        { type: 'finish', reason: 'stop' },
        { type: 'usage', usage: { promptTokens: 60, completionTokens: 50, totalTokens: 110 } },
        { type: 'done' },
      ])
      const { deps, request } = setup({
        streamChat,
        config: { maxTokens: 50 },  // lastRequestTokens (60) > limit (50) → trip
      })
      const result = await shellCall(deps, request)
      const hits = runGuards(result.updatedMetrics, deps.config)
      expect(hits.find(h => h.id === 'token')).toBeDefined()
    })

    it('returns metrics within budget when usage is small', async () => {
      const { deps, request } = setup()
      const result = await shellCall(deps, request)
      const hits = runGuards(result.updatedMetrics, deps.config)
      expect(hits).toEqual([])
    })
  })

  describe('protocol error propagation', () => {
    it('throws ProtocolError when protocol fails with 401', async () => {
      const streamChat: ShellDeps['streamChat'] = async function* () {
        throw new ProtocolError(401, { error: 'unauthorized' }, false)
      }
      const { deps, request } = setup({ streamChat })
      await expect(shellCall(deps, request)).rejects.toBeInstanceOf(ProtocolError)
    })
  })

  describe('lastRequestTokens (per-request size for token guard)', () => {
    it('writes usage.promptTokens to lastRequestTokens when usage chunk exists', async () => {
      const streamChat = fakeStreamChat([
        { type: 'content_delta', text: 'hello' },
        { type: 'finish', reason: 'stop' },
        { type: 'usage', usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 } },
        { type: 'done' },
      ])
      const { deps, request } = setup({ streamChat })
      const result = await shellCall(deps, request)
      expect(result.updatedMetrics.lastRequestTokens).toBe(42)
    })

    it('estimates lastRequestTokens from messages when no usage chunk', async () => {
      const streamChat: ShellDeps['streamChat'] = async function* () {
        yield { type: 'content_delta', text: 'no usage' }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'done' }
      }
      const { deps, request } = setup({ streamChat })
      const result = await shellCall(deps, request)
      expect(result.updatedMetrics.lastRequestTokens).toBeGreaterThan(0)
    })
  })

  describe('empty tools array omitted from request', () => {
    it('omits the tools key when no tools are referenced', async () => {
      let captured: Record<string, unknown> | null = null
      const streamChat: ShellDeps['streamChat'] = async function* (_url, request) {
        captured = request as Record<string, unknown>
        yield { type: 'content_delta', text: 'ok' }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'done' }
      }
      const { deps, request: finalPrompt } = setup({ streamChat })
      // The default setup registers an 'echo' tool but the default FinalPrompt
      // from compose() does NOT reference it — so tools is [].
      expect(finalPrompt.tools).toEqual([])
      await shellCall(deps, finalPrompt)
      expect(captured).not.toBeNull()
      expect(captured!).not.toHaveProperty('tools')
    })

    it('includes the tools key when tools are referenced', async () => {
      let captured: Record<string, unknown> | null = null
      const streamChat: ShellDeps['streamChat'] = async function* (_url, request) {
        captured = request as Record<string, unknown>
        yield { type: 'content_delta', text: 'ok' }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'done' }
      }
      const { deps } = setup({ streamChat })
      // Build a FinalPrompt that actually references the echo tool.
      const requestWithTool = compose(deps.registry, [
        { type: 'system', content: 'SYS' },
        { type: 'userTemplate', content: 'hi' },
        { type: 'systemTool', ref: 'echo' },
      ])
      expect(requestWithTool.tools).toHaveLength(1)
      await shellCall(deps, requestWithTool)
      expect(captured).not.toBeNull()
      expect(captured!).toHaveProperty('tools')
      expect((captured!.tools as unknown[])).toHaveLength(1)
    })
  })
})
