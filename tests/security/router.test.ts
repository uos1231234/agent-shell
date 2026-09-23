// router.test.ts
//
// Unit tests for SecurityRouter (src/security/router.ts).
//
// Coverage:
//   - getOrCreateSession: lazily creates a default '__global__' session when
//     sessionId is undefined, and reuses an existing session on a second call.
//   - createSession: explicitly creates a session, throws if the sessionId
//     already exists (no silent overwrite).
//   - registerDoor + check: doors run in registration order; the first
//     { allow: false } causes check() to throw with the door name + reason;
//     when every door allows, check() resolves without throwing.
//   - per-session isolation: two sessions with different sessionIds get
//     distinct SessionSecurityState instances (distinct ApprovalStore).
//   - ctx.sessionId undefined → '__global__' fallback (v0.15 compat).

import { describe, it, expect } from 'vitest'
import { SecurityRouter } from '../../src/security/router.js'
import type { SecurityDoor, SecurityDecision } from '../../src/security/types.js'

/** Build a trivial door that allows everything. */
function allowAllDoor(name: string): SecurityDoor {
  return {
    name,
    check: () => ({ allow: true }),
  }
}

/** Build a door that records its check() arguments for assertion. */
function recordingDoor(name: string, decision: SecurityDecision): {
  door: SecurityDoor
  calls: Array<{ sessionId: string; toolName: string; args: unknown }>
} {
  const calls: Array<{ sessionId: string; toolName: string; args: unknown }> = []
  return {
    calls,
    door: {
      name,
      check(sessionId, _state, toolName, args) {
        calls.push({ sessionId, toolName, args })
        return decision
      },
    },
  }
}

describe('SecurityRouter — getOrCreateSession', () => {
  it('lazily creates a "__global__" session when sessionId is undefined', () => {
    const router = new SecurityRouter()
    const s = router.getOrCreateSession(undefined)
    expect(s.sessionId).toBe('__global__')
    expect(s.approvalStore).toBeDefined()
  })

  it('reuses the existing session on a second call with the same id', () => {
    const router = new SecurityRouter()
    const a = router.getOrCreateSession('agent-1')
    const b = router.getOrCreateSession('agent-1')
    expect(b).toBe(a) // same reference — no duplicate session
  })

  it('creates distinct sessions for distinct ids', () => {
    const router = new SecurityRouter()
    const a = router.getOrCreateSession('agent-1')
    const b = router.getOrCreateSession('agent-2')
    expect(a).not.toBe(b)
    expect(a.approvalStore).not.toBe(b.approvalStore)
  })
})

describe('SecurityRouter — createSession', () => {
  it('explicitly creates a session with the given id', () => {
    const router = new SecurityRouter()
    const s = router.createSession('worker-42')
    expect(s.sessionId).toBe('worker-42')
    expect(s.approvalStore).toBeDefined()
  })

  it('throws if the sessionId already exists (no silent overwrite)', () => {
    const router = new SecurityRouter()
    router.createSession('worker-42')
    expect(() => router.createSession('worker-42')).toThrowError(
      /already exists/,
    )
  })

  it('createSession then getOrCreateSession returns the same reference', () => {
    const router = new SecurityRouter()
    const a = router.createSession('worker-42')
    const b = router.getOrCreateSession('worker-42')
    expect(b).toBe(a)
  })
})

describe('SecurityRouter — registerDoor + check', () => {
  it('runs doors in registration order', async () => {
    const router = new SecurityRouter()
    const rec1 = recordingDoor('d1', { allow: true })
    const rec2 = recordingDoor('d2', { allow: true })
    router.registerDoor(rec1.door)
    router.registerDoor(rec2.door)

    await router.check({ sessionId: 's1' }, 'read', { path: '/tmp/x' })
    expect(rec1.calls).toHaveLength(1)
    expect(rec2.calls).toHaveLength(1)
    // d1 ran before d2 (registration order)
    expect(rec1.calls[0]!.toolName).toBe('read')
    expect(rec2.calls[0]!.toolName).toBe('read')
  })

  it('throws on the first rejecting door with name + reason', async () => {
    const router = new SecurityRouter()
    const rec1 = recordingDoor('d1', { allow: true })
    const rejectDoor: SecurityDoor = {
      name: 'blocker',
      check: () => ({ allow: false, reason: 'forbidden by policy' }),
    }
    const rec3 = recordingDoor('d3', { allow: true })
    router.registerDoor(rec1.door)
    router.registerDoor(rejectDoor)
    router.registerDoor(rec3.door)

    await expect(
      router.check({ sessionId: 's1' }, 'write', { path: '/etc/passwd' }),
    ).rejects.toThrowError(/"blocker" rejected: forbidden by policy/)

    // d3 never ran — first reject short-circuits
    expect(rec3.calls).toHaveLength(0)
  })

  it('resolves without throwing when every door allows', async () => {
    const router = new SecurityRouter()
    router.registerDoor(allowAllDoor('d1'))
    router.registerDoor(allowAllDoor('d2'))
    await router.check({ sessionId: 's1' }, 'read', { path: '/tmp/x' })
  })

  it('passes the ctx.sessionId to door.check as the first arg', async () => {
    const router = new SecurityRouter()
    const rec = recordingDoor('d1', { allow: true })
    router.registerDoor(rec.door)
    await router.check({ sessionId: 'agent-7' }, 'bash', { command: 'ls' })
    expect(rec.calls[0]!.sessionId).toBe('agent-7')
  })

  it('falls back to "__global__" when ctx.sessionId is undefined', async () => {
    const router = new SecurityRouter()
    const rec = recordingDoor('d1', { allow: true })
    router.registerDoor(rec.door)
    await router.check({}, 'read', { path: '/tmp/x' })
    expect(rec.calls[0]!.sessionId).toBe('__global__')
  })
})

describe('SecurityRouter — per-session isolation', () => {
  it('two sessions get distinct ApprovalStore instances', () => {
    const router = new SecurityRouter()
    const a = router.getOrCreateSession('agent-1')
    const b = router.getOrCreateSession('agent-2')
    // Grant in session a, verify session b is unaffected
    a.approvalStore.grant('write:/secret')
    expect(a.approvalStore.isGranted('write:/secret')).toBe(true)
    expect(b.approvalStore.isGranted('write:/secret')).toBe(false)
  })
})
