// Tiny helper that exposes this package's version for the MCP client handshake
// (Client({ name, version })). Kept separate from connection.ts so the SDK
// touchpoint file stays focused on transport logic. Reads package.json at
// runtime via node:fs so it survives renames without a code change.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')

let cached: string | undefined

/**
 * The version string from package.json (e.g. "0.1.0"). Falls back to "0.0.0"
 * if the file cannot be read — the handshake still works, just with a less
 * precise version reported to the server.
 */
export function packageVersion(): string {
  if (cached !== undefined) return cached
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }
    cached = typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    cached = '0.0.0'
  }
  return cached
}
