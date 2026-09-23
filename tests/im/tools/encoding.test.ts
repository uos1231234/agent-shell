// encoding.test.ts
import { describe, it, expect } from 'vitest'
import iconvLite from 'iconv-lite'
import { detectEncoding, decode, encode, decodeForEdit } from '../../../src/im/tools/encoding.js'

describe('detectEncoding', () => {
  it('detects valid UTF-8 as utf8', () => {
    const buf = Buffer.from('hello 世界\n', 'utf8')
    expect(detectEncoding(buf, 'a.txt')).toBe('utf8')
  })

  it('detects UTF-8 with BOM as utf8', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello', 'utf8')])
    expect(detectEncoding(buf, 'a.txt')).toBe('utf8')
  })

  it('detects GBK file as gb18030 (round-trip passes)', () => {
    const buf = iconvLite.encode('你好世界\n第一行\n', 'gbk')
    expect(detectEncoding(buf, 'notes.txt')).toBe('gb18030')
  })

  it('detects GB18030 file as gb18030', () => {
    // GB18030 is a superset of GBK; encode with gb18030 codec
    const buf = iconvLite.encode('第一行\n第二行\n', 'gb18030')
    expect(detectEncoding(buf, 'notes.txt')).toBe('gb18030')
  })

  it('returns utf8 for pure ASCII (valid UTF-8 wins)', () => {
    const buf = Buffer.from('plain ascii text\n', 'utf8')
    expect(detectEncoding(buf, 'a.txt')).toBe('utf8')
  })

  it('returns utf8 for non-text extension even if bytes are GBK', () => {
    const buf = iconvLite.encode('你好世界', 'gbk')
    // .png is not in the text whitelist — no GB18030 probe
    expect(detectEncoding(buf, 'image.png')).toBe('utf8')
  })

  it('returns utf8 for non-text extension binary bytes', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(detectEncoding(buf, 'photo.png')).toBe('utf8')
  })

  it('falls back to utf8 when bytes are not valid UTF-8 and not round-trip GB18030', () => {
    // 0x80 is invalid UTF-8 and not a valid GB18030 lead byte → round-trip fails
    const buf = Buffer.concat([Buffer.from('plain text\n', 'utf8'), Buffer.from([0x80]), Buffer.from('\n', 'utf8')])
    expect(detectEncoding(buf, 'weird.txt')).toBe('utf8')
  })

  it('handles .md extension (in whitelist)', () => {
    const buf = iconvLite.encode('标题\n', 'gbk')
    expect(detectEncoding(buf, 'readme.md')).toBe('gb18030')
  })

  it('handles .csv extension (in whitelist)', () => {
    const buf = iconvLite.encode('姓名,年龄\n张三,20\n', 'gbk')
    expect(detectEncoding(buf, 'data.csv')).toBe('gb18030')
  })

  it('handles .log extension (in whitelist)', () => {
    const buf = iconvLite.encode('日志信息\n', 'gbk')
    expect(detectEncoding(buf, 'app.log')).toBe('gb18030')
  })
})

describe('decode', () => {
  it('decodes UTF-8 buffer to string', () => {
    const buf = Buffer.from('hello 世界', 'utf8')
    expect(decode(buf, 'utf8')).toBe('hello 世界')
  })

  it('decodes GB18030 buffer to string', () => {
    const buf = iconvLite.encode('你好世界', 'gb18030')
    expect(decode(buf, 'gb18030')).toBe('你好世界')
  })

  it('decodes GBK buffer via gb18030 codec (superset)', () => {
    const buf = iconvLite.encode('你好世界', 'gbk')
    expect(decode(buf, 'gb18030')).toBe('你好世界')
  })
})

describe('encode', () => {
  it('encodes string to UTF-8 buffer', () => {
    const buf = encode('hello 世界', 'utf8')
    expect(buf.equals(Buffer.from('hello 世界', 'utf8'))).toBe(true)
  })

  it('encodes string to GB18030 buffer', () => {
    const buf = encode('你好世界', 'gb18030')
    expect(buf.equals(Buffer.from(iconvLite.encode('你好世界', 'gb18030')))).toBe(true)
  })

  it('round-trips: encode(decode(buf)) == buf for GB18030', () => {
    const original = iconvLite.encode('第一行\n第二行\n', 'gb18030')
    const decoded = decode(original, 'gb18030')
    const reencoded = encode(decoded, 'gb18030')
    expect(reencoded.equals(original)).toBe(true)
  })

  it('round-trips: encode(decode(buf)) == buf for UTF-8', () => {
    const original = Buffer.from('hello 世界\n', 'utf8')
    const decoded = decode(original, 'utf8')
    const reencoded = encode(decoded, 'utf8')
    expect(reencoded.equals(original)).toBe(true)
  })
})

describe('decodeForEdit', () => {
  it('returns utf8 for valid UTF-8', () => {
    const buf = Buffer.from('hello 世界\n', 'utf8')
    const result = decodeForEdit(buf, 'a.txt')
    expect(result).not.toBeNull()
    expect(result!.encoding).toBe('utf8')
    expect(result!.text).toBe('hello 世界\n')
  })

  it('returns gb18030 for GBK file that round-trips', () => {
    const buf = iconvLite.encode('第一行\n第二行\n', 'gbk')
    const result = decodeForEdit(buf, 'notes.txt')
    expect(result).not.toBeNull()
    expect(result!.encoding).toBe('gb18030')
    expect(result!.text).toBe('第一行\n第二行\n')
  })

  it('returns null for non-text extension with non-UTF-8 bytes', () => {
    const buf = iconvLite.encode('你好', 'gbk')
    expect(decodeForEdit(buf, 'blob.bin')).toBeNull()
  })

  it('returns null for ambiguous bytes that fail round-trip', () => {
    // 0x80 is invalid UTF-8 and not valid GB18030 lead byte
    const buf = Buffer.concat([Buffer.from('plain text\n', 'utf8'), Buffer.from([0x80]), Buffer.from('\n', 'utf8')])
    expect(decodeForEdit(buf, 'weird.txt')).toBeNull()
  })

  it('returns utf8 for pure ASCII', () => {
    const buf = Buffer.from('plain ascii\n', 'utf8')
    const result = decodeForEdit(buf, 'a.txt')
    expect(result).not.toBeNull()
    expect(result!.encoding).toBe('utf8')
  })

  it('re-encoding unmodified decoded text reproduces exact bytes (gb18030)', () => {
    const original = iconvLite.encode('第一行\n第二行\n', 'gb18030')
    const result = decodeForEdit(original, 'notes.txt')
    expect(result).not.toBeNull()
    const reencoded = encode(result!.text, result!.encoding)
    expect(reencoded.equals(original)).toBe(true)
  })
})

describe('known GBK text scenario (Windows Notepad style)', () => {
  it('detects and decodes a GBK "中文 test.txt" file', () => {
    // Simulate a file saved by Windows Notepad in GBK encoding
    const content = '中文 test\n这是第二行\n'
    const buf = iconvLite.encode(content, 'gbk')
    const enc = detectEncoding(buf, 'test.txt')
    expect(enc).toBe('gb18030')
    expect(decode(buf, enc)).toBe(content)
  })

  it('edit round-trip: read GBK file, "edit" text, write back as GBK', () => {
    // Simulate the edit.ts flow: decode → modify → encode
    const originalText = '第一行\n第二行\n'
    const buf = iconvLite.encode(originalText, 'gbk')
    const result = decodeForEdit(buf, 'notes.txt')
    expect(result).not.toBeNull()

    // Simulate an edit: replace '第一行' with '修改后'
    const editedText = result!.text.replace('第一行', '修改后')
    const writtenBuf = encode(editedText, result!.encoding)

    // The written buffer should be valid GB18030 and decode back to the edited text
    expect(iconvLite.decode(writtenBuf, 'gb18030')).toBe('修改后\n第二行\n')
  })
})
