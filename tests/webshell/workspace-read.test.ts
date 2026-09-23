// v0.24 — readWorkspaceEntry（workspace.read 的宿主侧 fs 实现）单元测试。
//
// 覆盖（计划 DoD 对应行）：
//   - 越界拒绝：../ 逃逸 / 绝对路径外部 / 同名前缀目录（/ws vs /ws-foo，
//     前缀 + 分隔符边界防 startsWith 误判）
//   - path='.' 返回根目录列表；目录条目目录在前、按名排序、≤500 截断
//   - 文件正常读（返回相对 workDir 的正斜杠规范路径）
//   - >256KB 截断 + truncated 标记 + size 为原始字节数（恰在上限不截断）
//   - NUL 字节判二进制拒绝（含 NUL 落在 256KB 之外的情况——检测在截断之前）

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { readWorkspaceEntry } from '../../src/host/workspace-read.js'

let ws: string

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'ws-read-test-'))
})

afterEach(() => {
  if (ws) rmSync(ws, { recursive: true, force: true })
})

describe('readWorkspaceEntry — containment (workspace is the permission boundary)', () => {
  it('rejects a ../ escape outside the workspace', async () => {
    await expect(readWorkspaceEntry(ws, '../outside.txt')).rejects.toThrow(
      /escapes the session workspace/,
    )
  })

  it('rejects an external absolute path', async () => {
    const external = resolve(ws, '..', 'elsewhere.txt')
    await expect(readWorkspaceEntry(ws, external)).rejects.toThrow(/escapes the session workspace/)
  })

  it('rejects a sibling directory that only shares the name prefix', async () => {
    // 姊妹目录 <ws>-foo：naive 的 startsWith(root) 会误放行，必须带分隔符边界。
    const sibling = ws + '-foo'
    mkdirSync(sibling, { recursive: true })
    try {
      writeFileSync(join(sibling, 'secret.txt'), 'x')
      const rel = join('..', basename(sibling), 'secret.txt')
      await expect(readWorkspaceEntry(ws, rel)).rejects.toThrow(/escapes the session workspace/)
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })
})

describe('readWorkspaceEntry — directory listing', () => {
  it("returns the root listing for path '.'", async () => {
    writeFileSync(join(ws, 'a.txt'), 'A')
    mkdirSync(join(ws, 'sub'))

    const out = await readWorkspaceEntry(ws, '.')

    expect(out).toEqual({
      path: '.',
      kind: 'dir',
      entries: [
        { name: 'sub', kind: 'dir' },
        { name: 'a.txt', kind: 'file' },
      ],
    })
  })

  it('sorts dirs first then by name, and truncates to 500 entries', async () => {
    mkdirSync(join(ws, 'z-dir'))
    mkdirSync(join(ws, 'a-dir'))
    for (let i = 0; i < 505; i++) writeFileSync(join(ws, `f${String(i).padStart(3, '0')}.txt`), 'x')

    const out = await readWorkspaceEntry(ws, '.')

    expect(out.kind).toBe('dir')
    // 2 目录 + 505 文件 → 截到 500：全部目录在前 + 498 个文件。
    expect(out.entries).toHaveLength(500)
    expect(out.entries![0]).toEqual({ name: 'a-dir', kind: 'dir' })
    expect(out.entries![1]).toEqual({ name: 'z-dir', kind: 'dir' })
    expect(out.entries![2]).toEqual({ name: 'f000.txt', kind: 'file' })
    expect(out.entries![499]).toEqual({ name: 'f497.txt', kind: 'file' })
  })
})

describe('readWorkspaceEntry — file reading', () => {
  it('reads a text file with a canonical forward-slash relative path', async () => {
    mkdirSync(join(ws, 'sub'))
    writeFileSync(join(ws, 'sub', 'b.txt'), 'hello')

    const out = await readWorkspaceEntry(ws, 'sub/b.txt')

    expect(out).toEqual({ path: 'sub/b.txt', kind: 'file', content: 'hello', size: 5 })
    expect(out.truncated).toBeUndefined()
  })

  it('truncates files larger than 256KB and reports the original size', async () => {
    writeFileSync(join(ws, 'big.txt'), 'x'.repeat(256 * 1024 + 10))

    const out = await readWorkspaceEntry(ws, 'big.txt')

    expect(out.truncated).toBe(true)
    expect(out.size).toBe(256 * 1024 + 10)
    expect(out.content).toHaveLength(256 * 1024)
  })

  it('does not truncate a file exactly at the 256KB limit', async () => {
    writeFileSync(join(ws, 'exact.txt'), 'x'.repeat(256 * 1024))

    const out = await readWorkspaceEntry(ws, 'exact.txt')

    expect(out.truncated).toBeUndefined()
    expect(out.size).toBe(256 * 1024)
  })
})

describe('readWorkspaceEntry — binary detection', () => {
  it('rejects a file containing NUL bytes as binary', async () => {
    writeFileSync(join(ws, 'bin.dat'), Buffer.from([0x68, 0x69, 0x00, 0x0a]))

    await expect(readWorkspaceEntry(ws, 'bin.dat')).rejects.toThrow(/appears to be binary/)
  })

  it('scans the whole file for NUL bytes, not just the first 256KB', async () => {
    // NUL 落在 256KB 之外：检测必须在截断之前，否则漏判。
    const buf = Buffer.concat([Buffer.from('x'.repeat(300 * 1024)), Buffer.from([0])])
    writeFileSync(join(ws, 'late-nul.bin'), buf)

    await expect(readWorkspaceEntry(ws, 'late-nul.bin')).rejects.toThrow(/appears to be binary/)
  })
})
