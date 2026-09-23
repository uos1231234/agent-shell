/**
 * 配置路径解析 — 对齐 KimiCode resolveKimiHome 模式：
 * homeDir 参数 ?? env AGENT_SHELL_HOME ?? ~/.agent-shell。
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveShellHome(homeDir?: string | undefined, env?: Record<string, string | undefined>): string {
  return homeDir ?? env?.['AGENT_SHELL_HOME'] ?? join(homedir(), '.agent-shell')
}

export function resolveConfigPath(input: {
  homeDir?: string | undefined
  configPath?: string | undefined
  env?: Record<string, string | undefined>
}): string {
  return input.configPath ?? join(resolveShellHome(input.homeDir, input.env), 'providers.json')
}

export function ensureShellHome(homeDir: string): void {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 })
}
