// ls.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lsDirectory } from '../../../src/im/tools/ls.js'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-shell-ls-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('lsDirectory', () => {
  it('lists files and dirs in the current directory', async () => {
    writeFileSync(join(cwd, 'a.txt'), 'x')
    writeFileSync(join(cwd, 'b.txt'), 'x')
    mkdirSync(join(cwd, 'sub'))
    const out = await lsDirectory({ path: cwd })
    expect(out).toContain('a.txt')
    expect(out).toContain('b.txt')
    expect(out).toContain('sub')
  })

  it('appends / to directories', async () => {
    mkdirSync(join(cwd, 'dir1'))
    const out = await lsDirectory({ path: cwd })
    expect(out).toContain('dir1/')
  })

  it('respects the limit', async () => {
    for (let i = 0; i < 20; i += 1) writeFileSync(join(cwd, `f${i}.txt`), 'x')
    const out = await lsDirectory({ path: cwd, limit: 5 })
    const lines = out.split('\n').filter(Boolean)
    expect(lines.length).toBe(5)
  })

  it('returns empty string for an empty directory', async () => {
    const out = await lsDirectory({ path: cwd })
    expect(out).toBe('')
  })

  it('throws on missing path', async () => {
    await expect(lsDirectory({ path: join(cwd, 'nope') })).rejects.toThrow(/ENOENT|not a directory|cannot find/i)
  })
})
