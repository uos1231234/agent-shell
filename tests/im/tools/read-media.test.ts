// read-media.test.ts — read an image file → base64 data URL.
//
// Coverage: (1) tiny 1x1 PNG → success with correct mime + data URL prefix,
// (2) non-image extension → ReadMediaError, (3) > 4 MB → ReadMediaError,
// (4) missing file → ReadMediaError.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readMedia, ReadMediaError } from '../../../src/im/tools/read-media.js'

// A minimal valid 1x1 transparent PNG (67 bytes).
const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

describe('readMedia', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'read-media-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads a tiny PNG → correct mime + data URL prefix', () => {
    const file = join(dir, 'pixel.png')
    writeFileSync(file, TINY_PNG)

    const result = readMedia(file)
    expect(result.mimeType).toBe('image/png')
    expect(result.content).toMatch(/^data:image\/png;base64,/)
    expect(result.base64).toBe(TINY_PNG.toString('base64'))
    // The content is the data URL form.
    expect(result.content).toBe(`data:image/png;base64,${result.base64}`)
  })

  it('maps .jpg and .jpeg to image/jpeg', () => {
    const jpg = join(dir, 'photo.jpg')
    writeFileSync(jpg, TINY_PNG) // content doesn't matter for mime detection
    expect(readMedia(jpg).mimeType).toBe('image/jpeg')

    const jpeg = join(dir, 'photo.jpeg')
    writeFileSync(jpeg, TINY_PNG)
    expect(readMedia(jpeg).mimeType).toBe('image/jpeg')
  })

  it('supports .gif and .webp', () => {
    for (const ext of ['gif', 'webp']) {
      const f = join(dir, `img.${ext}`)
      writeFileSync(f, TINY_PNG)
      const r = readMedia(f)
      expect(r.mimeType).toBe(ext === 'gif' ? 'image/gif' : 'image/webp')
    }
  })

  it('throws ReadMediaError for non-image extensions', () => {
    const f = join(dir, 'doc.txt')
    writeFileSync(f, 'hello')
    expect(() => readMedia(f)).toThrow(ReadMediaError)
    expect(() => readMedia(f)).toThrow(/Unsupported image type/)
  })

  it('throws ReadMediaError for missing file', () => {
    expect(() => readMedia(join(dir, 'nope.png'))).toThrow(ReadMediaError)
    expect(() => readMedia(join(dir, 'nope.png'))).toThrow(/not found/)
  })

  it('throws ReadMediaError when file exceeds 4 MB', () => {
    // Create a file just over 4 MB. We write a sparse-ish buffer by
    // constructing 4*1024*1024 + 1 bytes. writeFileSync handles it.
    const f = join(dir, 'big.png')
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1, 0)
    writeFileSync(f, oversized)
    expect(() => readMedia(f)).toThrow(ReadMediaError)
    expect(() => readMedia(f)).toThrow(/MB.*limit/)
  })
})
