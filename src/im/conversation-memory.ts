// The canonical ordered conversation sequence.
// v0.10.4: ConversationMemory is the single source of truth for the working
// prompt — it stores user, assistant, AND tool turns in exact append order.
// Databus remains a tool-only projection copy; appendCanonicalTurn() in
// turn.ts is the one production write path that keeps both in sync.

import type { ToolCall, ContentPart } from '../protocol/types.js'
import type { ToolTurn } from './databus.js'

// reasoning（2026-09-12 用户拍板）：assistant 回合的思维链全文，仅落盘/回放；
// turnToMessage 刻意不投影它——思维链是回包词汇，不发回请求。
export type ConversationTurn =
  | { id: string; role: 'user'; content: string | ContentPart[]; at: number }
  | { id: string; role: 'assistant'; content: string | null; toolCalls?: ToolCall[]; reasoning?: string; at: number }
  | ToolTurn

export class ConversationMemory {
  private readonly stored: ConversationTurn[] = []

  append(turn: ConversationTurn): void {
    this.stored.push(turn)
  }

  turns(): readonly ConversationTurn[] {
    return this.stored
  }

  last(): ConversationTurn | undefined {
    return this.stored[this.stored.length - 1]
  }

  // Remove the half-open range [startIndex, endIndexExclusive) and return
  // the removed turns. The coordinator uses this to evict a persisted task
  // block exactly, then derives the tool ids from the returned turns to
  // evict the matching Databus projections.
  evictRange(startIndex: number, endIndexExclusive: number): readonly ConversationTurn[] {
    const removed = this.stored.splice(startIndex, endIndexExclusive - startIndex)
    return removed
  }

  // Replace the half-open range [startIndex, endIndexExclusive) with the
  // given turns, in place, preserving surrounding order. Used by the
  // handoff-note compaction path (sub-agents / warehouse / recall): the
  // replaced-out span is summarized into one note turn and the note is
  // spliced back at the same position, so the model always sees "there is
  // history here" instead of an unexplained gap. Distinct from evictRange,
  // which deletes outright (block-level compression keeps its content on
  // disk; the note keeps it only inside the replacement turn).
  replaceRange(
    startIndex: number,
    endIndexExclusive: number,
    replacement: readonly ConversationTurn[],
  ): readonly ConversationTurn[] {
    const removed = this.stored.splice(startIndex, endIndexExclusive - startIndex, ...replacement)
    return removed
  }
}
