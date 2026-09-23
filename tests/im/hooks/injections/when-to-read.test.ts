// Tests for when-to-read injection — v0.42（合并 memory_md + architecture_desc）
//
// Invariants:
//   - 引导段常驻（文档存在时），全文默认不注入。
//   - 内容哈希 ≠ 已读基线 → 未读提示（A/C/B 三选一）。
//   - 上轮回复以选项开头（宽松解析）→ 全量拉取 + 基线同步（markread）。
//   - 选 B / 未识别 → 不拉取，未读保留。
//   - 未读不存在时，回复以选项字母开头不触发（防误消费）。
//   - 状态按 agentId 分桶；同一回复文本不重复消费（lastHonoredText）。
//   - 无文档 / 无 workDir → null。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWhenToReadInjection, parseChoice } from '../../../../src/im/hooks/injections/when-to-read.js'
import type { InjectionContext } from '../../../../src/im/hooks/context-injection.js'

function makeCtx(overrides: Partial<InjectionContext> = {}): InjectionContext {
  return {
    conversationHistory: [],
    registry: {} as any,
    round: 1,
    ...overrides,
  }
}

describe('parseChoice（宽松选项解析）', () => {
  it.each([
    ['A', 'A'],
    ['a', 'A'],
    [' A。', 'A'],
    ['B 暂不需要。', 'B'],
    ['（选）C', 'C'],
    ['选择A', 'A'],
    ['**答案：A**', 'A'],
    ['Ｃ', 'C'],
    ['C、请注入架构文档', 'C'],
  ])('识别 %j → %s', (input, expected) => {
    expect(parseChoice(input)).toBe(expected)
  })

  it.each([
    ['API 设计如下'],
    ['Apple'],
    ['好的，我来看一下 B 站的视频'],
    [''],
  ])('拒绝 %j → null', (input) => {
    expect(parseChoice(input)).toBeNull()
  })
})

describe('when-to-read injection', () => {
  const testDir = join(tmpdir(), 'v042-wtr-test-' + Date.now())
  const memoryFile = join(testDir, 'MEMORY.md')
  const archFile = join(testDir, 'ARCHITECTURE.md')
  const subDoc = join(testDir, 'arch-detail.md')
  let injection: ReturnType<typeof createWhenToReadInjection>

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
    // 未读视图是注入源实例状态——每个测试全新实例，避免跨测试污染。
    injection = createWhenToReadInjection()
  })

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }) } catch { /* ignore */ }
  })

  const agentCtx = (history: unknown[] = [], agentId = 'main'): InjectionContext =>
    makeCtx({ workDir: testDir, conversationHistory: history, agentId })

  const reply = (text: string): unknown[] => [
    { id: 'u1', role: 'user', content: 'hi', at: 1 },
    { id: 'a1', role: 'assistant', content: text, at: 2 },
  ]

  it('文档存在时注入引导段，但不注入全文', async () => {
    writeFileSync(memoryFile, '- 用户偏好简洁回复（跨会话记忆）。', 'utf-8')
    const result = await injection.inject(agentCtx())
    expect(result).not.toBeNull()
    expect(result).toContain('MEMORY.md')
    expect(result).toContain('工作区文档索引')
    expect(result).not.toContain('用户偏好简洁回复')
    expect(result).not.toContain('未读变化')
  })

  it('无文档 / 无 workDir → null', async () => {
    expect(await injection.inject(makeCtx({ workDir: testDir }))).toBeNull()
    writeFileSync(memoryFile, 'x', 'utf-8')
    expect(await injection.inject(makeCtx({ round: 1 }))).toBeNull()
  })

  it('内容变化 → 未读提示（A/B 选项）', async () => {
    writeFileSync(memoryFile, 'v1', 'utf-8')
    await injection.inject(agentCtx()) // 建基线
    writeFileSync(memoryFile, 'v2 — 新增决策记录', 'utf-8')
    const result = await injection.inject(agentCtx())
    expect(result).toContain('未读变化')
    expect(result).toContain('**A**')
    expect(result).toContain('**B**')
    expect(result).not.toContain('**C**') // 架构文档不存在，无 C 选项
  })

  it('上轮选 A → 全量注入 MEMORY.md + 清未读', async () => {
    writeFileSync(memoryFile, 'v1', 'utf-8')
    await injection.inject(agentCtx())
    writeFileSync(memoryFile, 'v2 — 新增决策记录', 'utf-8')
    await injection.inject(agentCtx()) // 产生未读
    const result = await injection.inject(agentCtx(reply('A。我来读取记忆全文。')))
    expect(result).toContain('【MEMORY.md 全文】')
    expect(result).toContain('v2 — 新增决策记录')
    expect(result).not.toContain('未读变化') // 已清
    // 下一轮（无新变化）不再注入全文
    const next = await injection.inject(agentCtx([reply('A。我来读取记忆全文。'), { id: 'a2', role: 'assistant', content: '已读', at: 3 }]))
    expect(next).not.toContain('【MEMORY.md 全文】')
  })

  it('上轮选 C → 全量注入 ARCHITECTURE.md 子文档 + 清未读', async () => {
    writeFileSync(archFile, '# 架构\n\n## 架构文档\npath: arch-detail.md\n', 'utf-8')
    writeFileSync(subDoc, '# 详细架构\n\n- src/shell/ — 纯逻辑\n', 'utf-8')
    await injection.inject(agentCtx()) // 建基线
    writeFileSync(subDoc, '# 详细架构 v2\n\n- src/shell/ — 纯逻辑\n- src/im/ — 组合层\n', 'utf-8')
    await injection.inject(agentCtx()) // 产生未读
    const result = await injection.inject(agentCtx(reply(' C。请注入架构文档。')))
    expect(result).toContain('【ARCHITECTURE.md 全文】')
    expect(result).toContain('src/im/ — 组合层')
    expect(result).not.toContain('未读变化')
  })

  it('上轮选 B → 不拉取，未读保留', async () => {
    writeFileSync(memoryFile, 'v1', 'utf-8')
    await injection.inject(agentCtx())
    writeFileSync(memoryFile, 'v2', 'utf-8')
    await injection.inject(agentCtx())
    const result = await injection.inject(agentCtx(reply('B 暂不需要。')))
    expect(result).not.toContain('【MEMORY.md 全文】')
    expect(result).toContain('未读变化')
  })

  it('无未读时，回复以 A 开头不触发注入（防误消费）', async () => {
    writeFileSync(memoryFile, 'v1', 'utf-8')
    await injection.inject(agentCtx()) // 建基线，无未读
    const result = await injection.inject(agentCtx(reply('A 方案更好。')))
    expect(result).not.toContain('【MEMORY.md 全文】')
  })

  it('两个文档同时未读 → 三选一同时给（A/C/B）', async () => {
    writeFileSync(memoryFile, 'm1', 'utf-8')
    writeFileSync(archFile, '# 架构\n\n## 架构文档\npath: arch-detail.md\n', 'utf-8')
    writeFileSync(subDoc, 'sub v1', 'utf-8')
    await injection.inject(agentCtx())
    writeFileSync(memoryFile, 'm2', 'utf-8')
    writeFileSync(subDoc, 'sub v2', 'utf-8')
    const result = await injection.inject(agentCtx())
    expect(result).toContain('**A**')
    expect(result).toContain('**C**')
    expect(result).toContain('**B**')
  })

  it('per-agent 隔离：子代理的 "A..." 回复不消费工作代理的未读', async () => {
    writeFileSync(memoryFile, 'm1', 'utf-8')
    await injection.inject(agentCtx([], 'main')) // main 建基线
    writeFileSync(memoryFile, 'm2', 'utf-8')
    await injection.inject(agentCtx([], 'main')) // main 有未读
    // 子代理（新 agent，首次 inject 以 m2 建基线）回复 A —— 不应注入全文
    const sub = await injection.inject(agentCtx(reply('A 先做这个。'), 'sub-1'))
    expect(sub).not.toContain('【MEMORY.md 全文】')
    // main 的未读仍在
    const main = await injection.inject(agentCtx([], 'main'))
    expect(main).toContain('未读变化')
  })

  it('同一回复文本不重复消费（工具轮链中 lastHonoredText 守卫）', async () => {
    writeFileSync(memoryFile, 'm1', 'utf-8')
    await injection.inject(agentCtx())
    writeFileSync(memoryFile, 'm2', 'utf-8')
    await injection.inject(agentCtx())
    const history = reply('A。读取记忆。')
    await injection.inject(agentCtx(history)) // 消费，清未读
    // 新变化出现在工具轮链中（最后一条带文本 assistant 仍是旧的 A 回复）
    writeFileSync(memoryFile, 'm3', 'utf-8')
    const result = await injection.inject(agentCtx(history))
    expect(result).not.toContain('【MEMORY.md 全文】') // 旧回复不重复消费
    expect(result).toContain('未读变化') // 但未读提示照常出现
  })
})
