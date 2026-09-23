// v0.21 Signal Gate — approval wiring 单元测试。
//
// 覆盖 createGateApprovalHandler 的行为：
//   1. 调用 gate.request('approval') 并透传 sessionId
//   2. 前端回包 'approved' → handler 返回 'approved'
//   3. 前端回包 'rejected' → handler 返回 'rejected'
//   4. 前端回包非标准值（如 null）→ fail-closed 返回 'rejected'

import { describe, it, expect, vi } from 'vitest'
import { createGateApprovalHandler } from '../../src/signals/wiring/approval.js'
import type { SignalGate } from '../../src/signals/types.js'

const makeGate = (resolveWith: unknown = 'approved') => {
  const gate: SignalGate = {
    emit: vi.fn(),
    on: vi.fn(() => () => {}),
    request: vi.fn(async () => resolveWith),
    resolve: vi.fn(),
    command: vi.fn(),
    snapshot: vi.fn(() => ({ sessions: [], pendingRequests: 0, subscribers: 0, emitted: 0 })),
  }
  return gate
}

const approvalRequest = { toolName: 'bash', args: { command: 'ls' }, reason: 'test' }

describe('createGateApprovalHandler', () => {
  it('returns approved when front end approves', async () => {
    const gate = makeGate('approved')
    const handler = createGateApprovalHandler({ gate, getSessionId: () => 's1' })

    const result = await handler(approvalRequest)
    expect(result).toBe('approved')
    expect(gate.request).toHaveBeenCalledWith({
      kind: 'approval',
      payload: approvalRequest,
      sessionId: 's1',
    })
  })

  it('returns rejected when front end rejects', async () => {
    const gate = makeGate('rejected')
    const handler = createGateApprovalHandler({ gate, getSessionId: () => 's1' })

    const result = await handler(approvalRequest)
    expect(result).toBe('rejected')
  })

  it('returns rejected for non-standard values (fail-closed)', async () => {
    const gate = { ...makeGate(), request: vi.fn(async () => null) }
    const handler = createGateApprovalHandler({ gate, getSessionId: () => 's1' })

    const result = await handler(approvalRequest)
    expect(result).toBe('rejected')
  })

  it('returns rejected for undefined payload (fail-closed)', async () => {
    const gate = { ...makeGate(), request: vi.fn(async () => undefined) }
    const handler = createGateApprovalHandler({ gate, getSessionId: () => 's1' })

    const result = await handler(approvalRequest)
    expect(result).toBe('rejected')
  })
})
