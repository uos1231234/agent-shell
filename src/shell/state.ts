// ADR-002: shell is a funnel, not FSM.
// The state is a 2-value enum. No transition table. No half-open probing.

export type State = 'Running' | 'Tripped'
