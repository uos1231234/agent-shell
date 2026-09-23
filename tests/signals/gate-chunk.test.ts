// v0.42 大输入切块 — gate 层接线端到端测试。
//
// 语义锚点（用户拍板 2026-09-15）：
//   - 纯手动：chunk.set(true) 后该会话才切，低于阈值的输入走原并发控制（零改动）
//   - 超长输入切成多卷入队串行：对首立即跑（startTurn），其余由 turn.end →
//     advanceQueue 链式驱动
//   - chunk.set/get 是 gate 持有的状态（chunk-mode），不依赖宿主 handler
//   - chunk.changed 出站信号：前端忠实投影的基准
//   - session.close/delete 时 forget（随队列一起清）
//
// 复用 gate-session-queue.test.ts 的驱动模型：runPrompt mock 挂起回合，测试显式
// settle（发 turn.end）触发链式推进。

import { describe, it, expect, vi } from 'vitest'

import { createSignalGate } from '../../src/signals/gate.js'
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
  settle: () => void
  fail: (e: unknown) => void
}

type Harness = {
  gate: SignalGate
  runPrompt: ReturnType<typeof vi.fn>
  turns: PendingTurn[]
  seenChunk: { enabled: boolean; chunkTokens?: number }[]
}

const makeHarness = (): Harness => {
  const turns: PendingTurn[] = []
  const seenChunk: { enabled: boolean; chunkTokens?: number }[] = []
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
        throw new Error('create: not implemented')
      }),
      open: vi.fn(async () => {
        throw new Error('open: not implemented')
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
  gate.on('chunk.changed', (sig) => {
    if (sig.kind === 'chunk.changed') {
      seenChunk.push({ enabled: sig.enabled, ...(sig.chunkTokens !== undefined ? { chunkTokens: sig.chunkTokens } : {}) })
    }
  })

  return { gate, runPrompt, turns, seenChunk }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('gate 大输入切块（v0.42）', () => {
  it('chunk.set(true) 后 chunk.get 反映开启状态，并广播 chunk.changed', async () => {
    const h = makeHarness()
    const r = await h.gate.command({ kind: 'chunk.set', sessionId: 's1', enabled: true })
    expect(r).toEqual({ enabled: true, changed: true })

    const get = await h.gate.command({ kind: 'chunk.get', sessionId: 's1' })
    expect(get).toEqual({ enabled: true, chunkTokens: 40_000 })
    expect(h.seenChunk).toEqual([{ enabled: true, chunkTokens: 40_000 }])
  })

  it('chunk.set(false) 关闭并广播，chunk.get 报未启用', async () => {
    const h = makeHarness()
    await h.gate.command({ kind: 'chunk.set', sessionId: 's1', enabled: true })
    const r = await h.gate.command({ kind: 'chunk.set', sessionId: 's1', enabled: false })
    expect(r).toEqual({ enabled: false, changed: true })

    const get = await h.gate.command({ kind: 'chunk.get', sessionId: 's1' })
    expect(get).toEqual({ enabled: false })
    expect(h.seenChunk).toEqual([
      { enabled: true, chunkTokens: 40_000 },
      { enabled: false },
    ])
  })

  it('切块未启用时，超长输入也按原并发控制原样发送（单回合，无分卷）', async () => {
    const h = makeHarness()
    const big = 'a'.repeat(100_000) // 超过 40K 但会话未开切块
    void h.gate.command({ kind: 'user.prompt', sessionId: 's1', text: big })
    expect(h.runPrompt).toHaveBeenCalledTimes(1)
    expect(h.turns[0]!.text).toBe(big) // 原样，未被切
  })

  it('切块开启 + 超长输入 → 切成多卷入队，对首立即跑，其余按序接力', async () => {
    const h = makeHarness()
    await h.gate.command({ kind: 'chunk.set', sessionId: 's1', enabled: true })
    const big = 'c'.repeat(90_000) // 40K 一卷 → 至少 3 卷
    // user.prompt 会 await 对首分卷的回合（startTurn），所以不能直接 await——
    // 先把对首 settle，command 才会 resolve（与 gate-session-queue.test 的死锁纪律一致）。
    const cmd = h.gate.command({ kind: 'user.prompt', sessionId: 's1', text: big })

    // 对首已开始执行（分卷带前缀编号）
    expect(h.runPrompt).toHaveBeenCalledTimes(1)
    const total = Number(h.turns[0]!.text.match(/（资料分卷 1\/(\d+)）/)?.[1])
    expect(total).toBeGreaterThan(1)

    h.turns[0]!.settle()
    const receipt = await cmd
    expect(receipt).toMatchObject({ chunked: true })
    expect((receipt as { chunks: number }).chunks).toBe(total)

    // 接力：对首收尾 → 卷二开始，依此类推直到队空
    await flush()
    expect(h.runPrompt).toHaveBeenCalledTimes(2)
    expect(h.turns[1]!.text).toContain(`（资料分卷 2/${total}）`)

    h.turns[1]!.settle()
    await flush()
    expect(h.runPrompt).toHaveBeenCalledTimes(3)
    expect(h.turns[2]!.text).toContain(`（资料分卷 3/${total}）`)
  })

  it('切块所有分卷收尾后回到空闲，后续消息立即执行（不被误判在途）', async () => {
    const h = makeHarness()
    await h.gate.command({ kind: 'chunk.set', sessionId: 's1', enabled: true })
    const big = 'd'.repeat(45_000) // 2 卷
    void h.gate.command({ kind: 'user.prompt', sessionId: 's1', text: big })

    h.turns[0]!.settle()
    await flush()
    h.turns[1]!.settle()
    await flush()

    // 队列已空、busy 解除 → 新消息立即执行
    void h.gate.command({ kind: 'user.prompt', sessionId: 's1', text: 'after' })
    expect(h.runPrompt).toHaveBeenCalledTimes(3)
    expect(h.turns[2]!.text).toBe('after')
  })

  it('切块分卷对 turn.cancel 响应：丢弃排队中的卷，在途卷不受影响', async () => {
    const h = makeHarness()
    await h.gate.command({ kind: 'chunk.set', sessionId: 's1', enabled: true })
    const big = 'e'.repeat(120_000) // 多卷
    void h.gate.command({ kind: 'user.prompt', sessionId: 's1', text: big })
    const total = h.turns.length

    await h.gate.command({ kind: 'turn.cancel', sessionId: 's1' })
    // 对首在途不受影响；排队卷被丢弃 → 对首收尾后不再接力
    h.turns[total - 1]!.settle()
    await flush()
    expect(h.runPrompt).toHaveBeenCalledTimes(1)
    expect(h.turns.map((t) => t.text)).toHaveLength(1)
  })

  it('session.close 忘记切块状态：之后超长输入不被切（随队列一起清）', async () => {
    const h = makeHarness()
    await h.gate.command({ kind: 'chunk.set', sessionId: 's1', enabled: true })

    await h.gate.command({ kind: 'session.close', sessionId: 's1' })

    const get = await h.gate.command({ kind: 'chunk.get', sessionId: 's1' })
    expect(get).toEqual({ enabled: false })
    // 重新发超长输入：不切
    const big = 'f'.repeat(100_000)
    void h.gate.command({ kind: 'user.prompt', sessionId: 's1', text: big })
    expect(h.runPrompt).toHaveBeenCalledTimes(1)
    expect(h.turns[0]!.text).toBe(big)
  })

  it('低于阈值的输入在切块模式下也不切（走原路径，单卷）', async () => {
    const h = makeHarness()
    await h.gate.command({ kind: 'chunk.set', sessionId: 's1', enabled: true })
    void h.gate.command({ kind: 'user.prompt', sessionId: 's1', text: 'short' })
    expect(h.runPrompt).toHaveBeenCalledTimes(1)
    expect(h.turns[0]!.text).toBe('short')
    expect(h.turns).toHaveLength(1)
  })
})