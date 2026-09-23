// ast-grep.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import cp from 'node:child_process'

// Capture the ORIGINAL execFileSync BEFORE any mocking. This is the real
// function that spawns processes — we need it to restore later.
const originalExecFileSync = cp.execFileSync

// Mock child_process BEFORE importing the module under test so the imported
// execFileSync binding picks up the mock. (vi.spyOn on the require'd module
// object does not affect ES module imports — they capture the original.)
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: vi.fn(),
    spawnSync: actual.spawnSync,
  }
})

import { astGrep, isAstGrepAvailable, resolveAstGrep, AstGrepNotFoundError } from '../../../src/im/tools/ast-grep.js'
import { execFileSync } from 'node:child_process'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-shell-astgrep-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
  vi.mocked(execFileSync).mockImplementation(originalExecFileSync)
})

const write = (rel: string, content: string): string => {
  const abs = join(cwd, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

describe('astGrep — binary resolution', () => {
  it('throws AstGrepNotFoundError with install instructions when binary missing', () => {
    // Mock execFileSync to throw (simulates "where" / "which" failing)
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('not found')
    })
    expect(() => resolveAstGrep()).toThrow(AstGrepNotFoundError)
    try {
      resolveAstGrep()
    } catch (e) {
      expect(e).toBeInstanceOf(AstGrepNotFoundError)
      const msg = (e as Error).message
      expect(msg).toContain('ast-grep is required')
      expect(msg).toContain('cargo install ast-grep')
      expect(msg).toContain('scoop install ast-grep')
      expect(msg).toContain('https://ast-grep.github.io')
    }
  })

  it('isAstGrepAvailable returns boolean without throwing', () => {
    // Restore the mock so the real binary can be found
    vi.mocked(execFileSync).mockImplementation(originalExecFileSync)
    expect(typeof isAstGrepAvailable()).toBe('boolean')
  })
})

describe('astGrep — real execution', () => {
  // Restore the mock for real-execution tests
  beforeEach(() => {
    vi.mocked(execFileSync).mockImplementation(originalExecFileSync)
  })

  it('binary is available', () => {
    expect(isAstGrepAvailable()).toBe(true)
  })

  describe('pattern matching', () => {
    it('matches console.log($$$) calls in TS file', async () => {
      write('test.ts', 'console.log("hello")\nconsole.log(123)\nconst x = 1\n')
      const out = await astGrep({
        pattern: 'console.log($$$)',
        path: cwd,
        lang: 'typescript',
      })
      expect(out).toContain('test.ts')
      expect(out).toContain('console.log')
      const lines = out.split('\n').filter(Boolean)
      expect(lines.length).toBe(2)
    })

    it('formats output as path:line:content', async () => {
      write('sample.ts', 'console.log("first")\n')
      const out = await astGrep({
        pattern: 'console.log($$$)',
        path: cwd,
        lang: 'typescript',
      })
      expect(out).toMatch(/sample\.ts:1:.*console\.log/)
    })

    it('returns empty string when no matches', async () => {
      write('nomatch.ts', 'const x = 1\n')
      const out = await astGrep({
        pattern: 'console.log($$$)',
        path: cwd,
        lang: 'typescript',
      })
      expect(out).toBe('')
    })

    it('respects limit and shows truncation note', async () => {
      let body = ''
      for (let i = 0; i < 20; i += 1) {
        body += `console.log(${i})\n`
      }
      write('many.ts', body)
      const out = await astGrep({
        pattern: 'console.log($$$)',
        path: cwd,
        lang: 'typescript',
        limit: 5,
      })
      const lines = out.split('\n').filter(Boolean)
      expect(lines.length).toBe(6)
      expect(out).toContain('truncated')
    })

    it('works on a single file path (not just directories)', async () => {
      const filePath = write('single.ts', 'console.log(42)\n')
      const out = await astGrep({
        pattern: 'console.log($$$)',
        path: filePath,
        lang: 'typescript',
      })
      expect(out).toContain('console.log')
    })

    it('infers language from extension when lang omitted', async () => {
      write('auto.ts', 'console.log("auto")\n')
      const out = await astGrep({
        pattern: 'console.log($$$)',
        path: cwd,
      })
      expect(out).toContain('console.log')
    })
  })
})

describe('astGrep — error handling', () => {
  it('throws clean error with install instructions when binary missing', async () => {
    // Mock execFileSync so resolveAstGrep fails
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('not found')
    })
    write('dummy.ts', 'console.log(1)\n')

    await expect(
      astGrep({ pattern: 'console.log($$$)', path: cwd, lang: 'typescript' }),
    ).rejects.toThrow('ast_grep:')
  })

  it('throws on non-existent path (when binary is available)', async () => {
    // Restore the mock so the binary is available
    vi.mocked(execFileSync).mockImplementation(originalExecFileSync)
    const missingPath = join(cwd, 'does-not-exist')
    await expect(
      astGrep({ pattern: 'console.log($$$)', path: missingPath, lang: 'typescript' }),
    ).rejects.toThrow('ast_grep: path not found')
  })
})
