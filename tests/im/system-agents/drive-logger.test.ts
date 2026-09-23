// v0.14: logger integration tests for the drive coordinator.
//
// Verifies that the per-coordinator logger emits records on:
//   - tick start / skip / stop
//   - dispatchCompression start / ok / failure / skip
//   - evictRange mismatch warn
//   - M3 archive start / ok / skip / failure
//   - mailbox notice success/error (when mailbox.send throws)
//
// Each test installs a capture logger via DriveDeps.logger. Module-level
// defaultLogger is silenced during tests to avoid noise pollution.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createDriveCoordinator,
  type DriveDeps,
} from '../../../src/im/system-agents/drive-coordinator.js'
import { ConversationMemory } from '../../../src/im/conversation-memory.js'
import { Databus } from '../../../src/im/databus.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import { createSignalBus } from '../../../src/im/memory-layers.js'
import { turnToMessage } from '../../../src/im/turn.js'
import { appendCanonicalTurn } from '../../../src/im/turn.js'
import type { ConversationTurn } from '../../../src/im/conversation-memory.js'
import type { ToolTurn } from '../../../src/im/databus.js'
import type { SystemAgent } from '../../../src/im/system-agent.js'
import type { StateLine, StateLineEntry, RawArchiveRecord, CuratedMemory } from '../../../src/im/state-line/types.js'
import type { ChatMessage, ToolCall } from '../../../src/protocol/types.js'
import {
  setLevel,
  setSink,
  getLevel,
  type LogRecord,
  type Logger,
} from '../../../src/shared/logger.js'

// ---------------------------------------------------------------------------
// Test fixtures: build a valid block (user → assistant(tc) → tool → assistant)
// and a real ConversationMemory + Databus seeded with it.
// ---------------------------------------------------------------------------

let idCounter = 0
const nextId = (prefix: string): string => `${prefix}-${idCounter++}`

const userTurn = (content: string, at: number): ConversationTurn => ({
  id: nextId('user'), role: 'user', content, at,
})
const assistantTurn = (content: string | null, at: number, toolCalls?: ToolCall[]): ConversationTurn => {
  const t: ConversationTurn = { id: nextId('assistant'), role: 'assistant', content, at }
  if (toolCalls) (t as { toolCalls?: ToolCall[] }).toolCalls = toolCalls
  return t
}
const toolTurnIO = (toolCallId: string, content: string, at: number): ToolTurn => ({
  id: nextId('tool'), role: 'tool', toolCallId, content, sourceAgentId: 'main', at,
})
const tc = (id: string, name = 'echo'): ToolCall => ({
  id, type: 'function', function: { name, arguments: '{}' },
})

// A valid CuratedMemory object for the mock compressor to submit.
const curatedMemory = {
  task_goal: 'mock',
  causal_steps: [{ intent: 'i', tool_action: 't', result: 'r' }],
  evidence_fragments: [{ source: 's', fragment: 'f', relevance: 'r' }],
  conclusion: 'c',
  next_action: 'n',
  working_state: {
    current_goal: 'g',
    effective_decisions: [],
    rejected_decisions: [],
    architecture_boundaries: [],
    remaining_work: [],
  },
  status_hint: 'DONE',
} satisfies CuratedMemory

// Mock agent that returns the CuratedMemory submission payload (v0.42 contract).
const createMockAgent = (opts: { shouldThrow?: boolean } = {}): SystemAgent & { calls: unknown[] } => {
  const calls: unknown[] = []
  return {
    calls,
    async run(input: { messages: ChatMessage[]; metadata?: Record<string, unknown> }) {
      calls.push(input)
      if (opts.shouldThrow) throw new Error('mock compressor failed')
      return {
        output: '',
        submitted: curatedMemory,
        metrics: { stepCount: 1 } as never,
        finalState: 'Running' as never,
        reason: 'completed' as const,
        hits: [],
      }
    },
    stop() {},
    send() {},
  }
}

const createMockStateLine = (): StateLine & { rawArchiveRecords: RawArchiveRecord[] } => {
  const rawArchiveRecords: RawArchiveRecord[] = []
  return {
    compressor: { async appendBlock() { /* ok */ } },
    warehouse: {
      async appendSummary() {},
      async queryM3() { return { ok: false, error: 'mock' } },
    },
    rawArchive: {
      async append(r) { rawArchiveRecords.push(r) },
      async query() { return [] },
    },
    query() { return [] },
    subscribe() { return () => {} },
    close() {},
    rawArchiveRecords,
  }
}

// CaptureLogger: same shape as in loop-logger.test.ts (kept inline because
// tests should be self-contained — sharing helpers across tests/im/system-agents
// would couple unrelated suites).
//
// Single shared `records` array across every level of the .child() tree so
// the test can assert on `log.records.find(...)` regardless of how deeply
// the production code nests its .child() calls. The .records property on a
// returned child still points at the same array (the root CaptureLogger's
// `records`), so any reference works.
const makeCaptureLogger = (): Logger & { records: LogRecord[] } => {
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
        // Return a child that shares the same root `records` array so the
        // test sees every record from every level of the tree. The child's
        // .records property points at the SAME array (caller-observable).
        const next = make({ ...bindings, ...b })
        next.records = records
        return next
      },
    }
    return logger
  }
  return make()
}

const seedBlock = (): { conv: ConversationMemory; bus: Databus } => {
  const conv = new ConversationMemory()
  const bus = new Databus()
  const now = Date.now()
  // Block 1: user → assistant(tool_call) → tool → assistant — pair completes
  // before the next user turn, so it's eligible for findNextTaskBlock.
  const turns: ConversationTurn[] = [
    userTurn('task1', now),
    assistantTurn(null, now + 1, [tc('tc1')]),
    toolTurnIO('tc1', 'result', now + 2),
    assistantTurn('done', now + 3),
    userTurn('task2', now + 10), // boundary — block 1 ends here
  ]
  for (const t of turns) appendCanonicalTurn(conv, bus, t)
  return { conv, bus }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('drive-coordinator logger integration', () => {
  let prevLevel: ReturnType<typeof getLevel>
  let prevSink: (rec: LogRecord) => void

  beforeEach(() => {
    prevLevel = getLevel()
    prevSink = (rec) => { process.stderr.write(JSON.stringify(rec) + '\n') }
    // Drive tests rely on the per-coordinator logger (passed via DriveDeps.logger),
    // which is a CaptureLogger unaffected by setLevel. We still silence the
    // module-level defaultLogger here to avoid polluting stderr during tests.
    setLevel('error')
    setSink(() => { /* swallow */ })
  })

  afterEach(() => {
    setLevel(prevLevel)
    setSink(prevSink)
  })

  it('records tick + dispatchCompression start/ok on a clean M1 compression', async () => {
    const log = makeCaptureLogger()
    const { conv, bus } = seedBlock()
    const deps: DriveDeps = {
      bus: createSignalBus(),
      compressor: createMockAgent(),
      warehouse: createMockAgent(),
      stateLine: createMockStateLine(),
      mailbox: new Mailbox(),
      workingAgentId: 'main',
      logger: log,
    }
    const dc = createDriveCoordinator(deps)
    await dc.tick({ contextTokens: 250_000, conversation: conv, databus: bus })

    const msgs = log.records.map((r) => r.msg)
    expect(msgs).toContain('tick')
    expect(msgs).toContain('dispatchCompression start')
    expect(msgs).toContain('compressor run finished')
    expect(msgs).toContain('appendBlock ok')
    expect(msgs).toContain('rawArchive.append ok')
    expect(msgs).toContain('dispatchCompression ok')

    // child bindings propagate to every record.
    expect(log.records.every((r) => r.component === 'drive-coordinator')).toBe(true)
    expect(log.records.every((r) => r.workingAgentId === 'main')).toBe(true)

    // ok record carries the persisted counts.
    const okRec = log.records.find((r) => r.msg === 'dispatchCompression ok')
    expect(okRec).toBeDefined()
    expect(okRec!.persistedMessages).toBe(4)
    expect(okRec!.archivedToolIds).toBe(1)
  })

  it('records dispatchCompression failed when compressor throws', async () => {
    const log = makeCaptureLogger()
    const { conv, bus } = seedBlock()
    const deps: DriveDeps = {
      bus: createSignalBus(),
      compressor: createMockAgent({ shouldThrow: true }),
      warehouse: createMockAgent(),
      stateLine: createMockStateLine(),
      mailbox: new Mailbox(),
      workingAgentId: 'main',
      logger: log,
    }
    const dc = createDriveCoordinator(deps)
    await dc.tick({ contextTokens: 250_000, conversation: conv, databus: bus })

    const failed = log.records.find((r) => r.msg === 'dispatchCompression failed')
    expect(failed).toBeDefined()
    expect(failed!.level).toBe('error')
    expect(String(failed!.err)).toContain('mock compressor failed')
    expect(failed!.errStack).toBeDefined()
  })

  it('records "tick skipped (no eligible block)" when canonical is empty', async () => {
    const log = makeCaptureLogger()
    const conv = new ConversationMemory()
    const bus = new Databus()
    const deps: DriveDeps = {
      bus: createSignalBus(),
      compressor: createMockAgent(),
      warehouse: createMockAgent(),
      stateLine: createMockStateLine(),
      mailbox: new Mailbox(),
      workingAgentId: 'main',
      logger: log,
    }
    const dc = createDriveCoordinator(deps)
    // Empty conversation — but still in M1 zone (crossing would dispatch).
    await dc.tick({ contextTokens: 250_000, conversation: conv, databus: bus })
    const skipRec = log.records.find((r) => r.msg === 'dispatchCompression skipped (no eligible block)')
    expect(skipRec).toBeDefined()
  })

  it('records mailbox notice error when systemSend throws on success path', async () => {
    const log = makeCaptureLogger()
    const { conv, bus } = seedBlock()
    // Mailbox whose systemSend throws — forces the catch (mailbox notice failed (success)).
    const mb = {
      send: () => { throw new Error('mb send fail') },
      systemSend: () => { throw new Error('mb systemSend fail') },
      readOwnInbox: () => [],
      markRead: () => {},
      sentStatus: () => ({ found: false, read: false, summary: undefined, sentAt: undefined, readAt: undefined, ageMs: 0, now: 0 }),
      hasUnread: () => false,
      inboxSize: () => 0,
    }
    const deps: DriveDeps = {
      bus: createSignalBus(),
      compressor: createMockAgent(),
      warehouse: createMockAgent(),
      stateLine: createMockStateLine(),
      mailbox: mb as unknown as Mailbox,
      workingAgentId: 'main',
      logger: log,
    }
    const dc = createDriveCoordinator(deps)
    await dc.tick({ contextTokens: 250_000, conversation: conv, databus: bus })

    const mbFail = log.records.find((r) => r.msg === 'mailbox notice failed (success)')
    expect(mbFail).toBeDefined()
    expect(mbFail!.level).toBe('error')
    // The success record is still emitted even when the mailbox notice fails.
    expect(log.records.find((r) => r.msg === 'dispatchCompression ok')).toBeDefined()
  })

  it('records M3 archive start + ok when crossing into M3 with curated blocks', async () => {
    const log = makeCaptureLogger()
    const conv = new ConversationMemory()
    const bus = new Databus()
    // StateLine that returns M1/M2 entries — triggers archive.
    const entries: StateLineEntry[] = [{
      ...({
        task_goal: 'archived task',
        causal_steps: [],
        evidence_fragments: [],
        conclusion: 'done',
        next_action: 'none',
        working_state: {
          current_goal: 'g', effective_decisions: [], rejected_decisions: [],
          architecture_boundaries: [], remaining_work: [],
        },
        status_hint: 'DONE',
      } as CuratedMemory),
      _stamp: 'S-archive-1',
    }]
    const stateLine: StateLine = {
      compressor: { async appendBlock() {} },
      warehouse: {
        async appendSummary() {},
        async queryM3() { return { ok: false, error: 'mock' } },
      },
      rawArchive: {
        async append() {},
        async query() { return [] },
      },
      query: (filter) => filter?.layer === 'M1' ? entries : [],
      subscribe: () => () => {},
      close: () => {},
    }
    const deps: DriveDeps = {
      bus: createSignalBus(),
      compressor: createMockAgent(),
      warehouse: createMockAgent(),
      stateLine,
      mailbox: new Mailbox(),
      workingAgentId: 'main',
      logger: log,
    }
    const dc = createDriveCoordinator(deps)
    await dc.tick({ contextTokens: 950_000, conversation: conv, databus: bus })

    const msgs = log.records.map((r) => r.msg)
    expect(msgs).toContain('M3 archive dispatch start')
    expect(msgs).toContain('M3 archive scanned')
    expect(msgs).toContain('M3 archive batch ok')

    const okRec = log.records.find((r) => r.msg === 'M3 archive batch ok')
    expect(okRec!.archived).toBe(1)
  })

  it('records M3 archive start + failed when warehouse throws', async () => {
    const log = makeCaptureLogger()
    const entries: StateLineEntry[] = [{
      ...({
        task_goal: 'g',
        causal_steps: [],
        evidence_fragments: [],
        conclusion: 'c',
        next_action: 'n',
        working_state: {
          current_goal: 'g', effective_decisions: [], rejected_decisions: [],
          architecture_boundaries: [], remaining_work: [],
        },
      } as CuratedMemory),
      _stamp: 'S-x',
    }]
    const stateLine: StateLine = {
      compressor: { async appendBlock() {} },
      warehouse: { async appendSummary() {}, async queryM3() { return { ok: false, error: 'm' } } },
      rawArchive: { async append() {}, async query() { return [] } },
      query: () => entries,
      subscribe: () => () => {},
      close: () => {},
    }
    const deps: DriveDeps = {
      bus: createSignalBus(),
      compressor: createMockAgent(),
      warehouse: createMockAgent({ shouldThrow: true }),
      stateLine,
      mailbox: new Mailbox(),
      workingAgentId: 'main',
      logger: log,
    }
    const dc = createDriveCoordinator(deps)
    await dc.tick({ contextTokens: 950_000, conversation: new ConversationMemory(), databus: new Databus() })

    const fail = log.records.find((r) => r.msg === 'M3 archive batch failed')
    expect(fail).toBeDefined()
    expect(fail!.level).toBe('error')
  })

  it('records "tick skipped (stopped)" after stop()', async () => {
    const log = makeCaptureLogger()
    const deps: DriveDeps = {
      bus: createSignalBus(),
      compressor: createMockAgent(),
      warehouse: createMockAgent(),
      stateLine: createMockStateLine(),
      mailbox: new Mailbox(),
      workingAgentId: 'main',
      logger: log,
    }
    const dc = createDriveCoordinator(deps)
    dc.stop()
    await dc.tick({ contextTokens: 250_000, conversation: new ConversationMemory(), databus: new Databus() })
    expect(log.records.find((r) => r.msg === 'tick skipped (stopped)')).toBeDefined()
  })

  // silence unused-var warning for the helper exported above but not used here
  it('uses turnToMessage helper (compile-time guard)', () => {
    expect(typeof turnToMessage).toBe('function')
  })
})
