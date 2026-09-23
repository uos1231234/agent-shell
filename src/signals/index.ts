// v0.21 Signal Gate — public barrel。
//
// 宿主前端桥只应 import 本文件：
//   import { createSignalGate } from '../../src/signals/index.js'
//   import type { GateSignal, GateCommand } from '../../src/signals/index.js'

export { createSignalGate, type SignalGateOptions } from './gate.js'

export type {
  AskQuestion,
  GateSignal,
  GateRequest,
  GateRequestInput,
  GateCommand,
  GateSubscriptionKind,
  GateSubscriber,
  GateSnapshot,
  SignalGate,
  SignalGateHandlers,
} from './types.js'

// v0.22: 契约面补全——GateSignal/GateCommand 引用的真实源类型一并 re-export，
// 前端（webapp）经这一个 barrel 拿到完整契约（import type，零运行时）。
// v0.22: 契约面补全——GateSignal/GateCommand 引用的真实源类型一并 re-export，
// 前端（webapp）经这一个 barrel 拿到完整契约（import type，零运行时）。
export type { ConversationTurn } from '../im/conversation-memory.js'
export type { ContentPart } from '../protocol/types.js'
export type { ArtifactHandle } from '../rendering/base.js'
export type { ApprovalRequest } from '../im/tools/security/approval-store.js'
export type { SessionInfo } from '../im/session/types.js'
export type { LogLevel } from '../shared/logger.js'
export type { WorkspaceReadResult } from './types.js'
// v0.28: session.event 'tools' 的 data 契约（工具清单自描述到前端）。
export type { ToolInventoryEntry, SessionToolsPayload } from './types.js'
// v0.29 Wave B2: session.compact / session.undo 的回执契约（CLI 状态行的数据源）。
export type { SessionCompactResult, SessionUndoResult } from './types.js'
// v0.36: session.rewind 的回执契约（网页端「撤销更改」按钮的分组展示）。
export type { SessionRewindResult } from './types.js'

// v0.25 Wave B: mcp/subagent/settings/extensions 命令引用的真实源类型一并
// re-export（前端设置面板经这一个 barrel 拿到完整契约，import type 零运行时）。
export type { McpServerConfig } from '../mcp/config.js'
export type { McpListResult, McpWriteResult } from '../mcp/write.js'
export type { SubAgentConfig } from '../im/sub-agent/config.js'
export type { DatabusSettings } from '../config/databus-settings.js'
// v0.32: provider catalog 契约面（ModelSwitcher / ProviderPanel / CLI /model）。
export type {
  ThinkingEffort,
  ModelReasoning,
  ProviderConfig,
  ProviderModel,
  ProviderCatalog,
  ProviderCatalogEntry,
  ProviderListResult,
  WriteResult,
} from '../config/types.js'
export type { SubAgentListResult, ExtensionsInfo } from './types.js'
export type {
  WikiCardInput,
  WikiCardSummary,
  WikiListResult,
  WikiRenderResult,
  WikiGenerateStatus,
} from './types.js'
// v0.41 goal 模式契约面（goal.changed 的载荷 + goal.get 的回执）。前端与 CLI
// 经这一个接触面拿类型——webapp 的 contract.ts 是纯 `import type ... from
// '@agent-shell/signals'`，所以类型自动到位，缺的只是运行时消费（见 v0.41
// 计划 §9 前端待同步清单）。
export type {
  GoalJudgement,
  GoalVerdict,
  GoalVerdictResult,
  GoalState,
  GoalEvent,
} from '../im/goal/types.js'
export type { WorkflowRunEvent, WorkflowState } from '../host/workflow/types.js'
export type { BaselineRunResult } from '../host/workflow/scout.js'

// v0.21: per-session 装配 + 接线器（宿主通过这些把会话接到 Gate）。
export {
  wireSessionToGate,
  mergeLoopHooks,
  type SessionGateWiring,
  type SessionGateWiringInput,
} from './assemble.js'
export {
  createDeltaBridge,
  createGateLoopHooks,
  wrapRunPromptWithTurnEnd,
  wireHookSystemToGate,
  wireRenderingToGate,
  wireStateLineToGate,
  wireLogSinkToGate,
  createGateApprovalHandler,
  createGateAskUserHandler,
} from './wiring/index.js'
