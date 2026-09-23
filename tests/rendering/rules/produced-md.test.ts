// produced-md 规则单测：工作代理 write/edit/search_replace 的 .md 产物自动渲染。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createProducedMdRule } from '../../../src/rendering/rules/produced-md.js'
import { createRenderingSignalBus } from '../../../src/rendering/signal-bus.js'
import { ArtifactStore } from '../../../src/im/tools/artifact-store.js'
import type { ToolTurn } from '../../../src/im/databus.js'

const mkTurn = (over: Partial<ToolTurn>): ToolTurn => ({
  id: 't-1',
  role: 'tool',
  toolCallId: 'call-1',
  content: 'ok',
  sourceAgentId: 'root',
  at: 0,
  toolName: 'write',
  ...over,
})

describe('rendering/rules/produced-md', () => {
  let store: ArtifactStore
  let rule: ReturnType<typeof createProducedMdRule>
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'produced-md-'))
    store = new ArtifactStore()
    rule = createProducedMdRule(store, tmpDir)
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('match: write/edit/search_replace → true; read/grep/write 的非写工具 → false', () => {
    expect(rule.match('write')).toBe(true)
    expect(rule.match('edit')).toBe(true)
    expect(rule.match('search_replace')).toBe(true)
    expect(rule.match('read')).toBe(false)
    expect(rule.match('grep')).toBe(false)
    expect(rule.match('')).toBe(false)
  })

  it('extract: .md 产物 ≤64KB → kind:"markdown"，title=basename，source=工具+路径', () => {
    const file = join(tmpDir, 'report.md')
    writeFileSync(file, '# 报告\n\n正文', 'utf-8')
    const sig = rule.extract(undefined, mkTurn({ args: { path: file, content: 'x' } }))
    expect(sig).toBeDefined()
    expect(sig!.kind).toBe('markdown')
    const md = sig! as Extract<typeof sig, { kind: 'markdown' }>
    expect(md.title).toBe('report.md')
    expect(md.source).toBe(`write ${file}`)
    expect(md.content).toBe('# 报告\n\n正文')
  })

  it('extract: >64KB → store.put → kind:"artifact-ref"', () => {
    const file = join(tmpDir, 'big.md')
    let big = ''
    for (let i = 0; i < 65_537; i++) big += 'x'
    writeFileSync(file, big, 'utf-8')
    const sig = rule.extract(undefined, mkTurn({ args: { path: file } }))
    expect(sig!.kind).toBe('artifact-ref')
    const ref = sig! as Extract<typeof sig, { kind: 'artifact-ref' }>
    expect(ref.sizeBytes).toBe(65_537)
    expect(store.get(ref.artifactId)).toBe(big)
  })

  it('extract: isError / 非 .md / 无 args.path → undefined', () => {
    const file = join(tmpDir, 'skip.md')
    writeFileSync(file, 'x', 'utf-8')
    expect(rule.extract(undefined, mkTurn({ isError: true, args: { path: file } }))).toBeUndefined()
    expect(rule.extract(undefined, mkTurn({ args: { path: join(tmpDir, 'a.txt') } }))).toBeUndefined()
    expect(rule.extract(undefined, mkTurn({ args: { content: 'no path' } }))).toBeUndefined()
    expect(rule.extract(undefined, mkTurn({}))).toBeUndefined()
  })

  it('extract: 文件读取失败 → undefined（不阻塞其他规则）', () => {
    expect(rule.extract(undefined, mkTurn({ args: { path: join(tmpDir, 'ghost.md') } }))).toBeUndefined()
  })

  it('extract: 相对路径锚定 workDir（与 write 工具同一 resolver）', () => {
    writeFileSync(join(tmpDir, 'relative.md'), '# 相对', 'utf-8')
    const sig = rule.extract(undefined, mkTurn({ args: { path: 'relative.md' } }))
    expect(sig).toBeDefined()
    expect(sig!.kind).toBe('markdown')
  })

  it('extract: 越界路径（workDir 外）→ resolvePath 拒绝 → undefined', () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'))
    try {
      const file = join(outside, 'evil.md')
      writeFileSync(file, 'x', 'utf-8')
      expect(rule.extract(undefined, mkTurn({ args: { path: file } }))).toBeUndefined()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('bus.emit 端到端：write + .md + args.path → 订阅者收到信号；.txt → 静默', async () => {
    const bus = createRenderingSignalBus()
    bus.registerRule(rule)
    const got: unknown[] = []
    bus.onSignal((s) => {
      got.push(s)
    })
    const file = join(tmpDir, 'via-bus.md')
    writeFileSync(file, '# bus', 'utf-8')
    await bus.emit('write', mkTurn({ args: { path: file } }))
    expect(got.length).toBe(1)
    await bus.emit('write', mkTurn({ args: { path: join(tmpDir, 'plain.txt') } }))
    expect(got.length).toBe(1)
  })
})
