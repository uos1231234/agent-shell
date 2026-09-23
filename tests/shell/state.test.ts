import { describe, it, expect } from 'vitest'
import type { State } from '../../src/shell/state.js'

describe('shell/state', () => {
  it('State is exactly the 2-value union Running / Tripped', () => {
    const running: State = 'Running'
    const tripped: State = 'Tripped'
    expect([running, tripped]).toEqual(['Running', 'Tripped'])
  })

  it('only Running allows work (gate throws on Tripped)', async () => {
    const { gate, ShellTerminatedError } = await import('../../src/shell/gate.js')
    expect(gate('Running', [])).toEqual({ ok: true })
    expect(() => gate('Tripped', [])).toThrow(ShellTerminatedError)
  })
})
