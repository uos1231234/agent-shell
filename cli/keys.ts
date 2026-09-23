// v0.26 Wave 3 — byte-level key classifier (plan §5 "keys helper", constraint 9).
//
// Turns raw stdin chunks (string | Buffer) into semantic KeyEvents. Pure
// classification lives here; key *semantics* (what each key does to the
// editor) lives in cli/editor.ts.
//
// Chunk model (from the Wave 1 IME spike, cli/scratch-ime.log):
//   - chunks arrive per keystroke-commit; IME text arrives as complete UTF-8
//     runs, escape sequences arrive atomically in practice.
//   - BUT large pastes may split anywhere — so this decoder BUFFERS:
//       (a) an incomplete trailing UTF-8 multibyte sequence, and
//       (b) an incomplete trailing escape sequence (ESC seen, final byte not
//           yet arrived). A LONE ESC at end-of-chunk is emitted as 'esc'
//           immediately (the Esc key); a split arrow key across chunks is
//           therefore not reassembled after a lone-ESC flush — documented
//           limitation, acceptable because terminals send sequences in one
//           read.
//
// Zero npm dependencies. No src/** imports.

export type KnownKeyName =
  // editing keys
  | 'enter'
  | 'backspace'
  | 'delete'
  | 'esc'
  | 'tab'
  // caret motion
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'home'
  | 'end'
  // modifier word motion / kills (Alt/Ctrl-Left/Right, Alt-Backspace, Alt-D,
  // Alt-B, Alt-F — mission "word navigation")
  | 'word-left'
  | 'word-right'
  | 'kill-word-back'
  | 'kill-word-fwd'
  // control combos the editor binds (plan: kill-ring / undo / emacs basics)
  | 'ctrl+c'
  | 'ctrl+k'
  | 'ctrl+u'
  | 'ctrl+y'
  | 'ctrl+z'
  | 'ctrl+r'
  | 'ctrl+a'
  | 'ctrl+e'
  | 'ctrl+d'
  | 'alt+y'
  | 'alt+b'
  | 'alt+f'
  // Alt-D / Alt-Backspace classify directly to kill-word-fwd / kill-word-back
  // (terminal sequences alias to canonical key names — the editor switch
  // never sees alias names).
  // recognized but not actionable (unknown CSI, stray control bytes, ...)
  | 'unknown'

export type KeyEvent =
  | { kind: 'text'; chars: string }
  | { kind: 'key'; name: KnownKeyName }

const key = (name: KnownKeyName): KeyEvent => ({ kind: 'key', name })

const EMPTY: Uint8Array = new Uint8Array(0)

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/** UTF-8 sequence length from lead byte; 1 = ASCII or invalid (decodes to U+FFFD). */
function seqLen(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 2
  if (lead >= 0xe0 && lead <= 0xef) return 3
  if (lead >= 0xf0 && lead <= 0xf4) return 4
  return 1
}

/**
 * Decode the longest prefix of bytes[start, end) that ends on a code-point
 * boundary. Invalid bytes pass through and decode as U+FFFD (terminals send
 * valid UTF-8; this is damage control, not a validator).
 */
function decodeUtf8Prefix(bytes: Uint8Array, start: number, end: number): { text: string; complete: number } {
  let i = start
  while (i < end) {
    const len = seqLen(bytes[i]!)
    if (i + len > end) break // incomplete multibyte tail — hold it
    i += len
  }
  const complete = i - start
  const text =
    complete > 0 ? Buffer.from(bytes.buffer, bytes.byteOffset + start, complete).toString('utf8') : ''
  return { text, complete }
}

// ---------------------------------------------------------------------------
// KeyDecoder — stateful (holds the partial-tail buffer across feeds)
// ---------------------------------------------------------------------------

export class KeyDecoder {
  private pending: Uint8Array = EMPTY

  /** Discard any buffered partial sequence (used on programmatic setLine). */
  dropPending(): void {
    this.pending = EMPTY
  }

  /** Normalize one stdin chunk and return the key events it completes. */
  feed(data: string | Buffer): KeyEvent[] {
    const chunk = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    const bytes = this.pending.length === 0 ? chunk : concat(this.pending, chunk)
    this.pending = EMPTY

    const events: KeyEvent[] = []
    let i = 0
    let runStart = 0

    /** Emit a text run; hold back an incomplete trailing multibyte tail. */
    const flushRun = (end: number): void => {
      if (end <= runStart) return
      const { text, complete } = decodeUtf8Prefix(bytes, runStart, end)
      if (runStart + complete < end) this.pending = bytes.slice(runStart + complete, end)
      if (text !== '') events.push({ kind: 'text', chars: text })
    }

    while (i < bytes.length) {
      const b = bytes[i]!
      if (b === 0x1b) {
        flushRun(i)
        const next = i + 1 < bytes.length ? bytes[i + 1]! : undefined
        if (next === undefined) {
          // Lone ESC at end of chunk = Esc key (see header limitation).
          events.push(key('esc'))
          i += 1
          runStart = i
        } else if (next === 0x5b) {
          // CSI: scan to final byte in 0x40..0x7e.
          let j = i + 2
          while (j < bytes.length && !(bytes[j]! >= 0x40 && bytes[j]! <= 0x7e)) j++
          if (j >= bytes.length) {
            this.pending = bytes.slice(i) // incomplete CSI — hold from ESC on
            i = bytes.length
            runStart = i
            break
          }
          events.push(csiEvent(Buffer.from(bytes.subarray(i + 2, j)).toString('latin1'), String.fromCharCode(bytes[j]!)))
          i = j + 1
          runStart = i
        } else if (next === 0x4f) {
          // SS3 (application cursor mode): ESC O <char>.
          if (i + 2 >= bytes.length) {
            this.pending = bytes.slice(i)
            i = bytes.length
            runStart = i
            break
          }
          events.push(ss3Event(String.fromCharCode(bytes[i + 2]!)))
          i += 3
          runStart = i
        } else {
          // Alt-prefixed char: ESC <char>.
          events.push(altEvent(next))
          i += 2
          runStart = i
        }
      } else if (b < 0x20 || b === 0x7f) {
        flushRun(i)
        // Coalesce CRLF into one Enter.
        if (b === 0x0d && i + 1 < bytes.length && bytes[i + 1] === 0x0a) {
          events.push(key('enter'))
          i += 2
        } else {
          events.push(controlEvent(b))
          i += 1
        }
        runStart = i
      } else {
        i += 1
      }
    }
    flushRun(bytes.length)
    return events
  }
}

// ---------------------------------------------------------------------------
// Sequence mappers
// ---------------------------------------------------------------------------

function csiEvent(params: string, final: string): KeyEvent {
  switch (final) {
    case 'A':
      return key('up')
    case 'B':
      return key('down')
    case 'C':
      return hasWordModifier(params) ? key('word-right') : key('right')
    case 'D':
      return hasWordModifier(params) ? key('word-left') : key('left')
    case 'H':
      return key('home')
    case 'F':
      return key('end')
    case '~':
      return tildeEvent(params)
    case 'u':
      return kittyEvent(params)
    default:
      return key('unknown')
  }
}

/** CSI params "1;3" (Alt) / "1;5" (Ctrl) → word motion; plain → single step. */
function hasWordModifier(params: string): boolean {
  const last = params.split(';').pop() ?? ''
  return last === '3' || last === '5'
}

function tildeEvent(params: string): KeyEvent {
  const parts = params.split(';')
  switch (parts[0] ?? '') {
    case '1':
    case '7':
      return key('home')
    case '3':
      return params === '3;3' ? key('kill-word-fwd') : key('delete') // Alt+Delete
    case '4':
    case '8':
      return key('end')
    default:
      return key('unknown')
  }
}

/** Kitty keyboard protocol: CSI unicode-key-code;modifiers u. Only Ctrl+Shift+Z (redo) is mapped. */
function kittyEvent(params: string): KeyEvent {
  const [code, modRaw] = params.split(';')
  const mod = Number(modRaw ?? '1')
  // modifier = 1 + shift(1) + alt(2) + ctrl(4); require shift and ctrl bits.
  if (code === '122' && mod >= 1 && ((mod - 1) & 0b101) === 0b101) return key('ctrl+r')
  return key('unknown')
}

function ss3Event(ch: string): KeyEvent {
  switch (ch) {
    case 'A':
      return key('up')
    case 'B':
      return key('down')
    case 'C':
      return key('right')
    case 'D':
      return key('left')
    case 'H':
      return key('home')
    case 'F':
      return key('end')
    default:
      return key('unknown')
  }
}

function altEvent(byte: number): KeyEvent {
  switch (byte) {
    case 0x7f:
    case 0x08:
      return key('kill-word-back') // Alt-Backspace
    case 0x62:
      return key('word-left') // Alt-B
    case 0x66:
      return key('word-right') // Alt-F
    case 0x64:
      return key('kill-word-fwd') // Alt-D
    case 0x79:
      return key('alt+y') // Alt-Y — cycle yank
    default:
      return key('unknown')
  }
}

function controlEvent(b: number): KeyEvent {
  switch (b) {
    case 0x0d:
    case 0x0a:
      return key('enter')
    case 0x7f:
    case 0x08:
      return key('backspace')
    case 0x09:
      return key('tab')
    case 0x03:
      return key('ctrl+c')
    case 0x01:
      return key('ctrl+a')
    case 0x05:
      return key('ctrl+e')
    case 0x0b:
      return key('ctrl+k')
    case 0x15:
      return key('ctrl+u')
    case 0x19:
      return key('ctrl+y')
    case 0x1a:
      return key('ctrl+z')
    case 0x12:
      return key('ctrl+r')
    case 0x04:
      return key('ctrl+d')
    default:
      return key('unknown')
  }
}
