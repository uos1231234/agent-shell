// v0.26 宿主装配层 — public barrel。
//
// 职责：把 examples/web-host.ts 内联的"最后一公里"装配（session-manager →
// per-session registry/doors/rendering → SignalGate handlers）收进库层，宿主
// 入口只留 web 传输（webshell server / token / 静态托管）与 CLI 参数解析。
//
// 依赖纪律（架构规则）：
//   - 只依赖 src/**（im / security / config / mcp / skills / signals /
//     rendering / protocol / shared / extensions / shell），**不 import
//     src/webshell**（web 传输层留在宿主入口），也不 import examples/。
//   - Signal Gate 是唯一中转站：本层只经 gate.emit / gate handlers 与外界
//     通信，不开端口、不开第二条数据面。

export { createMockStreamChat } from './mock.js'
export { createRealLLMStreamChat, type RealLLMConfig } from './llm-adapter.js'
export { readWorkspaceEntry } from './workspace-read.js'
export { undoTaskBlocks, UNDO_MAX_BLOCKS, type UndoTaskBlocksDeps } from './session-undo.js'
export { rewindSessionFiles, REWIND_MAX_ENTRIES, type SessionRewindDeps } from './session-rewind.js'
export { buildToolsPayload } from './tools-payload.js'
export {
  createHostAssembly,
  resolveLLMPlan,
  type HostAssemblyOptions,
  type HostAssembly,
  type SessionAssets,
  type LLMPlan,
} from './assembly.js'
