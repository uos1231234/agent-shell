// Public entrypoint for the MCP subsystem.
//
// Re-exports the narrow, SDK-free surface of src/mcp/:
//   - config:    McpServerConfig, validateMcpServerConfig, loadMcpConfigFile, defaultMcpConfigPath
//   - connection: McpConnection (type only — no SDK types leak), connectToServer
//   - boot:      registerMcpConnection, bootMcpServers, McpBootResult
//
// Constraint 1 (v0.13): no SDK type is re-exported here. Callers outside
// src/mcp/ depend only on these names; the SDK stays a replaceable battery
// behind connection.ts.

export type {
  McpServerConfig,
  McpInstructionsMode,
} from './config.js'
export {
  validateMcpServerConfig,
  loadMcpConfigFile,
  defaultMcpConfigPath,
  DEFAULT_MCP_INSTRUCTIONS_MODE,
} from './config.js'

export type { McpConnection } from './connection.js'
export { connectToServer } from './connection.js'

export type { McpBootResult } from './boot.js'
export { registerMcpConnection, bootMcpServers } from './boot.js'

// v0.25: mcp.json 写路径（设置面板经 Gate mcp.* 命令调用）。
export type { McpListResult, McpWriteResult } from './write.js'
export { listMcpServers, upsertMcpServer, deleteMcpServer } from './write.js'
