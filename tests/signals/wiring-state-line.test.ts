// v0.21 Signal Gate — state-line wiring 单元测试。
//
// 覆盖 wireStateLineToGate 的行为：
//   1. M1/M2 curated block 写入 → memory.compressed 信号
//   2. M3 summary 写入 → memory.archived 信号
//   3. dispose 断开订阅

import { describe, it, expect, vi } from 'vitest'
import { wireStateLineToGate } from '../../src/signals/wiring/state-line.js'
import type { SignalGate, GateSignal } from '../../src/signals/types.js'
import type { StateLine, StateLineEntry } from '../../src/im/state-line/types.js'

const makeGate = () => {
  const emitted: GateSignal[] = []
  const gate: SignalGate = {
    emit: vi.fn((sig: GateSignal) => { emitted.push(sig) }),
    on: vi.fn(() => () => {}),
    request: vi.fn(),
    resolve: vi.fn(),
    command: vi.fn(),
    snapshot: vi.fn(() => ({ sessions: [], pendingRequests: 0, subscribers: 0, emitted: 0 })),
  }
  return { gate, emitted }
}

const makeStateLine = (): StateLine & { notify(entry: StateLineEntry): void; unsubCount: () => number } => {
  let cb: ((entry: StateLineEntry) => void) | undefined
  let unsubCalled = false
  return {
    query: vi.fn(() => []),
    subscribe: vi.fn((_filter: unknown, handler: (entry: StateLineEntry) => void) => {
      cb = handler
      return () => { unsubCalled = true }
    }),
    close: vi.fn(),
    compressor: {} as never,
    warehouse: {} as never,
    rawArchive: {} as never,
    notify: (entry: StateLineEntry) => cb?.(entry),
    unsubCount: () => unsubCalled ? 1 : 0,
  }
}

const curatedBlock: StateLineEntry = {
  task_goal: 'fix bug',
  causal_steps: [],
  evidence_fragments: [],
  conclusion: 'done',
  next_action: 'none',
  working_state: {
    current_goal: 'fix bug',
    effective_decisions: [],
    rejected_decisions: [],
    architecture_boundaries: [],
    remaining_work: [],
  },
  _stamp: 'stamp-1',
}

const m3Block: StateLineEntry = {
  stamp: 'm3-1',
  m1_stamp: 'stamp-1',
  summary_text: 'aggregated summary of work done',
  layer: 'M3',
  at: Date.now(),
}

describe('wireStateLineToGate', () => {
  it('M1/M2 curated block → memory.compressed signal', () => {
    const { gate, emitted } = makeGate()
    const sl = makeStateLine()
    wireStateLineToGate({ gate, stateLine: sl, getSessionId: () => 's1' })

    sl.notify(curatedBlock)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toEqual({
      kind: 'memory.activity',
      sessionId: 's1',
      activity: 'memory.compressed',
      detail: { layer: 'M1/M2', stamp: 'stamp-1', taskGoal: 'fix bug' },
    })
  })

  it('M3 summary → memory.archived signal', () => {
    const { gate, emitted } = makeGate()
    const sl = makeStateLine()
    wireStateLineToGate({ gate, stateLine: sl, getSessionId: () => 's1' })

    sl.notify(m3Block)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toEqual({
      kind: 'memory.activity',
      sessionId: 's1',
      activity: 'memory.archived',
      detail: { layer: 'M3', stamp: 'm3-1', taskGoal: 'aggregated summary of work done' },
    })
  })

  it('task_goal truncation for M3 summary_text', () => {
    const { gate, emitted } = makeGate()
    const sl = makeStateLine()
    wireStateLineToGate({ gate, stateLine: sl, getSessionId: () => 's1' })

    const longSummary = { ...m3Block, summary_text: 'x'.repeat(500) }
    sl.notify(longSummary)

    expect(emitted).toHaveLength(1)
    const detail = (emitted[0] as { detail: { taskGoal: string } }).detail
    expect(detail.taskGoal.length).toBeLessThanOrEqual(200)
  })

  it('dispose unsubscribes from StateLine', () => {
    const { gate } = makeGate()
    const sl = makeStateLine()
    const dispose = wireStateLineToGate({ gate, stateLine: sl, getSessionId: () => 's1' })

    dispose()
    expect(sl.unsubCount()).toBe(1)
  })
})
