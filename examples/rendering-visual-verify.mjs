// v0.20 rendering base — headless browser visual verification (sub-agent task 2).
// Uses global playwright to open the preview server page, verify CJK rendering,
// mermaid passthrough as code block, markdown elements, and capture screenshots.
// Run: node examples/rendering-visual-verify.mjs <artifactUrl> <outDir>

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// global playwright lives outside the workspace — resolve explicitly
const { chromium } = require(process.env.PLAYWRIGHT_GLOBAL_PATH)

const url = process.argv[2] ?? 'http://127.0.0.1:55190/artifact/473595671973b494'
const outDir = process.argv[3] ?? 'C:/Users/HP/.zcode/cli/artifacts'
mkdirSync(outDir, { recursive: true })

let pass = 0
let fail = 0
const results = []
const check = (name, ok, evidence) => {
  if (ok) pass++
  else fail++
  results.push(`${ok ? '[PASS]' : '[FAIL]'} ${name}\n       evidence: ${evidence}`)
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })

const consoleErrors = []
page.on('pageerror', (e) => consoleErrors.push(String(e)))

const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
check('Page loads with HTTP 200', resp.status() === 200, `status=${resp.status()}`)

// charset: document.characterSet must be UTF-8 (P1 charset fix verification)
const charset = await page.evaluate(() => document.characterSet)
check('Charset is UTF-8 (no GBK mojibake)', charset === 'UTF-8', `document.characterSet=${charset}`)

// CJK text renders correctly (no mojibake/replacement chars)
const h1 = await page.locator('h1').first().textContent()
check('Chinese heading intact', h1 === '代码 Wiki 知识库快照', `h1=${JSON.stringify(h1)}`)

const bodyText = await page.locator('body').innerText()
const hasReplacementChar = bodyText.includes('\uFFFD')
check('No U+FFFD replacement chars in body', !hasReplacementChar, `hasReplacementChar=${hasReplacementChar}`)
const cjkSample = ['生成时间', '核心结构链', '属于', '关系链', '函数卡片'].filter((t) => bodyText.includes(t))
check('All sampled CJK strings present', cjkSample.length === 5, `found=${cjkSample.length}/5: ${cjkSample.join(',')}`)

// mermaid: raw passthrough code block, NOT executed / not raw svg
const mermaidCount = await page.locator('pre.mermaid-raw').count()
check('mermaid fence renders as <pre class="mermaid-raw"> block', mermaidCount === 1, `count=${mermaidCount}`)
const mermaidText = await page.locator('pre.mermaid-raw').first().innerText()
check('mermaid content is source code (graph TD ... -->)', mermaidText.includes('graph TD') && mermaidText.includes('-->|属于|'), JSON.stringify(mermaidText.slice(0, 80)))
const svgCount = await page.locator('svg').count()
check('No <svg> produced (mermaid NOT executed)', svgCount === 0, `svg count=${svgCount}`)

// markdown elements
const counts = await page.evaluate(() => ({
  h1: document.querySelectorAll('h1').length,
  h2: document.querySelectorAll('h2').length,
  h3: document.querySelectorAll('h3').length,
  blockquote: document.querySelectorAll('blockquote').length,
  ul: document.querySelectorAll('ul').length,
  li: document.querySelectorAll('li').length,
  code: document.querySelectorAll('code').length,
  hr: document.querySelectorAll('hr').length,
  strong: document.querySelectorAll('strong').length,
  p: document.querySelectorAll('p').length,
}))
check(
  'Markdown elements rendered (headings/blockquote/list/code/hr/strong)',
  counts.h1 === 1 && counts.h2 >= 2 && counts.h3 >= 2 && counts.blockquote >= 2 && counts.ul >= 2 && counts.li >= 2 && counts.code >= 2 && counts.hr >= 1 && counts.strong >= 4 && counts.p >= 3,
  JSON.stringify(counts),
)

// no script tags injected
const scriptCount = await page.evaluate(() => document.querySelectorAll('script').length)
check('Zero <script> elements in DOM', scriptCount === 0, `script count=${scriptCount}`)

check('No page JS errors', consoleErrors.length === 0, consoleErrors.join('; ') || 'none')

// screenshots: full page + zoomed top section
const shotFull = join(outDir, 'rendering-visual-fullpage.png')
await page.screenshot({ path: shotFull, fullPage: true })
const shotTop = join(outDir, 'rendering-visual-top.png')
await page.screenshot({ path: shotTop, clip: { x: 0, y: 0, width: 1100, height: 620 } })

// targeted screenshots for evidence: mermaid block + a table-free section is fine;
// also capture the list endpoint page via fetch (JSON) separately in the shell.

await browser.close()

console.log('=== rendering visual verification ===')
for (const r of results) console.log(r)
console.log(`\ntotal: ${pass + fail}, pass: ${pass}, fail: ${fail}`)
console.log(`screenshots: ${shotFull}\n             ${shotTop}`)
if (fail > 0) process.exit(1)
