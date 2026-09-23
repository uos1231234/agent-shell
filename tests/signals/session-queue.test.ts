// v0.34 C1：会话级回合串行化器单测。
//
// 语义锚点（用户拍板 2026-09-10）：方案 A 排队 —— 不丢弃、不顶替；取消丢掉排队中的
// 但在途回合不受影响；跨会话并行、同会话串行。

import { describe, it, expect } from 'vitest'
import { createSessionQueue } from '../../src/signals/session-queue.js'

describe('createSessionQueue — 同会话串行（v0.34 C1）', () => {
  it('空闲会话 begin → run，并标记为在途', () => {
    const q = createSessionQueue()
    expect(q.begin('s1', 'A')).toEqual({ kind: 'run' })
    expect(q.isBusy('s1')).toBe(true)
    expect(q.pending('s1')).toBe(0)
  })

  it('在途会话 begin → queued，position 从 1 递增且不丢消息', () => {
    const q = createSessionQueue()
    q.begin('s1', 'A')
    expect(q.begin('s1', 'B')).toEqual({ kind: 'queued', position: 1 })
    expect(q.begin('s1', 'C')).toEqual({ kind: 'queued', position: 2 })
    expect(q.begin('s1', 'D')).toEqual({ kind: 'queued', position: 3 })
    expect(q.pending('s1')).toBe(3)
    expect(q.isBusy('s1')).toBe(true)
  })

  it('finish 按 FIFO 提升队首，会话保持 busy', () => {
    const q = createSessionQueue()
    q.begin('s1', 'A')
    q.begin('s1', 'B')
    q.begin('s1', 'C')

    expect(q.finish('s1')).toBe('B')
    expect(q.isBusy('s1')).toBe(true)
    expect(q.pending('s1')).toBe(1)

    expect(q.finish('s1')).toBe('C')
    expect(q.isBusy('s1')).toBe(true)
    expect(q.pending('s1')).toBe(0)
  })

  it('finish 队空 → 解除 busy，之后 begin 又是 run', () => {
    const q = createSessionQueue()
    q.begin('s1', 'A')
    expect(q.finish('s1')).toBeUndefined()
    expect(q.isBusy('s1')).toBe(false)

    // 队列已空 → 新消息立即执行，而不是被误判为在途
    expect(q.begin('s1', 'B')).toEqual({ kind: 'run' })
  })

  it('dropPending（turn.cancel）：丢掉排队消息、返回条数，**在途回合与 busy 不受影响**', () => {
    const q = createSessionQueue()
    q.begin('s1', 'A')
    q.begin('s1', 'B')
    q.begin('s1', 'C')

    expect(q.dropPending('s1')).toBe(2)
    expect(q.pending('s1')).toBe(0)
    // 关键：busy 必须保持——被取消的回合还在收尾，此时放新消息进来就会同会话并发
    expect(q.isBusy('s1')).toBe(true)

    // 在途回合收尾 → 解除 busy
    expect(q.finish('s1')).toBeUndefined()
    expect(q.isBusy('s1')).toBe(false)

    // 被丢掉的 B/C 不再出现
    expect(q.begin('s1', 'D')).toEqual({ kind: 'run' })
    expect(q.finish('s1')).toBeUndefined()
  })

  it('dropPending 后立即 begin 仍被排队（不会因为清了队列就放行）', () => {
    const q = createSessionQueue()
    q.begin('s1', 'A')
    q.begin('s1', 'B')
    q.dropPending('s1')

    // 在途回合还没收尾 → 新消息必须排队，否则同会话出现两个回合
    expect(q.begin('s1', 'C')).toEqual({ kind: 'queued', position: 1 })
  })

  it('forget（session.close/delete）：队列与 busy 一起清', () => {
    const q = createSessionQueue()
    q.begin('s1', 'A')
    q.begin('s1', 'B')

    q.forget('s1')
    expect(q.isBusy('s1')).toBe(false)
    expect(q.pending('s1')).toBe(0)
    expect(q.begin('s1', 'C')).toEqual({ kind: 'run' })
  })

  it('跨会话必须并行：s1 在途不影响 s2', () => {
    const q = createSessionQueue()
    expect(q.begin('s1', 'A')).toEqual({ kind: 'run' })
    expect(q.begin('s2', 'B')).toEqual({ kind: 'run' })
    expect(q.isBusy('s1')).toBe(true)
    expect(q.isBusy('s2')).toBe(true)

    q.begin('s1', 'A2')
    expect(q.pending('s1')).toBe(1)
    expect(q.pending('s2')).toBe(0) // 排队不串台

    q.dropPending('s1')
    expect(q.isBusy('s2')).toBe(true) // 清 s1 不影响 s2
  })

  it('对未知会话的 finish / dropPending / forget / pending 是安全 no-op', () => {
    const q = createSessionQueue()
    expect(q.finish('nope')).toBeUndefined()
    expect(q.dropPending('nope')).toBe(0)
    q.forget('nope')
    expect(q.isBusy('nope')).toBe(false)
    expect(q.pending('nope')).toBe(0)
  })

  it('长链：连续入队 5 条后逐条提升，顺序与内容完全一致', () => {
    const q = createSessionQueue()
    q.begin('s1', 'm0')
    for (let i = 1; i <= 5; i++) {
      expect(q.begin('s1', `m${i}`)).toEqual({ kind: 'queued', position: i })
    }
    const drained: string[] = []
    for (;;) {
      const next = q.finish('s1')
      if (next === undefined) break
      drained.push(next)
    }
    expect(drained).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    expect(q.isBusy('s1')).toBe(false)
  })
})
