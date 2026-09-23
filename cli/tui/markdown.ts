// v0.26 Wave 1 — minimal markdown → terminal lines renderer.
//
// Deliberate MINIMAL subset (plan §5): ATX headings, unordered lists, fenced
// code blocks, blockquotes, inline bold/italic/code, paragraphs — plus CJK-
// aware wrapping (wide chars count 2 columns). Wave A additions: GFM pipe
// tables (column-aligned, evenly truncated to terminal width), ordered lists,
// task lists (✓/☐), strikethrough (~~x~~), horizontal rules. NOT a markdown
// engine: no nested quotes, no links, no reference definitions, no syntax
// highlighting, no LaTeX. Zero npm dependencies; inline emphasis maps to
// plain ANSI SGR attributes.

// ---------------------------------------------------------------------------
// ANSI + width primitives (exported for tests / future editor reuse)
// ---------------------------------------------------------------------------

export const ANSI = {
  bold: '\x1b[1m',
  italic: '\x1b[3m',
  strike: '\x1b[9m',
  code: '\x1b[7m', // reverse video for code spans
  reset: '\x1b[0m',
} as const

/** East-Asian Wide code points count 2 terminal columns (UAX #11 subset). */
export function charWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals .. CJK Symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana .. CJK Compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) // Fullwidth Signatures
  ) {
    return 2
  }
  return 1
}

const CSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g

export function stripAnsi(s: string): string {
  return s.replace(CSI_RE, '')
}

/** Visible terminal columns of a string, ignoring ANSI SGR sequences. */
export function visibleWidth(s: string): number {
  let w = 0
  for (const ch of Array.from(stripAnsi(s))) w += charWidth(ch.codePointAt(0) ?? 0)
  return w
}

type Token = { text: string; width: number }

/** Tokenize into atomic pieces: ANSI escapes (zero width) and code points. */
function tokenize(s: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < s.length) {
    CSI_RE.lastIndex = i
    const m = CSI_RE.exec(s)
    if (m && m.index === i) {
      tokens.push({ text: m[0], width: 0 })
      i += m[0].length
    } else {
      const cp = s.codePointAt(i) ?? 0
      const ch = String.fromCodePoint(cp)
      tokens.push({ text: ch, width: charWidth(cp) })
      i += ch.length
    }
  }
  return tokens
}

/**
 * Greedy word wrap that is CJK-aware (break anywhere between wide chars)
 * and ANSI-safe (never splits an escape sequence). Lines carry whatever SGR
 * state crosses the break — real terminals keep attributes across rows.
 */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width)
  const lines: string[] = []
  let cur = ''
  let curW = 0
  let lastSpace = -1 // string index of the last space inside cur

  for (const t of tokenize(text)) {
    if (t.width === 0) {
      cur += t.text
      continue
    }
    if (t.text === ' ') {
      if (curW === 0) continue // collapse leading spaces
      if (cur.endsWith(' ')) continue // collapse consecutive spaces
      cur += t.text
      curW += 1
      lastSpace = cur.length - 1
      continue
    }
    if (curW + t.width > w && curW > 0) {
      if (lastSpace > 0) {
        lines.push(cur.slice(0, lastSpace))
        cur = cur.slice(lastSpace + 1)
      } else {
        lines.push(cur)
        cur = ''
      }
      cur = cur.replace(/^ +/, '')
      curW = visibleWidth(cur)
      lastSpace = -1
    }
    cur += t.text
    curW += t.width
  }
  if (cur !== '') lines.push(cur)
  return lines.length > 0 ? lines : ['']
}

// ---------------------------------------------------------------------------
// Inline formatting
// ---------------------------------------------------------------------------

/** `code` → reverse-video, **bold** → bold, ~~strike~~ → SGR 9, *italic* → italic (code wins). */
export function parseInline(text: string): string {
  return text
    .split(/(`[^`]+`)/g)
    .map((part) => {
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
        return ANSI.code + part.slice(1, -1) + ANSI.reset
      }
      return part
        .replace(/\*\*([^*]+)\*\*/g, `${ANSI.bold}$1${ANSI.reset}`)
        .replace(/~~([^~]+)~~/g, `${ANSI.strike}$1${ANSI.reset}`)
        .replace(/\*([^*]+)\*/g, `${ANSI.italic}$1${ANSI.reset}`)
    })
    .join('')
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

const HANGING = '  ' // code-block / continuation indent

// ---------------------------------------------------------------------------
// GFM pipe tables（Wave A）
// ---------------------------------------------------------------------------

/** 表行 → 单元格（trim 前后管道；单元格内的 `|` 不支持转义——已知局限）。 */
function splitTableRow(raw: string): string[] {
  let line = raw.trim()
  if (line.startsWith('|')) line = line.slice(1)
  if (line.endsWith('|')) line = line.slice(0, -1)
  return line.split('|').map((c) => c.trim())
}

/** GFM 分隔行：每个单元格都是 `---` / `:---:` / `---:` 形态。 */
function isTableDelimiter(raw: string): boolean {
  const cells = splitTableRow(raw)
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c))
}

/** 截断到 maxW 可见列；被截时以 '…'（宽 1）收尾。CJK/ANSI 安全。
 *  （导出供 app.ts 的 memory 分隔行复用——同一 CJK 宽度口径。） */
export function truncateVisible(s: string, maxW: number): string {
  if (visibleWidth(s) <= maxW) return s
  let out = ''
  let w = 0
  for (const ch of Array.from(s)) {
    const cw = charWidth(ch.codePointAt(0) ?? 0)
    if (w + cw > maxW - 1) break // 留一列给省略号
    out += ch
    w += cw
  }
  return out + '…'
}

/** 用空格把可见宽度补齐到 targetW（CJK 感知 padEnd）。 */
function padToWidth(s: string, targetW: number): string {
  let out = s
  while (visibleWidth(out) < targetW) out += ' '
  return out
}

/**
 * GFM 管道表格：列宽取各列最宽单元格；总宽超出终端时各列均匀截断到同一
 * 上限（"均匀截断"）。rows 含表头 + 分隔行 + 数据行；分隔行重画为与列宽
 * 对齐的虚线。
 */
function renderTable(rows: readonly (readonly string[])[], w: number): string[] {
  const header = rows[0]!
  const cols = header.length
  const norm = rows.map((r) => {
    const cells = r.slice(0, cols)
    while (cells.length < cols) cells.push('')
    return cells
  })

  const widths: number[] = []
  // 列宽只算表头 + 数据行（分隔行由虚线重画，不参与计宽）。
  const dataRows = [norm[0]!, ...norm.slice(2)]
  for (let c = 0; c < cols; c++) {
    widths.push(Math.max(1, ...dataRows.map((r) => visibleWidth(r[c] ?? ''))))
  }
  // 行格式 '| cell | cell |'：固定开销 = 2（首尾）+ 3×(cols-1)（' | ' 分隔）+ 1 尾 = 3*cols+1
  const overhead = 3 * cols + 1
  const total = overhead + widths.reduce((a, b) => a + b, 0)
  const cap = total > w ? Math.max(1, Math.floor((w - overhead) / cols)) : Infinity
  const colW = widths.map((x) => Math.min(x, cap))

  const renderRow = (cells: readonly string[]): string =>
    '| ' +
    cells.map((c, i) => padToWidth(truncateVisible(c, colW[i]!), colW[i]!)).join(' | ') +
    ' |'

  const out = [renderRow(norm[0]!)]
  out.push('| ' + colW.map((x) => '-'.repeat(x)).join(' | ') + ' |')
  for (let r = 2; r < norm.length; r++) out.push(renderRow(norm[r]!))
  return out
}

/**
 * Render a markdown string into terminal lines, each ≤ width visible columns.
 * Pure function: same inputs → same lines (line-diff fast path friendly).
 */
export function renderMarkdownToLines(md: string, width: number): string[] {
  const w = Math.max(1, width)
  const out: string[] = []
  let para: string[] = []
  let inFence = false

  const flushPara = (): void => {
    if (para.length === 0) return
    out.push(...wrapText(parseInline(para.join(' ')), w))
    para = []
  }

  /** 列表行共用（无序 / 有序 / 任务）：hanging 缩进 + 宽度换行。 */
  const pushListItem = (indent: string, marker: string, body: string): void => {
    const depth = Math.floor(indent.length / 2)
    const prefix = HANGING.repeat(depth) + marker
    const content = wrapText(parseInline(body), Math.max(1, w - visibleWidth(prefix)))
    out.push(prefix + (content[0] ?? ''))
    for (let i = 1; i < content.length; i++) {
      out.push(' '.repeat(visibleWidth(prefix)) + (content[i] ?? ''))
    }
  }

  const lines = md.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!

    if (/^\s*```/.test(raw)) {
      flushPara()
      inFence = !inFence // fence delimiters themselves are invisible
      continue
    }
    if (inFence) {
      const wrapped = wrapText(raw, w - HANGING.length)
      if (wrapped.length === 1 && wrapped[0] === '') out.push(HANGING)
      else for (const l of wrapped) out.push(HANGING + l)
      continue
    }
    if (/^\s*$/.test(raw)) {
      flushPara()
      continue
    }

    const heading = raw.match(/^#{1,6}\s+(.*)$/)
    if (heading !== null && heading[1] !== undefined) {
      flushPara()
      out.push(...wrapText(ANSI.bold + parseInline(heading[1]) + ANSI.reset, w))
      continue
    }

    // 水平线：--- / *** / ___ / - - -（同一字符重复 3+ 次，可夹空格）
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(raw)) {
      flushPara()
      out.push('─'.repeat(w))
      continue
    }

    // GFM 表格：本行含 '|' 且下一行是分隔行 → 收集整块渲染；否则按普通
    // 段落处理（GFM 要求表头 + 分隔行成对出现）。
    if (raw.includes('|') && i + 1 < lines.length && isTableDelimiter(lines[i + 1]!)) {
      flushPara()
      const block: string[] = []
      while (i < lines.length && lines[i]!.includes('|')) block.push(lines[i++]!)
      i-- // for 循环再 +1，回退到块后的第一行
      out.push(...renderTable(block.map(splitTableRow), w))
      continue
    }

    // 有序列表（1. / 1)）；嵌套按 2 空格一层（与无序列表同口径）
    const ordered = raw.match(/^(\s*)(\d{1,9})[.)]\s+(.*)$/)
    if (ordered !== null && ordered[1] !== undefined && ordered[3] !== undefined) {
      flushPara()
      pushListItem(ordered[1], `${ordered[2]}. `, ordered[3])
      continue
    }

    // 无序列表 + 任务列表：`- [x] ` → ✓、`- [ ] ` → ☐
    const listItem = raw.match(/^(\s*)[-*+]\s+(.*)$/)
    if (listItem !== null && listItem[1] !== undefined && listItem[2] !== undefined) {
      flushPara()
      const task = listItem[2].match(/^\[([ xX])\]\s+(.*)$/)
      if (task !== null && task[1] !== undefined && task[2] !== undefined) {
        pushListItem(listItem[1], task[1] === ' ' ? '☐ ' : '✓ ', task[2])
      } else {
        pushListItem(listItem[1], '- ', listItem[2])
      }
      continue
    }

    const quote = raw.match(/^>\s?(.*)$/)
    if (quote !== null && quote[1] !== undefined) {
      flushPara()
      const content = wrapText(parseInline(quote[1]), Math.max(1, w - 2))
      for (const l of content) out.push('> ' + l)
      continue
    }

    para.push(raw.trim())
  }
  flushPara()
  return out
}
