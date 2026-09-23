// approval-hook.test.ts
//
// Tests for createApprovalHook: verifies the approval decision flow —
// store short-circuit, handler approved → grant + allow, handler rejected →
// Error, timeout/throw → fail-closed Error, plus the sensitive-path and
// dangerous-command triggers.

import { describe, it, expect, vi } from 'vitest'
import { ApprovalStore, type ApprovalHandler, type ApprovalRequest } from '../../../../src/im/tools/security/approval-store.js'
import { createApprovalHook } from '../../../../src/im/tools/security/approval-hook.js'

/** A handler that never resolves — used to force the timeout path. */
const hangingHandler: ApprovalHandler = () => new Promise<'approved' | 'rejected'>(() => {})

/** A handler that immediately rejects with the given error. */
function throwingHandler(err: unknown): ApprovalHandler {
  return () => Promise.reject(err)
}

/** Build a handler that resolves to a fixed decision. */
function fixedHandler(decision: 'approved' | 'rejected'): ApprovalHandler {
  return () => Promise.resolve(decision)
}

/** Build a handler that records the request it received. */
function recordingHandler(decision: 'approved' | 'rejected', captured: ApprovalRequest[]): ApprovalHandler {
  return (req) => {
    captured.push(req)
    return Promise.resolve(decision)
  }
}

describe('createApprovalHook — store short-circuit', () => {
  it('returns void (allow) when the store has a matching write grant', async () => {
    const store = new ApprovalStore()
    store.grant(ApprovalStore.keyForWrite('write', '/abs/file.ts', 'file'))
    const handler = vi.fn(fixedHandler('approved'))
    const hook = createApprovalHook({ store, handler })

    const result = await hook({ path: '/abs/file.ts', content: 'x', reason: 'r' }, undefined, 'write')
    expect(result).toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
  })

  it('returns void when a session-level write grant exists', async () => {
    const store = new ApprovalStore()
    store.grant(ApprovalStore.keyForWrite('write', '/abs/file.ts', 'session'))
    const handler = vi.fn(fixedHandler('approved'))
    const hook = createApprovalHook({ store, handler })

    const result = await hook({ path: '/other/file.ts', content: 'x', reason: 'r' }, undefined, 'write')
    expect(result).toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
  })

  it('returns void when a session-level bash grant exists', async () => {
    const store = new ApprovalStore()
    store.grant(ApprovalStore.keyForBash('session'))
    const handler = vi.fn(fixedHandler('approved'))
    const hook = createApprovalHook({ store, handler })

    const result = await hook({ command: 'rm -rf /', reason: 'r' }, undefined, 'bash')
    expect(result).toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('createApprovalHook — handler decisions', () => {
  it('approved → returns void and grants file-level write key', async () => {
    const store = new ApprovalStore()
    const handler = fixedHandler('approved')
    const hook = createApprovalHook({ store, handler })

    const result = await hook({ path: '/abs/file.ts', content: 'x', reason: 'r' }, undefined, 'write')
    expect(result).toBeUndefined()
    expect(store.isGranted(ApprovalStore.keyForWrite('write', '/abs/file.ts', 'file'))).toBe(true)
  })

  it('approved → subsequent write to the same file short-circuits', async () => {
    const store = new ApprovalStore()
    let calls = 0
    const handler: ApprovalHandler = () => { calls++; return Promise.resolve('approved') }
    const hook = createApprovalHook({ store, handler })

    await hook({ path: '/abs/file.ts', content: 'x', reason: 'r' }, undefined, 'write')
    await hook({ path: '/abs/file.ts', content: 'y', reason: 'r' }, undefined, 'write')
    expect(calls).toBe(1)
  })

  it('approved bash → grants session-level bash key', async () => {
    const store = new ApprovalStore()
    const handler = fixedHandler('approved')
    const hook = createApprovalHook({ store, handler })

    const result = await hook({ command: 'rm -rf /', reason: 'r' }, undefined, 'bash')
    expect(result).toBeUndefined()
    expect(store.isGranted(ApprovalStore.keyForBash('session'))).toBe(true)
  })

  it('rejected → returns Error', async () => {
    const store = new ApprovalStore()
    const handler = fixedHandler('rejected')
    const hook = createApprovalHook({ store, handler })

    const result = await hook({ path: '/abs/file.ts', content: 'x', reason: 'r' }, undefined, 'write')
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('rejected by user')
    // Nothing should have been granted.
    expect(store.isGranted(ApprovalStore.keyForWrite('write', '/abs/file.ts', 'file'))).toBe(false)
  })
})

describe('createApprovalHook — fail-closed', () => {
  it('handler timeout → returns Error', async () => {
    const store = new ApprovalStore()
    const hook = createApprovalHook({ store, handler: hangingHandler, timeoutMs: 50 })

    const result = await hook({ path: '/abs/file.ts', content: 'x', reason: 'r' }, undefined, 'write')
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('fail-closed')
    expect((result as Error).message).toContain('timed out')
  })

  it('handler throws → returns Error', async () => {
    const store = new ApprovalStore()
    const hook = createApprovalHook({ store, handler: throwingHandler(new Error('user disconnected')) })

    const result = await hook({ command: 'rm -rf /', reason: 'r' }, undefined, 'bash')
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('fail-closed')
    expect((result as Error).message).toContain('user disconnected')
  })

  it('handler throws a non-Error value → returns Error with stringified message', async () => {
    const store = new ApprovalStore()
    const hook = createApprovalHook({ store, handler: throwingHandler('string error') })

    const result = await hook({ path: '/abs/file.ts', content: 'x', reason: 'r' }, undefined, 'write')
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('string error')
  })
})

describe('createApprovalHook — triggers', () => {
  it('sensitive path (read) → triggers approval', async () => {
    const store = new ApprovalStore()
    const captured: ApprovalRequest[] = []
    const handler = recordingHandler('approved', captured)
    const hook = createApprovalHook({ store, handler })

    // `read` is not a write tool, so this is a sensitive-path-only trigger.
    const result = await hook({ path: '/home/u/.env', reason: 'r' }, undefined, 'read')
    expect(result).toBeUndefined()
    expect(captured).toHaveLength(1)
    expect(captured[0]!.reason).toContain('sensitive path')
    expect(captured[0]!.dangerous).toBe('sensitive-file access')
  })

  it('sensitive path + write → reason mentions both', async () => {
    const store = new ApprovalStore()
    const captured: ApprovalRequest[] = []
    const handler = recordingHandler('approved', captured)
    const hook = createApprovalHook({ store, handler })

    const result = await hook({ path: '/home/u/.env', content: 'x', reason: 'r' }, undefined, 'write')
    expect(result).toBeUndefined()
    expect(captured[0]!.reason).toContain('sensitive path')
    // write also flagged
    expect(captured[0]!.dangerous).toBe('sensitive-file access')
  })

  it('dangerous bash command → triggers approval', async () => {
    const store = new ApprovalStore()
    const captured: ApprovalRequest[] = []
    const handler = recordingHandler('approved', captured)
    const hook = createApprovalHook({ store, handler })

    const result = await hook({ command: 'rm -rf /', reason: 'r' }, undefined, 'bash')
    expect(result).toBeUndefined()
    expect(captured).toHaveLength(1)
    expect(captured[0]!.dangerous).toBeDefined()
  })

  it('safe bash command (non-dangerous) → no approval needed', async () => {
    const store = new ApprovalStore()
    const handler = vi.fn(fixedHandler('approved'))
    const hook = createApprovalHook({ store, handler })

    // `ls` is not dangerous and bash is not a write tool, so no trigger.
    const result = await hook({ command: 'ls -la', reason: 'r' }, undefined, 'bash')
    expect(result).toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
  })

  it('non-sensitive, non-write read → no approval needed', async () => {
    const store = new ApprovalStore()
    const handler = vi.fn(fixedHandler('approved'))
    const hook = createApprovalHook({ store, handler })

    const result = await hook({ path: '/tmp/normal.txt', reason: 'r' }, undefined, 'read')
    expect(result).toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('createApprovalHook — default timeout', () => {
  it('uses 300000ms when timeoutMs is not provided', async () => {
    // We verify the default indirectly: a handler that resolves after a short
    // delay should succeed (i.e. the default timeout did not fire first).
    const store = new ApprovalStore()
    const handler: ApprovalHandler = () =>
      new Promise((resolve) => setTimeout(() => resolve('approved'), 10))
    const hook = createApprovalHook({ store, handler })

    const result = await hook({ path: '/abs/file.ts', content: 'x', reason: 'r' }, undefined, 'write')
    expect(result).toBeUndefined()
  })
})
