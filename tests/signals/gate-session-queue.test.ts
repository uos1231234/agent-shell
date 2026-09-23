// v0.34 C1：gate 层会话级串行化（排队）端到端测试。
//
// 语义锚点（用户拍板 2026-09-10）：
//   - 方案 A 排队：同会话第二条 user.prompt 不丢弃、不顶替（D2）
//   - 防线在 gate 层，一处设防覆盖所有前端（D1）
//   - 排队必须前端可见：turn.queue 权威广播 + 回执带 queued/position（D9）
//   - 取消丢掉排队中的、在途不受影响（D3）
//
// 测试如何驱动「回合」：gate 自身不产 turn.end——真实宿主装配层在 runPrompt 成功后
// emit（见 src/host/assembly.ts 的 runPrompt handler）。所以这里的 runPrompt mock
// 模拟同一职责：把每个回合挂起，由测试显式 settle（发 turn.end）或 fail。
//
// 注意「立即执行」的那条 prompt 必须由测试 settle 才会 resolve——所以断言前先 settle，
// 不能直接 await（会死锁）。sendPrompt() 返回的 started 已同步判定好这一点。

import { describe, it, expect, vi } from 'vitest'

import { createSignalGate } from '../../src/signals/gate.js'
import { isQueuedPromptReceipt } from '../../src/signals/session-queue.js'
import type { SignalGate, SignalGateHandlers } from '../../src/signals/types.js'
import type { IMLoopResult } from '../../src/im/loop.js'
import { createMetrics } from '../../src/shell/metrics.js'

const loopResult = (): IMLoopResult => ({
  terminated: false,
  reason: 'completed',
  finalState: 'Running',
  hits: [],
  turns: 1,
  metrics: createMetrics(),
})

type PendingTurn = {
  sessionId: string
  text: string
  /** 模拟宿主装配层：收尾并发 turn.end（成功路径）。 */
  settle: () => void
  /** 失败路径：runPrompt 抛错——注意此时**不会**有 turn.end。 */
  fail: (e: unknown) => void
}

type Harness = {
  gate: SignalGate
  runPrompt: ReturnType<typeof vi.fn>
  turns: PendingTurn[]
  seenQueue: number[]
  /**
   * 发一条 user.prompt。
   * started=true 表示它**立即开始执行**（turns 末尾多了一条待 settle 的回合）；
   * started=false 表示被排队（promise 已带排队回执，无需 settle）。
   */
  sendPrompt: (sessionId: string, text: string) => { promise: Promise<unknown>; started: boolean }
}

const makeHarness = (): Harness => {
  const turns: PendingTurn[] = []
  const seenQueue: number[] = []
  let gate!: SignalGate

  const runPrompt = vi.fn(
    (sessionId: string, text: string): Promise<IMLoopResult> =>
      new Promise<IMLoopResult>((resolve, reject) => {
        turns.push({
          sessionId,
          text,
          settle: () => {
            const result = loopResult()
            gate.emit({ kind: 'turn.end', sessionId, result })
            resolve(result)
          },
          fail: reject,
        })
      }),
  )

  const handlers: SignalGateHandlers = {
    runPrompt,
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
  }

  gate = createSignalGate({ handlers })
  gate.on('turn.queue', (sig) => {
    if (sig.kind === 'turn.queue') seenQueue.push(sig.pending)
  })

  const sendPrompt = (sessionId: string, text: string): { promise: Promise<unknown>; started: boolean } => {
    const before = turns.length
    const promise = gate.command({ kind: 'user.prompt', sessionId, text })
    // 失败路径的测试会让它 reject；这里先接住，避免 unhandled rejection 干扰断言。
    promise.catch(() => {})
    return { promise, started: turns.length > before }
  }

  return { gate, runPrompt, turns, seenQueue, sendPrompt }
}

/** 让已 resolve 的 promise 回调与 advanceQueue 的 .catch 链跑完。 */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('gate 会话级串行化（v0.34 C1）', () => {
  it('空闲会话立即执行，且不返回排队回执', async () => {
    const h = makeHarness()
    const { promise, started } = h.sendPrompt('s1', 'A')

    expect(started).toBe(true)
    expect(h.runPrompt).toHaveBeenCalledTimes(1)
    expect(h.turns.map((t) => t.text)).toEqual(['A'])

    h.turns[0]!.settle()
    const receipt = await promise
    expect(isQueuedPromptReceipt(receipt)).toBe(false)
    expect(h.seenQueue).toEqual([0]) // 收尾时广播"队列空"
  })

  it('同会话第二条排队：返回 {queued,position} 回执（决策 A），且不立刻执行', async () => {
    const h = makeHarness()
    void h.sendPrompt('s1', 'A')

    const b = h.sendPrompt('s1', 'B')
    const c = h.sendPrompt('s1', 'C')

    expect(b.started).toBe(false)
    expect(c.started).toBe(false)
    expect(await b.promise).toEqual({ queued: true, position: 1 })
    expect(await c.promise).toEqual({ queued: true, position: 2 })
    // 只有 A 在跑；B/C 排队未执行（不丢弃也不顶替）
    expect(h.runPrompt).toHaveBeenCalledTimes(1)
    expect(h.turns.map((t) => t.text)).toEqual(['A'])
  })

  it('排队必须前端可见：turn.queue 权威广播 pending 条数（D9）', async () => {
    const h = makeHarness()
    void h.sendPrompt('s1', 'A')
    await h.sendPrompt('s1', 'B').promise
    await h.sendPrompt('s1', 'C').promise

    expect(h.seenQueue).toEqual([1, 2])
  })

  it('turn.end 触发出队：队首自动接力执行，pending 递减', async () => {
    const h = makeHarness()
    void h.sendPrompt('s1', 'A')
    await h.sendPrompt('s1', 'B').promise
    await h.sendPrompt('s1', 'C').promise

    // A 收尾 → 出队 B（B 开始跑）
    h.turns[0]!.settle()
    await flush()

    expect(h.runPrompt).toHaveBeenCalledTimes(2)
    expect(h.turns.map((t) => t.text)).toEqual(['A', 'B'])
    expect(h.seenQueue).toEqual([1, 2, 1])

    // B 收尾 → 出队 C
    h.turns[1]!.settle()
    await flush()

    expect(h.runPrompt).toHaveBeenCalledTimes(3)
    expect(h.turns.map((t) => t.text)).toEqual(['A', 'B', 'C'])
    expect(h.seenQueue).toEqual([1, 2, 1, 0])

    // C 收尾 → 队列空、busy 解除 → 新消息立即执行
    h.turns[2]!.settle()
    await flush()

    const d = h.sendPrompt('s1', 'D')
    expect(d.started).toBe(true)
    h.turns[3]!.settle()
    await d.promise
  })

  it('跨会话并行：s1 在途不影响 s2 立即执行', async () => {
    const h = makeHarness()
    void h.sendPrompt('s1', 'A1')

    const b = h.sendPrompt('s2', 'B1')

    expect(b.started).toBe(true)
    expect(h.runPrompt).toHaveBeenCalledTimes(2)
    expect(h.turns.map((t) => `${t.sessionId}:${t.text}`)).toEqual(['s1:A1', 's2:B1'])

    h.turns[1]!.settle()
    await b.promise
  })

  it('turn.cancel 丢掉排队中的（D3）：pending 广播归零，且后继不再被执行', async () => {
    const h = makeHarness()
    void h.sendPrompt('s1', 'A')
    await h.sendPrompt('s1', 'B').promise

    await h.gate.command({ kind: 'turn.cancel', sessionId: 's1' })
    expect(h.seenQueue).toEqual([1, 0])

    // 在途 A 收尾 → 队列已被取消，B **不得**被执行
    h.turns[0]!.settle()
    await flush()

    expect(h.runPrompt).toHaveBeenCalledTimes(1)
    expect(h.turns.map((t) => t.text)).toEqual(['A'])

    // A 收尾后 busy 才解除 → 新消息立即执行（而非被误判排队）
    const c = h.sendPrompt('s1', 'C')
    expect(c.started).toBe(true)
  })

  it('runPrompt 抛错时队列不卡死：继续推进（该路径无 turn.end）', async () => {
    const h = makeHarness()
    void h.sendPrompt('s1', 'A')
    await h.sendPrompt('s1', 'B').promise

    h.turns[0]!.fail(new Error('boom'))
    await flush()

    // A 失败不影响队列：B 被推进执行（否则会话永久卡在 busy）
    expect(h.runPrompt).toHaveBeenCalledTimes(2)
    expect(h.turns.map((t) => t.text)).toEqual(['A', 'B'])
  })

  it('排队回合自身抛错也继续推进到队尾，最终回到空闲', async () => {
    const h = makeHarness()
    void h.sendPrompt('s1', 'A')
    await h.sendPrompt('s1', 'B').promise
    await h.sendPrompt('s1', 'C').promise

    h.turns[0]!.fail(new Error('boom'))
    await flush()
    expect(h.turns.map((t) => t.text)).toEqual(['A', 'B'])

    h.turns[1]!.fail(new Error('boom again'))
    await flush()
    expect(h.turns.map((t) => t.text)).toEqual(['A', 'B', 'C'])

    // 队尾失败后会话回空闲
    h.turns[2]!.fail(new Error('boom third'))
    await flush()
    const d = h.sendPrompt('s1', 'D')
    expect(d.started).toBe(true)
    expect(h.runPrompt).toHaveBeenCalledTimes(4)
  })

  it('session.close 忘记该会话：队列清空，新消息立即执行', async () => {
    const h = makeHarness()
    void h.sendPrompt('s1', 'A')
    await h.sendPrompt('s1', 'B').promise

    await h.gate.command({ kind: 'session.close', sessionId: 's1' })
    expect(h.seenQueue).toEqual([1, 0])

    const c = h.sendPrompt('s1', 'C')
    expect(c.started).toBe(true)
    expect(h.runPrompt).toHaveBeenCalledTimes(2)
  })
})
