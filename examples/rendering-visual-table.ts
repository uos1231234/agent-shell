// v0.20 rendering base — rich markdown visual check (tables, links, inline fmt).
// Renders a table-heavy doc through the REAL chain (bus → rule → base), then
// drives headless Chromium over the stored HTML.
// v0.24: 加载面从 preview server URL 改为 data: URL（gate 是唯一数据面，
// 用户拍板 2026-09-07）——零端口，浏览器仍对同一份 HTML 做真实渲染。
//
// playwright 来源（用户拍板 2026-09-07：用 npm 引入变量，不做环境变量持久化）：
// playwright 不进 package.json（examples 零重依赖纪律），运行时从 npm 全局
// 目录引入——缺省 `npm root -g` + '/playwright' 自动推导，裸跑即可；
// PLAYWRIGHT_GLOBAL_PATH 环境变量可覆盖（指向任何可被 require 的 playwright 包）。
// Run: npx tsx examples/rendering-visual-table.ts [outDir]

/// <reference lib="dom" />

import { mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import { createRenderingSignalBus } from '../src/rendering/signal-bus.js'
import { createRenderingBase } from '../src/rendering/base.js'
import { createWikiRenderRule } from '../src/rendering/rules/wiki.js'
import { ArtifactStore } from '../src/im/tools/artifact-store.js'

const require = createRequire(import.meta.url)

// playwright 路径：环境变量优先；缺省从 npm 全局目录推导（npm root -g）。
function resolvePlaywrightPath(): string {
  const fromEnv = process.env.PLAYWRIGHT_GLOBAL_PATH
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  const globalRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim()
  return join(globalRoot, 'playwright')
}

const { chromium } = require(resolvePlaywrightPath())

const outDir = process.argv[2] ?? 'C:/Users/HP/.zcode/cli/artifacts'
mkdirSync(outDir, { recursive: true })

const md = [
  '# 渲染基座元素验证',
  '',
  '| 模块 | 类型 | 状态 | 备注 |',
  '|------|------|------|------|',
  '| render-md.ts | 纯函数 | 完成 | 零依赖 markdown 渲染 |',
  '| base.ts | 服务 | 完成 | ArtifactStore + preview server |',
  '| signal-bus.ts | 事件 | 完成 | 规则池 + 订阅广播 |',
  '| wiki.ts | 规则 | 完成 | 提取 render_md 结果 |',
  '',
  '## 行内格式',
  '',
  '这是 **加粗文本**、*斜体文本*、`行内代码 renderMarkdown()`，以及一个[外部链接](https://example.com/docs)和一个[可疑链接](javascript:alert(1))。',
  '',
  '## 有序与无序列表',
  '',
  '1. 第一步：emit 渲染信号',
  '2. 第二步：规则匹配并提取',
  '3. 第三步：base 渲染存储广播',
  '',
  '- 无序项 A',
  '- 无序项 B',
  '- 无序项 C',
  '',
  '## 代码块',
  '',
  '```ts',
  'export function renderMarkdown(md: string): string {',
  '  return escaped(md)',
  '}',
  '```',
  '',
  '```mermaid',
  'graph LR',
  '    A[信号] --> B[规则]',
  '    B --> C[渲染]',
  '    C --> D[广播]',
  '```',
].join('\n')

let pass = 0
let fail = 0
const results: string[] = []
const check = (name: string, ok: boolean, evidence: string): void => {
  if (ok) pass++
  else fail++
  results.push(`${ok ? '[PASS]' : '[FAIL]'} ${name}\n       evidence: ${evidence}`)
}

async function main(): Promise<void> {
  // real chain
  const store = new ArtifactStore()
  const bus = createRenderingSignalBus()
  const base = createRenderingBase(bus, { store })
  bus.registerRule(createWikiRenderRule(store))
  await bus.emit('wiki__render_md', {
    id: 'table-turn',
    role: 'tool',
    toolCallId: 'table-call',
    content: JSON.stringify({ success: true, markdown: md, mode: 'snapshot' }),
    sourceAgentId: 'visual-agent',
    at: Date.now(),
    toolName: 'wiki__render_md',
  })
  const handle = base.handles()[0]!
  const html = base.getHtml(handle.id) ?? ''
  if (html.length === 0) throw new Error('stored html missing for ' + handle.id)
  const pageUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html)

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1100, height: 950 } })
  // data: URL 的 goto 无 HTTP 响应（resp 为 null 是预期）——加载成功由后续
  // DOM 断言背书。
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })

  // table rendering
  const tableCount = await page.locator('table').count()
  check('pipe table rendered as <table>', tableCount === 1, `count=${tableCount}`)
  const thCount = await page.locator('th').count()
  const tdCount = await page.locator('td').count()
  check('table header cells (th=4)', thCount === 4, `th=${thCount}`)
  check('table body cells (td=16: 4 rows × 4 cols)', tdCount === 16, `td=${tdCount}`)

  // inline formats
  const strongCount = await page.locator('strong').count()
  const emCount = await page.locator('em').count()
  const codeCount = await page.locator('code').count()
  check('bold/italic/inline-code present', strongCount >= 1 && emCount >= 1 && codeCount >= 2, `strong=${strongCount} em=${emCount} code=${codeCount}`)

  // links: safe external kept, javascript: neutralized to '#'
  const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a')).map((a) => (a as HTMLAnchorElement).getAttribute('href')))
  check('external https link kept', hrefs.includes('https://example.com/docs'), JSON.stringify(hrefs))
  check('javascript: link neutralized to #', hrefs.includes('#'), JSON.stringify(hrefs))

  // lists
  const olCount = await page.locator('ol').count()
  const ulCount = await page.locator('ul').count()
  check('ordered+unordered lists', olCount === 1 && ulCount === 1, `ol=${olCount} ul=${ulCount}`)

  // code blocks incl mermaid raw
  const tsBlock = await page.locator('pre code.language-ts').count()
  const mermaidRaw = await page.locator('pre.mermaid-raw').count()
  check('ts code block with language class', tsBlock === 1, `count=${tsBlock}`)
  check('mermaid raw block', mermaidRaw === 1, `count=${mermaidRaw}`)

  // charset + CJK
  const charset = await page.evaluate(() => document.characterSet)
  const h1 = await page.locator('h1').first().textContent()
  check('UTF-8 + CJK heading intact', charset === 'UTF-8' && h1 === '渲染基座元素验证', `charset=${charset} h1=${JSON.stringify(h1)}`)

  // no script in DOM
  const scriptCount = await page.evaluate(() => document.querySelectorAll('script').length)
  check('zero <script> in DOM', scriptCount === 0, `count=${scriptCount}`)

  const shot = join(outDir, 'rendering-visual-elements.png')
  await page.screenshot({ path: shot, fullPage: true })
  await browser.close()

  console.log('=== rendering elements visual verification ===')
  for (const r of results) console.log(r)
  console.log(`\ntotal: ${pass + fail}, pass: ${pass}, fail: ${fail}`)
  console.log(`screenshot: ${shot}`)
  if (fail > 0) process.exit(1)
}

void main().catch((e) => {
  console.error('visual-table failed:', e)
  process.exit(1)
})
