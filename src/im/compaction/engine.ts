// Handoff-note compaction engine (KimiCode-style): fold assistant/tool turns
// into one first-person handoff note via an LLM call, keep user messages
// verbatim (head/tail budgeted), and splice the result back in place.
// Consumers: sub-agent loops and system-agent loops. Zero external deps —
// node builtins + existing src/ modules only.

import { GENERIC_TOKEN_COUNTER, type TokenCounter } from '../../shared/token-counter.js'
import { mintTurnId } from '../turn.js'
import type { ConversationMemory, ConversationTurn } from '../conversation-memory.js'
import type { StreamChunk, ToolCall } from '../../protocol/types.js'
import { HANDOFF_NOTE_PREFIX, buildHandoffInstruction } from './handoff-prompt.js'

// True when promptTokens strictly exceeds maxTokens * triggerRatio (default 0.85).
export const shouldCompact = (opts: {
  promptTokens: number
  maxTokens: number
  triggerRatio?: number
}): boolean => {
  const ratio = opts.triggerRatio ?? 0.85
  return opts.promptTokens > opts.maxTokens * ratio
}

// 转录不截断（2026-09-12 用户拍板）：工具内容与 args 全量进入压缩请求；
// user 回合的头/尾预算是"省略并如实告知盲区"，不是静默截断，保留。

// Serialize user content for token estimation: string as-is, ContentPart[] as JSON.
const serializeUserContent = (content: string | readonly unknown[]): string =>
  typeof content === 'string' ? content : JSON.stringify(content)

// Serialize one fold candidate (assistant | tool turn) into transcript lines.
// Line numbering uses the turn's original index in the conversation so the
// timeline stays traceable after folding.
const serializeFoldTurn = (turn: ConversationTurn, index: number): string[] => {
  if (turn.role === 'assistant') {
    const lines = [`[${index}] assistant: ${turn.content ?? ''}`]
    for (const call of turn.toolCalls ?? []) {
      lines.push(`[${index}] tool_call ${serializeToolCall(call)}`)
    }
    return lines
  }
  if (turn.role === 'tool') {
    const tag = turn.toolName ? `<${turn.toolName}>` : ''
    return [`[${index}] tool${tag}: ${turn.content}`]
  }
  return [] // user turns are never fold candidates (excluded by the caller)
}

const serializeToolCall = (call: ToolCall): string =>
  `${call.function.name}(${call.function.arguments ?? ''})`

// Run the handoff compaction. Returns undefined (no LLM call, no mutation) when
// there are fewer than minFoldTurns assistant/tool turns to fold.
//
// Semantics:
// - user turns are kept verbatim, budgeted head 2,000 + tail 18,000 tokens
//   (estimateTokens-based); over-budget middles are dropped and covered by the note.
// - all assistant/tool turns are folded into one note turn appended after the
//   kept user turns, via a single conversationMemory.replaceRange(0, len, newTurns).
// - only `content_delta` chunks contribute to the note; empty note throws.
export const compactConversation = async (opts: {
  conversationMemory: ConversationMemory
  streamChat: (
    url: string,
    request: { model: string; messages: unknown[]; [k: string]: unknown },
  ) => AsyncIterable<StreamChunk>
  url: string
  model: string
  systemPrompt?: string
  keepUserMessageTokens?: number
  minFoldTurns?: number
  /**
   * transcript 喂给摘要 LLM 的 token 预算（默认 300_000）。超限时从最老的行
   * 开始丢弃并在指令中如实注明盲区（对齐 KimiCode droppedCount 语义）——
   * 压缩触发时上下文已达 ~0.85 × maxTokens，不裁剪的话摘要请求自身就会
   * 逼近甚至超过模型窗口。
   */
  maxTranscriptTokens?: number
  tokenCounter?: TokenCounter
}): Promise<{ folded: number; note: string } | undefined> => {
  const {
    conversationMemory,
    streamChat,
    url,
    model,
    systemPrompt,
    keepUserMessageTokens = 20_000,
    minFoldTurns = 4,
    maxTranscriptTokens = 300_000,
    tokenCounter = GENERIC_TOKEN_COUNTER,
  } = opts

  const turns = conversationMemory.turns()
  const userTurns = turns.filter((t): t is Extract<ConversationTurn, { role: 'user' }> => t.role === 'user')
  const foldTurns = turns.filter((t) => t.role !== 'user')
  if (foldTurns.length < minFoldTurns) return undefined

  // ---- user-message budget: head 2,000 + tail 18,000 (KimiCode split) ----
  const headBudget = Math.min(2_000, keepUserMessageTokens)
  const tailBudget = Math.max(0, keepUserMessageTokens - headBudget)
  const estimates = userTurns.map((t) => tokenCounter.count(serializeUserContent(t.content)))
  const totalUserTokens = estimates.reduce((a, b) => a + b, 0)

  let kept: readonly Extract<ConversationTurn, { role: 'user' }>[]
  let droppedHint: string | undefined
  if (totalUserTokens <= keepUserMessageTokens) {
    // Within budget: keep all verbatim.
    kept = userTurns
  } else {
    // Over budget: take from the head up to headBudget, from the tail up to
    // tailBudget; always keep at least one turn per side; drop the middle.
    let headEnd = 0
    let cum = 0
    while (headEnd < userTurns.length) {
      const t = estimates[headEnd]!
      if (cum + t > headBudget && headEnd > 0) break
      cum += t
      headEnd++
    }
    let tailStart = userTurns.length
    cum = 0
    while (tailStart > headEnd) {
      const t = estimates[tailStart - 1]!
      if (cum + t > tailBudget && tailStart < userTurns.length) break
      cum += t
      tailStart--
    }
    const droppedCount = userTurns.length - headEnd - (userTurns.length - tailStart)
    kept = [...userTurns.slice(0, headEnd), ...userTurns.slice(tailStart)]
    if (droppedCount > 0) {
      droppedHint = `另有 ${droppedCount} 条早期用户消息未逐字保留，其要点见笔记`
    }
  }

  // ---- serialize the fold candidates into a timeline transcript ----
  // transcript 超 maxTranscriptTokens 时从最老的行丢弃，盲区如实上报——
  // 摘要请求自身必须 bounded（KimiCode 的 overflow-shrink 同语义）。
  let transcriptLines = turns
    .flatMap((turn, index) => (turn.role === 'user' ? [] : serializeFoldTurn(turn, index)))
  let transcript = transcriptLines.join('\n')
  let transcriptHint: string | undefined
  if (tokenCounter.count(transcript) > maxTranscriptTokens) {
    let cut = 0
    let cum = 0
    while (cut < transcriptLines.length) {
      cum += tokenCounter.count(transcriptLines[cut]!)
      if (cum > maxTranscriptTokens) break
      cut += 1
    }
    const droppedLines = cut
    transcriptLines = transcriptLines.slice(cut)
    transcript = transcriptLines.join('\n')
    transcriptHint = `对话时间线省略了最早的 ${droppedLines} 行（更早的内容不在本摘要范围内，笔记无法覆盖它们，恢复后不要假装记得）`
  }

  // ---- ask the LLM for the handoff note ----
  const instruction = buildHandoffInstruction({
    transcript,
    ...(droppedHint ? { droppedUserMessageHint: droppedHint } : {}),
    ...(transcriptHint ? { transcriptHint } : {}),
  })
  const messages: unknown[] = systemPrompt
    ? [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: instruction },
      ]
    : [{ role: 'user', content: instruction }]

  let note = ''
  for await (const chunk of streamChat(url, { model, messages })) {
    if (chunk.type === 'content_delta') note += chunk.text
  }
  if (note.trim() === '') {
    throw new Error('handoff compaction produced an empty note')
  }

  // ---- splice in place: kept user turns (original order) + the note turn ----
  const noteTurn: Extract<ConversationTurn, { role: 'user' }> = {
    id: mintTurnId('compaction-note'),
    role: 'user',
    content: HANDOFF_NOTE_PREFIX + '\n\n' + note,
    at: Date.now(),
  }
  conversationMemory.replaceRange(0, turns.length, [...kept, noteTurn])

  return { folded: foldTurns.length, note }
}
