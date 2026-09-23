// read.ts
//
// Reads a text file and returns it as a single string with each line
// prefixed by a 1-based line number and a tab. The offset/limit fields
// match the conventions used by pi's `read` tool.

import { readFile as fsReadFile } from 'node:fs/promises'
import { detectEncoding, decode } from './encoding.js'

export type ReadInput = {
  path: string
  offset?: number
  limit?: number
}

/**
 * Read a text file with automatic encoding detection (UTF-8 / GB18030).
 *
 * For non-text extensions (`.png` etc.) encoding is always `'utf8'` — the
 * historical behavior is preserved (bytes decoded as utf8 with replacement
 * chars for invalid sequences).
 */
export const readFile = async (input: ReadInput): Promise<string> => {
  const { path, offset, limit } = input
  if (offset !== undefined && offset < 1) {
    throw new Error(`offset must be >= 1, got ${offset}`)
  }
  if (limit !== undefined && limit < 1) {
    throw new Error(`limit must be >= 1, got ${limit}`)
  }
  const buf = await fsReadFile(path)
  const enc = detectEncoding(buf, path)
  const raw = decode(buf, enc)
  const allLines = raw.split('\n')
  const hasTrailingNewline = allLines.length > 0 && allLines[allLines.length - 1] === ''
  const contentLines = hasTrailingNewline ? allLines.slice(0, -1) : allLines

  const start = (offset ?? 1) - 1
  if (start >= contentLines.length) return ''
  const end = limit !== undefined ? Math.min(start + limit, contentLines.length) : contentLines.length
  const selected = contentLines.slice(start, end)
  return selected.map((line, i) => `${start + 1 + i}\t${line}`).join('\n')
}
