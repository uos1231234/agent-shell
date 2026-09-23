// v0.14: logger integration tests for runIMLoop.
//
// Verifies that the per-loop logger emits the documented events at the right
// points. We capture records via a custom sink (setSink/resetSink) and check
// the records' msg + fields. Test isolation: each test installs + restores
// its own sink.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runIMLoop, type IMLoopOptions } from '../../src/im/loop.js'
import { ToolRegistry } from '../../src/shell/registry.js'
import { createConfig } from '../../src/shell/config.js'
import { createMetrics } from '../../src/shell/metrics.js'
import { Databus } from '../../src/im/databus.js'
import { ConversationMemory } from '../../src/im/conversation-memory.js'
import { Mailbox } from '../../src/im/mailbox/index.js'
import { createNoopStateLine } from '../../src/im/state-line/index.js'
import {
  setLevel,
  setSink,
  getLevel,
  type LogRecord,
  type Logger,
} from '../../src/shared/logger.js'
import type { SystemAgent } from '../../src/im/system-agent.js'
import type { StreamChunk, ChatCompletionResponse, ToolCall } from '../../src/protocol/types.js'

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

// CollectLogger: an in-memory logger that captures every record the loop emits.
// We use it instead of setSink() so the bind is explicit at the IMLoopOptions
// site (proves the loop routes through the opts.logger, not the module-level
// defaultLogger). Each test gets its own instance.
//
// .child() returns a logger that shares the SAME `records` array as the root,
// so the test can assert on `log.records.find(...)` regardless of nesting depth.
const makeCollectLogger = (): Logger & { records: LogRecord[] } => {
  const records: LogRecord[] = []
  const make = (bindings: Record<string, unknown> = {}): Logger & { records: LogRecord[] } => {
    const push = (level: LogRecord['level'], msg: string, fields?: Record<string, unknown>): void => {
      records.push({ ...bindings, ...(fields ?? {}), ts: Date.now(), level, msg })
    }
    const logger: Logger & { records: LogRecord[] } = {
      records,
      trace: (m, f) => push('trace', m, f),
      debug: (m, f) => push('debug', m, f),
      info: (m, f) => push('info', m, f),
      warn: (m, f) => push('warn', m, f),
      error: (m, f) => push('error', m, f),
      child: (b) => {
        const next = make({ ...bindings, ...b })
        next.records = records
        return next
      },
    }
    return logger
  }
  return make()
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

describe('im/loop logger integration', () => {
  let prevLevel: ReturnType<typeof getLevel>
  let prevSink: (rec: LogRecord) => void

  beforeEach(() => {
    prevLevel = getLevel()
    prevSink = (rec) => { process.stderr.write(JSON.stringify(rec) + '\n') }
    // Silence the defaultLogger during these tests so module-level leakage
    // (from anywhere else using defaultLogger) doesn't pollute the test output.
    setLevel('error')
  })

  afterEach(() => {
    setLevel(prevLevel)
    setSink(prevSink)
  })

  it('emits runIMLoop start + completed for a text-only round', async () => {
    const log = makeCollectLogger()
    const opts = baseOptions({
      logger: log,
      streamChat: scriptedStreamChat([{
        id: 'r1', model: 'gpt-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }]),
    })
    await runIMLoop(opts)
    const msgs = log.records.map((r) => r.msg)
    expect(msgs).toContain('runIMLoop start')
    expect(msgs).toContain('runIMLoop completed')
    // workingAgentId binding must propagate through .child().
    expect(log.records.every((r) => r.workingAgentId === 'main')).toBe(true)
    expect(log.records.every((r) => r.component === 'im-loop')).toBe(true)
  })

  it('emits "guard tripped" with hit details when token guard fires', async () => {
    const log = makeCollectLogger()
    const opts = baseOptions({
      logger: log,
      config: createConfig({ maxTokens: 5 }),
      streamChat: scriptedStreamChat([{
        id: 'r1', model: 'gpt-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'big' }, finish_reason: 'stop' }],
        usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
      }]),
    })
    const result = await runIMLoop(opts)
    expect(result.reason).toBe('guard-tripped')
    const tripped = log.records.find((r) => r.msg === 'guard tripped')
    expect(tripped).toBeDefined()
    expect(tripped!.level).toBe('warn')
    expect(Array.isArray(tripped!.hits)).toBe(true)
    expect((tripped!.hits as Array<{ id: string }>).some((h) => h.id === 'token')).toBe(true)
  })

  it('emits "tool errors in round" warn when a tool throws', async () => {
    const log = makeCollectLogger()
    const registry = new ToolRegistry()
    registry.registerSystemTool({
      name: 'explode',
      description: 'always fails',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => { throw new Error('boom') },
    })
    const tc: ToolCall = { id: 'tc-x', type: 'function', function: { name: 'explode', arguments: '{"reason":"test"}' } }
    const opts = baseOptions({
      logger: log,
      registry,
      systemToolRefs: ['explode'],
      streamChat: scriptedStreamChat([
        {
          id: 'r1', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [tc] }, finish_reason: 'tool_calls' }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
        {
          id: 'r2', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }],
          usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
        },
      ]),
    })
    await runIMLoop(opts)
    const warn = log.records.find((r) => r.msg === 'tool errors in round')
    expect(warn).toBeDefined()
    expect(warn!.level).toBe('warn')
    expect(warn!.errorCount).toBe(1)
    expect(warn!.consecutiveToolErrors).toBe(1)
  })

  it('does NOT emit "tool errors in round" when all tools succeed', async () => {
    const log = makeCollectLogger()
    const tc: ToolCall = { id: 'tc-1', type: 'function', function: { name: 'echo', arguments: '{"x":"hi","reason":"verify"}' } }
    const opts = baseOptions({
      logger: log,
      streamChat: scriptedStreamChat([
        {
          id: 'r1', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [tc] }, finish_reason: 'tool_calls' }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
        {
          id: 'r2', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
        },
      ]),
    })
    await runIMLoop(opts)
    expect(log.records.find((r) => r.msg === 'tool errors in round')).toBeUndefined()
  })

  it('emits "driveCoordinator.tick unhandled rejection" when tick throws', async () => {
    const log = makeCollectLogger()
    const dc = {
      tick: async () => { throw new Error('drive exploded') },
      nextEligibleBlock: () => undefined,
      stop: () => {},
      drain: async () => {},
    }
    const opts = baseOptions({
      logger: log,
      driveCoordinator: dc,
      // Need at least one tool call so driveCoordinator is invoked.
      streamChat: scriptedStreamChat([
        {
          id: 'r1', model: 'gpt-4',
          choices: [{
            index: 0, message: {
              role: 'assistant', content: null,
              tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'echo', arguments: '{"x":"go","reason":"trigger drive"}' } } as ToolCall],
            }, finish_reason: 'tool_calls',
          }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
        {
          id: 'r2', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
          usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
        },
      ]),
    })
    // Drain microtasks so the void Promise rejection lands.
    await runIMLoop(opts)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const rejected = log.records.find((r) => r.msg === 'driveCoordinator.tick unhandled rejection')
    expect(rejected).toBeDefined()
    expect(rejected!.level).toBe('error')
    expect(String(rejected!.err)).toContain('drive exploded')
  })

  it('emits "protocol error" warn when streamChat throws ProtocolError', async () => {
    const log = makeCollectLogger()
    const { ProtocolError } = await import('../../src/protocol/types.js')
    const erroringStream: IMLoopOptions['streamChat'] = async function* () {
      // retriable=false so the loop terminates immediately without retrying
      // (retry path sleeps with backoff and would exceed the test timeout).
      throw new ProtocolError(400, 'bad request', false)
    }
    const opts = baseOptions({ logger: log, streamChat: erroringStream })
    const result = await runIMLoop(opts)
    expect(result.reason).toBe('protocol-error')
    const rec = log.records.find((r) => r.msg === 'protocol error (non-retriable)')
    expect(rec).toBeDefined()
    expect(rec!.level).toBe('warn')
    expect(String(rec!.err)).toContain('bad request')
  })
})
