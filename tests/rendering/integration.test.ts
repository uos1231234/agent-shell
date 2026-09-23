// v0.20 rendering base: end-to-end integration test.
//
// Verifies the full chain: signal-bus + wiki rule → base → onArtifact.
// This mirrors how the wiki agent will use the rendering infrastructure:
//   1. A tool result (wiki__render_md) arrives at the bus
//   2. The wiki rule matches and extracts an ArtifactSignal
//   3. The base (subscribed) renders md → HTML and broadcasts to onArtifact

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRenderingSignalBus } from '../../src/rendering/signal-bus.js'
import { createRenderingBase } from '../../src/rendering/base.js'
import { createWikiRenderRule } from '../../src/rendering/rules/wiki.js'
import { ArtifactStore } from '../../src/im/tools/artifact-store.js'
import type { ArtifactHandle } from '../../src/rendering/base.js'
import type { ToolTurn } from '../../src/im/databus.js'

const mkTurn = (overrides: Partial<ToolTurn> = {}): ToolTurn => ({
  id: 't1',
  role: 'tool',
  toolCallId: 'tc-1',
  content: '{}',
  sourceAgentId: 'main',
  at: 1,
  ...overrides,
})

describe('rendering/integration', () => {
  let store: ArtifactStore
  let bus: ReturnType<typeof createRenderingSignalBus>
  let base: ReturnType<typeof createRenderingBase>
  let tmpDir: string

  beforeAll(() => {
    store = new ArtifactStore()
    bus = createRenderingSignalBus()
    base = createRenderingBase(bus, { store })
    bus.registerRule(createWikiRenderRule(store))
    tmpDir = mkdtempSync(join(tmpdir(), 'rendering-int-'))
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('full chain: wiki__render_md result → rule → base → onArtifact', async () => {
    const received: ArtifactHandle[] = []
    base.onArtifact((h) => { received.push(h) })

    // Simulate a wiki__render_md tool result (as it would arrive from the bus)
    const result = {
      success: true,
      file: '/tmp/snapshot.md',
      sizeBytes: 100,
      mode: 'snapshot',
      markdown: '# Hello Wiki\n\nThis is a **test**.\n\n```mermaid\ngraph TD\nA-->B\n```',
    }

    await bus.emit('wiki__render_md', mkTurn({ toolName: 'wiki__render_md', content: JSON.stringify(result) }))

    expect(received).toHaveLength(1)
    const handle = received[0]!
    expect(handle.kind).toBe('markdown')
    expect(handle.title).toBe('Wiki 全库快照')
    expect(handle.source).toBe('wiki__render_md snapshot')

    // Verify HTML was rendered and stored
    const html = base.getHtml(handle.id)
    expect(html).toBeDefined()
    expect(html!).toContain('<h1>Hello Wiki</h1>')
    expect(html!).toContain('<strong>test</strong>')
    // mermaid fence should be passed through as-is
    expect(html!).toContain('<pre class="mermaid-raw">')
    expect(html!).toContain('graph TD')
  })

  it('non-wiki tool results are silently ignored', async () => {
    const received: ArtifactHandle[] = []
    base.onArtifact((h) => { received.push(h) })

    await bus.emit('grep', mkTurn({ toolName: 'grep', content: '{"matches":[]}' }))
    expect(received).toHaveLength(0)
  })

  it('truncated markdown falls back to file read path', async () => {
    const received: ArtifactHandle[] = []
    base.onArtifact((h) => { received.push(h) })

    const fullContent = '# Full Content\n\nFrom file.'
    const file = join(tmpDir, 'fallback.md')
    writeFileSync(file, fullContent, 'utf-8')

    const truncated = {
      success: true,
      file,
      sizeBytes: fullContent.length,
      mode: 'card',
      card_id: 'mod-test',
      markdown: '# Full Con' + '...[truncated]',
    }

    await bus.emit('wiki__render_md', mkTurn({ toolName: 'wiki__render_md', content: JSON.stringify(truncated) }))

    expect(received).toHaveLength(1)
    const handle = received[0]!
    expect(handle.kind).toBe('html') // artifact-ref → base stores as 'html' kind
    expect(handle.title).toBe('Wiki 卡片 mod-test')
    // The base should have read the file and stored its content
    const html = base.getHtml(handle.id)
    expect(html).toBe(fullContent)
  })

  it('base.renderMarkdown (direct, non-signal path) works', () => {
    const received: ArtifactHandle[] = []
    base.onArtifact((h) => { received.push(h) })

    const handle = base.renderMarkdown('# Direct', { title: 'Direct Title', source: 'test' })
    expect(handle.kind).toBe('markdown')
    expect(received).toHaveLength(1)
    expect(base.getHtml(handle.id)).toContain('<h1>Direct</h1>')
  })
})
