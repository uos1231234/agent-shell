// v0.41 goal 模式 — Gate `goal.*` 命令路由单元测试（optional-handler 模式，
// 仿 gate-waveb-commands.test.ts 款式）。
//
// 覆盖三命令各两态：
//   1. handler 提供时 → 参数原样透传（maxRounds 传与不传两条路都要钉住：
//      gate.ts 用 `cmd.maxRounds !== undefined` 分派，是为了在
//      exactOptionalPropertyTypes 下不把 undefined 塞进可选参数位）
//   2. handler 缺省时 → 干净英文错误（requires a goal handler）
// 再加一条出站：goal.changed 经 emit/on 广播（gate 纯路由，事件由状态持有者产）。

import { describe, it, expect, vi } from 'vitest'

import { createSignalGate } from '../../src/signals/gate.js'
import type { SignalGateHandlers } from '../../src/signals/types.js'
import type { GoalState } from '../../src/im/goal/types.js'

/** 最小 handlers mock：required 成员给 never 分支，optional 按需注入。 */
const makeHandlers = (optional: Partial<SignalGateHandlers> = {}): SignalGateHandlers => ({
  runPrompt: vi.fn(async () => {
    throw new Error('runPrompt: not implemented in tests')
  }),
  session: {
    create: vi.fn(async () => {
      throw new Error('create: not implemented in tests')
    }),
    open: vi.fn(async () => {
      throw new Error('open: not implemented in tests')
    }),
    list: vi.fn(async () => []),
    close: vi.fn(async (_id: string) => {}),
    delete: vi.fn(async (_id: string) => {}),
    history: vi.fn(async (_id: string) => [] as const),
  },
  cancel: vi.fn((_sessionId: string) => {}),
  setFullPermission: vi.fn((_sessionId: string, _enabled: boolean) => {}),
  ...optional,
})

const goalState = (): GoalState => ({ condition: '把报告写完', maxRounds: 24, roundsUsed: 3 })

describe('SignalGate goal commands — routed when the handler is provided', () => {
  it('routes goal.set with an explicit maxRounds', async () => {
    const goal = {
      set: vi.fn(async (_s: string, _c: string, _m?: number) => {}),
      clear: vi.fn(async (_s: string) => {}),
      get: vi.fn(async (_s: string) => undefined),
    }
    const gate = createSignalGate({ handlers: makeHandlers({ goal }) })

    await gate.command({ kind: 'goal.set', sessionId: 's1', condition: '把报告写完', maxRounds: 5 })

    expect(goal.set).toHaveBeenCalledTimes(1)
    expect(goal.set).toHaveBeenCalledWith('s1', '把报告写完', 5)
  })

  it('routes goal.set without maxRounds as a two-argument call (host applies the default)', async () => {
    const goal = {
      set: vi.fn(async (_s: string, _c: string, _m?: number) => {}),
      clear: vi.fn(async (_s: string) => {}),
      get: vi.fn(async (_s: string) => undefined),
    }
    const gate = createSignalGate({ handlers: makeHandlers({ goal }) })

    await gate.command({ kind: 'goal.set', sessionId: 's1', condition: '把报告写完' })

    // 缺省不是 gate 的职责：DEFAULT_GOAL_MAX_ROUNDS 的事实源在 src/im/goal/types.ts，
    // 由宿主 handler 应用（铁律「gate 不伪造语义」）。所以断言的是"第三参没被传"。
    expect(goal.set).toHaveBeenCalledWith('s1', '把报告写完')
    expect(goal.set.mock.calls[0]!).toHaveLength(2)
  })

  it('routes goal.clear / goal.get and returns the handler receipt verbatim', async () => {
    const goal = {
      set: vi.fn(async (_s: string, _c: string, _m?: number) => {}),
      clear: vi.fn(async (_s: string) => {}),
      get: vi.fn(async (_s: string) => goalState()),
    }
    const gate = createSignalGate({ handlers: makeHandlers({ goal }) })

    await gate.command({ kind: 'goal.clear', sessionId: 's1' })
    const got = await gate.command({ kind: 'goal.get', sessionId: 's1' })

    expect(goal.clear).toHaveBeenCalledWith('s1')
    expect(goal.get).toHaveBeenCalledWith('s1')
    expect(got).toEqual(goalState())
  })

  it('goal.get returns undefined when no goal is set (absence is a normal state, not an error)', async () => {
    const goal = {
      set: vi.fn(async (_s: string, _c: string, _m?: number) => {}),
      clear: vi.fn(async (_s: string) => {}),
      get: vi.fn(async (_s: string) => undefined),
    }
    const gate = createSignalGate({ handlers: makeHandlers({ goal }) })

    await expect(gate.command({ kind: 'goal.get', sessionId: 's1' })).resolves.toBeUndefined()
  })
})

describe('SignalGate goal commands — clean error without the handler', () => {
  it('goal.set / goal.clear / goal.get all throw "requires a goal handler"', async () => {
    const gate = createSignalGate({ handlers: makeHandlers() })

    await expect(
      gate.command({ kind: 'goal.set', sessionId: 's1', condition: 'x' }),
    ).rejects.toThrow(/"goal\.set" requires a goal handler/)
    await expect(gate.command({ kind: 'goal.clear', sessionId: 's1' })).rejects.toThrow(
      /"goal\.clear" requires a goal handler/,
    )
    await expect(gate.command({ kind: 'goal.get', sessionId: 's1' })).rejects.toThrow(
      /"goal\.get" requires a goal handler/,
    )
  })
})

describe('goal.changed outbound signal', () => {
  it('broadcasts to kind subscribers and to the wildcard', () => {
    const gate = createSignalGate({ handlers: makeHandlers() })
    const kindSeen: unknown[] = []
    const allSeen: unknown[] = []
    gate.on('goal.changed', (s) => kindSeen.push(s))
    gate.on('*', (s) => allSeen.push(s))

    gate.emit({
      kind: 'goal.changed',
      sessionId: 's1',
      event: { status: 'round', round: 2, maxRounds: 24, verdict: { verdict: 'not_met', reason: '证据不足' } },
    })

    expect(kindSeen).toHaveLength(1)
    expect(allSeen).toHaveLength(1)
    expect(kindSeen[0]).toEqual({
      kind: 'goal.changed',
      sessionId: 's1',
      event: { status: 'round', round: 2, maxRounds: 24, verdict: { verdict: 'not_met', reason: '证据不足' } },
    })
  })
})
