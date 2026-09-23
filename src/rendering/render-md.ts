// v0.20 rendering base: zero-dependency markdown → HTML pure function.
//
// Supports a 10-item markdown subset (ATX headings, paragraphs, inline
// formatting, ordered/unordered lists, pipe tables, fenced code blocks,
// blockquotes, links, thematic breaks) plus mermaid/html fence passthrough.
// All text is HTML-escaped for XSS safety. Block-level parsing is a per-line
// state machine; inline parsing runs on already-escaped text within a block.

/** md → html. 零依赖. mermaid/html 围栏透传为 <pre class="mermaid-raw">, 归前端渲染. */
export function renderMarkdown(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  // current block state
  let i = 0
  // accumulate paragraph lines before flushing
  let para: string[] = []
  // accumulate list items (<li> html strings) before flushing
  let listItems: string[] = []
  let listOrdered = false
  // accumulate table rows (raw escaped-cell arrays) before flushing
  let tableRows: string[][] = []
  let tableHasHeader = false

  const flushPara = () => {
    if (para.length === 0) return
    const joined = para.join('\n')
    out.push(`<p>${renderInline(escaped(joined))}</p>`)
    para = []
  }
  const flushList = () => {
    if (listItems.length === 0) return
    const tag = listOrdered ? 'ol' : 'ul'
    out.push(`<${tag}>${listItems.join('')}</${tag}>`)
    listItems = []
    listOrdered = false
  }
  const flushTable = () => {
    if (tableRows.length === 0) return
    const rows = tableRows.length
    let html = '<table>'
    for (let r = 0; r < rows; r++) {
      const cells = tableRows[r]!
      const isHeader = tableHasHeader && r === 0
      const cellTag = isHeader ? 'th' : 'td'
      html += '<tr>'
      for (const c of cells) html += `<${cellTag}>${renderInline(c)}</${cellTag}>`
      html += '</tr>'
    }
    html += '</table>'
    out.push(html)
    tableRows = []
    tableHasHeader = false
  }
  const flushAll = () => {
    flushPara()
    flushList()
    flushTable()
  }

  while (i < lines.length) {
    const line = lines[i]!

    // --- fenced code block / passthrough ---
    const fence = matchFence(line)
    if (fence) {
      flushAll()
      const { lang, raw } = fence
      const body: string[] = []
      i++
      while (i < lines.length && !isFenceClose(lines[i]!)) {
        body.push(lines[i]!)
        i++
      }
      // close fence (if present) consumed; if EOF, auto-close.
      if (i < lines.length) i++
      const content = escaped(body.join('\n'))
      if (lang === 'mermaid') {
        out.push(`<pre class="mermaid-raw">${content}</pre>`)
      } else if (lang === 'html') {
        out.push(`<pre class="html-raw">${content}</pre>`)
      } else {
        const cls = lang ? ` class="language-${escapedAttr(lang)}"` : ''
        out.push(`<pre><code${cls}>${content}</code></pre>`)
      }
      continue
    }

    // --- blank line: block separator ---
    if (line.trim() === '') {
      flushAll()
      i++
      continue
    }

    // --- ATX heading ---
    const heading = matchHeading(line)
    if (heading) {
      flushAll()
      out.push(`<h${heading.level}>${renderInline(escaped(heading.text))}</h${heading.level}>`)
      i++
      continue
    }

    // --- thematic break ---
    if (isThematicBreak(line)) {
      flushAll()
      out.push('<hr>')
      i++
      continue
    }

    // --- blockquote (non-nested) ---
    const quoteMatch = /^>\s?(.*)$/.exec(line)
    if (quoteMatch) {
      flushAll()
      const quoteLines: string[] = []
      while (i < lines.length) {
        const m = /^>\s?(.*)$/.exec(lines[i]!)
        if (!m) break
        quoteLines.push(m[1]!)
        i++
      }
      // inner content parsed as a mini-markdown (paragraph + inline).
      out.push(`<blockquote>${renderInline(escaped(quoteLines.join('\n')))}</blockquote>`)
      continue
    }

    // --- table (pipe table) ---
    const cells = parseTableRow(line)
    if (cells !== null && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      flushAll()
      tableHasHeader = true
      tableRows.push(cells)
      i += 2 // header + separator
      while (i < lines.length) {
        const row = parseTableRow(lines[i]!)
        if (row === null) break
        tableRows.push(row)
        i++
      }
      flushTable()
      continue
    }

    // --- unordered list ---
    const ulMatch = /^[-*+]\s+(.*)$/.exec(line)
    if (ulMatch) {
      // flush non-list blocks
      flushPara()
      flushTable()
      // if previous list was ordered or none, start fresh
      if (listOrdered) flushList()
      listOrdered = false
      listItems.push(`<li>${renderInline(escaped(ulMatch[1]!))}</li>`)
      i++
      // continue collecting consecutive list items of same kind
      while (i < lines.length) {
        const m = /^[-*+]\s+(.*)$/.exec(lines[i]!)
        if (!m) {
          if (lines[i]!.trim() === '') break
          // ordered item ends unordered list
          if (/^\d+\.\s+/.test(lines[i]!)) break
          break
        }
        listItems.push(`<li>${renderInline(escaped(m[1]!))}</li>`)
        i++
      }
      continue
    }

    // --- ordered list ---
    const olMatch = /^(\d+)\.\s+(.*)$/.exec(line)
    if (olMatch) {
      flushPara()
      flushTable()
      if (!listOrdered) flushList()
      listOrdered = true
      listItems.push(`<li>${renderInline(escaped(olMatch[2]!))}</li>`)
      i++
      while (i < lines.length) {
        const m = /^(\d+)\.\s+(.*)$/.exec(lines[i]!)
        if (!m) {
          if (lines[i]!.trim() === '') break
          if (/^[-*+]\s+/.test(lines[i]!)) break
          break
        }
        listItems.push(`<li>${renderInline(escaped(m[2]!))}</li>`)
        i++
      }
      continue
    }

    // --- paragraph line ---
    para.push(line)
    i++
  }

  // close any open blocks at EOF
  flushAll()

  return out.join('\n')
}

// ---------- HTML escaping ----------

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escaped(s: string): string {
  // Escape text content (block bodies, code). Order matters: & first.
  let out = ''
  for (const ch of s) {
    out += HTML_ENTITIES[ch] ?? ch
  }
  return out
}

function escapedAttr(s: string): string {
  // For attributes (language class). Same set is sufficient.
  return escaped(s)
}

// ---------- inline parsing ----------

/**
 * Sanitize a link URL to a safe subset before emitting <a href>.
 * Allowlist: http:, https:, mailto:, and relative forms (#, /, ./, ../, or
 * any scheme-less relative path). Everything else (javascript:, data:,
 * vbscript:, file:, unknown schemes) is replaced with '#' so no executable
 * URL scheme can ever reach the href attribute. The check runs on the
 * entity-decoded, lowercased form so mixed-case / entity tricks fail closed.
 */
function safeHref(url: string): string {
  const decoded = url
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
    .toLowerCase()
  if (
    decoded.startsWith('http://') ||
    decoded.startsWith('https://') ||
    decoded.startsWith('mailto:') ||
    decoded.startsWith('#') ||
    decoded.startsWith('/') ||
    decoded.startsWith('./') ||
    decoded.startsWith('../') ||
    !decoded.includes(':')
  ) {
    return url
  }
  return '#'
}

/**
 * Render inline markdown on already-escaped text.
 * Supported: **bold**, __bold__, *italic*, _italic_, `code`, [text](url).
 * url gets re-escaped (it was already escaped once as text; we escape the
 * raw url separately). Since input is already escaped, we operate on the
 * escaped form and only transform recognized markers.
 */
function renderInline(text: string): string {
  // We process left-to-right with a cursor. Because text is already escaped,
  // < > & " ' are entity-encoded, so inline markers (`*`, `_`, `` ` ``, `[`)
  // are safe to scan for directly.
  let out = ''
  let i = 0
  const n = text.length

  const isMarker = (ch: string) => ch === '*' || ch === '_' || ch === '`' || ch === '['

  while (i < n) {
    const ch = text[i]!

    if (ch === '`') {
      // inline code: find closing backtick, content already escaped
      const end = text.indexOf('`', i + 1)
      if (end === -1) {
        out += ch
        i++
        continue
      }
      out += `<code>${text.slice(i + 1, end)}</code>`
      i = end + 1
      continue
    }

    if (ch === '*' || ch === '_') {
      // ** / __  → bold ; * / _ → italic. Try double first.
      if (text[i + 1] === ch) {
        const close = text.indexOf(ch + ch, i + 2)
        if (close !== -1) {
          out += `<strong>${renderInline(text.slice(i + 2, close))}</strong>`
          i = close + 2
          continue
        }
      } else {
        // single: italic. Opening marker must not be followed by whitespace
        // (CommonMark flanking). Closing marker must not be preceded by whitespace.
        if (text[i + 1] !== ' ' && text[i + 1] !== '\t' && text[i + 1] !== ch) {
          let j = i + 1
          while (j < n) {
            // skip ** (bold delimiter) sequences entirely
            if (text[j] === ch && text[j + 1] === ch) {
              j += 2
              continue
            }
            if (text[j] === ch && text[j + 1] !== ch && text[j - 1] !== ' ' && text[j - 1] !== '\t') break
            j++
          }
          if (j < n) {
            out += `<em>${renderInline(text.slice(i + 1, j))}</em>`
            i = j + 1
            continue
          }
        }
      }
      // no close: literal
      out += ch
      i++
      continue
    }

    if (ch === '[') {
      // [text](url) — note url in source may contain chars that are now
      // escaped (e.g. & → &amp;). We decode back? Simpler: scan raw, but text
      // is escaped. We match ]( pattern on escaped text; url portion keeps its
      // escaped form which is valid inside an attribute.
      const closeBracket = text.indexOf('](', i + 1)
      if (closeBracket !== -1) {
        const closeParen = text.indexOf(')', closeBracket + 2)
        if (closeParen !== -1) {
          const linkText = text.slice(i + 1, closeBracket)
          const url = text.slice(closeBracket + 2, closeParen)
          out += `<a href="${safeHref(url)}">${renderInline(linkText)}</a>`
          i = closeParen + 1
          continue
        }
      }
      out += ch
      i++
      continue
    }

    out += ch
    i++
  }

  return out
}

// ---------- block-level matchers ----------

interface Heading {
  level: number
  text: string
}

function matchHeading(line: string): Heading | null {
  const m = /^(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/.exec(line)
  if (!m) return null
  return { level: m[1]!.length, text: m[2]!.trim() }
}

function isThematicBreak(line: string): boolean {
  const t = line.trim()
  if (t.length < 3) return false
  const ch = t[0]!
  if (ch !== '-' && ch !== '*' && ch !== '_') return false
  for (const c of t) {
    if (c !== ch && c !== ' ') return false
  }
  // must contain at least 3 of ch
  let count = 0
  for (const c of t) if (c === ch) count++
  return count >= 3
}

interface FenceMatch {
  lang: string
  raw: string // raw lang token (may include extra)
}

function matchFence(line: string): FenceMatch | null {
  const t = line.trimStart()
  // 3+ backticks
  if (t.startsWith('```')) {
    const rest = t.slice(3)
    const lang = rest.trim().split(/\s+/)[0] ?? ''
    return { lang, raw: rest }
  }
  // 3+ tildes
  if (t.startsWith('~~~')) {
    const rest = t.slice(3)
    const lang = rest.trim().split(/\s+/)[0] ?? ''
    return { lang, raw: rest }
  }
  return null
}

function isFenceClose(line: string): boolean {
  const t = line.trim()
  return t === '```' || t === '~~~'
}

function parseTableRow(line: string): string[] | null {
  const t = line.trim()
  if (!t.includes('|')) return null
  // strip leading/trailing pipe
  let inner = t
  if (inner.startsWith('|')) inner = inner.slice(1)
  if (inner.endsWith('|') && !inner.endsWith('\\|')) inner = inner.slice(0, -1)
  // split on unescaped pipes
  const cells: string[] = []
  let cur = ''
  let j = 0
  while (j < inner.length) {
    const c = inner[j]!
    if (c === '\\' && inner[j + 1] === '|') {
      cur += '|'
      j += 2
      continue
    }
    if (c === '|') {
      cells.push(escaped(cur.trim()))
      cur = ''
      j++
      continue
    }
    cur += c
    j++
  }
  cells.push(escaped(cur.trim()))
  // must have at least one cell and at least one pipe was present
  if (cells.length < 1) return null
  return cells
}

function isTableSeparator(line: string): boolean {
  const cells = parseTableRow(line)
  if (!cells) return false
  if (cells.length === 0) return false
  for (const c of cells) {
    // c is escaped; separators are - : | space, all unchanged by escaping.
    if (!/^[-:\s]+$/.test(c)) return false
    if (!c.includes('-')) return false
  }
  return true
}
