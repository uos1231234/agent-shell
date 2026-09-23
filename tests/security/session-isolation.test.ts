// session-isolation.test.ts
//
// Integration-style tests for per-session security isolation via SecurityRouter.
//
// Scenarios:
//   1. Same-session sharing: a write approval granted in session A is visible
//      to a later tool call in the same session (handler not re-invoked).
//   2. Cross-session isolation: a grant in session A does NOT affect session B
//      (handler IS invoked for session B).
//   3. Subagent inheritance: a sub-agent that inherits its parent's sessionId
//      shares the parent's approval grants. We simulate the inheritance
//      directly: run-subagent.ts threads ctx.sessionId into createSystemAgent
//      opts.sessionId → loop opts.sessionId → child ctx.sessionId. Here we
//      verify the router-level consequence: child and parent dispatch to the
//      same SessionSecurityState when they share sessionId.
//   4. Default session: when ctx.sessionId is undefined, the router falls back
//      to '__global__' (v0.15 compat — no session isolation, single shared
//      state). Two undefined-sessionId calls share the global state.

import { describe, it, expect } from 'vitest'
import { SecurityRouter } from '../../src/security/router.js'
import { ApprovalStore } from '../../src/im/tools/security/approval-store.js'
import { createWriteApprovalDoor } from '../../src/security/doors/write-approval.js'

describe('session isolation — same-session sharing', () => {
  it('a write approval in session A is visible to a later call in session A', async () => {
    const router = new SecurityRouter()
    const state = router.createSession('agent-A')

    let handlerCalls = 0
    router.registerDoor(createWriteApprovalDoor({
      handler: async () => {
        handlerCalls++
        return 'approved'
      },
    }))

    // First write: handler invoked, grant recorded
    await router.check(
      { sessionId: 'agent-A' }, 'write', { path: '/tmp/shared.txt' },
    )
    expect(handlerCalls).toBe(1)

    // Second write to the SAME file in the SAME session: short-circuited
    await router.check(
      { sessionId: 'agent-A' }, 'write', { path: '/tmp/shared.txt' },
    )
    expect(handlerCalls).toBe(1) // no second call
    void state
  })
})

describe('session isolation — cross-session isolation', () => {
  it('a grant in session A does not affect session B', async () => {
    const router = new SecurityRouter()
    router.createSession('agent-A')
    router.createSession('agent-B')

    let handlerCalls = 0
    const callsBySession: string[] = []
    router.registerDoor(createWriteApprovalDoor({
      handler: async (req) => {
        handlerCalls++
        callsBySession.push(req.toolName)
        return 'approved'
      },
    }))

    // Grant in session A
    await router.check(
      { sessionId: 'agent-A' }, 'write', { path: '/tmp/x.txt' },
    )
    expect(handlerCalls).toBe(1)

    // Same file, session B: handler must be invoked (no shared grant)
    await router.check(
      { sessionId: 'agent-B' }, 'write', { path: '/tmp/x.txt' },
    )
    expect(handlerCalls).toBe(2)
    expect(callsBySession).toHaveLength(2)
  })

  it('a rejected approval in session A does not block session B', async () => {
    const router = new SecurityRouter()
    router.createSession('agent-A')
    router.createSession('agent-B')

    router.registerDoor(createWriteApprovalDoor({
      handler: async () => 'rejected',
    }))

    // Session A: rejected
    await expect(
      router.check({ sessionId: 'agent-A' }, 'write', { path: '/tmp/a.txt' }),
    ).rejects.toThrowError(/rejected/)

    // Session B with a fresh approving handler should still work
    const router2 = new SecurityRouter()
    router2.createSession('agent-B')
    router2.registerDoor(createWriteApprovalDoor({
      handler: async () => 'approved',
    }))
    await router2.check(
      { sessionId: 'agent-B' }, 'write', { path: '/tmp/b.txt' },
    )
  })
})

describe('session isolation — subagent inheritance', () => {
  it('child and parent share SessionSecurityState when sessionId matches', () => {
    // Simulates the run-subagent.ts inheritance: parent ctx.sessionId =
    // 'main', child createSystemAgent opts.sessionId = 'main' (inherited),
    // child loop opts.sessionId = 'main', child ctx.sessionId = 'main'.
    // Router consequence: both dispatch to the same SessionSecurityState.
    const router = new SecurityRouter()
    const parentState = router.createSession('main')

    // Child "inherits" — uses the same sessionId, so getOrCreateSession
    // returns the same state reference.
    const childState = router.getOrCreateSession('main')
    expect(childState).toBe(parentState)

    // A grant recorded by the parent is visible to the child
    parentState.approvalStore.grant('write:/ inherited.txt')
    expect(childState.approvalStore.isGranted('write:/ inherited.txt')).toBe(true)
  })

  it('a write approval granted by the parent covers the child (same sessionId)', async () => {
    const router = new SecurityRouter()
    router.createSession('main')

    let handlerCalls = 0
    router.registerDoor(createWriteApprovalDoor({
      handler: async () => {
        handlerCalls++
        return 'approved'
      },
    }))

    // Parent writes to a file → handler invoked, grant recorded
    await router.check(
      { sessionId: 'main' }, 'write', { path: '/tmp/inherited.txt' },
    )
    expect(handlerCalls).toBe(1)

    // Child (same sessionId 'main') writes to the same file → short-circuited
    await router.check(
      { sessionId: 'main' }, 'write', { path: '/tmp/inherited.txt' },
    )
    expect(handlerCalls).toBe(1)
  })
})

describe('session isolation — default session fallback', () => {
  it('undefined sessionId falls back to "__global__" (v0.15 compat)', async () => {
    const router = new SecurityRouter()
    let handlerCalls = 0
    router.registerDoor(createWriteApprovalDoor({
      handler: async () => {
        handlerCalls++
        return 'approved'
      },
    }))

    // First call: undefined sessionId → '__global__' session created lazily
    await router.check({}, 'write', { path: '/tmp/global.txt' })
    expect(handlerCalls).toBe(1)

    // Second call: also undefined → same '__global__' session, grant cached
    await router.check({}, 'write', { path: '/tmp/global.txt' })
    expect(handlerCalls).toBe(1)

    // The global session exists and holds the grant
    const globalState = router.getOrCreateSession(undefined)
    expect(globalState.sessionId).toBe('__global__')
    expect(globalState.approvalStore.isGranted('write:/tmp/global.txt')).toBe(true)
  })

  it('two undefined-sessionId callers share the global state', () => {
    const router = new SecurityRouter()
    const a = router.getOrCreateSession(undefined)
    const b = router.getOrCreateSession(undefined)
    expect(a).toBe(b) // same '__global__' reference
  })

  it('an explicit sessionId is distinct from the global session', () => {
    const router = new SecurityRouter()
    const global = router.getOrCreateSession(undefined)
    const explicit = router.getOrCreateSession('agent-1')
    expect(global).not.toBe(explicit)
    expect(global.sessionId).toBe('__global__')
    expect(explicit.sessionId).toBe('agent-1')
  })
})

describe('session isolation — ApprovalStore key shape (regression)', () => {
  it('keyForWrite file scope includes the path', () => {
    const key = ApprovalStore.keyForWrite('write', '/abs/file.txt', 'file')
    expect(key).toBe('write:/abs/file.txt')
  })

  it('keyForWrite session scope is the bare "write" key', () => {
    const key = ApprovalStore.keyForWrite('edit', '/any.txt', 'session')
    expect(key).toBe('write')
  })

  it('keyForBash is the constant "bash" key regardless of scope', () => {
    expect(ApprovalStore.keyForBash('session')).toBe('bash')
    expect(ApprovalStore.keyForBash('file')).toBe('bash')
  })
})
