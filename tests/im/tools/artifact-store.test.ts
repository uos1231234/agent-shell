// artifact-store.test.ts
import { describe, it, expect } from 'vitest'
import { ArtifactStore } from '../../../src/im/tools/artifact-store.js'

describe('ArtifactStore', () => {
  it('put returns an id and get returns the full content', () => {
    const s = new ArtifactStore()
    const id = s.put('hello world')
    expect(id).toHaveLength(16)
    expect(s.get(id)).toBe('hello world')
  })

  it('put is idempotent (same content → same id)', () => {
    const s = new ArtifactStore()
    const id1 = s.put('same content')
    const id2 = s.put('same content')
    expect(id1).toBe(id2)
  })

  it('get with offset slices by character', () => {
    const s = new ArtifactStore()
    const id = s.put('abcdef')
    expect(s.get(id, 2)).toBe('cdef')
  })

  it('get with offset and limit slices a range', () => {
    const s = new ArtifactStore()
    const id = s.put('abcdef')
    expect(s.get(id, 1, 3)).toBe('bcd')
  })

  it('get does not split CJK mid-codepoint (character slice not byte)', () => {
    const s = new ArtifactStore()
    const text = '你好世界测试'
    const id = s.put(text)
    expect(s.get(id, 2, 2)).toBe('世界')
  })

  it('get with offset beyond length returns empty string', () => {
    const s = new ArtifactStore()
    const id = s.put('abc')
    expect(s.get(id, 10)).toBe('')
  })

  it('get with limit 0 returns empty string', () => {
    const s = new ArtifactStore()
    const id = s.put('abc')
    expect(s.get(id, 0, 0)).toBe('')
  })

  it('get missing id throws clean error', () => {
    const s = new ArtifactStore()
    expect(() => s.get('deadbeefdeadbeef')).toThrow(/artifact not found/)
  })

  it('get with negative offset throws', () => {
    const s = new ArtifactStore()
    const id = s.put('abc')
    expect(() => s.get(id, -1)).toThrow(/offset must be non-negative/)
  })

  it('get with negative limit throws', () => {
    const s = new ArtifactStore()
    const id = s.put('abc')
    expect(() => s.get(id, 0, -5)).toThrow(/limit must be non-negative/)
  })
})
