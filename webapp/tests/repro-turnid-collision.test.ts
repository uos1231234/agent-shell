// 回归测试：跨轮 turnId 撞车（2026-09-08 真实事故）。
//
// loop 侧曾以 `turn-${turns}`（每轮 runIMLoop 从 1 重置）作为流式 turnId，
// webapp reducer 以 turnId 为 items key——第二轮起所有单步轮次的流式正文
// 合并进第一轮的 "turn-1" 条目：items.length 不变 → MessageList 不滚动 →
// 用户在底部看到"没有回应"（后端 canonical 实际有完整回复）。
// 修复：loop 每轮 mintTurnId('turn')（全局唯一）。本测试锁定 reducer 侧
// 语义：不同 turnId 恒开新条目，即使内容/轮次相同。
import { describe, expect, it } from 'vitest'
import { reduceSignal, type StoreState } from '../src/state/session-store'

const sid = 's1'
const base = (): StoreState => ({
  sessions: {},
  sessionList: [],
  logs: [],
  pendingRequests: [],
  providerCatalog: undefined,
  wikiChangedAt: 0,
  wikiGen: undefined,
  activeSessionId: sid,
})

const delta = (turnId: string, text: string) =>
  ({ kind: 'assistant.delta', sessionId: sid, turnId, text } as never)
const turnEnd = () =>
  ({
    kind: 'turn.end',
    sessionId: sid,
    result: {
      reason: 'completed',
      turns: 1,
      hits: [],
      metrics: {
        totalTokens: 1, promptTokens: 1, completionTokens: 1,
        stepCount: 1, toolCallCount: 0, elapsedMs: 1, lastRequestTokens: 1,
      },
    },
  } as never)

describe('regression: cross-round turnId collision (2026-09-08)', () => {
  it('two rounds with distinct turnIds produce two distinct turn items', () => {
    let st = base()
    // ---- round 1: turnId A ----
    st = reduceSignal(st, delta('turn-aaa', 'AAA'), 1)
    st = reduceSignal(st, turnEnd(), 2)
    // ---- round 2: turnId B（loop 每轮 mint 唯一 id）----
    st = reduceSignal(st, delta('turn-bbb', 'BBB'), 3)
    st = reduceSignal(st, turnEnd(), 4)

    const items = st.sessions[sid]!.items.filter((it) => it.type === 'turn')
    expect(items).toHaveLength(2)
    expect((items[0] as { text: string }).text).toBe('AAA')
    expect((items[1] as { text: string }).text).toBe('BBB')
  })
})
