/**
 * mcp.json 写路径 — list / upsert / delete（~/.databus/mcp.json，形如
 * { servers: [...] }）。
 *
 * 家目录归属（用户拍板 2026-09-07，"功能配置与凭据分离"）：功能配置在
 * ~/.databus/，凭据在 ~/.agent-shell/——本模块不读 AGENT_SHELL_HOME。
 *
 * 语义（与 src/config/write.ts 的 providers.json 写路径同模式）：
 *   - 写入前必须校验：server（unknown）原样透传 validateMcpServerConfig，
 *     坏数据在任何 IO 之前被拒绝。
 *   - upsert：同名覆盖（保持原位置），新名追加尾部。
 *   - delete：条目不存在 → throw 干净英文错误。
 *   - 原子写（tmp + rename）+ 写前 .bak 备份（保留最近一版）。
 *   - list：文件缺失 → { exists: false, servers: [] }（配置可选，缺失是常态）；
 *     文件存在 → 逐条校验 + 重名拒绝（复用 loadMcpConfigFile）。
 *
 * 注：写入后需重启 web-host 对新会话生效（MCP 连接是启动期行为，ADR-018 D6）。
 */

import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadMcpConfigFile, validateMcpServerConfig, type McpServerConfig } from './config.js'

export type McpListResult = { exists: boolean; configPath: string; servers: McpServerConfig[] }
export type McpWriteResult = { configPath: string }

type McpWriteInput = { configPath?: string | undefined; homeDir?: string | undefined }

const resolveMcpPath = (input?: McpWriteInput): string =>
  input?.configPath ?? join(input?.homeDir ?? homedir(), '.databus', 'mcp.json')

/** 读现有文件并逐条校验（含重名拒绝）；文件缺失 → undefined。 */
const readServers = (configPath: string): McpServerConfig[] | undefined => {
  if (!existsSync(configPath)) return undefined
  return loadMcpConfigFile(configPath)
}

/** 原子写（tmp + rename）+ 写前 .bak 备份。 */
const writeServersFile = (configPath: string, servers: readonly McpServerConfig[]): void => {
  const tmpPath = `${configPath}.tmp`
  const bakPath = `${configPath}.bak`
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 })
  if (existsSync(configPath)) copyFileSync(configPath, bakPath)
  writeFileSync(tmpPath, JSON.stringify({ servers }, null, 2) + '\n', 'utf8')
  renameSync(tmpPath, configPath)
}

/** mcp.json 全量快照（设置面板列表用）。文件缺失 → exists:false。 */
export function listMcpServers(input?: McpWriteInput): McpListResult {
  const configPath = resolveMcpPath(input)
  const servers = readServers(configPath)
  return servers === undefined
    ? { exists: false, configPath, servers: [] }
    : { exists: true, configPath, servers }
}

/** 新增或覆盖一个 MCP server 配置。校验先行；同名保持原位置，新名追加尾部。 */
export function upsertMcpServer(input: { server: unknown } & McpWriteInput): McpWriteResult {
  const entry = validateMcpServerConfig(input.server)
  const configPath = resolveMcpPath(input)
  const servers = readServers(configPath) ?? []
  const idx = servers.findIndex((s) => s.name === entry.name)
  if (idx >= 0) servers[idx] = entry
  else servers.push(entry)
  writeServersFile(configPath, servers)
  return { configPath }
}

/** 删除一个 MCP server 配置。不存在 → throw 干净错误。 */
export function deleteMcpServer(input: { name: string } & McpWriteInput): McpWriteResult {
  const configPath = resolveMcpPath(input)
  const servers = readServers(configPath)
  if (servers === undefined || !servers.some((s) => s.name === input.name)) {
    throw new Error(`MCP server "${input.name}" does not exist in ${configPath}`)
  }
  writeServersFile(configPath, servers.filter((s) => s.name !== input.name))
  return { configPath }
}
