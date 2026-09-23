// ast-grep.ts
//
// Structural code search via the ast-grep CLI binary. Searches by AST pattern
// instead of text — e.g. "console.log($$$)" matches calls regardless of
// argument text. Metavariables: $NAME captures one node, $$$NAME matches
// zero+ nodes.
//
// ast-grep (or `sg`) is a HARD dependency. There is no text-search fallback.
// If the binary is not on the system PATH, the resolver throws with install
// instructions, modeled on rg-resolver.ts.
//
// Contract:
//   --json=compact   single-line JSON array output
//   exit code 0      success (matches found or not)
//   non-zero exit    error — throws with stderr
//   null exit        timeout / abort / spawn error — throws
//
// Output cap: 10 MB on stdout. Timeout: 20s. Lifecycle on timeout:
// SIGTERM → 5s grace → SIGKILL (same pattern as rg-runner.ts).

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'

export type AstGrepInput = {
  pattern: string
  path: string
  lang?: string
  limit?: number          // default 100
  /** v0.29: 外部取消信号（turn.cancel / 用户关闭状态机）→ 终止 ast-grep 子进程。 */
  signal?: AbortSignal
}

// --- ast-grep JSON output schema (confirmed from source) -------------------
// Source: ast-grep/ast-grep crates/cli/src/print/json_print.rs
// MatchJSON struct, serde rename_all = "camelCase".
// All line/column numbers are ZERO-BASED.

type AstGrepPosition = {
  line: number      // 0-based
  column: number    // 0-based
}

type AstGrepRange = {
  byteOffset: [number, number]   // [start, end)
  start: AstGrepPosition
  end: AstGrepPosition
}

type AstGrepMatch = {
  text: string
  range: AstGrepRange
  file: string
  lines: string
  charCount: { leading: number; trailing: number }
  language: string
  replacement?: string
  replacementOffsets?: [number, number]
  metaVariables?: {
    single?: Record<string, { text: string; range: AstGrepRange }>
    multi?: Record<string, Array<{ text: string; range: AstGrepRange }>>
    transformed?: Record<string, string>
  }
}

// --- binary resolution ------------------------------------------------------

const CANDIDATE_NAMES = process.platform === 'win32'
  ? ['ast-grep.exe', 'sg.exe', 'ast-grep', 'sg']
  : ['ast-grep', 'sg']

export class AstGrepNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AstGrepNotFoundError'
  }
}

export const AST_GREP_INSTALL_INSTRUCTIONS = `ast-grep is required but was not found on your PATH.

Install it with one of:
  - cargo install ast-grep            (any platform with Rust)
  - brew install ast-grep             (macOS / Homebrew)
  - scoop install ast-grep            (Windows / Scoop)
  - npm install -g @ast-grep/cli      (Node.js)
  - Download from https://ast-grep.github.io/guide/installation.html

After installing, ensure the 'ast-grep' (or 'sg') binary is on your PATH and re-run.`

/**
 * Find the ast-grep binary on the system PATH by shelling out to the OS
 * lookup utility. Tries both `ast-grep` and `sg` candidate names.
 * Returns the absolute path or null if not found.
 */
const findOnSystemPath = (): string | null => {
  for (const name of CANDIDATE_NAMES) {
    try {
      if (process.platform === 'win32') {
        const out = execFileSync('where', [name], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5000,
          windowsHide: true,
        }).trim()
        const first = out.split(/\r?\n/)[0]
        if (first && existsSync(first)) return first
      } else {
        const out = execFileSync('which', [name], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5000,
          windowsHide: true,
        }).trim()
        if (out && existsSync(out)) return out
      }
    } catch {
      // this candidate not found, try next
    }
  }
  return null
}

/**
 * Resolve the ast-grep binary path.
 *
 * @throws AstGrepNotFoundError if the binary cannot be found.
 */
export const resolveAstGrep = (): string => {
  const found = findOnSystemPath()
  if (found) return found
  throw new AstGrepNotFoundError(AST_GREP_INSTALL_INSTRUCTIONS)
}

/**
 * Check whether ast-grep is available without throwing. Used by tests to
 * conditionally skip real-execution cases.
 */
export const isAstGrepAvailable = (): boolean => {
  try {
    resolveAstGrep()
    return true
  } catch {
    return false
  }
}

// --- execution --------------------------------------------------------------

const DEFAULT_LIMIT = 100
const DEFAULT_TIMEOUT_MS = 20_000
const GRACE_PERIOD_MS = 5_000
const OUTPUT_CAP_BYTES = 10 * 1024 * 1024  // 10 MB

type RunOptions = {
  cwd: string
  timeout?: number
  /** v0.29: 外部取消信号（turn.cancel / 用户关闭状态机）→ 终止 ast-grep 子进程。 */
  signal?: AbortSignal
}

/**
 * Run ast-grep with the given args and return raw stdout string.
 *
 * The caller builds the arg list. This is a thin execution layer modeled
 * on rg-runner.ts.
 *
 * @throws Error on non-zero exit, timeout, spawn failure, or output cap.
 */
const runAstGrep = async (
  binaryPath: string,
  args: string[],
  options: RunOptions,
): Promise<string> => {
  const cwd = options.cwd
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS

  return new Promise<string>((resolve, reject) => {
    const child: ChildProcess = spawn(binaryPath, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const stdoutChunks: Buffer[] = []
    let stdoutLen = 0
    let stderrText = ''
    let settled = false
    let timeoutTimer: NodeJS.Timeout | undefined
    let graceTimer: NodeJS.Timeout | undefined

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (graceTimer) clearTimeout(graceTimer)
      fn()
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
      stdoutLen += chunk.length
      if (stdoutLen > OUTPUT_CAP_BYTES) {
        tryKill(child, 'SIGKILL')
        finish(() => reject(new Error(
          `ast-grep output exceeded ${OUTPUT_CAP_BYTES} bytes (10 MB). ` +
          `Narrow your search (use a more specific pattern or a smaller path).`,
        )))
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString('utf8')
    })

    timeoutTimer = setTimeout(() => {
      tryKill(child, 'SIGTERM')
      graceTimer = setTimeout(() => {
        tryKill(child, 'SIGKILL')
      }, GRACE_PERIOD_MS)
    }, timeoutMs)

    // v0.29: 外部取消（turn.cancel / 用户关闭状态机）——abort 即杀子进程。
    const onAbort = (): void => {
      tryKill(child, 'SIGKILL')
      finish(() => reject(new Error('ast-grep was aborted by the caller.')))
    }
    if (options.signal) {
      if (options.signal.aborted) {
        tryKill(child, 'SIGKILL')
        finish(() => reject(new Error('ast-grep was aborted by the caller.')))
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
      child.on('exit', () => options.signal?.removeEventListener('abort', onAbort))
    }

    child.on('error', (err) => {
      finish(() => reject(new Error(
        `Failed to spawn ast-grep at "${binaryPath}": ${err.message}`,
      )))
    })

    child.on('exit', (code, sig) => {
      const raw = Buffer.concat(stdoutChunks).toString('utf8')

      // ast-grep exit code 0 = success (matches or no matches).
      // Non-zero = error.
      // NOTE: sg.exe (the legacy binary name, still shipped by winget) returns
      // exit code 1 with a "deprecated" warning on stderr even on success. We
      // detect this case: if stdout is valid JSON, the search succeeded and
      // the non-zero exit is just the deprecation noise.
      if (code === 0) {
        finish(() => resolve(raw))
        return
      }

      if (sig) {
        finish(() => reject(new Error(
          `ast-grep was killed by signal ${sig}` +
          (stderrText ? `: ${stderrText.trim()}` : ''),
        )))
        return
      }

      // Filter the sg.exe deprecation warning from stderr
      const filteredStderr = stderrText
        .split('\n')
        .filter(line => !line.includes('deprecated') && !line.includes('WARNING') && !line.includes('=====') && line.trim())
        .join('\n')

      // If stdout has valid JSON and stderr is just the deprecation warning,
      // treat as success (sg.exe compatibility).
      try {
        if (raw.trim()) JSON.parse(raw)
        if (filteredStderr.length === 0) {
          finish(() => resolve(raw))
          return
        }
      } catch {}

      const msg = filteredStderr || raw.trim() || `exited with code ${code}`
      finish(() => reject(new Error(`ast-grep error: ${msg}`)))
    })
  })
}

const tryKill = (child: ChildProcess, sig: NodeJS.Signals): void => {
  try {
    child.kill(sig)
  } catch {
    // already dead
  }
}

// --- parsing + formatting ---------------------------------------------------

/**
 * Parse ast-grep `--json=compact` output into match records.
 *
 * Output format (confirmed from source): a single-line JSON array of objects.
 * Empty result is `[]\n`.
 */
const parseAstGrepJson = (raw: string): AstGrepMatch[] => {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === '[]') return []
  let arr: unknown
  try {
    arr = JSON.parse(trimmed)
  } catch (e) {
    throw new Error(`ast-grep: failed to parse JSON output: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!Array.isArray(arr)) return []
  return arr as AstGrepMatch[]
}

/**
 * Format parsed matches into `path:line:content` style (like grep output).
 * Line numbers are converted from 0-based (ast-grep) to 1-based (tool contract).
 */
const formatMatches = (matches: AstGrepMatch[], limit: number): string => {
  if (matches.length === 0) return ''
  const out: string[] = []
  const cap = Math.min(matches.length, limit)
  for (let i = 0; i < cap; i += 1) {
    const m = matches[i]!
    const lineNum = m.range.start.line + 1
    // `lines` includes surrounding context; `text` is the matched text.
    // Use `lines` (full source line context) when available, fall back to text.
    const content = m.lines ?? m.text
    out.push(`${m.file}:${lineNum}:${content.replace(/\r?\n$/, '')}`)
  }
  if (matches.length > limit) {
    out.push(`...[truncated: ${matches.length - limit} more matches omitted]`)
  }
  return out.join('\n')
}

// --- main entry point -------------------------------------------------------

/**
 * Structural code search via ast-grep.
 *
 * @throws Error('ast_grep: ...') on binary missing, bad pattern, timeout, etc.
 */
export const astGrep = async (input: AstGrepInput): Promise<string> => {
  const { pattern, path: searchPath, lang, limit = DEFAULT_LIMIT, signal } = input

  // Resolve binary (throws AstGrepNotFoundError with install instructions).
  let binaryPath: string
  try {
    binaryPath = resolveAstGrep()
  } catch (e) {
    if (e instanceof AstGrepNotFoundError) {
      throw new Error(`ast_grep: ${e.message}`)
    }
    throw e
  }

  // If path doesn't exist, return empty (resolvePathForRead already checks
  // upstream, but this is a defensive guard for direct callers).
  if (!existsSync(searchPath)) {
    throw new Error(`ast_grep: path not found: ${searchPath}`)
  }

  const isFile = statSync(searchPath).isFile()

  // Build args: ast-grep --json=compact --pattern <pattern> [--lang <lang>] <path>
  const args: string[] = ['--json=compact', '--pattern', pattern]
  if (lang) {
    args.push('--lang', lang)
  }

  // For directories, ast-grep needs a path argument. For files, pass the file.
  // Use cwd = parent dir so paths in output are relative-ish.
  const cwd = isFile ? require('node:path').dirname(searchPath) : searchPath
  const targetArg = isFile ? require('node:path').basename(searchPath) : '.'
  args.push(targetArg)

  let raw: string
  try {
    raw = await runAstGrep(binaryPath, args, {
      cwd,
      ...(signal !== undefined ? { signal } : {}),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`ast_grep: ${msg}`)
  }

  const matches = parseAstGrepJson(raw)
  return formatMatches(matches, limit)
}
