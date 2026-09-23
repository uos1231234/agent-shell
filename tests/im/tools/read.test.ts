// read.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from '../../../src/im/tools/read.js'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-shell-read-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

const write = (name: string, content: string): string => {
  const p = join(cwd, name)
  writeFileSync(p, content)
  return p
}

describe('readFile', () => {
  it('reads the whole file with line numbers when offset/limit omitted', async () => {
    const p = write('a.txt', 'one\ntwo\nthree\nfour\n')
    const out = await readFile({ path: p })
    expect(out).toBe('1\tone\n2\ttwo\n3\tthree\n4\tfour')
  })

  it('respects offset (1-indexed) and limit', async () => {
    const p = write('a.txt', 'one\ntwo\nthree\nfour\n')
    const out = await readFile({ path: p, offset: 2, limit: 2 })
    expect(out).toBe('2\ttwo\n3\tthree')
  })

  it('handles files without a trailing newline', async () => {
    const p = write('a.txt', 'one\ntwo')
    const out = await readFile({ path: p })
    expect(out).toBe('1\tone\n2\ttwo')
  })

  it('handles a single line file', async () => {
    const p = write('a.txt', 'hello')
    const out = await readFile({ path: p })
    expect(out).toBe('1\thello')
  })

  it('throws on missing file', async () => {
    await expect(readFile({ path: join(cwd, 'nope.txt') })).rejects.toThrow(/ENOENT|no such file|cannot find/i)
  })

  it('rejects offset < 1', async () => {
    const p = write('a.txt', 'one\ntwo\n')
    await expect(readFile({ path: p, offset: 0 })).rejects.toThrow(/offset/i)
  })

  it('rejects limit < 1', async () => {
    const p = write('a.txt', 'one\ntwo\n')
    await expect(readFile({ path: p, limit: 0 })).rejects.toThrow(/limit/i)
  })

  it('returns empty string when offset is past end of file', async () => {
    const p = write('a.txt', 'one\ntwo\n')
    const out = await readFile({ path: p, offset: 100 })
    expect(out).toBe('')
  })
})
