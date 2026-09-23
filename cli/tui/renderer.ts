// v0.26 Wave 1 — TuiScreen: minimal immediate-mode terminal renderer.
//
// Self-authored, ZERO npm dependencies (plan §1.3). Modeled on the
// pi-tui `render(width): string[]` + line-diff shape (copied as a form, not
// as code). The core render/diff logic is pure and driven through injected
// I/O streams so unit tests run headless without a tty.
//
// Wave 1 scope: renderer only. SignalGate wiring arrives in Wave 2
// (plan §3.2); this module must stay transport-agnostic.

// ---------------------------------------------------------------------------
// Public component contract
// ---------------------------------------------------------------------------

export interface TuiComponent {
  /** Produce the full frame as lines (no trailing newline, no cursor codes). */
  render(width: number): string[]
  /** Drop any internal cache so the next render() recomputes. */
  invalidate(): void
  /** Consume a raw input chunk. Return true when fully consumed. */
  handleInput?(data: string): boolean
}

export interface TuiIo {
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
}

export interface TuiScreenOptions {
  /** Minimum interval between actual draws. Default 16 (plan §3.2). */
  throttleMs?: number
  /** Deferred-run scheduler for the edge-triggered requestRender. Default process.nextTick. */
  schedule?: (fn: () => void) => void
}

// ---------------------------------------------------------------------------
// Pure diff core (exported for headless testing)
// ---------------------------------------------------------------------------

export type LineEdit = { row: number; text: string | null } // null = clear only

/**
 * Lines whose visible content changed between frames. Rows beyond the next
 * frame's length (shrunk screen content) are emitted as clears so stale
 * text never survives.
 */
export function computeLineEdits(prev: readonly string[], next: readonly string[]): LineEdit[] {
  const edits: LineEdit[] = []
  const rows = Math.max(prev.length, next.length)
  for (let row = 0; row < rows; row++) {
    const before = row < prev.length ? prev[row] : undefined
    const after = row < next.length ? next[row] : undefined
    if (before !== after) edits.push({ row, text: after === undefined ? null : after })
  }
  return edits
}

// ANSI row addressing: 1-based.
const CSI = '\x1b['
const cursorTo = (row: number) => `${CSI}${row + 1};1H`
const CLEAR_LINE = `${CSI}2K`
// DEC private mode 2026: synchronized output — optional, terminal-ignored if
// unsupported (plan §5 "synchronized output optional").
const SYNC_BEGIN = `${CSI}?2026h`
const SYNC_END = `${CSI}?2026l`

/** Serialize edits into one write() payload (pure; exported for testing). */
export function serializeEdits(edits: readonly LineEdit[]): string {
  if (edits.length === 0) return ''
  return SYNC_BEGIN + edits.map((e) => cursorTo(e.row) + CLEAR_LINE + (e.text ?? '')).join('') + SYNC_END
}

// ---------------------------------------------------------------------------
// TuiScreen
// ---------------------------------------------------------------------------

type Overlay = { component: TuiComponent; percentHeight: number }

const DEFAULT_WIDTH = 80

export class TuiScreen {
  private readonly io: TuiIo
  private readonly throttleMs: number
  private readonly schedule: (fn: () => void) => void

  private root: TuiComponent | null = null
  private overlay: Overlay | null = null
  private prevLines: readonly string[] | null = null // null = next draw is full redraw

  private started = false
  private stopped = false
  private pendingTick = false
  private trailingTimer: NodeJS.Timeout | null = null
  private lastDrawAt = 0

  private readonly resizeCbs = new Set<() => void>()
  private crashGuardInstalled = false
  private readonly crashHandlers: Array<[string, (...a: never[]) => void]> = []

  constructor(io: TuiIo, opts: TuiScreenOptions = {}) {
    this.io = io
    this.throttleMs = opts.throttleMs ?? 16
    this.schedule = opts.schedule ?? ((fn) => process.nextTick(fn))
  }

  // -- component tree -------------------------------------------------------

  setRoot(c: TuiComponent): void {
    this.root = c
    this.prevLines = null // structural change → full redraw
    this.requestRender()
  }

  /** Mount an overlay; it takes over the bottom slice of the screen. */
  showOverlay(c: TuiComponent, opts?: { percentHeight?: number }): { close(): void } {
    this.overlay = { component: c, percentHeight: opts?.percentHeight ?? 30 }
    this.prevLines = null
    this.requestRender()
    let closed = false
    return {
      close: () => {
        if (closed || this.stopped) return
        closed = true
        this.overlay = null
        this.prevLines = null
        this.requestRender()
      },
    }
  }

  // -- scheduling (edge-triggered + throttled) ------------------------------

  /** Coalesce renders: at most one draw per throttle window. */
  requestRender(): void {
    if (this.stopped || this.pendingTick) return
    const elapsed = Date.now() - this.lastDrawAt
    if (elapsed >= this.throttleMs) {
      this.pendingTick = true
      this.schedule(() => {
        this.pendingTick = false
        this.draw()
      })
    } else if (this.trailingTimer === null) {
      this.trailingTimer = setTimeout(() => {
        this.trailingTimer = null
        this.draw()
      }, this.throttleMs - elapsed)
    }
  }

  /** Force the next draw to repaint every line (resize / invalidate). */
  invalidate(): void {
    this.prevLines = null
    this.requestRender()
  }

  onResize(cb: () => void): () => void {
    this.resizeCbs.add(cb)
    return () => {
      this.resizeCbs.delete(cb)
    }
  }

  // -- lifecycle ------------------------------------------------------------

  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    if (this.io.stdin.isTTY) this.io.stdin.setRawMode(true)
    // 隐藏终端真光标——它停在最后一次 stdout 写入的末尾，与自绘的反色光标
    // 并存会呈现两个错位的光标；TUI 的光标 = 编辑器行里的反色块。stop() 恢复。
    if (this.io.stdout.isTTY) this.io.stdout.write('\x1b[?25l')
    this.io.stdin.on('data', this.onData)
    this.io.stdout.on('resize', this.onResizeEvent)
    this.prevLines = null
    this.draw()
  }

  /** Idempotent: restores the terminal exactly once. */
  stop(): void {
    if (!this.started || this.stopped) return
    this.stopped = true
    if (this.trailingTimer !== null) clearTimeout(this.trailingTimer)
    this.trailingTimer = null
    this.io.stdin.removeListener('data', this.onData)
    this.io.stdout.removeListener('resize', this.onResizeEvent)
    if (this.io.stdin.isTTY) this.io.stdin.setRawMode(false)
    if (this.io.stdout.isTTY) this.io.stdout.write('\x1b[?25h') // 恢复真光标
    if (this.crashGuardInstalled) this.uninstallCrashHandlers()
  }

  // ✅G3: any abnormal exit path must restore the terminal first.
  // 静默退出是诊断黑洞（用户只看到闪退）——restore 终端后把错误打到 stderr
  // 再退出；信号类（SIGINT/SIGTERM）没有错误对象，保持安静退出。
  installCrashGuard(): void {
    if (this.crashGuardInstalled) return
    this.crashGuardInstalled = true
    const guarded = (exitCode: number, report?: (sig: string) => string) => (arg: unknown) => {
      this.stop()
      if (report !== undefined) {
        try {
          process.stderr.write(report(arg instanceof Error ? arg.message : String(arg)))
        } catch { /* 终端已 restore，stderr 不可用则放弃输出 */ }
      }
      process.exitCode = exitCode
      process.exit(exitCode)
    }
    const fmt = (sig: string) => (e: string): string => `\n[HE-CLI] ${sig}: ${e}\n`
    const pairs: Array<[string, (...a: never[]) => void]> = [
      ['uncaughtException', guarded(1, fmt('uncaughtException'))],
      ['unhandledRejection', guarded(1, fmt('unhandledRejection'))],
      ['SIGINT', guarded(1)],
      ['SIGTERM', guarded(1)],
    ]
    for (const [event, handler] of pairs) {
      process.on(event as never, handler as never)
      this.crashHandlers.push([event, handler])
    }
  }

  private uninstallCrashHandlers(): void {
    this.crashGuardInstalled = false
    for (const [event, handler] of this.crashHandlers) {
      process.removeListener(event as never, handler as never)
    }
    this.crashHandlers.length = 0
  }

  // -- internals ------------------------------------------------------------

  private readonly onData = (chunk: Buffer | string): void => {
    const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    // Focus routing: overlay eats input first, then the root (plan §3.2 ③;
    // the four-state router lands in Wave 3 on top of this seam).
    if (this.overlay?.component.handleInput?.(data) === true) {
      this.requestRender()
      return
    }
    void this.root?.handleInput?.(data)
    // 按键改了编辑器/路由状态后必须请求重绘——raw mode 关掉了终端本地回显，
    // 输入可见性完全靠应用自绘（漏掉这条 = 打字不可见，回车提交才显示）。
    this.requestRender()
  }

  private readonly onResizeEvent = (): void => {
    // Windows has no SIGWINCH; stdout 'resize' is the only signal (✅G4).
    for (const cb of this.resizeCbs) cb()
    this.invalidate() // full redraw
  }

  private width(): number {
    return this.io.stdout.columns ?? DEFAULT_WIDTH
  }

  private composeFrame(): string[] {
    const width = this.width()
    const base = this.root?.render(width) ?? []
    if (this.overlay === null) return base
    const n = Math.max(1, Math.min(base.length, Math.ceil((base.length * this.overlay.percentHeight) / 100)))
    const overlayLines = this.overlay.component.render(width)
    const head = base.slice(0, base.length - n)
    const lines = head.concat(overlayLines.slice(0, n))
    while (lines.length < base.length) lines.push('')
    return lines
  }

  private draw(): void {
    if (this.stopped || !this.started) return
    const next = this.composeFrame()
    const edits = this.prevLines === null ? fullFrameEdits(next) : computeLineEdits(this.prevLines, next)
    this.prevLines = next
    const payload = serializeEdits(edits)
    if (payload !== '') this.io.stdout.write(payload)
    this.lastDrawAt = Date.now()
  }
}

/** First paint: address and write every line. */
function fullFrameEdits(lines: readonly string[]): LineEdit[] {
  return lines.map((text, row) => ({ row, text }))
}
