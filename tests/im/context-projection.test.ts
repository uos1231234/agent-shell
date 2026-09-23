import { describe, it, expect, vi } from 'vitest'
import {
  buildContextProjection,
  estimateTokensFromText,
  type ContextProjectionConfig,
  type ProjectionInput,
} from '../../src/im/context-projection.js'
import { Mailbox } from '../../src/im/mailbox/index.js'
import type { StateLine, StateLineEntry, CuratedMemory, StateLineQueryFilter } from '../../src/im/state-line/types.js'
import type { PromptPart } from '../../src/shell/compose.js'

/** Narrow a PromptPart union to its 'system' variant — tests only care about the content. */
const systemContent = (part: PromptPart | null): string =>
  part?.type === 'system' ? part.content : ''

// ─── Mock helpers ────────────────────────────────────────

const mkCuratedMemory = (goal: string, stamp: string): CuratedMemory & { _stamp: string } => ({
  task_goal: goal,
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
  _stamp: stamp,
})

const mkStateLineMock = (queryImpl?: (filter: StateLineQueryFilter) => StateLineEntry[]): StateLine => ({
  query: vi.fn(queryImpl ?? (() => [])),
  compressor: {
    async appendBlock() { throw new Error('mock') },
  },
  warehouse: {
    async appendSummary() { throw new Error('mock') },
    async queryM3() { return { ok: false as const, error: 'mock' } },
  },
  rawArchive: {
    async append() { throw new Error('mock') },
    async query() { return [] },
  },
  subscribe: () => () => {},
  close() {},
})

const mkMailbox = (unread: number): Mailbox => {
  const mb = new Mailbox()
  for (let i = 0; i < unread; i++) {
    mb.send({ from: 'other', to: 'main', subject: `s${i}`, body: `b${i}` })
  }
  return mb
}

const baseInput = (overrides: {
  estimatedTokens?: number
  stateLine?: StateLine
  mailbox?: Mailbox
  config?: ContextProjectionConfig
  availableToolRefs?: readonly string[]
}): ProjectionInput => ({
  stateLine: overrides.stateLine ?? mkStateLineMock(),
  mailbox: overrides.mailbox ?? new Mailbox(),
  workingAgentId: 'main' as const,
  estimatedTokens: overrides.estimatedTokens ?? 100,
  ...(overrides.config ? { config: overrides.config } : {}),
  ...(overrides.availableToolRefs ? { availableToolRefs: overrides.availableToolRefs } : {}),
})

// ─── Tests ───────────────────────────────────────────────

describe('im/context-projection', () => {
  describe('estimateTokensFromText', () => {
    it('returns Math.ceil(length / 4)', () => {
      expect(estimateTokensFromText('')).toBe(0)
      expect(estimateTokensFromText('ab')).toBe(1)    // ceil(2/4) = 1
      expect(estimateTokensFromText('abcd')).toBe(1)   // ceil(4/4) = 1
      expect(estimateTokensFromText('abcde')).toBe(2)  // ceil(5/4) = 2
    })
  })

  describe('M0 (tokens < 200K)', () => {
    it('stateLinePart is null, no mailbox → empty suffix', () => {
      const result = buildContextProjection(baseInput({ estimatedTokens: 100_000 }))
      expect(result.layer).toBe('M0')
      expect(result.stateLinePart).toBeNull()
      expect(result.systemSuffix).toBe('')
    })
  })

  describe('M1 (200K ≤ tokens < 500K)', () => {
    it('stateLinePart non-null, content contains "### M1"', () => {
      const m1Block = mkCuratedMemory('M1 goal', 'S-M1-001')
      const sl = mkStateLineMock((filter) => {
        if (filter.layer === 'M1') return [m1Block]
        return []
      })
      const result = buildContextProjection(baseInput({
        estimatedTokens: 250_000,
        stateLine: sl,
      }))
      expect(result.layer).toBe('M1')
      expect(result.stateLinePart?.type).toBe('system')
      expect(systemContent(result.stateLinePart)).toContain('### M1')
      expect(systemContent(result.stateLinePart)).toContain('S-M1-001')
    })
  })

  describe('M2 (500K ≤ tokens < 900K)', () => {
    it('stateLinePart non-null, content contains both "### M1" and "### M2"', () => {
      const m1Block = mkCuratedMemory('M1 goal', 'S-M1-001')
      const m2Block = mkCuratedMemory('M2 goal', 'S-M2-001')
      const sl = mkStateLineMock((filter) => {
        if (filter.layer === 'M1') return [m1Block]
        if (filter.layer === 'M2') return [m2Block]
        return []
      })
      const result = buildContextProjection(baseInput({
        estimatedTokens: 600_000,
        stateLine: sl,
      }))
      expect(result.layer).toBe('M2')
      expect(systemContent(result.stateLinePart)).toContain('### M1')
      expect(systemContent(result.stateLinePart)).toContain('### M2')
    })

    it('calls query twice (once for M1, once for M2)', () => {
      const sl = mkStateLineMock((filter) => {
        if (filter.layer === 'M1') return [mkCuratedMemory('m1', 's1')]
        if (filter.layer === 'M2') return [mkCuratedMemory('m2', 's2')]
        return []
      })
      buildContextProjection(baseInput({
        estimatedTokens: 600_000,
        stateLine: sl,
      }))
      expect(sl.query).toHaveBeenCalledTimes(2)
      expect(sl.query).toHaveBeenCalledWith(expect.objectContaining({ layer: 'M1' }))
      expect(sl.query).toHaveBeenCalledWith(expect.objectContaining({ layer: 'M2' }))
    })
  })

  describe('M3 (tokens ≥ 900K)', () => {
    it('stateLinePart is null, systemSuffix contains [context overflow]', () => {
      const result = buildContextProjection(baseInput({
        estimatedTokens: 950_000,
        availableToolRefs: ['state_query', 'ask_recall'],
      }))
      expect(result.layer).toBe('M3')
      expect(result.stateLinePart).toBeNull()
      expect(result.systemSuffix).toContain('[context overflow]')
    })
  })

  describe('blocks cap', () => {
    it('stateLineMaxBlocks=5 → takes 5 most recent M1 blocks (slice(-5))', () => {
      const blocks = Array.from({ length: 10 }, (_, i) =>
        mkCuratedMemory(`goal-${i}`, `S-M1-${i}`),
      )
      const sl = mkStateLineMock((filter) => {
        if (filter.layer === 'M1') return blocks
        return []
      })
      const result = buildContextProjection(baseInput({
        estimatedTokens: 250_000,
        stateLine: sl,
        config: { stateLineMaxBlocks: 5, conversationMaxTokens: 50_000 },
      }))
      // query no longer receives limit
      expect(sl.query).toHaveBeenCalledWith(expect.not.objectContaining({ limit: expect.anything() }))
      // Should take the last 5 (goal-5 through goal-9), not the first 5
      expect(systemContent(result.stateLinePart).match(/### M1/g)?.length).toBe(5)
      expect(systemContent(result.stateLinePart)).toContain('goal-9')
      expect(systemContent(result.stateLinePart)).toContain('goal-5')
      expect(systemContent(result.stateLinePart)).not.toContain('goal-4')
    })
  })

  describe('A10: M1 blocks take most recent (not oldest)', () => {
    it('15 M1 blocks, maxBlocks=5 → returns last 5 (index 10-14)', () => {
      const blocks = Array.from({ length: 15 }, (_, i) =>
        mkCuratedMemory(`goal-${i}`, `S-M1-${i}`),
      )
      const sl = mkStateLineMock((filter) => {
        if (filter.layer === 'M1') return blocks
        return []
      })
      const result = buildContextProjection(baseInput({
        estimatedTokens: 250_000,
        stateLine: sl,
        config: { stateLineMaxBlocks: 5, conversationMaxTokens: 50_000 },
      }))
      const content = systemContent(result.stateLinePart)
      // Should contain the last 5 (goal-10 through goal-14)
      expect(content.match(/### M1/g)?.length).toBe(5)
      expect(content).toContain('goal-14')
      expect(content).toContain('goal-10')
      // Should NOT contain the oldest 5 (goal-0 through goal-4)
      expect(content).not.toContain('goal-0')
      expect(content).not.toContain('goal-4')
    })
  })

  describe('mailbox with no unread', () => {
    it('systemSuffix does not contain [mailbox]', () => {
      const result = buildContextProjection(baseInput({
        mailbox: new Mailbox(),
      }))
      expect(result.systemSuffix).not.toContain('[mailbox]')
    })
  })

  describe('mailbox with unread', () => {
    it('systemSuffix contains "[mailbox] you have 3 unread"', () => {
      const result = buildContextProjection(baseInput({
        mailbox: mkMailbox(3),
      }))
      expect(result.systemSuffix).toContain('[mailbox] you have 3 unread')
    })
  })

  describe('M3 + mailbox simultaneously', () => {
    it('systemSuffix contains both [mailbox] and [context overflow]', () => {
      const result = buildContextProjection(baseInput({
        estimatedTokens: 950_000,
        mailbox: mkMailbox(2),
        availableToolRefs: ['state_query', 'ask_recall'],
      }))
      expect(result.systemSuffix).toContain('[mailbox]')
      expect(result.systemSuffix).toContain('[context overflow]')
    })
  })

  // v0.12.2: M3 overflow hint must be tailored to the agent's actual tools.
  // A sub-agent whose recall is a noop and whose toolRefs omit ask_recall must
  // not be told to use ask_recall.
  describe('M3 hint tailored to availableToolRefs', () => {
    it('mentions ask_recall when the agent has it', () => {
      const result = buildContextProjection(baseInput({
        estimatedTokens: 950_000,
        availableToolRefs: ['state_query', 'ask_recall'],
      }))
      expect(result.systemSuffix).toContain('via state_query/ask_recall')
    })

    it('mentions only state_query when the agent lacks ask_recall', () => {
      const result = buildContextProjection(baseInput({
        estimatedTokens: 950_000,
        availableToolRefs: ['state_query'],
      }))
      expect(result.systemSuffix).toContain('via state_query')
      expect(result.systemSuffix).not.toContain('ask_recall')
    })

    it('gives a neutral delegation hint when the agent has neither', () => {
      const result = buildContextProjection(baseInput({
        estimatedTokens: 950_000,
        availableToolRefs: ['databus_query'],
      }))
      expect(result.systemSuffix).toContain('[context overflow]')
      expect(result.systemSuffix).not.toContain('via state_query')
      expect(result.systemSuffix).not.toContain('via ask_recall')
      expect(result.systemSuffix).toContain('delegate retrieval')
    })
  })
})
