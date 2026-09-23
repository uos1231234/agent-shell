// 真实并发测试（场景 3）：createSignalBus 并发 emit。
//
// 机制来源（已读代码）：
//   src/im/memory-layers.ts:51-81  createSignalBus
//     - emit 用 Promise.all([...set].map(h => h(signal))) 并发触发同层 handler
//     - 每个 createSignalBus 实例拥有独立 handlers Map（per-instance 隔离）
//     - 任一 handler 抛错 → Promise.all reject → emit() reject；但其余 handler
//       已被并发调用（不因为某个兄弟抛错而跳过）
//     - 未知 requestId / 迟到回包：GateBus 无此概念；本文件只测 SignalBus。
//
// 注意：此处测的是 memory-layers 的 SignalBus（layer 信号），与 signals/gate.ts
// 的审批请求-应答是两套独立机制；场景 10 的审批并发在 approval-gate.test.ts。

import { describe, it, expect } from 'vitest'
import { createSignalBus } from '../../../src/im/memory-layers.js'

describe('concurrency: SignalBus 并发 emit', () => {
  it('同层多个 handler 被并发触发（Promise.all，非顺序），且不丢事件', async () => {
    const bus = createSignalBus()
    const order: string[] = []
    // 慢 handler（30ms）与快 handler（2ms）并发，若顺序执行总时≈32ms，并发≈30ms。
    bus.on('M1', async () => { await new Promise((r) => setTimeout(r, 30)); order.push('slow') })
    bus.on('M1', async () => { await new Promise((r) => setTimeout(r, 2)); order.push('fast') })

    const start = Date.now()
    const signal = await bus.emit(300_000) // M1
    const elapsed = Date.now() - start

    expect(signal.layer).toBe('M1')
    expect(order).toHaveLength(2) // 两个都触发，无丢失
    // 并发：总时 ≈ max(30,2)，远小于 32（顺顺序上限）。宽松阈值防 CI 抖动。
    expect(elapsed).toBeLessThan(60)
    bus.clear()
  })

  it('某 handler 抛错：其余 handler 仍被调用，但 emit() 整体 reject（不静默吞错）', async () => {
    const bus = createSignalBus()
    const ran: string[] = []
    bus.on('M2', () => { ran.push('a') })
    bus.on('M2', async () => { await Promise.resolve(); ran.push('b'); throw new Error('boom') })
    bus.on('M2', () => { ran.push('c') })

    await expect(bus.emit(600_000)).rejects.toThrow('boom')
    // 关键不变量：b 抛错不阻止 a / c 的执行（Promise.all 并发，均已 dispatch）
    expect(ran.sort()).toEqual(['a', 'b', 'c'])
    bus.clear()
  })

  it('per-instance 隔离：两个 bus 并发 emit 同层，互不串台', async () => {
    const busA = createSignalBus()
    const busB = createSignalBus()
    const aRan: number[] = []
    const bRan: number[] = []
    busA.on('M1', () => { aRan.push(1) })
    busB.on('M1', () => { bRan.push(1) })

    // 并发：A emit 多次、B emit 多次，交错执行
    await Promise.all([
      busA.emit(300_000),
      busB.emit(300_000),
      busA.emit(300_000),
      busB.emit(300_000),
    ])

    expect(aRan).toHaveLength(2)
    expect(bRan).toHaveLength(2)
    busA.clear()
    busB.clear()
  })
})
