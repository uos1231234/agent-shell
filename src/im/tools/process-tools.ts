// process-tools.ts — list_processes / kill_process（v0.29 进程监督工具）。
//
// 能力面：LLM 自查本会话正在运行的进程（bash/powershell spawn 的同步
// 进程，tracked by ProcessRegistry）+ 终止跟踪中的进程。
// 边界：只对本会话跟踪的 pid 生效——不扫描系统进程、不允许杀未跟踪的
// pid（会话边界即权限边界，防止误杀用户机器上的无关进程）。

import type { SystemTool } from '../../shell/registry.js'
import { wrapTool, toSchema, reasonField } from './helpers.js'
import type { ProcessRegistry } from './process-registry.js'

export const createListProcessesTool = (processRegistry: ProcessRegistry): SystemTool => ({
  name: 'list_processes',
  description:
    'List processes started by this session that are still running (pid, command, uptime, deadline). '
    + 'Use to supervise long-running commands or check whether a background task has finished. '
    + 'Empty result means nothing from this session is currently running.',
  parameters: toSchema({ reason: reasonField }, ['reason']),
  category: 'read',
  execute: wrapTool('list_processes', async () => {
    const procs = processRegistry.list()
    if (procs.length === 0) {
      return 'No processes from this session are currently running.'
    }
    const now = Date.now()
    const lines = procs.map((p) => {
      const ageSec = Math.max(0, Math.round((now - p.startedAt) / 1000))
      const deadline = p.deadlineAt === undefined
        ? 'no harness deadline'
        : `${Math.max(0, Math.ceil((p.deadlineAt - now) / 1000))}s remaining`
      return `pid ${p.pid} | running ${ageSec}s | ${deadline} | ${p.command}`
    })
    return `Running processes from this session (${procs.length}):\n${lines.join('\n')}`
  }),
})

export const createKillProcessTool = (processRegistry: ProcessRegistry): SystemTool => ({
  name: 'kill_process',
  description:
    'Terminate a process started by this session (SIGTERM first, SIGKILL after 10s). '
    + 'Only pids returned by list_processes are accepted — untracked pids are rejected '
    + 'so you cannot kill processes you did not start. Use when a long-running command '
    + 'must be stopped early or a process is stuck.',
  parameters: toSchema({
    pid: { type: 'number', description: 'Process id as shown by list_processes' },
    reason: reasonField,
  }, ['pid', 'reason']),
  category: 'command',
  execute: wrapTool('kill_process', async (raw) => {
    const a = raw as { pid: unknown; reason: string }
    const pid = typeof a.pid === 'number' && Number.isInteger(a.pid) ? a.pid : NaN
    if (!Number.isFinite(pid)) {
      throw new Error('kill_process: "pid" must be an integer')
    }
    const result = await processRegistry.kill(pid)
    if (!result.ok) {
      throw new Error(
        `kill_process: pid ${pid} is not tracked by this session. `
        + 'List tracked pids with list_processes before killing.',
      )
    }
    return `Sent termination signal to pid ${pid} (session-tracked process).`
  }),
})
