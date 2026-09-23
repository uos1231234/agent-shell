// search-replace.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep, dirname } from 'node:path'
import { searchReplace } from '../../../src/im/tools/search-replace.js'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-shell-sr-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

const write = (name: string, content: string): string => {
  const p = join(cwd, name)
  const dir = dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(p, content)
  return p
}

describe('searchReplace', () => {
  it('replaces literal text in a single file', async () => {
    const p = write('a.txt', 'foo bar foo\n')
    const res = await searchReplace({ pattern: 'foo', replacement: 'baz', path: cwd })
    expect(readFileSync(p, 'utf8')).toBe('baz bar baz\n')
    expect(res.filesChanged).toBe(1)
    expect(res.changes[0]).toEqual({ file: p, count: 2 })
  })

  it('replaces literal text across multiple files', async () => {
    const p1 = write('a.txt', 'foo\n')
    const p2 = write('b.txt', 'foo foo\n')
    const res = await searchReplace({ pattern: 'foo', replacement: 'qux', path: cwd })
    expect(readFileSync(p1, 'utf8')).toBe('qux\n')
    expect(readFileSync(p2, 'utf8')).toBe('qux qux\n')
    expect(res.filesChanged).toBe(2)
  })

  it('replaces with regex and supports capture groups', async () => {
    const p = write('a.txt', 'name=alice\nname=bob\n')
    const res = await searchReplace({
      pattern: 'name=(\\w+)',
      replacement: 'user[$1]',
      path: cwd,
      regex: true,
    })
    expect(readFileSync(p, 'utf8')).toBe('user[alice]\nuser[bob]\n')
    expect(res.changes[0]!.count).toBe(2)
  })

  it('filters files by glob pattern', async () => {
    write('a.ts', 'old\n')
    write('b.js', 'old\n')
    write('c.ts', 'old\n')
    const res = await searchReplace({
      pattern: 'old',
      replacement: 'new',
      glob: '**/*.ts',
      path: cwd,
    })
    expect(res.filesChanged).toBe(2)
    const changed = res.changes.map(c => c.file).sort()
    expect(changed).toEqual([join(cwd, 'a.ts'), join(cwd, 'c.ts')].sort())
  })

  it('respects .gitignore — ignored files are not changed', async () => {
    writeFileSync(join(cwd, '.gitignore'), 'ignored.txt\n')
    const ignored = write('ignored.txt', 'secret\n')
    const visible = write('visible.txt', 'secret\n')
    const res = await searchReplace({
      pattern: 'secret',
      replacement: 'public',
      path: cwd,
    })
    expect(readFileSync(ignored, 'utf8')).toBe('secret\n')
    expect(readFileSync(visible, 'utf8')).toBe('public\n')
    expect(res.filesChanged).toBe(1)
  })

  it('does not descend into .git directory', async () => {
    mkdirSync(join(cwd, '.git'), { recursive: true })
    writeFileSync(join(cwd, '.git', 'config'), 'foo\n')
    const p = write('real.txt', 'foo\n')
    const res = await searchReplace({ pattern: 'foo', replacement: 'bar', path: cwd })
    expect(readFileSync(join(cwd, '.git', 'config'), 'utf8')).toBe('foo\n')
    expect(readFileSync(p, 'utf8')).toBe('bar\n')
    expect(res.filesChanged).toBe(1)
  })

  it('truncates at limit', async () => {
    for (let i = 0; i < 5; i++) {
      write(`f${i}.txt`, 'target\n')
    }
    const res = await searchReplace({
      pattern: 'target',
      replacement: 'done',
      path: cwd,
      limit: 2,
    })
    expect(res.filesChanged).toBe(2)
    expect(res.changes).toHaveLength(2)
  })

  it('returns filesChanged 0 when no content changes', async () => {
    write('a.txt', 'nothing here\n')
    const res = await searchReplace({ pattern: 'nope', replacement: 'yes', path: cwd })
    expect(res.filesChanged).toBe(0)
    expect(res.changes).toEqual([])
  })

  it('throws on empty pattern', async () => {
    await expect(searchReplace({ pattern: '', replacement: 'x', path: cwd }))
      .rejects.toThrow(/pattern must not be empty/i)
  })

  it('throws on invalid regex', async () => {
    await expect(searchReplace({ pattern: '(unclosed', replacement: 'x', path: cwd, regex: true }))
      .rejects.toThrow(/invalid regex/i)
  })

  it('throws on non-positive limit', async () => {
    await expect(searchReplace({ pattern: 'x', replacement: 'y', path: cwd, limit: 0 }))
      .rejects.toThrow(/limit must be a positive integer/i)
  })

  it('handles nested directories with glob', async () => {
    const p1 = write('src/a.ts', 'old\n')
    const p2 = write('src/sub/b.ts', 'old\n')
    write('src/c.js', 'old\n')
    const res = await searchReplace({
      pattern: 'old',
      replacement: 'new',
      glob: '**/*.ts',
      path: cwd,
    })
    expect(res.filesChanged).toBe(2)
    expect(readFileSync(p1, 'utf8')).toBe('new\n')
    expect(readFileSync(p2, 'utf8')).toBe('new\n')
  })
})
