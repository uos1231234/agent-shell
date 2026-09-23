// encoding.ts
//
// Shared text-encoding helpers for the file tools (read.ts / edit.ts).
//
// Files are UTF-8 by default, but Chinese Windows editors routinely write
// `.txt`/`.md`/source files as GBK (a subset of GB18030). This module:
//   - detects whether a Buffer is valid UTF-8 or GB18030 (with a round-trip
//     guard so an ambiguous file is never mis-classified),
//   - decodes a Buffer to a UTF-8 string,
//   - encodes a UTF-8 string back to the original on-disk encoding.
//
// Safety: a legacy encoding is only ever claimed when a full decode→re-encode
// reproduces the file's exact bytes. That makes an in-place edit lossless for
// the untouched content and refuses ambiguous files (Latin-1, Big5, truncated
// UTF-8, binary) instead of corrupting them. Mirrors the AtomCode approach in
// `atomcode-capabilities/src/tools/encoding.rs`.

import iconvLite from 'iconv-lite'
import { extname } from 'node:path'

export type FileEncoding = 'utf8' | 'gb18030'

/** Text-ish extensions worth trying a GB18030 decode for when UTF-8 fails. */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.tsv', '.json',
  '.yaml', '.yml', '.xml', '.html', '.htm',
  '.log', '.conf', '.ini', '.properties',
])

function hasTextExtension(filename: string): boolean {
  const ext = extname(filename).toLowerCase()
  return TEXT_EXTENSIONS.has(ext)
}

/**
 * Pure-byte UTF-8 validator.
 *
 * Node's `Buffer.isUtf8()` was only added in v23.1.0 / v22.17.0 (behind a
 * flag at first) and is not reliably available across the supported Node
 * 18+ range. This hand-rolled validator implements the exact UTF-8 byte
 * sequence rules from RFC 3629:
 *   - 1-byte: 0xxxxxxx (0x00–0x7F)
 *   - 2-byte: 110xxxxx 10xxxxxx (lead 0xC2–0xDF; excludes overlong 0xC0/0xC1)
 *   - 3-byte: 1110xxxx 10xxxxxx 10xxxxxx (lead 0xE0–0xEF; 0xE0 requires
 *     second byte ≥ 0xA0; 0xED requires second byte ≤ 0x9F to exclude
 *     surrogates)
 *   - 4-byte: 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx (lead 0xF0–0xF4; 0xF0
 *     requires second byte ≥ 0x90; 0xF4 requires second byte ≤ 0x8F to
 *     stay within Unicode range)
 *
 * Returns `true` only if EVERY byte is part of a valid sequence.
 */
function isValidUtf8(buf: Buffer): boolean {
  let i = 0
  const len = buf.length
  while (i < len) {
    const b0 = buf[i]!
    if (b0 <= 0x7f) {
      // ASCII
      i += 1
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      // 2-byte sequence
      if (i + 1 >= len) return false
      if ((buf[i + 1]! & 0xc0) !== 0x80) return false
      i += 2
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      // 3-byte sequence
      if (i + 2 >= len) return false
      const b1 = buf[i + 1]!
      const b2 = buf[i + 2]!
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) return false
      // Reject overlongs and surrogates
      if (b0 === 0xe0 && b1 < 0xa0) return false
      if (b0 === 0xed && b1 > 0x9f) return false
      i += 3
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      // 4-byte sequence
      if (i + 3 >= len) return false
      const b1 = buf[i + 1]!
      const b2 = buf[i + 2]!
      const b3 = buf[i + 3]!
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) return false
      // Reject overlongs and out-of-range (> U+10FFFF)
      if (b0 === 0xf0 && b1 < 0x90) return false
      if (b0 === 0xf4 && b1 > 0x8f) return false
      i += 4
    } else {
      // 0x80–0xBF (lone continuation), 0xC0/0xC1 (overlong 2-byte), 0xF5–0xFF (out of range)
      return false
    }
  }
  return true
}

/**
 * Detect the on-disk encoding of a buffer.
 *
 * Decision tree:
 *   1. Non-text extension (e.g. `.png`) → `'utf8'` (no encoding concept;
 *      caller treats as binary, read.ts will still return the bytes decoded
 *      as utf8 which is the historical behavior).
 *   2. Valid UTF-8 → `'utf8'`.
 *   3. Text extension + GB18030 decode + round-trip (`encode(decode(buf))`
 *      equals original bytes) → `'gb18030'`.
 *   4. Anything else → `'utf8'` (fallback; read.ts will emit replacement
 *      chars, edit.ts will refuse via the round-trip guard in
 *      `decodeForEdit`).
 */
export function detectEncoding(buf: Buffer, filename: string): FileEncoding {
  // Gate 1: only probe text-ish files. Binary files have no encoding.
  if (!hasTextExtension(filename)) return 'utf8'

  // Gate 2: valid UTF-8 wins immediately.
  if (isValidUtf8(buf)) return 'utf8'

  // Gate 3: try GB18030 with a round-trip guard.
  try {
    const decoded = iconvLite.decode(buf, 'gb18030')
    const reencoded = iconvLite.encode(decoded, 'gb18030')
    if (Buffer.from(reencoded).equals(buf)) return 'gb18030'
  } catch {
    // decode threw — definitely not GB18030
  }
  return 'utf8'
}

/** Decode a buffer to a UTF-8 string using the given encoding. */
export function decode(buf: Buffer, enc: FileEncoding): string {
  if (enc === 'gb18030') return iconvLite.decode(buf, 'gb18030')
  return buf.toString('utf8')
}

/** Encode a UTF-8 string back to the on-disk encoding. */
export function encode(s: string, enc: FileEncoding): Buffer {
  if (enc === 'gb18030') return Buffer.from(iconvLite.encode(s, 'gb18030'))
  return Buffer.from(s, 'utf8')
}

/**
 * Decode a file for EDITING: return its text as UTF-8 plus the encoding to
 * write back, or `null` if the file cannot be losslessly decoded.
 *
 * Unlike `detectEncoding` + `decode` (which always returns a string for
 * display, falling back to utf8 with replacement chars), this is strict:
 * a file that is neither valid UTF-8 nor round-trip-safe GB18030 is refused
 * so edit.ts never corrupts an ambiguous file.
 *
 * - Valid UTF-8 → `{ text, encoding: 'utf8' }`.
 * - Text extension + GB18030 round-trip → `{ text, encoding: 'gb18030' }`.
 * - Anything else → `null` (caller refuses the edit).
 */
export function decodeForEdit(
  buf: Buffer,
  filename: string,
): { text: string; encoding: FileEncoding } | null {
  if (isValidUtf8(buf)) {
    return { text: buf.toString('utf8'), encoding: 'utf8' }
  }
  if (!hasTextExtension(filename)) return null
  try {
    const decoded = iconvLite.decode(buf, 'gb18030')
    const reencoded = iconvLite.encode(decoded, 'gb18030')
    if (Buffer.from(reencoded).equals(buf)) {
      return { text: decoded, encoding: 'gb18030' }
    }
  } catch {
    // not GB18030
  }
  return null
}
