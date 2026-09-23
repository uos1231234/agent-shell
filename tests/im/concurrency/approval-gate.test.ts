// 真实并发测试（场景 10）：审批流并发 —— 两个 approval 请求同时到达，
// 前端回包是否可能串到错误请求（典型竞争缺陷：只用一个 pending 槽位）。
//
// 机制来源（已读代码）：
//   src/signals/gate.ts:95-116  request()
//     - 每次 request 生成唯一 requestId = `req-${randomUUID()}`，并存入
//       pending: Map<requestId, PendingRequest>（【每个请求一个独立槽位】）。
//   src/signals/gate.ts:183-185  approval.decision 命令 → resolve(requestId, decision)
//     - resolve 用 requestId 精确查表落到对应 promise。
//   结论：gate 使用 per-request UUID 槽位，两个并发审批请求各有独立 pending，
//   回包按 requestId 路由，【不存在「单个 pending 槽位串台」缺陷】。本测试守护之。

import { describe, it, expect } from 'vitest'
import { createSignalGate } from '../../../src/signals/gate.js'
import type { SignalGateHandlers } from '../../../src/signals/types.js'

const noopHandlers: SignalGateHandlers = {
  runPrompt: async () => ({ terminated: true, reason: 'completed', finalState: 'Running', hits: [], turns: 0, metrics: {} as never }),
  session: {
    create: async () => ({}) as never,
    open: async () => ({}) as never,
    list: async () => [],
    close: async () => {},
    delete: async () => {},
    history: async () => [],
  },
  cancel: () => {},
  setFullPermission: () => {},
}

describe('concurrency: 审批流并发（gate per-request 槽位）', () => {
  it('两个并发 approval 请求：各自独立 resolve，回包不串台', async () => {
    const gate = createSignalGate({ handlers: noopHandlers })

    // 捕获两个请求的 requestId（模拟前端收到审批 UI 弹出）。
    const captured: string[] = []
    const unsub = gate.on('approval', (sig) => {
      const s = sig as { kind: 'approval'; requestId: string }
      if (s.kind === 'approval') captured.push(s.requestId)
    })

    const p1 = gate.request({ kind: 'approval', payload: { toolName: 'bash', args: {}, reason: 'r1' } })
    const p2 = gate.request({ kind: 'approval', payload: { toolName: 'write', args: {}, reason: 'r2' } })

    expect(captured).toHaveLength(2)
    expect(captured[0]).not.toBe(captured[1]) // 请求 id 互不相同

    // 前端分别回包（注意：用捕获到的 requestId 精确路由）
    gate.command({ kind: 'approval.decision', requestId: captured[0]!, decision: 'approved' })
    gate.command({ kind: 'approval.decision', requestId: captured[1]!, decision: 'rejected' })

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe('approved') // 第一请求的回包落到第一请求
    expect(r2).toBe('rejected') // 第二请求的回包落到第二请求，无串台
    expect(gate.snapshot().pendingRequests).toBe(0) // 两个都已清理
    unsub()
  })

  it('迟到的/未知 requestId 回包被静默忽略（不污染其它挂起请求）', async () => {
    const gate = createSignalGate({ handlers: noopHandlers })
    const captured: string[] = []
    const unsub = gate.on('approval', (sig) => {
      const s = sig as { kind: 'approval'; requestId: string }
      if (s.kind === 'approval') captured.push(s.requestId)
    })

    const p = gate.request({ kind: 'approval', payload: { toolName: 'bash', args: {}, reason: 'x' } })
    // 先发一个未知 requestId 的回包
    gate.command({ kind: 'approval.decision', requestId: 'req-nonexistent', decision: 'approved' })
    expect(gate.snapshot().pendingRequests).toBe(1) // 真实请求仍挂起

    gate.command({ kind: 'approval.decision', requestId: captured[0]!, decision: 'approved' })
    expect(await p).toBe('approved')
    unsub()
  })
})
