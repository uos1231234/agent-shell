// 真实并发测试（场景 9）：ArtifactStore 并发 put/get。
//
// 机制来源（已读代码）：
//   src/im/tools/artifact-store.ts:14-45
//     - put：createHash('sha256').update(content).digest('hex').slice(0,16) 然后
//       this.entries.set(id, content) —— 全程同步、无 await（Map.set 原子）。
//     - get：同步读取切片（CJK 按字符切，不按字节）。
//   内容寻址：相同内容 → 相同 id（幂等）；不同内容 → 不同 id。并发安全由同步保证。

import { describe, it, expect } from 'vitest'
import { ArtifactStore } from '../../../src/im/tools/artifact-store.js'

describe('concurrency: ArtifactStore 并发 put/get', () => {
  it('并发 put 相同内容：返回同一 id（幂等），store 只存一份', async () => {
    const store = new ArtifactStore()
    const N = 20
    const ids = await Promise.all(
      Array.from({ length: N }, () => Promise.resolve().then(() => store.put('same-content'))),
    )
    expect(new Set(ids).size).toBe(1) // 全部得到同一个 id
    // 内容寻址：相同内容只有一条 entry（通过 get 一致性间接验证）
    expect(store.get(ids[0]!)).toBe('same-content')
  })

  it('并发 put 不同内容：全部可检索、互不覆盖', async () => {
    const store = new ArtifactStore()
    const contents = Array.from({ length: 50 }, (_, i) => `content-${i}-${'z'.repeat(100)}`)
    const ids = await Promise.all(contents.map((c) => Promise.resolve().then(() => store.put(c))))
    expect(new Set(ids).size).toBe(50) // 内容不同 → id 不同
    for (let i = 0; i < 50; i++) {
      expect(store.get(ids[i]!)).toBe(contents[i]!) // 配对检索无错配
    }
  })

  it('并发 put 与 get：get 总能拿到已 put 的内容（无读-写错配）', async () => {
    const store = new ArtifactStore()
    const contents = Array.from({ length: 40 }, (_, i) => `c${i}`)
    const ids = await Promise.all(contents.map((c) => Promise.resolve().then(() => store.put(c))))
    // 再并发 get（混合不同 offset/limit 切片）
    const got = await Promise.all(
      ids.map((id, i) => Promise.resolve().then(() => store.get(id, 0, i % 2 === 0 ? 2 : undefined))),
    )
    for (let i = 0; i < 40; i++) {
      const expected = i % 2 === 0 ? contents[i]!.slice(0, 2) : contents[i]!
      expect(got[i]).toBe(expected)
    }
  })
})
