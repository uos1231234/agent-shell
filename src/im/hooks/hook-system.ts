/**
 * Hook System — v0.19 D8
 *
 * General-purpose event hooks for agent lifecycle.
 * - SessionStart/SessionEnd: session lifecycle
 * - PreToolUse: can block tool execution (return false)
 * - PostToolUse: observation point (audit, error recovery)
 *
 * Runs alongside existing SecurityHook / SystemSecurityHook.
 *
 * ============================================================================
 * 【现状备注】HookSystem 是信号关（Signal Gate）的低配版 —— 用户判定 2026-09-10
 * ============================================================================
 *
 * **定位**：HookSystem 是早期的事件广播机制，功能上是 Signal Gate 的子集。
 * 它能做的生命周期事件通知，Signal Gate 都能做；而 Signal Gate 还额外承担
 * 前后端双向中转（入站命令 GateCommand + 出站信号）。因此有了信号关之后，
 * HookSystem 的独立价值已经很小。
 *
 * **生产现状：从未接线。** `src/host/assembly.ts` 的 createHostAssembly 不构造
 * HookSystem，`buildLoopOptions` 也不传 `hookSystem` → `src/im/loop.ts:635/902/1097`
 * 的 `opts.hookSystem?.emit(...)` 恒不触发；`src/signals/wiring/hook-system.ts`
 * 把四个事件桥成 gate 的 `session.event` 也因此永不发生。
 *
 * **实际影响：无用户可见后果。** 原因是 `session.event` 的四个桥接事件名
 * （SessionStart / TurnEnd / SessionEnd / PostToolUse）在消费端
 * `cli/session-view.ts:239` 只被写进 `shard.events` 这张 map，而全仓只有
 * `shard.events['tools']` 一处被读取——且 `'tools'` / `'system.prompt'`
 * 这两个键是 `src/host/assembly.ts:727/730` 直接 emit 的，不经过本模块。
 * 即：四个生命周期事件即便发出来也无人读取。丢的是"内部事件流"这个能力，
 * 不是线上功能。
 *
 * **未来接线路径（若确实需要内部事件流）**：
 *   1. 在 `src/host/assembly.ts` 装配处 `const hookSystem = new HookSystem()`，
 *      并传入 `buildLoopOptions({ ..., hookSystem })`
 *   2. 把同一个 `hookSystem` 传给 `wireSessionToGate`——接线通道已现成预留：
 *      `src/signals/assemble.ts:37` 有可选字段 `hookSystem?: HookSystem`，
 *      `:92-93` 有 `if (input.hookSystem !== undefined)` 分支
 *   3. 注意：`wireHookSystemToGate` 返回的 dispose 是 no-op（本类的 register
 *      只进不出、无 unregister API），见 `src/signals/wiring/hook-system.ts:42-48`；
 *      HookSystem 与 gate 同生命周期（装配层一次装配、进程内共享）
 *   4. 若要接本目录下的三个 handler 工厂（`createAuditHook` /
 *      `createErrorRecoveryHook` / `createMcpSummaryInjection`），务必先确认它们
 *      是否已被现有机制覆盖，避免重复建设：
 *        - `createAuditHook`：记 工具名/耗时/成败/错误 到**内存数组**。databus 的
 *          `ToolTurn`（`src/im/databus.ts:7-21`）已记 工具名/参数/结果/isError/
 *          时间戳/来源 agent，**且落盘**（databus.jsonl）——两者只差一个"耗时"
 *        - `createErrorRecoveryHook`：连错≥3 提示换方案。loop 的 errorRate guard
 *          （`src/shell/guards.ts:30-31`，基于 `metrics.consecutiveToolErrors`）
 *          **能感知失败并终止**，但不给模型"换方案继续"的机会——属部分覆盖
 *        - `createMcpSummaryInjection`：包装 `buildServerSummary` 成
 *          ContextInjectionSource。而 `buildServerSummary` 已由
 *          `src/im/loop.ts:54` 直接消费（MCP/skill 清单确实已进上下文）——纯重复
 */

import type { HookEvent, HookHandler, HookContext } from './types.js'

export class HookSystem {
  private readonly handlers: HookHandler[] = []

  register(handler: HookHandler): void {
    this.handlers.push(handler)
  }

  async emit(event: Exclude<HookEvent, 'PreToolUse'>, ctx: HookContext): Promise<void> {
    for (const h of this.handlers) {
      if (h.event === event) {
        try {
          await h.handler(ctx)
        } catch (e) {
          // v0.20: handler 抛错不击穿循环，记录警告。
          // 与 loop-hooks.ts callHook 的容错策略一致。
          console.warn(`[hook-system] handler "${h.event}" threw, ignored: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
  }

  async emitPreToolUse(ctx: HookContext): Promise<boolean> {
    for (const h of this.handlers) {
      if (h.event === 'PreToolUse') {
        const result = await h.handler(ctx)
        if (result === false) return false
      }
    }
    return true
  }

  async clear(): Promise<void> {
    this.handlers.length = 0
  }
}
