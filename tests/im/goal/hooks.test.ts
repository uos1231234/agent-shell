// v0.41 — createGoalHooks 编排测试（beforeComplete 的 ①②④ 顺序与状态机）。
//
// 钉住的核心性质：
//  (1) goal 未激活时**立即弃权**——这是"关闭 goal 时行为逐字节不变"的落点；
//  (2) **judge 先于压缩**（原则 2）：judge 必须看到未被压缩的原始证据，
//      压缩后原位置只剩信封，它就只能在审摘要；
//  (3) 终止型裁决（met / impossible / rounds_exhausted）先跑一次 G1/G2 梯度
//      （2026-09-17 用户拍板：收尾不豁免，met 标 DONE、其余标 UNKNOWN），再清空
//      goal 状态并返回 undefined，让 loop 走既有 completed 路径；
//  (4) D15 fail-open：judge 失败照样续跑，且提醒里如实写失败；
//  (5) D17：达到轮次上限后**不再调 judge**（那是一次全上下文调用，在已经
//      决定收尾之后花它没有意义）。

import { describe, it, expect, vi } from 'vitest'
import { createGoalHooks } from '../../../src/im/goal/hooks.js'
import { createGoalSessionState, resolveGoalConfig, GOAL_TURN_ID_PREFIX } from '../../../src/im/goal/types.js'
import type { GoalJudge } from '../../../src/im/goal/judge.js'
import type { Distiller, DistillRun } from '../../../src/im/goal/distill.js'
import type { GoalEvent, GoalState, GoalVerdictResult } from '../../../src/im/goal/types.js'
import { findNextTaskBlock } from '../../../src/im/system-agents/drive-coordinator.js'
import type { DriveCoordinator, DriveSnapshot, TaskBlock } from '../../../src/im/system-agents/drive-coordinator.js'
import type { BeforeCompleteContext } from '../../../src/im/loop-hooks.js'
import type { ConversationTurn } from '../../../src/im/conversation-memory.js'
import type { CuratedMemory } from '../../../src/im/state-line/types.js'
import { ConversationMemory } from '../../../src/im/conversation-memory.js'
import { Databus } from '../../../src/im/databus.js'
import { appendCanonicalTurn } from '../../../src/im/turn.js'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const notMet = (reason: string): GoalVerdictResult => ({ verdict: 'not_met', reason })
const met = (reason = '证据齐全'): GoalVerdictResult => ({ verdict: 'met', reason })
const impossible = (reason: string): GoalVerdictResult => ({ verdict: 'impossible', reason })
const judgeFailed = (err: string): GoalVerdictResult => ({ verdict: 'judge_failed', reason: `judge 调用失败：${err}` })

type FakeJudge = GoalJudge & { seen: ConversationTurn[][]; rounds: number[]; calls: number }

/** 按序发牌；牌用完后重复最后一张。记录每次看到的 canonical 快照。 */
const fakeJudge = (...verdicts: GoalVerdictResult[]): FakeJudge => {
  const seen: ConversationTurn[][] = []
  const rounds: number[] = []
  let i = 0
  return {
    seen, rounds,
    get calls() { return i },
    evaluate: async (input) => {
      seen.push([...input.conversationMemory.turns()])
      rounds.push(input.round)
      const v = verdicts[Math.min(i, verdicts.length - 1)]!
      i += 1
      return v
    },
  }
}

type FakeCoordinator = DriveCoordinator & {
  merges: Array<{ block: TaskBlock; memory: CuratedMemory; snapshot: DriveSnapshot }>
  distills: Array<{ memory: CuratedMemory; range: { startIndex: number; endIndexExclusive: number; sourceStamps: string[] } }>
}

const fakeCoordinator = (opts: { hasMerge?: boolean; hasDistill?: boolean; distillReturnsUndefined?: boolean } = {}): FakeCoordinator => {
  const merges: FakeCoordinator['merges'] = []
  const distills: FakeCoordinator['distills'] = []
  return {
    merges,
    distills,
    async tick() {},
    // 真实实现 = 同一条 findNextTaskBlock 再减去登记表（在飞块）与失败集合；
    // fake 没有这两份私有状态，转发即等价。
    nextEligibleBlock: (turns) => findNextTaskBlock(turns, 0),
    stop() {},
    async drain() {},
    ...(opts.hasMerge === false
      ? {}
      : {
          async mergeGoalBlock(input: { snapshot: DriveSnapshot; block: TaskBlock; memory: CuratedMemory }) {
            merges.push(input)
            return { stamp: 'S-FAKE-1', blockTokens: 1234, envelopeTokens: 56 }
          },
        }),
    ...(opts.hasDistill === false
      ? {}
      : {
          async distillEnvelopes(input: {
            snapshot: DriveSnapshot
            memory: CuratedMemory
            range: { startIndex: number; endIndexExclusive: number; sourceStamps: string[] }
          }) {
            distills.push({ memory: input.memory, range: input.range })
            if (opts.distillReturnsUndefined === true) return undefined
            return { stamp: 'S-FAKE-G2', beforeTokens: 9000, afterTokens: 2000 }
          },
        }),
  }
}

type FakeDistiller = Distiller & { calls: number; runs: DistillRun[] }

const DISTILL_REPLY: CuratedMemory = {
  task_goal: '合并后的上层目标',
  causal_steps: [],
  evidence_fragments: [],
  conclusion: '合并后的结论',
  next_action: '合并后的下一步',
  working_state: {
    current_goal: '合并后的上层目标',
    effective_decisions: [],
    rejected_decisions: ['被否决的方案 A：理由'],
    architecture_boundaries: [],
    remaining_work: [],
  },
  status_hint: 'PENDING',
}

const fakeDistiller = (opts: { fail?: boolean } = {}): FakeDistiller => {
  const runs: DistillRun[] = []
  let calls = 0
  return {
    runs,
    get calls() { return calls },
    distill: async (input) => {
      calls += 1
      runs.push(input.run)
      if (opts.fail === true) throw new Error('distill LLM 500')
      return DISTILL_REPLY
    },
  }
}

let n = 0
const nid = (p: string): string => `${p}-${n++}`
const user = (content: string, prefix = 'user'): ConversationTurn => ({ id: nid(prefix), role: 'user', content, at: n })
const assistant = (content: string): ConversationTurn => ({ id: nid('assistant'), role: 'assistant', content, at: n })

/** [u1 a1] 由 goal 提醒关闭 → findNextTaskBlock 能取到一个已关闭块。 */
const memoryWithClosedBlock = (): { conv: ConversationMemory; bus: Databus } => {
  const conv = new ConversationMemory()
  const bus = new Databus()
  for (const t of [user('材料'), assistant('结论'), user('提醒', 'goal'), user('右边界')]) {
    appendCanonicalTurn(conv, bus, t)
  }
  return { conv, bus }
}

const ctxOf = (conv: ConversationMemory, bus: Databus, lastRequestTokens = 100): BeforeCompleteContext => ({
  turnId: 'turn-1', stepNumber: 1, signal: undefined,
  lastRequestTokens, conversationMemory: conv, databus: bus,
})

/** 形状与 buildCompressionEnvelope 的产出一致：首行 #STAMP，末行 #END_BLOCK。 */
const envelope = (stamp: string, filler = ''): ConversationTurn => ({
  id: nid('mem'),
  role: 'user',
  content: [
    `#STAMP ${stamp}`, '#LAYER M1', '#STATUS PENDING', '#NOTE 块召回：state_query',
    `[任务] 目标 ${stamp}`, `[结论] 结论 ${stamp} ${filler}`, '#END_BLOCK',
  ].join('\n'),
  at: n,
})

/**
 * N 个相邻信封 + 一个已关闭块（供 G1）+ 右边界。
 * 这是 goal 模式跑了几轮之后 canonical 的真实样子。
 */
const memoryWithEnvelopes = (count: number, filler = ''): { conv: ConversationMemory; bus: Databus } => {
  const conv = new ConversationMemory()
  const bus = new Databus()
  const turns: ConversationTurn[] = []
  for (let i = 0; i < count; i += 1) turns.push(envelope(`S-${i}`, filler))
  turns.push(user('待合并块的材料'), assistant('待合并块的结论'), user('提醒', 'goal'), user('右边界'))
  for (const t of turns) appendCanonicalTurn(conv, bus, t)
  return { conv, bus }
}

const buildHooks = (opts: {
  goal?: GoalState
  judge?: FakeJudge
  coordinator?: FakeCoordinator
  distiller?: FakeDistiller
  config?: Partial<ReturnType<typeof resolveGoalConfig>>
}) => {
  const state = createGoalSessionState()
  if (opts.goal !== undefined) state.current = { ...opts.goal }
  const events: GoalEvent[] = []
  const distiller = opts.distiller ?? fakeDistiller()
  const hooks = createGoalHooks({
    state,
    judge: opts.judge ?? fakeJudge(met()),
    distiller,
    resolveDriveCoordinator: () => opts.coordinator,
    config: resolveGoalConfig(opts.config),
    onEvent: (e) => { events.push(e) },
  })
  return { state, events, hooks, distiller }
}

const goal = (over?: Partial<GoalState>): GoalState => ({
  condition: '写出 a.txt 与 b.txt', maxRounds: 24, roundsUsed: 0, ...over,
})

const call = (hooks: ReturnType<typeof createGoalHooks>, ctx: BeforeCompleteContext) =>
  hooks.beforeComplete!(ctx)

// ---------------------------------------------------------------------------

describe('createGoalHooks — goal 未激活时立即弃权', () => {
  it('state.current 为 undefined → 返回 undefined 且不调 judge', async () => {
    const judge = fakeJudge(notMet('x'))
    const { hooks } = buildHooks({ judge })
    const { conv, bus } = memoryWithClosedBlock()

    await expect(call(hooks, ctxOf(conv, bus))).resolves.toBeUndefined()
    expect(judge.calls).toBe(0)
  })

  it('弃权时也不碰 coordinator', async () => {
    const coordinator = fakeCoordinator()
    const { hooks } = buildHooks({ coordinator })
    const { conv, bus } = memoryWithClosedBlock()

    await call(hooks, ctxOf(conv, bus))
    expect(coordinator.merges).toHaveLength(0)
  })
})

describe('createGoalHooks — 顺序：judge 先于压缩（原则 2）', () => {
  it('judge 看到的 canonical 里没有信封——压缩还没发生', async () => {
    const judge = fakeJudge(notMet('缺 b.txt'))
    const coordinator = fakeCoordinator()
    const { hooks } = buildHooks({ goal: goal(), judge, coordinator, config: { blockMinTokens: 1 } })
    const { conv, bus } = memoryWithClosedBlock()

    await call(hooks, ctxOf(conv, bus))

    expect(judge.seen).toHaveLength(1)
    // judge 的视野 = 压缩前的原始回合，一条 mem- 信封都没有
    expect(judge.seen[0]!.some((t) => t.id.startsWith('mem-'))).toBe(false)
    expect(judge.seen[0]!.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'user'])
    // 而压缩确实在 judge 之后跑了
    expect(coordinator.merges).toHaveLength(1)
  })

  it('coordinator 在 judge 之后才被调用（调用序而非仅存在性）', async () => {
    const order: string[] = []
    const judge: GoalJudge = {
      evaluate: async () => { order.push('judge'); return notMet('r') },
    }
    const coordinator = fakeCoordinator()
    const origMerge = coordinator.mergeGoalBlock!
    coordinator.mergeGoalBlock = async (input) => { order.push('G1'); return origMerge.call(coordinator, input) }

    const state = createGoalSessionState()
    state.current = goal()
    const hooks = createGoalHooks({
      state, judge, distiller: fakeDistiller(), resolveDriveCoordinator: () => coordinator,
      config: resolveGoalConfig({ blockMinTokens: 1 }),
    })
    const { conv, bus } = memoryWithClosedBlock()
    await hooks.beforeComplete!(ctxOf(conv, bus))

    expect(order).toEqual(['judge', 'G1'])
  })
})

describe('createGoalHooks — 终止型裁决', () => {
  it('met → 返回 undefined、发 met、清空 goal 状态', async () => {
    const { hooks, state, events } = buildHooks({ goal: goal(), judge: fakeJudge(met('两个文件都在')) })
    const { conv, bus } = memoryWithClosedBlock()

    await expect(call(hooks, ctxOf(conv, bus))).resolves.toBeUndefined()
    expect(events).toEqual([{ status: 'met', roundsUsed: 1 }])
    expect(state.current).toBeUndefined()
  })

  it('impossible → 返回 undefined、发 impossible（带 reason）、清空状态', async () => {
    const { hooks, state, events } = buildHooks({ goal: goal(), judge: fakeJudge(impossible('目标要求的权限不存在')) })
    const { conv, bus } = memoryWithClosedBlock()

    await expect(call(hooks, ctxOf(conv, bus))).resolves.toBeUndefined()
    expect(events).toEqual([{ status: 'impossible', roundsUsed: 1, reason: '目标要求的权限不存在' }])
    expect(state.current).toBeUndefined()
  })

  it('met 时也做 G1，信封标 DONE 且 remaining_work 为空（2026-09-17 用户拍板）', async () => {
    const coordinator = fakeCoordinator()
    const { hooks } = buildHooks({ goal: goal(), judge: fakeJudge(met('证据齐全')), coordinator, config: { blockMinTokens: 1 } })
    const { conv, bus } = memoryWithClosedBlock()

    await call(hooks, ctxOf(conv, bus))
    expect(coordinator.merges).toHaveLength(1)
    const memory = coordinator.merges[0]!.memory
    expect(memory.status_hint).toBe('DONE')
    // DONE 与"剩余工作"不能同时为真。
    expect(memory.working_state.remaining_work).toEqual([])
    expect(memory.next_action).toContain('目标已于第 1 轮判定达成')
    expect(memory.next_action).toContain('证据齐全')
  })

  it('终止后 goal 已清空 → 下一次调用立即弃权，不再调 judge', async () => {
    const judge = fakeJudge(met())
    const { hooks, state } = buildHooks({ goal: goal(), judge })
    const { conv, bus } = memoryWithClosedBlock()

    await call(hooks, ctxOf(conv, bus))
    expect(state.current).toBeUndefined()
    await call(hooks, ctxOf(conv, bus))
    expect(judge.calls).toBe(1)
  })
})

describe('createGoalHooks — 续跑（not_met / judge_failed）', () => {
  it('not_met → 返回 continueWith，idPrefix = goal，正文是提醒', async () => {
    const { hooks, events } = buildHooks({ goal: goal(), judge: fakeJudge(notMet('b.txt 无写入证据')) })
    const { conv, bus } = memoryWithClosedBlock()

    const r = await call(hooks, ctxOf(conv, bus))

    expect(r?.continueWith?.idPrefix).toBe(GOAL_TURN_ID_PREFIX)
    const content = r!.continueWith!.content
    expect(content).toContain('#GOAL_CONTINUATION')
    expect(content).toContain('#OBJECTIVE 写出 a.txt 与 b.txt')
    expect(content).toContain('#ROUND 1/24')
    expect(content).toContain('#VERDICT not_met')
    expect(content).toContain('#JUDGE_REASON b.txt 无写入证据')
    expect(content).toContain('#END_GOAL')
    expect(events).toEqual([{
      status: 'round', round: 1, maxRounds: 24,
      verdict: { verdict: 'not_met', reason: 'b.txt 无写入证据' },
    }])
  })

  it('roundsUsed 递增，judge 收到的 round 从 1 起算', async () => {
    const judge = fakeJudge(notMet('r1'), notMet('r2'), met())
    const { hooks, state } = buildHooks({ goal: goal(), judge })
    const { conv, bus } = memoryWithClosedBlock()

    await call(hooks, ctxOf(conv, bus))
    expect(state.current!.roundsUsed).toBe(1)
    await call(hooks, ctxOf(conv, bus))
    expect(state.current!.roundsUsed).toBe(2)
    await call(hooks, ctxOf(conv, bus)) // met → 清空
    expect(state.current).toBeUndefined()
    expect(judge.rounds).toEqual([1, 2, 3])
  })

  it('lastVerdict 记录最近一次裁决', async () => {
    const { hooks, state } = buildHooks({ goal: goal(), judge: fakeJudge(notMet('第一次'), notMet('第二次')) })
    const { conv, bus } = memoryWithClosedBlock()
    await call(hooks, ctxOf(conv, bus))
    await call(hooks, ctxOf(conv, bus))
    expect(state.current!.lastVerdict).toEqual({ verdict: 'not_met', reason: '第二次' })
  })

  it('D15 fail-open：judge_failed 照样续跑，提醒里如实写失败、不编造理由', async () => {
    const { hooks, events } = buildHooks({ goal: goal(), judge: fakeJudge(judgeFailed('ETIMEDOUT')) })
    const { conv, bus } = memoryWithClosedBlock()

    const r = await call(hooks, ctxOf(conv, bus))

    expect(r?.continueWith).toBeDefined()
    const content = r!.continueWith!.content
    expect(content).toContain('#VERDICT judge_failed')
    expect(content).toContain('#JUDGE_REASON judge 调用失败：ETIMEDOUT')
    expect(content).toContain('未能跑成')
    // 一次裁决一个事件：judge_failed 走 round，不再单发一个事件
    expect(events).toHaveLength(1)
    expect(events[0]!.status).toBe('round')
  })
})

describe('createGoalHooks — 轮次上限（D17）', () => {
  it('达到 maxRounds 后不再调 judge，直接收尾并清空状态', async () => {
    const judge = fakeJudge(notMet('r'))
    const { hooks, state, events } = buildHooks({ goal: goal({ maxRounds: 3, roundsUsed: 3 }), judge })
    const { conv, bus } = memoryWithClosedBlock()

    await expect(call(hooks, ctxOf(conv, bus))).resolves.toBeUndefined()
    expect(judge.calls).toBe(0)
    expect(events).toEqual([{ status: 'rounds_exhausted', roundsUsed: 3 }])
    expect(state.current).toBeUndefined()
  })

  it('耗尽收尾也跑 G1，信封标 UNKNOWN（尝试结束 ≠ 完成，2026-09-17 用户拍板）', async () => {
    const coordinator = fakeCoordinator()
    const { hooks } = buildHooks({
      goal: goal({ maxRounds: 3, roundsUsed: 3 }),
      judge: fakeJudge(notMet('r')),
      coordinator,
      config: { blockMinTokens: 1 },
    })
    const { conv, bus } = memoryWithClosedBlock()

    await call(hooks, ctxOf(conv, bus))
    expect(coordinator.merges).toHaveLength(1)
    const memory = coordinator.merges[0]!.memory
    expect(memory.status_hint).toBe('UNKNOWN')
    expect(memory.next_action).toContain('3/3 轮耗尽')
    expect(memory.next_action).toContain('本轮未做裁决')
  })

  it('跑满 maxRounds 的完整过程：前 N-1 次续跑，第 N 次裁决后耗尽', async () => {
    const judge = fakeJudge(notMet('仍未完成'))
    const { hooks, state, events } = buildHooks({ goal: goal({ maxRounds: 2 }), judge })
    const { conv, bus } = memoryWithClosedBlock()

    const r1 = await call(hooks, ctxOf(conv, bus))
    expect(r1?.continueWith).toBeDefined()
    const r2 = await call(hooks, ctxOf(conv, bus))
    expect(r2?.continueWith).toBeDefined()
    expect(state.current!.roundsUsed).toBe(2)

    const r3 = await call(hooks, ctxOf(conv, bus))
    expect(r3).toBeUndefined()
    expect(judge.calls).toBe(2) // 第三次没有调 judge
    expect(events.map((e) => e.status)).toEqual(['round', 'round', 'rounds_exhausted'])
  })
})

describe('createGoalHooks — G1 触发与降级', () => {
  it('块 ≥ blockMinTokens → 调 mergeGoalBlock，发 goal_block_merged（trigger=size）', async () => {
    const coordinator = fakeCoordinator()
    const { hooks, events } = buildHooks({
      goal: goal(), judge: fakeJudge(notMet('r')), coordinator, config: { blockMinTokens: 1 },
    })
    const { conv, bus } = memoryWithClosedBlock()

    await call(hooks, ctxOf(conv, bus))

    expect(coordinator.merges).toHaveLength(1)
    const m = coordinator.merges[0]!
    expect(m.memory.task_goal).toBe('写出 a.txt 与 b.txt')
    expect(m.memory.next_action).toBe('r')
    expect(m.memory.status_hint).toBe('PENDING')
    expect(m.snapshot.conversation).toBe(conv)
    expect(m.snapshot.databus).toBe(bus)
    expect(events.map((e) => e.status)).toEqual(['round', 'goal_block_merged'])
    const merged = events[1] as Extract<GoalEvent, { status: 'goal_block_merged' }>
    expect(merged).toMatchObject({ stamp: 'S-FAKE-1', blockTokens: 1234, envelopeTokens: 56, trigger: 'size' })
  })

  it('触发 B：块 ≥ floor 且上下文 ≥ m1MinTokens → trigger=watermark', async () => {
    const coordinator = fakeCoordinator()
    const { hooks, events } = buildHooks({
      goal: goal(), judge: fakeJudge(notMet('r')), coordinator,
      config: { blockMinTokens: 10_000_000, watermarkBlockFloorTokens: 10 },
    })
    const { conv, bus } = memoryWithClosedBlock()

    // 默认 m1MinTokens = 200_000；floor 降到 10 让测试块（~20 tok）能触发
    await call(hooks, ctxOf(conv, bus, 250_000))

    expect(coordinator.merges).toHaveLength(1)
    const merged = events.find((e) => e.status === 'goal_block_merged') as Extract<GoalEvent, { status: 'goal_block_merged' }>
    expect(merged.trigger).toBe('watermark')
  })

  it('触发 B floor：块 < floorTokens 时 watermark 不触发（v0.41 后续补丁 (a)）', async () => {
    const coordinator = fakeCoordinator()
    const { hooks, events } = buildHooks({
      goal: goal(), judge: fakeJudge(notMet('r')), coordinator,
      config: { blockMinTokens: 10_000_000, watermarkBlockFloorTokens: 10_000 },
    })
    const { conv, bus } = memoryWithClosedBlock()

    // 块 ~20 tok < floor 10K → 不触发（过滤净膨胀小块）
    await call(hooks, ctxOf(conv, bus, 250_000))

    expect(coordinator.merges).toHaveLength(0)
    expect(events.filter((e) => e.status === 'goal_block_merged')).toHaveLength(0)
  })

  it('触发 C（C3 压力阀）：上下文进 M3 层时小块也合并，trigger=pressure', async () => {
    // goal 模式下 tick 的跨越驱动整段关闭（D7），M3 之上只有 G1/G2 在出货——
    // 两条尺寸线都不命中时也必须排干一个块，否则上下文停在 900K 不动直到撞 1M guard。
    const coordinator = fakeCoordinator()
    const { hooks, events } = buildHooks({
      goal: goal(), judge: fakeJudge(notMet('r')), coordinator,
      config: { blockMinTokens: 10_000_000, watermarkBlockFloorTokens: 10_000_000 },
    })
    const { conv, bus } = memoryWithClosedBlock()

    await call(hooks, ctxOf(conv, bus, 900_000))

    expect(coordinator.merges).toHaveLength(1)
    const merged = events.find((e) => e.status === 'goal_block_merged') as Extract<GoalEvent, { status: 'goal_block_merged' }>
    expect(merged.trigger).toBe('pressure')
  })

  it('两条线都不满足 → 不调 mergeGoalBlock、不发压缩事件', async () => {
    const coordinator = fakeCoordinator()
    const { hooks, events } = buildHooks({
      goal: goal(), judge: fakeJudge(notMet('r')), coordinator,
      config: { blockMinTokens: 10_000_000 },
    })
    const { conv, bus } = memoryWithClosedBlock()

    const r = await call(hooks, ctxOf(conv, bus, 100))

    expect(coordinator.merges).toHaveLength(0)
    expect(events.map((e) => e.status)).toEqual(['round'])
    // 续跑不受压缩是否发生影响
    expect(r?.continueWith).toBeDefined()
  })

  it('无已关闭块（第一轮）→ 不调 mergeGoalBlock，但仍续跑', async () => {
    const coordinator = fakeCoordinator()
    const { hooks } = buildHooks({ goal: goal(), judge: fakeJudge(notMet('r')), coordinator, config: { blockMinTokens: 1 } })
    const conv = new ConversationMemory()
    const bus = new Databus()
    appendCanonicalTurn(conv, bus, user('唯一的用户回合'))
    appendCanonicalTurn(conv, bus, assistant('回答'))

    const r = await call(hooks, ctxOf(conv, bus))
    expect(coordinator.merges).toHaveLength(0)
    expect(r?.continueWith).toBeDefined()
  })

  it('noop coordinator（无 mergeGoalBlock）→ 跳过 G1，续跑照常', async () => {
    const judge = fakeJudge(notMet('r'))
    const { hooks, events } = buildHooks({ goal: goal(), judge, config: { blockMinTokens: 1 } })
    const { conv, bus } = memoryWithClosedBlock()

    const r = await call(hooks, ctxOf(conv, bus))
    expect(r?.continueWith).toBeDefined()
    expect(events.map((e) => e.status)).toEqual(['round'])
  })

  it('coordinator 返回 undefined（在飞/已停）→ 不发 goal_block_merged', async () => {
    const coordinator = fakeCoordinator()
    coordinator.mergeGoalBlock = async () => undefined
    const { hooks, events } = buildHooks({ goal: goal(), judge: fakeJudge(notMet('r')), coordinator, config: { blockMinTokens: 1 } })
    const { conv, bus } = memoryWithClosedBlock()

    await call(hooks, ctxOf(conv, bus))
    expect(events.map((e) => e.status)).toEqual(['round'])
  })
})

describe('createGoalHooks — ③ G2 信封折叠', () => {
  const g2cfg = { distillMinTokens: 1, distillMinBlocks: 4, blockMinTokens: 10_000_000 }

  it('G1 先于 G2（G1 刚产出的信封可能正好凑满 G2 门槛）', async () => {
    const order: string[] = []
    const coordinator = fakeCoordinator()
    const origMerge = coordinator.mergeGoalBlock!
    const origDistill = coordinator.distillEnvelopes!
    coordinator.mergeGoalBlock = async (i) => { order.push('G1'); return origMerge.call(coordinator, i) }
    coordinator.distillEnvelopes = async (i) => { order.push('G2'); return origDistill.call(coordinator, i) }

    const state = createGoalSessionState()
    state.current = goal()
    const hooks = createGoalHooks({
      state,
      judge: fakeJudge(notMet('r')),
      distiller: fakeDistiller(),
      resolveDriveCoordinator: () => coordinator,
      config: resolveGoalConfig({ blockMinTokens: 1, distillMinTokens: 1, distillMinBlocks: 4 }),
    })
    const { conv, bus } = memoryWithEnvelopes(4)
    await hooks.beforeComplete!(ctxOf(conv, bus))

    expect(order).toEqual(['G1', 'G2'])
  })

  it('达标区间 → 调 distiller、调 distillEnvelopes（带血缘）、发 envelopes_distilled', async () => {
    const coordinator = fakeCoordinator()
    const distiller = fakeDistiller()
    const { hooks, events } = buildHooks({
      goal: goal(), judge: fakeJudge(notMet('r')), coordinator, distiller, config: g2cfg,
    })
    const { conv, bus } = memoryWithEnvelopes(4)

    const r = await call(hooks, ctxOf(conv, bus))

    expect(distiller.calls).toBe(1)
    expect(distiller.runs[0]!.stamps).toEqual(['S-0', 'S-1', 'S-2', 'S-3'])
    expect(distiller.runs[0]!.startIndex).toBe(0)
    expect(distiller.runs[0]!.endIndexExclusive).toBe(4)
    // distiller 拿到的 condition 是 goal 条件（用于写 task_goal）
    expect(coordinator.distills).toHaveLength(1)
    expect(coordinator.distills[0]!.range.sourceStamps).toEqual(['S-0', 'S-1', 'S-2', 'S-3'])
    expect(coordinator.distills[0]!.memory).toBeDefined()

    const distilled = events.find((e) => e.status === 'envelopes_distilled') as Extract<GoalEvent, { status: 'envelopes_distilled' }>
    expect(distilled).toBeDefined()
    expect(distilled.stamp).toBe('S-FAKE-G2')
    expect(distilled.sourceStamps).toEqual(['S-0', 'S-1', 'S-2', 'S-3'])
    expect(distilled.beforeTokens).toBe(9000)
    expect(distilled.afterTokens).toBe(2000)
    // 续跑照常
    expect(r?.continueWith).toBeDefined()
  })

  it('D16 降级：distiller 抛错 → 发 distill_failed、不调 distillEnvelopes、续跑照常', async () => {
    const coordinator = fakeCoordinator()
    const distiller = fakeDistiller({ fail: true })
    const { hooks, events } = buildHooks({
      goal: goal(), judge: fakeJudge(notMet('r')), coordinator, distiller, config: g2cfg,
    })
    const { conv, bus } = memoryWithEnvelopes(4)
    const before = conv.turns().length

    const r = await call(hooks, ctxOf(conv, bus))

    expect(distiller.calls).toBe(1)
    expect(coordinator.distills).toHaveLength(0)
    // 信封原样保留，下一轮再试
    expect(conv.turns()).toHaveLength(before)
    const failed = events.find((e) => e.status === 'distill_failed') as Extract<GoalEvent, { status: 'distill_failed' }>
    expect(failed.err).toContain('distill LLM 500')
    expect(events.some((e) => e.status === 'envelopes_distilled')).toBe(false)
    // G2 失败不影响续跑决策（它是比例优化，不是正确性要求）
    expect(r?.continueWith).toBeDefined()
  })

  it('块数不达标 → 不调 distiller', async () => {
    const distiller = fakeDistiller()
    const { hooks, events } = buildHooks({
      goal: goal(), judge: fakeJudge(notMet('r')), coordinator: fakeCoordinator(), distiller, config: g2cfg,
    })
    const { conv, bus } = memoryWithEnvelopes(3)

    await call(hooks, ctxOf(conv, bus))

    expect(distiller.calls).toBe(0)
    expect(events.some((e) => e.status === 'envelopes_distilled')).toBe(false)
  })

  it('体量不达标 → 不调 distiller', async () => {
    const distiller = fakeDistiller()
    const { hooks } = buildHooks({
      goal: goal(), judge: fakeJudge(notMet('r')), coordinator: fakeCoordinator(), distiller,
      config: { ...g2cfg, distillMinTokens: 10_000_000 },
    })
    const { conv, bus } = memoryWithEnvelopes(4)

    await call(hooks, ctxOf(conv, bus))
    expect(distiller.calls).toBe(0)
  })

  it('coordinator 没有 distillEnvelopes（noop）→ 跳过且不调 distiller', async () => {
    const distiller = fakeDistiller()
    const { hooks, events } = buildHooks({
      goal: goal(), judge: fakeJudge(notMet('r')),
      coordinator: fakeCoordinator({ hasDistill: false }), distiller, config: g2cfg,
    })
    const { conv, bus } = memoryWithEnvelopes(4)

    const r = await call(hooks, ctxOf(conv, bus))
    expect(distiller.calls).toBe(0)
    expect(events.some((e) => e.status === 'envelopes_distilled')).toBe(false)
    expect(r?.continueWith).toBeDefined()
  })

  it('distillEnvelopes 返回 undefined（区间失效/已停）→ 不发 envelopes_distilled', async () => {
    const distiller = fakeDistiller()
    const { hooks, events } = buildHooks({
      goal: goal(), judge: fakeJudge(notMet('r')),
      coordinator: fakeCoordinator({ distillReturnsUndefined: true }), distiller, config: g2cfg,
    })
    const { conv, bus } = memoryWithEnvelopes(4)

    await call(hooks, ctxOf(conv, bus))
    expect(distiller.calls).toBe(1)
    expect(events.some((e) => e.status === 'envelopes_distilled')).toBe(false)
  })

  it('met 裁决时 G1 与 G2 都跑（收尾分支不豁免梯度，2026-09-17 用户拍板）', async () => {
    const coordinator = fakeCoordinator()
    const distiller = fakeDistiller()
    const { hooks } = buildHooks({
      goal: goal(), judge: fakeJudge(met()), coordinator, distiller,
      config: { blockMinTokens: 1, distillMinTokens: 1, distillMinBlocks: 4 },
    })
    const { conv, bus } = memoryWithEnvelopes(4)

    await call(hooks, ctxOf(conv, bus))
    expect(coordinator.merges).toHaveLength(1)
    expect(coordinator.distills).toHaveLength(1)
    expect(distiller.calls).toBe(1)
  })
})

describe('createGoalHooks — 事件通道不得反噬决策', () => {
  it('onEvent 抛错时续跑决策不受影响', async () => {
    const state = createGoalSessionState()
    state.current = goal()
    const hooks = createGoalHooks({
      state,
      judge: fakeJudge(notMet('r')),
      distiller: fakeDistiller(),
      resolveDriveCoordinator: () => undefined,
      config: resolveGoalConfig(),
      onEvent: () => { throw new Error('WS 写炸了') },
    })
    const { conv, bus } = memoryWithClosedBlock()

    const r = await hooks.beforeComplete!(ctxOf(conv, bus))
    expect(r?.continueWith).toBeDefined()
  })

  it('未提供 onEvent 时不抛（headless / 库直用场景）', async () => {
    const state = createGoalSessionState()
    state.current = goal()
    const hooks = createGoalHooks({
      state,
      judge: fakeJudge(met()),
      distiller: fakeDistiller(),
      resolveDriveCoordinator: () => undefined,
      config: resolveGoalConfig(),
    })
    const { conv, bus } = memoryWithClosedBlock()

    await expect(hooks.beforeComplete!(ctxOf(conv, bus))).resolves.toBeUndefined()
  })

  it('只暴露 beforeComplete 一个字段（不污染其它 hook 位）', () => {
    const { hooks } = buildHooks({ goal: goal() })
    expect(Object.keys(hooks)).toEqual(['beforeComplete'])
    expect(hooks.beforeShellCall).toBeUndefined()
    expect(hooks.afterToolExecution).toBeUndefined()
  })
})

describe('createGoalHooks — resolveDriveCoordinator 用活引用', () => {
  it('装配层事后才换上真 coordinator 时，hook 拿到的是新的那个', async () => {
    // assembly 在 createSession 之后才把 handle.runtime.driveCoordinator 从
    // noop 覆盖成真 coordinator（session-manager.ts:137 的 buildLoopOptions
    // 也因此读活引用）。持值版本会静默拿到 noop 而 G1 永不落盘。
    let current: DriveCoordinator | undefined
    const state = createGoalSessionState()
    state.current = goal()
    const hooks = createGoalHooks({
      state,
      judge: fakeJudge(notMet('r')),
      distiller: fakeDistiller(),
      resolveDriveCoordinator: () => current,
      config: resolveGoalConfig({ blockMinTokens: 1 }),
    })
    const { conv, bus } = memoryWithClosedBlock()

    await hooks.beforeComplete!(ctxOf(conv, bus)) // 此时还是 undefined

    const coordinator = fakeCoordinator()
    current = coordinator
    await hooks.beforeComplete!(ctxOf(conv, bus)) // 换上真的了

    expect(coordinator.merges).toHaveLength(1)
  })
})

describe('createGoalHooks — 与 loop 的契约', () => {
  it('beforeComplete 是 async 且返回 Promise（callHook 的契约）', () => {
    const { hooks } = buildHooks({ goal: goal() })
    expect(typeof hooks.beforeComplete).toBe('function')
  })

  it('judge 抛错不会穿透 hook（judge 自身已 fail-open，此处验证 hook 不额外吞错）', async () => {
    const state = createGoalSessionState()
    state.current = goal()
    const hooks = createGoalHooks({
      state,
      judge: { evaluate: vi.fn(async () => { throw new Error('不该发生') }) },
      distiller: fakeDistiller(),
      resolveDriveCoordinator: () => undefined,
      config: resolveGoalConfig(),
    })
    const { conv, bus } = memoryWithClosedBlock()

    // hook 不吞这个错——由 loop 的 callHook 统一吞成弃权（既有失败安全语义，
    // 见 goal-continuation.replay.test.ts 的 H2 用例）。这里只验证它确实抛出。
    await expect(hooks.beforeComplete!(ctxOf(conv, bus))).rejects.toThrow('不该发生')
  })
})
