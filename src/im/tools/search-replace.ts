// search-replace.ts
//
// Cross-file find & replace. Walks `path` (already resolved to absolute by
// the registration layer), filters files by optional glob, applies literal
// or regex replacement, and writes back only files whose content actually
// changed. Honors .gitignore (reuses path.ts loader) and skips .git dirs.
//
// Design:
//   - The caller (tools/index.ts) resolves `path` via resolvePath(cwd, input).
//     searchReplace itself assumes `path` is absolute and does NOT call
//     resolvePath again.
//   - Literal mode uses split/join (no regex metachar surprises).
//   - Regex mode compiles `new RegExp(pattern, 'g')` so `$1` capture groups
//     work in the replacement string.
//   - `limit` caps how many files are *changed* (not scanned). Scanning
//     continues but writing stops once the cap is reached.

import { readdir, stat, readFile, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { matchGlob } from './glob.js'
import { loadGitignore, isIgnored, type GitignorePattern } from './path.js'
import { summarizeSnapshotGaps, type SnapshotContext, type SnapshotRecordResult } from './file-history.js'

export type SearchReplaceInput = {
  pattern: string
  replacement: string
  glob?: string
  path: string
  regex?: boolean
  limit?: number
  /** v0.29: 外部取消信号（turn.cancel / 用户关闭状态机）——协作式检查（JS 遍历，无子进程）。 */
  signal?: AbortSignal
}

export type SearchReplaceResult = {
  filesChanged: number
  changes: { file: string; count: number }[]
  /**
   * v0.36.1：本次改动里"留底没成、因此 /rewind 撤不回来"的汇总提示。
   * 缺省表示全部可撤（或本来就没开快照）。
   */
  snapshotNotice?: string
}

const DEFAULT_LIMIT = 100
const MAX_DEPTH = 32

const toForwardSlash = (p: string): string => p.split(sep).join('/')

/**
 * Apply a single replacement strategy to `content`, returning the new
 * content and the number of substitutions made.
 *
 * - Literal: split/join. Occurrences = split.length - 1.
 * - Regex:   global replace. Occurrences counted via match.
 */
const applyReplacement = (
  content: string,
  pattern: string,
  replacement: string,
  regex: boolean,
): { result: string; count: number } => {
  if (regex) {
    const re = new RegExp(pattern, 'g')
    const matches = content.match(re)
    const count = matches ? matches.length : 0
    if (count === 0) return { result: content, count: 0 }
    return { result: content.replace(re, replacement), count }
  }
  // Literal mode: split/join is safe against regex metacharacters.
  if (pattern === '') return { result: content, count: 0 }
  const parts = content.split(pattern)
  const count = parts.length - 1
  if (count === 0) return { result: content, count: 0 }
  return { result: parts.join(replacement), count }
}

const walk = async (
  root: string,
  dir: string,
  gitignore: GitignorePattern[],
  depth: number,
  out: string[],
  signal?: AbortSignal,
): Promise<void> => {
  // v0.29: 协作式取消——遍历中 abort 即停（JS 无子进程可杀，只能自己停）。
  if (signal?.aborted === true) throw new Error('search_replace was aborted by the caller.')
  if (depth > MAX_DEPTH) return
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const name of entries) {
    // Never descend into .git
    if (name === '.git') continue
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
    if (isDir) {
      await walk(root, abs, gitignore, depth + 1, out, signal)
    } else {
      out.push(abs)
    }
  }
}

export const searchReplace = async (
  input: SearchReplaceInput,
  snapshot?: SnapshotContext,
): Promise<SearchReplaceResult> => {
  const {
    pattern,
    replacement,
    glob,
    path,
    regex = false,
    limit = DEFAULT_LIMIT,
    signal,
  } = input

  if (pattern === '') {
    throw new Error('search_replace: pattern must not be empty')
  }
  if (typeof replacement !== 'string') {
    throw new Error('search_replace: replacement must be a string')
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`search_replace: limit must be a positive integer (got ${limit})`)
  }

  // Validate regex before scanning (fail fast with a clean message).
  if (regex) {
    try {
      new RegExp(pattern, 'g')
    } catch (e) {
      throw new Error(`search_replace: invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Collect candidate files (absolute paths).
  const gitignore = loadGitignore(path)
  const allFiles: string[] = []
  await walk(path, path, gitignore, 0, allFiles, signal)

  const changes: { file: string; count: number }[] = []
  const snapshotResults: SnapshotRecordResult[] = []
  let filesChanged = 0

  for (const abs of allFiles) {
    if (signal?.aborted === true) throw new Error('search_replace was aborted by the caller.')
    if (filesChanged >= limit) break

    // Optional glob filter (relative to search root, forward slashes).
    if (glob !== undefined) {
      const rel = toForwardSlash(relative(path, abs))
      if (!matchGlob(glob, rel)) continue
    }

    let content: string
    try {
      content = await readFile(abs, 'utf8')
    } catch {
      // Skip unreadable files (binary, permission, etc.)
      continue
    }

    const { result, count } = applyReplacement(content, pattern, replacement, regex)

    if (count === 0 || result === content) continue

    // v0.36: 写盘前留底（逐文件，因为一次 search_replace 会改多个文件）。
    // v0.36.1: 收集留底结果——一次改多个文件时，"其中几个撤不回来"要汇总告知。
    if (snapshot !== undefined) {
      snapshotResults.push(await snapshot.history.record(abs, snapshot.sessionId))
    }

    try {
      await writeFile(abs, result, 'utf8')
    } catch (e) {
      throw new Error(`search_replace: failed to write ${abs}: ${e instanceof Error ? e.message : String(e)}`)
    }

    changes.push({ file: abs, count })
    filesChanged += 1
  }

  const snapshotNotice = summarizeSnapshotGaps(snapshotResults)
  return { filesChanged, changes, ...(snapshotNotice === undefined ? {} : { snapshotNotice }) }
}
