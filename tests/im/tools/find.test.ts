// find.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findFiles } from '../../../src/im/tools/find.js'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-shell-find-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('findFiles', () => {
  it('matches a single-segment glob', async () => {
    writeFileSync(join(cwd, 'a.ts'), 'x')
    writeFileSync(join(cwd, 'b.js'), 'x')
    writeFileSync(join(cwd, 'c.ts'), 'x')
    const out = await findFiles({ pattern: '*.ts', path: cwd })
    const lines = out.split('\n').filter(Boolean)
    expect(lines.sort()).toEqual(['a.ts', 'c.ts'])
  })

  it('matches a deep glob recursively', async () => {
    mkdirSync(join(cwd, 'src', 'sub'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'a.ts'), 'x')
    writeFileSync(join(cwd, 'src', 'sub', 'b.ts'), 'x')
    writeFileSync(join(cwd, 'src', 'c.js'), 'x')
    const out = await findFiles({ pattern: '**/*.ts', path: cwd })
    const lines = out.split('\n').filter(Boolean)
    expect(lines.sort()).toEqual(['src/a.ts', 'src/sub/b.ts'])
  })

  it('returns paths relative to the search root using forward slashes', async () => {
    mkdirSync(join(cwd, 'src', 'sub'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'sub', 'a.ts'), 'x')
    const out = await findFiles({ pattern: '**/*.ts', path: cwd })
    expect(out).toBe('src/sub/a.ts')
  })

  it('respects .gitignore', async () => {
    mkdirSync(join(cwd, 'node_modules'), { recursive: true })
    writeFileSync(join(cwd, 'node_modules', 'a.ts'), 'x')
    writeFileSync(join(cwd, 'src.ts'), 'x')
    writeFileSync(join(cwd, '.gitignore'), 'node_modules\n')
    const out = await findFiles({ pattern: '*.ts', path: cwd })
    expect(out).toBe('src.ts')
  })

  it('respects limit', async () => {
    for (let i = 0; i < 30; i += 1) writeFileSync(join(cwd, `f${i}.ts`), 'x')
    const out = await findFiles({ pattern: '*.ts', path: cwd, limit: 5 })
    const lines = out.split('\n').filter(Boolean)
    expect(lines.length).toBe(5)
  })

  it('returns empty string when nothing matches', async () => {
    writeFileSync(join(cwd, 'a.txt'), 'x')
    const out = await findFiles({ pattern: '*.ts', path: cwd })
    expect(out).toBe('')
  })
})

// v0.29: 协作式取消——find 遍历中 abort 应立刻抛错停止。
describe('findFiles abort (v0.29)', () => {
  it('throws when the signal aborts during traversal', async () => {
    // 构造一个多层目录树（>30 目录），遍历未完成前 abort。
    const mkdir = (await import('node:fs/promises')).mkdir
    const tmp = process.cwd() + '/tmp-find-abort-test'
    const rm = (await import('node:fs/promises')).rm
    await rm(tmp, { recursive: true, force: true })
    await mkdir(tmp, { recursive: true })
    for (let i = 0; i < 40; i += 1) {
      await mkdir(`${tmp}/d${i}`, { recursive: true })
    }
    const ac = new AbortController()
    const p = findFiles({ pattern: '**/*.ts', path: tmp, signal: ac.signal })
    ac.abort() // 立刻取消
    await expect(p).rejects.toThrow(/aborted by the caller/)
    await rm(tmp, { recursive: true, force: true })
  })
})
