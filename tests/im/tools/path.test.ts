// path.test.ts
//
// The `path` module gives us:
//   - resolvePath(cwd, input): resolve a possibly-relative path to an absolute path,
//     rejecting paths that escape the cwd.
//   - loadGitignore(cwd): parse .gitignore into a list of ignore patterns.
//   - isIgnored(relPath, isDir, patterns): check if a path matches any pattern.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePath, resolvePathForRead, loadGitignore, isIgnored, parseGitignoreLine, notFoundHint } from '../../../src/im/tools/path.js'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-shell-path-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('resolvePath', () => {
  it('returns absolute path unchanged when inside cwd', () => {
    const abs = join(cwd, 'foo.txt')
    writeFileSync(abs, '')  // v0.15: resolvePath now checks existence
    expect(resolvePath(cwd, abs)).toBe(abs)
  })

  it('resolves a relative path against cwd', () => {
    writeFileSync(join(cwd, 'foo.txt'), '')
    expect(resolvePath(cwd, 'foo.txt')).toBe(join(cwd, 'foo.txt'))
  })

  it('normalizes path separators', () => {
    mkdirSync(join(cwd, 'a', 'b'), { recursive: true })
    writeFileSync(join(cwd, 'a', 'b', 'c.txt'), '')
    expect(resolvePath(cwd, 'a/b/c.txt')).toBe(join(cwd, 'a', 'b', 'c.txt'))
  })

  it('rejects paths that escape cwd via ..', () => {
    expect(() => resolvePath(cwd, '../escape.txt')).toThrow(/escape/i)
  })

  it('rejects absolute paths outside cwd', () => {
    expect(() => resolvePath(cwd, 'C:\\Windows\\System32\\cmd.exe')).toThrow()
  })

  it('resolvePathForRead throws with not-found hint when path does not exist', () => {
    expect(() => resolvePathForRead(cwd, 'nonexistent.txt')).toThrow(/Path not found/)
    expect(() => resolvePathForRead(cwd, 'nonexistent.txt')).toThrow(/Nearest existing directory/)
  })

  it('resolvePath does NOT check existence (for write tool)', () => {
    // resolvePath should succeed even if the file doesn't exist — write creates it
    expect(resolvePath(cwd, 'new-file.txt')).toBe(join(cwd, 'new-file.txt'))
  })
})

describe('notFoundHint', () => {
  it('returns empty string when no ancestor exists', () => {
    expect(notFoundHint('/nonexistent/path/that/does/not/exist/anywhere')).toBe('')
  })

  it('lists entries of nearest existing ancestor', () => {
    const hint = notFoundHint(join(cwd, 'nonexistent', 'file.txt'))
    expect(hint).toContain('Nearest existing directory')
    expect(hint).toContain(cwd)
  })

  it('skips build/VCS/cache directories', () => {
    // cwd is a temp dir — create a SKIP_DIRS entry and verify it's excluded
    mkdirSync(join(cwd, 'node_modules'), { recursive: true })
    const hint = notFoundHint(join(cwd, 'nonexistent'))
    expect(hint).not.toContain('node_modules')
  })

  it('truncates at HINT_MAX_ENTRIES', () => {
    // Create 50 files — hint should cap at 40
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(cwd, `file${String(i).padStart(3, '0')}.txt`), '')
    }
    const hint = notFoundHint(join(cwd, 'nonexistent'))
    expect(hint).toContain('more')
  })
})

describe('parseGitignoreLine', () => {
  it('skips blank lines and comments', () => {
    expect(parseGitignoreLine('')).toBeNull()
    expect(parseGitignoreLine('  ')).toBeNull()
    expect(parseGitignoreLine('# comment')).toBeNull()
  })

  it('parses a simple filename pattern', () => {
    const p = parseGitignoreLine('node_modules')
    expect(p).toEqual({ pattern: 'node_modules', dirOnly: false, negate: false, anchored: false })
  })

  it('detects directory-only patterns (trailing /)', () => {
    const p = parseGitignoreLine('build/')
    expect(p).toEqual({ pattern: 'build', dirOnly: true, negate: false, anchored: false })
  })

  it('detects negation (!)', () => {
    const p = parseGitignoreLine('!keep.md')
    expect(p).toEqual({ pattern: 'keep.md', dirOnly: false, negate: true, anchored: false })
  })

  it('detects anchored patterns (leading /)', () => {
    const p = parseGitignoreLine('/dist')
    expect(p).toEqual({ pattern: 'dist', dirOnly: false, negate: false, anchored: true })
  })
})

describe('loadGitignore', () => {
  it('returns empty array when .gitignore does not exist', () => {
    expect(loadGitignore(cwd)).toEqual([])
  })

  it('parses .gitignore file lines', () => {
    writeFileSync(join(cwd, '.gitignore'), [
      'node_modules',
      'build/',
      '# comment',
      '',
      '*.log',
    ].join('\n'))
    const patterns = loadGitignore(cwd)
    expect(patterns).toHaveLength(3)
    expect(patterns.map(p => p.pattern)).toEqual(['node_modules', 'build', '*.log'])
  })
})

describe('isIgnored', () => {
  it('matches a simple filename pattern anywhere in the path', () => {
    const patterns = loadGitignore(makeGitignore('node_modules'))
    expect(isIgnored('node_modules', true, patterns)).toBe(true)
    expect(isIgnored('src/node_modules', true, patterns)).toBe(true)
    expect(isIgnored('node_modules.txt', false, patterns)).toBe(false)
  })

  it('respects dir-only flag', () => {
    const patterns = loadGitignore(makeGitignore('build/'))
    expect(isIgnored('build', true, patterns)).toBe(true)
    expect(isIgnored('build', false, patterns)).toBe(false)
  })

  it('respects anchored flag (matches from root only)', () => {
    const patterns = loadGitignore(makeGitignore('/dist'))
    expect(isIgnored('dist', true, patterns)).toBe(true)
    expect(isIgnored('a/dist', true, patterns)).toBe(false)
  })

  it('respects negation', () => {
    const patterns = loadGitignore(makeGitignore(['*.log', '!important.log']))
    expect(isIgnored('a.log', false, patterns)).toBe(true)
    expect(isIgnored('important.log', false, patterns)).toBe(false)
  })

  function makeGitignore(content: string | string[]): string {
    const lines = Array.isArray(content) ? content.join('\n') : content
    writeFileSync(join(cwd, '.gitignore'), lines)
    return cwd
  }
})

// Suppress unused-import warning when tests above are the only consumers.
void mkdirSync
