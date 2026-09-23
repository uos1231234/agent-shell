// Tests for ProcessRegistry + list_processes / kill_process — v0.29.
//
// Invariants:
//   - track/untrack/list lifecycle: exit removes, list sorted by start time.
//   - kill only accepts session-tracked pids; untracked → { ok:false }.
//   - kill actually terminates a spawned process (real node child).
//   - list_processes/kill_process tools surface the registry with clean text.

import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { ProcessRegistry } from '../../../src/im/tools/process-registry.js'
import { createListProcessesTool, createKillProcessTool } from '../../../src/im/tools/process-tools.js'
import { createBuiltinTools } from '../../../src/im/tools/index.js'

describe('ProcessRegistry', () => {
  it('tracks and lists in start order', async () => {
    const reg = new ProcessRegistry()
    reg.track(101, 'first')
    reg.track(102, 'second')
    const list = reg.list()
    expect(list.map((p) => p.pid)).toEqual([101, 102])
    expect(list[0]!.command).toBe('first')
  })

  it('untrack removes a process', async () => {
    const reg = new ProcessRegistry()
    reg.track(101, 'first')
    reg.untrack(101)
    expect(reg.list()).toEqual([])
  })

  it('startsAt is set at track time (uptime non-negative)', async () => {
    const reg = new ProcessRegistry()
    reg.track(101, 'cmd')
    const now = Date.now()
    expect(reg.list()[0]!.startedAt).toBeLessThanOrEqual(now)
    expect(reg.list()[0]!.startedAt).toBeGreaterThan(now - 5000)
  })

  it('records a deadline when a finite timeout is supplied', () => {
    const reg = new ProcessRegistry()
    const entry = reg.track(101, 'cmd', 240)
    expect(entry.deadlineAt).toBeDefined()
    expect(entry.deadlineAt! - entry.startedAt).toBe(240_000)
  })

  it('truncates long command display', async () => {
    const reg = new ProcessRegistry()
    reg.track(101, 'x'.repeat(300))
    expect(reg.list()[0]!.command.length).toBeLessThanOrEqual(121) // 120 + '…'
  })

  it('kill rejects non-tracked pid', async () => {
    const reg = new ProcessRegistry()
    const result = await reg.kill(99999)
    expect(result).toEqual({ ok: false, reason: 'not-tracked' })
  })

  it('kill terminates a real spawned process', async () => {
    const reg = new ProcessRegistry()
    // 真实长驻进程：sleep 30s（POSIX）；Windows 无 sleep 命令，用 node 兜底。
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
    const pid = child.pid!
    reg.track(pid, 'node-sleeper')
    const result = await reg.kill(pid)
    expect(result).toEqual({ ok: true, pid })
    // 进程确实死了：探活失败（ESRCH）
    await new Promise((r) => setTimeout(r, 300))
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
    expect(reg.list()).toEqual([]) // kill 后 untrack
  }, 10_000)

  // POSIX 才有真实信号：Windows 上 SIGTERM 由 Node 模拟（实际 TerminateProcess
  // 强杀），handler 不执行——宽限窗口是 POSIX 特性，Windows 由 SIGKILL 兜底
  // （设计注释已声明）。此用例在 Windows 上跳过。
  const gracefulWindowTest = process.platform === 'win32' ? it.skip : it
  gracefulWindowTest('kill honors the graceful-window: SIGTERM handler gets time to clean up', async () => {
    const reg = new ProcessRegistry()
    // 子进程注册 SIGTERM 处理器：延迟 1s 后退出（模拟优雅清理）。若 kill
    // 立即 SIGKILL（窗口失效的回归），进程会在文件写入前被杀 → 文件缺失。
    const child = spawn(process.execPath, ['-e', `
      process.on('SIGTERM', () => {
        setTimeout(() => process.exit(0), 1000);
      });
      setInterval(()=>{},1000);
    `])
    const pid = child.pid!
    reg.track(pid, 'graceful-handler')
    const started = Date.now()
    const result = await reg.kill(pid)
    const elapsed = Date.now() - started
    expect(result).toEqual({ ok: true, pid })
    // 窗口生效：kill 至少等了 ~1s（进程的 SIGTERM handler 完成清理），
    // 而不是 0ms 直接 SIGKILL。留 300ms 抖动。
    expect(elapsed).toBeGreaterThanOrEqual(700)
    expect(reg.list()).toEqual([])
  }, 10_000)
})

describe('process tools', () => {
  it('list_processes reports empty cleanly', async () => {
    const reg = new ProcessRegistry()
    const tool = createListProcessesTool(reg)
    const result = await tool.execute({ reason: 'check' }, {})
    expect(result).toContain('No processes')
  })

  it('list_processes surfaces tracked process with uptime', async () => {
    const reg = new ProcessRegistry()
    reg.track(123, 'npm run dev')
    const tool = createListProcessesTool(reg)
    const result = await tool.execute({ reason: 'check' }, {})
    expect(result).toContain('pid 123')
    expect(result).toContain('npm run dev')
    expect(result).toContain('running')
    expect(result).toContain('no harness deadline')
  })

  it('kill_process rejects non-integer pid', async () => {
    const reg = new ProcessRegistry()
    const tool = createKillProcessTool(reg)
    await expect(tool.execute({ pid: 1.5, reason: 'x' }, {})).rejects.toThrow(/"pid" must be an integer/)
  })

  it('kill_process rejects untracked pid with guidance', async () => {
    const reg = new ProcessRegistry()
    const tool = createKillProcessTool(reg)
    await expect(tool.execute({ pid: 12345, reason: 'x' }, {})).rejects.toThrow(/not tracked by this session/)
  })

  it('kill_process terminates a tracked real process', async () => {
    const reg = new ProcessRegistry()
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
    reg.track(child.pid!, 'node-sleeper')
    const tool = createKillProcessTool(reg)
    const result = await tool.execute({ pid: child.pid, reason: 'stop it' }, {})
    expect(result).toContain('Sent termination signal to pid')
    expect(reg.list()).toEqual([])
  }, 10_000)
})

describe('createBuiltinTools wires the process registry', () => {
  it('registers list_processes and kill_process system tools', () => {
    const registry = createBuiltinTools({ cwd: process.cwd() })
    const names = registry.listSystemTools()
    expect(names).toContain('list_processes')
    expect(names).toContain('kill_process')
  })

  it('bash tool tracks into the session registry surface', async () => {
    const registry = createBuiltinTools({ cwd: process.cwd() })
    // 先确认无进程，再跑一个快速命令，命令结束后跟踪即清空（同步生命周期）
    const listTool = registry.getSystemTool('list_processes')!
    const empty = await listTool.execute({ reason: 'pre-check' }, {})
    expect(String(empty)).toContain('No processes')

    const bashTool = registry.getSystemTool('bash')!
    const out = await bashTool.execute({ command: 'echo hi', reason: 'test' }, {})
    expect(String(out)).toContain('hi')

    // 命令同步结束 → 跟踪窗口已关，回到空态
    const after = await listTool.execute({ reason: 'post-check' }, {})
    expect(String(after)).toContain('No processes')
  }, 15_000)
})
