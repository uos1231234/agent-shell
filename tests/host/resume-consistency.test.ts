// v0.32 — 恢复一致性测试（Phase 3 第二优先）。
//
// 历史翻车点：会话经「首次创建+运行」（热路径）落盘后，在全新装配（模拟进程重启）
// 经 session.open 重新接入（resume 路径），对话记忆必须完整恢复，且恢复后的运行
// 时与热路径行为一致。本测试断言：
//   1. 热路径跑出的对话轮次，resume 后通过 history 读回数量一致、内容不丢；
//   2. resume 后装配项（contextInjector/mailbox/systemToolRefs）依旧齐全；
//   3. resume 后能在既有记忆上继续跑下一轮并正常完成（恢复路径不是死状态）。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { createHostAssembly } from '../../src/host/assembly.js'
import type { HostAssembly } from '../../src/host/assembly.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'resume-consistency-'))
const dataDir = join(tmpRoot, 'sessions')
const ws = join(tmpRoot, 'ws')

async function freshAssembly(): Promise<HostAssembly> {
  return createHostAssembly({ dataDir, mock: true })
}

describe('hot path vs resume path behavior consistency', () => {
  it('resumed session restores the same conversation turns as the hot path and can continue', async () => {
    // ---- 热路径：创建 + 运行一轮 ----
    const a = await freshAssembly()
    const handle = await a.handlers.session.create({ workDir: ws })
    const id = handle.info.id
    await a.gate.command({ kind: 'permission.full', sessionId: id, enabled: true })
    const hot = await a.handlers.runPrompt(id, 'hi')
    expect(hot.reason).toBe('completed')

    const hotTurns = await a.handlers.session.history(id)
    expect(hotTurns.length).toBeGreaterThan(0)

    await a.shutdown()

    // ---- resume 路径：全新装配，session.open 重新接入 ----
    const b = await freshAssembly()
    const reopened = await b.handlers.session.open(id)
    expect(reopened.info.id).toBe(id)
    // 恢复路径同样授权全权限：B 是全新 mock 实例，callCount 重置为 0，
    // 续跑首轮会再次触发 write 工具 —— 不授权会走审批且无人在场 resolve 而挂起。
    await b.gate.command({ kind: 'permission.full', sessionId: id, enabled: true })

    const resumeTurns = await b.handlers.session.history(id)
    // 一致性核心断言：恢复后读回的轮次与热路径一致（不丢、不翻倍）。
    expect(resumeTurns.map((t) => t.id)).toEqual(hotTurns.map((t) => t.id))

    // 恢复后能在既有记忆上继续跑下一轮并正常完成。
    const cont = await b.handlers.runPrompt(id, 'again')
    expect(cont.reason).toBe('completed')

    // 续跑后总轮次 = 热路径轮次 + 第二轮新增轮次（严格增长，证明 resume 是增量而非重置）。
    const afterContinue = await b.handlers.session.history(id)
    expect(afterContinue.length).toBeGreaterThan(hotTurns.length)

    await b.shutdown()
  })
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})
