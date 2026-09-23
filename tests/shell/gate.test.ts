import { describe, it, expect } from 'vitest'
import { gate, ShellTerminatedError } from '../../src/shell/gate.js'

describe('shell/gate', () => {
  describe('Running', () => {
    it('returns ok without throwing', () => {
      const r = gate('Running', [])
      expect(r.ok).toBe(true)
    })
  })

  describe('Tripped', () => {
    it('throws ShellTerminatedError with the trip reason', () => {
      expect(() => gate('Tripped', [{ id: 'token', reason: 'over budget' }])).toThrow(ShellTerminatedError)
      try {
        gate('Tripped', [{ id: 'token', reason: 'over budget' }])
      } catch (e) {
        expect(e).toBeInstanceOf(ShellTerminatedError)
        const err = e as ShellTerminatedError
        expect(err.state).toBe('Tripped')
        expect(err.hits[0]?.id).toBe('token')
        expect(err.hits[0]?.reason).toBe('over budget')
        expect(err.message).toMatch(/token/i)
      }
    })
  })
})
