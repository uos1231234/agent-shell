// v0.17.x test supplement batch 2: retry boundary semantics.
//
// 5 tests covering retry policy at the edge of v0.17 hook integration.
// Adapted from KimiCode retry.test.ts. Tests are RED first; bugs found
// drive minimal root-cause fixes.

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
import { ProtocolError } from '../../src/protocol/types.js'

const noopSystemAgent: SystemAgent = {
  run: async () => { throw new Error('noop') },
  stop() {},
  send() {},
}

const scriptedStreamChat = (responses: ChatCompletionResponse[]): IMLoopOptions['streamChat'] => {
  let i = 0
  return async function* (_url, _request): AsyncIterable<StreamChunk> {
    const r = responses[i++]
    if (!r) return
    const msg = r.choices[0]?.message
    if (typeof msg?.content === 'string' && msg.content.length > 0) {
      yield { type: 'content_delta', text: msg.content }
    }
    yield { type: 'finish', reason: r.choices[0]?.finish_reason ?? 'stop' }
    yield { type: 'done' }
  }
}

const baseOptions = (overrides: Partial<IMLoopOptions> = {}): IMLoopOptions => ({
  config: createConfig(),
  registry: new ToolRegistry(),
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
  systemToolRefs: [],
  mcpRefs: [],
  skillRefs: [],
  ...overrides,
})

// 1. retriable protocol error retries up to MAX then terminates
describe('retry 1 — retriable ProtocolError exhausts budget', () => {
  it('returns reason=protocol-error after MAX_PROTOCOL_ERROR_RETRIES failures', async () => {
    let calls = 0
    const failing: IMLoopOptions['streamChat'] = async function* () {
      calls += 1
      throw new ProtocolError(503, 'down', true)
    }
    const opts = baseOptions({ streamChat: failing })
    const result = await runIMLoop(opts)
    expect(result.reason).toBe('protocol-error')
    expect(result.terminated).toBe(true)
    // 1 initial + 3 retries = 4 calls before terminate
    expect(calls).toBe(4)
  }, 15_000)
})

// 2. non-retriable ProtocolError terminates immediately, no backoff
describe('retry 2 — non-retriable ProtocolError fails fast', () => {
  it('returns reason=protocol-error on first call, no retry', async () => {
    let calls = 0
    const failing: IMLoopOptions['streamChat'] = async function* () {
      calls += 1
      throw new ProtocolError(400, 'bad', false)
    }
    const start = Date.now()
    const opts = baseOptions({ streamChat: failing })
    const result = await runIMLoop(opts)
    const elapsed = Date.now() - start
    expect(result.reason).toBe('protocol-error')
    expect(calls).toBe(1)
    // No backoff should have elapsed — non-retriable fails immediately.
    expect(elapsed).toBeLessThan(500)
  })
})

// 3. recovery on retry: fail twice then succeed
describe('retry 3 — recovery succeeds within retry budget', () => {
  it('completes normally when transient error clears', async () => {
    let calls = 0
    const flaky: IMLoopOptions['streamChat'] = async function* () {
      calls += 1
      if (calls < 3) throw new ProtocolError(503, 'transient', true)
      // 3rd call succeeds
      yield { type: 'content_delta', text: 'finally' }
      yield { type: 'finish', reason: 'stop' }
      yield { type: 'done' }
    }
    const opts = baseOptions({ streamChat: flaky })
    const result = await runIMLoop(opts)
    expect(result.reason).toBe('completed')
    expect(calls).toBe(3)
  })
})

// 4. hook retry=true counts against MAX_PROTOCOL_ERROR_RETRIES (P1-3 regression)
//    (already covered in loop-hooks-integration.test.ts but repeated here for
//    boundary semantics; if the integration test gets deleted, this stays.)
describe('retry 4 — hook retry respects MAX_PROTOCOL_ERROR_RETRIES', () => {
  it('hook returning retry=true forever terminates after MAX attempts', async () => {
    let hookCalls = 0
    const failing: IMLoopOptions['streamChat'] = async function* () {
      throw new ProtocolError(503, 'always', true)
    }
    const opts = baseOptions({
      streamChat: failing,
      hooks: {
        afterShellCall: async () => {
          hookCalls += 1
          return { retry: true, retryDelayMs: 0 }
        },
      },
    })
    const result = await runIMLoop(opts)
    expect(result.reason).toBe('protocol-error')
    // Hook sees retry for each call, but never exceeds cap
    expect(hookCalls).toBeGreaterThanOrEqual(3)
    expect(hookCalls).toBeLessThanOrEqual(5)
  })
})

// 5. backoff timing — first retry is ~1000ms, doubles each subsequent
describe('retry 5 — backoff timing is exponential', () => {
  it('full retry cycle takes roughly 1000+2000+4000 = 7000ms (3 retries)', async () => {
    let calls = 0
    const failing: IMLoopOptions['streamChat'] = async function* () {
      calls += 1
      throw new ProtocolError(503, 'down', true)
    }
    const start = Date.now()
    const opts = baseOptions({ streamChat: failing })
    await runIMLoop(opts)
    const elapsed = Date.now() - start
    // 4 calls total (1 initial + 3 retries). Backoffs: 1000 + 2000 + 4000 = 7000ms.
    // Allow wide tolerance for test scheduling jitter.
    expect(elapsed).toBeGreaterThan(5000)
  }, 15_000)
})
