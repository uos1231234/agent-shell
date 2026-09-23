// ADR-002: guards are not hot-pluggable. They are built-in. Configuration only.
// ADR-014: every guard threshold below must be reachable - each field is read
// by a guard in guards.ts and each guard's metric has a producer. There are
// no "reserved" config fields.

export type ShellConfig = {
  maxTokens: number                  // tokenGuard: trip if metrics.lastRequestTokens > maxTokens
                                     // (this round's request size, NOT cumulative spend)
  maxSteps: number                   // iterGuard: trip if metrics.stepCount > maxSteps
  maxToolCalls: number               // toolRateGuard: trip if metrics.toolCallCount > maxToolCalls (default 1000)
  maxElapsedMs: number               // timeGuard: trip if metrics.elapsedMs > maxElapsedMs
  // errorRateGuard: trip if metrics.consecutiveToolErrors > maxConsecutiveToolErrors.
  // Counting semantics decide the real behavior — read these before touching
  // the threshold:
  //   - Unit is one TURN (assistant round), not one tool call: a batch where
  //     several tools fail increments the counter once (im/loop.ts calls
  //     addToolError at most once per round).
  //   - Any round where every tool call succeeds resets the counter to 0.
  //   - The comparison is strict >, so the default of 10 trips on the 11th
  //     consecutive error turn.
  //   - Known limit: alternating success/failure never trips (success resets).
  //     If that becomes a real problem, the fix is a window/rate metric, not a
  //     smaller threshold.
  maxConsecutiveToolErrors: number
  // v0.14: maximum nesting depth for run_subagent calls (was the module
  // constant MAX_SUB_AGENT_DEPTH = 3 in run-subagent.ts). Depth 0 = working
  // agent; a sub-agent launched by it runs at depth 1; etc. At depth >=
  // maxSubAgentDepth, run_subagent refuses to launch. Sub-agents may override
  // this to a *lower* value via SubAgentConfig.config (validated by
  // validateShellConfigOverrides — must be a positive int ≤ DEFAULT_CONFIG).
  maxSubAgentDepth: number
}

export const DEFAULT_CONFIG: ShellConfig = {
  maxTokens: 1_000_000,
  maxSteps: 15_000,                    // 【测试临时改动 2026-09-12】500 → 15000，让 deep-swe benchmark 长任务不被步数 guard 掐断，观察 B 层 LLM 压缩器是否触发。测试结束后改回 500。
                                       // 历史：v0.29 200→500（用户拍板）；本次再放到 15000 仅为 benchmark。
  maxToolCalls: 1000,                  // v0.29: 500 → 1000（用户拍板 2026-09-12）——toolRate guard 上限放宽。
  // v0.29: per-run 时间上限取消（Infinity）——长任务跑一两个小时是正常形态。
  // 时间约束不设在状态机：工具执行无时限（bash/powershell 命令可自带 timeout，
  // cap 900s），终止权交还用户——关闭状态机 / turn.cancel → ctx.signal →
  // shell 子进程 kill。iter/toolRate/errorRate guard 仍防无限循环与连续错误。
  // 宿主不得覆盖 guard 阈值——状态机行为全局一致，不因前端形态不同而不同。
  maxElapsedMs: Number.POSITIVE_INFINITY,
  maxConsecutiveToolErrors: 10,        // trips on the 11th consecutive error turn (strict >).
                                       // Tuned in the 2026-08-26 session (ADR-013);
                                       // no strict derivation behind the number.
  maxSubAgentDepth: 3,                 // v0.14: was MAX_SUB_AGENT_DEPTH in run-subagent.ts.
                                       // Default unchanged. Sub-agents can lower it,
                                       // never raise it (validateShellConfigOverrides).
}

export const createConfig = (overrides: Partial<ShellConfig> = {}): ShellConfig => ({
  ...DEFAULT_CONFIG,
  ...overrides,
})
