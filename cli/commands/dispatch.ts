// v0.26 Wave 4 — /命令分发管线（计划 §3.3）。
//
// 编辑器提交行 → resolveSlashInput 三分：
//   1. message  — 无前导 /，或未知的 /xxx（降级为普通 prompt，KimiCode 同款）
//   2. builtin  — 注册表命中且 availability 允许
//   3. blocked  — 注册表命中但 idle-only 且当前非 idle（不执行；app 负责
//      经 editor.setLine 把输入文本还原，本模块只给意图，不碰编辑器）
//
// idle 的计算（!streaming && !approvalPending && …）属于 app 层（计划 §4.6）：
// resolveSlashInput 只接收布尔结果，本模块不读 SessionView。
//
// 命令文本永不进模型历史（计划 §4.4）——message 意图由 app 经 gate
// user.prompt 发送；blocked 意图什么都不发。

import { CLI_SLASH_COMMANDS, findCommand, type BuiltinCommandName } from './registry.js'

export type SlashIntent =
  | { kind: 'message'; text: string }
  | { kind: 'builtin'; name: BuiltinCommandName; args: string }
  | { kind: 'blocked'; name: BuiltinCommandName }

/**
 * 把一行已提交输入解析为执行意图。
 *
 * @param input 编辑器提交的原始行（内部先 trim；前导空白不影响判定）
 * @param idle  app 计算的会话空闲态（!streaming && !approvalPending；见文件头）
 */
export const resolveSlashInput = (input: string, idle: boolean): SlashIntent => {
  const line = input.trim()
  if (!line.startsWith('/')) return { kind: 'message', text: line }

  const sp = line.indexOf(' ')
  const name = sp === -1 ? line.slice(1) : line.slice(1, sp)
  const args = sp === -1 ? '' : line.slice(sp + 1).trim()

  const cmd = findCommand(name)
  if (cmd === undefined) return { kind: 'message', text: line } // 未命中降级为 prompt
  if (cmd.availability === 'idle-only' && !idle) return { kind: 'blocked', name: cmd.name }
  return { kind: 'builtin', name: cmd.name, args }
}

/**
 * Tab 补全（✅P1-1，从注册表派生）。
 *
 *   - 行内无空格（或只有 /前缀）：按主名或别名前缀过滤，返回规范名
 *     '/name'（别名命中也归一到主名），按名字排序；空前缀 → 全部命令。
 *   - 行为 '/cmd args…' 且该命令声明了 completeArgs：补全第一个参数，
 *     返回 '/cmd candidate' 全行候选。
 *   - 其余（未知命令 / 无 completeArgs 的带参行）：空数组。
 */
export const tabComplete = (line: string): string[] => {
  const trimmed = line.replace(/^\s+/, '')
  if (!trimmed.startsWith('/')) return []

  const sp = trimmed.indexOf(' ')
  if (sp === -1) {
    const prefix = trimmed.slice(1).toLowerCase()
    return CLI_NAMES.filter((n) => n.startsWith(prefix)).map((n) => `/${n}`)
  }

  const name = trimmed.slice(1, sp)
  const cmd = findCommand(name)
  if (cmd === undefined || !('completeArgs' in cmd)) return []
  const argPrefix = trimmed.slice(sp + 1)
  return cmd
    .completeArgs(argPrefix)
    .filter((c: string) => c !== '')
    .map((c: string) => `/${name} ${c}`)
}

// 规范名集合（Tab 补全用；注册表内 name 无重复，导入序即声明序，排序在过滤后做）。
const CLI_NAMES: readonly string[] = CLI_SLASH_COMMANDS.map((c) => c.name).sort()

/**
 * help 面板行（从注册表派生）：命令列（/name + 别名 + 参数提示）与描述
 * 对齐两列。纯函数，无状态。
 */
export const buildHelpLines = (): string[] => {
  const left = CLI_SLASH_COMMANDS.map((c) => {
    const base = `/${c.name}`
    const alias = c.aliases.length > 0 ? ` (${c.aliases.join(', ')})` : ''
    const hint = c.argumentHint !== undefined ? ` ${c.argumentHint}` : ''
    return `${base}${alias}${hint}`
  })
  const width = Math.max(...left.map((s) => s.length))
  return CLI_SLASH_COMMANDS.map((c, i) => `${left[i]!.padEnd(width + 2)}${c.description}`)
}
