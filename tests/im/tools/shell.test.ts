// shell.test.ts
//
// The shell module is the cross-platform shell abstraction shared by
// `bash` and `powershell` tools. It exposes a single `runShellCommand`
// function that takes a `ShellSpec` (which shell binary, which args).
//
// The actual spawning logic is intentionally trivial: we wrap the command
// in a `child_process.spawn` call and capture stdout, stderr, exit code,
// and a truncation flag if the output exceeded the byte limit.

import { describe, it, expect } from 'vitest'
import { ApprovalStore } from '../../../src/im/tools/security/approval-store.js'
import { DEFAULT_SHELL_TIMEOUT_SECONDS, resolveShellTimeout, runShellCommand, type ShellSpec } from '../../../src/im/tools/shell.js'

describe('runShellCommand', () => {
  it('captures stdout', async () => {
    const r = await runShellCommand(echoSpec('hello world'))
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('hello world')
  }, 20_000)

  it('captures non-zero exit codes', async () => {
    const r = await runShellCommand(failingSpec())
    expect(r.exitCode).not.toBe(0)
  }, 20_000)

  it('captures stderr separately', async () => {
    const r = await runShellCommand(stderrSpec())
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toContain('warning')
    expect(r.stdout).toBe('')
  }, 20_000)

  it('rejects when the shell binary is missing', async () => {
    const r = await runShellCommand({ binary: '/no/such/binary', args: ['arg'], cwd: '.' })
    expect(r.exitCode).not.toBe(0)
  }, 20_000)

  it('respects timeout (in seconds) — kills long-running processes', async () => {
    const r = await runShellCommand(sleepSpec(10), { timeout: 1 })
    expect(r.exitCode).not.toBe(0)
  }, 20_000)
})

// ---------------------------------------------------------------------------
// Test specs. We pick a shell binary that exists on the host (bash on POSIX,
// powershell on Windows). The tools themselves wrap these into user-facing
// registrations.
// ---------------------------------------------------------------------------

const echoSpec = (text: string): ShellSpec => {
  if (process.platform === 'win32') {
    return { binary: 'powershell', args: ['-NoProfile', '-Command', `Write-Output '${text.replace(/'/g, "''")}'`], cwd: '.' }
  }
  return { binary: 'bash', args: ['-c', `echo '${text.replace(/'/g, "'\\''")}'`], cwd: '.' }
}

const failingSpec = (): ShellSpec => {
  if (process.platform === 'win32') {
    return { binary: 'powershell', args: ['-NoProfile', '-Command', 'exit 7'], cwd: '.' }
  }
  return { binary: 'bash', args: ['-c', 'exit 7'], cwd: '.' }
}

const stderrSpec = (): ShellSpec => {
  if (process.platform === 'win32') {
    return { binary: 'powershell', args: ['-NoProfile', '-Command', '[Console]::Error.WriteLine("warning")'], cwd: '.' }
  }
  return { binary: 'bash', args: ['-c', 'echo warning 1>&2'], cwd: '.' }
}

const sleepSpec = (seconds: number): ShellSpec => {
  if (process.platform === 'win32') {
    return { binary: 'powershell', args: ['-NoProfile', '-Command', `Start-Sleep -Seconds ${seconds}`], cwd: '.' }
  }
  return { binary: 'bash', args: ['-c', `sleep ${seconds}`], cwd: '.' }
}

// v0.29: 外部 AbortSignal → child.kill('SIGTERM')。这是"用户关闭状态机 =
// 真正终止运行中的工具子进程"的机制——loop 退出后子进程不能留在后台跑。
describe('runShellCommand signal abort (v0.29)', () => {
  it('kills a running child when the signal aborts', async () => {
    const ac = new AbortController()
    // 长命令：sleep 30s。signal 在 500ms 后 abort，子进程应被 SIGTERM 终止，
    // runShellCommand 不应等满 30s。
    const start = Date.now()
    const p = runShellCommand(
      { binary: process.platform === 'win32' ? 'powershell' : 'bash',
        args: process.platform === 'win32'
          ? ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30']
          : ['-c', 'sleep 30'],
        cwd: '.' },
      { signal: ac.signal },
    )
    setTimeout(() => ac.abort(), 500)
    const r = await p
    const elapsed = Date.now() - start
    expect(r.exitCode).toBeNull() // killed → null
    expect(elapsed).toBeLessThan(10_000) // 远小于 30s —— abort 真终止了进程
  }, 15_000)

  it('pre-aborted signal kills immediately without spawning long wait', async () => {
    const ac = new AbortController()
    ac.abort() // 先 abort 再调用
    const start = Date.now()
    const r = await runShellCommand(
      { binary: process.platform === 'win32' ? 'powershell' : 'bash',
        args: process.platform === 'win32'
          ? ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30']
          : ['-c', 'sleep 30'],
        cwd: '.' },
      { signal: ac.signal },
    )
    const elapsed = Date.now() - start
    expect(r.exitCode).toBeNull()
    expect(elapsed).toBeLessThan(10_000)
  }, 15_000)
})

describe('shell timeout policy', () => {
  it('uses 240 seconds when timeout is omitted', async () => {
    await expect(resolveShellTimeout(undefined, undefined, 'bash', 'npm test'))
      .resolves.toBe(DEFAULT_SHELL_TIMEOUT_SECONDS)
  })

  it('requires a security-door grant for timeout:null', async () => {
    await expect(resolveShellTimeout(null, undefined, 'bash', 'npm test'))
      .rejects.toThrow(/security door/i)
  })

  it('accepts an unlimited grant recorded by the security door', async () => {
    const approvalStore = new ApprovalStore()
    approvalStore.grant(ApprovalStore.keyForUnlimitedTimeout())
    await expect(resolveShellTimeout(null, { approvalStore }, 'bash', 'long test')).resolves.toBeUndefined()
    await expect(resolveShellTimeout(null, { approvalStore }, 'bash', 'another long test')).resolves.toBeUndefined()
    expect(approvalStore.isGranted(ApprovalStore.keyForUnlimitedTimeout())).toBe(true)
  })

  it('treats full permission as an unlimited-timeout grant', async () => {
    const approvalStore = new ApprovalStore()
    approvalStore.grant(ApprovalStore.keyForFullPermission())
    await expect(resolveShellTimeout(null, { approvalStore }, 'bash', 'long test')).resolves.toBeUndefined()
  })
})
