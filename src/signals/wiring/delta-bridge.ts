// v0.21 Signal Gate — delta-bridge（流式增量 → Gate 信号）。
//
// 把 shellCall 的 onStreamChunk 观察者流转成 Gate 出站信号：
//   - content_delta  → assistant.delta（token 级文本，打字机数据源）
//   - tool_call_delta → 首个 delta（新 index 出现）发 tool.started；
//     后续同 index 的 arguments 增量不逐帧转发（tool.result 由
//     afterToolExecution 接线器带完整 ToolTurn 发出，这里不重复）。
//   - finish / usage / done 不产信号（turn 收尾由 turn.end 覆盖）。
//
// 纯观察者：不持有 loop 状态，不改变 shell 聚合语义。turnId 由 loop 侧
// 注入（loop 每轮 mint 的唯一 id）；turn 切换（turnId 变化）时重置 tool index 表。

import type { StreamChunk } from '../../protocol/types.js'
import type { SignalGate } from '../index.js'

export type DeltaBridgeDeps = {
  gate: SignalGate
  /** 信号归属的 session（bridge 由会话级 wiring 创建，一桥一会话）。 */
  getSessionId: () => string
}

export type DeltaBridge = {
  /** 直接可作为 IMLoopOptions.onStreamChunk 的回调。 */
  onStreamChunk: (turnId: string, chunk: StreamChunk) => void
}

export const createDeltaBridge = (deps: DeltaBridgeDeps): DeltaBridge => {
  const { gate } = deps
  let currentTurnId: string | null = null
  /** 已发过 tool.started 的 tool_call index 集合（per-turn）。 */
  const startedIndexes = new Set<number>()

  const onStreamChunk = (turnId: string, chunk: StreamChunk): void => {
    // turn 切换 → 重置 per-turn 状态。
    if (turnId !== currentTurnId) {
      currentTurnId = turnId
      startedIndexes.clear()
    }
    const sessionId = deps.getSessionId()

    switch (chunk.type) {
      case 'content_delta':
        gate.emit({ kind: 'assistant.delta', sessionId, turnId, text: chunk.text })
        return
      case 'reasoning_delta':
        // 推理模型（GLM/R1 系）的思考流 → thinking.delta 信号（UI 思考折叠块）。
        gate.emit({ kind: 'thinking.delta', sessionId, turnId, text: chunk.text })
        return
      case 'tool_call_delta': {
        if (startedIndexes.has(chunk.index)) return
        startedIndexes.add(chunk.index)
        gate.emit({
          kind: 'tool.started',
          sessionId,
          turnId,
          toolName: chunk.name ?? '',
          callId: chunk.id ?? `idx-${chunk.index}`,
          args: null, // 流式阶段参数尚未完整；完整 args 随 tool.result 的 ToolTurn 到达
        })
        return
      }
      case 'finish':
      case 'usage':
      case 'done':
        return
    }
  }

  return { onStreamChunk }
}
