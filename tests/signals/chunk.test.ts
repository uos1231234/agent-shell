// v0.42 大输入切块 — 纯函数 `splitChunk` + 会话状态 `createChunkMode` 单测。
//
// 语义锚点（用户拍板 2026-09-15）：
//   - 纯手动：只有 enable 的会话才切（chunk-mode），splitChunk 不判断"该不该切"
//   - 字符/字节硬切 + 序号前缀「（资料分卷 n/N）」
//   - 默认每卷 40K（DEFAULT_CHUNK_TOKENS），可配 chunkTokens

import { describe, it, expect } from 'vitest'
import { splitChunk, chunkPrefix, DEFAULT_CHUNK_TOKENS } from '../../src/signals/chunk.js'
import { createChunkMode } from '../../src/signals/chunk-mode.js'

describe('splitChunk — 字符硬切 + 序号前缀', () => {
  it('空输入返回空数组', () => {
    expect(splitChunk('')).toEqual([])
  })

  it('长度 ≤ 阈值的输入原样单卷返回（带前缀）', () => {
    const parts = splitChunk('hello', 100)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toBe('（资料分卷 1/1）\nhello')
  })

  it('超长输入切成多卷，前缀带正确编号与总数', () => {
    const text = 'a'.repeat(100)
    const parts = splitChunk(text, 30) // 30 单位一卷
    expect(parts.length).toBeGreaterThan(1)
    // 每卷都以前缀开头
    for (let i = 0; i < parts.length; i += 1) {
      expect(parts[i]!.startsWith(`（资料分卷 ${i + 1}/${parts.length}）`)).toBe(true)
    }
  })

  it('每卷正文长度 + 前缀 ≤ 阈值（不含换行）', () => {
    const text = 'x'.repeat(1000)
    const parts = splitChunk(text, 80)
    for (const p of parts) {
      const body = p.slice(p.indexOf('\n') + 1)
      expect(body.length).toBeLessThanOrEqual(80)
    }
  })

  it('拼接所有分卷的正文还原原文', () => {
    const text = '中文中大输入切块测试 '.repeat(500) // 有真实内容
    const parts = splitChunk(text, 100)
    const joined = parts.map((p) => p.slice(p.indexOf('\n') + 1)).join('')
    expect(joined).toBe(text)
  })

  it('重音/emoji 等非 BMP 字符按字符计（不被劈成半个码点）', () => {
    const text = '🀄🎲🚀'.repeat(50) // 每个 emoji 是 2 个 UTF-16 码元
    const parts = splitChunk(text, 50) // budget ≫ 最坏前缀，bodyCap 健康
    const joined = parts.map((p) => p.slice(p.indexOf('\n') + 1)).join('')
    expect(joined).toBe(text) // 拼接还原原文
    // 每个分卷正文都必须落在标量边界：不以孤立高代理结尾、不以孤立低代理开头
    //（完整 emoji 的结尾是低代理 0xDF04，属正常；孤立高代理 D800-DBFF 才是被切断）
    for (const p of parts) {
      const body = p.slice(p.indexOf('\n') + 1)
      const first = body.charCodeAt(0)
      const last = body.charCodeAt(body.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false) // 不以孤立高代理结尾
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false) // 不以孤立低代理开头
    }
  })

  it('chunkTokens 极端小也至少给每个分卷 1 单位正文（不产生空卷）', () => {
    const parts = splitChunk('abcd', 2)
    expect(parts.length).toBeGreaterThan(0)
    for (const p of parts) {
      const body = p.slice(p.indexOf('\n') + 1)
      expect(body.length).toBeGreaterThan(0)
    }
  })
})

describe('createChunkMode — 会话级切块状态', () => {
  it('新会话默认未启用', () => {
    const m = createChunkMode()
    expect(m.isEnabled('s1')).toBe(false)
    expect(m.tokensOf('s1')).toBeUndefined()
  })

  it('enable 后启用，tokensOf 返回默认或自定义阈值', () => {
    const m = createChunkMode()
    expect(m.enable('s1')).toBe(true)
    expect(m.isEnabled('s1')).toBe(true)
    expect(m.tokensOf('s1')).toBe(DEFAULT_CHUNK_TOKENS)

    const m2 = createChunkMode()
    m2.enable('s2', 12345)
    expect(m2.tokensOf('s2')).toBe(12345)
  })

  it('重复 enable 返回 false（此前已启用），disable 返回 true 表示真有关可关', () => {
    const m = createChunkMode()
    expect(m.enable('s1')).toBe(true)
    expect(m.enable('s1')).toBe(false)
    expect(m.disable('s1')).toBe(true)
    expect(m.disable('s1')).toBe(false)
    expect(m.isEnabled('s1')).toBe(false)
  })

  it('会话互相独立：s1 启用不影响 s2', () => {
    const m = createChunkMode()
    m.enable('s1')
    expect(m.isEnabled('s1')).toBe(true)
    expect(m.isEnabled('s2')).toBe(false)
    m.disable('s1')
    expect(m.isEnabled('s2')).toBe(false)
  })

  it('forget 清空（session.close/delete 时），之后视为未启用', () => {
    const m = createChunkMode()
    m.enable('s1')
    m.forget('s1')
    expect(m.isEnabled('s1')).toBe(false)
    expect(m.tokensOf('s1')).toBeUndefined()
  })
})