// Node → Python bridge for chromadb M3 RAG (ADR-016 §4.5).
// Spawns scripts/embed.py, writes JSON request to stdin, reads one JSON response from stdout.
// Errors return { ok: false, error } — never throw.

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StateLineConfig } from './types.js'

// v0.42（2026-09-16 修复）：脚本路径改为**模块相对**解析——旧实现按
// process.cwd() 找 'scripts/embed.py'，而 drive_mrcr 用 cwd=workdir 跑 cli，
// spawn 时 cwd 是会话工作目录，脚本根本解析不到 → RAG 静默全废（ENOENT 被
// {ok:false} 吞掉）。模块相对路径与调用方 cwd 无关，在哪跑都找得到。
const DEFAULT_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'scripts', 'embed.py',
)
// Python 路径：环境变量 CHROMA_PYTHON 可覆盖（默认仍是 Trae 运行时；在别的
// 机器上无此路径时不再只能靠改源码）。
const DEFAULT_PYTHON_PATH = process.env['CHROMA_PYTHON'] ?? 'D:\\trae\\runtime\\python\\python.exe'
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_STORE_PATH = join(homedir(), '.databus', 'state', 'vectors', 'chroma')

type BridgeOptions = {
  storePath?: string
  pythonPath?: string
  timeoutMs?: number
}

const runEmbed = (
  request: Record<string, unknown>,
  opts?: BridgeOptions,
): Promise<{ ok: true; count: number; dim?: number } | { ok: false; error: string }> =>
  runPython(request, opts)

const runQuery = (
  request: Record<string, unknown>,
  opts?: BridgeOptions,
): Promise<
  | { ok: true; results: Array<{ stamp: string; distance: number; document: string }> }
  | { ok: false; error: string }
> => runPython(request, opts)

async function runPython<R>(request: Record<string, unknown>, opts?: BridgeOptions): Promise<R> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve) => {
    const pythonPath = opts?.pythonPath ?? DEFAULT_PYTHON_PATH
    const cwd = process.cwd()
    const child = spawn(pythonPath, [DEFAULT_SCRIPT], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })

    let stdout = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve({ ok: false, error: 'timeout' } as unknown as R)
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        resolve(JSON.parse(stdout) as R)
      } catch {
        resolve({ ok: false, error: `invalid JSON from Python: ${stdout.slice(0, 200)}` } as unknown as R)
      }
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, error: err.message } as unknown as R)
    })

    child.stdin.end(JSON.stringify(request))
  })
}

export const embedM3 = (
  items: Array<{ stamp: string; text: string }>,
  opts?: BridgeOptions,
): Promise<{ ok: true; count: number; dim?: number } | { ok: false; error: string }> => {
  const request: Record<string, unknown> = {
    command: 'embed',
    storePath: opts?.storePath ?? DEFAULT_STORE_PATH,
    collection: 'm3_summaries',
    items: items.map((item) => ({ id: item.stamp, stamp: item.stamp, text: item.text })),
  }
  return runEmbed(request, opts)
}

export const queryM3 = (
  queryText: string,
  limit: number,
  opts?: BridgeOptions,
): Promise<
  | { ok: true; results: Array<{ stamp: string; distance: number; document: string }> }
  | { ok: false; error: string }
> => {
  const request: Record<string, unknown> = {
    command: 'query',
    storePath: opts?.storePath ?? DEFAULT_STORE_PATH,
    collection: 'm3_summaries',
    queryText,
    limit,
  }
  return runQuery(request, opts)
}

// Re-export for index.ts to pass config through.
export type { StateLineConfig }
export { DEFAULT_STORE_PATH, DEFAULT_TIMEOUT_MS, DEFAULT_PYTHON_PATH }
