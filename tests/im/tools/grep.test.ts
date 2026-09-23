// grep.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grepFiles } from '../../../src/im/tools/grep.js'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-shell-grep-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

const write = (rel: string, content: string): string => {
  const abs = join(cwd, rel)
  const { dirname } = require('node:path') as { dirname: (p: string) => string }
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

describe('grepFiles', () => {
  it('finds matches with file:line:content format', async () => {
    write('a.txt', 'hello\nworld\nhello again\n')
    const out = await grepFiles({ pattern: 'hello', path: cwd })
    expect(out).toBe('a.txt:1:hello\na.txt:3:hello again')
  })

  it('respects ignoreCase', async () => {
    write('a.txt', 'Hello\nhello\nHELLO\n')
    const out = await grepFiles({ pattern: 'hello', path: cwd, ignoreCase: true })
    const lines = out.split('\n').filter(Boolean)
    expect(lines.length).toBe(3)
  })

  it('respects context (lines before and after)', async () => {
    write('a.txt', 'line1\nline2\nMATCH\nline4\nline5\n')
    const out = await grepFiles({ pattern: 'MATCH', path: cwd, context: 1 })
    expect(out).toContain('line2')
    expect(out).toContain('MATCH')
    expect(out).toContain('line4')
    expect(out).not.toContain('line1')
  })

  it('literal mode treats pattern as fixed string', async () => {
    write('a.txt', 'a.b\naxb\n')
    const out = await grepFiles({ pattern: 'a.b', path: cwd, literal: true })
    expect(out).toContain('a.b')
    expect(out).not.toContain('axb')
  })

  it('respects limit', async () => {
    let body = ''
    for (let i = 0; i < 50; i += 1) body += `match ${i}\n`
    write('a.txt', body)
    const out = await grepFiles({ pattern: 'match', path: cwd, limit: 5 })
    const lines = out.split('\n').filter(Boolean)
    expect(lines.length).toBe(5)
  })

  it('respects glob filter', async () => {
    write('a.ts', 'foo\n')
    write('b.js', 'foo\n')
    const out = await grepFiles({ pattern: 'foo', path: cwd, glob: '*.ts' })
    expect(out).toContain('a.ts')
    expect(out).not.toContain('b.js')
  })

  it('handles a non-existent path gracefully', async () => {
    const out = await grepFiles({ pattern: 'x', path: join(cwd, 'nope') })
    expect(out).toBe('')
  })
})
