/**
 * loadProviderConfig — 读取并校验 providers.json。
 *
 * 语义：
 *   - 文件不存在 → undefined（正常状态：装配层回落环境变量路径）
 *   - 文件存在但内容无效 → throw 干净错误（用户手写的配置坏了必须让他知道，
 *     静默回落会让人疑惑"明明填了配置为什么没用上"）
 *   - 未知字段忽略（前向兼容）
 */

import { existsSync, readFileSync } from 'node:fs'
import type {
  AgentShellConfig,
  LoadedProviderConfig,
  ProviderConfig,
  ProviderListResult,
  ProviderModel,
} from './types.js'
import { resolveConfigPath } from './paths.js'

const CONFIG_FILE = 'providers.json'

/**
 * listProviders — providers.json 全量快照（设置面板列表用）。与
 * loadProviderConfig 的差异：不执行 "active 必须指向存在条目" 的 fail-fast，
 * 允许调用方看到悬空 active 以便在前端修复。
 */
export function listProviders(input?: {
  configPath?: string | undefined
  homeDir?: string | undefined
  env?: Record<string, string | undefined>
}): ProviderListResult {
  const configPath = resolveConfigPath(input ?? {})
  if (!existsSync(configPath)) {
    return { exists: false, configPath, active: undefined, providers: {} }
  }
  const raw: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
  const config = validateShape(raw, configPath)
  return { exists: true, configPath, active: config.active, providers: config.providers ?? {} }
}

export function loadProviderConfig(input?: {
  configPath?: string | undefined
  homeDir?: string | undefined
  env?: Record<string, string | undefined>
}): LoadedProviderConfig | undefined {
  const configPath = resolveConfigPath(input ?? {})
  if (!existsSync(configPath)) return undefined

  const rawText = readFileSync(configPath, 'utf8')
  let raw: unknown
  try {
    raw = JSON.parse(rawText)
  } catch (cause) {
    throw new Error(`Invalid provider config at ${configPath}: not valid JSON — ${String(cause)}`)
  }

  const config = validateShape(raw, configPath)

  const active = config.active ?? (config.providers !== undefined ? Object.keys(config.providers)[0] : undefined)
  const providers = config.providers
  if (active === undefined || providers === undefined || providers[active] === undefined) {
    throw new Error(
      `Invalid provider config at ${configPath}: "active" must name an entry under "providers"`,
    )
  }

  return {
    provider: validateProvider(providers[active]!, active, configPath),
    name: active,
    configPath,
  }
}

/**
 * loadProviderConfigByName — 按 provider 名加载，不检查 "active"（供系统智能体
 * 固定默认 provider：工作代理可热切换，系统智能体锚定指定条目）。指定名不存在
 * 时返回 undefined（调用方决定回落 active 还是报错）。
 */
export function loadProviderConfigByName(input: {
  /** 空 = 使用 resolveConfigPath 缺省（~/.agent-shell/providers.json）。 */
  configPath?: string | undefined
  homeDir?: string | undefined
  env?: Record<string, string | undefined>
  providerName: string
}): LoadedProviderConfig | undefined {
  const configPath = resolveConfigPath(input)
  if (!existsSync(configPath)) return undefined
  const rawText = readFileSync(configPath, 'utf8')
  let raw: unknown
  try {
    raw = JSON.parse(rawText)
  } catch (cause) {
    throw new Error(`Invalid provider config at ${configPath}: not valid JSON — ${String(cause)}`)
  }
  const config = validateShape(raw, configPath)
  const providers = config.providers
  if (providers === undefined || providers[input.providerName] === undefined) return undefined
  return {
    provider: validateProvider(providers[input.providerName]!, input.providerName, configPath),
    name: input.providerName,
    configPath,
  }
}

export function validateShape(raw: unknown, configPath: string): AgentShellConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid provider config at ${configPath}: top level must be an object`)
  }
  const obj = raw as Record<string, unknown>
  const out: AgentShellConfig = {}
  if (obj['active'] !== undefined) {
    if (typeof obj['active'] !== 'string') {
      throw new Error(`Invalid provider config at ${configPath}: "active" must be a string`)
    }
    out.active = obj['active']
  }
  if (obj['providers'] !== undefined) {
    if (typeof obj['providers'] !== 'object' || obj['providers'] === null || Array.isArray(obj['providers'])) {
      throw new Error(`Invalid provider config at ${configPath}: "providers" must be an object`)
    }
    out.providers = obj['providers'] as Record<string, ProviderConfig>
  }
  return out
}

export function validateProvider(entry: ProviderConfig, name: string, configPath: string): ProviderConfig {
  const fail = (msg: string): Error =>
    new Error(`Invalid provider config at ${configPath}: provider "${name}" — ${msg}`)
  if (typeof entry !== 'object' || entry === null) throw fail('entry must be an object')
  if (typeof entry.url !== 'string' || !/^https?:\/\//.test(entry.url)) throw fail('"url" must be an http(s) URL string')
  if (typeof entry.model !== 'string' || entry.model.length === 0) throw fail('"model" must be a non-empty string')
  if (entry.apiKey !== undefined && typeof entry.apiKey !== 'string') throw fail('"apiKey" must be a string when present')
  if (entry.upstreamTrusted !== undefined && typeof entry.upstreamTrusted !== 'boolean') {
    throw fail('"upstreamTrusted" must be a boolean when present')
  }
  if (entry.capabilities !== undefined) {
    if (typeof entry.capabilities !== 'object' || entry.capabilities === null) {
      throw fail('"capabilities" must be an object when present')
    }
    for (const field of ['maxInputTokens', 'maxOutputTokens'] as const) {
      const v = entry.capabilities[field]
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v <= 0)) {
        throw fail(`"capabilities.${field}" must be a positive integer when present`)
      }
    }
    // v0.41 D19：严格角色交替开关。布尔字段，与上面的正整数字段分开校验。
    const strictAlternation = entry.capabilities.strictAlternation
    if (strictAlternation !== undefined && typeof strictAlternation !== 'boolean') {
      throw fail('"capabilities.strictAlternation" must be a boolean when present')
    }
  }
  if (entry.thinking !== undefined && !['max', 'high', 'low', 'off'].includes(entry.thinking)) {
    throw fail('"thinking" must be one of: max | high | low | off')
  }
  if (entry.reasoningEffort !== undefined && !['max', 'high', 'low', 'off'].includes(entry.reasoningEffort)) {
    throw fail('"reasoningEffort" must be one of: max | high | low | off')
  }
  if (entry.models !== undefined) {
    if (!Array.isArray(entry.models)) throw fail('"models" must be an array when present')
    const ids = new Set<string>()
    for (const m of entry.models) {
      if (typeof m !== 'object' || m === null || typeof (m as ProviderModel).id !== 'string' || (m as ProviderModel).id.length === 0) {
        throw fail('"models" entries must be objects with a non-empty "id"')
      }
      const model = m as ProviderModel
      if (ids.has(model.id)) throw fail(`"models" has duplicate id "${model.id}"`)
      ids.add(model.id)
      if (model.reasoning !== undefined) {
        const r = model.reasoning
        if (typeof r !== 'object' || r === null || !Array.isArray(r.efforts) || r.efforts.length === 0) {
          throw fail(`"models[${model.id}].reasoning.efforts" must be a non-empty array`)
        }
        for (const e of r.efforts) {
          if (!['max', 'high', 'low', 'off'].includes(e)) {
            throw fail(`"models[${model.id}].reasoning.efforts" contains invalid value ${JSON.stringify(e)}`)
          }
        }
        if (new Set(r.efforts).size !== r.efforts.length) {
          throw fail(`"models[${model.id}].reasoning.efforts" has duplicates`)
        }
        if (r.defaultEffort !== undefined && !r.efforts.includes(r.defaultEffort)) {
          throw fail(`"models[${model.id}].reasoning.defaultEffort" must be one of its "efforts"`)
        }
      }
    }
    if (!ids.has(entry.model)) {
      throw fail(`"model" ("${entry.model}") must be a member of "models" when "models" is present`)
    }
  }
  return entry
}

export { CONFIG_FILE }
