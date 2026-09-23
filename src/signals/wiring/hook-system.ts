// v0.21 Signal Gate — hook-system 接线器。
//
// 把 HookSystem 的生命周期事件（SessionStart / TurnEnd / SessionEnd /
// PostToolUse）桥成 Gate 出站信号 session.event。PreToolUse 不在此桥接
// （它有"返回 false 阻断"的双向语义，归未来的 pre_tool_use 请求-应答，
// v0.21 不做）。
//
// HookContext.sessionId 可能缺省（loop 组装时带不带取决于 caller）——
// 缺省时回退 wiring 层的 getSessionId()。

import type { HookSystem } from '../../im/hooks/hook-system.js'
import type { HookHandler, HookContext, HookEvent } from '../../im/hooks/types.js'
import type { SignalGate } from '../index.js'

export type GateHookSystemWiringDeps = {
  gate: SignalGate
  hookSystem: HookSystem
  getSessionId: () => string
}

/** 桥接的 Hook 事件（PreToolUse 双向语义不在 v0.21 范围）。 */
const BRIDGED_EVENTS: readonly HookEvent[] = ['SessionStart', 'TurnEnd', 'SessionEnd', 'PostToolUse']

export const wireHookSystemToGate = (deps: GateHookSystemWiringDeps): (() => void) => {
  const handlers: HookHandler[] = BRIDGED_EVENTS.map((event) => ({
    event,
    handler: async (ctx: HookContext): Promise<void> => {
      deps.gate.emit({
        kind: 'session.event',
        sessionId: ctx.sessionId ?? deps.getSessionId(),
        event,
        data: {
          agentId: ctx.agentId,
          toolName: ctx.toolName,
          duration: ctx.duration,
          error: ctx.error?.message,
        },
      })
    },
  }))
  for (const h of handlers) deps.hookSystem.register(h)
  // HookSystem 无 unregister API（register 只进不出，clear 是全清）——
  // 返回的 dispose 用 clear() 兜底，但会清掉其他注册者。诚实做法：返回
  // no-op 并在注释里说明生命周期约束（HookSystem 与 gate 同生命周期装配）。
  return () => {
    // no-op：HookSystem 的 register 无对应 unregister；接线器与 hookSystem
    // 同生命周期（装配层一次装配、进程内共享），不需要单独拆除。
  }
}
