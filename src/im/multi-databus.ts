// MultiDatabus: read-only merged view over multiple Databus instances.
//
// Used as ctx.databus when a loop needs to see more than one bus
// (e.g. the working agent sees its own private bus + the sub-agent shared
// bus; a sub-agent sees the shared bus + the working agent's bus).
//
// Mirrors the read-side of Databus (turns/query/subscribe/evictByIds).
// Does NOT implement append — writes always go to a single concrete Databus.

import type { AgentId, ToolTurn } from './databus.js'
import { Databus } from './databus.js'

export type DatabusFilter = {
  sourceAgentIds?: AgentId[]
  range?: [number, number]
  limit?: number
}

export class MultiDatabus {
  private cachedMerge: ToolTurn[] | undefined
  private readonly unsubs: (() => void)[] = []

  constructor(private readonly buses: readonly Databus[]) {
    if (buses.length === 0) {
      throw new Error('MultiDatabus requires at least one underlying Databus')
    }
    // Invalidate the cached merge whenever any underlying bus appends a turn.
    // The unsubscribe handles are retained so close() can detach this view from
    // the underlying buses — otherwise the closure (which captures `this`) pins
    // the MultiDatabus instance forever, leaking it and its cached turns.
    for (const bus of buses) {
      this.unsubs.push(bus.subscribe('*', () => { this.cachedMerge = undefined }))
    }
  }

  /**
   * Detach this merged view from its underlying buses (removes the cache
   * invalidation subscriptions). Call when the view is no longer needed —
   * e.g. at the end of a runIMLoop that built a ctxDatabus from multiple buses.
   * Idempotent: a second call is a no-op.
   */
  close(): void {
    for (const u of this.unsubs) u()
    this.unsubs.length = 0
    this.cachedMerge = undefined
  }

  turns(): readonly ToolTurn[] {
    if (this.cachedMerge === undefined) {
      this.cachedMerge = this.dedupeAndSort(this.buses.flatMap(b => b.turns()))
    }
    return this.cachedMerge
  }

  query(filter?: DatabusFilter): readonly ToolTurn[] {
    // When a filter is applied, we can't use the unfiltered cache directly.
    // But we can still avoid re-merging from the underlying buses by starting
    // from the cached merge (if present) and applying the filter locally.
    const base = this.cachedMerge ?? this.dedupeAndSort(this.buses.flatMap(b => b.turns()))
    this.cachedMerge = base  // populate cache if it wasn't already
    if (!filter) return base
    let result = [...base]
    if (filter.sourceAgentIds) {
      const ids = new Set(filter.sourceAgentIds)
      result = result.filter(t => ids.has(t.sourceAgentId))
    }
    if (filter.range) {
      const [start, end] = filter.range
      result = result.filter(t => t.at >= start && t.at <= end)
    }
    if (filter.limit !== undefined) {
      result = result.slice(-filter.limit)
    }
    return result
  }

  subscribe(sourceAgentId: AgentId | '*', onEvent: (turn: ToolTurn) => void): () => void {
    // A turn projected into multiple buses shares the same id; dedupe across
    // buses so the subscriber sees each turn exactly once per subscription.
    const seen = new Set<string>()
    const dedup = (turn: ToolTurn): void => {
      if (seen.has(turn.id)) return
      seen.add(turn.id)
      onEvent(turn)
    }
    const unsubs = this.buses.map(b => b.subscribe(sourceAgentId, dedup))
    return () => { for (const u of unsubs) u() }
  }

  evictByIds(ids: readonly string[]): number {
    const result = this.buses.reduce((sum, b) => sum + b.evictByIds(ids), 0)
    if (result > 0) this.cachedMerge = undefined
    return result
  }

  // Deduplicate by id (a turn projected into two buses has the same id),
  // then sort by at, breaking ties by id for determinism.
  private dedupeAndSort(turns: readonly ToolTurn[]): ToolTurn[] {
    const seen = new Set<string>()
    const unique: ToolTurn[] = []
    for (const t of turns) {
      if (seen.has(t.id)) continue
      seen.add(t.id)
      unique.push(t)
    }
    unique.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return unique
  }
}
