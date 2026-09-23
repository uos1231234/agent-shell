// v0.21 Signal Gate — wiring barrel。
//
// 8 个接线器（每个一个小文件，单一职责）：
//   delta-bridge   流式增量 → assistant.delta / tool.started
//   loop-hooks     afterToolExecution → tool.result + wrapRunPromptWithTurnEnd
//   hook-system    HookSystem 生命周期 → session.event
//   rendering      bus → Gate → base.handleSignal（用户拍板的顺序）
//   state-line     StateLine.subscribe → memory.activity
//   log-sink       logger.setSink → log（全局，单槽接管）
//   approval       approvalHandler → gate.request('approval')
//   ask-user       requestHandler('request_user_input') → gate.request('ask_user')
//
// per-session 一键装配见 assemble.ts（wireSessionToGate）。

export { createDeltaBridge, type DeltaBridge, type DeltaBridgeDeps } from './delta-bridge.js'
export {
  createGateLoopHooks,
  wrapRunPromptWithTurnEnd,
  type GateLoopHooksWiringDeps,
} from './loop-hooks.js'
export { wireHookSystemToGate, type GateHookSystemWiringDeps } from './hook-system.js'
export { wireRenderingToGate, type GateRenderingWiringDeps } from './rendering.js'
export { wireStateLineToGate, type GateStateLineWiringDeps } from './state-line.js'
export { wireLogSinkToGate, type GateLogSinkWiringDeps } from './log-sink.js'
export { createGateApprovalHandler, type GateApprovalWiringDeps } from './approval.js'
export { createGateAskUserHandler, type GateAskUserHandler, type GateAskUserWiringDeps } from './ask-user.js'
