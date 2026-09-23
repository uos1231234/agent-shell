// v0.21 Signal Gate — loop-hooks 接线器 + turn.end 包装。
//
// 两件事：
//   1. toolLoopHooks()：产出 LoopHooks 片段，把 afterToolExecution 的完整
//      ToolTurn 转成 Gate tool.result 信号（tool.started 由 delta-bridge 在
//      流式侧发过，这里补全结果）。afterShellCall 不产信号——它是"每轮
//      shell 调用"的边界，多轮 loop 中会触发多次，语义不是"回合结束"。
//   2. wrapRunPromptWithTurnEnd()：包装 handlers.runPrompt——runIMLoop
//      返回后发 turn.end（IMLoopResult 是 runIMLoop 的返回值，只有调用方
//      拿得到，loop 内部没有"整个回合结束"的 hook 点）。这是 turn.end
//      信号的唯一发射点。

import type { ToolTurn } from '../../im/databus.js'
import type { LoopHooks } from '../../im/loop-hooks.js'
import type { IMLoopResult } from '../../im/loop.js'
import type { SignalGate } from '../index.js'

export type GateLoopHooksWiringDeps = {
  gate: SignalGate
  getSessionId: () => string
}

/** 产出接进 IMLoopOptions.hooks 的 LoopHooks 片段（只占 afterToolExecution）。 */
export const createGateLoopHooks = (deps: GateLoopHooksWiringDeps): LoopHooks => ({
  // v0.21: 工具结果 → Gate tool.result。转发原始 ToolTurn，不改变
  // transformedResults（返回 undefined = 不干预，hook 契约的默认行为）。
  // turnId 用 ctx.turnId（loop 每轮 mint 的唯一 id）——与 delta-bridge 的
  // tool.started 同源，前端才能把 started/result 关联到同一轮。
  afterToolExecution: async (ctx) => {
    const sessionId = deps.getSessionId()
    for (const turn of ctx.toolResults) {
      deps.gate.emit({
        kind: 'tool.result',
        sessionId,
        turnId: ctx.turnId,
        toolName: turn.toolName ?? '',
        callId: turn.toolCallId,
        result: turn,
      })
    }
    return undefined
  },
})

/** 包装 runPrompt：runIMLoop 返回后发 turn.end（带完整 IMLoopResult）。 */
export const wrapRunPromptWithTurnEnd = (
  deps: GateLoopHooksWiringDeps,
  runPrompt: (sessionId: string, text: string) => Promise<IMLoopResult>,
): ((sessionId: string, text: string) => Promise<IMLoopResult>) => {
  return async (sessionId: string, text: string): Promise<IMLoopResult> => {
    const result = await runPrompt(sessionId, text)
    deps.gate.emit({ kind: 'turn.end', sessionId, result })
    return result
  }
}
