// powershell.ts
//
// Registers the `powershell` tool. Mirrors `bash.ts` but uses the Windows
// PowerShell binary. The tool's description tells the LLM when to prefer
// PowerShell over bash (Windows-native commands, registry access, etc.).
//
// On Windows the tool is registered unconditionally. On non-Windows hosts
// the tool still gets registered (the LLM is unlikely to call it), and the
// `powershell` binary is expected to be on PATH.
//
// ADR-013: the `reason` runtime contract is enforced by `wrapTool` below.
// Tool-level errors (invalid command, spawn failure) throw from this
// `execute`, are caught by `wrapTool`, and surface to the LLM as a
// plain English sentence on a `role: 'tool'` turn (deepseek-harness
// style: no internal `error: ` prefix, no `isError` field on the wire).

import type { JSONSchema } from '../../shared/json-schema.js'
import type { ToolDefinition } from '../../shell/registry.js'
import { DEFAULT_SHELL_TIMEOUT_SECONDS, resolveShellTimeout, runShellCommand } from './shell.js'
import { wrapTool, reasonField } from './helpers.js'
import { ApprovalStore } from './security/approval-store.js'
import type { ProcessRegistry } from './process-registry.js'
import type { SnapshotContext } from './file-history.js'

/** Default PowerShell timeout cap in seconds. LLM can request more via the timeout parameter,
 *  but exceeding this cap requires approval (or full-permission session).
 *  Aligned with bash.ts BASH_TIMEOUT_CAP for consistent shell-tool safety margins.
 *  v0.29: 600s → 900s → 3600s（1h，2026-09-12 用户拍板）——长命令放宽，时间权交还命令自带 timeout
 *  与用户手动终止（ctx.signal → shell.ts child.kill）。 */
const POWERSHELL_TIMEOUT_CAP = 3600

// Prefix forces the PowerShell host to use UTF-8 for stdout. This matches
// what pi does in its own powershell.ts and is essential for non-ASCII tool
// results to round-trip cleanly through the IM databus.
const UTF8_OUTPUT_PREFIX = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n'

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'PowerShell command to execute' },
    timeout: { type: ['number', 'null'], description: `Timeout in seconds (default ${DEFAULT_SHELL_TIMEOUT_SECONDS}s). Use null only after explicit user approval for a long-running foreground command.` },
    reason: reasonField,
  },
  required: ['command'],
}

export const createPowerShellTool = (opts: {
  cwd: string
  /** 可选：进程监督注册表（createBuiltinTools 每会话一个）。提供时本工具
   *  spawn 的进程进入 list_processes/kill_process 监督面；缺省不跟踪。 */
  processRegistry?: ProcessRegistry
  /** v0.36: 可选快照层——执行期回调（ctx.sessionId 就绪后才调用）。返回
   *  undefined 表示本次执行不可归属（无会话上下文），跳过快照。 */
  snapshotFor?: (sessionId: string | undefined) => SnapshotContext | undefined
}): ToolDefinition => ({
  name: 'powershell',
  description:
    'Execute a PowerShell command. Use for Windows-native operations like registry access, COM, or WMI. '
    + `Commands are synchronous — the default timeout is ${DEFAULT_SHELL_TIMEOUT_SECONDS}s; finite timeouts may be extended up to ${POWERSHELL_TIMEOUT_CAP}s. `
    + 'Use timeout:null only after explicit user approval. Do NOT background commands '
    + '(Start-Process / jobs): keep long-running tasks in the foreground, '
    + 'and monitor/terminate with list_processes / kill_process when needed.',
  parameters,
  execute: wrapTool('powershell', async (raw, ctx) => {
    const args = raw as { command?: unknown; timeout?: unknown }
    if (typeof args.command !== 'string' || args.command.length === 0) {
      throw new Error('powershell: command must be a non-empty string')
    }
    const timeout = await resolveShellTimeout(args.timeout, ctx, 'powershell', args.command)

    // v0.20: Enforce timeout cap, aligned with bash.ts. Full-permission sessions
    // (or sessions with the 'session:full-permission' grant) bypass the cap.
    if (timeout !== undefined && timeout > POWERSHELL_TIMEOUT_CAP) {
      const hasFullPermission = ctx?.approvalStore?.isGranted(ApprovalStore.keyForFullPermission())
      if (!hasFullPermission) {
        throw new Error(
          `powershell: requested timeout ${timeout}s exceeds the ${POWERSHELL_TIMEOUT_CAP}s limit. ` +
          `Use a timeout <= ${POWERSHELL_TIMEOUT_CAP}s, or request an approval grant for extended timeout.`,
        )
      }
    }

    const options: import('./shell.js').ShellRunOptions = timeout !== undefined ? { timeout } : {}
    // v0.36: 执行前留底——同 bash.ts（Remove-Item / Move-Item / 重定向等）。
    const snapshot = opts.snapshotFor?.(ctx?.sessionId)
    if (snapshot !== undefined) {
      await snapshot.history.recordShellCommand(args.command as string, snapshot.sessionId)
    }
    // v0.29: 外部取消信号（turn.cancel / 用户关闭状态机）→ shell.ts abort 时
    // 杀子进程。无限时长只表示没有 harness deadline，仍可被用户取消。
    if (ctx?.signal !== undefined) options.signal = ctx.signal
    // 进程监督：同 bash.ts——spawn 后 track，命令结束（正常/超时/报错）后 untrack。
    let spawnedPid: number | undefined
    if (opts.processRegistry) {
      options.onSpawn = (pid: number): void => {
        spawnedPid = pid
        opts.processRegistry!.track(pid, args.command as string, timeout)
      }
    }
    try {
      const r = await runShellCommand(
        {
          binary: 'powershell',
          args: ['-NoProfile', '-Command', `${UTF8_OUTPUT_PREFIX}${args.command as string}`],
          cwd: opts.cwd,
        },
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
