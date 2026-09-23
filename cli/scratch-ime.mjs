// v0.26 Wave 1 — IME spike scratch script (NOT part of the TUI, do not ship).
//
// Purpose: empirically test how a Node raw-mode program receives keyboard
// input on this Windows machine, distinguishing printable text (including
// IME-committed Chinese) from escape sequences.
//
// Usage:
//   node cli/scratch-ime.mjs            (interactive — run inside Windows Terminal)
//   node cli/scratch-ime.mjs --auto     (no raw mode; for pipe / ConPTY-driven runs)
//
// Evidence is appended to cli/scratch-ime.log (hex + classification per chunk)
// so a run in a separate terminal window still leaves an inspectable record.
// Exit: Ctrl-C (\x03) or EOF.

import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const logFile = join(here, 'scratch-ime.log')
const auto = process.argv.includes('--auto')
const isTty = process.stdin.isTTY === true

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`
  process.stdout.write(stamped + '\n')
  try { appendFileSync(logFile, stamped + '\n') } catch { /* evidence is best-effort */ }
}

log(`start: isTTY=${isTty} rawRequested=${!auto} platform=${process.platform} node=${process.version}`)

if (!auto && isTty) {
  process.stdin.setRawMode(true)
  log('raw mode: ON')
} else {
  log('raw mode: OFF (pipe / --auto)')
}

process.stdin.on('data', (chunk) => {
  // Node 24 finding (verified empirically): setEncoding(null) yields STRING
  // chunks; default (no setEncoding) yields Buffers. Normalize to Buffer.
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
  const hex = [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ')
  const text = buf.toString('utf8')
  const isEscape = buf.includes(0x1b)
  // A "printable text" chunk contains at least one byte >= 0x20 or a UTF-8
  // multibyte lead, and no ESC. Chinese IME commit arrives as UTF-8 multibytes.
  const hasPrintable = [...buf].some((b) => (b >= 0x20 && b !== 0x7f) || b >= 0x80)
  log(`data: isBuffer=${Buffer.isBuffer(chunk)} bytes=${buf.length} hex=[${hex}] escape=${isEscape} printable=${hasPrintable} utf8="${text.replace(/\r/g, '<CR>').replace(/\n/g, '<LF>').replace(/\x1b/g, '<ESC>')}"`)
})
process.stdin.setEncoding(null) // documented above: yields string chunks (kept to pin the behavior)

process.stdin.on('end', () => { log('stdin end'); process.exit(0) })
process.stdin.on('error', (e) => { log(`stdin error: ${e.message}`); process.exit(1) })

// Auto-exit for ConPTY-driven runs so the harness does not hang: after the
// first data chunk containing CR, exit 0 shortly after.
let sawCr = false
process.stdin.on('data', (buf) => {
  if (buf.includes(0x0d)) sawCr = true
  if (sawCr) setTimeout(() => { log('auto-exit after CR chunk'); process.exit(0) }, 300)
})

process.stdout.write('IME-SPIKE-READY: type or inject input now\n')
