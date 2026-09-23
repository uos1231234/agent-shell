// v0.20 rendering base: wiki rule unit tests (plan v0.20-rendering-base.md §5.5 + D4).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWikiRenderRule } from '../../../src/rendering/rules/wiki.js'
import { ArtifactStore } from '../../../src/im/tools/artifact-store.js'
import type { ToolTurn } from '../../../src/im/databus.js'

// extract 的第二参数（v0.33 契约：bus 转发原始 ToolTurn）；wiki 规则不消费它。
const mockTurn: ToolTurn = {
  id: 't-1',
  role: 'tool',
  toolCallId: 'call-1',
  content: '',
  sourceAgentId: 'root',
  at: 0,
  toolName: 'wiki__render_md',
}

describe('rendering/rules/wiki', () => {
  let store: ArtifactStore
  let rule: ReturnType<typeof createWikiRenderRule>
  let tmpDir: string

  beforeAll(() => {
    store = new ArtifactStore()
    rule = createWikiRenderRule(store)
    tmpDir = mkdtempSync(join(tmpdir(), 'wiki-rule-'))
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ---- match ----
  it('match: wiki__render_md → true; other tool names → false', () => {
    expect(rule.match('wiki__render_md')).toBe(true)
    expect(rule.match('grep')).toBe(false)
    expect(rule.match('')).toBe(false)
    expect(rule.match('wiki__search_cards')).toBe(false)
  })

  // ① complete markdown (not truncated, ≤64KB) → kind:'markdown'
  it('extract: complete markdown string → kind:"markdown" with correct title/source', () => {
    const result = rule.extract({ success: true, markdown: '# Hello', mode: 'snapshot' }, mockTurn)
    expect(result).toBeDefined()
    expect(result!.kind).toBe('markdown')
    const md = result! as Extract<typeof result, { kind: 'markdown' }>
    expect(md.title).toBe('Wiki 全库快照')
    expect(md.source).toBe('wiki__render_md snapshot')
    expect(md.content).toBe('# Hello')
  })

  it('extract: card mode → title includes card_id', () => {
    const result = rule.extract({ success: true, markdown: 'x', mode: 'card', card_id: 'mod-foo' }, mockTurn)
    expect(result!.kind).toBe('markdown')
    expect(result!.title).toBe('Wiki 卡片 mod-foo')
    expect(result!.source).toBe('wiki__render_md card')
  })

  // ② complete but >64KB → store.put → kind:'artifact-ref'
  it('extract: markdown >64KB → kind:"artifact-ref" with stored id', () => {
    let big = ''
    for (let i = 0; i < 65_537; i++) big += 'x'
    const result = rule.extract({ success: true, markdown: big, mode: 'snapshot' }, mockTurn)
    expect(result).toBeDefined()
    expect(result!.kind).toBe('artifact-ref')
    const ref = result! as Extract<typeof result, { kind: 'artifact-ref' }>
    expect(ref.sizeBytes).toBe(65_537)
    expect(store.get(ref.artifactId)).toBe(big)
  })

  // ③ markdown truncated → read file → store.put → kind:'artifact-ref'
  it('extract: markdown truncated (ends with "...[truncated]") → fallback to file read', () => {
    const fullContent = '# Full Snapshot\n\nThis is the real content.'
    const file = join(tmpDir, 'snapshot.md')
    writeFileSync(file, fullContent, 'utf-8')

    const result = rule.extract({
      success: true,
      markdown: '# Full Snapsh' + '...[truncated]',
      file,
      mode: 'snapshot',
    }, mockTurn)
    expect(result).toBeDefined()
    expect(result!.kind).toBe('artifact-ref')
    const ref = result! as Extract<typeof result, { kind: 'artifact-ref' }>
    expect(ref.sizeBytes).toBe(fullContent.length)
    expect(store.get(ref.artifactId)).toBe(fullContent)
  })

  it('extract: markdown missing but file present → read file → artifact-ref', () => {
    const fullContent = '# From File Only'
    const file = join(tmpDir, 'only-file.md')
    writeFileSync(file, fullContent, 'utf-8')

    const result = rule.extract({ success: true, file, mode: 'card', card_id: 'fn-x' }, mockTurn)
    expect(result).toBeDefined()
    expect(result!.kind).toBe('artifact-ref')
    const ref = result! as Extract<typeof result, { kind: 'artifact-ref' }>
    expect(store.get(ref.artifactId)).toBe(fullContent)
    expect(ref.title).toBe('Wiki 卡片 fn-x')
  })

  it('extract: file read fails (missing file) → undefined', () => {
    const result = rule.extract({
      success: true,
      markdown: '# abc' + '...[truncated]',
      file: join(tmpDir, 'nonexistent.md'),
    }, mockTurn)
    expect(result).toBeUndefined()
  })

  // ④ no usable content → undefined
  it('extract: success=false → undefined', () => {
    expect(rule.extract({ success: false, markdown: 'x' }, mockTurn)).toBeUndefined()
  })

  it('extract: not an object → undefined', () => {
    expect(rule.extract(null, mockTurn)).toBeUndefined()
    expect(rule.extract('string', mockTurn)).toBeUndefined()
    expect(rule.extract(42, mockTurn)).toBeUndefined()
  })

  it('extract: success but no markdown and no file → undefined', () => {
    expect(rule.extract({ success: true, mode: 'snapshot' }, mockTurn)).toBeUndefined()
  })

  // modeToTitle edge cases
  it('extract: unknown mode → generic title', () => {
    const result = rule.extract({ success: true, markdown: 'x', mode: 'bogus' }, mockTurn)
    expect(result!.title).toBe('Wiki 渲染结果')
  })

  it('extract: card mode without card_id → "unknown" placeholder', () => {
    const result = rule.extract({ success: true, markdown: 'x', mode: 'card' }, mockTurn)
    expect(result!.title).toBe('Wiki 卡片 unknown')
  })
})
