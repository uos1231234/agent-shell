// ADR-002: the gate is the funnel's valve.
// Running → flow continues.
// Tripped → the valve is closed; the caller (IM) MUST terminate.

import type { State } from './state.js'
import type { GuardHit } from './guards.js'

export type GateOk = { ok: true }

export class ShellTerminatedError extends Error {
  readonly state: State
  readonly hits: GuardHit[]

  constructor(state: State, hits: GuardHit[]) {
    const summary = hits.length > 0
      ? hits.map(h => `${h.id}:${h.reason}`).join('; ')
      : 'shell terminated'
    super(`Shell terminated (${state}) — ${summary}`)
    this.name = 'ShellTerminatedError'
    this.state = state
    this.hits = hits
  }
}

export const gate = (state: State, hits: GuardHit[]): GateOk => {
  if (state === 'Running') {
    return { ok: true }
  }
  throw new ShellTerminatedError(state, hits)
}
