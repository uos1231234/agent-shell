// v0.42 C3 — 受控并行的**次序保证**。用户硬性约束原话："块的先后次序必须得到
// 保证，不要因这一次升级而让 M1 和 M3 压缩机制的错误竞争而产生次序错乱。"
//
// 本文件钉住领取登记表（claims）+ FIFO 落盘屏障给出的六条性质：
//  (1) M3 一波领取**不同**的块（最旧 + 次旧），而不是同一个块领两次；
//  (2) 落盘按领取次序排队——后领取的块即使 LLM 先回来，也不得抢在前一个的戳之前
//      （磁盘戳序 ≡ canonical 阅读序，M3 归档与血缘继承都按戳序讲先后）；
//  (3) 并行度 = 池大小：不传 compressorOverflow 时第二次派发返回 'in-flight'，
//      compressor 恰好被调一次（= v0.42 单飞行为，逐字节不变）；
//  (4) 领取之后 canonical 漂移 → **fail closed**（不逐出、不落盘，宁可这一轮白跑）；
//  (5) nextEligibleBlock 尊重登记表：在飞块对 goal 路径不可见（两条路径不争抢同块）；
//  (6) G2 信封折叠与块压缩全互斥。
//
// 块边界判据不在本文件的断言范围里（那是 findNextTaskBlock 自己的 52 项测试），
// C3 只加"选谁"的 skip 集，不改"什么是块"。

import { describe, it, expect } from 'vitest'
import {
  createDriveCoordinator,
  type DriveDeps,
  type DriveSnapshot,
} from '../../../src/im/system-agents/drive-coordinator.js'
import { ConversationMemory } from '../../../src/im/conversation-memory.js'
import { Databus } from '../../../src/im/databus.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import { createSignalBus } from '../../../src/im/memory-layers.js'
import { appendCanonicalTurn } from '../../../src/im/turn.js'
import type { ConversationTurn } from '../../../src/im/conversation-memory.js'
import type { SystemAgent } from '../../../src/im/system-agent.js'
import type { StateLine, StateLineEntry, RawArchiveRecord, CuratedMemory, M3Summary } from '../../../src/im/state-line/types.js'
import type { ChatMessage } from '../../../src/protocol/types.js'
import type { Logger, LogFields } from '../../../src/shared/logger.js'
import { DEFAULT_MEMORY_CONFIG } from '../../../src/shell/memory-config.js'

const silent = (): Logger => {
  const noop = (): void => {}
  const make = (): Logger => ({
    trace: noop, debug: noop, info: noop, warn: noop, error: noop,
    child: () => make(),
  })
  return make()
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * 可控压缩机：`delayMs` 模拟 LLM 往返快慢，`onRun` 在 run 期间（= 领取之后、
 * 落盘之前）对 canonical 做手脚。产出的 task_goal 取自收到的**首条 user 消息**，
 * 于是落盘记录能反查出它是哪个块——次序断言因此不需要额外旁路。
 */
type Compressor = SystemAgent & {
  calls: ChatMessage[][]
  runCount(): number
}

const fakeCompressor = (opts: {
  delayMs?: number
  onRun?: (nth: number) => void | Promise<void>
} = {}): Compressor => {
  const calls: ChatMessage[][] = []
  const agent = {
    calls,
    async run(input: { messages: ChatMessage[] }) {
      const nth = calls.length
      calls.push([...input.messages])
      if (opts.onRun !== undefined) await opts.onRun(nth)
      if (opts.delayMs !== undefined && opts.delayMs > 0) {
        await new Promise<void>((r) => setTimeout(r, opts.delayMs))
      }
      const firstUser = input.messages.find((m) => m.role === 'user')?.content
      const memory: CuratedMemory = {
        task_goal: typeof firstUser === 'string' ? firstUser : 'unknown',
        causal_steps: [],
        evidence_fragments: [],
        conclusion: '结论',
        next_action: '无',
        working_state: {
          current_goal: 'g', effective_decisions: [], rejected_decisions: [],
          architecture_boundaries: [], remaining_work: [],
        },
        status_hint: 'DONE',
      }
      return {
        output: '', submitted: memory, metrics: {} as never,
        finalState: 'Running' as never, reason: 'completed' as const, hits: [],
      }
    },
    stop() {},
    send() {},
  }
  return Object.assign(agent, { runCount: () => calls.length }) as Compressor
}

const neverAgent = (): SystemAgent => ({
  async run() { throw new Error('warehouse 不该被唤醒（本测试 curated 为空）') },
  stop() {},
  send() {},
})

/** 记录 appendBlock 的 (stamp, task_goal, zone) 序列——次序断言的事实源。 */
const recordingStateLine = (opts: { holdAppend?: () => Promise<void> } = {}): StateLine & {
  blocks: Array<{ stamp: string; taskGoal: string; zone: string }>
  archives: RawArchiveRecord[]
} => {
  const blocks: Array<{ stamp: string; taskGoal: string; zone: string }> = []
  const archives: RawArchiveRecord[] = []
  const line: StateLine & { blocks: typeof blocks; archives: RawArchiveRecord[] } = {
    compressor: {
      async appendBlock(memory: CuratedMemory, layer: 'M1' | 'M2', stamp: string) {
        if (opts.holdAppend !== undefined) await opts.holdAppend()
        blocks.push({ stamp, taskGoal: memory.task_goal, zone: layer })
      },
    },
    warehouse: {
      async appendSummary(_s: M3Summary) {},
      async queryM3() { return { ok: false, error: 'mock' } },
    },
    rawArchive: {
      async append(r: RawArchiveRecord) { archives.push(r) },
      async query() { return archives },
    },
    // curated 恒空 → tick 的 M3 归档驱动直接早退，warehouse 不被唤醒。
    query(_filter?: { layer?: string }): readonly StateLineEntry[] { return [] },
    subscribe() { return () => {} },
    close() {},
    blocks,
    archives,
  }
  return line
}

// ---------------------------------------------------------------------------
// Canonical fixtures（显式 id，断言可读）
// ---------------------------------------------------------------------------

let clock = 0
const u = (id: string, content = id): ConversationTurn => ({ id, role: 'user', content, at: (clock += 1) })
const a = (id: string, content = id): ConversationTurn => ({ id, role: 'assistant', content, at: (clock += 1) })
const env = (id: string): ConversationTurn => ({ id, role: 'user', content: `#STAMP ${id}\n#END_BLOCK`, at: (clock += 1) })

/** 两个已关闭块 + 一段未关闭尾部：[u1 a1] [u2 a2] [u3 a3…]。 */
const twoClosedBlocks = (): { conv: ConversationMemory; bus: Databus } => {
  const conv = new ConversationMemory()
  const bus = new Databus()
  for (const t of [u('u1'), a('a1'), u('u2'), a('a2'), u('u3'), a('a3')]) appendCanonicalTurn(conv, bus, t)
  return { conv, bus }
}

const M3 = DEFAULT_MEMORY_CONFIG.m3MinTokens

const snapshotOf = (conv: ConversationMemory, bus: Databus, contextTokens = M3): DriveSnapshot => ({
  contextTokens, conversation: conv, databus: bus,
})

const depsOf = (over: Partial<DriveDeps> = {}): DriveDeps => ({
  bus: createSignalBus(),
  compressor: fakeCompressor(),
  warehouse: neverAgent(),
  stateLine: recordingStateLine(),
  mailbox: new Mailbox(),
  workingAgentId: 'main',
  logger: silent(),
  ...over,
})

// ---------------------------------------------------------------------------

describe('C3 — M3 压力阀领取不同的块', () => {
  it('池=2 时一次 M3 tick 压掉两个块（最旧 + 次旧），且各自用一个池实例', async () => {
    const { conv, bus } = twoClosedBlocks()
    const c0 = fakeCompressor()
    const c1 = fakeCompressor()
    const stateLine = recordingStateLine()
    const coordinator = createDriveCoordinator(depsOf({
      compressor: c0, compressorOverflow: c1, stateLine,
    }))

    await coordinator.tick(snapshotOf(conv, bus))

    // 两个实例各一次，且看到的块内容不同（不是同一个块被领两次）
    expect(c0.calls).toHaveLength(1)
    expect(c1.calls).toHaveLength(1)
    const seen = [c0.calls[0]![0]!.content, c1.calls[0]![0]!.content]
    expect(seen).toEqual(['u1', 'u2'])
    // 两个块都从 canonical 消失，被各自的原位信封替代
    expect(conv.turns().filter((t) => t.id === 'a1' || t.id === 'a2')).toHaveLength(0)
    expect(stateLine.blocks).toHaveLength(2)
  })

  it('池=1 时同一 tick 的第二次派发返回 in-flight，compressor 只被调一次（v0.42 行为）', async () => {
    const { conv, bus } = twoClosedBlocks()
    const c0 = fakeCompressor({ delayMs: 5 })
    const coordinator = createDriveCoordinator(depsOf({ compressor: c0 }))

    // 两个 tick 同时在飞：第二个 tick 见池满 → 'in-flight'，不排队不重试
    await Promise.all([coordinator.tick(snapshotOf(conv, bus)), coordinator.tick(snapshotOf(conv, bus))])

    expect(c0.calls).toHaveLength(1)
  })

  it('M1 层（200K–500K）不受压力阀影响：池=2 也只派一个块', async () => {
    const { conv, bus } = twoClosedBlocks()
    const c0 = fakeCompressor()
    const c1 = fakeCompressor()
    const coordinator = createDriveCoordinator(depsOf({ compressor: c0, compressorOverflow: c1 }))

    await coordinator.tick(snapshotOf(conv, bus, DEFAULT_MEMORY_CONFIG.m1MinTokens))

    expect(c0.calls).toHaveLength(1)
    expect(c1.calls).toHaveLength(0)
  })
})

describe('C3 — FIFO 落盘屏障：戳序 ≡ canonical 序', () => {
  it('年轻块的 LLM 先回来，落盘仍按领取次序（最旧的戳先进磁盘）', async () => {
    const { conv, bus } = twoClosedBlocks()
    // 领到 u1 块的实例慢，领到 u2 块的实例快——若无屏障，磁盘上 u2 的戳会排在前面
    const slow = fakeCompressor({ delayMs: 40 })
    const fast = fakeCompressor()
    const stateLine = recordingStateLine()
    const coordinator = createDriveCoordinator(depsOf({
      compressor: slow, compressorOverflow: fast, stateLine,
    }))

    await coordinator.tick(snapshotOf(conv, bus))

    expect(stateLine.blocks.map((b) => b.taskGoal)).toEqual(['u1', 'u2'])
    expect(stateLine.archives.map((r) => r.sourceTurnIds[0])).toEqual(['u1', 'u2'])
  })

  it('信封在 canonical 里的先后与块的原先后一致', async () => {
    const { conv, bus } = twoClosedBlocks()
    const slow = fakeCompressor({ delayMs: 40 })
    const fast = fakeCompressor()
    const coordinator = createDriveCoordinator(depsOf({ compressor: slow, compressorOverflow: fast }))

    await coordinator.tick(snapshotOf(conv, bus))

    const ids = conv.turns().map((t) => t.id)
    const envs = ids.filter((id) => id.startsWith('mem-'))
    expect(envs).toHaveLength(2)
    // 信封之后紧跟 u3（两块被压掉的区间不重叠、不交错）
    expect(ids.indexOf(envs[0]!)).toBeLessThan(ids.indexOf(envs[1]!))
    expect(ids.indexOf(envs[1]!)).toBeLessThan(ids.indexOf('u3'))
  })
})

describe('C3 — 漂移即 fail closed', () => {
  it('领取后块区间被改动 → 不逐出、不落盘（宁可这一轮白跑）', async () => {
    const { conv, bus } = twoClosedBlocks()
    // run 期间（领取之后）往块内部插一条新的 user 边界：落盘时的重定位会发现
    // 成员对不上，必须拒绝而不是按老下标 evictRange。
    const intruder = fakeCompressor({
      onRun: () => { conv.replaceRange(1, 1, [u('user-inject')]) },
    })
    const stateLine = recordingStateLine()
    const coordinator = createDriveCoordinator(depsOf({ compressor: intruder, stateLine }))

    await coordinator.tick(snapshotOf(conv, bus, DEFAULT_MEMORY_CONFIG.m1MinTokens))

    expect(stateLine.blocks).toHaveLength(0)
    expect(stateLine.archives).toHaveLength(0)
    // 原块回合仍在（没有被错删），且插入的边界也在
    expect(conv.turns().map((t) => t.id)).toContain('a1')
    expect(conv.turns().map((t) => t.id)).toContain('user-inject')
  })
})

describe('C3 — 两条路径不争抢同一个块', () => {
  it('nextEligibleBlock 跳过在飞块（goal 的 G1 因此拿到次旧块）', async () => {
    const { conv, bus } = twoClosedBlocks()
    let releaseRun: () => void = () => {}
    const gate = new Promise<void>((r) => { releaseRun = r })
    const held = fakeCompressor({ onRun: () => gate })
    const coordinator = createDriveCoordinator(depsOf({ compressor: held }))

    const tick = coordinator.tick(snapshotOf(conv, bus))
    // tick 的第一个 await 是 M3 归档驱动（curated 为空 → 早退），让出一个宏任务
    // 后它才走到派发；此刻 u1 已被领取，compressor 还被 gate 攥着。
    await new Promise<void>((r) => setTimeout(r, 0))
    const next = coordinator.nextEligibleBlock(conv.turns())
    expect(next?.startUserTurnId).toBe('u2')

    releaseRun()
    await tick
  })

  it('G2 折叠在飞时，块压缩一个也不派（登记表全互斥）', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    for (const t of [env('mem-1'), env('mem-2'), u('u9'), a('a9'), u('u10')]) appendCanonicalTurn(conv, bus, t)

    let releaseAppend: () => void = () => {}
    const appendGate = new Promise<void>((r) => { releaseAppend = r })
    const stateLine = recordingStateLine({ holdAppend: () => appendGate })
    const compressor = fakeCompressor()
    const coordinator = createDriveCoordinator(depsOf({ compressor, stateLine }))

    const memory: CuratedMemory = {
      task_goal: '折叠', causal_steps: [], evidence_fragments: [], conclusion: 'c',
      next_action: 'n',
      working_state: {
        current_goal: 'g', effective_decisions: [], rejected_decisions: [],
        architecture_boundaries: [], remaining_work: [],
      },
      status_hint: 'PENDING',
    }
    const distill = coordinator.distillEnvelopes!({
      snapshot: snapshotOf(conv, bus),
      memory,
      range: { startIndex: 0, endIndexExclusive: 2, sourceStamps: ['mem-1', 'mem-2'] },
    })
    // distill 的领取同步完成，appendBlock 现在被我们攥着
    const tick = coordinator.tick(snapshotOf(conv, bus))
    expect(compressor.calls).toHaveLength(0)

    releaseAppend()
    await Promise.all([distill, tick])
    expect(stateLine.blocks.map((b) => b.taskGoal)).toEqual(['折叠'])
  })
})
