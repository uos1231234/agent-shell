// file-history-concurrency.test.ts — v0.36 快照层的并发稳定性（实测，非推理）。
//
// 为什么单独测：工具是并发执行的（loop 有并发上限），而 record 是**并发追加
// 同一个 index.jsonl**（append-only），prune 又会在第 32 次 record 时整体重写
// 索引（tmp + rename）。三件事撞一起时会不会丢记录 / 写坏文件，只能实测。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileHistory } from '../../../src/im/tools/file-history.js'

let cwd: string
let dataRoot: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-shell-fhcc-cwd-'))
  dataRoot = mkdtempSync(join(tmpdir(), 'agent-shell-fhcc-data-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
  rmSync(dataRoot, { recursive: true, force: true })
})

const indexPath = (): string => {
  const project = readdirSync(dataRoot)[0]!
  return join(dataRoot, project, 'index.jsonl')
}

/** 索引文件的每一行都必须是完整可解析的 JSON（交错写会产出半行）。 */
const everyLineParses = (): boolean => {
  const raw = readFileSync(indexPath(), 'utf8')
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .every((l) => {
      try {
        JSON.parse(l)
        return true
      } catch {
        return false
      }
    })
}

describe('concurrent record', () => {
  it('keeps every record when 30 distinct files are recorded concurrently', async () => {
    const fh = createFileHistory({ dataRoot, cwd })
    const files = Array.from({ length: 30 }, (_, i) => join(cwd, `f${i}.ts`))
    for (const f of files) writeFileSync(f, `content of ${f}\n`)

    await Promise.all(files.map((f) => fh.record(f, 's1')))

    const entries = await fh.list('s1')
    expect(entries).toHaveLength(30)
    expect(new Set(entries.map((e) => e.relPath)).size).toBe(30)
    expect(everyLineParses()).toBe(true)
  })

  it('keeps every record when the SAME file is recorded 20 times concurrently', async () => {
    const fh = createFileHistory({ dataRoot, cwd })
    const p = join(cwd, 'a.ts')
    writeFileSync(p, 'v\n')

    await Promise.all(Array.from({ length: 20 }, () => fh.record(p, 's1')))

    expect(await fh.list('s1')).toHaveLength(20)
    expect(everyLineParses()).toBe(true)
  })

  it('does not corrupt the index when prune fires inside a concurrent burst', async () => {
    // maxEntries 很小 → 第 32 次 record 触发 prune（prune 会整体重写索引），
    // 而同一批并发 record 还在 append。这是最容易写坏索引的窗口。
    const fh = createFileHistory({ dataRoot, cwd, maxEntries: 10 })
    const files = Array.from({ length: 50 }, (_, i) => join(cwd, `g${i}.ts`))
    for (const f of files) writeFileSync(f, `content of ${f}\n`)

    await Promise.all(files.map((f) => fh.record(f, 's1')))

    // 索引必须完好：不能出现半行 / 解析失败。
    expect(everyLineParses()).toBe(true)
    const entries = await fh.list('s1')
    // 条数在 [maxEntries, 尝试次数] 之间，且无重复——prune 是唯一允许裁记录的地方，
    // 裁剪只从队头丢，不会造成重复或中间空洞。
    expect(entries.length).toBeGreaterThanOrEqual(10)
    expect(entries.length).toBeLessThanOrEqual(50)
    expect(new Set(entries.map((e) => e.relPath)).size).toBe(entries.length)
  })

  it('loses nothing when records race an index rewrite (rewind)', async () => {
    // P0-1 的直接回归。rewind 会 readIndex → 还原 → writeIndex（整体重写），与并发
    // 的 append 交错时，旧实现可能把 append 落到**已被 rename 掉的旧 inode** 上，
    // 该条记录随旧 inode 一起消失。
    //
    // 与上一组不同：**rewind 不会裁掉别的会话的记录**，所以这里能精确断言"一条都
    // 不少"（prune 那组做不到——prune 本身就要按配额裁）。
    const fh = createFileHistory({ dataRoot, cwd })
    const a = join(cwd, 'a.ts')
    writeFileSync(a, 'v1\n')
    await fh.record(a, 'A')

    const bs = Array.from({ length: 20 }, (_, i) => join(cwd, `b${i}.ts`))
    for (const f of bs) writeFileSync(f, 'x\n')

    await Promise.all([fh.rewind('A', 1), ...bs.map((f) => fh.record(f, 'B'))])

    expect(await fh.list('B')).toHaveLength(20)
    expect(await fh.list('A')).toHaveLength(0)
    expect(everyLineParses()).toBe(true)
  })
})
