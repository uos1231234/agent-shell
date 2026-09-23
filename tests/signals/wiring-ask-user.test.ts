// v0.21 Signal Gate — ask-user wiring 单元测试。
//
// 覆盖 createGateAskUserHandler 的行为：
//   1. 调用 gate.request('ask_user') 并透传 questions
//   2. 前端回包 { answers } → handler 透传
//   3. 前端回包 { answers, cancelled: true } → handler 透传
//   4. 前端回包 null → handler 返回 null（取消语义）

import { describe, it, expect, vi } from 'vitest'
import { createGateAskUserHandler } from '../../src/signals/wiring/ask-user.js'
import type { SignalGate } from '../../src/signals/types.js'
import type { RequestUserInputQuestion } from '../../src/im/tools/request-user-input.js'

const makeGate = (resolveWith: unknown) => {
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

const questions: RequestUserInputQuestion[] = [
  { question: 'Which file?', options: [{ label: 'A' }, { label: 'B' }] },
]

describe('createGateAskUserHandler', () => {
  it('returns answers from front end', async () => {
    const gate = makeGate({ answers: ['A'] })
    const handler = createGateAskUserHandler({ gate, getSessionId: () => 's1' })

    const result = await handler(questions)
    expect(result).toEqual({ answers: ['A'] })
    expect(gate.request).toHaveBeenCalledWith({
      kind: 'ask_user',
      payload: { questions },
      sessionId: 's1',
    })
  })

  it('returns cancelled flag when front end cancels', async () => {
    const gate = makeGate({ answers: [], cancelled: true })
    const handler = createGateAskUserHandler({ gate, getSessionId: () => 's1' })

    const result = await handler(questions)
    expect(result).toEqual({ answers: [], cancelled: true })
  })

  it('returns null when front end sends null (cancel semantic)', async () => {
    const gate = makeGate(null)
    const handler = createGateAskUserHandler({ gate, getSessionId: () => 's1' })

    const result = await handler(questions)
    expect(result).toBeNull()
  })
})
