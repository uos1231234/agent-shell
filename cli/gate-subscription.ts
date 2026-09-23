// v0.26 Wave 2 — gate 订阅薄胶水（cli）。
//
// 只做一件事：gate.on('*') → view.apply。过滤/分片/渲染全部在 reducer
// （session-view.ts）里；订阅生命周期归 app（Wave 5）——这里返回
// unsubscribe，不持有任何全局状态。

import type { GateSignal, GateRequest, SignalGate } from '../src/signals/types.js'

/** 消费端最小接口——SessionView 的 applySignal 满足它（结构化类型）。 */
export type SignalSink = {
  apply: (sig: GateSignal | GateRequest) => void
}

/**
 * 订阅 gate 全部出站信号与请求（'*' 通配），原样转发给 sink。
 * 返回 unsubscribe（app 持有，会话关闭/退出时调用）。
 */
export const subscribeToGate = (gate: SignalGate, sink: SignalSink): (() => void) =>
  gate.on('*', (sig) => sink.apply(sig))
