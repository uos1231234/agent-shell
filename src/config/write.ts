/**
 * providers.json 写路径 — upsert / delete / activate。
 *
 * 语义（与 load.ts 的 fail-fast 纪律对齐）：
 *   - 读-改-写：写入前用 load.ts 导出的 validateShape / validateProvider 校验，
 *     坏数据写不进文件。
 *   - 原子写：先写 tmp 文件再 rename，进程中断不产生半截文件。
 *   - 备份：写入前把原文件复制为 .bak（覆盖上次备份——保留最近一版即可）。
 *   - 文件不存在时 upsert/activate 创建之（首次使用）；delete 掉 active 条目
 *     （active 悬空）→ throw 干净错误。
 *
 * 注：文件配置模式下配置在启动期读一次，写入后需重启 web-host 对新会话
 * 生效（提示由 UI 层负责，本模块只负责把文件写对）。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentShellConfig, ProviderConfig, WriteResult } from './types.js'
import { resolveConfigPath } from './paths.js'
import { validateProvider, validateShape } from './load.js'
import { resolveModelReasoning } from './model-capabilities.js'

export type WriteInput = {
  configPath?: string | undefined
  homeDir?: string | undefined
  env?: Record<string, string | undefined>
}

type ProviderOp = (config: AgentShellConfig, configPath: string) => void

export const upsertProvider = (input: { name: string; provider: ProviderConfig } & WriteInput): WriteResult =>
  writeThrough(input, (config, configPath) => {
    const entry = validateProvider(input.provider, input.name, configPath)
    config.providers = { ...(config.providers ?? {}), [input.name]: entry }
  })

export const deleteProvider = (input: { name: string } & WriteInput): WriteResult =>
  writeThrough(input, (config, configPath) => {
    if (config.providers?.[input.name] === undefined) {
      throw new Error(`provider "${input.name}" does not exist in ${configPath}`)
    }
    if (config.active === input.name) {
      throw new Error(`provider "${input.name}" is active — activate another provider before deleting it`)
    }
    const { [input.name]: _removed, ...rest } = config.providers
    config.providers = rest
  })

export const activateProvider = (input: { name: string } & WriteInput): WriteResult =>
  writeThrough(input, (config, configPath) => {
    if (config.providers?.[input.name] === undefined) {
      throw new Error(`provider "${input.name}" does not exist in ${configPath}`)
    }
    config.active = input.name
  })

/**
 * selectProviderModel（v0.32，dsh selectModel 同款语义）：一次写盘完成
 * 服务商/模型/档位三种选择的任意组合。切换语义：
 *   - provider 缺省 = 当前 active；
 *   - model 给定 → 校验目录成员（无 models 目录 = 单模型条目，直接改选中）
 *     并**清除 reasoningEffort**——档位跟随新模型 defaultEffort（dsh choose
 *     不带 effort、服务端物化 defaultEffort）；
 *   - effort 给定 → 校验 ∈ 该模型有效 efforts（声明覆盖/内置表），写
 *     provider.reasoningEffort；effort 缺省 → 清除（跟随默认）。
 * 未知且未声明能力的模型：拒绝选档（fail-fast——保守方案下 UI 根本不渲染
 * 档位组，走到这里说明调用方绕过了门控）。
 */
export const selectProviderModel = (input: {
  provider?: string | undefined
  model?: string | undefined
  effort?: import('./types.js').ThinkingEffort | undefined
} & WriteInput): WriteResult =>
  writeThrough(input, (config, configPath) => {
    const name = input.provider ?? config.active
    if (name === undefined || config.providers?.[name] === undefined) {
      throw new Error(`provider "${name ?? '(none)'}" does not exist in ${configPath}`)
    }
    const entry = validateProvider(config.providers[name]!, name, configPath)
    if (input.model !== undefined && input.model !== entry.model) {
      if (entry.models !== undefined && !entry.models.some((m) => m.id === input.model)) {
        throw new Error(
          `provider "${name}" has no model "${input.model}" in its catalog ` +
            `(${entry.models.map((m) => m.id).join(', ')})`,
        )
      }
      entry.model = input.model
      entry.reasoningEffort = undefined
    }
    if (input.effort !== undefined) {
      const declared = entry.models?.find((m) => m.id === entry.model)?.reasoning
      const reasoning = resolveModelReasoning(entry.model, declared)
      if (reasoning === undefined) {
        throw new Error(
          `model "${entry.model}" has no declared reasoning capabilities — ` +
            `declare models[].reasoning in providers.json before selecting an effort`,
        )
      }
      if (!reasoning.efforts.includes(input.effort)) {
        throw new Error(
          `model "${entry.model}" does not support effort "${input.effort}" ` +
            `(supported: ${reasoning.efforts.join(', ')})`,
        )
      }
      entry.reasoningEffort = input.effort
    } else if (input.model === undefined) {
      // 仅清 effort 的调用（{effort: undefined}）= 回到跟随模型默认。
      entry.reasoningEffort = undefined
    }
    config.providers[name] = entry
  })

/** 读-校验-改-终检-原子写（tmp + rename）+ .bak 备份。 */
const writeThrough = (input: WriteInput, op: ProviderOp): WriteResult => {
  const configPath = resolveConfigPath(input)

  let config: AgentShellConfig = {}
  if (existsSync(configPath)) {
    const raw: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
    config = validateShape(raw, configPath)
  }

  op(config, configPath)

  // 终检：改动后的 config 必须仍是合法形态（active 指向存在的条目）。
  if (config.active !== undefined && (config.providers === undefined || config.providers[config.active] === undefined)) {
    throw new Error(`invalid config after write: "active" names "${config.active}" which has no provider entry`)
  }

  const tmpPath = `${configPath}.tmp`
  const bakPath = `${configPath}.bak`
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 })
  if (existsSync(configPath)) copyFileSync(configPath, bakPath)
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
  renameSync(tmpPath, configPath)

  return { configPath, config }
}
