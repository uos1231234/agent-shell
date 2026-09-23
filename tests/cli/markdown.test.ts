// v0.26 Wave 1 — minimal markdown renderer tests (subset + CJK width).

import { describe, expect, it } from 'vitest'

import {
  ANSI,
  charWidth,
  parseInline,
  renderMarkdownToLines,
  visibleWidth,
  wrapText,
} from '../../cli/tui/markdown.js'

describe('charWidth / visibleWidth', () => {
  it('counts CJK chars as 2 columns and ASCII as 1', () => {
    expect(charWidth('你'.codePointAt(0) ?? 0)).toBe(2)
    expect(charWidth('A'.codePointAt(0) ?? 0)).toBe(1)
    expect(charWidth('，'.codePointAt(0) ?? 0)).toBe(2) // fullwidth comma FF0C
    expect(charWidth('가'.codePointAt(0) ?? 0)).toBe(2) // Hangul syllable
  })

  it('visibleWidth ignores ANSI escape sequences', () => {
    expect(visibleWidth(`${ANSI.bold}ab${ANSI.reset}`)).toBe(2)
    expect(visibleWidth('你好')).toBe(4)
  })
})

describe('wrapText', () => {
  it('breaks between CJK chars when the width runs out', () => {
    expect(wrapText('一二三四五', 6)).toEqual(['一二三', '四五'])
  })

  it('wraps ASCII at word boundaries when possible', () => {
    expect(wrapText('hello world again', 11)).toEqual(['hello world', 'again'])
  })

  it('keeps ANSI sequences intact and zero-width across the break', () => {
    // Attributes persist across rows by design (real terminal behavior);
    // the escape sequences themselves are never split.
    const lines = wrapText(`${ANSI.bold}你好世界${ANSI.reset}`, 4)
    expect(lines).toEqual([`${ANSI.bold}你好`, `世界${ANSI.reset}`])
    expect(visibleWidth(lines[0] ?? '')).toBeLessThanOrEqual(4)
    expect(visibleWidth(lines[1] ?? '')).toBeLessThanOrEqual(4)
  })

  it('collapses leading whitespace on continuation lines', () => {
    const lines = wrapText('aaa   bbb', 3)
    expect(lines).toEqual(['aaa', 'bbb'])
  })
})

describe('renderMarkdownToLines', () => {
  it('renders ATX headings as bold lines', () => {
    const lines = renderMarkdownToLines('# Title', 40)
    expect(lines).toEqual([`${ANSI.bold}Title${ANSI.reset}`])
  })

  it('renders unordered lists with a dash prefix and hanging continuation', () => {
    const lines = renderMarkdownToLines('- first item\n- second', 40)
    expect(lines).toEqual(['- first item', '- second'])
  })

  it('wraps long list items keeping the indent aligned', () => {
    // width 8: '- ' prefix takes 2, content wraps at 6 → 'one two' (7) must break
    const lines = renderMarkdownToLines('- one two three four', 8)
    expect(lines).toEqual(['- one', '  two', '  three', '  four'])
  })

  it('renders fenced code blocks indented, without the fence lines', () => {
    const lines = renderMarkdownToLines('```js\nconst a = 1\nconst b = 2\n```', 40)
    expect(lines).toEqual(['  const a = 1', '  const b = 2'])
  })

  it('renders blockquotes with a "> " prefix', () => {
    const lines = renderMarkdownToLines('> quoted text', 40)
    expect(lines).toEqual(['> quoted text'])
  })

  it('formats inline bold, italic and code', () => {
    const lines = renderMarkdownToLines('a **bold** and *it* and `code` end', 40)
    expect(lines).toEqual([
      `a ${ANSI.bold}bold${ANSI.reset} and ${ANSI.italic}it${ANSI.reset} and ${ANSI.code}code${ANSI.reset} end`,
    ])
  })

  it('joins soft-wrapped paragraphs into one flow and wraps to width', () => {
    const lines = renderMarkdownToLines('aaaa\nbbbb\n', 9)
    expect(lines).toEqual(['aaaa bbbb'])
  })

  it('wraps CJK paragraphs at the 2-column boundary', () => {
    const lines = renderMarkdownToLines('一二三四五六七', 8)
    expect(lines).toEqual(['一二三四', '五六七'])
  })

  it('every emitted line fits the given width (mixed content)', () => {
    const md = [
      '# 标题标题',
      '- 中文列表项有点长需要换行处理',
      '> 引用也能遇到宽度限制的时候折行',
      '普通段落混排 English words and 中文 mixed together',
      '```',
      'code line that is quite long and must wrap too',
      '```',
    ].join('\n')
    for (const width of [10, 20, 40]) {
      for (const line of renderMarkdownToLines(md, width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width)
      }
    }
  })

  it('is a pure function: same input, same lines', () => {
    const md = '# hi\n\n- x\n```\ncode\n```'
    expect(renderMarkdownToLines(md, 20)).toEqual(renderMarkdownToLines(md, 20))
  })
})

// ---------------------------------------------------------------------------
// Wave A additions: tables / ordered lists / task lists / strikethrough / hr
// ---------------------------------------------------------------------------

describe('renderMarkdownToLines — GFM tables', () => {
  it('renders an ASCII table with aligned columns and a resynthesized separator', () => {
    const md = '| A | BB |\n| --- | --- |\n| x | y |'
    expect(renderMarkdownToLines(md, 30)).toEqual(['| A | BB |', '| - | -- |', '| x | y  |'])
  })

  it('measures CJK cells at 2 columns when padding', () => {
    const md = '| 名称 | 值 |\n| --- | --- |\n| alpha | 1 |'
    expect(renderMarkdownToLines(md, 30)).toEqual(['| 名称  | 值 |', '| ----- | -- |', '| alpha | 1  |'])
  })

  it('evenly truncates columns when the table exceeds the terminal width', () => {
    const md = '| header1 | header2 |\n| --- | --- |\n| aaaaaaaaaa | bbbbbbbbbb |'
    const lines = renderMarkdownToLines(md, 20)
    expect(lines).toEqual(['| heade… | heade… |', '| ------ | ------ |', '| aaaaa… | bbbbb… |'])
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(20)
  })

  it('header without a delimiter row is not a table (stays a paragraph)', () => {
    const lines = renderMarkdownToLines('a | b', 40)
    expect(lines).toEqual(['a | b'])
  })
})

describe('renderMarkdownToLines — ordered lists', () => {
  it('renders ordered items with their number as the marker', () => {
    expect(renderMarkdownToLines('1. first\n2. second', 40)).toEqual(['1. first', '2. second'])
  })

  it('supports nested ordered items via leading spaces (2 per depth)', () => {
    expect(renderMarkdownToLines('1. top\n   1. inner', 40)).toEqual(['1. top', '  1. inner'])
  })
})

describe('renderMarkdownToLines — task lists', () => {
  it('renders checked and unchecked tasks as ✓ / ☐ (bullet replaced by the checkbox)', () => {
    expect(renderMarkdownToLines('- [x] done thing\n- [ ] todo', 40)).toEqual([
      '✓ done thing',
      '☐ todo',
    ])
  })

  it('accepts uppercase [X] and keeps wrapping for long task bodies', () => {
    expect(renderMarkdownToLines('- [X] finished', 40)).toEqual(['✓ finished'])
    const lines = renderMarkdownToLines('- [ ] a very long task body that must wrap', 12)
    expect(lines[0]).toBe('☐ a very')
    expect(lines[1]).toBe('  long task')
    expect(visibleWidth(lines[lines.length - 1] ?? '')).toBeLessThanOrEqual(12)
  })
})

describe('renderMarkdownToLines — strikethrough', () => {
  it('wraps ~~text~~ in SGR 9', () => {
    expect(parseInline('~~gone~~ now')).toBe(`${ANSI.strike}gone${ANSI.reset} now`)
    expect(renderMarkdownToLines('~~gone~~ fast', 40)).toEqual([
      `${ANSI.strike}gone${ANSI.reset} fast`,
    ])
  })

  it('code spans win over strikethrough', () => {
    expect(parseInline('`~~x~~`')).toBe(`${ANSI.code}~~x~~${ANSI.reset}`)
  })
})

describe('renderMarkdownToLines — horizontal rules', () => {
  it('renders --- as a full-width rule', () => {
    expect(renderMarkdownToLines('---', 10)).toEqual(['──────────'])
  })

  it('renders *** and - - - as rules too; a bullet list item is not a rule', () => {
    expect(renderMarkdownToLines('***', 4)).toEqual(['────'])
    expect(renderMarkdownToLines('- - -', 4)).toEqual(['────'])
    expect(renderMarkdownToLines('- item', 40)).toEqual(['- item'])
  })
})
