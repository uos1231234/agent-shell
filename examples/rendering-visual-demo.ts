// v0.20 rendering base: visual demo — run the real wiki snapshot through the
// full signal chain (hook → bus → rule → base) and write the rendered HTML to
// a local file the user can open directly in a browser.
//
// v0.24: startPreviewServer 已移除（gate 是唯一数据面，用户拍板 2026-09-07）——
// 观测形态从"起端口"改为"写文件"。
//
// Run: npx tsx examples/rendering-visual-demo.ts [outFile]
// The script prints the output file path.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRenderingSignalBus } from '../src/rendering/signal-bus.js'
import { createRenderingBase } from '../src/rendering/base.js'
import { createWikiRenderRule } from '../src/rendering/rules/wiki.js'
import { ArtifactStore } from '../src/im/tools/artifact-store.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const snapshotPath = join(
  __dirname,
  '..',
  'src',
  'mcp-servers',
  'wiki-mcp',
  'visualizer',
  'exports',
  'knowledge-snapshot.md',
)

async function main(): Promise<void> {
  const md = readFileSync(snapshotPath, 'utf-8')

  // Assemble the rendering base (same wiring as plan §5.7).
  const store = new ArtifactStore()
  const bus = createRenderingSignalBus()
  const base = createRenderingBase(bus, { store })
  bus.registerRule(createWikiRenderRule(store))

  // Simulate the full silent chain: an LLM tool turn for wiki__render_md
  // arrives with the snapshot markdown → hook would call bus.emit →
  // rule matches → base renders + stores + broadcasts.
  let broadcasted: string | undefined
  base.onArtifact((h) => { broadcasted = h.id })
  await bus.emit(
    'wiki__render_md',
    {
      id: 'demo-turn',
      role: 'tool',
      toolCallId: 'demo-call',
      content: JSON.stringify({ success: true, markdown: md, mode: 'snapshot' }),
      sourceAgentId: 'demo-agent',
      at: Date.now(),
      toolName: 'wiki__render_md',
    },
  )
  if (!broadcasted) throw new Error('signal chain did not produce an artifact')
  const handle = base.handles()[0]!
  if (handle.id !== broadcasted) throw new Error('broadcast handle mismatch')
  const html = base.getHtml(handle.id)
  if (html === undefined) throw new Error('stored html missing for ' + handle.id)

  const outPath = resolve(process.argv[2] ?? join(__dirname, '.out', 'rendering-visual-demo.html'))
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, html, 'utf-8')

  console.log('=== v0.20 rendering base visual demo ===')
  console.log('artifact id :', handle.id)
  console.log('output file :', outPath)
  console.log('')
  console.log('Open the output file in a browser to see the rendered wiki snapshot.')
}

void main().catch((e) => {
  console.error('demo failed:', e)
  process.exit(1)
})
