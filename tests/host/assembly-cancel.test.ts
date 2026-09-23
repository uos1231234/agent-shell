// turn.cancel 真取消验证（回归测试）：此前 runPromptOnce 创建的
// AbortController 从未把 signal 传入 loop，cancel 是 no-op——审批挂起时
// 取消，回合会一直挂着。修复后 abort 应把 runIMLoop 收敛为
// 'shell-terminated'。

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { createHostAssembly } from '../../src/host/assembly.js'
import type { HostAssembly } from '../../src/host/assembly.js'
import { USER_INTERRUPTED_MARKER } from '../../src/im/turn.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'host-cancel-test-'))

let assembly: HostAssembly

afterAll(async () => {
  await assembly?.shutdown()
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('turn.cancel actually cancels the in-flight round', () => {
  it('cancel while a round is blocked on approval resolves the runPrompt promise with shell-terminated', async () => {
    const ws = join(tmpRoot, 'ws')
    mkdirSync(ws, { recursive: true })

    assembly = await createHostAssembly({ dataDir: join(tmpRoot, 'sessions'), mock: true })
    const handle = await assembly.handlers.session.create({ workDir: ws })

    const approvalIds: string[] = []
    assembly.gate.on('approval', (req) => {
      if (req.kind === 'approval') approvalIds.push(req.requestId)
    })

    // mock 首轮回放 write 工具 → 审批门挂起 → 回合在途。
    const pending = assembly.handlers.runPrompt(handle.info.id, 'hi')
    await vi.waitFor(() => expect(approvalIds.length).toBeGreaterThan(0), { timeout: 5000 })

    // 取消在途回合：pending 必须 resolve（而非永远挂起），reason = shell-terminated。
    assembly.handlers.cancel(handle.info.id)
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('cancel did not settle runPrompt within 5s')), 5000)),
    ])

    expect(result.terminated).toBe(true)
    expect(result.reason).toBe('shell-terminated')

    // 取消后 approval 句柄应已被 assembly 的 shutdown 清理（gate 无悬挂请求）
    // ——这里由 shutdown 的 afterAll 断言兜底；本测试只验证回合收敛。
  })

  it('cancel appends a stop marker turn after unwind — in canonical and on disk (2026-09-17)', async () => {
    const ws = join(tmpRoot, 'ws-marker')
    mkdirSync(ws, { recursive: true })

    const a = await createHostAssembly({ dataDir: join(tmpRoot, 'sessions-marker'), mock: true })
    try {
      const handle = await a.handlers.session.create({ workDir: ws })
      const approvalIds: string[] = []
      a.gate.on('approval', (req) => {
        if (req.kind === 'approval') approvalIds.push(req.requestId)
      })

      // mock 首轮回放 write 工具 → 审批门挂起 → 回合在途。
      const pending = a.handlers.runPrompt(handle.info.id, 'hi')
      await vi.waitFor(() => expect(approvalIds.length).toBeGreaterThan(0), { timeout: 5000 })

      a.handlers.cancel(handle.info.id)
      const result = await pending
      expect(result.reason).toBe('shell-terminated')

      // canonical 最后一条 = 停止标记回合（入站登记 + 回合收尾落插）。
      const history = await a.handlers.session.history(handle.info.id)
      const last = history[history.length - 1]!
      expect(last.role).toBe('user')
      expect(last.id.startsWith('stop-')).toBe(true)
      expect(last.content).toBe(USER_INTERRUPTED_MARKER)

      // wire 序列合法性：标记之前不能有"未闭合的 tool 结果"——tool 结果
      // （取消产生的 error turn）必须先于标记落盘，否则服务商 400。
      const tail = history.slice(-3).map((t) => t.role)
      expect(tail[tail.length - 1]).toBe('user') // marker
      expect(tail.includes('tool')).toBe(true) // error result before marker

      // 落盘验证：conversation.jsonl 最后一行 = 标记回合（persistTurn 同路径）。
      const convFile = join(tmpRoot, 'sessions-marker', handle.info.id, 'conversation.jsonl')
      const lines = readFileSync(convFile, 'utf8').trim().split('\n')
      const lastLine = JSON.parse(lines[lines.length - 1]!) as { id: string; role: string; content: string }
      expect(lastLine.role).toBe('user')
      expect(lastLine.id.startsWith('stop-')).toBe(true)
      expect(lastLine.content).toBe(USER_INTERRUPTED_MARKER)
    } finally {
      await a.shutdown()
    }
  })

  it('cancel with no turn in flight does not append a marker', async () => {
    const ws = join(tmpRoot, 'ws-idle')
    mkdirSync(ws, { recursive: true })

    const a = await createHostAssembly({ dataDir: join(tmpRoot, 'sessions-idle'), mock: true })
    try {
      const handle = await a.handlers.session.create({ workDir: ws })
      // 空闲时 cancel：无登记、无标记、无异常。
      a.handlers.cancel(handle.info.id)
      const history = await a.handlers.session.history(handle.info.id)
      expect(history.every((t) => !t.id.startsWith('stop-'))).toBe(true)
    } finally {
      await a.shutdown()
    }
  })
})
