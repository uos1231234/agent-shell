// v0.20 rendering base — concurrency safety + multi-round rendering test.
// Task 2.3 + Task 3: emit many distinct wiki__render_md signals concurrently,
// verify handles integrity, broadcast count, and per-artifact stored HTML.
// v0.24: 读取面从 preview server HTTP（/list + /artifact/:id）改为
// handles()/getHtml() 直接断言（gate 是唯一数据面，用户拍板 2026-09-07）。
// Run: npx tsx examples/rendering-concurrency-test.ts

import { createRenderingSignalBus } from '../src/rendering/signal-bus.js'
import { createRenderingBase } from '../src/rendering/base.js'
import { createWikiRenderRule } from '../src/rendering/rules/wiki.js'
import { ArtifactStore } from '../src/im/tools/artifact-store.js'

let pass = 0
let fail = 0
const results: string[] = []

function check(name: string, ok: boolean, evidence: string): void {
  if (ok) pass++
  else fail++
  results.push(`${ok ? '[PASS]' : '[FAIL]'} ${name}\n       evidence: ${evidence}`)
}

async function main(): Promise<void> {
  const store = new ArtifactStore()
  const bus = createRenderingSignalBus()
  const base = createRenderingBase(bus, { store })
  bus.registerRule(createWikiRenderRule(store))

  let broadcastCount = 0
  const broadcastIds: string[] = []
  base.onArtifact((h) => {
    broadcastCount++
    broadcastIds.push(h.id)
  })

  const N = 50
  const turns = Array.from({ length: N }, (_, k) => ({
    id: `turn-${k}`,
    role: 'tool' as const,
    toolCallId: `call-${k}`,
    content: JSON.stringify({
      success: true,
      markdown: `# 并发文档 ${k}\n\n内容 ${k} — 中文渲染检查。\n\n- item A ${k}\n- item B ${k}\n\n\`\`\`ts\nconst x${k} = ${k};\n\`\`\`\n`,
      mode: 'card',
      card_id: `card-${k}`,
    }),
    sourceAgentId: 'concurrency-agent',
    at: Date.now(),
    toolName: 'wiki__render_md',
  }))

  // Task 3: fire all emissions concurrently.
  await Promise.all(turns.map((t) => bus.emit('wiki__render_md', t)))

  const handles = base.handles()
  check(
    `Concurrency: ${N} parallel emits → ${N} handles (no loss, no dup)`,
    handles.length === N,
    `handles.length=${handles.length}, expected=${N}`,
  )

  const uniqueIds = new Set(handles.map((h) => h.id))
  check(
    'Concurrency: all handle ids unique (content-addressed, distinct content)',
    uniqueIds.size === N,
    `unique=${uniqueIds.size}`,
  )

  check(
    'Concurrency: broadcast called exactly once per artifact',
    broadcastCount === N,
    `broadcastCount=${broadcastCount}, expected=${N}`,
  )

  check(
    'Concurrency: broadcast ids match handles set',
    uniqueIds.size === new Set(broadcastIds).size && broadcastIds.every((id) => uniqueIds.has(id)),
    `broadcastIds=${broadcastIds.length}`,
  )

  check(
    'Concurrency: every handle title carried through (no cross-turn mixup)',
    handles.every((h) => /^Wiki 卡片 card-\d+$/.test(h.title)),
    `sample titles: ${handles.slice(0, 3).map((h) => h.title).join(' | ')}`,
  )

  // Task 2.3 (v0.24 形态): handles + stored html 直接断言（原 /list + /artifact/:id）。
  const list = handles.map((h) => ({ id: h.id, title: h.title }))
  check(
    'Multi-round: handles() returns all artifacts',
    list.length === N,
    `list.length=${list.length}`,
  )

  let okHtml = 0
  let emptyBody = 0
  for (const h of handles) {
    const body = base.getHtml(h.id) ?? ''
    if (body.length > 0) okHtml++
    if (body.length === 0) emptyBody++
  }
  check(
    `Multi-round: all ${N} artifacts have non-empty stored HTML`,
    okHtml === N && emptyBody === 0,
    `ok=${okHtml}, empty=${emptyBody}`,
  )

  // Spot-check one body's content integrity (id k=7 must contain its own number)
  const h7 = handles.find((h) => h.title === 'Wiki 卡片 card-7')
  if (h7) {
    const body = base.getHtml(h7.id) ?? ''
    check(
      'Multi-round: content integrity (card-7 body contains its own heading + code)',
      body.includes('并发文档 7') && body.includes('const x7 = 7;'),
      `len=${body.length}`,
    )
  }

  console.log('=== rendering concurrency + multi-round test ===')
  for (const r of results) console.log(r)
  console.log(`\ntotal: ${pass + fail}, pass: ${pass}, fail: ${fail}`)
  if (fail > 0) process.exit(1)
}

void main().catch((e) => {
  console.error('concurrency test failed:', e)
  process.exit(1)
})
