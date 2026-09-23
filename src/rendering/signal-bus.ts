// Rendering signal bus — the dispatch core of the v0.20 rendering base.
// v0.20 plan §5.2: event pool + registered rule table + subscribe/broadcast.
//
// Design (mirrors memory-layers.ts SignalBus pattern — v0.10 decision):
//   - rules: RenderRule[] — registered, append-only-ish; unregister via returned fn
//   - emit: iterate rules in registration order; first rule whose match()=true
//     AND extract()=non-undefined wins; that signal is broadcast to subscribers
//     serially (await each in registration order).
//   - fire-and-forget: subscriber throw → swallow + logger.warn, never bubbles;
//     one subscriber failing does not block the rest.
//   - no rule matches / extract returns undefined → silent return, no warn.
//
// Logger: opts.logger optional; falls back to console.

import type { Logger } from '../shared/logger.js'
import type { ToolTurn } from '../im/databus.js'

export type ArtifactSignal =
  | { kind: 'markdown'; title: string; source: string; content: string }
  | {
      kind: 'artifact-ref'
      title: string
      source: string
      artifactId: string
      sizeBytes: number
      mime: 'text/html' | 'text/markdown'
    }

export type RenderRule = {
  /** Debug/log identity. */
  name: string
  match(toolName: string): boolean
  /** parsed = JSON.parse 后的工具结果（非 JSON 结果为 undefined）；turn = 原始
   *  ToolTurn（args/isError 在此——写文件类规则需要 args.path 定位产物文件）。 */
  extract(parsed: unknown, turn: ToolTurn): ArtifactSignal | undefined
}

export type RenderingSignalBus = {
  /** Append rule to the pool; returns an unregister function. */
  registerRule(rule: RenderRule): () => void
  /** Match rules in order; first extract()≠undefined wins → serial broadcast. */
  emit(toolName: string, turn: ToolTurn): Promise<void>
  /** Register a subscriber; returns an unsubscribe function. */
  onSignal(h: (s: ArtifactSignal) => void | Promise<void>): () => void
}

type ConsoleLike = {
  warn(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
}

/** JSON.parse(content); returns undefined on failure (never throws).
 *
 * v0.20 P2 fix: 当 wiki-mcp 在 JSON 正文后追加 reminder 文本块时，
 * connection.ts 的 stringifyCallToolResult 会把它们 join('\n') 拼成一个混合字符串。
 * 恢复逻辑：先尝试直接 parse（快路径）；失败时，从字符串开头提取第一个合法的
 * JSON 对象（花括号匹配，忽略字符串内的花括号）。 */
function parseResult(_toolName: string, content: string): unknown {
  // 快路径：直接 parse（无 reminder 的正常情况）
  try {
    return JSON.parse(content)
  } catch {
    // 继续恢复
  }

  // 恢复路径：提取第一个合法的 JSON 对象/数组
  const trimmed = content.trimStart()
  const firstChar = trimmed[0]
  if (firstChar !== '{' && firstChar !== '[') return undefined
  const closeChar = firstChar === '{' ? '}' : ']'

  let depth = 0
  let inString = false
  let escape = false
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue

    if (ch === firstChar) depth++
    if (ch === closeChar) depth--
    if (depth === 0) {
      try {
        return JSON.parse(trimmed.slice(0, i + 1))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

export function createRenderingSignalBus(opts?: { logger?: Logger }): RenderingSignalBus {
  const rules: RenderRule[] = []
  const subscribers: Array<(s: ArtifactSignal) => void | Promise<void>> = []

  const logger: ConsoleLike =
    opts?.logger ?? {
      warn: (msg, fields) => console.warn(msg, fields ?? ''),
      info: (msg, fields) => console.info(msg, fields ?? ''),
    }

  const registerRule = (rule: RenderRule): (() => void) => {
    rules.push(rule)
    return () => {
      const idx = rules.indexOf(rule)
      if (idx >= 0) rules.splice(idx, 1)
    }
  }

  const onSignal = (
    h: (s: ArtifactSignal) => void | Promise<void>,
  ): (() => void) => {
    subscribers.push(h)
    return () => {
      const idx = subscribers.indexOf(h)
      if (idx >= 0) subscribers.splice(idx, 1)
    }
  }

  const emit = async (toolName: string, turn: ToolTurn): Promise<void> => {
    // Parse once per emit (outside the rule loop — content is the same).
    const parsed = parseResult(toolName, turn.content)

    let signal: ArtifactSignal | undefined
    let winningName: string | undefined
    for (const rule of rules) {
      if (!rule.match(toolName)) continue
      const sig = rule.extract(parsed, turn)
      if (sig !== undefined) {
        signal = sig
        winningName = rule.name
        break
      }
      // extract returned undefined → continue to next matching rule.
    }

    if (signal === undefined) return

    logger.info('rendering: signal emitted', { rule: winningName, kind: signal.kind })

    // Serial broadcast in registration order; swallow per-subscriber errors.
    for (const h of subscribers) {
      try {
        await h(signal)
      } catch (e) {
        logger.warn('rendering: subscriber threw', {
          rule: winningName,
          kind: signal.kind,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }

  return { registerRule, emit, onSignal }
}
