// 真实并发测试（场景 7）：appendJsonl 并发追加是否产生半行/坏行。
//
// 机制来源（已读代码）：
//   src/im/state-line/jsonl-writer.ts:6-9  appendJsonl
//     await mkdir(recursive) 然后 await appendFile(path, JSON.stringify(record)+'\n')
//     —— 每次调用独立打开文件并以 O_APPEND('a') 追加；POSIX/Windows 的 'a' 模式
//        下 appendFile 的单次写是原子的（不会在字节层面与其它 append 交错），
//        因此并发追加不会产生半行。本测试守护该不变量：并发 N 次追加后，
//        读回的每一行都是合法 JSON、数量完整、无重复丢失。
//   （readJsonl 的 per-line try-catch 只是容忍坏行，不等于允许产生坏行。）

import { describe, it, expect } from 'vitest'
import { appendJsonl } from '../../../src/im/state-line/jsonl-writer.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('concurrency: appendJsonl 并发追加', () => {
  it('并发 N 次追加到同一文件：每行都是合法 JSON，数量完整，无半行/坏行', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jsonl-conc-'))
    const file = join(dir, 'conversation.jsonl')
    const N = 200
    // 每条记录带索引 + 一段足够大的 payload（跨小缓冲，仍为单次写）。
    const records = Array.from({ length: N }, (_, i) => ({ i, payload: 'x'.repeat(512), tag: `rec-${i}` }))

    await Promise.all(records.map((r) => appendJsonl(file, r)))

    const raw = await readFile(file, 'utf8')
    const lines = raw.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(N)

    // 每行都是合法 JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
    // 集合完整、无重复（每个 i 恰好一次）
    const ids = lines.map((l) => JSON.parse(l).i as number).sort((a, b) => a - b)
    expect(ids).toEqual(Array.from({ length: N }, (_, i) => i))

    await rm(dir, { recursive: true, force: true })
  })

  it('并发追加期间无某行被另一行截断（长度校验：每行 JSON 都能解析出原 payload）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jsonl-conc2-'))
    const file = join(dir, 'c.jsonl')
    const N = 100
    const records = Array.from({ length: N }, (_, i) => ({ i, payload: `P${i}-${'y'.repeat(300)}` }))
    await Promise.all(records.map((r) => appendJsonl(file, r)))

    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
    for (const line of lines) {
      const obj = JSON.parse(line) as { i: number; payload: string }
      expect(obj.payload).toBe(`P${obj.i}-${'y'.repeat(300)}`) // 未被其它行截断/拼接
    }
    await rm(dir, { recursive: true, force: true })
  })
})
