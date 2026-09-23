/**
 * Audit hook — v0.19 D8
 *
 * Records every tool call with duration, success/failure, and error.
 * PostToolUse event handler.
 *
 * ============================================================================
 * 【为可观测性保留】用户拍板 2026-09-10
 * ============================================================================
 *
 * 本 hook 生产零调用（装配层从不 `new HookSystem()`，见 hook-system.ts 的现状
 * 备注），但**决定保留**，理由是可观测性：
 *
 *   1. `getLogs()` 是当前**唯一记录「工具耗时（duration）」的面**——databus 的
 *      `ToolTurn`（src/im/databus.ts:7-21）记了 toolName / args / content /
 *      isError / at / sourceAgentId 且落盘，但**没有 duration 字段**。
 *   2. 它是 v0.19 hook 体系**唯一的 e2e 验证资产**：examples/e2e-v019-verify.ts:56-59
 *      构造 `HookSystem` + `register(auditHook)` 并用 `getLogs()` 做断言。
 *      （另见 e2e-v019-integration / -comprehensive / -prompt-memory）
 *   3. 将来若要接内部事件流，本 hook 正好是现成的 PostToolUse handler。
 *
 * 注意：`logs` 是**进程内内存数组、不落盘**——它不是持久化审计日志。若哪天真
 * 需要"可追溯的审计轨迹"，应先决定落盘方案，而不是直接接线了事。
 */

import type { HookHandler, HookContext } from './types.js'

export type AuditEntry = {
  timestamp: string
  toolName: string
  duration?: number | undefined
  success: boolean
  error?: string | undefined
  sessionId?: string | undefined
}

export function createAuditHook(): HookHandler & { getLogs(): AuditEntry[] } {
  const logs: AuditEntry[] = []

  return {
    event: 'PostToolUse',
    handler: async (ctx) => {
      logs.push({
        timestamp: new Date().toISOString(),
        toolName: ctx.toolName ?? 'unknown',
        duration: ctx.duration,
        success: !ctx.error,
        error: ctx.error?.message,
        sessionId: ctx.sessionId,
      })
    },
    getLogs: () => [...logs],
  }
}
