// bash.ts
//
// Registers the `bash` tool. The tool description tells the LLM to use it
// for shell commands. The actual spawning logic lives in `shell.ts`; this
// file only decides which binary to use and what default timeout to set.
//
// On Windows, `bash` is the Git Bash binary. The PATH `bash.exe` is the
// WSL launcher stub on a stock Windows install, so we prefer the Git Bash
// path if it exists and fall back to a plain "bash" lookup otherwise.
//
// ADR-013: the `reason` runtime contract is enforced by `wrapTool` below.
// Tool-level errors (invalid command, spawn failure) throw from this
// `execute`, are caught by `wrapTool`, and surface to the LLM as a
// plain English sentence on a `role: 'tool'` turn (deepseek-harness
// style: no internal `error: ` prefix, no `isError` field on the wire).

import { existsSync } from 'node:fs'
import type { JSONSchema } from '../../shared/json-schema.js'
import type { ToolDefinition } from '../../shell/registry.js'
import { DEFAULT_SHELL_TIMEOUT_SECONDS, resolveShellTimeout, runShellCommand } from './shell.js'
import { wrapTool, reasonField } from './helpers.js'
import { ApprovalStore } from './security/approval-store.js'
import type { ProcessRegistry } from './process-registry.js'
import type { SnapshotContext } from './file-history.js'

/** Default bash timeout cap in seconds. LLM can request more via the timeout parameter,
 *  but exceeding this cap requires approval (or full-permission session).
 *  v0.29: 600s → 900s → 3600s（1h，2026-09-12 用户拍板）——长命令放宽，时间权交还命令自带 timeout
 *  与用户手动终止（ctx.signal → shell.ts child.kill）。 */
const BASH_TIMEOUT_CAP = 3600

const GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\msys64\\usr\\bin\\bash.exe',
]

const resolveBash = (): string => {
  for (const candidate of GIT_BASH_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return 'bash'  // fall back to PATH lookup (works on POSIX; on Windows relies on WSL or Git on PATH)
}

const BASH_BINARY = resolveBash()

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'Shell command to execute' },
    timeout: { type: ['number', 'null'], description: `Timeout in seconds (default ${DEFAULT_SHELL_TIMEOUT_SECONDS}s). Use null only after explicit user approval for a long-running foreground command.` },
    reason: reasonField,
  },
  required: ['command'],
}

// v0.20 (ADR-025 T8): conservative read-only detection for parallel dispatch.
// Matches only the leading binary and only the no-side-effect common ones.
// NOT a full safety analysis: pipes/redirects/`&&` chains fall through to the
// category default ('command', cap 3) because any segment after a pipe or
// separator can write. A tree-sitter level analysis (AtomCode-style) is future
// work — this predicate is deliberately cheap and biased toward "not safe".
const READ_ONLY_COMMAND_PATTERNS: readonly RegExp[] = [
  /^grep\s/, /^rg\s/, /^find\s/, /^ls\s/, /^cat\s/, /^head\s/, /^tail\s/,
  /^wc\s/, /^diff\s/, /^pwd$/, /^echo\s/, /^which\s/, /^file\s/, /^stat\s/,
]

const isReadOnlyBashCommand = (args: unknown): boolean => {
  const command = (args as { command?: unknown })?.command
  if (typeof command !== 'string' || command.length === 0) return false
  // Any shell metacharacter means the command is composite — bail to the
  // category default instead of trying to analyze each segment.
  if (/[|;&<>`$]/.test(command)) return false
  return READ_ONLY_COMMAND_PATTERNS.some(p => p.test(command))
}

export const createBashTool = (opts: {
  cwd: string
  /** 可选：进程监督注册表（createBuiltinTools 每会话一个）。提供时本
   *  工具 spawn 的进程进入 list_processes/kill_process 监督面；缺省不跟踪。 */
  processRegistry?: ProcessRegistry
  /** v0.36: 可选快照层——执行期回调（ctx.sessionId 就绪后才调用）。返回
   *  undefined 表示本次执行不可归属（无会话上下文），跳过快照。 */
  snapshotFor?: (sessionId: string | undefined) => SnapshotContext | undefined
}): ToolDefinition => ({
  name: 'bash',
  description:
    'Execute a bash command. Use for shell operations like running scripts, inspecting files, and managing processes. '
    + `Commands are synchronous — the default timeout is ${DEFAULT_SHELL_TIMEOUT_SECONDS}s; finite timeouts may be extended up to ${BASH_TIMEOUT_CAP}s. `
    + 'Use timeout:null only after explicit user approval. Do NOT background commands with "&" or nohup: keep long-running tasks in the foreground, '
    + 'and monitor/terminate with list_processes / kill_process when needed.',
  parameters,
  category: 'command',
  parallelSafe: isReadOnlyBashCommand,
  execute: wrapTool('bash', async (raw, ctx) => {
    const args = raw as { command?: unknown; timeout?: unknown }
    if (typeof args.command !== 'string' || args.command.length === 0) {
      throw new Error('bash: command must be a non-empty string')
    }
    const timeout = await resolveShellTimeout(args.timeout, ctx, 'bash', args.command)

    // Enforce timeout cap. Full-permission sessions (or sessions with the
    // 'session:full-permission' grant) bypass the cap.
    if (timeout !== undefined && timeout > BASH_TIMEOUT_CAP) {
      const hasFullPermission = ctx?.approvalStore?.isGranted(ApprovalStore.keyForFullPermission())
      if (!hasFullPermission) {
        throw new Error(
          `bash: requested timeout ${timeout}s exceeds the ${BASH_TIMEOUT_CAP}s limit. ` +
          `Use a timeout <= ${BASH_TIMEOUT_CAP}s, or request an approval grant for extended timeout.`
        )
      }
    }

    const options: import('./shell.js').ShellRunOptions = timeout !== undefined ? { timeout } : {}
    // v0.36: 执行前留底——命令行里写明的文件目标（rm/mv/重定向等）先进快照。
    // 旁路能力，失败静默（file-history 内部吞错），绝不阻断命令本身。
    const snapshot = opts.snapshotFor?.(ctx?.sessionId)
    if (snapshot !== undefined) {
      await snapshot.history.recordShellCommand(args.command as string, snapshot.sessionId)
    }
    // v0.29: 外部取消信号（turn.cancel / 用户关闭状态机）→ shell.ts abort 时
    // 杀子进程。无限时长只表示没有 harness deadline，仍可被用户取消。
    if (ctx?.signal !== undefined) options.signal = ctx.signal
    // 进程监督：spawn 后 track，命令结束（正常/超时 kill/报错）后 untrack。
    // 一次 bash 调用是同步进程——跟踪窗口=运行期（并发监督场景可见），
    // 超时 kill 由 shell.ts 负责，这里只维护注册表的进出。
    let spawnedPid: number | undefined
    if (opts.processRegistry) {
      options.onSpawn = (pid: number): void => {
        spawnedPid = pid
        opts.processRegistry!.track(pid, args.command as string, timeout)
      }
    }
    try {
      const r = await runShellCommand(
        { binary: BASH_BINARY, args: ['-c', args.command as string], cwd: opts.cwd },
        options,
      )
      if (spawnedPid !== undefined) opts.processRegistry!.untrack(spawnedPid)
      const header = r.exitCode === 0 ? '' : `\n[exit code: ${r.exitCode}]`
      return `${r.stdout}${r.stderr ? '\n[stderr]\n' + r.stderr : ''}${header}`
    } catch (e) {
      if (spawnedPid !== undefined) opts.processRegistry!.untrack(spawnedPid)
      throw e
    }
  }),
})
