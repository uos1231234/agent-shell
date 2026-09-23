// The databus is the IM's tool-event store.
// ADR-016 §2.1: role-bounded to 'tool' only. user/assistant turns live in ConversationMemory.
// ADR-016 §2.1: passive — no auto-inject. Only query()/subscribe()/turns() callers see contents.

import { createHash } from 'node:crypto'

export type AgentId = string  // 'main' | 'warehouse' | 'compressor' | 'recall' | ...

export type ToolTurn = {
  id: string
  role: 'tool'
  toolCallId: string
  content: string
  isError?: true
  sourceAgentId: AgentId    // cross-agent join key
  at: number
  toolName?: string
  /** v0.24: 工具输入参数（parsed.value 原样）。tool.result 信号携带它，
   *  前端才能从写文件类调用（write/edit/search_replace 的 path 字段）
   *  机械提取产物路径——产物 chips 的数据源。可选：旧快照无此字段。 */
  args?: unknown
}

// stampOfToolTurn: 12-char content-hash stamp for a tool turn.
// Algorithm (aligned with l1-demo handlers/compress.py:51-55): SHA256 of
// `${toolCallId}:${toolName}:${content.slice(0,100)}`, first 12 hex chars.
// Content-addressed, not time-based: stable across restarts, re-computable
// without storage (the databus already holds the full ToolTurn — the stamp
// is a pure function of fields the databus always has).
//
// The two consumers:
//   - history-tool-table.ts: inlines the stamp into the truncation marker so
//     the model can see "this was truncated, here's the stamp to recall it".
//   - databus-query.ts: accepts a `stamp` filter; recomputes per candidate
//     and matches — no index, no persistence (O(n) over a few hundred turns
//     is negligible).
//
// CRITICAL: compute the stamp from the ORIGINAL (pre-truncation) content.
// The folding path computes before mutating; the query path reads databus
// turns whose content is never truncated (truncation only touches canonical).
export const stampOfToolTurn = (t: {
  toolCallId: string
  toolName?: string
  content: string
}): string =>
  createHash('sha256')
    .update(`${t.toolCallId}:${t.toolName ?? 'unknown'}:${t.content.slice(0, 100)}`)
    .digest('hex')
    .slice(0, 12)

export class Databus {
  /** The session UUID this bus belongs to (v0.17). Optional — anonymous buses keep working. */
  readonly sessionId?: string | undefined

  private readonly stored: ToolTurn[] = []
  private readonly subscribers: Array<{ sourceAgentId: AgentId | '*'; onEvent: (t: ToolTurn) => void }> = []

  constructor(opts?: { sessionId?: string }) {
    this.sessionId = opts?.sessionId
  }

  append(turn: ToolTurn): void {
    this.stored.push(turn)
    for (const sub of this.subscribers) {
      if (sub.sourceAgentId === '*' || sub.sourceAgentId === turn.sourceAgentId) {
        try {
          sub.onEvent(turn)
        } catch (e) {
          // Subscriber callbacks must not interrupt the append or other subscribers.
          // Databus stays dependency-free (no structured logger import), but a
          // subscriber crash is a real signal — warn so it is at least observable.
          console.warn('[databus] subscriber threw on append', {
            sourceAgentId: turn.sourceAgentId,
            err: e instanceof Error ? e.message : String(e),
          })
        }
      }
    }
  }

  turns(): readonly ToolTurn[] {
    return this.stored
  }

  query(filter?: { sourceAgentIds?: AgentId[]; range?: [number, number]; limit?: number }): readonly ToolTurn[] {
    let result = this.stored.slice()
    if (filter?.sourceAgentIds) {
      const ids = new Set(filter.sourceAgentIds)
      result = result.filter(t => ids.has(t.sourceAgentId))
    }
    if (filter?.range) {
      const [start, end] = filter.range
      result = result.filter(t => t.at >= start && t.at <= end)
    }
    if (filter?.limit !== undefined) {
      result = result.slice(-filter.limit)
    }
    return result
  }

  subscribe(sourceAgentId: AgentId | '*', onEvent: (turn: ToolTurn) => void): () => void {
    const entry = { sourceAgentId, onEvent }
    this.subscribers.push(entry)
    return () => {
      const idx = this.subscribers.indexOf(entry)
      if (idx >= 0) this.subscribers.splice(idx, 1)
    }
  }

  // Remove only projection entries whose id is in `ids`. Does not use at,
  // toolCallId, limit, or subscriber callbacks to infer a range. The
  // coordinator derives the exact tool ids from evictRange's returned turns
  // and passes them here to evict the matching projections.
  evictByIds(ids: readonly string[]): number {
    const idSet = new Set(ids)
    let removed = 0
    for (let i = this.stored.length - 1; i >= 0; i -= 1) {
      if (idSet.has(this.stored[i]!.id)) {
        this.stored.splice(i, 1)
        removed += 1
      }
    }
    return removed
  }
}
