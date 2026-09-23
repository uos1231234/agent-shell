// v0.21 Signal Gate — per-session 一键装配。
//
// wireSessionToGate 把"一个会话"需要的全部 Gate 接线一次完成，产物
// SessionGateWiring 直接塞进宿主装配面：
//   - onStreamChunk   → SessionLoopBase.onStreamChunk（v0.21 新字段）
//   - hooks           → SessionLoopBase.hooks（与宿主自有 hooks 合并）
//   - requestHandler  → SessionLoopBase.requestHandler（ask_user 路由）
//   - approvalHandler → bootstrapExtensions({ approvalHandler })
//   - dispose()       → 拆除本会话的全部订阅
//
// 全局接线（不 per-session）：wireLogSinkToGate（logger sink 是全局单槽）、
// gate 本身（createSignalGate，跨会话共享一个）。

import type { LoopHooks } from '../im/loop-hooks.js'
import type { ApprovalHandler } from '../im/tools/security/approval-store.js'
import type { RenderingSignalBus } from '../rendering/signal-bus.js'
import type { RenderingBase } from '../rendering/base.js'
import type { HookSystem } from '../im/hooks/hook-system.js'
import type { StateLine } from '../im/state-line/types.js'
import type { StreamChunk } from '../protocol/types.js'
import type { SignalGate } from './index.js'
import {
  createDeltaBridge,
  createGateLoopHooks,
  createGateApprovalHandler,
  createGateAskUserHandler,
  wireHookSystemToGate,
  wireRenderingToGate,
  wireStateLineToGate,
} from './wiring/index.js'

export type SessionGateWiringInput = {
  gate: SignalGate
  /** 本会话的 id（delta/tool/artifact/log 等信号的归属标注）。 */
  sessionId: string
  /** 可选：本会话的 HookSystem（生命周期事件桥接）。 */
  hookSystem?: HookSystem | undefined
  /** 可选：本会话的 StateLine（记忆分层活动桥接）。 */
  stateLine?: StateLine | undefined
  /** 可选：本会话的渲染三件套（bus → Gate → base 顺序接线）。 */
  rendering?: { bus: RenderingSignalBus; base: RenderingBase } | undefined
}

export type SessionGateWiring = {
  /** 塞进 SessionLoopBase.onStreamChunk（v0.21 新字段）。 */
  onStreamChunk: (turnId: string, chunk: StreamChunk) => void
  /**
   * 塞进 SessionLoopBase.hooks——注意这是 **合并语义**：宿主自有 hooks 与
   * gate 的 tool.result 片段都要生效。提供 mergeLoopHooks 帮助函数。
   */
  gateHooks: LoopHooks
  /** 塞进 SessionLoopBase.requestHandler（kind 未知时抛干净错误）。 */
  requestHandler: (kind: string, payload: unknown) => Promise<unknown>
  /** 塞进 bootstrapExtensions({ approvalHandler })。 */
  approvalHandler: ApprovalHandler
  /** 拆除本会话订阅（session close/delete 时调用）。 */
  dispose: () => void
}

/**
 * 责任链合并单个 hook：单侧定义 → 取该侧**原引用**（不包装，保持
 * `hooks.X === undefined` 的可判定性）；两侧都定义 → own 先跑，返回
 * undefined 才轮到 other（§6.13 记录的 fall-through 语义：第一个返回
 * 非 undefined 的赢，其余跳过）。
 */
const chainHook = <C, R>(
  own: ((ctx: C) => Promise<R | undefined>) | undefined,
  other: ((ctx: C) => Promise<R | undefined>) | undefined,
): ((ctx: C) => Promise<R | undefined>) | undefined => {
  if (own === undefined) return other
  if (other === undefined) return own
  return async (ctx) => (await own(ctx)) ?? (await other(ctx))
}

/**
 * 编译期守卫：mergeLoopHooks 的返回字面量必须覆盖 LoopHooks 的**全部**键。
 * 新增 hook 字段而未在合并里处理它 = 这里编译错误，而不是静默丢弃。
 *
 * 为什么需要它：本函数曾逐字段显式枚举，第二参数的同名字段除
 * afterToolExecution 外全被丢弃。三个既有消费者（toolTableHooks /
 * renderingHooks / gateHooks）恰好都只用 afterToolExecution，缺陷因此
 * 潜伏至今——任何落在别的字段上的第四个消费者都会被静默吞掉
 * （AGENTS.md §5「实现 ≠ 接线 ≠ 生效」的同一类）。
 */
const requireAllHookFields = (merged: Required<LoopHooks>): LoopHooks => merged

/**
 * 合并两组 LoopHooks，两边的同名字段都生效（own 先、other 后）。
 *
 * afterToolExecution 是唯一例外：两侧**都必须跑**（own 可 transform 结果，
 * other 需观察转发 tool.result），且 own 的 transformedResults 要进 other
 * 的 ctx。这是 v0.21 起的既有语义，不走 chainHook 的短路链。
 */
export const mergeLoopHooks = (own: LoopHooks | undefined, other: LoopHooks): LoopHooks => {
  if (own === undefined) return other
  return requireAllHookFields({
    beforeShellCall: chainHook(own.beforeShellCall, other.beforeShellCall),
    afterShellCall: chainHook(own.afterShellCall, other.afterShellCall),
    afterGuards: chainHook(own.afterGuards, other.afterGuards),
    beforeToolExecution: chainHook(own.beforeToolExecution, other.beforeToolExecution),
    beforeComplete: chainHook(own.beforeComplete, other.beforeComplete),
    afterToolExecution: async (ctx) => {
      const ownResult = own.afterToolExecution !== undefined ? await own.afterToolExecution(ctx) : undefined
      await other.afterToolExecution?.({
        ...ctx,
        toolResults: ownResult?.transformedResults ?? ctx.toolResults,
      })
      return ownResult
    },
  })
}

export const wireSessionToGate = (input: SessionGateWiringInput): SessionGateWiring => {
  const { gate } = input
  const getSessionId = (): string => input.sessionId
  const disposers: Array<() => void> = []

  // 1) 流式增量 → assistant.delta / tool.started。
  const bridge = createDeltaBridge({ gate, getSessionId })

  // 2) tool.result 片段（afterToolExecution 观察转发）。
  const gateHooks = createGateLoopHooks({ gate, getSessionId })

  // 3) HookSystem 生命周期 → session.event。
  if (input.hookSystem !== undefined) {
    disposers.push(wireHookSystemToGate({ gate, hookSystem: input.hookSystem, getSessionId }))
  }

  // 4) 渲染：bus → Gate → base.handleSignal（用户拍板的顺序）。
  if (input.rendering !== undefined) {
    disposers.push(wireRenderingToGate({ gate, bus: input.rendering.bus, base: input.rendering.base, getSessionId }))
  }

  // 5) StateLine → memory.activity。
  if (input.stateLine !== undefined) {
    disposers.push(wireStateLineToGate({ gate, stateLine: input.stateLine, getSessionId }))
  }

  // 6) approval / ask_user 的"问人"实现。
  const approvalHandler = createGateApprovalHandler({ gate, getSessionId })
  const askUserHandler = createGateAskUserHandler({ gate, getSessionId })

  const requestHandler = (kind: string, payload: unknown): Promise<unknown> => {
    if (kind === 'request_user_input') {
      const questions = (payload as { questions?: Parameters<typeof askUserHandler>[0] } | undefined)?.questions
      if (questions === undefined) {
        return Promise.reject(new Error(`request_user_input: payload missing "questions"`))
      }
      return askUserHandler(questions)
    }
    return Promise.reject(new Error(`Signal gate wiring: unknown requestHandler kind "${kind}"`))
  }

  return {
    onStreamChunk: bridge.onStreamChunk,
    gateHooks,
    requestHandler,
    approvalHandler,
    dispose: () => {
      for (const d of disposers) d()
      disposers.length = 0
    },
  }
}
