// v0.10.4 B7: drive-coordinator tests — plan §5.10 items 7–12.
//
// Covers:
//  7. selector returns exactly one user-to-next-user span, includes all
//     intermediate assistant/tool turns, requires a tool turn, rejects
//     incomplete pairing, and never consults Databus for block content.
//  8. drive success — compressor receives the exact ChatMessage[]; canonical
//     range is evicted; Databus is left intact (方案 A — stamps stay live).
//  9. drive failure — record/persistence failure sends a mailbox note and
//     leaves canonical + Databus unchanged.
// 10. pairing regression — after middle-range eviction, surviving canonical
//     serialization has no leading tool, no orphan result, no assistant
//     tool_calls without its result.
// 11. M1/M2/M3 drive tests — M1 compression, preserved prior M2 target
//     policy, M3 archive with curated blocks retained and mailbox pointer sent.
// 12. end-to-end scripted test — cross 200K and 900K without working agent
//     calling compression/archive tool; assert protocol order, full-block
//     delivery, persistence, exact eviction, archive retention, mailbox
//     notification.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  findNextTaskBlock,
  createDriveCoordinator,
  createNoopDriveCoordinator,
  parseCuratedMemoryOutput,
  fitMailBody,
  MAIL_BODY_BUDGET,
  type TaskBlock,
  type DriveDeps,
} from '../../../src/im/system-agents/drive-coordinator.js'
import { ConversationMemory } from '../../../src/im/conversation-memory.js'
import { Databus } from '../../../src/im/databus.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import { createSignalBus } from '../../../src/im/memory-layers.js'
import { createStateLine } from '../../../src/im/state-line/index.js'
import { turnToMessage } from '../../../src/im/turn.js'
import { appendCanonicalTurn, buildUserStopMarkerTurn, USER_INTERRUPTED_MARKER } from '../../../src/im/turn.js'
import type { ConversationTurn } from '../../../src/im/conversation-memory.js'
import type { ToolTurn } from '../../../src/im/databus.js'
import type { SystemAgent } from '../../../src/im/system-agent.js'
import type { StateLine, StateLineEntry, RawArchiveRecord, CuratedMemory, M3Summary } from '../../../src/im/state-line/types.js'
import type { ChatMessage, ToolCall } from '../../../src/protocol/types.js'

// ---------------------------------------------------------------------------
// Helpers: build canonical turns with deterministic ids.
// ---------------------------------------------------------------------------

let idCounter = 0
const nextId = (prefix: string): string => `${prefix}-${idCounter++}`

const userTurn = (content: string, at: number): ConversationTurn => ({
  id: nextId('user'),
  role: 'user',
  content,
  at,
})

const assistantTurn = (content: string | null, at: number, toolCalls?: ToolCall[]): ConversationTurn => {
  const t: ConversationTurn = { id: nextId('assistant'), role: 'assistant', content, at }
  if (toolCalls) (t as { toolCalls?: ToolCall[] }).toolCalls = toolCalls
  return t
}

const toolTurn = (toolCallId: string, content: string, at: number, sourceAgentId = 'main'): ConversationTurn => {
  const t: ToolTurn = {
    id: nextId('tool'),
    role: 'tool',
    toolCallId,
    content,
    sourceAgentId,
    at,
  }
  return t
}

const tc = (id: string, name = 'echo'): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: '{}' },
})

// Seed a canonical memory + databus with a list of turns via appendCanonicalTurn.
const seed = (conv: ConversationMemory, bus: Databus, turns: ConversationTurn[]): void => {
  for (const t of turns) {
    appendCanonicalTurn(conv, bus, t)
  }
}

// ---------------------------------------------------------------------------
// Mock SystemAgent — captures run() input and returns a configurable result.
// ---------------------------------------------------------------------------

type MockAgentRun = {
  messages: ChatMessage[]
  metadata: Record<string, unknown> | undefined
}

type MockAgent = SystemAgent & { calls: MockAgentRun[] }

// A valid CuratedMemory object that mock compressors return as their
// submission payload (v0.42 contract: the compressor calls submit_curated_memory,
// the coordinator reads result.submitted, validates + persists it).
const curatedMemory = {
  task_goal: 'mock compressed block',
  causal_steps: [{ intent: 'read block', tool_action: 'parse', result: 'parsed' }],
  evidence_fragments: [{ source: 'mock', fragment: 'frag', relevance: 'load-bearing' }],
  conclusion: 'block compressed by scripted mock',
  next_action: 'evict canonical range',
  working_state: {
    current_goal: 'drive compression',
    effective_decisions: ['mock persisted via coordinator appendBlock'],
    rejected_decisions: [],
    architecture_boundaries: ['state-line is append-only'],
    remaining_work: [],
  },
  status_hint: 'DONE',
} satisfies CuratedMemory

const createMockAgent = (
  opts: { shouldThrow?: boolean; spy?: ReturnType<typeof vi.fn>; submitted?: unknown } = {},
): MockAgent => {
  const calls: MockAgentRun[] = []
  // Distinguish "no submitted key" (→ default CuratedMemory payload) from an
  // explicit submitted value (including undefined). `'submitted' in opts` is
  // true only when the caller passed the key, so `submitted: undefined`
  // simulates a compressor that never called submit_curated_memory.
  const hasExplicitSubmitted = 'submitted' in opts
  const agent = {
    async run(input: { messages: ChatMessage[]; metadata?: Record<string, unknown> }) {
      calls.push({ messages: input.messages, metadata: input.metadata })
      if (opts.spy) opts.spy(input)
      if (opts.shouldThrow) {
        throw new Error('mock compressor failure')
      }
      return {
        // Default submission is the valid CuratedMemory payload (v0.42
        // contract: result.submitted = last submit_curated_memory `memory`
        // argument). An explicit submitted (including undefined) is used as-is.
        output: '',
        submitted: hasExplicitSubmitted ? opts.submitted : curatedMemory,
        metrics: {
          rounds: 1,
          toolCalls: 0,
          toolErrors: 0,
          guardTrips: 0,
          tokensUsed: 0,
        } as any,
        finalState: 'Running' as any,
        reason: 'completed' as const,
        hits: [],
      }
    },
    stop() {},
    send() {},
    calls,
  }
  return agent as MockAgent
}

// ---------------------------------------------------------------------------
// Mock StateLine — query returns configurable entries; append succeeds/throws.
// ---------------------------------------------------------------------------

const createMockStateLine = (opts: {
  entries?: { M1?: StateLineEntry[]; M2?: StateLineEntry[] }
  appendShouldThrow?: boolean
  rawArchiveShouldThrow?: boolean
} = {}): StateLine & { rawArchiveRecords: RawArchiveRecord[]; m3Summaries: M3Summary[] } => {
  const rawArchiveRecords: RawArchiveRecord[] = []
  // v0.42（方案 A）：增量归档幂等性的模拟——appendSummary（生产里由
  // record_m3_summary 工具经 warehouse 调用）把 M3 摘要记下来，query({layer:'M3'})
  // 能从 source_summary_stamps 重建"已索引集合"。
  const m3Summaries: M3Summary[] = []
  return {
    compressor: {
      async appendBlock() {
        if (opts.appendShouldThrow) throw new Error('mock appendBlock failure')
      },
    },
    warehouse: {
      async appendSummary(summary: M3Summary) {
        if (opts.appendShouldThrow) throw new Error('mock appendSummary failure')
        m3Summaries.push(summary)
      },
      async queryM3() {
        return { ok: false, error: 'mock' }
      },
    },
    rawArchive: {
      async append(record: RawArchiveRecord) {
        if (opts.rawArchiveShouldThrow) throw new Error('mock rawArchive failure')
        rawArchiveRecords.push(record)
      },
      async query(filter: { sourceTurnIds?: string[]; layer?: 'M1' | 'M2'; archiveIds?: string[]; summaryStamps?: string[]; limit?: number }) {
        let results = [...rawArchiveRecords]
        if (filter.layer !== undefined) results = results.filter(r => r.layer === filter.layer)
        if (filter.sourceTurnIds !== undefined) {
          const wanted = new Set(filter.sourceTurnIds)
          results = results.filter(r => r.sourceTurnIds.some(id => wanted.has(id)))
        }
        if (filter.archiveIds !== undefined) {
          const wanted = new Set(filter.archiveIds)
          results = results.filter(r => wanted.has(r.archiveId))
        }
        if (filter.summaryStamps !== undefined) {
          const wanted = new Set(filter.summaryStamps)
          results = results.filter(r => wanted.has(r.summaryStamp))
        }
        if (filter.limit !== undefined) results = results.slice(0, filter.limit)
        return results
      },
    },
    query(filter) {
      // v0.42（方案 A）：M3 查询返回 appendSummary 记录的摘要（增量幂等的
      // source_summary_stamps 来源，模拟 record_m3_summary 的落盘面）。
      if (filter?.layer === 'M3') return m3Summaries
      if (!filter?.layer) return [...(opts.entries?.M1 ?? []), ...(opts.entries?.M2 ?? [])]
      if (filter.layer === 'M1') return opts.entries?.M1 ?? []
      if (filter.layer === 'M2') return opts.entries?.M2 ?? []
      return []
    },
    subscribe() {
      return () => {}
    },
    close() {},
    rawArchiveRecords,
    m3Summaries,
  }
}

// ---------------------------------------------------------------------------
// DriveDeps factory — wires real mailbox + signal bus + mock agents/stateLine.
// ---------------------------------------------------------------------------

const makeDeps = (overrides: Partial<DriveDeps> = {}): DriveDeps => ({
  bus: createSignalBus(),
  compressor: createMockAgent(),
  warehouse: createMockAgent(),
  stateLine: createMockStateLine(),
  mailbox: new Mailbox(),
  workingAgentId: 'main',
  ...overrides,
})

// ===========================================================================
// Item 7: selector behavior
// ===========================================================================

describe('drive-coordinator: findNextTaskBlock (item 7)', () => {
  it('returns exactly one user-to-next-user span with all intermediate turns', () => {
    const turns: ConversationTurn[] = [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'result1', 300),
      assistantTurn('a2', 400),
      userTurn('u2', 500),
      assistantTurn('a3', 600),
      userTurn('u3', 700),
    ]

    const block = findNextTaskBlock(turns)
    expect(block).toBeDefined()
    expect(block!.startIndex).toBe(0)
    expect(block!.endIndexExclusive).toBe(4) // exclusive of u2 at index 4
    expect(block!.turns).toHaveLength(4)
    expect(block!.turns[0]!.role).toBe('user')
    expect(block!.turns[1]!.role).toBe('assistant')
    expect(block!.turns[2]!.role).toBe('tool')
    expect(block!.turns[3]!.role).toBe('assistant')
    expect(block!.startUserTurnId).toBe(turns[0]!.id)
    expect(block!.boundaryUserTurnId).toBe(turns[4]!.id)
  })

  it('v0.30 B4: a pure-conversation span (no tool turns) is an eligible block', () => {
    const turns: ConversationTurn[] = [
      userTurn('u1', 100),
      assistantTurn('a1', 200), // no tool calls
      userTurn('u2', 300),
      assistantTurn('a2', 400, [tc('t1')]),
      toolTurn('t1', 'result1', 500),
      assistantTurn('a3', 600),
      userTurn('u3', 700),
    ]

    // The first span [u1, a1) has no tool — v0.30 relaxed judgment: it is a
    // valid block on its own and is selected first (pure-text sessions are
    // compressible now).
    const block = findNextTaskBlock(turns)
    expect(block).toBeDefined()
    expect(block!.startIndex).toBe(0) // starts at u1
    expect(block!.endIndexExclusive).toBe(2) // exclusive of u2 at index 2
    expect(block!.turns).toHaveLength(2)
    expect(block!.toolTurnIds).toHaveLength(0)
  })

  it('rejects incomplete pairing — outstanding assistant tool_call at end', () => {
    // u1 → assistant(tool_calls) → (no tool result) → u2
    // This span has a tool_call but no matching tool result → incomplete pairing.
    const turns: ConversationTurn[] = [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]), // tool_call t1 outstanding
      userTurn('u2', 300),
      assistantTurn('a2', 400, [tc('t2')]),
      toolTurn('t2', 'result2', 500),
      assistantTurn('a3', 600),
      userTurn('u3', 700),
    ]

    // First span [u1, a1) fails pairing (outstanding tool_call). Selector recurses
    // to [u2, a2, t2, a3) which passes.
    const block = findNextTaskBlock(turns)
    expect(block).toBeDefined()
    expect(block!.startIndex).toBe(2) // u2
    expect(block!.toolTurnIds).toEqual([turns[4]!.id])
  })

  it('rejects leading tool turn', () => {
    // tool before any assistant — should be rejected by validatePairing.
    const turns: ConversationTurn[] = [
      userTurn('u1', 100),
      toolTurn('t1', 'orphan', 200), // leading tool after user, no assistant tool_call before it
      userTurn('u2', 300),
      assistantTurn('a1', 400, [tc('t2')]),
      toolTurn('t2', 'result2', 500),
      assistantTurn('a2', 600),
      userTurn('u3', 700),
    ]

    // First span [u1, tool) — leading tool is rejected. Recurse to [u2, a1, t2, a2).
    const block = findNextTaskBlock(turns)
    expect(block).toBeDefined()
    expect(block!.startIndex).toBe(2)
  })

  it('rejects orphan tool result (tool_call_id not outstanding)', () => {
    const turns: ConversationTurn[] = [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t-wrong', 'wrong id', 300), // toolCallId 't-wrong' not in outstanding
      userTurn('u2', 400),
      assistantTurn('a2', 500, [tc('t2')]),
      toolTurn('t2', 'result2', 600),
      assistantTurn('a3', 700),
      userTurn('u3', 800),
    ]

    // First span fails (orphan tool). Recurse to [u2, a2, t2, a3).
    const block = findNextTaskBlock(turns)
    expect(block).toBeDefined()
    expect(block!.startIndex).toBe(3)
  })

  it('returns undefined when no eligible block exists', () => {
    // Only one user turn — no boundary.
    const turns: ConversationTurn[] = [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'result', 300),
    ]
    expect(findNextTaskBlock(turns)).toBeUndefined()
  })

  it('v0.30 B4: pure-conversation spans are eligible — first span selected', () => {
    const turns: ConversationTurn[] = [
      userTurn('u1', 100),
      assistantTurn('a1', 200),
      userTurn('u2', 300),
      assistantTurn('a2', 400),
      userTurn('u3', 500),
    ]
    // No tool turns anywhere — still compressible after the v0.30 relaxation.
    const block = findNextTaskBlock(turns)
    expect(block).toBeDefined()
    expect(block!.startIndex).toBe(0)
    expect(block!.endIndexExclusive).toBe(2)
    expect(block!.toolTurnIds).toHaveLength(0)
  })

  it('messages are derived from turns via turnToMessage (never consults Databus)', () => {
    const turns: ConversationTurn[] = [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'result1', 300),
      assistantTurn('a2', 400),
      userTurn('u2', 500),
    ]

    const block = findNextTaskBlock(turns)!
    // Each message should match what turnToMessage produces.
    expect(block.messages).toHaveLength(4)
    expect(block.messages[0]).toEqual(turnToMessage(turns[0]!))
    expect(block.messages[1]).toEqual(turnToMessage(turns[1]!))
    expect(block.messages[2]).toEqual(turnToMessage(turns[2]!))
    expect(block.messages[3]).toEqual(turnToMessage(turns[3]!))
    // The function signature takes turns only — Databus is never passed.
    // This is structurally guaranteed by the type signature.
  })
})

// ===========================================================================
// Item 8: drive success
// ===========================================================================

describe('drive-coordinator: drive success (item 8)', () => {
  it('compressor receives exact ChatMessage[]; evicts canonical range + Databus ids', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    const mailbox = new Mailbox()

    // Seed: two complete task blocks.
    const turns: ConversationTurn[] = [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'result1', 300),
      assistantTurn('a2', 400),
      userTurn('u2', 500),
      assistantTurn('a3', 600, [tc('t2')]),
      toolTurn('t2', 'result2', 700),
      assistantTurn('a4', 800),
    ]
    seed(conv, bus, turns)

    // Verify initial state: 8 canonical turns, 2 tool turns in Databus.
    expect(conv.turns()).toHaveLength(8)
    expect(bus.turns()).toHaveLength(2)

    const compressor = createMockAgent()
    const deps = makeDeps({
      compressor,
      mailbox,
      workingAgentId: 'main',
    })
    const coordinator = createDriveCoordinator(deps)

    // Tick at M1 (contextTokens >= 200K).
    await coordinator.tick({
      contextTokens: 250_000,
      conversation: conv,
      databus: bus,
    })

    // Compressor was called exactly once.
    expect(compressor.calls).toHaveLength(1)
    const call = compressor.calls[0]!

    // The delivered messages match block.messages (exact ChatMessage[]).
    const expectedBlock = findNextTaskBlock(turns)!
    expect(call.messages).toEqual([...expectedBlock.messages])
    expect(call.metadata).toMatchObject({ kind: 'compress', zone: 'M1' })

    // Canonical range evicted; envelope replacement inserted at the block
    // start (2026-09-13): 4 survivors + 1 envelope.
    expect(conv.turns()).toHaveLength(5)
    const envelope = conv.turns()[0]!
    expect(envelope.role).toBe('user')
    expect(envelope.id.startsWith('mem-')).toBe(true)
    const envContent = (envelope as { content: string }).content
    expect(envContent).toMatch(/^#STAMP S-/)
    expect(envContent).toContain('#LAYER M1')
    expect(envContent).toContain('#STATUS DONE')
    expect(envContent).toContain('[任务]')
    expect(envContent.endsWith('#END_BLOCK')).toBe(true)
    // The surviving turns start at u2 (the boundary), right after the envelope.
    expect(conv.turns()[1]!.role).toBe('user')
    expect((conv.turns()[1] as { content: string }).content).toBe('u2')

    // Databus: 方案 A — block compression does NOT evict databus; both tools stay.
    expect(bus.turns()).toHaveLength(2)
    expect(bus.turns().map(t => t.toolCallId).sort()).toEqual(['t1', 't2'])

    // Mailbox has a success notice.
    const inbox = mailbox.readOwnInbox('main')
    expect(inbox.length).toBeGreaterThanOrEqual(1)
    expect(inbox.some(m => m.subject.includes('compressed block'))).toBe(true)
  })

  it('no duplicate tool messages after eviction — surviving canonical is clean', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()

    const turns: ConversationTurn[] = [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'result1', 300),
      assistantTurn('a2', 400),
      userTurn('u2', 500),
      assistantTurn('a3', 600, [tc('t2')]),
      toolTurn('t2', 'result2', 700),
      assistantTurn('a4', 800),
    ]
    seed(conv, bus, turns)

    const coordinator = createDriveCoordinator(makeDeps({
      compressor: createMockAgent(),
    }))

    await coordinator.tick({
      contextTokens: 250_000,
      conversation: conv,
      databus: bus,
    })

    // Surviving canonical turns, mapped to messages, must not have duplicate tool messages.
    const survivingMessages = conv.turns().map(turnToMessage)
    const toolMessages = survivingMessages.filter(m => m.role === 'tool')
    expect(toolMessages).toHaveLength(1)
    expect((toolMessages[0] as { tool_call_id: string }).tool_call_id).toBe('t2')
  })
})

// ===========================================================================
// Item 9: drive failure
// ===========================================================================

describe('drive-coordinator: drive failure (item 9)', () => {
  it('compressor failure sends mailbox note and leaves stores unchanged', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    const mailbox = new Mailbox()

    const turns: ConversationTurn[] = [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'result1', 300),
      assistantTurn('a2', 400),
      userTurn('u2', 500),
    ]
    seed(conv, bus, turns)

    const failingCompressor = createMockAgent({ shouldThrow: true })
    const deps = makeDeps({
      compressor: failingCompressor,
      mailbox,
    })
    const coordinator = createDriveCoordinator(deps)

    await coordinator.tick({
      contextTokens: 250_000,
      conversation: conv,
      databus: bus,
    })

    // Compressor was called but threw.
    expect(failingCompressor.calls).toHaveLength(1)

    // Canonical memory is unchanged — nothing evicted.
    expect(conv.turns()).toHaveLength(5)

    // Databus is unchanged.
    expect(bus.turns()).toHaveLength(1)

    // Mailbox has a failure notice.
    const inbox = mailbox.readOwnInbox('main')
    expect(inbox.some(m => m.subject.includes('compression failed'))).toBe(true)
  })
})

// ===========================================================================
// Item 10: pairing regression after middle-range eviction
// ===========================================================================

describe('drive-coordinator: pairing regression (item 10)', () => {
  it('after eviction, surviving canonical has no leading tool, no orphan, no outstanding tool_call', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()

    // Three task blocks. Evict the middle one.
    const turns: ConversationTurn[] = [
      // Block 1
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'r1', 300),
      assistantTurn('a2', 400),
      // Block 2 (to be evicted)
      userTurn('u2', 500),
      assistantTurn('a3', 600, [tc('t2')]),
      toolTurn('t2', 'r2', 700),
      assistantTurn('a4', 800),
      // Block 3
      userTurn('u3', 900),
      assistantTurn('a5', 1000, [tc('t3')]),
      toolTurn('t3', 'r3', 1100),
      assistantTurn('a6', 1200),
    ]
    seed(conv, bus, turns)

    // Manually evict block 2 (indices 4..8).
    const removed = conv.evictRange(4, 8)
    expect(removed).toHaveLength(4)
    const removedToolIds = removed.filter(t => t.role === 'tool').map(t => t.id)
    bus.evictByIds(removedToolIds)

    // Surviving canonical: block1 (4 turns) + block3 (4 turns) = 8.
    const surviving = conv.turns()
    expect(surviving).toHaveLength(8)

    // No leading tool — first turn is user.
    expect(surviving[0]!.role).toBe('user')

    // Map to messages and check protocol order.
    const messages = surviving.map(turnToMessage)

    // No orphan tool results: every tool message has a preceding assistant tool_call.
    const outstandingToolCalls = new Set<string>()
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const c of msg.tool_calls) outstandingToolCalls.add(c.id)
      }
      if (msg.role === 'tool') {
        expect(outstandingToolCalls.has(msg.tool_call_id)).toBe(true)
        outstandingToolCalls.delete(msg.tool_call_id)
      }
    }
    // No outstanding tool_calls at the end.
    expect(outstandingToolCalls.size).toBe(0)

    // Databus has 2 tool turns (t1 and t3), t2 was evicted.
    expect(bus.turns()).toHaveLength(2)
    expect(bus.turns().map(t => t.toolCallId).sort()).toEqual(['t1', 't3'])
  })
})

// ===========================================================================
// Item 11: M1/M2/M3 drive tests
// ===========================================================================

describe('drive-coordinator: M1/M2/M3 zone behavior (item 11)', () => {
  it('M1 compression — compressor dispatched with zone M1', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    const mailbox = new Mailbox()

    seed(conv, bus, [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'r1', 300),
      assistantTurn('a2', 400),
      userTurn('u2', 500),
    ])

    const compressor = createMockAgent()
    const coordinator = createDriveCoordinator(makeDeps({ compressor, mailbox }))

    await coordinator.tick({ contextTokens: 210_000, conversation: conv, databus: bus })

    expect(compressor.calls).toHaveLength(1)
    expect(compressor.calls[0]!.metadata).toMatchObject({ kind: 'compress', zone: 'M1' })
    expect(conv.turns()).toHaveLength(2) // envelope + u2
    expect(conv.turns()[0]!.id.startsWith('mem-')).toBe(true)
    expect((conv.turns()[1] as { content: string }).content).toBe('u2')
    expect(bus.turns()).toHaveLength(1) // 方案 A: t1 stays in databus
    expect(mailbox.readOwnInbox('main').some(m => m.subject.includes('compressed'))).toBe(true)
  })

  it('M2 — sustained dispatch (200K–900K dead zone removed, 2026-09-16)', async () => {
    // 参考实现 context-amplifier 同源修复：M2 不再静默。旧设计 M1 只压跨越首块、
    // M2 整段下线，200K–900K 成压缩真空，长会话只压 1 块就一路涨到溢出。现在
    // M1/M2/M3 统一每 tick 压一块（zone='M1'）。seeded [u1,a1,t1,a2,u2] 是单个
    // 任务块（u1→u2）：首 tick 压掉它换成 mem- 信封 → [信封, u2]；次 tick 因 u2
    // 后无下个 user 边界 → 无可压块 → 不再派发。
    const conv = new ConversationMemory()
    const bus = new Databus()
    const mailbox = new Mailbox()

    seed(conv, bus, [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'r1', 300),
      assistantTurn('a2', 400),
      userTurn('u2', 500),
    ])

    const compressor = createMockAgent()
    const coordinator = createDriveCoordinator(makeDeps({ compressor, mailbox }))

    await coordinator.tick({ contextTokens: 550_000, conversation: conv, databus: bus })

    expect(compressor.calls).toHaveLength(1)
    // u1 块被压成信封，canonical 收缩为 [信封, u2]。
    expect(conv.turns()).toHaveLength(2)
    expect(conv.turns()[0]!.id.startsWith('mem-')).toBe(true)
    // 持续档：再 tick 一次，但已无可压块（u2 无下个 user 边界）→ 不再派发。
    await coordinator.tick({ contextTokens: 550_000, conversation: conv, databus: bus })
    expect(compressor.calls).toHaveLength(1)
    expect(conv.turns()).toHaveLength(2)
  })

  it('M3 archive — warehouse dispatched, curated blocks retained, mailbox pointer sent', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    const mailbox = new Mailbox()

    // StateLine has 2 M1 curated entries and 1 M2 entry.
    const m1Entries: StateLineEntry[] = [
      {
        task_goal: 'goal1',
        causal_steps: [],
        evidence_fragments: [],
        conclusion: 'c1',
        next_action: 'na1',
        working_state: {
          current_goal: 'g1',
          effective_decisions: [],
          rejected_decisions: [],
          architecture_boundaries: [],
          remaining_work: [],
        },
        _stamp: 's1',
      },
      {
        task_goal: 'goal2',
        causal_steps: [],
        evidence_fragments: [],
        conclusion: 'c2',
        next_action: 'na2',
        working_state: {
          current_goal: 'g2',
          effective_decisions: [],
          rejected_decisions: [],
          architecture_boundaries: [],
          remaining_work: [],
        },
        _stamp: 's2',
      },
    ]
    const m2Entries: StateLineEntry[] = [
      {
        task_goal: 'goal3',
        causal_steps: [],
        evidence_fragments: [],
        conclusion: 'c3',
        next_action: 'na3',
        working_state: {
          current_goal: 'g3',
          effective_decisions: [],
          rejected_decisions: [],
          architecture_boundaries: [],
          remaining_work: [],
        },
        _stamp: 's3',
      },
    ]

    const warehouse = createMockAgent()
    const stateLine = createMockStateLine({ entries: { M1: m1Entries, M2: m2Entries } })
    const coordinator = createDriveCoordinator(makeDeps({
      warehouse,
      stateLine,
      mailbox,
    }))

    await coordinator.tick({ contextTokens: 950_000, conversation: conv, databus: bus })

    // Warehouse was called once with an archive message.
    expect(warehouse.calls).toHaveLength(1)
    const archiveMsg = warehouse.calls[0]!.messages[0] as { role: string; content: string }
    expect(archiveMsg.role).toBe('user')
    // Stage 2b: the archive message now carries a per-block digest line
    // (stamp/goal/conclusion) instead of just a count.
    expect(archiveMsg.content).toContain('stamp=<s1>')
    expect(archiveMsg.content).toContain('goal=<goal1>')
    expect(archiveMsg.content).toContain('conclusion=<c1>')
    expect(archiveMsg.content).toContain('stamp=<s3>')
    expect(warehouse.calls[0]!.metadata).toMatchObject({ kind: 'archive', zone: 'M3' })
    // Stage 2b: metadata now carries sourceStamps and rawArchiveIds for the
    // M3 join chain (drive-coordinator → ctx → record_m3_summary → M3Summary).
    expect(warehouse.calls[0]!.metadata).toMatchObject({
      sourceStamps: ['s1', 's2', 's3'],
      rawArchiveIds: expect.any(Array),
    })
    // rawArchiveIds come from querying rawArchive by summaryStamps. The mock
    // stateLine has no raw archive records, so rawArchiveIds is empty.
    expect((warehouse.calls[0]!.metadata as { rawArchiveIds: string[] }).rawArchiveIds).toHaveLength(0)

    // Mailbox has M3 archive completed notice.
    const inbox = mailbox.readOwnInbox('main')
    expect(inbox.some(m => m.subject.includes('M3 archive completed'))).toBe(true)

    // Curated blocks remain on disk — the coordinator did not delete them.
    // (The stateLine.query still returns them — we verify no eviction happened.)
    expect(stateLine.query({ layer: 'M1' })).toHaveLength(2)
    expect(stateLine.query({ layer: 'M2' })).toHaveLength(1)
  })

  it('M3 墓碑：超长 task_goal 被截断、邮件必达且不超 mailbox 10K 硬限（2026-09-22）', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    const mailbox = new Mailbox()

    // 8 块（批上限）× 2000 字符 task_goal ≈ 16K——若原样进 body 必被
    // mailbox.deliver 的 10K 拒收，catch 吞掉 = 墓碑静默丢失。
    const longGoal = (tag: string): string => `${tag}-${'长目标内容'.repeat(300)}`
    const m1Entries: StateLineEntry[] = Array.from({ length: 8 }, (_, i) => ({
      task_goal: longGoal(`g${i}`),
      causal_steps: [],
      evidence_fragments: [],
      conclusion: `c${i}`,
      next_action: 'na',
      working_state: {
        current_goal: 'g',
        effective_decisions: [],
        rejected_decisions: [],
        architecture_boundaries: [],
        remaining_work: [],
      },
      _stamp: `s${i + 1}`,
    }))

    const warehouse = createMockAgent()
    const coordinator = createDriveCoordinator(makeDeps({
      warehouse,
      stateLine: createMockStateLine({ entries: { M1: m1Entries } }),
      mailbox,
    }))

    await coordinator.tick({ contextTokens: 950_000, conversation: conv, databus: bus })

    // 归档照常发生，墓碑邮件必须送达（不能被长度拒收后静默消失）。
    expect(warehouse.calls).toHaveLength(1)
    const mail = mailbox.readOwnInbox('main').find(m => m.subject.includes('M3 archive completed'))
    expect(mail).toBeDefined()
    // 双重防线：goal 截断 60 后 full 体远低于预算；即便未来文案膨胀，
    // fitMailBody 降级也保证 body ≤ 9000 < mailbox 的 10000 硬限。
    expect(mail!.body.length).toBeLessThan(10_000)
    expect(mail!.body.length).toBeLessThanOrEqual(MAIL_BODY_BUDGET)
    // goal 在第 61 字符处被截断：前 60 在、第 61 字之后的不在。
    expect(mail!.body).toContain(longGoal('g1').slice(0, 60))
    expect(mail!.body).not.toContain(longGoal('g1').slice(60, 120))
    expect(mail!.body).toContain('stamp=<s1>')
    expect(mail!.body).toContain('ask_recall')
  })

  it('fitMailBody 纯函数：预算内原样、超预算降级', () => {
    const full = 'x'.repeat(MAIL_BODY_BUDGET)
    const compact = 'compact'
    expect(fitMailBody(full, compact)).toBe(full)
    expect(fitMailBody(`${full}x`, compact)).toBe(compact)
  })

  it('M3 archive — metadata carries sourceStamps and rawArchiveIds from raw-archive join (stage 2b)', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    const mailbox = new Mailbox()

    // Two M1 entries with _stamps s1, s2.
    const m1Entries: StateLineEntry[] = [
      {
        task_goal: 'goal1', causal_steps: [], evidence_fragments: [],
        conclusion: 'c1', next_action: 'na1',
        working_state: {
          current_goal: 'g', effective_decisions: [], rejected_decisions: [],
          architecture_boundaries: [], remaining_work: [],
        },
        _stamp: 's1',
      },
      {
        task_goal: 'goal2', causal_steps: [], evidence_fragments: [],
        conclusion: 'c2', next_action: 'na2',
        working_state: {
          current_goal: 'g', effective_decisions: [], rejected_decisions: [],
          architecture_boundaries: [], remaining_work: [],
        },
        _stamp: 's2',
      },
    ]

    const warehouse = createMockAgent()

    // StateLine with pre-populated raw archive records keyed by summaryStamp.
    const stateLine = createMockStateLine({ entries: { M1: m1Entries, M2: [] } })
    // Seed two raw archive records whose summaryStamp matches the M1 _stamps.
    stateLine.rawArchiveRecords.push(
      {
        archiveId: 'RA-1', sourceTurnIds: ['t1'], messages: [],
        layer: 'M1', at: 100, summaryStamp: 's1',
      },
      {
        archiveId: 'RA-2', sourceTurnIds: ['t2'], messages: [],
        layer: 'M1', at: 200, summaryStamp: 's2',
      },
    )

    const coordinator = createDriveCoordinator(makeDeps({
      warehouse,
      stateLine,
      mailbox,
    }))

    await coordinator.tick({ contextTokens: 950_000, conversation: conv, databus: bus })

    expect(warehouse.calls).toHaveLength(1)
    const meta = warehouse.calls[0]!.metadata as {
      kind: string; zone: string; sourceStamps: string[]; rawArchiveIds: string[]
    }
    expect(meta.kind).toBe('archive')
    expect(meta.zone).toBe('M3')
    // sourceStamps = the _stamps of the M1 entries.
    expect(meta.sourceStamps).toEqual(['s1', 's2'])
    // rawArchiveIds = the archiveIds found by querying rawArchive({ summaryStamps }).
    expect(meta.rawArchiveIds).toEqual(['RA-1', 'RA-2'])

    // The archive message carries per-block digest lines.
    const content = (warehouse.calls[0]!.messages[0] as { content: string }).content
    expect(content).toContain('stamp=<s1>')
    expect(content).toContain('goal=<goal1>')
    expect(content).toContain('conclusion=<c1>')
    expect(content).toContain('stamp=<s2>')
  })

  it('M3 archive with no curated entries — warehouse not dispatched', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    const warehouse = createMockAgent()
    const coordinator = createDriveCoordinator(makeDeps({
      warehouse,
      stateLine: createMockStateLine({ entries: { M1: [], M2: [] } }),
    }))

    await coordinator.tick({ contextTokens: 950_000, conversation: conv, databus: bus })

    expect(warehouse.calls).toHaveLength(0)
  })

  it('M3 archive failure — mailbox note sent, curated blocks intact', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    const mailbox = new Mailbox()

    const m1Entries: StateLineEntry[] = [
      {
        task_goal: 'g1', causal_steps: [], evidence_fragments: [],
        conclusion: 'c', next_action: 'na',
        working_state: {
          current_goal: 'g', effective_decisions: [], rejected_decisions: [],
          architecture_boundaries: [], remaining_work: [],
        },
        _stamp: 's1',
      },
    ]

    const failingWarehouse = createMockAgent({ shouldThrow: true })
    const coordinator = createDriveCoordinator(makeDeps({
      warehouse: failingWarehouse,
      stateLine: createMockStateLine({ entries: { M1: m1Entries } }),
      mailbox,
    }))

    await coordinator.tick({ contextTokens: 950_000, conversation: conv, databus: bus })

    expect(failingWarehouse.calls).toHaveLength(1)
    const inbox = mailbox.readOwnInbox('main')
    expect(inbox.some(m => m.subject.includes('M3 archive failed'))).toBe(true)
  })
})

// ===========================================================================
// Item 12: end-to-end scripted test — layer crossings without working agent
// calling compression/archive tools
// ===========================================================================

describe('drive-coordinator: end-to-end scripted crossings (item 12)', () => {
  it('cross M1 then M3 — full-block delivery, persistence, exact eviction, archive retention', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    const mailbox = new Mailbox()

    // Two complete task blocks for compression.
    seed(conv, bus, [
      userTurn('task1', 100),
      assistantTurn('doing1', 200, [tc('tc-1')]),
      toolTurn('tc-1', 'result1', 300),
      assistantTurn('done1', 400),
      userTurn('task2', 500),
      assistantTurn('doing2', 600, [tc('tc-2')]),
      toolTurn('tc-2', 'result2', 700),
      assistantTurn('done2', 800),
    ])

    expect(conv.turns()).toHaveLength(8)
    expect(bus.turns()).toHaveLength(2)

    const compressor = createMockAgent()
    const warehouse = createMockAgent()

    // Mock StateLine that gains an M1 entry after compression (simulating
    // the coordinator's appendBlock persisting during dispatchCompression).
    let m1Count = 0
    const rawArchiveRecords: RawArchiveRecord[] = []
    const stateLine: StateLine & { rawArchiveRecords: RawArchiveRecord[] } = {
      compressor: {
        async appendBlock() { m1Count += 1 },
      },
      warehouse: { async appendSummary() {}, async queryM3() { return { ok: false, error: 'mock' } } },
      rawArchive: {
        async append(record: RawArchiveRecord) { rawArchiveRecords.push(record) },
        async query(filter: { sourceTurnIds?: string[]; layer?: 'M1' | 'M2'; archiveIds?: string[]; summaryStamps?: string[]; limit?: number }) {
          let results = [...rawArchiveRecords]
          if (filter.layer !== undefined) results = results.filter(r => r.layer === filter.layer)
          if (filter.sourceTurnIds !== undefined) {
            const wanted = new Set(filter.sourceTurnIds)
            results = results.filter(r => r.sourceTurnIds.some(id => wanted.has(id)))
          }
          if (filter.archiveIds !== undefined) {
            const wanted = new Set(filter.archiveIds)
            results = results.filter(r => wanted.has(r.archiveId))
          }
          if (filter.summaryStamps !== undefined) {
            const wanted = new Set(filter.summaryStamps)
            results = results.filter(r => wanted.has(r.summaryStamp))
          }
          if (filter.limit !== undefined) results = results.slice(0, filter.limit)
          return results
        },
      },
      query(filter) {
        if (filter?.layer === 'M1') {
          return Array(m1Count).fill(null).map((_, i) => ({
            task_goal: `goal${i}`, causal_steps: [], evidence_fragments: [],
            conclusion: 'c', next_action: 'na',
            working_state: {
              current_goal: 'g', effective_decisions: [], rejected_decisions: [],
              architecture_boundaries: [], remaining_work: [],
            },
            _stamp: `s${i}`,
          })) as StateLineEntry[]
        }
        return []
      },
      subscribe: () => () => {},
      close() {},
      rawArchiveRecords,
    }

    // v0.12.4: the compressor returns CuratedMemory JSON as its reply. The
    // coordinator parses it and calls appendBlock itself — so the mock
    // stateLine's appendBlock (which increments m1Count) is invoked by the
    // coordinator, not by the compressor. No persistingCompressor wrapper
    // is needed.
    const coordinator = createDriveCoordinator(makeDeps({
      compressor,
      warehouse,
      stateLine,
      mailbox,
    }))

    // --- Phase 1: cross M1 (200K threshold) ---
    await coordinator.tick({ contextTokens: 210_000, conversation: conv, databus: bus })

    // Compressor received the exact first block (4 messages).
    expect(compressor.calls).toHaveLength(1)
    expect(compressor.calls[0]!.messages).toHaveLength(4)
    expect(compressor.calls[0]!.metadata).toMatchObject({ kind: 'compress', zone: 'M1' })

    // First block evicted from canonical; envelope replacement at the block start.
    expect(conv.turns()).toHaveLength(5) // [envelope, u2, a3, t2, a4]
    expect(conv.turns()[0]!.id.startsWith('mem-')).toBe(true)
    // 方案 A: both tools stay in databus (tc-1 was in the compressed block).
    expect(bus.turns()).toHaveLength(2)
    expect(bus.turns().map(t => t.toolCallId).sort()).toEqual(['tc-1', 'tc-2'])

    // Mailbox has compression notice.
    expect(mailbox.readOwnInbox('main').some(m => m.subject.includes('compressed'))).toBe(true)

    // Surviving canonical messages preserve protocol order (envelope first).
    const survivingMsgs = conv.turns().map(turnToMessage)
    expect(survivingMsgs[0]!.role).toBe('user') // envelope
    expect(survivingMsgs[1]!.role).toBe('user') // u2
    expect(survivingMsgs[2]!.role).toBe('assistant')
    expect(survivingMsgs[3]!.role).toBe('tool')
    expect(survivingMsgs[4]!.role).toBe('assistant')

    // --- Phase 2: cross M3 (900K threshold) ---
    // The mock stateLine now has 1 M1 entry (m1Count was incremented by appendBlock).
    await coordinator.tick({ contextTokens: 950_000, conversation: conv, databus: bus })

    // Warehouse was dispatched for archive.
    expect(warehouse.calls).toHaveLength(1)
    expect(warehouse.calls[0]!.metadata).toMatchObject({ kind: 'archive', zone: 'M3' })
    const archiveContent = (warehouse.calls[0]!.messages[0] as { content: string }).content
    // Stage 2b: digest line for the single M1 block (stamp=s0).
    expect(archiveContent).toContain('stamp=<s0>')

    // Mailbox has M3 archive completed notice.
    const allMail = mailbox.readOwnInbox('main')
    expect(allMail.some(m => m.subject.includes('M3 archive completed'))).toBe(true)

    // Curated blocks remain queryable (retained on disk).
    expect(stateLine.query({ layer: 'M1' }).length).toBeGreaterThanOrEqual(1)

    // The working agent never called any compression/archive tool — the coordinator
    // dispatched autonomously. (The mock agents' calls are from the coordinator only.)
    expect(compressor.calls).toHaveLength(1) // still just the M1 compression
  })

  it('noop coordinator never dispatches', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    seed(conv, bus, [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'r1', 300),
      assistantTurn('a2', 400),
      userTurn('u2', 500),
    ])

    const noop = createNoopDriveCoordinator()
    await noop.tick({ contextTokens: 950_000, conversation: conv, databus: bus })
    noop.stop()

    // Nothing changed.
    expect(conv.turns()).toHaveLength(5)
    expect(bus.turns()).toHaveLength(1)
  })

  it('stop() prevents further ticks', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    seed(conv, bus, [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'r1', 300),
      assistantTurn('a2', 400),
      userTurn('u2', 500),
    ])

    const compressor = createMockAgent()
    const coordinator = createDriveCoordinator(makeDeps({ compressor }))
    coordinator.stop()

    await coordinator.tick({ contextTokens: 250_000, conversation: conv, databus: bus })

    expect(compressor.calls).toHaveLength(0)
    expect(conv.turns()).toHaveLength(5)
  })

  it('does not re-dispatch when layer has not crossed (same layer, no in-flight)', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    seed(conv, bus, [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'r1', 300),
      assistantTurn('a2', 400),
      userTurn('u2', 500),
    ])

    const compressor = createMockAgent()
    const coordinator = createDriveCoordinator(makeDeps({ compressor }))

    // First tick at M1 — dispatches.
    await coordinator.tick({ contextTokens: 210_000, conversation: conv, databus: bus })
    expect(compressor.calls).toHaveLength(1)

    // Second tick at M1 — same layer, no in-flight → no dispatch.
    // (conv now has 1 turn after eviction — no eligible block anyway, but the
    // early-return on same-layer should prevent even calling findNextTaskBlock.)
    await coordinator.tick({ contextTokens: 220_000, conversation: conv, databus: bus })
    expect(compressor.calls).toHaveLength(1)
  })
})

// ===========================================================================
// M3 sustained compression drive — context must be able to fall back below
// the 900K archive threshold. M3 is the terminal layer: there is no higher
// layer to cross into, so crossing-only dispatch would strand the canonical
// memory at high-water until the 1M token guard ends the session.
// ===========================================================================

describe('drive-coordinator: M3 sustained compression drive', () => {
  // Two complete task blocks plus a trailing user turn (the in-progress span
  // that must NOT be compressed — no next-user boundary yet).
  const seedTwoBlocks = (conv: ConversationMemory, bus: Databus): void => {
    seed(conv, bus, [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'r1', 300),
      assistantTurn('a2', 400),
      userTurn('u2', 500),
      assistantTurn('a3', 600, [tc('t2')]),
      toolTurn('t2', 'r2', 700),
      assistantTurn('a4', 800),
      userTurn('u3', 900),
    ])
  }

  it('compresses an eligible block on the crossing tick into M3', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    seedTwoBlocks(conv, bus)

    const compressor = createMockAgent()
    const coordinator = createDriveCoordinator(makeDeps({
      compressor,
      stateLine: createMockStateLine({ entries: { M1: [], M2: [] } }),
    }))

    await coordinator.tick({ contextTokens: 950_000, conversation: conv, databus: bus })

    expect(compressor.calls).toHaveLength(1)
    // M2 形态未上线（2026-09-12 下线），M3 sustained 回落唯一可用档 M1。
    expect(compressor.calls[0]!.metadata).toMatchObject({ kind: 'compress', zone: 'M1' })

    // First block evicted; envelope at block start: [envelope, u2, a3, t2, a4, u3].
    expect(conv.turns()).toHaveLength(6)
    expect(conv.turns()[0]!.id.startsWith('mem-')).toBe(true)
    expect((conv.turns()[1] as { content: string }).content).toBe('u2')
    // 方案 A: both tools stay (t1 was in the compressed block).
    expect(bus.turns()).toHaveLength(2)
    expect(bus.turns().map(t => t.toolCallId).sort()).toEqual(['t1', 't2'])
  })

  it('keeps compressing on later M3 ticks without a new crossing', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    seedTwoBlocks(conv, bus)

    const compressor = createMockAgent()
    const coordinator = createDriveCoordinator(makeDeps({
      compressor,
      stateLine: createMockStateLine({ entries: { M1: [], M2: [] } }),
    }))

    await coordinator.tick({ contextTokens: 950_000, conversation: conv, databus: bus })
    // Second tick at the SAME layer — the crossing guard must not suppress it.
    await coordinator.tick({ contextTokens: 950_000, conversation: conv, databus: bus })

    expect(compressor.calls).toHaveLength(2)
    // M2 形态未上线（2026-09-12 下线），M3 sustained 回落唯一可用档 M1。
    expect(compressor.calls[1]!.metadata).toMatchObject({ kind: 'compress', zone: 'M1' })

    // Both complete blocks evicted; two envelopes remain at the block starts,
    // plus the in-progress trailing user turn (no next-user boundary, so it is
    // not a compressible block). findNextTaskBlock skips 'mem-' turns, so the
    // second tick compressed block 2 — not the first envelope.
    expect(conv.turns()).toHaveLength(3)
    expect(conv.turns()[0]!.id.startsWith('mem-')).toBe(true)
    expect(conv.turns()[1]!.id.startsWith('mem-')).toBe(true)
    expect(conv.turns()[2]!.role).toBe('user')
    expect((conv.turns()[2] as { content: string }).content).toBe('u3')
    expect(compressor.calls[1]!.messages).toHaveLength(4) // block 2, not the envelope
    // 方案 A: all tools remain in databus after both compressions.
    expect(bus.turns().length).toBeGreaterThan(0)
  })

  it('incremental archive — batches ≤ M3_BATCH_SIZE; indexed stamps are not re-archived on later ticks; failures retry', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    seedTwoBlocks(conv, bus)

    // 11 个 M1 curated 块（s1..s11）：第一批 8 个，第二批 3 个，第三批无。
    const m1Entries: StateLineEntry[] = Array.from({ length: 11 }, (_, i) => ({
      task_goal: `goal${i + 1}`, causal_steps: [], evidence_fragments: [],
      conclusion: 'c', next_action: 'na',
      working_state: {
        current_goal: 'g', effective_decisions: [], rejected_decisions: [],
        architecture_boundaries: [], remaining_work: [],
      },
      _stamp: `s${i + 1}`,
    })) as StateLineEntry[]

    const stateLine = createMockStateLine({ entries: { M1: m1Entries, M2: [] } })
    const runs: Array<{ messages: ChatMessage[]; metadata?: Record<string, unknown> | undefined }> = []
    // warehouse mock 模拟 record_m3_summary 的落盘面：归档批成功 → 把这些戳
    // 写进 M3 摘要（appendSummary），下一 tick 的"已索引集合"就能看到。
    const warehouse: SystemAgent = {
      async run(input) {
        runs.push(input)
        const meta = input.metadata as { kind?: string; sourceStamps?: string[] } | undefined
        if (meta?.kind === 'archive' && Array.isArray(meta.sourceStamps)) {
          for (const s of meta.sourceStamps) {
            await stateLine.warehouse.appendSummary({
              stamp: `M3-${s}`, m1_stamp: '', summary_text: 'sum', layer: 'M3',
              at: Date.now(), source_summary_stamps: [s],
            })
          }
        }
        return {
          output: 'archived',
          metrics: { rounds: 1, toolCalls: 0, toolErrors: 0, guardTrips: 0, tokensUsed: 0 } as never,
          finalState: 'Running' as never,
          reason: 'completed' as const,
          hits: [],
        }
      },
      stop() {},
      send() {},
    }

    const coordinator = createDriveCoordinator(makeDeps({
      warehouse,
      compressor: createMockAgent(),
      stateLine,
    }))

    // Tick 1：归档最旧的 8 块（批上限）。
    await coordinator.tick({ contextTokens: 950_000, conversation: conv, databus: bus })
    expect(runs).toHaveLength(1)
    expect((runs[0]!.metadata as unknown as { sourceStamps: string[] }).sourceStamps).toEqual(
      ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'],
    )

    // Tick 2：s1..s8 已在已索引集合 → 只补最旧的未索引 3 块。
    await coordinator.tick({ contextTokens: 950_000, conversation: conv, databus: bus })
    expect(runs).toHaveLength(2)
    expect((runs[1]!.metadata as unknown as { sourceStamps: string[] }).sourceStamps).toEqual(['s9', 's10', 's11'])

    // Tick 3：全部已索引 → 不再派发（每 tick 检查，无新工作即返回）。
    await coordinator.tick({ contextTokens: 950_000, conversation: conv, databus: bus })
    expect(runs).toHaveLength(2)
  })

  it('M3 archive failure — not consumed: next M3 tick retries the same batch', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    const mailbox = new Mailbox()

    const m1Entries: StateLineEntry[] = [
      {
        task_goal: 'g1', causal_steps: [], evidence_fragments: [],
        conclusion: 'c', next_action: 'na',
        working_state: {
          current_goal: 'g', effective_decisions: [], rejected_decisions: [],
          architecture_boundaries: [], remaining_work: [],
        },
        _stamp: 's1',
      },
    ]

    // 第一次 throw（模拟仓库临时故障），第二次成功。
    let archiveCalls = 0
    const flakyWarehouse: SystemAgent = {
      async run(input) {
        archiveCalls += 1
        if (archiveCalls === 1) throw new Error('transient M3 warehouse failure')
        return {
          output: 'archived',
          metrics: { rounds: 1 } as never,
          finalState: 'Running' as never,
          reason: 'completed' as const,
          hits: [],
        }
      },
      stop() {},
      send() {},
    }

    const coordinator = createDriveCoordinator(makeDeps({
      warehouse: flakyWarehouse,
      stateLine: createMockStateLine({ entries: { M1: m1Entries } }),
      mailbox,
    }))

    // Tick 1：失败 → 失败通知，块未被索引（不消费）。
    await coordinator.tick({ contextTokens: 950_000, conversation: conv, databus: bus })
    expect(archiveCalls).toBe(1)
    expect(mailbox.readOwnInbox('main').some(m => m.subject.includes('M3 archive failed'))).toBe(true)

    // Tick 2（同层 M3）：前一批失败未消费 → 自动重试并成功。
    await coordinator.tick({ contextTokens: 950_000, conversation: conv, databus: bus })
    expect(archiveCalls).toBe(2)
    // 成功不再刷失败通知（consecutive 已清零）。
    expect(mailbox.readOwnInbox('main').some(m => m.subject.includes('M3 archive failed'))).toBe(true) // 仅第一次那封
    expect(mailbox.readOwnInbox('main').some(m => m.subject.includes('M3 archive completed'))).toBe(true)
  })
})

// ===========================================================================
// Raw archive: full canonical history is persisted BEFORE eviction so
// compressed turns remain recallable for M3 deep recall.
// ===========================================================================

describe('drive-coordinator: raw archive before eviction', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raw-archive-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('evicted block messages are recallable from stateLine.rawArchive after compression', async () => {
    // End-to-end: real createStateLine + real drive-coordinator + mock
    // compressor (whose run succeeds → triggers archive + evict).
    const conv = new ConversationMemory()
    const bus = new Databus()
    const stateLine = createStateLine({ databusPath: tmpDir })

    const turns: ConversationTurn[] = [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'result1', 300),
      assistantTurn('a2', 400),
      userTurn('u2', 500),
      assistantTurn('a3', 600, [tc('t2')]),
      toolTurn('t2', 'result2', 700),
      assistantTurn('a4', 800),
    ]
    seed(conv, bus, turns)

    // Record the first block's turn ids before eviction — these are the
    // sourceTurnIds the archive should be keyed by.
    const expectedBlock = findNextTaskBlock(turns)!
    const expectedSourceTurnIds = expectedBlock.turns.map(t => t.id)

    const coordinator = createDriveCoordinator(makeDeps({
      compressor: createMockAgent(),
      stateLine,
    }))

    await coordinator.tick({ contextTokens: 250_000, conversation: conv, databus: bus })

    // The first block was evicted; the envelope replacement remains.
    expect(conv.turns()).toHaveLength(5)
    expect(conv.turns()[0]!.id.startsWith('mem-')).toBe(true)

    // The raw archive has one record, keyed by the evicted block's turn ids.
    const archived = await stateLine.rawArchive.query({ sourceTurnIds: expectedSourceTurnIds })
    expect(archived).toHaveLength(1)
    const record = archived[0]!
    expect(record.layer).toBe('M1')
    expect(record.sourceTurnIds).toEqual(expectedSourceTurnIds)

    // The archived messages preserve the full role sequence and content.
    expect(record.messages).toHaveLength(4)
    expect(record.messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect((record.messages[0] as { content: string }).content).toBe('u1')
    expect((record.messages[2] as { tool_call_id: string }).tool_call_id).toBe('t1')
    expect((record.messages[2] as { content: string }).content).toBe('result1')
  })

  it('raw archive append happens BEFORE eviction — query works even after canonical is empty', async () => {
    // Use a mock stateLine that records the order of rawArchive.append
    // relative to conversation.evictRange. We assert the archive is present
    // immediately after tick returns (eviction already happened), proving
    // append completed before evictRange ran within the same awaited tick.
    const conv = new ConversationMemory()
    const bus = new Databus()

    const turns: ConversationTurn[] = [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'r1', 300),
      assistantTurn('a2', 400),
      userTurn('u2', 500),
    ]
    seed(conv, bus, turns)

    const expectedBlock = findNextTaskBlock(turns)!
    const expectedSourceTurnIds = expectedBlock.turns.map(t => t.id)

    const mockSl = createMockStateLine()
    const coordinator = createDriveCoordinator(makeDeps({
      compressor: createMockAgent(),
      stateLine: mockSl,
    }))

    await coordinator.tick({ contextTokens: 250_000, conversation: conv, databus: bus })

    // Eviction happened; canonical = envelope + trailing u2.
    expect(conv.turns()).toHaveLength(2)
    expect(conv.turns()[0]!.id.startsWith('mem-')).toBe(true)

    // The mock stateLine recorded exactly one rawArchive.append, and its
    // sourceTurnIds match the evicted block. Because the tick was awaited
    // and append precedes evictRange in dispatchCompression, the record is
    // already present when we query here.
    expect(mockSl.rawArchiveRecords).toHaveLength(1)
    expect(mockSl.rawArchiveRecords[0]!.sourceTurnIds).toEqual(expectedSourceTurnIds)

    // Query by one of the source turn ids returns the record.
    const found = await mockSl.rawArchive.query({ sourceTurnIds: [expectedSourceTurnIds[0]!] })
    expect(found).toHaveLength(1)
    expect(found[0]!.messages).toHaveLength(4)
  })

  it('raw archive append failure aborts eviction — canonical memory stays intact', async () => {
    // If rawArchive.append throws, dispatchCompression's try/catch catches
    // it and evictRange never runs. Canonical memory and Databus are left
    // unchanged. This is the atomicity guarantee: archive failure does not
    // cause data loss.
    const conv = new ConversationMemory()
    const bus = new Databus()

    const turns: ConversationTurn[] = [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'r1', 300),
      assistantTurn('a2', 400),
      userTurn('u2', 500),
    ]
    seed(conv, bus, turns)

    const mockSl = createMockStateLine({ rawArchiveShouldThrow: true })
    const mailbox = new Mailbox()
    const coordinator = createDriveCoordinator(makeDeps({
      compressor: createMockAgent(),
      stateLine: mockSl,
      mailbox,
    }))

    await coordinator.tick({ contextTokens: 250_000, conversation: conv, databus: bus })

    // Nothing was evicted — canonical and Databus intact.
    expect(conv.turns()).toHaveLength(5)
    expect(bus.turns()).toHaveLength(1)

    // No raw archive record was committed (append threw before persistence).
    expect(mockSl.rawArchiveRecords).toHaveLength(0)

    // A failure mailbox notice was sent.
    const inbox = mailbox.readOwnInbox('main')
    expect(inbox.some(m => m.subject.includes('compression failed'))).toBe(true)
  })

  it('raw archive summaryStamp equals the CuratedMemory block _stamp (v0.12.4 correlation)', async () => {
    // v0.12.4: the coordinator pre-generates one stamp and passes it to both
    // appendBlock (→ CuratedMemory _stamp) and rawArchive.append (→ summaryStamp).
    // The compressor only returns JSON; it does not touch the stamp. After the
    // tick, the raw archive record's summaryStamp must equal the persisted
    // block's _stamp — proving the coordinator's stamp correlates the two.
    const conv = new ConversationMemory()
    const bus = new Databus()
    const stateLine = createStateLine({ databusPath: tmpDir })

    const turns: ConversationTurn[] = [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'r1', 300),
      assistantTurn('a2', 400),
      userTurn('u2', 500),
    ]
    seed(conv, bus, turns)

    const expectedBlock = findNextTaskBlock(turns)!
    const expectedSourceTurnIds = expectedBlock.turns.map(t => t.id)

    // The mock compressor returns valid CuratedMemory JSON (default). The
    // coordinator parses it, validates it, and calls appendBlock(parsed, 'M1',
    // stamp) + rawArchive.append({ summaryStamp: stamp }) atomically.
    const coordinator = createDriveCoordinator(makeDeps({
      compressor: createMockAgent(),
      stateLine,
    }))

    await coordinator.tick({ contextTokens: 250_000, conversation: conv, databus: bus })

    // The raw archive has one record.
    const archived = await stateLine.rawArchive.query({ sourceTurnIds: expectedSourceTurnIds })
    expect(archived).toHaveLength(1)
    const archiveRecord = archived[0]!

    // The CuratedMemory block was persisted with the same stamp.
    const blocks = stateLine.query({ layer: 'M1' })
    expect(blocks).toHaveLength(1)
    const blockEntry = blocks[0] as CuratedMemory & { _stamp?: string }
    const blockStamp = blockEntry._stamp

    // The correlation: summaryStamp on the raw archive equals the block's _stamp.
    expect(archiveRecord.summaryStamp).toBeDefined()
    expect(archiveRecord.summaryStamp).toBe(blockStamp)
  })
})

// ===========================================================================
// v0.12.4: compressor produces CuratedMemory JSON — coordinator parses +
// persists atomically. Robustness and failure semantics.
// ===========================================================================

describe('drive-coordinator: compressor JSON reply parsing (v0.12.4)', () => {
  // Shared seed: one complete task block + boundary user turn.
  const seedBlock = (conv: ConversationMemory, bus: Databus): void => {
    seed(conv, bus, [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'r1', 300),
      assistantTurn('a2', 400),
      userTurn('u2', 500),
    ])
  }

  it('parses pure-JSON compressor reply and persists + evicts', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    const mailbox = new Mailbox()
    seedBlock(conv, bus)

    // Compressor returns pure JSON (no fences).
    const compressor = createMockAgent()
    const sl = createMockStateLine()
    const coordinator = createDriveCoordinator(makeDeps({ compressor, stateLine: sl, mailbox }))

    await coordinator.tick({ contextTokens: 250_000, conversation: conv, databus: bus })

    // appendBlock was called by the coordinator (mock records nothing, but
    // eviction proves the atomic sequence ran past appendBlock).
    expect(conv.turns()).toHaveLength(2) // envelope + u2
    expect(conv.turns()[0]!.id.startsWith('mem-')).toBe(true)
    expect(bus.turns()).toHaveLength(1) // 方案 A: t1 stays in databus
    expect(mailbox.readOwnInbox('main').some(m => m.subject.includes('compressed block'))).toBe(true)
  })

  it('uses the submit_curated_memory payload and persists + evicts', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    const mailbox = new Mailbox()
    seedBlock(conv, bus)

    // v0.42: 生产结果是 submit_curated_memory 的 memory 参数（服务端 schema
    // 约束的 JSON 对象），不再是自由文本回复。
    const compressor = createMockAgent({ submitted: curatedMemory })
    const sl = createMockStateLine()
    const coordinator = createDriveCoordinator(makeDeps({ compressor, stateLine: sl, mailbox }))

    await coordinator.tick({ contextTokens: 250_000, conversation: conv, databus: bus })

    // The payload was taken as-is, block persisted, range evicted.
    expect(conv.turns()).toHaveLength(2) // envelope + u2
    expect(conv.turns()[0]!.id.startsWith('mem-')).toBe(true)
    expect(bus.turns()).toHaveLength(1) // 方案 A: t1 stays
    expect(mailbox.readOwnInbox('main').some(m => m.subject.includes('compressed block'))).toBe(true)
  })

  it('no submission (compressor never called submit_curated_memory): no eviction, no raw archive write, mailbox failure notice', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    const mailbox = new Mailbox()
    seedBlock(conv, bus)

    // Compressor ended its run without submitting (v0.42: 无提交 = 失败，等效
    // 于旧"回复既不是 JSON 也没有围栏"）。
    const compressor = createMockAgent({ submitted: undefined })
    const sl = createMockStateLine()
    const coordinator = createDriveCoordinator(makeDeps({ compressor, stateLine: sl, mailbox }))

    await coordinator.tick({ contextTokens: 250_000, conversation: conv, databus: bus })

    // Nothing evicted — canonical and Databus intact.
    expect(conv.turns()).toHaveLength(5)
    expect(bus.turns()).toHaveLength(1)
    // No raw archive record committed (failure aborted before appendBlock).
    expect(sl.rawArchiveRecords).toHaveLength(0)
    // Mailbox has a failure notice.
    expect(mailbox.readOwnInbox('main').some(m => m.subject.includes('compression failed'))).toBe(true)
  })

  it('schema validation failure (missing required field): no eviction, mailbox failure notice', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    const mailbox = new Mailbox()
    seedBlock(conv, bus)

    // Submitted payload missing required fields (no task_goal, no working_state).
    // 协调器持久化前显式 validateCuratedMemory（与旧 parse 路径同门槛）。
    const compressor = createMockAgent({ submitted: { conclusion: 'incomplete' } })
    const sl = createMockStateLine()
    const coordinator = createDriveCoordinator(makeDeps({ compressor, stateLine: sl, mailbox }))

    await coordinator.tick({ contextTokens: 250_000, conversation: conv, databus: bus })

    // Validation threw → catch → no eviction.
    expect(conv.turns()).toHaveLength(5)
    expect(bus.turns()).toHaveLength(1)
    expect(sl.rawArchiveRecords).toHaveLength(0)
    expect(mailbox.readOwnInbox('main').some(m => m.subject.includes('compression failed'))).toBe(true)
  })

  it('empty submission payload: no eviction, mailbox failure notice', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    const mailbox = new Mailbox()
    seedBlock(conv, bus)

    // Compressor submitted nothing usable (undefined submitted = 未调用工具).
    const compressor = createMockAgent({ submitted: undefined })
    const sl = createMockStateLine()
    const coordinator = createDriveCoordinator(makeDeps({ compressor, stateLine: sl, mailbox }))

    await coordinator.tick({ contextTokens: 250_000, conversation: conv, databus: bus })

    expect(conv.turns()).toHaveLength(5)
    expect(bus.turns()).toHaveLength(1)
    expect(sl.rawArchiveRecords).toHaveLength(0)
    expect(mailbox.readOwnInbox('main').some(m => m.subject.includes('compression failed'))).toBe(true)
  })
})

// ===========================================================================
// parseCuratedMemoryOutput unit tests — direct parser robustness.
// ===========================================================================

describe('parseCuratedMemoryOutput (unit)', () => {
  const validBlock: CuratedMemory = {
    task_goal: 'g',
    causal_steps: [{ intent: 'i', tool_action: 't', result: 'r' }],
    evidence_fragments: [{ source: 's', fragment: 'f', relevance: 'rel' }],
    conclusion: 'c',
    next_action: 'na',
    working_state: {
      current_goal: 'cg',
      effective_decisions: [],
      rejected_decisions: [],
      architecture_boundaries: [],
      remaining_work: [],
    },
  }

  it('parses pure JSON', () => {
    const parsed = parseCuratedMemoryOutput(JSON.stringify(validBlock))
    expect(parsed.task_goal).toBe('g')
  })

  it('parses ```json-fenced JSON', () => {
    const fenced = '```json\n' + JSON.stringify(validBlock) + '\n```'
    const parsed = parseCuratedMemoryOutput(fenced)
    expect(parsed.task_goal).toBe('g')
  })

  it('parses bare ```-fenced JSON (no language tag)', () => {
    const fenced = '```\n' + JSON.stringify(validBlock) + '\n```'
    const parsed = parseCuratedMemoryOutput(fenced)
    expect(parsed.task_goal).toBe('g')
  })

  it('throws on non-string input', () => {
    expect(() => parseCuratedMemoryOutput(undefined)).toThrow('no reply text')
    expect(() => parseCuratedMemoryOutput(123)).toThrow('no reply text')
  })

  it('throws on empty string', () => {
    expect(() => parseCuratedMemoryOutput('')).toThrow('empty')
    expect(() => parseCuratedMemoryOutput('   ')).toThrow('empty')
  })

  it('throws on non-JSON without fence', () => {
    expect(() => parseCuratedMemoryOutput('not json')).toThrow('not valid JSON')
  })

  it('throws on fenced non-JSON', () => {
    expect(() => parseCuratedMemoryOutput('```json\nnot json\n```')).toThrow('not valid JSON')
  })

  it('throws on valid JSON missing required fields', () => {
    expect(() => parseCuratedMemoryOutput(JSON.stringify({ conclusion: 'x' }))).toThrow('missing required field')
  })
})

// ===========================================================================
// 2026-09-11: crossing consumption semantics — no-eligible-block keeps the
// crossing (retried on a later tick); success/failure consume it.
// ===========================================================================

describe('drive-coordinator: no-eligible-block does not consume the crossing', () => {
  it('retries on a later tick once the block is closed by the next user turn', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    const compressor = createMockAgent()
    const coordinator = createDriveCoordinator(makeDeps({ compressor }))

    // Incomplete span: one user turn + a tool cycle — no next-user boundary.
    seed(conv, bus, [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'r1', 300),
    ])

    // Tick #1 at M1 (the M0→M1 crossing): dispatch attempted → no eligible
    // block. The crossing must NOT be consumed.
    await coordinator.tick({ contextTokens: 210_000, conversation: conv, databus: bus })
    expect(compressor.calls).toHaveLength(0)

    // The next user turn closes the span into an eligible block.
    appendCanonicalTurn(conv, bus, userTurn('u2', 400))

    // Tick #2 at the SAME layer: the kept crossing retries and compresses.
    await coordinator.tick({ contextTokens: 215_000, conversation: conv, databus: bus })
    expect(compressor.calls).toHaveLength(1)
    expect(compressor.calls[0]!.metadata).toMatchObject({ kind: 'compress', zone: 'M1' })

    // First block evicted — envelope + the boundary user turn survive.
    expect(conv.turns()).toHaveLength(2)
    expect(conv.turns()[0]!.id.startsWith('mem-')).toBe(true)
    expect((conv.turns()[1] as { content: string }).content).toBe('u2')
    expect(bus.turns()).toHaveLength(1) // 方案 A: t1 stays
  })

  it('failure does NOT consume the crossing; failed block is skipped on next tick (no eligible block left)', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    const failing = createMockAgent({ shouldThrow: true })
    const coordinator = createDriveCoordinator(makeDeps({ compressor: failing }))

    seed(conv, bus, [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'r1', 300),
      assistantTurn('a2', 400),
      userTurn('u2', 500),
    ])

    // First tick: block u1 fails → failedBlockIds={u1}, crossing NOT consumed.
    await coordinator.tick({ contextTokens: 210_000, conversation: conv, databus: bus })
    expect(failing.calls).toHaveLength(1)

    // Second tick: crossing still live (lastLayer=M0), findNextTaskBlock skips
    // u1 (in failedBlockIds), no more blocks → no-eligible-block, no LLM call.
    await coordinator.tick({ contextTokens: 215_000, conversation: conv, databus: bus })
    expect(failing.calls).toHaveLength(1) // no new call — block skipped, not retried
  })

  it('block A failure does not prevent block B from being compressed on the next tick', async () => {
    // 核心 bug 修复验证：前一块失败不影响后面块的压缩。
    // 旧行为：块 A 失败 → lastLayer='M1'（跨越位消费）→ 块 B 永远不被尝试。
    // 新行为：块 A 失败 → failedBlockIds={A}，跨越位保留 → 下一 tick 跳过 A，压 B。
    const conv = new ConversationMemory()
    const bus = new Databus()

    // 两个完整任务块：A=[u1,a1,t1,a2] B=[u2,a3,t2,a4]，边界 u3。
    const turns: ConversationTurn[] = [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'r1', 300),
      assistantTurn('a2', 400),
      userTurn('u2', 500),
      assistantTurn('a3', 600, [tc('t2')]),
      toolTurn('t2', 'r2', 700),
      assistantTurn('a4', 800),
      userTurn('u3', 900),
    ]
    seed(conv, bus, turns)

    // 压缩器：第一次调用抛错（块 A），第二次正常返回（块 B）。
    let callCount = 0
    const selectiveCompressor: SystemAgent = {
      async run(input) {
        callCount++
        if (callCount === 1) throw new Error('transient failure on block A')
        return {
          output: '',
          submitted: curatedMemory,
          metrics: { rounds: 1, toolCalls: 0, toolErrors: 0, guardTrips: 0, tokensUsed: 0 } as any,
          finalState: 'Running' as any,
          reason: 'completed' as const,
          hits: [],
        }
      },
      stop() {},
      send() {},
    } as SystemAgent

    const coordinator = createDriveCoordinator(makeDeps({ compressor: selectiveCompressor }))

    // Tick 1：跨越 M0→M1，块 A 被选中，压缩失败。
    // 新行为：failedBlockIds={u1}，跨越位不消费（lastLayer 仍为 M0）。
    await coordinator.tick({ contextTokens: 210_000, conversation: conv, databus: bus })
    expect(callCount).toBe(1)
    // 块 A 未被逐出（canonical 仍有 9 个回合）。
    expect(conv.turns()).toHaveLength(9)

    // Tick 2：跨越位仍活（lastLayer=M0 ≠ layer=M1），findNextTaskBlock 跳过
    // u1（在 failedBlockIds 中），选中块 B（u2），压缩成功。
    await coordinator.tick({ contextTokens: 215_000, conversation: conv, databus: bus })
    expect(callCount).toBe(2)
    // 块 B 被逐出：原 9 回合 - 4（块 B）+ 1（信封）= 6。
    // 剩余：u1, a1, t1, a2, [mem-信封], u3。
    expect(conv.turns()).toHaveLength(6)
    // 信封在块 B 的原位（index 4）。
    expect(conv.turns()[4]!.id.startsWith('mem-')).toBe(true)
    // 块 A 的回合仍在（未被逐出）。
    expect(conv.turns()[0]!.id).toBe(turns[0]!.id) // u1
    // 持续档（2026-09-16 修复）：不再"跨越消费后静默"。tick 2 成功已清空
    // failedBlockIds，tick 3 再次派发，选中块 A。fence 修复（2026-09-22）：块 A
    // 的跨度在 B 的信封处收住（[u1,a1,t1,a2] 4 条），B 的信封是硬边界、不再被
    // 二次吞并 → [A信封, B信封, u3]。吞信封即二次有损压缩（MRCR-3M S10-13 事故根因）。
    await coordinator.tick({ contextTokens: 220_000, conversation: conv, databus: bus })
    expect(callCount).toBe(3)
    expect(conv.turns()).toHaveLength(3)
    expect(conv.turns()[0]!.id.startsWith('mem-')).toBe(true)
    expect(conv.turns()[1]!.id.startsWith('mem-')).toBe(true) // B 的信封保留（未被吞）
    expect(conv.turns()[2]!.id).toBe(turns[8]!.id) // u3
  })
})

// ===========================================================================
// 用户停止标记（2026-09-17 用户拍板）：turn.cancel 产生 stop- 标记回合，
// 作为被打断块的终止符号留在切片内（不作块起点/边界），compressor 按正文
// sentinel 识别后把该块标为 DONE。
// ===========================================================================

describe('drive-coordinator: user stop marker (2026-09-17)', () => {
  it('stop- marker is not a block boundary but stays inside the slice as its final message', () => {
    const marker = buildUserStopMarkerTurn()
    const turns: ConversationTurn[] = [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'r1', 300),
      assistantTurn('a2', 400),
      marker,
      userTurn('u2', 500),
      assistantTurn('a3', 600),
      userTurn('u3', 700),
    ]

    const block1 = findNextTaskBlock(turns)
    expect(block1).toBeDefined()
    // 块 1 = [u1, a1, t1, a2, marker]，边界是 u2（marker 不算边界）
    expect(block1!.endIndexExclusive).toBe(5)
    expect(block1!.turns).toHaveLength(5)
    // 标记是块的最后一条消息（wire 上 compressor 能看到）
    expect(block1!.turns[4]!.id).toBe(marker.id)
    expect(block1!.messages[4]).toEqual({ role: 'user', content: USER_INTERRUPTED_MARKER })

    // 块 2 从 u2 开始（marker 不是起点，被打断块与下一个任务不合并）
    const block2 = findNextTaskBlock(turns, block1!.endIndexExclusive)
    expect(block2).toBeDefined()
    expect(block2!.startIndex).toBe(5)
  })

  it('marker-only tail (no next real user turn) does not form a premature block', () => {
    const marker = buildUserStopMarkerTurn()
    const turns: ConversationTurn[] = [
      userTurn('u1', 100),
      assistantTurn('a1', 200),
      marker,
    ]
    // 没有下一个真实 user 边界 → 跨度未完整，不切块（与既有行为一致）
    expect(findNextTaskBlock(turns)).toBeUndefined()
  })

  it('interrupted block is compressed with the marker as its final wire message', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    const marker = buildUserStopMarkerTurn()
    const compressor = createMockAgent()
    const coordinator = createDriveCoordinator(makeDeps({ compressor }))

    seed(conv, bus, [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'r1', 300),
      assistantTurn('a2', 400),
      marker,
      userTurn('u2', 500),
    ])

    await coordinator.tick({ contextTokens: 210_000, conversation: conv, databus: bus })

    // 压缩器收到的最后一条 wire 消息 = 停止标记（DONE 判定依据）
    expect(compressor.calls).toHaveLength(1)
    const last = compressor.calls[0]!.messages[compressor.calls[0]!.messages.length - 1]
    expect(last).toEqual({ role: 'user', content: USER_INTERRUPTED_MARKER })

    // 被打断块被逐出（5 回合）+ 原位信封 = 2 回合（信封 + u2）
    expect(conv.turns()).toHaveLength(2)
    expect(conv.turns()[0]!.id.startsWith('mem-')).toBe(true)
  })
})

// ===========================================================================
// 2026-09-11: drain — wait for the in-flight dispatch before host shutdown.
// ===========================================================================

describe('drive-coordinator: drain', () => {
  it('resolves immediately when nothing is in flight', async () => {
    const coordinator = createDriveCoordinator(makeDeps({ compressor: createMockAgent() }))
    await coordinator.drain() // no in-flight → returns right away
  })

  it('waits for the in-flight dispatch to finish before resolving', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()

    // Deferred compressor: run() resolves only when the test releases it.
    let release: (() => void) | null = null
    const released = new Promise<void>((resolve) => { release = resolve })
    let runCalls = 0
    const deferredCompressor = {
      async run() {
        runCalls += 1
        await released
        return {
          output: '',
          submitted: curatedMemory,
          metrics: { rounds: 1, toolCalls: 0, toolErrors: 0, guardTrips: 0, tokensUsed: 0 } as never,
          finalState: 'Running' as never,
          reason: 'completed' as const,
          hits: [],
        }
      },
      stop() {},
      send() {},
    }

    seed(conv, bus, [
      userTurn('u1', 100),
      assistantTurn('a1', 200, [tc('t1')]),
      toolTurn('t1', 'r1', 300),
      assistantTurn('a2', 400),
      userTurn('u2', 500),
    ])

    const coordinator = createDriveCoordinator(
      makeDeps({ compressor: deferredCompressor as unknown as SystemAgent }),
    )

    // Fire-and-forget tick (mirrors fireDriveCoordinator): dispatch starts,
    // compressor.run() blocks on the deferred gate.
    const ticking = coordinator.tick({ contextTokens: 250_000, conversation: conv, databus: bus })
    await new Promise((r) => setTimeout(r, 10))
    expect(runCalls).toBe(1)

    // Drain resolves only after the in-flight dispatch completes.
    let drained = false
    const draining = coordinator.drain().then(() => { drained = true })
    await new Promise((r) => setTimeout(r, 10))
    expect(drained).toBe(false) // dispatch still in flight
    release!()
    await draining
    expect(drained).toBe(true)

    // The dispatch finished: block compressed + evicted, envelope in place.
    expect(conv.turns()).toHaveLength(2) // envelope + u2
    expect(conv.turns()[0]!.id.startsWith('mem-')).toBe(true)
    expect(bus.turns()).toHaveLength(1) // 方案 A: t1 stays

    await ticking
  })

  it('waits for the in-flight M3 archive before resolving', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    const stateLine = createMockStateLine({
      entries: {
        M1: [{
          task_goal: 'archive me',
          causal_steps: [],
          evidence_fragments: [],
          conclusion: 'pending warehouse write',
          next_action: 'wait',
          working_state: {
            current_goal: 'test drain',
            effective_decisions: [],
            rejected_decisions: [],
            architecture_boundaries: [],
            remaining_work: [],
          },
          _stamp: 's-drain-m3',
        }],
      },
    })
    let release: (() => void) | null = null
    const released = new Promise<void>((resolve) => { release = resolve })
    let warehouseRuns = 0
    const warehouse = {
      async run() {
        warehouseRuns += 1
        await released
        return {
          output: '',
          metrics: { rounds: 1, toolCalls: 0, toolErrors: 0, guardTrips: 0, tokensUsed: 0 } as never,
          finalState: 'Running' as never,
          reason: 'completed' as const,
          hits: [],
        }
      },
      stop() {},
      send() {},
    }
    const coordinator = createDriveCoordinator(makeDeps({
      warehouse: warehouse as unknown as SystemAgent,
      stateLine,
    }))

    const ticking = coordinator.tick({ contextTokens: 950_000, conversation: conv, databus: bus })
    await new Promise((r) => setTimeout(r, 10))
    expect(warehouseRuns).toBe(1)

    let drained = false
    const draining = coordinator.drain().then(() => { drained = true })
    await new Promise((r) => setTimeout(r, 10))
    expect(drained).toBe(false)

    release!()
    await draining
    expect(drained).toBe(true)
    await ticking
  })

  it('noop coordinator drain resolves immediately', async () => {
    const noop = createNoopDriveCoordinator()
    await noop.drain()
  })
})
