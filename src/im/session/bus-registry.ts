// v0.17 SessionBusRegistry — per-session databus ownership.
//
// Mirrors SecurityRouter's lifecycle shape (Map<SessionId, ...> +
// getOrCreate/create/delete/list) so session lifecycle semantics are uniform
// across the harness, but is implemented independently and does NOT import
// src/security/*. The only shared thing with SecurityRouter is the SessionId
// string value (the same UUID). This keeps the security mechanism and the
// session/databus mechanism decoupled — each owns its own state Map.
//
// Why a registry at all: multi-session windows mean multiple runIMLoops share
// one ToolRegistry. The working agent's databus (root.ownDatabus) and the
// sub-agent family bus (root.familyDatabus) must be attributable to a session
// so (a) query/subscribe can be scoped by session and (b) session close can
// release the buses' subscriptions. Buses themselves carry a sessionId field;
// the registry is the lookup that maps sessionId → the session's bus pair.

import type { SessionId, SessionBuses } from './types.js'
import { Databus, type ToolTurn } from '../databus.js'

export type SessionBusFilter = {
  sourceAgentIds?: string[]
  range?: [number, number]
  limit?: number
}

export class SessionBusRegistry {
  private readonly sessions = new Map<SessionId, SessionBuses>()

  /** Look up a session's buses. Returns undefined if not registered. */
  getSession(sessionId: SessionId): SessionBuses | undefined {
    return this.sessions.get(sessionId)
  }

  /** Look up a session's buses, lazily creating a default pair if missing. */
  getOrCreateSession(sessionId: SessionId): SessionBuses {
    let buses = this.sessions.get(sessionId)
    if (!buses) {
      buses = { own: new Databus(), family: new Databus() }
      this.sessions.set(sessionId, buses)
    }
    return buses
  }

  /** Explicitly register a session's bus pair. Throws if already registered. */
  registerSession(sessionId: SessionId, buses: SessionBuses): SessionBuses {
    if (this.sessions.has(sessionId)) {
      throw new Error(`SessionBusRegistry: session "${sessionId}" already registered`)
    }
    this.sessions.set(sessionId, buses)
    return buses
  }

  /** Register or replace a session's bus pair (idempotent). */
  registerOrUpdate(sessionId: SessionId, buses: SessionBuses): SessionBuses {
    this.sessions.set(sessionId, buses)
    return buses
  }

  /** Unregister a session and release its buses. Returns true if existed. */
  unregisterSession(sessionId: SessionId): boolean {
    return this.sessions.delete(sessionId)
  }

  /** List registered session ids. */
  listSessions(): SessionId[] {
    return [...this.sessions.keys()].sort()
  }

  /** Query tool turns across a session's buses (own + family), merged + deduped. */
  query(sessionId: SessionId, filter?: SessionBusFilter): readonly ToolTurn[] {
    const buses = this.sessions.get(sessionId)
    if (!buses) return []
    const all: ToolTurn[] = []
    for (const b of [buses.own, buses.family]) {
      all.push(...(b.query(filter as { sourceAgentIds?: string[]; range?: [number, number]; limit?: number }) as ToolTurn[]))
    }
    // Dedupe by turn id (a turn projected into both buses shares the same id).
    const seen = new Set<string>()
    const unique: ToolTurn[] = []
    for (const t of all) {
      if (seen.has(t.id)) continue
      seen.add(t.id)
      unique.push(t)
    }
    unique.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    if (filter?.limit !== undefined) return unique.slice(-filter.limit)
    return unique
  }

  /**
   * Subscribe to tool events across a session's buses, deduped by turn id.
   * Returns an unsubscribe function that removes all underlying subscriptions.
   */
  subscribe(
    sessionId: SessionId,
    sourceAgentId: string | '*',
    onEvent: (turn: ToolTurn) => void,
  ): () => void {
    const buses = this.sessions.get(sessionId)
    if (!buses) return () => {}
    const seen = new Set<string>()
    const dedup = (turn: ToolTurn): void => {
      if (seen.has(turn.id)) return
      seen.add(turn.id)
      onEvent(turn)
    }
    const unsubs = [buses.own.subscribe(sourceAgentId, dedup), buses.family.subscribe(sourceAgentId, dedup)]
    return () => { for (const u of unsubs) u() }
  }
}
