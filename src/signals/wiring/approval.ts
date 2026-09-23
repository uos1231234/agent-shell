// v0.21 Signal Gate — approval 接线器。
//
// 把 extensions.ts 的 fail-closed reject stub（approval 默认 handler）替换为
// "经 Gate.request 问前端"的实现。审批判定 / grant / fail-closed 语义全部
// 留在既有链路（write-approval door + ApprovalStore），这里只替换"问人"这
// 一环：
//
//   door.check → handler(request)             ← 本接线器产出的 handler
//                 → gate.request({kind:'approval', payload, sessionId})
//                     → 广播 GateRequest 给前端（弹出审批浮层）
//                 → 前端 command('approval.decision') → gate.resolve()
//                 → payload === 'approved' ? 'approved' : 'rejected'
//
// 超时语义：gate.request 默认 300s fail-closed（与 door 的 300s 对齐）；
// gate 侧先超时则本 handler 抛错 → door 的 callHandlerWithTimeout 捕获 →
// fail-closed deny，语义一致。

import type { ApprovalHandler } from '../../im/tools/security/approval-store.js'
import type { SignalGate } from '../index.js'

export type GateApprovalWiringDeps = {
  gate: SignalGate
  /**
   * 信号归属的 session。审批 handler 在 registry 层是跨会话共享的（没有
   * per-session 上下文），wiring 层用 provider 尽力标注归属；单会话宿主
   * 直接返回固定 id，多会话宿主返回当前活跃会话。
   */
  getSessionId: () => string
}

export const createGateApprovalHandler = (deps: GateApprovalWiringDeps): ApprovalHandler => {
  return async (request) => {
    const payload = await deps.gate.request({
      kind: 'approval',
      payload: request,
      sessionId: deps.getSessionId(),
    })
    // 前端回包经 command('approval.decision') → gate.resolve(requestId, decision)。
    // 'approved' 之外的任何值（'rejected'/null/未知形态）都按拒绝处理——
    // fail-closed 纪律由 door 层兜底，这里不做宽松解释。
    return payload === 'approved' ? 'approved' : 'rejected'
  }
}
