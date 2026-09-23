// find.ts
//
// Recursively walks a directory and returns paths that match a glob pattern.
// The pattern uses the same subset as the shared glob matcher (`*`, `?`, `**`).
// Output is one path per line, relative to the search root, with forward
// slashes. `.gitignore` is honored.

import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { matchGlob } from './glob.js'
import { loadGitignore, isIgnored, type GitignorePattern } from './path.js'

export type FindInput = {
  pattern: string
  path: string
  limit?: number
  /** v0.29: 外部取消信号（turn.cancel / 用户关闭状态机）——协作式检查（JS 遍历）。 */
  signal?: AbortSignal
}

const DEFAULT_LIMIT = 1000
const MAX_DEPTH = 32  // safety net against pathological symlink loops

const toForwardSlash = (p: string): string => p.split(sep).join('/')

const walk = async (
  root: string,
  dir: string,
  pattern: string,
  gitignore: GitignorePattern[],
  depth: number,
  out: string[],
  signal?: AbortSignal,
): Promise<void> => {
  // v0.29: 协作式取消——遍历中 abort 即停。
  if (signal?.aborted === true) throw new Error('find was aborted by the caller.')
  if (depth > MAX_DEPTH) return
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const abs = join(dir, name)
    const rel = toForwardSlash(relative(root, abs))
    let isDir = false
    try {
      const s = await stat(abs)
      isDir = s.isDirectory()
    } catch {
      continue
    }
    if (isIgnored(rel, isDir, gitignore)) continue
    if (matchGlob(pattern, rel)) {
      out.push(rel)
    }
    if (isDir) {
      await walk(root, abs, pattern, gitignore, depth + 1, out, signal)
    }
  }
}

export const findFiles = async (input: FindInput): Promise<string> => {
  const { pattern, path, limit = DEFAULT_LIMIT, signal } = input
  const gitignore = loadGitignore(path)
  const out: string[] = []
  await walk(path, path, pattern, gitignore, 0, out, signal)
  out.sort()
  return out.slice(0, limit).join('\n')
}
