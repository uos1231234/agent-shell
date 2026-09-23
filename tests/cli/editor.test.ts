// v0.26 Wave 3 — LineEditor 单测（byte-stream 层级：我们完全控制喂给
// handleKey 的字节，这正是诚实纪律允许的验证方式——真实终端行为不在断言里
// 冒充）。覆盖任务清单：typing/backspace/caret（含 CJK 显示宽度）、kill-ring
// （Ctrl-K→Ctrl-Y 还原；两杀→Alt-Y 循环）、undo 多步 + redo、CJK/ASCII 混排
// 词跳转、paste burst 单步 undo、history 上下、Enter 提交、跨 chunk 的
// UTF-8 断裂重组、Ctrl-C 到 abort hook（不退进程）。

import { describe, expect, it, vi } from 'vitest'
import { LineEditor } from '../../cli/editor.js'
import { KeyDecoder } from '../../cli/keys.js'

// 常用按键字节（keys.ts 的映射契约）
const BS = '\x7f'
const ENTER = '\r'
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'
const HOME = '\x1b[H'
const END = '\x1b[F'
const CTRL_A = '\x01'
const CTRL_E = '\x05'
const CTRL_C = '\x03'
const CTRL_K = '\x0b'
const CTRL_U = '\x15'
const CTRL_Y = '\x19'
const CTRL_Z = '\x1a'
const CTRL_R = '\x12'
const ALT_Y = '\x1by'
const ALT_BS = '\x1b\x7f' // Alt-Backspace = kill word back

const feed = (ed: LineEditor, s: string): void => {
  ed.handleKey(s)
}
const feedAll = (ed: LineEditor, ...chunks: string[]): void => {
  for (const c of chunks) ed.handleKey(c)
}

// ---------------------------------------------------------------------------

describe('LineEditor: typing / backspace / caret', () => {
  it('inserts printable text (string chunks)', () => {
    const ed = new LineEditor()
    feedAll(ed, 'abc')
    expect(ed.getLine()).toBe('abc')
    expect(ed.getCaret()).toBe(3)
  })

  it('backspace removes the last code point (CJK included)', () => {
    const ed = new LineEditor()
    feedAll(ed, '你a')
    feed(ed, BS)
    expect(ed.getLine()).toBe('你')
    feed(ed, BS)
    expect(ed.getLine()).toBe('')
  })

  it('arrow keys move the caret; insert lands at the caret', () => {
    const ed = new LineEditor()
    feedAll(ed, 'hello')
    feedAll(ed, LEFT, LEFT)
    expect(ed.getCaret()).toBe(3)
    feed(ed, 'XX')
    expect(ed.getLine()).toBe('helXXlo')
    expect(ed.getCaret()).toBe(5)
  })

  it('home/end jump to line bounds (CSI H / CSI F, Ctrl-A / Ctrl-E)', () => {
    const ed = new LineEditor()
    feedAll(ed, 'hello')
    feed(ed, HOME)
    expect(ed.getCaret()).toBe(0)
    feed(ed, CTRL_A) // already home — no-op
    feed(ed, 'x')
    expect(ed.getLine()).toBe('xhello')
    feed(ed, END)
    expect(ed.getCaret()).toBe(6)
    feed(ed, CTRL_E)
    expect(ed.getCaret()).toBe(6)
  })

  it('delete removes the code point under the caret (Ctrl-D too)', () => {
    const ed = new LineEditor()
    feedAll(ed, '你好', HOME)
    feed(ed, '\x1b[3~') // Delete key
    expect(ed.getLine()).toBe('好')
    feed(ed, HOME)
    feed(ed, '\x04') // Ctrl-D
    expect(ed.getLine()).toBe('')
  })
})

describe('LineEditor: CJK width-aware rendering', () => {
  it('renders the caret as a reverse block at its display column', () => {
    const ed = new LineEditor()
    feedAll(ed, '你好')
    expect(ed.render(80)).toEqual(['> 你好\x1b[7m \x1b[0m'])
    feed(ed, HOME)
    expect(ed.render(80)).toEqual(['> \x1b[7m你\x1b[0m好'])
  })

  it('caret between ASCII and CJK lands on the right display column', () => {
    const ed = new LineEditor()
    feedAll(ed, '你a', LEFT) // caret = 1 (before 'a', display col 2+2)
    expect(ed.render(80)).toEqual(['> 你\x1b[7ma\x1b[0m'])
  })

  it('empty line renders prompt + reverse block', () => {
    const ed = new LineEditor()
    expect(ed.render(80)).toEqual(['> \x1b[7m \x1b[0m'])
  })

  it('wraps long CJK input onto continuation rows without splitting a char', () => {
    const ed = new LineEditor()
    feed(ed, '你'.repeat(45)) // 90 columns + prompt > 80
    const rows = ed.render(80)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toBe('> ' + '你'.repeat(39)) // 2 + 78 = 80 cols
    expect(rows[1]).toBe('你'.repeat(6) + '\x1b[7m \x1b[0m')
  })

  it('wraps long ASCII input at the width boundary', () => {
    const ed = new LineEditor()
    feed(ed, 'a'.repeat(100))
    const rows = ed.render(80)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toBe('> ' + 'a'.repeat(78))
    expect(rows[1]).toBe('a'.repeat(22) + '\x1b[7m \x1b[0m')
  })
})

describe('LineEditor: kill-ring', () => {
  it('Ctrl-K kills to end; Ctrl-Y restores', () => {
    const ed = new LineEditor()
    feedAll(ed, 'hello world', CTRL_A, CTRL_K)
    expect(ed.getLine()).toBe('')
    feed(ed, CTRL_Y)
    expect(ed.getLine()).toBe('hello world')
    expect(ed.getCaret()).toBe(11)
  })

  it('Ctrl-U kills to start; two kills then Alt-Y cycles through the ring', () => {
    const ed = new LineEditor()
    feedAll(ed, 'aaa bbb')
    feed(ed, ALT_BS) // kill 'bbb' → ring ['bbb']
    expect(ed.getLine()).toBe('aaa ')
    feed(ed, CTRL_U) // kill 'aaa ' → ring ['aaa ', 'bbb']
    expect(ed.getLine()).toBe('')
    feed(ed, CTRL_Y) // yank ring[0] = 'aaa '
    expect(ed.getLine()).toBe('aaa ')
    feed(ed, ALT_Y) // cycle → ring[1] = 'bbb' (replaces the yanked span)
    expect(ed.getLine()).toBe('bbb')
    feed(ed, ALT_Y) // cycle wraps → ring[0] = 'aaa '
    expect(ed.getLine()).toBe('aaa ')
  })

  it('yank span survives caret movement; Alt-Y replaces the span, not the caret', () => {
    const ed = new LineEditor()
    feedAll(ed, 'aaa bbb', ALT_BS, CTRL_U) // ring ['aaa ', 'bbb'], line ''
    feedAll(ed, CTRL_Y, LEFT) // 'aaa ' caret 3
    feed(ed, ALT_Y) // span {0,4} → 'bbb'
    expect(ed.getLine()).toBe('bbb')
    expect(ed.getCaret()).toBe(3)
  })

  it('a new mutation clears the yank span (Alt-Y becomes no-op)', () => {
    const ed = new LineEditor()
    feedAll(ed, 'ab', CTRL_A, CTRL_K, CTRL_Y) // killed 'ab', yanked back
    feed(ed, 'x') // mutation — span gone
    feed(ed, ALT_Y)
    expect(ed.getLine()).toBe('abx')
  })
})

describe('LineEditor: undo / redo', () => {
  it('multi-step undo then redo', () => {
    const ed = new LineEditor()
    feedAll(ed, 'a', 'b', 'c')
    feed(ed, CTRL_Z)
    expect(ed.getLine()).toBe('ab')
    feed(ed, CTRL_Z)
    expect(ed.getLine()).toBe('a')
    feed(ed, CTRL_Z)
    expect(ed.getLine()).toBe('')
    feed(ed, CTRL_R)
    expect(ed.getLine()).toBe('a')
    feed(ed, CTRL_R)
    expect(ed.getLine()).toBe('ab')
    feed(ed, CTRL_R)
    expect(ed.getLine()).toBe('abc')
  })

  it('undo restores the caret alongside the text', () => {
    const ed = new LineEditor()
    feedAll(ed, 'hello', HOME, 'X') // 'Xhello', caret 1
    feed(ed, CTRL_Z)
    expect(ed.getLine()).toBe('hello')
    expect(ed.getCaret()).toBe(0)
  })

  it('a paste burst is exactly ONE undo step', () => {
    const ed = new LineEditor()
    feed(ed, '你好世界 abc') // one multi-char chunk = paste burst
    feed(ed, CTRL_Z)
    expect(ed.getLine()).toBe('')
  })

  it('per-chunk granularity: two single-char chunks = two undo steps', () => {
    const ed = new LineEditor()
    feedAll(ed, '你', '好')
    feed(ed, CTRL_Z)
    expect(ed.getLine()).toBe('你')
    feed(ed, CTRL_Z)
    expect(ed.getLine()).toBe('')
  })

  it('redo stack is cleared by a new edit', () => {
    const ed = new LineEditor()
    feedAll(ed, 'a', 'b', CTRL_Z) // 'a'
    feed(ed, 'c') // 'ac' — redo history dropped
    feed(ed, CTRL_R)
    expect(ed.getLine()).toBe('ac')
  })

  it('Ctrl-Shift-Z (kitty CSI-u) also redoes', () => {
    const ed = new LineEditor()
    feedAll(ed, 'a', 'b', CTRL_Z) // 'a' (per-chunk undo granularity)
    expect(ed.getLine()).toBe('a')
    feed(ed, '\x1b[122;6u')
    expect(ed.getLine()).toBe('ab')
  })
})

describe('LineEditor: CJK/ASCII mixed word navigation', () => {
  // "你好 world test测试" — indices: 0你 1好 2␣ 3w..7d 8␣ 9t..12t 13测 14试
  const nav = (): LineEditor => {
    const ed = new LineEditor()
    ed.setLine('你好 world test测试')
    return ed
  }

  it('word-left: CJK run = one word; CJK<->ASCII boundary always splits', () => {
    const ed = nav()
    feed(ed, '\x1b[1;3D') // Alt-Left
    expect(ed.getCaret()).toBe(13) // before 测试 (boundary between 't' and '测', no space)
    feed(ed, '\x1b[1;3D')
    expect(ed.getCaret()).toBe(9) // before 'test'
    feed(ed, '\x1b[1;3D')
    expect(ed.getCaret()).toBe(3) // before 'world'
    feed(ed, '\x1b[1;3D')
    expect(ed.getCaret()).toBe(0) // before 你好
  })

  it('Ctrl-Left/Right are word motion too', () => {
    const ed = nav()
    feed(ed, '\x1b[1;5D')
    expect(ed.getCaret()).toBe(13)
  })

  it('word-right from 0 walks runs and separators symmetrically', () => {
    const ed = nav()
    feedAll(ed, HOME, '\x1b[1;3C')
    expect(ed.getCaret()).toBe(2)
    feed(ed, '\x1b[1;3C')
    expect(ed.getCaret()).toBe(8)
    feed(ed, '\x1b[1;3C')
    expect(ed.getCaret()).toBe(13)
    feed(ed, '\x1b[1;3C')
    expect(ed.getCaret()).toBe(15)
  })

  it('Alt-Backspace kills the word before the caret (CJK run as a unit)', () => {
    const ed = new LineEditor()
    ed.setLine('hello 测试')
    feed(ed, ALT_BS)
    expect(ed.getLine()).toBe('hello ')
    feed(ed, ALT_BS)
    expect(ed.getLine()).toBe('')
    feed(ed, CTRL_Y)
    expect(ed.getLine()).toBe('hello ') // most recent kill = the CJK run
  })

  it('Alt-B / Alt-F are emacs-style word motion', () => {
    const ed = nav()
    feed(ed, '\x1bb')
    expect(ed.getCaret()).toBe(13)
    feed(ed, '\x1bf')
    expect(ed.getCaret()).toBe(15)
  })
})

describe('LineEditor: history', () => {
  it('Up/Down navigate injected history; draft is restored at the bottom', () => {
    const ed = new LineEditor()
    ed.setHistory(() => ['first', 'second'])
    feed(ed, 'draft text')
    feed(ed, UP)
    expect(ed.getLine()).toBe('second')
    feed(ed, UP)
    expect(ed.getLine()).toBe('first')
    feed(ed, DOWN)
    expect(ed.getLine()).toBe('second')
    feed(ed, DOWN)
    expect(ed.getLine()).toBe('draft text')
  })

  it('maxEntries bounds how far back navigation goes', () => {
    const ed = new LineEditor()
    ed.setHistory(() => ['e1', 'e2', 'e3', 'e4', 'e5'], 2)
    feedAll(ed, UP, UP, UP)
    expect(ed.getLine()).toBe('e4') // floor = 5 - 2 = 3
  })

  it('commit closes navigation; empty lines also commit (app decides)', () => {
    const ed = new LineEditor()
    const committed: string[] = []
    ed.onCommit((line) => committed.push(line))
    ed.setHistory(() => ['first', 'second'])
    feed(ed, 'x')
    feed(ed, ENTER)
    expect(committed).toEqual(['x'])
    expect(ed.getLine()).toBe('')
    feed(ed, UP)
    expect(ed.getLine()).toBe('second') // fresh nav, draft gone
  })

  it('Enter on an empty line fires the callback with ""', () => {
    const ed = new LineEditor()
    const committed: string[] = []
    ed.onCommit((line) => committed.push(line))
    feed(ed, ENTER)
    expect(committed).toEqual([''])
  })
})

describe('LineEditor: chunk normalization + split UTF-8', () => {
  it('string and Buffer input are equivalent', () => {
    const a = new LineEditor()
    const b = new LineEditor()
    a.handleKey('你好')
    b.handleKey(Buffer.from('你好', 'utf8'))
    expect(a.getLine()).toBe(b.getLine())
    expect(b.getLine()).toBe('你好')
  })

  it('a UTF-8 sequence split across chunks reassembles', () => {
    const ed = new LineEditor()
    ed.handleKey(Buffer.from('ab', 'utf8'))
    ed.handleKey(Buffer.from([0xe4, 0xbd])) // '你' = e4 bd a0 — first two bytes
    expect(ed.getLine()).toBe('ab') // nothing emitted yet
    ed.handleKey(Buffer.from([0xa0]))
    expect(ed.getLine()).toBe('ab你')
    feed(ed, 'c')
    expect(ed.getLine()).toBe('ab你c')
  })

  it('a mixed chunk (text + escape) applies events in order', () => {
    const ed = new LineEditor()
    ed.handleKey('ab\x1b[Dc') // 'ab', Left, 'c'
    expect(ed.getLine()).toBe('acb')
  })
})

describe('LineEditor: Ctrl-C abort hook (never exits the process)', () => {
  it('reaches the subscribed hook and leaves the line intact', () => {
    const ed = new LineEditor()
    const abort = vi.fn()
    ed.onAbort(abort)
    feedAll(ed, 'partial input')
    expect(ed.handleKey(CTRL_C)).toBe(true)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(ed.getLine()).toBe('partial input')
    feed(ed, CTRL_C)
    expect(abort).toHaveBeenCalledTimes(2)
  })
})

describe('KeyDecoder (byte classifier)', () => {
  it('decodes arrow / home / end sequences', () => {
    const d = new KeyDecoder()
    expect(d.feed('\x1b[A')).toEqual([{ kind: 'key', name: 'up' }])
    expect(d.feed('\x1b[B')).toEqual([{ kind: 'key', name: 'down' }])
    expect(d.feed('\x1b[C')).toEqual([{ kind: 'key', name: 'right' }])
    expect(d.feed('\x1b[D')).toEqual([{ kind: 'key', name: 'left' }])
    expect(d.feed('\x1b[H')).toEqual([{ kind: 'key', name: 'home' }])
    expect(d.feed('\x1b[F')).toEqual([{ kind: 'key', name: 'end' }])
    expect(d.feed('\x1bOA')).toEqual([{ kind: 'key', name: 'up' }]) // SS3
  })

  it('buffers an incomplete CSI until the final byte arrives', () => {
    const d = new KeyDecoder()
    expect(d.feed('\x1b[')).toEqual([])
    expect(d.feed('A')).toEqual([{ kind: 'key', name: 'up' }])
  })

  it('a lone ESC is the Esc key', () => {
    const d = new KeyDecoder()
    expect(d.feed('\x1b')).toEqual([{ kind: 'key', name: 'esc' }])
  })

  it('unknown CSI / control bytes are consumed as unknown', () => {
    const d = new KeyDecoder()
    expect(d.feed('\x1b[99Z')).toEqual([{ kind: 'key', name: 'unknown' }])
    expect(d.feed('\x07')).toEqual([{ kind: 'key', name: 'unknown' }]) // BEL
  })

  it('CRLF coalesces into one Enter', () => {
    const d = new KeyDecoder()
    expect(d.feed('\r\n')).toEqual([{ kind: 'key', name: 'enter' }])
  })
})
