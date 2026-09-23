// v0.20 rendering base: renderMarkdown unit tests.
//
// Covers the 10 markdown subset items + mermaid/html passthrough, plus
// boundary cases: empty input, pure whitespace, unclosed fences, XSS
// escaping, CJK characters.

import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../../src/rendering/render-md.js'

describe('renderMarkdown', () => {
  // 1. ATX headings
  it('renders ATX headings h1..h6', () => {
    const md = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6'
    const html = renderMarkdown(md)
    expect(html).toContain('<h1>H1</h1>')
    expect(html).toContain('<h2>H2</h2>')
    expect(html).toContain('<h3>H3</h3>')
    expect(html).toContain('<h4>H4</h4>')
    expect(html).toContain('<h5>H5</h5>')
    expect(html).toContain('<h6>H6</h6>')
  })

  // 2. paragraphs + line breaks
  it('renders a single paragraph', () => {
    expect(renderMarkdown('hello world')).toBe('<p>hello world</p>')
  })

  it('joins consecutive non-blank lines into one paragraph', () => {
    const html = renderMarkdown('line one\nline two')
    expect(html).toBe('<p>line one\nline two</p>')
  })

  it('splits paragraphs on blank lines', () => {
    const html = renderMarkdown('first\n\nsecond')
    expect(html).toContain('<p>first</p>')
    expect(html).toContain('<p>second</p>')
  })

  // 3. bold / italic / inline code
  it('renders **bold** and __bold__ as <strong>', () => {
    expect(renderMarkdown('a **b** c')).toContain('<strong>b</strong>')
    expect(renderMarkdown('a __b__ c')).toContain('<strong>b</strong>')
  })

  it('renders *italic* and _italic_ as <em>', () => {
    expect(renderMarkdown('a *b* c')).toContain('<em>b</em>')
    expect(renderMarkdown('a _b_ c')).toContain('<em>b</em>')
  })

  it('renders `inline code` as <code>', () => {
    expect(renderMarkdown('use `map` here')).toContain('<code>map</code>')
  })

  it('leaves unmatched markers as literal text', () => {
    expect(renderMarkdown('a * b * c')).toBe('<p>a * b * c</p>')
  })

  // 4. lists
  it('renders unordered list with - * +', () => {
    expect(renderMarkdown('- a\n- b')).toContain('<ul><li>a</li><li>b</li></ul>')
    expect(renderMarkdown('* a\n* b')).toContain('<ul><li>a</li><li>b</li></ul>')
    expect(renderMarkdown('+ a\n+ b')).toContain('<ul><li>a</li><li>b</li></ul>')
  })

  it('renders ordered list', () => {
    expect(renderMarkdown('1. a\n2. b')).toContain('<ol><li>a</li><li>b</li></ol>')
  })

  it('separates unordered and ordered lists', () => {
    const html = renderMarkdown('- a\n1. b')
    expect(html).toContain('<ul><li>a</li></ul>')
    expect(html).toContain('<ol><li>b</li></ol>')
  })

  // 5. pipe table
  it('renders a pipe table with header', () => {
    const md = '| Name | Age |\n| --- | --- |\n| Ada | 36 |'
    const html = renderMarkdown(md)
    expect(html).toContain('<table>')
    expect(html).toContain('<th>Name</th>')
    expect(html).toContain('<th>Age</th>')
    expect(html).toContain('<td>Ada</td>')
    expect(html).toContain('<td>36</td>')
  })

  it('handles escaped pipes in table cells', () => {
    const md = '| a\\|b | c |\n| --- | --- |\n| d | e |'
    const html = renderMarkdown(md)
    expect(html).toContain('<th>a|b</th>')
  })

  // 6. fenced code block
  it('renders fenced code block with language class', () => {
    const html = renderMarkdown('```ts\nconst x = 1\n```')
    expect(html).toContain('<pre><code class="language-ts">')
    expect(html).toContain('const x = 1')
  })

  it('renders fenced code block without language', () => {
    const html = renderMarkdown('```\nplain\n```')
    expect(html).toContain('<pre><code>')
    expect(html).toContain('plain')
  })

  // 7. blockquote
  it('renders a blockquote', () => {
    expect(renderMarkdown('> wisdom here')).toContain('<blockquote>wisdom here</blockquote>')
  })

  it('renders multi-line blockquote', () => {
    const html = renderMarkdown('> line1\n> line2')
    expect(html).toContain('<blockquote>line1\nline2</blockquote>')
  })

  // 8. link
  it('renders [text](url) as anchor', () => {
    const html = renderMarkdown('[click](https://example.com)')
    expect(html).toContain('<a href="https://example.com">click</a>')
  })

  it('escapes url with ampersand', () => {
    const html = renderMarkdown('[q](https://ex.com/?a=1&b=2)')
    expect(html).toContain('href="https://ex.com/?a=1&amp;b=2"')
  })

  // 9. thematic break
  it('renders --- as <hr>', () => {
    expect(renderMarkdown('a\n\n---\n\nb')).toContain('<hr>')
  })

  it('renders *** and ___ as <hr>', () => {
    expect(renderMarkdown('***')).toBe('<hr>')
    expect(renderMarkdown('___')).toBe('<hr>')
  })

  // 10. mermaid passthrough
  it('renders mermaid fence as <pre class="mermaid-raw"> with escaped content', () => {
    const md = '```mermaid\ngraph TD\nA-->B\n```'
    const html = renderMarkdown(md)
    expect(html).toBe('<pre class="mermaid-raw">graph TD\nA--&gt;B</pre>')
  })

  // 11. html passthrough
  it('renders html fence as <pre class="html-raw"> with escaped content', () => {
    const md = '```html\n<div>raw</div>\n```'
    const html = renderMarkdown(md)
    expect(html).toBe('<pre class="html-raw">&lt;div&gt;raw&lt;/div&gt;</pre>')
  })

  // ---- boundary cases ----

  it('returns empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('')
  })

  it('returns empty string for pure whitespace input', () => {
    expect(renderMarkdown('   \n  \n')).toBe('')
  })

  it('auto-closes unclosed code fence at EOF', () => {
    const html = renderMarkdown('```ts\nconst x = 1')
    expect(html).toContain('<pre><code class="language-ts">')
    expect(html).toContain('const x = 1')
    expect(html).toContain('</code></pre>')
  })

  it('auto-closes unclosed mermaid fence at EOF', () => {
    const html = renderMarkdown('```mermaid\ngraph TD\nA-->B')
    expect(html).toContain('<pre class="mermaid-raw">')
    expect(html).toContain('graph TD')
  })

  it('does not crash on an unclosed table (separator missing)', () => {
    // A line with pipes but no following separator is just a paragraph.
    const html = renderMarkdown('| a | b |')
    expect(html).toContain('<p>')
  })

  it('renders a standalone blockquote without trailing content', () => {
    const html = renderMarkdown('> quote')
    expect(html).toContain('<blockquote>quote</blockquote>')
  })

  it('escapes HTML special characters in text to prevent XSS', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('escapes HTML inside inline code', () => {
    const html = renderMarkdown('`<b>`')
    expect(html).toContain('<code>&lt;b&gt;</code>')
  })

  it('escapes HTML inside fenced code block', () => {
    const html = renderMarkdown('```\n<a>\n```')
    expect(html).toContain('&lt;a&gt;')
    expect(html).not.toContain('<a>')
  })

  it('escapes HTML inside heading', () => {
    const html = renderMarkdown('# <img src=x>')
    expect(html).toContain('&lt;img src=x&gt;')
  })

  it('handles CJK characters correctly', () => {
    const html = renderMarkdown('# 中文标题\n\n这是段落。')
    expect(html).toContain('<h1>中文标题</h1>')
    expect(html).toContain('<p>这是段落。</p>')
  })

  it('handles mixed inline formatting', () => {
    const html = renderMarkdown('a *b **c** d* e')
    expect(html).toContain('<em>b <strong>c</strong> d</em>')
  })

  it('handles a link inside a paragraph with surrounding text', () => {
    const html = renderMarkdown('see [docs](https://x.io) now')
    expect(html).toContain('see <a href="https://x.io">docs</a> now')
  })
})
