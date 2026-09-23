/**
 * settings.json 读写 — 宿主功能配置（~/.databus/settings.json）。
 *
 * 家目录归属（用户拍板 2026-09-07，"功能配置与凭据分离"）：
 *   - 功能配置在 ~/.databus/（本文件 + mcp.json + agents/）
 *   - 凭据在 ~/.agent-shell/（providers.json）
 * 两个家目录不许合并或迁移——本模块刻意不读 AGENT_SHELL_HOME，路径恒为
 * join(homedir(), '.databus', 'settings.json')（homeDir 参数仅供测试注入）。
 *
 * 语义（与 src/config/write.ts 的 providers.json 写路径同模式）：
 *   - 读：文件缺失 → {}（设置是可选的，缺失是常态）；字段类型非法 → throw。
 *   - 写：读-改-写合并（未知字段保留，前向兼容）+ 原子写（tmp + rename）
 *     + 写前 .bak 备份（保留最近一版）。坏 patch 写不进文件。
 *   - 未知字段忽略校验（前向兼容，同 providers.json load 纪律）。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type DatabusSettings = {
  /** 子代理向下配置开关（缺省 false = 子代理不能再定义/运行子代理）。 */
  subAgentNesting?: boolean
  /** 模块 skill 目录（.ts/.js）。 */
  skillsDir?: string
  /** 文本 skill 目录（.md/.txt）。 */
  textSkillsDir?: string
}

type SettingsInput = { homeDir?: string | undefined }

const settingsPath = (input?: SettingsInput): string =>
  join(input?.homeDir ?? homedir(), '.databus', 'settings.json')

/**
 * 校验已知字段的类型，返回仅含已知字段的类型化视图。
 * 未知字段不进返回值（readDatabusSettings 的契约是 DatabusSettings），
 * 但写路径在 raw 层保留它们。
 */
const validateSettings = (raw: unknown, path: string): DatabusSettings => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid databus settings at ${path}: top level must be an object`)
  }
  const obj = raw as Record<string, unknown>
  const out: DatabusSettings = {}
  if (obj['subAgentNesting'] !== undefined) {
    if (typeof obj['subAgentNesting'] !== 'boolean') {
      throw new Error(`Invalid databus settings at ${path}: "subAgentNesting" must be a boolean`)
    }
    out.subAgentNesting = obj['subAgentNesting']
  }
  for (const field of ['skillsDir', 'textSkillsDir'] as const) {
    if (obj[field] !== undefined) {
      if (typeof obj[field] !== 'string') {
        throw new Error(`Invalid databus settings at ${path}: "${field}" must be a string`)
      }
      out[field] = obj[field]
    }
  }
  return out
}

/** 读原始对象（存在时）。文件存在但不是合法 JSON / 字段类型非法 → throw。 */
const readRawObject = (path: string): Record<string, unknown> | undefined => {
  if (!existsSync(path)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (cause) {
    throw new Error(`Invalid databus settings at ${path}: not valid JSON — ${String(cause)}`)
  }
  validateSettings(raw, path)
  return raw as Record<string, unknown>
}

/** 读宿主功能设置。文件缺失 → {}（设置可选，缺失是常态）。 */
export function readDatabusSettings(input?: SettingsInput): DatabusSettings {
  const path = settingsPath(input)
  const raw = readRawObject(path)
  return raw === undefined ? {} : validateSettings(raw, path)
}

/**
 * 读-改-写合并 + 原子写（tmp + rename）+ 写前 .bak。返回合并后的设置。
 * patch 里的显式 undefined 会清掉对应键（JSON.stringify 丢弃 undefined 值）。
 */
export function writeDatabusSettings(
  patch: Partial<DatabusSettings>,
  input?: SettingsInput,
): DatabusSettings {
  const path = settingsPath(input)
  const raw = readRawObject(path) ?? {}
  const merged: Record<string, unknown> = { ...raw, ...patch }
  validateSettings(merged, path) // 终检：坏数据写不进文件

  const tmpPath = `${path}.tmp`
  const bakPath = `${path}.bak`
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (existsSync(path)) copyFileSync(path, bakPath)
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  renameSync(tmpPath, path)

  return validateSettings(merged, path)
}
