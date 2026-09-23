// glob.test.ts
import { describe, it, expect } from 'vitest'
import { matchGlob } from '../../../src/im/tools/glob.js'

describe('matchGlob', () => {
  describe('literal patterns', () => {
    it('exact filename match', () => {
      expect(matchGlob('foo.ts', 'foo.ts')).toBe(true)
      expect(matchGlob('foo.ts', 'bar.ts')).toBe(false)
    })

    it('does not interpret regex meta in literal patterns', () => {
      expect(matchGlob('foo.ts', 'foo.ts')).toBe(true)
      expect(matchGlob('foo+bar.ts', 'foo+bar.ts')).toBe(true)
    })
  })

  describe('* wildcard', () => {
    it('matches anything within a single path segment', () => {
      expect(matchGlob('*.ts', 'foo.ts')).toBe(true)
      expect(matchGlob('*.ts', 'foo.js')).toBe(false)
      expect(matchGlob('*.ts', 'main.test.ts')).toBe(true)
    })

    it('does not cross path separators', () => {
      expect(matchGlob('src/*.ts', 'src/foo.ts')).toBe(true)
      expect(matchGlob('src/*.ts', 'src/sub/foo.ts')).toBe(false)
    })

    it('matches empty segment', () => {
      expect(matchGlob('*.ts', '.ts')).toBe(true)
    })
  })

  describe('** wildcard', () => {
    it('matches zero or more path segments', () => {
      expect(matchGlob('**/*.ts', 'foo.ts')).toBe(true)
      expect(matchGlob('**/*.ts', 'src/foo.ts')).toBe(true)
      expect(matchGlob('**/*.ts', 'src/sub/foo.ts')).toBe(true)
      expect(matchGlob('**/*.ts', 'src/sub/deep/foo.ts')).toBe(true)
    })

    it('matches a bare **', () => {
      expect(matchGlob('**', 'foo.ts')).toBe(true)
      expect(matchGlob('**', 'src/foo.ts')).toBe(true)
    })

    it('matches ** at the start', () => {
      expect(matchGlob('src/**/foo.ts', 'src/foo.ts')).toBe(true)
      expect(matchGlob('src/**/foo.ts', 'src/a/foo.ts')).toBe(true)
      expect(matchGlob('src/**/foo.ts', 'src/a/b/c/foo.ts')).toBe(true)
      expect(matchGlob('src/**/foo.ts', 'lib/foo.ts')).toBe(false)
    })
  })

  describe('? wildcard', () => {
    it('matches exactly one character in a segment', () => {
      expect(matchGlob('?.ts', 'a.ts')).toBe(true)
      expect(matchGlob('?.ts', 'ab.ts')).toBe(false)
      expect(matchGlob('?.ts', '.ts')).toBe(false)
    })
  })

  describe('mixed wildcards', () => {
    it('combines * and ** in one pattern', () => {
      expect(matchGlob('src/**/test/*.ts', 'src/a/test/foo.ts')).toBe(true)
      expect(matchGlob('src/**/test/*.ts', 'src/a/b/test/foo.ts')).toBe(true)
      expect(matchGlob('src/**/test/*.ts', 'src/foo.ts')).toBe(false)
    })

    it('? mixed with *', () => {
      expect(matchGlob('?.?.ts', 'a.b.ts')).toBe(true)
      expect(matchGlob('?.?.ts', 'ab.ts')).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('handles trailing slashes in pattern by treating as **', () => {
      expect(matchGlob('src/', 'src/foo.ts')).toBe(true)
    })

    it('handles empty string as matching empty', () => {
      expect(matchGlob('', '')).toBe(true)
    })

    it('handles Windows-style path separators in input', () => {
      expect(matchGlob('src/*.ts', 'src\\foo.ts')).toBe(false)
    })
  })
})
