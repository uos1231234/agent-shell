// v0.26 Wave 1 — TuiScreen renderer tests (headless: fake I/O streams).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  computeLineEdits,
  serializeEdits,
  TuiScreen,
  type TuiComponent,
  type TuiIo,
} from '../../cli/tui/renderer.js'

// ---------------------------------------------------------------------------
// Fake I/O (no tty anywhere; the renderer must not care)
// ---------------------------------------------------------------------------

type WriteSpy = ReturnType<typeof vi.fn>

function makeFakeIo(opts?: { isTTY?: boolean; columns?: number }): { io: TuiIo; writes: string[]; write: WriteSpy } {
  const writes: string[] = []
  const write = vi.fn((payload: string) => {
    writes.push(payload)
  })
  const stdout = {
    columns: opts?.columns ?? 20,
    write,
    on: vi.fn(),
    removeListener: vi.fn(),
  }
  const stdin = {
    isTTY: opts?.isTTY ?? false,
    setRawMode: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  }
  return { io: { stdout, stdin } as unknown as TuiIo, writes, write }
}

function staticComponent(lines: string[]): TuiComponent {
  return { render: vi.fn(() => lines), invalidate: vi.fn() }
}

/** Manual scheduler queue standing in for process.nextTick. */
function manualScheduler(): { schedule: (fn: () => void) => void; flush: WriteSpy } {
  const queue: Array<() => void> = []
  const flush = vi.fn(() => {
    while (queue.length > 0) queue.shift()?.()
  })
  return {
    schedule: (fn) => queue.push(fn),
    flush,
  }
}

function extractRows(payload: string): string[] {
  // payloads look like: ESC[?2026h ESC[row;1H ESC[2K<text> ... ESC[?2026l
  const out: string[] = []
  for (const m of payload.matchAll(/\x1b\[(\d+);1H\x1b\[2K([^\x1b]*)/g)) {
    out.push(m[2] ?? '')
  }
  return out
}

// ---------------------------------------------------------------------------
// Pure diff core
// ---------------------------------------------------------------------------

describe('computeLineEdits', () => {
  it('emits only changed lines', () => {
    const edits = computeLineEdits(['a', 'b', 'c'], ['a', 'B', 'c'])
    expect(edits).toEqual([{ row: 1, text: 'B' }])
  })

  it('clears stale rows when content shrinks', () => {
    const edits = computeLineEdits(['a', 'b', 'c'], ['a'])
    expect(edits).toEqual([{ row: 1, text: null }, { row: 2, text: null }])
  })

  it('treats grown content as edits for the new rows only', () => {
    const edits = computeLineEdits(['a'], ['a', 'b', 'c'])
    expect(edits).toEqual([{ row: 1, text: 'b' }, { row: 2, text: 'c' }])
  })
})

describe('serializeEdits', () => {
  it('wraps the frame in synchronized output (DEC 2026) and addresses 1-based rows', () => {
    const payload = serializeEdits([
      { row: 0, text: 'a' },
      { row: 2, text: null },
    ])
    expect(payload).toBe(
      '\x1b[?2026h\x1b[1;1H\x1b[2Ka\x1b[3;1H\x1b[2K\x1b[?2026l',
    )
  })

  it('serializes nothing when there are no edits', () => {
    expect(serializeEdits([])).toBe('')
  })
})

// ---------------------------------------------------------------------------
// TuiScreen lifecycle + draw pipeline (fake io, manual scheduler)
// ---------------------------------------------------------------------------

describe('TuiScreen', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('start() paints the full frame once and stop() is idempotent', () => {
    const { io, write } = makeFakeIo({ isTTY: true, columns: 10 })
    const screen = new TuiScreen(io, { schedule: manualScheduler().schedule })
    screen.setRoot(staticComponent(['hello']))
    screen.start()
    expect(write).toHaveBeenCalledTimes(1)
    expect(io.stdin.setRawMode).toHaveBeenCalledWith(true)

    screen.stop()
    screen.stop()
    expect(io.stdin.setRawMode).toHaveBeenLastCalledWith(false)
    expect(io.stdin.removeListener).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledTimes(1) // stop draws nothing
  })

  it('requestRender coalesces bursts into one draw (edge-triggered)', () => {
    const { io, write } = makeFakeIo({ columns: 10 })
    const sched = manualScheduler()
    const screen = new TuiScreen(io, { schedule: sched.schedule })
    const comp = staticComponent(['a', 'b'])
    screen.setRoot(comp)
    screen.start()
    const baseline = write.mock.calls.length

    // let the fake clock move past the throttle window drawn by start()
    vi.advanceTimersByTime(20)
    comp.render = vi.fn(() => ['a', 'B'])
    screen.requestRender()
    screen.requestRender()
    screen.requestRender()
    expect(sched.flush).not.toHaveBeenCalled()
    expect(write.mock.calls.length).toBe(baseline) // nothing drawn yet

    sched.flush()
    expect(write.mock.calls.length).toBe(baseline + 1)
    const payload = write.mock.calls.at(-1)?.[0] as string
    expect(extractRows(payload)).toEqual(['B']) // only the changed line

    // further bursts inside the throttle window go to a single trailing timer
    comp.render = vi.fn(() => ['a', 'C'])
    screen.requestRender()
    screen.requestRender()
    vi.advanceTimersByTime(16)
    expect(write.mock.calls.length).toBe(baseline + 2)
    expect(extractRows(write.mock.calls.at(-1)?.[0] as string)).toEqual(['C'])
  })

  it('performs a full redraw after invalidate()', () => {
    const { io, write } = makeFakeIo({ columns: 10 })
    const sched = manualScheduler()
    const screen = new TuiScreen(io, { schedule: sched.schedule })
    screen.setRoot(staticComponent(['one', 'two']))
    screen.start()
    screen.invalidate()
    sched.flush()
    // full redraw: both rows re-emitted even though content is unchanged
    const payload = write.mock.calls.at(-1)?.[0] as string
    expect(extractRows(payload)).toEqual(['one', 'two'])
  })

  it('overlay replaces the bottom slice and close() restores the root frame', () => {
    const { io, write } = makeFakeIo({ columns: 10 })
    const sched = manualScheduler()
    const screen = new TuiScreen(io, { schedule: sched.schedule })
    screen.setRoot(staticComponent(['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9']))
    screen.start()
    const baseline = write.mock.calls.length

    const overlay = staticComponent(['OVERLAY'])
    const handle = screen.showOverlay(overlay, { percentHeight: 20 })
    sched.flush()
    vi.advanceTimersByTime(20) // close/overlay paths may use the trailing timer
    expect(write.mock.calls.length).toBe(baseline + 1)
    const frame = extractRows(write.mock.calls.at(-1)?.[0] as string)
    expect(frame.slice(0, 8)).toEqual(['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'])
    expect(frame.slice(8)).toEqual(['OVERLAY', ''])

    handle.close()
    sched.flush()
    vi.advanceTimersByTime(20) // cover either scheduling path (tick or trailing)
    expect(write.mock.calls.length).toBe(baseline + 2)
    expect(extractRows(write.mock.calls.at(-1)?.[0] as string)).toEqual([
      'l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9',
    ])
  })

  it('routes input to the overlay first, then the root', () => {
    const { io } = makeFakeIo({ columns: 10 })
    const sched = manualScheduler()
    const screen = new TuiScreen(io, { schedule: sched.schedule })
    const rootInput = vi.fn(() => true)
    const overlayInput = vi.fn(() => true)
    screen.setRoot({ render: () => ['r'], invalidate: () => {}, handleInput: rootInput })
    screen.start()

    // capture the stdin data listener the screen registered
    const dataListener = (io.stdin.on as WriteSpy).mock.calls.find((c) => c[0] === 'data')?.[1] as (d: string) => void

    dataListener('x')
    expect(rootInput).toHaveBeenCalledWith('x')

    screen.showOverlay({ render: () => ['o'], invalidate: () => {}, handleInput: overlayInput })
    dataListener('y')
    expect(overlayInput).toHaveBeenCalledWith('y')
    expect(rootInput).not.toHaveBeenCalledWith('y') // overlay consumed it
  })

  it('onResize callback fires and the next frame is a full redraw', () => {
    const { io, write } = makeFakeIo({ columns: 10 })
    const sched = manualScheduler()
    const screen = new TuiScreen(io, { schedule: sched.schedule })
    const onResize = vi.fn()
    screen.onResize(onResize)
    screen.setRoot(staticComponent(['a', 'b']))
    screen.start()

    const resizeHandler = (io.stdout.on as WriteSpy).mock.calls.find((c) => c[0] === 'resize')?.[1] as () => void
    resizeHandler()
    expect(onResize).toHaveBeenCalledTimes(1)
    sched.flush()
    // full redraw (invalidate), not a diff
    expect(extractRows(write.mock.calls.at(-1)?.[0] as string)).toEqual(['a', 'b'])

    const off = screen.onResize(onResize)
    off()
    resizeHandler()
    expect(onResize).toHaveBeenCalledTimes(1)
  })

  it('installCrashGuard restores the terminal and exits non-zero; stop() unwinds it', () => {
    const { io } = makeFakeIo({ isTTY: true })
    const screen = new TuiScreen(io, { schedule: manualScheduler().schedule })
    const onSpy = vi.spyOn(process, 'on')
    const removeSpy = vi.spyOn(process, 'removeListener')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    screen.start()
    screen.installCrashGuard()
    const events = ['uncaughtException', 'unhandledRejection', 'SIGINT', 'SIGTERM']
    for (const ev of events) {
      expect(onSpy).toHaveBeenCalledWith(ev, expect.any(Function))
    }

    const handler = onSpy.mock.calls.find((c) => c[0] === 'SIGINT')?.[1] as () => void
    handler()
    expect(io.stdin.setRawMode).toHaveBeenLastCalledWith(false)
    expect(exitSpy).toHaveBeenCalledWith(1)

    screen.stop()
    for (const ev of events) {
      expect(removeSpy).toHaveBeenCalledWith(ev, expect.any(Function))
    }

    onSpy.mockRestore()
    removeSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('requestRender is a no-op after stop()', () => {
    const { io, write } = makeFakeIo({ columns: 10 })
    const sched = manualScheduler()
    const screen = new TuiScreen(io, { schedule: sched.schedule })
    screen.setRoot(staticComponent(['a']))
    screen.start()
    screen.stop()
    const n = write.mock.calls.length
    screen.requestRender()
    sched.flush()
    vi.advanceTimersByTime(100)
    expect(write.mock.calls.length).toBe(n)
  })
})
