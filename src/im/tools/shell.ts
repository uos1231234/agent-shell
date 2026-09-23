// shell.ts
//
// Cross-platform shell execution shared by the `bash` and `powershell` tools.
// This module knows nothing about which shell is "right" for which platform —
// callers pass a `ShellSpec` describing the binary, args, and cwd. The `bash`
// and `powershell` tool files are responsible for picking the right binary
// and (on Windows) wrapping commands in UTF-8 output prefixes.

import { spawn } from 'node:child_process'
import type { ToolContext } from '../../shared/tool-context.js'
import { ApprovalStore } from './security/approval-store.js'

/** Normal shell-tool deadline when the caller does not choose one. */
export const DEFAULT_SHELL_TIMEOUT_SECONDS = 240

/** Resolve the tool-level deadline after the security door handles approval. */
export const resolveShellTimeout = async (
  requested: unknown,
  ctx: ToolContext | undefined,
  toolName: string,
  command: string,
): Promise<number | undefined> => {
  if (requested === undefined) return DEFAULT_SHELL_TIMEOUT_SECONDS
  if (requested !== null) {
    if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 0) {
      throw new Error(`${toolName}: timeout must be a non-negative number, null, or omitted`)
    }
    return requested
  }

  if (ctx?.approvalStore?.isGranted(ApprovalStore.keyForUnlimitedTimeout())) return undefined
  throw new Error(
    `${toolName}: timeout:null requires approval from the security door. `
    + 'A sub-agent must ask its parent agent to obtain that approval first.',
  )
}

export type ShellSpec = {
  binary: string
  args: string[]
  cwd: string
}

export type ShellRunOptions = {
  timeout?: number  // seconds
  /** spawn 成功后回调 pid——bash/powershell 工具借此把进程记入
   *  ProcessRegistry（list_processes/kill_process 监督用）。可不传
   *  （旧调用方/测试不跟踪，行为不变）。 */
  onSpawn?: (pid: number) => void
  /**
   * v0.29: 外部取消信号（来自 ctx.signal —— turn.cancel / 用户关闭状态机）。
   * abort 时对子进程发 SIGTERM。这是"用户结束状态机 = 真正终止正在运行的
   * 工具进程"的机制——没有它，loop 退出但子进程仍在后台跑。
   */
  signal?: AbortSignal
}

export type ShellRunResult = {
  exitCode: number | null
  stdout: string
  stderr: string
}

// spawn + collect stdout/stderr with optional timeout. 输出不设字节帽
// （2026-09-12 用户拍板：未经同意不允许任何信息截断机制）；超大输出由
// fold hook（history-tool-table，保头保尾）在 canonical 层收敛。
// We deliberately keep this single-purpose: no retries, no signal plumbing
// for now (tools can add their own AbortSignal later if needed).
export const runShellCommand = (
  spec: ShellSpec,
  options: ShellRunOptions = {},
): Promise<ShellRunResult> => {
  return new Promise<ShellRunResult>((resolve) => {
    const child = spawn(spec.binary, spec.args, {
      cwd: spec.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    // 进程监督：spawn 成功即上报 pid（工具的 execute 负责在命令结束后 untrack）
    options.onSpawn?.(child.pid ?? -1)

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let killed = false

    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      chunks.push(chunk)
    }

    child.stdout.on('data', (c: Buffer) => collect(stdoutChunks, c))
    child.stderr.on('data', (c: Buffer) => collect(stderrChunks, c))

    if (options.timeout !== undefined) {
      const timer = setTimeout(() => {
        killed = true
        child.kill('SIGTERM')
      }, options.timeout * 1000)
      child.on('exit', () => clearTimeout(timer))
    }

    // v0.29: 外部取消（turn.cancel / 用户关闭）——abort 即杀子进程。
    // 与 options.timeout 共存：先到者先 kill（killed 标记防止双杀误报）。
    if (options.signal !== undefined) {
      const onAbort = (): void => {
        if (!killed) {
          killed = true
          child.kill('SIGTERM')
        }
      }
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
      child.on('exit', () => options.signal?.removeEventListener('abort', onAbort))
    }

    child.on('error', (err) => {
      resolve({ exitCode: null, stdout: '', stderr: `spawn ${spec.binary} failed: ${err.message}` })
    })

    child.on('exit', (code) => {
      const normalize = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '')
      resolve({
        exitCode: killed ? null : code,
        stdout: normalize(Buffer.concat(stdoutChunks).toString('utf8')),
        stderr: normalize(Buffer.concat(stderrChunks).toString('utf8')),
      })
    })
  })
}
