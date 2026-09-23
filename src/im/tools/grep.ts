// grep.ts
//
// Searches files under a directory for lines matching a pattern. Output
// uses the `path:line:content` format. Honors .gitignore (via ripgrep's
// built-in gitignore support) and an optional glob filter.
//
// ripgrep (rg) is a HARD dependency. There is no Node RegExp fallback.
// If rg is not on the system PATH the resolver throws RgNotFoundError with
// install instructions. The runner is resolved once at module load and
// reused for every search.

import { existsSync, statSync } from 'node:fs'
import { sep, join } from 'node:path'
import { resolveRg, RgNotFoundError } from './search/rg-resolver.js'
import { RgRunner, type RgMatch } from './search/rg-runner.js'

export type GrepInput = {
  pattern: string
  path: string
  glob?: string
  ignoreCase?: boolean
  literal?: boolean
  context?: number
  limit?: number
  /** v0.29: 外部取消信号（turn.cancel / 用户关闭状态机）→ rg 子进程终止。 */
  signal?: AbortSignal
}

export { RgNotFoundError }

const DEFAULT_LIMIT = 100

// Resolve rg once at module load. If rg is missing, every grep call will
// throw — but we defer the throw to call time (lazy) so that importing the
// module (e.g. in tests that don't call grepFiles) does not crash.
let runnerPromise: Promise<RgRunner> | null = null

const getRunner = (): Promise<RgRunner> => {
  if (runnerPromise === null) {
    runnerPromise = (async () => {
      const res = await resolveRg()
      return new RgRunner(res.path)
    })()
  }
  return runnerPromise
}

/**
 * Build the ripgrep argument list from a GrepInput.
 *
 * Strategy:
 *   --json              structured output (parsed by RgRunner)
 *   --color never       no ANSI escapes
 *   --no-heading        plain path:line:content style (for non-JSON fallback)
 *   --line-number       always include line numbers
 *   --max-count N       limit matches per file (we also cap globally)
 *   -C N                context lines
 *   -i                  ignore case (or smart-case if ignoreCase + has upper)
 *   --fixed-strings     literal mode
 *   -g pattern          glob filter
 *   .                   search cwd-relative (so rg returns relative paths)
 */
const buildArgs = (input: GrepInput): string[] => {
  const {
    pattern, glob, ignoreCase = false, literal = false,
    context = 0, limit = DEFAULT_LIMIT,
  } = input

  const args: string[] = [
    '--json',
    '--color', 'never',
    '--line-number',
  ]

  // Context lines.
  if (context > 0) {
    args.push('-C', String(context))
  }

  // Glob filter. rg's -g accepts the same glob syntax the LLM is used to.
  if (glob) {
    args.push('-g', glob)
  }

  // Case sensitivity.
  // rg default is smart-case (case-sensitive unless pattern has no uppercase).
  // -i forces ignore-case. We honor ignoreCase explicitly.
  if (ignoreCase) {
    args.push('-i')
  }

  // Literal mode.
  if (literal) {
    args.push('--fixed-strings')
  }

  // Limit matches per file. rg's --max-count is per-file; we also cap
  // globally in post-processing to respect the overall `limit`.
  args.push('--max-count', String(limit))

  // The pattern itself.
  args.push('--', pattern)

  // Search the current directory (.) so rg emits relative paths.
  args.push('.')

  return args
}

/**
 * Normalize a path returned by rg so it uses forward slashes and has no
 * leading `./` prefix. rg emits paths relative to the cwd we pass, using
 * the OS native separator (backslash on Windows). We normalize to the
 * forward-slash style the tool contract has always used.
 */
const normalizePath = (p: string): string => {
  let n = p.split(sep).join('/')
  if (n.startsWith('./')) n = n.slice(2)
  return n
}

/**
 * Format parsed matches into the `path:line:content` string the tool
 * contract promises. Context lines are prefixed with `-` (like grep -C).
 */
const formatMatches = (matches: RgMatch[], limit: number): string => {
  if (matches.length === 0) return ''
  const out: string[] = []
  for (const m of matches) {
    if (out.length >= limit) break
    const prefix = m.isContext ? '-' : ''
    const p = normalizePath(m.path)
    out.push(`${prefix}${p}:${m.lineNumber}:${m.content}`)
  }
  return out.join('\n')
}

export const grepFiles = async (input: GrepInput): Promise<string> => {
  const { path: searchPath } = input

  // If the search path doesn't exist, return empty (no matches) rather
  // than letting rg fail with exit code 2.
  if (!existsSync(searchPath)) return ''
  // rg can search a single file or a directory. If it's a file, we pass
  // the file path as cwd is not appropriate — rg needs the file as an
  // argument. For directories, we use cwd = searchPath and search '.'.
  const isFile = statSync(searchPath).isFile()

  const runner = await getRunner()

  const args = buildArgs(input)
  // For a single file, replace the '.' argument with the file path (as
  // an absolute path, so rg includes it regardless of cwd).
  if (isFile) {
    args[args.length - 1] = searchPath
  }

  let matches: RgMatch[]
  try {
    matches = await runner.run(args, {
      cwd: isFile ? join(searchPath, '..') : searchPath,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })
  } catch (e) {
    if (e instanceof RgNotFoundError) throw e
    throw e
  }

  const limit = input.limit ?? DEFAULT_LIMIT
  return formatMatches(matches, limit)
}
