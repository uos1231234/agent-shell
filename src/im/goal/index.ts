// v0.41 goal 模式 — barrel。
//
// 分层：goal 语义全住在本目录，loop.ts 只认识 beforeComplete hook 的
// `continueWith` 布尔结果（计划 §5.1 命名理由：hook 是泛化接缝，goal 是特性）。
//
// 装配路径：assembly.attachHandle 建 GoalSessionState + createGoalHooks →
// SessionAssets.goalHooks → runPromptOnce 的 4 路 mergeLoopHooks 链末端。

export type {
  GoalJudgement,
  GoalVerdict,
  GoalVerdictResult,
  GoalState,
  GoalSessionState,
  GoalConfig,
  GoalEvent,
} from './types.js'

export {
  createGoalSessionState,
  resolveGoalConfig,
  DEFAULT_GOAL_CONFIG,
  DEFAULT_GOAL_MAX_ROUNDS,
  DEFAULT_GOAL_BLOCK_MIN_TOKENS,
  DEFAULT_GOAL_INPUT_KEEP_TOKENS,
  DEFAULT_GOAL_DISTILL_MIN_TOKENS,
  DEFAULT_GOAL_DISTILL_MIN_BLOCKS,
  GOAL_TURN_ID_PREFIX,
} from './types.js'

export { buildGoalReminder } from './reminder.js'

export type {
  GoalJudge,
  GoalJudgeInput,
  GoalJudgeDeps,
  GoalJudgeStreamChat,
} from './judge.js'

// parseGoalVerdict / buildJudgeRequest 导出为纯函数供单测直接断言。
export { createGoalJudge, parseGoalVerdict, buildJudgeRequest } from './judge.js'

export type { MergeGoalBlockInput, GoalBlockTrigger } from './block-merge.js'

// G1：确定性本地合并（无 LLM、无字数上限）。estimateBlockTokens 是从
// drive-coordinator 转发的统一块尺寸口径。
export {
  mergeGoalBlock,
  shouldMergeGoalBlock,
  estimateBlockTokens,
  finalConclusionOf,
  causalStepsOf,
  evidenceFragmentsOf,
} from './block-merge.js'

export type { GoalHooksDeps } from './hooks.js'

export { createGoalHooks } from './hooks.js'

export type { DistillRun, Distiller, DistillerDeps } from './distill.js'

// G2：连续信封区间的定位与 LLM 保守合并。findDistillRun / extractEnvelopeStamp /
// buildDistillRequest 是纯函数，导出供单测直接断言。
export { findDistillRun, extractEnvelopeStamp, buildDistillRequest, createDistiller } from './distill.js'
