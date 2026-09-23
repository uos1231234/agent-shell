// read-media.ts
//
// Read an image file and return it as a base64 data URL, suitable for feeding
// directly into a vision-capable model (OpenAI image_url content part format).
//
// Supported formats (by extension): png, jpg, jpeg, gif, webp.
// Size limit: 4 MB — vision APIs typically reject larger images, and base64
// encoding inflates size by ~33%, so a 4 MB image becomes ~5.3 MB of base64.

import { readFileSync, statSync, existsSync } from 'node:fs'
import { extname } from 'node:path'

export class ReadMediaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReadMediaError'
  }
}

export interface ReadMediaResult {
  /** data:<mime>;base64,<data> — usable directly as image_url.url */
  content: string
  mimeType: string
  base64: string
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

const MAX_BYTES = 4 * 1024 * 1024 // 4 MB

/**
 * Read an image file → base64 data URL.
 *
 * @throws {ReadMediaError} if the file doesn't exist, isn't a supported image
 *   type, or exceeds the 4 MB size limit.
 */
export function readMedia(filePath: string): ReadMediaResult {
  if (!existsSync(filePath)) {
    throw new ReadMediaError(`Image file not found: ${filePath}`)
  }

  const ext = extname(filePath).toLowerCase()
  const mimeType = MIME_BY_EXT[ext]
  if (!mimeType) {
    throw new ReadMediaError(
      `Unsupported image type "${ext}". Supported: png, jpg, jpeg, gif, webp.`,
    )
  }

  const stat = statSync(filePath)
  if (stat.size > MAX_BYTES) {
    throw new ReadMediaError(
      `Image is ${(stat.size / 1024 / 1024).toFixed(1)} MB; limit is 4 MB. Resize or crop the image first.`,
    )
  }

  const buf = readFileSync(filePath)
  const base64 = buf.toString('base64')
  return {
    content: `data:${mimeType};base64,${base64}`,
    mimeType,
    base64,
  }
}
