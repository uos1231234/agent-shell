// v0.26 Wave 3 — LineEditor: the full prompt-line editor (plan §5, constraint 9 / G1).
//
// Self-authored, ZERO npm dependencies, no src/** imports (app-side UI, pure —
// all I/O is injected: input arrives via handleKey, output is a pure
// render(width) that TuiScreen diffs). Byte classification lives in
// cli/keys.ts (KeyDecoder); key semantics live here.
//
// IME verdict (cli/scratch-ime.log, user-verified): Windows Terminal raw-mode
// stdin receives committed IME text byte-exact — full editor approved.
//
// ---------------------------------------------------------------------------
// Semantics contract (documented deviations / choices, plan §5):
//   - Enter commit: CALLBACK, not a drained queue. `onCommit(cb)` — every
//     Enter fires cb(line) (including the empty line; the app decides whether
//     an empty submit means anything). After commit the editor resets: empty
//     line, undo/redo cleared, history navigation closed.
//   - History: injected read-only — `setHistory(getEntries, maxEntries?)`.
//     The editor only NAVIGATES (Up/Down); the app owns persistence (it
//     appends committed lines to its own store). maxEntries bounds how far
//     back navigation may go from the most recent entry. Navigating stashes
//     the draft; Down past the newest entry restores it. Edits made while
//     navigating keep the navigation position.
//   - Undo granularity = one handleKey CHUNK (every mutation caused by a
//     single chunk is one undo step). A multi-char text chunk is a paste
//     burst and is therefore exactly one undo step. Movement / history
//     navigation / abort never push undo.
//   - setLine (blocked-command restore, app-driven): replaces text, caret to
//     end, drops a partial input buffer. Does NOT touch undo/redo or the
//     kill ring — programmatic substitution is not a user mutation.
//   - Ctrl-C: calls the onAbort hook (if any) and is consumed. The editor
//     NEVER exits the process — exit policy belongs to the app.
//   - Yank span: Ctrl-Y records the inserted span; Alt-Y replaces that span
//     with the next ring entry (cycling). Any mutation other than
//     yank/Alt-Y clears the span (caret movement does not).
//   - Kill ring: every non-empty kill unshifts the ring (cap 10); kills are
//     NOT merged (each Ctrl-K/Ctrl-U/Alt-Backspace is its own entry).
//   - Esc / Tab / unrecognized sequences: consumed, no-op (Tab completion is
//     Wave 4; overlays use Esc from Wave 4/5).
//
// Rendering: pure function of state. The caret is drawn as a reverse-video
// cell at its display column (CJK width aware via charWidth from the
// markdown module); a caret at end-of-line renders as a reverse-video space.
// Long input wraps to continuation rows (no prompt indent, no space
// collapsing — the editor must show the user's exact text).

import type { TuiComponent } from './tui/renderer.js'
import { KeyDecoder, type KnownKeyName, type KeyEvent } from './keys.js'
import { charWidth } from './tui/markdown.js'

// ---------------------------------------------------------------------------
// code-point / word helpers
// ---------------------------------------------------------------------------

/** String index one code point to the left of i (surrogate-pair safe). */
function stepLeft(s: string, i: number): number {
  if (i <= 0) return 0
  const code = s.charCodeAt(i - 1)
  if (code >= 0xdc00 && code <= 0xdfff && i >= 2) {
    const prev = s.charCodeAt(i - 2)
    if (prev >= 0xd800 && prev <= 0xdbff) return i - 2
  }
  return i - 1
}

/** String index one code point to the right of i (surrogate-pair safe). */
function stepRight(s: string, i: number): number {
  if (i >= s.length) return s.length
  const cp = s.codePointAt(i) ?? 0
  return i + (cp > 0xffff ? 2 : 1)
}

/** Wide (CJK/fullwidth) code point — one word unit per contiguous run. */
const isWide = (s: string, i: number): boolean => charWidth(s.codePointAt(i) ?? 0) === 2

/** ASCII word character (letters / digits / underscore). */
const isWordChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch)

/**
 * Separator = neither wide nor an ASCII word char (spaces, punctuation).
 * Word rules (plan / mission): ASCII runs split on spaces/punct; a CJK run is
 * ONE word; a CJK<->ASCII transition always splits.
 */
const isSep = (s: string, i: number): boolean => !isWide(s, i) && !isWordChar(s[i] ?? '')

/** Caret index after jumping one word left from `caret` (emacs-style). */
export function wordLeft(s: string, caret: number): number {
  let i = caret
  while (i > 0 && isSep(s, i - 1)) i = stepLeft(s, i)
  if (i > 0) {
    if (isWide(s, i - 1)) {
      while (i > 0 && isWide(s, i - 1)) i = stepLeft(s, i)
    } else {
      while (i > 0 && !isSep(s, i - 1) && !isWide(s, i - 1)) i = stepLeft(s, i)
    }
  }
  return i
}

/** Caret index after jumping one word right from `caret` (emacs-style). */
export function wordRight(s: string, caret: number): number {
  const len = s.length
  let i = caret
  while (i < len && isSep(s, i)) i = stepRight(s, i)
  if (i < len) {
    if (isWide(s, i)) {
      while (i < len && isWide(s, i)) i = stepRight(s, i)
    } else {
      while (i < len && !isSep(s, i) && !isWide(s, i)) i = stepRight(s, i)
    }
  }
  return i
}

// ---------------------------------------------------------------------------
// LineEditor
// ---------------------------------------------------------------------------

export type EditorSnapshot = { text: string; caret: number }

const UNDO_CAP = 200
const RING_CAP = 10
const PROMPT = '> '

const reverseVideo = (ch: string): string => `\x1b[7m${ch}\x1b[0m`

export class LineEditor implements TuiComponent {
  private text = ''
  private caret = 0
  private readonly decoder = new KeyDecoder()

  private undoStack: EditorSnapshot[] = []
  private redoStack: EditorSnapshot[] = []

  private ring: string[] = []
  private yankSpan: { start: number; end: number } | null = null
  private yankNext = 0 // next ring index Alt-Y will surface

  private historyFn: (() => readonly string[]) | null = null
  private historyMax = 1000
  private historyIndex: number | null = null // null = at draft
  private historyDraft = ''

  private commitCb: ((line: string) => void) | null = null
  private abortCb: (() => void) | null = null

  // -- public API -----------------------------------------------------------

  getLine(): string {
    return this.text
  }

  getCaret(): number {
    return this.caret
  }

  /** Programmatic replacement (blocked-command restore). See header contract. */
  setLine(s: string): void {
    this.text = s
    this.caret = s.length
    this.decoder.dropPending()
  }

  /** Inject the history source (read-only navigation). See header contract. */
  setHistory(getEntries: () => readonly string[], maxEntries?: number): void {
    this.historyFn = getEntries
    if (maxEntries !== undefined) this.historyMax = Math.max(1, maxEntries)
  }

  /** Enter-commit callback. Fired on EVERY Enter, including the empty line. */
  onCommit(cb: (line: string) => void): void {
    this.commitCb = cb
  }

  /** Ctrl-C hook. The editor never exits the process (header contract). */
  onAbort(cb: () => void): void {
    this.abortCb = cb
  }

  /**
   * Consume one raw stdin chunk (string | Buffer — normalized here; partial
   * UTF-8 / escape tails are buffered inside the KeyDecoder). Undo
   * granularity = this chunk. Always returns true: a focused editor consumes
   * all input.
   */
  handleKey(data: string | Buffer): boolean {
    const events = this.decoder.feed(data)
    if (events.length === 0) return true
    const before: EditorSnapshot = { text: this.text, caret: this.caret }
    let mutated = false
    for (const ev of events) {
      if (this.applyEvent(ev)) mutated = true
    }
    if (mutated) this.pushUndo(before)
    return true
  }

  /** TuiComponent seam (TuiScreen normalizes Buffers to strings already). */
  handleInput(data: string | Buffer): boolean {
    return this.handleKey(data)
  }

  /** Stateless render — nothing to invalidate (diffing is TuiScreen's job). */
  invalidate(): void {}

  render(width: number): string[] {
    const w = Math.max(1, width)
    const promptW = PROMPT.length
    const rows: string[] = []
    let row = PROMPT
    let rowW = promptW

    const emit = (ch: string, isCaret: boolean): void => {
      const cw = charWidth(ch.codePointAt(0) ?? 0)
      if (rowW + cw > w) {
        rows.push(row)
        row = ''
        rowW = 0
      }
      row += isCaret ? reverseVideo(ch) : ch
      rowW += cw
    }

    let i = 0
    while (i < this.text.length) {
      const cp = this.text.codePointAt(i) ?? 0
      emit(String.fromCodePoint(cp), i === this.caret)
      i += cp > 0xffff ? 2 : 1
    }
    if (this.caret >= this.text.length) emit(' ', true) // caret at end → reverse block
    rows.push(row)
    return rows
  }

  // -- event application ------------------------------------------------------

  private applyEvent(ev: KeyEvent): boolean {
    if (ev.kind === 'text') return this.insert(ev.chars)
    return this.applyKey(ev.name)
  }

  private applyKey(name: KnownKeyName): boolean {
    switch (name) {
      case 'enter':
        this.commit()
        return false
      case 'backspace': {
        const start = stepLeft(this.text, this.caret)
        if (start === this.caret) return false
        this.splice(start, this.caret, '')
        this.caret = start
        return true
      }
      case 'delete':
      case 'ctrl+d': {
        const end = stepRight(this.text, this.caret)
        if (end === this.caret) return false
        this.splice(this.caret, end, '')
        return true
      }
      case 'left':
        this.caret = stepLeft(this.text, this.caret)
        return false
      case 'right':
        this.caret = stepRight(this.text, this.caret)
        return false
      case 'home':
      case 'ctrl+a':
        this.caret = 0
        return false
      case 'end':
      case 'ctrl+e':
        this.caret = this.text.length
        return false
      case 'up':
        this.historyPrev()
        return false
      case 'down':
        this.historyNext()
        return false
      case 'word-left':
        this.caret = wordLeft(this.text, this.caret)
        return false
      case 'word-right':
        this.caret = wordRight(this.text, this.caret)
        return false
      case 'kill-word-back': {
        const start = wordLeft(this.text, this.caret)
        if (start === this.caret) return false
        this.pushKill(this.text.slice(start, this.caret))
        this.splice(start, this.caret, '')
        this.caret = start
        return true
      }
      case 'kill-word-fwd': {
        const end = wordRight(this.text, this.caret)
        if (end === this.caret) return false
        this.pushKill(this.text.slice(this.caret, end))
        this.splice(this.caret, end, '')
        return true
      }
      case 'ctrl+k': {
        if (this.caret >= this.text.length) return false
        this.pushKill(this.text.slice(this.caret))
        this.splice(this.caret, this.text.length, '')
        return true
      }
      case 'ctrl+u': {
        if (this.caret === 0) return false
        this.pushKill(this.text.slice(0, this.caret))
        this.splice(0, this.caret, '')
        this.caret = 0
        return true
      }
      case 'ctrl+y': {
        const y = this.ring[0]
        if (y === undefined || y === '') return false
        this.splice(this.caret, this.caret, y)
        this.caret += y.length
        this.yankSpan = { start: this.caret - y.length, end: this.caret }
        this.yankNext = 1
        return true
      }
      case 'alt+y': {
        const span = this.yankSpan
        if (span === null || this.ring.length < 2) return false
        const next = this.yankNext % this.ring.length
        const y = this.ring[next]
        if (y === undefined) return false
        this.splice(span.start, span.end, y)
        this.caret = span.start + y.length
        this.yankSpan = { start: span.start, end: this.caret }
        this.yankNext = (next + 1) % this.ring.length
        return true
      }
      case 'ctrl+z':
        this.undo()
        return false
      case 'ctrl+r':
        this.redo()
        return false
      case 'ctrl+c':
        this.abortCb?.()
        return false
      case 'esc':
      case 'tab':
      case 'alt+b':
      case 'alt+f':
      case 'unknown':
        return false
    }
  }

  // -- mutations --------------------------------------------------------------

  private insert(s: string): boolean {
    if (s === '') return false
    this.splice(this.caret, this.caret, s)
    this.caret += s.length
    return true
  }

  /** Replace text[start, end) with `s`; clears any pending yank span. */
  private splice(start: number, end: number, s: string): void {
    this.text = this.text.slice(0, start) + s + this.text.slice(end)
    this.yankSpan = null
    this.yankNext = 0
  }

  private pushKill(killed: string): void {
    if (killed === '') return
    this.ring.unshift(killed)
    if (this.ring.length > RING_CAP) this.ring.pop()
  }

  private pushUndo(before: EditorSnapshot): void {
    this.undoStack.push(before)
    if (this.undoStack.length > UNDO_CAP) this.undoStack.shift()
    this.redoStack.length = 0
  }

  private undo(): void {
    const prev = this.undoStack.pop()
    if (prev === undefined) return
    this.redoStack.push({ text: this.text, caret: this.caret })
    this.text = prev.text
    this.caret = prev.caret
    this.yankSpan = null
    this.yankNext = 0
  }

  private redo(): void {
    const next = this.redoStack.pop()
    if (next === undefined) return
    this.undoStack.push({ text: this.text, caret: this.caret })
    this.text = next.text
    this.caret = next.caret
    this.yankSpan = null
    this.yankNext = 0
  }

  private commit(): void {
    const line = this.text
    this.text = ''
    this.caret = 0
    this.historyIndex = null
    this.historyDraft = ''
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.yankSpan = null
    this.yankNext = 0
    this.commitCb?.(line)
  }

  // -- history navigation -------------------------------------------------------

  private historyPrev(): void {
    const entries = this.historyFn?.() ?? []
    if (entries.length === 0) return
    const floor = Math.max(0, entries.length - this.historyMax)
    if (this.historyIndex === null) {
      this.historyDraft = this.text
      this.historyIndex = entries.length - 1
    } else {
      this.historyIndex = Math.max(floor, this.historyIndex - 1)
    }
    this.text = entries[this.historyIndex] ?? ''
    this.caret = this.text.length
  }

  private historyNext(): void {
    if (this.historyIndex === null) return
    const entries = this.historyFn?.() ?? []
    const next = this.historyIndex + 1
    if (next >= entries.length) {
      this.historyIndex = null
      this.text = this.historyDraft
      this.caret = this.text.length
      return
    }
    this.historyIndex = next
    this.text = entries[next] ?? ''
    this.caret = this.text.length
  }
}
