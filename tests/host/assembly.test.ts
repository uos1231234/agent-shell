// v0.26 — createHostAssembly 装配冒烟：全进程内经 Signal Gate 走通
// session.create → runPrompt → 审批闭环（write door 经 gate 请求-应答）→
// 第二轮无审批 → shutdown。这同时证明 gate 是唯一中转（审批请求经
// gate.request 广播到达，测试只通过 gate.on/gate.resolve 交互）。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { createHostAssembly, defaultRepoSkillsDir } from '../../src/host/assembly.js'
import type { HostAssembly } from '../../src/host/assembly.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'host-assembly-test-'))

let assembly: HostAssembly

afterAll(async () => {
  await assembly?.shutdown()
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('createHostAssembly (mock, in-process through the gate)', () => {
  it('session.create attaches a session; runPrompt round-trips an approval through the gate and writes hello.txt', async () => {
    const ws = join(tmpRoot, 'ws-1')
    mkdirSync(ws, { recursive: true })

    assembly = await createHostAssembly({ dataDir: join(tmpRoot, 'sessions'), mock: true })

    const handle = await assembly.handlers.session.create({ workDir: ws })
    expect(handle.info.workDir).toBe(ws)

    // 审批请求必须经 gate 广播到达（gate 是唯一中转，不是旁路）。
    const approvalIds: string[] = []
    assembly.gate.on('approval', (req) => {
      if (req.kind === 'approval') approvalIds.push(req.requestId)
    })

    const pending = assembly.handlers.runPrompt(handle.info.id, 'hi')
    // write door → wiring.approvalHandler → gate.request → 'approval' 广播。
    await vi.waitFor(() => expect(approvalIds.length).toBeGreaterThan(0), { timeout: 5000 })
    assembly.gate.resolve(approvalIds[0]!, 'approved')

    const result = await pending
    expect(result.reason).toBe('completed')
    expect(result.finalState).toBe('Running')

    // mock 首轮回放 write hello.txt（工具真正落到 workDir）。
    expect(existsSync(join(ws, 'hello.txt'))).toBe(true)
    expect(readFileSync(join(ws, 'hello.txt'), 'utf8')).toBe('hello from web-host (mock)\n')
  })

  it('second prompt completes without a new approval request', async () => {
    const approvalIds: string[] = []
    assembly.gate.on('approval', (req) => {
      if (req.kind === 'approval') approvalIds.push(req.requestId)
    })

    const sessionId = assembly.gate.snapshot().sessions[0]!
    const result = await assembly.handlers.runPrompt(sessionId, 'again')

    expect(result.reason).toBe('completed')
    expect(approvalIds.length).toBe(0)
  })

  it('runPrompt on an unknown session throws a clean error; shutdown closes cleanly', async () => {
    await expect(assembly.handlers.runPrompt('no-such-session', 'x')).rejects.toThrow(
      /session "no-such-session" is not open/,
    )

    await expect(assembly.shutdown()).resolves.toBeUndefined()
    // shutdown 后 pendingRequests 清零（无悬挂的 gate 请求句柄）。
    expect(assembly.gate.snapshot().pendingRequests).toBe(0)
  })
})

describe('per-session permission (user decision 2026-09-07: global broadcast removed)', () => {
  it('permission.full affects only the target session; permission.changed is emitted', async () => {
    const local = await createHostAssembly({ dataDir: join(tmpRoot, 'sessions-perm'), mock: true })
    try {
      const changed: Array<{ sessionId: string; full: boolean }> = []
      local.gate.on('permission.changed', (sig) => {
        if (sig.kind === 'permission.changed') changed.push({ sessionId: sig.sessionId, full: sig.full })
      })

      const wsA = join(tmpRoot, 'ws-perm-a')
      const wsB = join(tmpRoot, 'ws-perm-b')
      mkdirSync(wsA, { recursive: true })
      mkdirSync(wsB, { recursive: true })
      const a = await local.handlers.session.create({ workDir: wsA })
      const b = await local.handlers.session.create({ workDir: wsB })

      // open/create 完成后各推送一次初始状态（false）。
      expect(changed).toContainEqual({ sessionId: a.info.id, full: false })
      expect(changed).toContainEqual({ sessionId: b.info.id, full: false })

      // 只切 A：B 的安全状态不受影响（全局广播已删除）。
      await local.gate.command({ kind: 'permission.full', sessionId: a.info.id, enabled: true })
      expect(changed).toContainEqual({ sessionId: a.info.id, full: true })
      expect(changed.filter((c) => c.sessionId === b.info.id).every((c) => c.full === false)).toBe(true)

      // 重复 open 已打开会话：幂等推送当前状态（A=true，B=false）。
      const after: Array<{ sessionId: string; full: boolean }> = []
      local.gate.on('permission.changed', (sig) => {
        if (sig.kind === 'permission.changed') after.push({ sessionId: sig.sessionId, full: sig.full })
      })
      await local.handlers.session.open(a.info.id)
      await local.handlers.session.open(b.info.id)
      expect(after).toContainEqual({ sessionId: a.info.id, full: true })
      expect(after).toContainEqual({ sessionId: b.info.id, full: false })

      // 未打开的会话：干净错误。
      await expect(
        local.gate.command({ kind: 'permission.full', sessionId: 'never-opened', enabled: true }),
      ).rejects.toThrow(/session "never-opened" is not open/)
    } finally {
      await local.shutdown()
    }
  })
})

// ---------------------------------------------------------------------------
// v0.26 Wave A — session.rename（/title 的宿主落点）
// ---------------------------------------------------------------------------

describe('session.rename (v0.26 Wave A)', () => {
  it('persists the title to session.json; list reflects it; input validation errors are clean', async () => {
    const root = join(tmpRoot, 'rename')
    const ws = join(root, 'ws')
    mkdirSync(ws, { recursive: true })
    const local = await createHostAssembly({ dataDir: join(root, 'sessions'), mock: true })
    try {
      const handle = await local.handlers.session.create({ workDir: ws })
      await local.handlers.session.rename!(handle.info.id, '新标题')

      // session.json 是事实源：直接读盘验证。
      const raw = JSON.parse(
        readFileSync(join(root, 'sessions', handle.info.id, 'session.json'), 'utf8'),
      ) as { title: string }
      expect(raw.title).toBe('新标题')

      // 打开中的句柄内存投影同步；清单反映新标题。
      expect(handle.info.title).toBe('新标题')
      const list = await local.handlers.session.list()
      expect(list.find((s) => s.id === handle.info.id)?.title).toBe('新标题')

      // 校验：空 title / 超过 200 字符 / 未知会话 → 干净错误。
      await expect(local.handlers.session.rename!(handle.info.id, '   ')).rejects.toThrow(
        /non-empty/,
      )
      await expect(local.handlers.session.rename!(handle.info.id, 'x'.repeat(201))).rejects.toThrow(
        /at most 200/,
      )
      await expect(local.handlers.session.rename!('no-such-id', 'x')).rejects.toThrow(/not found/)
    } finally {
      await local.shutdown()
    }
  })
})

describe('skillsDir 默认回落仓库内 skills/ (v0.26+ web_search skill)', () => {
  it('defaultRepoSkillsDir 返回仓库 skills 目录（存在）', () => {
    const dir = defaultRepoSkillsDir()
    expect(dir).toBeTruthy()
    expect(existsSync(dir!)).toBe(true)
    expect(dir!.endsWith('skills')).toBe(true)
  })
})
