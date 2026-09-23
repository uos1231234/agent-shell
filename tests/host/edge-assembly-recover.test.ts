// 装配级 E2E：压缩 rewrite 后关闭再 open，信封是否还在、磁盘是否 ≡ 内存。
// 不走 mock 单元缝，走 createHostAssembly 真实接线。

import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createHostAssembly } from '../../src/host/assembly.js'
import type { SystemAgent } from '../../src/im/system-agent.js'
import { createMetrics } from '../../src/shell/metrics.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'edge-assembly-recover-'))
let assembly: Awaited<ReturnType<typeof createHostAssembly>> | undefined

afterAll(async () => {
  await assembly?.shutdown()
  rmSync(tmpRoot, { recursive: true, force: true })
})

const fakeCompressor: SystemAgent = {
  run: async () => ({
    output: '',
    // v0.42: 提交协议——生产结果是 submit_curated_memory 的 memory 参数。
    submitted: {
      task_goal: 'create hello.txt',
      causal_steps: [{ intent: 'create file', tool_action: 'write hello.txt', result: 'written' }],
      evidence_fragments: [{ source: 'tool', fragment: 'hello from web-host (mock)', relevance: 'artifact' }],
      conclusion: 'file created',
      next_action: 'none',
      working_state: {
        current_goal: 'done',
        effective_decisions: [],
        rejected_decisions: [],
        architecture_boundaries: [],
        remaining_work: [],
      },
    },
    metrics: createMetrics(),
    finalState: 'Running',
    reason: 'completed',
    hits: [],
  }),
  stop() {},
  send() {},
}

describe('assembly e2e: envelope survives close/reopen', () => {
  it('compress → rewrite → close → open restores envelope from disk', { timeout: 30_000 }, async () => {
    const ws = join(tmpRoot, 'ws')
    assembly = await createHostAssembly({
      dataDir: join(tmpRoot, 'sessions'),
      mock: true,
      compressorOverride: fakeCompressor,
    })

    const approvalIds: string[] = []
    assembly.gate.on('approval', (req) => {
      if (req.kind === 'approval') approvalIds.push(req.requestId)
    })

    const handle = await assembly.handlers.session.create({ workDir: ws })
    const sessionId = handle.info.id

    const p1 = assembly.handlers.runPrompt(sessionId, 'hi')
    await vi.waitFor(() => expect(approvalIds.length).toBeGreaterThan(0), { timeout: 5000 })
    assembly.gate.resolve(approvalIds[0]!, 'approved')
    await p1

    await assembly.handlers.runPrompt(sessionId, 'again')

    // 手动 M1 跨越触发压缩
    await handle.runtime.driveCoordinator.tick({
      contextTokens: 1,
      conversation: handle.runtime.conversationMemory,
      databus: handle.runtime.databus,
      memoryConfig: { m1MinTokens: 1, m2MinTokens: 500_000, m3MinTokens: 900_000 },
    })
    await handle.runtime.driveCoordinator.drain()

    const memBefore = handle.runtime.conversationMemory.turns()
    expect(memBefore[0]!.id.startsWith('mem-')).toBe(true)
    const envelopeContent = String((memBefore[0] as { content: string }).content)
    expect(envelopeContent).toMatch(/^#STAMP S-/)

    // 磁盘应已 rewrite
    await vi.waitFor(() => {
      const disk = readFileSync(join(tmpRoot, 'sessions', sessionId, 'conversation.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string })
      expect(disk.map((r) => r.id)).toEqual(memBefore.map((t) => t.id))
    }, { timeout: 5000 })

    // 关闭再打开
    await assembly.handlers.session.close(sessionId)
    const reopened = await assembly.handlers.session.open(sessionId)
    const turnsAfter = reopened.runtime.conversationMemory.turns()
    expect(turnsAfter[0]!.id.startsWith('mem-')).toBe(true)
    expect(String((turnsAfter[0] as { content: string }).content)).toContain('#END_BLOCK')
    // 信封 stamp 与关闭前一致（同一行从盘恢复）
    expect(String((turnsAfter[0] as { content: string }).content)).toBe(envelopeContent)
    // 原块不应复活
    expect(turnsAfter.some((t) => t.role === 'tool' && String(t.content).includes('hello'))).toBe(false)
  })
})
