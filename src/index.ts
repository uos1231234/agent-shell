// agent-shell public API surface (v0.14 §5.4).
//
// This file is pure sugar: it re-exports the symbols external callers
// (宿主应用, custom frontends) are most likely to need. Internal modules
// continue to import from their existing paths (`./im/loop.js`, etc.) —
// nothing is moved or renamed here. Adding a re-export is backward
// compatible; removing or renaming one is not (plan §1 constraint 4,
// §4 principle 5).
//
// A built dist bundle is a v0.15 follow-up. For now `main`/`exports` in
// package.json point at this `.ts` source, which tsx/vitest/Node 22
// resolve directly thanks to `"type": "module"`.

// ---- IM loop ----
export { runIMLoop } from './im/loop.js'
export type { IMLoopOptions, IMLoopResult } from './im/loop.js'

// ---- minimal IM factory ----
export { createMinimalIM, DEFAULT_WORKING_AGENT_TOOL_REFS } from './im/minimal.js'

// ---- builtin tools ----
export { createBuiltinTools } from './im/tools/index.js'

// ---- sub-agent registry ----
export { createSubAgentRegistry, SubAgentRegistry } from './im/minimal.js'

// ---- extension bootstrap (MCP + skills) ----
export { bootstrapExtensions } from './extensions.js'
export type { ExtensionBootstrapOptions, ExtensionBootstrapResult } from './extensions.js'

// ---- shell config ----
export { createConfig, DEFAULT_CONFIG } from './shell/config.js'
export type { ShellConfig } from './shell/config.js'

// ---- provider config service (providers.json, ~/.agent-shell) ----
export { loadProviderConfig, resolveShellHome, resolveConfigPath, ensureShellHome, CONFIG_FILE } from './config/index.js'
export type { ProviderConfig, AgentShellConfig, LoadedProviderConfig } from './config/index.js'

// ---- tool registry (v0.15 system-tool security hook surface) ----
export { ToolRegistry } from './shell/registry.js'
export type { SecurityHook } from './shell/registry.js'

// ---- memory config (v0.14 P2-1) ----
export { DEFAULT_MEMORY_CONFIG } from './shell/memory-config.js'
export type { MemoryConfig } from './shell/memory-config.js'

// ---- logger (v0.14 P3-1 observability surface) ----
export {
  defaultLogger,
  createSilentLogger,
  setLevel,
  setSink,
  getLevel,
} from './shared/logger.js'
export type { Logger, LogLevel, LogFields, LogRecord } from './shared/logger.js'

// ---- session layer (v0.17 multi-session windows + history recovery) ----
export { createSessionManager, SessionStore, SessionBusRegistry, recoverSession } from './im/session/index.js'
export type {
  SessionManager,
  SessionHandle,
  SessionInfo,
  SessionBuses,
  SessionRuntime,
  SessionLoopBase,
  SessionManagerOptions,
  SessionId,
  SessionBusFilter,
  RecoveryOptions,
  RecoveryResult,
  CompressionDeps,
} from './im/session/index.js'

// ---- rendering base (v0.20 silent rendering infrastructure) ----
export { createRenderingBase, createRenderingSignalBus } from './rendering/index.js'
export type { RenderingBase, ArtifactHandle } from './rendering/base.js'
export type { RenderingSignalBus, ArtifactSignal, RenderRule } from './rendering/signal-bus.js'

// ---- signal gate (v0.21 front/back signal boundary) ----
export { createSignalGate } from './signals/index.js'
export {
  wireSessionToGate,
  mergeLoopHooks,
  wireLogSinkToGate,
} from './signals/index.js'
export type {
  SignalGate,
  SignalGateOptions,
  SignalGateHandlers,
  GateSignal,
  GateRequest,
  GateRequestInput,
  GateCommand,
  GateSubscriptionKind,
  GateSnapshot,
  SessionGateWiring,
  SessionGateWiringInput,
} from './signals/index.js'
