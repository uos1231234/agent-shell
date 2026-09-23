// A Turn is IM's representation of one conversational step.
// v0.10.4: ConversationMemory is the canonical ordered sequence (user,
// assistant, tool in exact append order). Databus is a tool-only projection
// copy. appendCanonicalTurn is the sole production write path that keeps
// both stores in sync.

import { randomUUID } from 'node:crypto'
import type { ToolCall, ChatMessage } from '../protocol/types.js'
import { stampOfToolTurn, type ToolTurn, type Databus } from './databus.js'
import type { ConversationTurn, ConversationMemory } from './conversation-memory.js'
import { projectToolResult, type ToolResultProjection } from './tools/result-budget.js'
import type { TokenCounter } from '../shared/token-counter.js'

// Re-export for backward compat (other files may import Turn from here)
export type { ToolTurn, ConversationTurn, ConversationMemory }

// Backward compat alias: the full union of all turn types.
export type Turn = ConversationTurn | ToolTurn

// v0.14 P1-1: single source of truth for minting turn ids. Replaces the
// prior Math.random().toString(36) inline helpers in loop.ts and
// system-agent.ts. UUIDs are collision-free and Node-native. The prefix is
// preserved so ids remain human-greppable (tool-…, assistant-…, sys-…).
export const mintTurnId = (prefix: string): string => `${prefix}-${randomUUID()}`

// 用户停止轮次的终止标记（2026-09-17 用户拍板）：turn.cancel 时宿主在 canonical
// 追加一条 role:'user' 的标记回合——上一条 user 回合是起始符号，本条是终止符号，
// 被打断的工作天然构成一个完整任务块（findNextTaskBlock 不把 stop- 回合当块
// 边界，它作为块的最后一条消息留在切片内）。compressor 提示词按正文 sentinel
// 识别（wire 消息不带回合 id），把该块标为 DONE（用户决定关闭，非未完待续）。
// sentinel 必须稳定：改文案会同时破坏提示词引导与切块器之外的任何内容匹配。
export const USER_INTERRUPTED_MARKER = '[Request interrupted by user] 用户主动停止了本轮回复。'

export const buildUserStopMarkerTurn = (): ConversationTurn => ({
  id: mintTurnId('stop'),
  role: 'user',
  content: USER_INTERRUPTED_MARKER,
  at: Date.now(),
})

// Translate a Turn into an OpenAI ChatMessage. This is the only place where
// Turn → ChatMessage conversion happens, so the rest of the IM and the
// shell.compose layer stay decoupled from the protocol's wire format.
//
// Note: `reasoning` (chain-of-thought, reply-side vocabulary) is intentionally
// NOT carried over either — requests must never echo it back, and strict
// providers reject unknown fields.
// Note: `isError` is intentionally NOT carried over. The OpenAI Chat Completions
// `role: 'tool'` schema is `{ role, tool_call_id, content }` only; any extra
// field is rejected by strict providers. The LLM reads `content` to learn
// about errors; agent-shell tracks the same fact via the `Turn.isError`
// flag for the local errorRate guard.
export const turnToMessageWithCounter = (
  turn: ConversationTurn | ToolTurn,
  tokenCounter?: TokenCounter,
): ChatMessage => {
  switch (turn.role) {
    case 'user':
      return { role: 'user', content: turn.content }
    case 'assistant': {
      const msg: { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] } = {
        role: 'assistant',
        content: turn.content,
      }
      if (turn.toolCalls !== undefined) msg.tool_calls = turn.toolCalls
      return msg
    }
    case 'tool': {
      // The canonical turn and Databus retain the complete result. Only the
      // protocol-facing projection is bounded, so recovery and exact recall
      // remain lossless while the next model request stays within the result
      // budget.
      const projection = projectToolResult({
        content: turn.content,
        stamp: stampOfToolTurn(turn),
        ...(tokenCounter !== undefined ? { tokenCounter } : {}),
      })
      return { role: 'tool', tool_call_id: turn.toolCallId, content: projection.visibleContent }
    }
  }
}

export const turnToMessage = (turn: ConversationTurn | ToolTurn): ChatMessage =>
  turnToMessageWithCounter(turn)

// The sole production write path for appending a turn to the canonical
// conversation. Always appends `turn` to `conversation`; when the turn is a
// tool turn, also appends a structural copy to `databus` so the projection
// stays in sync. Never adds user/assistant to Databus.
export function appendCanonicalTurn(
  conversation: ConversationMemory,
  databus: Databus,
  turn: ConversationTurn,
  databusTurn?: ToolTurn,
): void {
  conversation.append(turn)
  if (turn.role === 'tool') {
    databus.append(databusTurn ?? turn)
  }
}

/**
 * Append one complete tool event to the Databus and a bounded projection to
 * the model-facing canonical conversation. The Databus remains authoritative;
 * the returned projection is the only content that enters the next prompt.
 */
export function appendToolResultWithProjection(
  conversation: ConversationMemory,
  databus: Databus,
  turn: ToolTurn,
  options?: { maxVisibleTokens?: number; tokenCounter?: TokenCounter },
): { projection: ToolResultProjection; projectedTurn: ToolTurn } {
  const projection = projectToolResult({
    content: turn.content,
    stamp: stampOfToolTurn(turn),
    ...(options?.maxVisibleTokens !== undefined ? { maxVisibleTokens: options.maxVisibleTokens } : {}),
    ...(options?.tokenCounter !== undefined ? { tokenCounter: options.tokenCounter } : {}),
  })
  const projectedTurn = { ...turn, content: projection.visibleContent }
  appendCanonicalTurn(conversation, databus, projectedTurn, turn)
  return { projection, projectedTurn }
}
