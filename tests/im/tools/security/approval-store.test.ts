// approval-store.test.ts
//
// Tests for ApprovalStore: grant lifecycle (isGranted / grant / revoke) and
// the static key builders (keyForWrite / keyForBash) that produce the
// deterministic strings the store is keyed by.

import { describe, it, expect } from 'vitest'
import { ApprovalStore } from '../../../../src/im/tools/security/approval-store.js'

describe('ApprovalStore — grant lifecycle', () => {
  it('isGranted is false before grant', () => {
    const store = new ApprovalStore()
    expect(store.isGranted('write:/tmp/foo')).toBe(false)
  })

  it('grant makes isGranted true', () => {
    const store = new ApprovalStore()
    store.grant('write:/tmp/foo')
    expect(store.isGranted('write:/tmp/foo')).toBe(true)
  })

  it('revoke returns isGranted to false', () => {
    const store = new ApprovalStore()
    store.grant('write:/tmp/foo')
    store.revoke('write:/tmp/foo')
    expect(store.isGranted('write:/tmp/foo')).toBe(false)
  })

  it('revoke on an ungranted key is a no-op', () => {
    const store = new ApprovalStore()
    expect(() => store.revoke('never-granted')).not.toThrow()
    expect(store.isGranted('never-granted')).toBe(false)
  })

  it('grants are independent per key', () => {
    const store = new ApprovalStore()
    store.grant('write:/tmp/a')
    store.grant('write:/tmp/b')
    expect(store.isGranted('write:/tmp/a')).toBe(true)
    expect(store.isGranted('write:/tmp/b')).toBe(true)
    store.revoke('write:/tmp/a')
    expect(store.isGranted('write:/tmp/a')).toBe(false)
    expect(store.isGranted('write:/tmp/b')).toBe(true)
  })
})

describe('ApprovalStore.keyForWrite', () => {
  it('file scope → write:/abs/path', () => {
    expect(ApprovalStore.keyForWrite('write', '/abs/path/file.ts', 'file')).toBe('write:/abs/path/file.ts')
  })

  it('session scope → write (covers all writes)', () => {
    expect(ApprovalStore.keyForWrite('write', '/abs/path/file.ts', 'session')).toBe('write')
  })

  it('edit tool shares the write namespace', () => {
    // write and edit both mutate the filesystem; a grant for one covers the other.
    expect(ApprovalStore.keyForWrite('edit', '/abs/path/file.ts', 'file')).toBe('write:/abs/path/file.ts')
    expect(ApprovalStore.keyForWrite('edit', '/abs/path/file.ts', 'session')).toBe('write')
  })

  it('keys are stable across calls with the same inputs', () => {
    const k1 = ApprovalStore.keyForWrite('write', '/x/y', 'file')
    const k2 = ApprovalStore.keyForWrite('write', '/x/y', 'file')
    expect(k1).toBe(k2)
  })
})

describe('ApprovalStore.keyForBash', () => {
  it('session scope → bash', () => {
    expect(ApprovalStore.keyForBash('session')).toBe('bash')
  })

  it('returns the same session key regardless of scope argument', () => {
    // per-command scope is intentionally unsupported; the store key is always 'bash'.
    expect(ApprovalStore.keyForBash('file')).toBe('bash')
    expect(ApprovalStore.keyForBash('session')).toBe('bash')
  })
})

describe('ApprovalStore.isGrantedForPath (directory-scope prefix match, H8)', () => {
  it('exact file path matches', () => {
    const store = new ApprovalStore()
    store.grant('write:/project/foo.ts')
    expect(store.isGrantedForPath('/project/foo.ts')).toBe(true)
  })

  it('a directory grant covers files under it', () => {
    const store = new ApprovalStore()
    store.grant('write:/project')
    expect(store.isGrantedForPath('/project/foo.ts')).toBe(true)
    expect(store.isGrantedForPath('/project/src/index.ts')).toBe(true)
    // The directory itself still matches exactly.
    expect(store.isGrantedForPath('/project')).toBe(true)
  })

  it('does NOT leak across path boundaries', () => {
    const store = new ApprovalStore()
    store.grant('write:/project')
    // Sibling with a shared prefix must NOT match.
    expect(store.isGrantedForPath('/project2/bar.ts')).toBe(false)
    expect(store.isGrantedForPath('/projectx')).toBe(false)
  })

  it('ignores session-scope keys and unrelated keys', () => {
    const store = new ApprovalStore()
    store.grant('write')            // session grant — not a path grant
    store.grant('bash')             // unrelated
    expect(store.isGrantedForPath('/project/foo.ts')).toBe(false)
  })

  it('is case-insensitive-free (exact string semantics, Windows separators normalized)', () => {
    const store = new ApprovalStore()
    store.grant('write:/project')
    expect(store.isGrantedForPath('\\project\\src\\index.ts')).toBe(true)
  })
})
