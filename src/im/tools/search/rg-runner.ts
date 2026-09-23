// rg-runner.ts
//
// Executes ripgrep as a child process and parses its `--json` output stream
// into structured RgMatch records. One rg invocation per call — no reuse,
// no pooling. The runner is stateless beyond the resolved binary path.
//
// Contract:
//   exit code 0  → success (matches found, or pattern matched with no output)
//   exit code 1  → no matches — returns []
//   exit code 2  → error (bad regex, permission, etc.) — throws
//   null exit    → timeout / abort / spawn error — throws
//
// Lifecycle on timeout: SIGTERM → 5s grace → SIGKILL.
// Lifecycle on abort:   immediate SIGKILL (AbortSignal is user-initiated).
// Output cap: 10 MB on stdout — beyond that we kill the process (the user
// asked for too broad a search) and throw.

import { spawn, type ChildProcess } from 'node:child_process'

export type RgMatch = {
  path: string
  lineNumber: number
  content: string
  isContext: boolean
}

export type RgRunOptions = {
  cwd: string
  timeout?: number  // ms, default 20000
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 20_000
const GRACE_PERIOD_MS = 5_000
const OUTPUT_CAP_BYTES = 10 * 1024 * 1024  // 10 MB

// --json line types we care about. rg emits one JSON object per line.
type RgJsonLine = {
  type: 'begin' | 'end' | 'match' | 'context' | 'summary'
  data?: {
    path?: { text?: string }
    line_number?: number
    lines?: { text?: string }
  }
}

/**
 * Parse the raw `rg --json` stdout (one JSON object per line) into matches.
 * Only `match` and `context` lines produce RgMatch records; `begin`/`end`/
 * `summary` are structural markers we skip.
 */
export const parseRgJsonOutput = (raw: string): RgMatch[] => {
  const out: RgMatch[] = []
  const lines = raw.split('\n')
  for (const line of lines) {
    if (line === '') continue
    let obj: RgJsonLine
    try {
      obj = JSON.parse(line) as RgJsonLine
    } catch {
      // rg may emit a non-JSON line on some platforms; skip defensively.
      continue
    }
    if (obj.type !== 'match' && obj.type !== 'context') continue
    const data = obj.data
    if (!data) continue
    const path = data.path?.text
    if (path === undefined) continue
    const lineNumber = data.line_number
    if (lineNumber === undefined) continue
    // rg includes the trailing newline in `lines.text`; strip it.
    const content = (data.lines?.text ?? '').replace(/\r?\n$/, '')
    out.push({
      path,
      lineNumber,
      content,
      isContext: obj.type === 'context',
    })
  }
  return out
}

export type RgRunnerOptions = {
  rgPath: string
}

export class RgRunner {
  private readonly rgPath: string

  constructor(rgPath: string) {
    this.rgPath = rgPath
  }

  /**
   * Run ripgrep with the given args and return parsed matches.
   *
   * The caller is responsible for building the arg list (including --json).
   * This keeps the runner a thin, composable execution + parsing layer.
   *
   * @throws Error on rg exit code 2, timeout, abort, spawn failure, or
   *         output cap exceeded.
   */
  async run(args: string[], options: RgRunOptions): Promise<RgMatch[]> {
    const cwd = options.cwd
    const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS
    const signal = options.signal

    return new Promise<RgMatch[]>((resolve, reject) => {
      const child: ChildProcess = spawn(this.rgPath, args, {
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
      let onAbort: (() => void) | undefined

      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (timeoutTimer) clearTimeout(timeoutTimer)
        if (graceTimer) clearTimeout(graceTimer)
        fn()
      }

      // ---- stdout drain with cap ----
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk)
        stdoutLen += chunk.length
        if (stdoutLen > OUTPUT_CAP_BYTES) {
          // Output too large — kill and reject. The search was too broad.
          tryKill(child, 'SIGKILL')
          finish(() => reject(new Error(
            `ripgrep output exceeded ${OUTPUT_CAP_BYTES} bytes (10 MB). ` +
            `Narrow your search (use a more specific pattern, a glob filter, ` +
            `or --max-count).`,
          )))
        }
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString('utf8')
      })

      // ---- timeout: SIGTERM → 5s grace → SIGKILL ----
      timeoutTimer = setTimeout(() => {
        tryKill(child, 'SIGTERM')
        graceTimer = setTimeout(() => {
          tryKill(child, 'SIGKILL')
        }, GRACE_PERIOD_MS)
      }, timeoutMs)

      // ---- abort signal ----
      onAbort = (): void => {
        tryKill(child, 'SIGKILL')
        finish(() => reject(new Error('ripgrep was aborted by the caller.')))
      }
      if (signal) {
        if (signal.aborted) {
          tryKill(child, 'SIGKILL')
          finish(() => reject(new Error('ripgrep was aborted by the caller.')))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      // ---- spawn error ----
      child.on('error', (err) => {
        finish(() => reject(new Error(
          `Failed to spawn ripgrep at "${this.rgPath}": ${err.message}`,
        )))
      })

      // ---- exit ----
      child.on('exit', (code, sig) => {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort)
        const raw = Buffer.concat(stdoutChunks).toString('utf8')

        if (code === 0 || code === 1) {
          // 0 = matches found; 1 = no matches. Both are "success" for our
          // purposes. Parse and return.
          const matches = parseRgJsonOutput(raw)
          finish(() => resolve(matches))
          return
        }

        if (code === 2) {
          // rg error (bad regex, permission denied on a dir, etc.)
          const msg = stderrText.trim() || raw.trim() || 'unknown ripgrep error'
          finish(() => reject(new Error(`ripgrep error: ${msg}`)))
          return
        }

        // null exit code = killed by signal
        if (sig) {
          finish(() => reject(new Error(
            `ripgrep was killed by signal ${sig}` +
            (stderrText ? `: ${stderrText.trim()}` : ''),
          )))
          return
        }

        finish(() => reject(new Error(
          `ripgrep exited with unexpected code ${code}` +
          (stderrText ? `: ${stderrText.trim()}` : ''),
        )))
      })
    })
  }
}

/**
 * Send a signal to a child process, ignoring errors if it already exited.
 */
const tryKill = (child: ChildProcess, sig: NodeJS.Signals): void => {
  try {
    child.kill(sig)
  } catch {
    // Already dead — nothing to do.
  }
}
