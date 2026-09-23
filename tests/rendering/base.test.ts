import { describe, it, expect } from 'vitest'
import { createRenderingBase, type ArtifactHandle } from '../../src/rendering/base.js'
import { createRenderingSignalBus } from '../../src/rendering/signal-bus.js'
import { createWikiRenderRule } from '../../src/rendering/rules/wiki.js'
import { ArtifactStore } from '../../src/im/tools/artifact-store.js'

// v0.24: 原 HTTP fetch helper 随 startPreviewServer 一起移除——
// 产物读取改走 getHtml()/handles() 直接断言（gate 的 artifact.get 数据面）。

describe('RenderingBase', () => {
  it('renderMarkdown method: handle created + onArtifact fired + handles grows', () => {
    const bus = createRenderingSignalBus()
    const base = createRenderingBase(bus)
    const received: ArtifactHandle[] = []
    const unsub = base.onArtifact((h) => { received.push(h) })

    const h = base.renderMarkdown('# Hello', { title: 't1', source: 's1' })
    expect(h.kind).toBe('markdown')
    expect(h.title).toBe('t1')
    expect(h.source).toBe('s1')
    expect(h.id).toMatch(/^[a-f0-9]{16}$/)
    expect(received).toHaveLength(1)
    expect(received[0]!.id).toBe(h.id)
    expect(base.handles()).toHaveLength(1)

    unsub()
  })

  it('signal path: bus.emit markdown signal → base auto-renders + broadcasts', async () => {
    const bus = createRenderingSignalBus()
    const base = createRenderingBase(bus)
    let received: { id: string; title: string } | null = null
    base.onArtifact((h) => { received = { id: h.id, title: h.title } })

    // Emit a markdown signal directly via onSignal — but bus.emit requires a
    // rule to produce a signal. We test the signal path by emitting a signal
    // through a registered rule that always produces a markdown signal.
    bus.registerRule({
      name: 'test-rule',
      match: () => true,
      extract: () => ({ kind: 'markdown' as const, title: 'sig-title', source: 'sig-src', content: '# Sig' }),
    })

    await bus.emit('any-tool', { content: '{}', success: true } as never)
    expect(received).not.toBeNull()
    expect(received!.title).toBe('sig-title')
    expect(base.handles()).toHaveLength(1)
    expect(base.getHtml(received!.id)).toContain('<h1>')
  })

  it('artifact-ref path: bus emits artifact-ref → base fetches html from store + broadcasts', async () => {
    const store = new ArtifactStore()
    const id = store.put('<h1>stored</h1>')
    const bus = createRenderingSignalBus()
    const base = createRenderingBase(bus, { store })
    let received: { id: string; kind: string } | null = null
    base.onArtifact((h) => { received = { id: h.id, kind: h.kind } })

    bus.registerRule({
      name: 'ref-rule',
      match: () => true,
      extract: () => ({
        kind: 'artifact-ref' as const,
        title: 'ref-title',
        source: 'ref-src',
        artifactId: id,
        sizeBytes: 100,
        mime: 'text/html' as const,
      }),
    })

    await bus.emit('any-tool', { content: '{}', success: true } as never)
    expect(received).not.toBeNull()
    expect(received!.id).toBe(id)
    expect(received!.kind).toBe('html')
    expect(base.getHtml(id)).toBe('<h1>stored</h1>')
  })

  it('handles() returns independent snapshots', () => {
    const bus = createRenderingSignalBus()
    const base = createRenderingBase(bus)
    base.renderMarkdown('# A', { title: 'a', source: 's' })
    const snap1 = base.handles()
    base.renderMarkdown('# B', { title: 'b', source: 's' })
    const snap2 = base.handles()
    expect(snap1).toHaveLength(1)
    expect(snap2).toHaveLength(2)
    // mutating snap1 does not affect internal state
    expect(base.handles()).toHaveLength(2)
  })

  it('onArtifact unsubscribe stops delivery', () => {
    const bus = createRenderingSignalBus()
    const base = createRenderingBase(bus)
    let count = 0
    const unsub = base.onArtifact(() => { count++ })
    base.renderMarkdown('# X', { title: 't', source: 's' })
    expect(count).toBe(1)
    unsub()
    base.renderMarkdown('# Y', { title: 't', source: 's' })
    expect(count).toBe(1)
  })

  it('getHtml: existing id returns html; missing id returns undefined', () => {
    const bus = createRenderingSignalBus()
    const base = createRenderingBase(bus)
    const h = base.renderMarkdown('# Hi', { title: 't', source: 's' })
    expect(base.getHtml(h.id)).toContain('<h1>')
    expect(base.getHtml('deadbeefdeadbeef')).toBeUndefined()
  })

  // v0.24: 原 preview server 的 7 个 HTTP 测试随 startPreviewServer 一起移除
  // （gate 是唯一数据面）。仍有意义的渲染断言以直接形态保留在下方。
  describe('artifact reads（直接断言，替代原 preview server HTTP 测试）', () => {
    it('handles() snapshot is JSON-serializable with titles carried (原 /list 断言的直接形态)', () => {
      const bus = createRenderingSignalBus()
      const base = createRenderingBase(bus)
      base.renderMarkdown('# Title', { title: 't', source: 's' })
      const json = JSON.parse(JSON.stringify(base.handles())) as Array<{ title: string }>
      expect(json).toHaveLength(1)
      expect(json[0]!.title).toBe('t')
    })

    it('getHtml: chinese content survives the pipeline intact (原 utf-8 charset 断言的直接形态)', () => {
      const bus = createRenderingSignalBus()
      const base = createRenderingBase(bus)
      const h = base.renderMarkdown('# 中文标题测试', { title: 't', source: 's' })
      // 渲染管线端到端保持中文（原断言验证 HTTP charset；现在验证内容本身）。
      expect(base.getHtml(h.id)).toContain('<h1>中文标题测试</h1>')
    })
  })

  // v0.20 P3 fix: 重复 emit 同 id 信号不应产生重复 handle。
  describe('P3: duplicate emit dedup', () => {
    it('same markdown emitted twice — single handle', async () => {
      const store = new ArtifactStore()
      const bus = createRenderingSignalBus()
      bus.registerRule(createWikiRenderRule(store))
      const base = createRenderingBase(bus, { store })
      const md = '# 去重测试\n\n内容'
      const turn = {
        id: 't-dup',
        role: 'tool' as const,
        toolCallId: 'tc-dup',
        content: JSON.stringify({ success: true, markdown: md, mode: 'snapshot' }),
        sourceAgentId: 'main',
        at: Date.now(),
        toolName: 'wiki__render_md',
      }
      const received: ArtifactHandle[] = []
      base.onArtifact((h) => { received.push(h) })
      await bus.emit('wiki__render_md', turn)
      await bus.emit('wiki__render_md', turn)
      expect(base.handles()).toHaveLength(1)
      expect(received).toHaveLength(1)
    })

    it('same artifact-ref emitted twice — single handle', async () => {
      const store = new ArtifactStore()
      const bus = createRenderingSignalBus()
      bus.registerRule(createWikiRenderRule(store))
      const base = createRenderingBase(bus, { store })
      const bigMd = '# 大快照\n\n' + '行\n'.repeat(5000)
      const turn = {
        id: 't-ref',
        role: 'tool' as const,
        toolCallId: 'tc-ref',
        content: JSON.stringify({ success: true, markdown: bigMd, mode: 'snapshot' }),
        sourceAgentId: 'main',
        at: Date.now(),
        toolName: 'wiki__render_md',
      }
      const received: ArtifactHandle[] = []
      base.onArtifact((h) => { received.push(h) })
      await bus.emit('wiki__render_md', turn)
      await bus.emit('wiki__render_md', turn)
      expect(base.handles()).toHaveLength(1)
      expect(received).toHaveLength(1)
    })
  })
})
