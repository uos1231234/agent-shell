// v0.21 Signal Gate — ask-user 接线器。
//
// 把 ctx.requestHandler('request_user_input', { questions }) 的反向 RPC 实现
// 接到 Gate：工具侧调 requestHandler → 这里 → gate.request({kind:'ask_user'})
// → 前端弹出提问浮层 → command('ask_user.answer') 回包 → gate.resolve() 落地
// → 返回给工具的 { answers, cancelled? } 形状由 gate.command 侧组装好了
// （见 gate.ts 的 ask_user.answer 分支），这里只透传。
//
// 返回值形状必须满足 request-user-input.ts 的消费契约：
//   { answers: (string|string[])[], cancelled?: boolean }（或 null → 视为取消）。

import type { SignalGate } from '../index.js'
import type { RequestUserInputQuestion } from '../../im/tools/request-user-input.js'

export type GateAskUserWiringDeps = {
  gate: SignalGate
  getSessionId: () => string
}

export type GateAskUserHandler = (
  questions: RequestUserInputQuestion[],
) => Promise<{ answers: (string | string[])[]; cancelled?: boolean } | null>

export const createGateAskUserHandler = (deps: GateAskUserWiringDeps): GateAskUserHandler => {
  return async (questions) => {
    const payload = await deps.gate.request({
      kind: 'ask_user',
      payload: { questions },
      sessionId: deps.getSessionId(),
    })
    // gate.command('ask_user.answer') 已组装成 { answers, cancelled? }；
    // null/undefined → 视为取消（request-user-input.ts 的取消语义）。
    if (payload == null) return null
    return payload as { answers: (string | string[])[]; cancelled?: boolean }
  }
}
