// edit.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { editFile } from '../../../src/im/tools/edit.js'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-shell-edit-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

const write = (name: string, content: string): string => {
  const p = join(cwd, name)
  writeFileSync(p, content)
  return p
}

describe('editFile', () => {
  it('replaces a unique occurrence with new text', async () => {
    const p = write('a.txt', 'hello world\nbye world\n')
    const out = await editFile({ path: p, edits: [{ oldText: 'hello', newText: 'goodbye' }] })
    expect(readFileSync(p, 'utf8')).toBe('goodbye world\nbye world\n')
    expect(out).toContain('1 replacement')
  })

  it('rejects when oldText is not found', async () => {
    const p = write('a.txt', 'hello\n')
    await expect(editFile({ path: p, edits: [{ oldText: 'nope', newText: 'x' }] }))
      .rejects.toThrow(/not found|0 occurrences/i)
  })

  it('rejects when oldText matches more than once (strict uniqueness)', async () => {
    const p = write('a.txt', 'foo\nfoo\n')
    await expect(editFile({ path: p, edits: [{ oldText: 'foo', newText: 'bar' }] }))
      .rejects.toThrow(/2 occurrences|not unique/i)
  })

  it('applies multiple edits atomically against the original file', async () => {
    const p = write('a.txt', 'a=1\nb=2\nc=3\n')
    const out = await editFile({
      path: p,
      edits: [
        { oldText: 'a=1', newText: 'a=10' },
        { oldText: 'c=3', newText: 'c=30' },
      ],
    })
    expect(readFileSync(p, 'utf8')).toBe('a=10\nb=2\nc=30\n')
    expect(out).toContain('2 replacements')
  })

  it('reports overlap between edits as an error', async () => {
    const p = write('a.txt', 'a=1\nb=2\n')
    await expect(editFile({
      path: p,
      edits: [
        { oldText: 'a=1', newText: 'x' },
        { oldText: '=1', newText: 'y' },
      ],
    })).rejects.toThrow(/overlap/i)
  })

  it('reports when an edit matches zero times', async () => {
    const p = write('a.txt', 'a=1\nb=2\n')
    await expect(editFile({
      path: p,
      edits: [
        { oldText: 'a=1', newText: 'x' },
        { oldText: 'nope', newText: 'y' },
      ],
    })).rejects.toThrow(/not found|0 occurrences/i)
  })

  it('preserves the original line endings (LF)', async () => {
    const p = write('a.txt', 'a\nb\nc\n')
    await editFile({ path: p, edits: [{ oldText: 'b', newText: 'B' }] })
    expect(readFileSync(p, 'utf8')).toBe('a\nB\nc\n')
  })
})
