// tool-description.test.ts — v0.28: read/edit 纪律 description（KimiCode 形态）。
// 断言语义关键词而非整句全文（措辞可调，纪律语义必须稳定在 schema 里）。

import { describe, it, expect } from 'vitest'
import { createBuiltinTools } from '../../../src/im/tools/index.js'
import { ToolRegistry } from '../../../src/shell/registry.js'

const schemaOf = (r: ToolRegistry, name: string) => {
  const s = r.toOpenAIToolSchemas().find((t) => t.function.name === name)
  expect(s, `tool "${name}" must be exposed via toOpenAIToolSchemas`).toBeDefined()
  return s!.function
}

describe('tool description discipline (v0.28)', () => {
  it('read description declares the line-number view as the factual source for edit oldText', () => {
    const r = createBuiltinTools({ cwd: process.cwd() })
    const desc = schemaOf(r, 'read').description
    // 行号视图约定：`N<TAB>行内容`，1-based
    expect(desc).toContain('1-based')
    expect(desc).toContain('line numbers')
    expect(desc).toContain('N<TAB>')
    // 视图 = 事实视图，edit oldText 的事实来源，需去掉行号前缀
    expect(desc).toMatch(/factual|snapshot|on disk/)
    expect(desc).toContain('edit')
    expect(desc).toContain('oldText')
    expect(desc).toMatch(/line-number prefix/i)
  })

  it('edit description carries the read-before-edit discipline', () => {
    const r = createBuiltinTools({ cwd: process.cwd() })
    const desc = schemaOf(r, 'edit').description
    // ① 修改前先 read
    expect(desc).toMatch(/ALWAYS call read/i)
    // ② 不凭记忆/陈旧上下文/猜测构造 oldText
    expect(desc).toMatch(/NEVER construct oldText from memory|not from memory/i)
    expect(desc).toMatch(/stale context/i)
    // ③ 连续修改同一文件每次修改前重新 read
    expect(desc).toMatch(/re-read/i)
    // ④ oldText 与磁盘当前内容精确匹配且唯一；0 次或多次匹配被拒绝且文件不变
    expect(desc).toMatch(/exactly/i)
    expect(desc).toMatch(/uniquely|match.*once/i)
    expect(desc).toMatch(/zero or multiple|zero times/i)
    expect(desc).toMatch(/rejected/i)
    expect(desc).toMatch(/unchanged/i)
    // ⑤ oldText 取自 read 输出视图、去掉行号前缀
    expect(desc).toMatch(/read tool/i)
    expect(desc).toMatch(/output view/i)
    expect(desc).toMatch(/line-number prefix/i)
    // ⑥ 创建新文件 / 整体重写用 write
    expect(desc).toMatch(/create a new file/i)
    expect(desc).toMatch(/use write instead of edit/i)
  })

  it('edit oldText parameter description documents the view convention', () => {
    const r = createBuiltinTools({ cwd: process.cwd() })
    const fn = schemaOf(r, 'edit')
    const props = fn.parameters.properties as Record<
      string,
      { items?: { properties?: Record<string, { description?: string }> } }
    >
    const edits = props['edits']
    expect(edits?.items?.properties).toBeDefined()
    const oldTextDesc = edits!.items!.properties!['oldText']?.description
    expect(oldTextDesc).toBeDefined()
    // 来自 read 输出视图的内容行，去掉行号前缀
    expect(oldTextDesc).toMatch(/read tool/i)
    expect(oldTextDesc).toMatch(/output view/i)
    expect(oldTextDesc).toMatch(/line-number prefix/i)
    // 精确匹配
    expect(oldTextDesc).toMatch(/exactly/i)
  })

  it('discipline upgrade does not disturb schema structure (name/required/reason intact)', () => {
    const r = createBuiltinTools({ cwd: process.cwd() })
    const fn = schemaOf(r, 'edit')
    const params = fn.parameters as unknown as {
      properties: Record<string, unknown>
      required: string[]
    }
    expect(params.properties).toHaveProperty('path')
    expect(params.properties).toHaveProperty('edits')
    expect(params.properties).toHaveProperty('reason')
    expect(params.required).toContain('path')
    expect(params.required).toContain('edits')
    expect(fn.name).toBe('edit')
  })
})
