// ToolsRow（v0.28 工具自描述清单）SSR 冒烟：无 DOM 基建下的最低渲染验证，
// 对齐 deliverables.test.tsx 的 renderToStaticMarkup 模式。renderToStaticMarkup
// 能出 HTML = import type（编译期擦除）没有把库运行时代码泄漏进 bundle 的通路。
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToolsRow } from '../src/components/chat/MessageList'

describe('ToolsRow SSR 冒烟', () => {
  it('renders summary label + each tool name + description', () => {
    const html = renderToStaticMarkup(
      <ToolsRow
        tools={[
          { name: 'read', description: 'line-numbered view' },
          { name: 'edit', description: 'oldText must match disk exactly' },
        ]}
      />,
    )
    expect(html).toContain('模型工具（自描述 · 纪律）')
    expect(html).toContain('read')
    expect(html).toContain('line-numbered view')
    expect(html).toContain('edit')
    expect(html).toContain('oldText must match disk exactly')
  })

  it('description keeps newlines (whitespace-pre-wrap 纪律多行文本)', () => {
    const html = renderToStaticMarkup(<ToolsRow tools={[{ name: 'edit', description: 'line1\nline2' }]} />)
    expect(html).toContain('whitespace-pre-wrap')
    expect(html).toContain('line1\nline2')
  })
})
