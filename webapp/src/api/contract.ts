// 前端与后端的唯一类型接触点：全部 import type（编译期擦除，vite 产物零库
// 运行时代码）。类型唯一来源 = 库的 src/signals（经 tsconfig paths 映射）。
// 契约变了这里 tsc 直接报错——"契约唯一"的 TS 原生形态。
import type {
  GateSignal,
  GateRequest,
  GateCommand,
  AskQuestion,
} from '@agent-shell/signals'
import type { ConversationTurn } from '@agent-shell/signals'
import type { ContentPart } from '@agent-shell/signals'
import type { ArtifactHandle } from '@agent-shell/signals'
import type { ApprovalRequest } from '@agent-shell/signals'
import type { SessionInfo } from '@agent-shell/signals'
import type { LogLevel } from '@agent-shell/signals'
// v0.25 Wave B：设置面板（MCP / Skill / 子代理）的类型。
import type { McpServerConfig } from '@agent-shell/signals'
import type { McpListResult, McpWriteResult } from '@agent-shell/signals'
import type { SubAgentConfig } from '@agent-shell/signals'
import type { SubAgentListResult, ExtensionsInfo } from '@agent-shell/signals'
import type { DatabusSettings } from '@agent-shell/signals'
// v0.24：workspace.read 的回执（内嵌只读查看器 FileViewer）。
import type { WorkspaceReadResult } from '@agent-shell/signals'
// v0.28：session.event 'tools' 的 data 契约（工具自描述清单）。
import type { SessionToolsPayload } from '@agent-shell/signals'
// v0.33b：知识卡片（KnowledgePanel）。
import type {
  WikiCardInput,
  WikiCardSummary,
  WikiListResult,
  WikiRenderResult,
  WikiGenerateStatus,
} from '@agent-shell/signals'
// v0.32：模型目录 + 思考档位（ModelSwitcher / ProviderPanel）。
import type {
  ThinkingEffort,
  ModelReasoning,
  ProviderCatalog,
  ProviderCatalogEntry,
  ProviderListResult,
} from '@agent-shell/signals'
// v0.36.1：session.rewind 的回执（网页端「撤销更改」按钮的三组结果）。
import type { SessionRewindResult } from '@agent-shell/signals'
// v0.41：goal 模式（goal.changed 信号载荷 + goal.get 回执）。
import type { GoalEvent, GoalState } from '@agent-shell/signals'
import type { WorkflowRunEvent, WorkflowState, BaselineRunResult } from '@agent-shell/signals'
export type {
  GateSignal,
  GateRequest,
  GateCommand,
  AskQuestion,
  ConversationTurn,
  ContentPart,
  ArtifactHandle,
  ApprovalRequest,
  SessionInfo,
  LogLevel,
  McpServerConfig,
  McpListResult,
  McpWriteResult,
  SubAgentConfig,
  SubAgentListResult,
  ExtensionsInfo,
  DatabusSettings,
  WorkspaceReadResult,
  SessionToolsPayload,
  ThinkingEffort,
  ModelReasoning,
  ProviderCatalog,
  ProviderCatalogEntry,
  ProviderListResult,
  WikiCardInput,
  WikiCardSummary,
  WikiListResult,
  WikiRenderResult,
  WikiGenerateStatus,
  SessionRewindResult,
  GoalEvent,
  GoalState,
  WorkflowRunEvent,
  WorkflowState,
  BaselineRunResult,
}
