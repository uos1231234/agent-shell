// path.ts
//
// Path utilities for the built-in file tools.
// Responsibilities:
//   - resolvePath(cwd, input): the single resolver for the path tools
//     (read / write / edit / ls / find / grep, wired in tools/index.ts).
//     Anchors relative paths to the tool's configured cwd and REJECTS
//     absolute paths that escape the cwd (throws "Path escapes working
//     directory"). To allow access elsewhere, call the tools factory with
//     a wider cwd.
//   - loadGitignore(cwd): read .gitignore from cwd if present.
//   - isIgnored(rel, isDir, patterns): check a path against the patterns.
//
// We deliberately support only a subset of .gitignore:
//   - `#` comments and blank lines are skipped
//   - `pattern/` means dir-only
//   - `!pattern` means negate
//   - `/pattern` means anchored (must match from the root)
//   - glob wildcards `*` `?` are supported via the shared glob matcher

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, normalize, isAbsolute, relative, sep, dirname, basename, extname } from 'node:path'
import { matchGlob } from './glob.js'

export type GitignorePattern = {
  pattern: string
  dirOnly: boolean
  negate: boolean
  anchored: boolean
}

export const parseGitignoreLine = (raw: string): GitignorePattern | null => {
  const line = raw.trim()
  if (line === '' || line.startsWith('#')) return null
  let p = line
  let negate = false
  let dirOnly = false
  let anchored = false
  if (p.startsWith('!')) { negate = true; p = p.slice(1) }
  if (p.startsWith('/')) { anchored = true; p = p.slice(1) }
  if (p.endsWith('/')) { dirOnly = true; p = p.slice(0, -1) }
  if (p === '') return null
  return { pattern: p, dirOnly, negate, anchored }
}

// The platform separator. Used to convert "**" patterns to the host style
// so a single .gitignore works on both Windows and POSIX.
const platformSep = sep

// Adapt a gitignore pattern (always uses forward slashes) to a matcher
// against a path that uses the host's native separator.
const matchGitignore = (pattern: GitignorePattern, relPath: string, isDir: boolean): boolean => {
  if (pattern.dirOnly && !isDir) return false
  // Convert the pattern's `/` to the platform separator for matching.
  const pat = pattern.pattern.split('/').join(platformSep)
  const path = relPath.split('/').join(platformSep)
  if (pattern.anchored) {
    return matchGlob(pat, path)
  }
  // Unanchored: match the basename OR any trailing segment of the path.
  const segments = path.split(platformSep)
  for (let i = 0; i < segments.length; i += 1) {
    const tail = segments.slice(i).join(platformSep)
    if (matchGlob(pat, tail)) return true
  }
  return false
}

export const isIgnored = (relPath: string, isDir: boolean, patterns: GitignorePattern[]): boolean => {
  let ignored = false
  for (const p of patterns) {
    if (matchGitignore(p, relPath, isDir)) {
      ignored = !p.negate
    }
  }
  return ignored
}

export const loadGitignore = (cwd: string): GitignorePattern[] => {
  const file = join(cwd, '.gitignore')
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const out: GitignorePattern[] = []
  for (const line of lines) {
    const p = parseGitignoreLine(line)
    if (p) out.push(p)
  }
  return out
}

// --- not-found hint (v0.15) -----------------------------------------------

/** Build / VCS / cache directories never descended into for hints. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'target', '__pycache__', '.next', 'dist', 'build',
  '.cache', 'vendor', '.venv', 'venv', '.idea', '.vscode', 'datalog',
  'logs', 'log', '.atomcode', '.claude', 'runs',
])

/** Binary file extensions — skipped in hints to avoid dumping garbage. */
const SKIP_EXTS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.lib',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
  '.mp3', '.mp4', '.avi', '.mov', '.wav',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.pyc', '.pyo', '.class', '.jar',
])

const HINT_MAX_ENTRIES = 40
const HINT_MAX_LINE = 200

/**
 * Generate a helpful hint when a path is not found.
 *
 * Walks up from the missing path to find the nearest existing ancestor,
 * then lists its entries (directories first, then files, sorted).
 *
 * Global mode (D4=B): no cwd boundary — but still skips home directory
 * and sensitive locations to avoid information leakage.
 */
export function notFoundHint(missing: string): string {
  // Walk up to find nearest existing ancestor
  let cur = normalize(missing)
  let ancestor: string | null = null
  while (cur !== dirname(cur)) {
    if (existsSync(cur)) { ancestor = cur; break }
    cur = dirname(cur)
  }
  if (!ancestor) return ''

  // Skip home directory — never enumerate another user's home
  const home = process.env['HOME'] ?? process.env['USERPROFILE']
  if (home && ancestor.toLowerCase() === home.toLowerCase()) return ''

  // Skip if ancestor itself is a build/VCS/cache dir
  if (SKIP_DIRS.has(basename(ancestor))) return ''

  let entries: string[]
  try {
    entries = readdirSync(ancestor)
  } catch {
    return ''
  }

  const dirs: string[] = []
  const files: string[] = []
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const abs = join(ancestor, name)
    let isDir = false
    try {
      isDir = statSync(abs).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      dirs.push(name + '/')
    } else {
      // Skip binary files
      const ext = extname(name).toLowerCase()
      if (SKIP_EXTS.has(ext)) continue
      files.push(name)
    }
  }

  if (dirs.length === 0 && files.length === 0) {
    return `\nNearest existing directory: ${ancestor} (it is empty).`
  }

  dirs.sort((a, b) => a.localeCompare(b))
  files.sort((a, b) => a.localeCompare(b))

  const all = [...dirs, ...files]
  const shown = all.slice(0, HINT_MAX_ENTRIES)
  const truncated = all.length > HINT_MAX_ENTRIES

  const lines = shown.map(n => {
    if (n.length > HINT_MAX_LINE) return n.slice(0, HINT_MAX_LINE) + '…'
    return n
  })
  if (truncated) lines.push(`… (+${all.length - HINT_MAX_ENTRIES} more)`)

  return `\nNearest existing directory: ${ancestor} — contains: ${lines.join(', ')}`
}

export const resolvePath = (cwd: string, input: string): string => {
  const abs = isAbsolute(input) ? normalize(input) : normalize(join(cwd, input))
  const rel = relative(cwd, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path escapes working directory: ${input}`)
  }
  return abs
}

/**
 * Resolve a path for read-only access (read/ls/find/grep/edit).
 * Like resolvePath but also checks existence and provides a helpful
 * not-found hint for the LLM.
 *
 * v0.15: Separated from resolvePath because write/edit tools legitimately
 * operate on non-existent paths (write creates, edit's readFile will fail
 * with its own clear error).
 */
export const resolvePathForRead = (cwd: string, input: string): string => {
  const abs = resolvePath(cwd, input)
  if (!existsSync(abs)) {
    const hint = notFoundHint(abs)
    throw new Error(`Path not found: ${input}${hint}`)
  }
  return abs
}
