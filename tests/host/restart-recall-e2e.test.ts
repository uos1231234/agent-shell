// 验收 E2E（2026-09-13）：压缩信封替代 + 跨重启落盘 + 召回链的完整闭环。
//
// 场景 = 一次真实重启：
//   1. create 会话 → 两轮 prompt 形成完整任务块 → 手动 tick 触发 M1 压缩
//   2. 断言：信封原位替代 + 磁盘快照 ≡ 内存（含信封）
//   3. close 会话（模拟进程退出）
//   4. open 会话（模拟重启恢复，走 recoverSession）
//   5. 断言：信封存活且逐 id 与重启前一致；被压缩块的工具回合仍在 databus
//      （方案 A），工具戳可精确召回全文；state_query 按戳召回 curated 块；
//      raw-archive 按 summaryStamp 召回原始消息序列。
//
// 临时验收文件，验收后按用户指示去留。

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { createHostAssembly } from '../../src/host/assembly.js'
import type { HostAssembly } from '../../src/host/assembly.js'
import type { SystemAgent } from '../../src/im/system-agent.js'
import { createMetrics } from '../../src/shell/metrics.js'
import { stampOfToolTurn } from '../../src/im/databus.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'restart-recall-e2e-'))

let assembly: HostAssembly

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
      status_hint: 'DONE',
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

describe('restart E2E: envelope survives reopen; recall chains stay live (方案 A)', () => {
  it('compress → close → open: envelope identical, databus stamp recall, state_query stamp recall', { timeout: 30_000 }, async () => {
    const ws = join(tmpRoot, 'ws')
    mkdirSync(ws, { recursive: true })

    assembly = await createHostAssembly({
      dataDir: join(tmpRoot, 'sessions'),
      mock: true,
      compressorOverride: fakeCompressor,
    })

    const approvalIds: string[] = []
    assembly.gate.on('approval', (req) => {
      if (req.kind === 'approval') approvalIds.push(req.requestId)
    })

    // ---- 阶段 1：会话 + 完整任务块 ----
    const handle = await assembly.handlers.session.create({ workDir: ws })
    const sessionId = handle.info.id
    const pending = assembly.handlers.runPrompt(sessionId, 'hi')
    await vi.waitFor(() => expect(approvalIds.length).toBeGreaterThan(0), { timeout: 5000 })
    assembly.gate.resolve(approvalIds[0]!, 'approved')
    expect((await pending).reason).toBe('completed')

    const pending2 = assembly.handlers.runPrompt(sessionId, 'again')
    expect((await pending2).reason).toBe('completed')

    // 记录压缩前工具回合的戳（召回钥匙）
    const toolTurnBefore = handle.runtime.databus.turns().find(t => t.toolName === 'write')
      ?? handle.runtime.databus.turns()[0]
    expect(toolTurnBefore).toBeDefined()
    const toolStamp = stampOfToolTurn(toolTurnBefore!)
    const toolFullContent = String(toolTurnBefore!.content)

    // ---- 阶段 2：触发压缩 ----
    await handle.runtime.driveCoordinator.tick({
      contextTokens: 1,
      conversation: handle.runtime.conversationMemory,
      databus: handle.runtime.databus,
      memoryConfig: { m1MinTokens: 1, m2MinTokens: 500_000, m3MinTokens: 900_000 },
    })

    const memBeforeClose = handle.runtime.conversationMemory.turns()
    await vi.waitFor(() => {
      expect(memBeforeClose[0]!.id.startsWith('mem-')).toBe(true)
    }, { timeout: 5000 })
    const envelopeId = memBeforeClose[0]!.id
    const envelopeContent = String((memBeforeClose[0] as { content: string }).content)
    const stampMatch = envelopeContent.match(/^#STAMP (S-\S+)/m)
    expect(stampMatch).not.toBeNull()
    const blockStamp = stampMatch![1]!
    // status_hint DONE → #STATUS DONE（不得混淆）
    expect(envelopeContent).toContain('#STATUS DONE')
    expect(envelopeContent.endsWith('#END_BLOCK')).toBe(true)

    // 磁盘 ≡ 内存（落盘队列收敛）
    await vi.waitFor(() => {
      const disk = readFileSync(join(tmpRoot, 'sessions', sessionId, 'conversation.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map(l => JSON.parse(l) as { id: string })
      expect(disk.map(r => r.id)).toEqual(memBeforeClose.map(t => t.id))
    }, { timeout: 5000 })

    // databus 磁盘快照同样含被压缩块的工具回合（方案 A：不逐出）
    await vi.waitFor(() => {
      const diskDb = readFileSync(join(tmpRoot, 'sessions', sessionId, 'databus.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map(l => JSON.parse(l) as { id: string })
      expect(diskDb.map(r => r.id)).toEqual(handle.runtime.databus.turns().map(t => t.id))
      expect(diskDb.some(r => r.id === toolTurnBefore!.id)).toBe(true)
    }, { timeout: 5000 })

    // ---- 阶段 3：重启（close → open）----
    await assembly.handlers.session.close(sessionId)
    const reopened = await assembly.handlers.session.open(sessionId)

    // 证据 R1：信封存活，逐 id 与重启前完全一致（位置/角色/内容）
    const memAfterOpen = reopened.runtime.conversationMemory.turns()
    expect(memAfterOpen.map(t => t.id)).toEqual(memBeforeClose.map(t => t.id))
    expect(memAfterOpen[0]!.id).toBe(envelopeId)
    expect(memAfterOpen[0]!.role).toBe('user')
    expect(String((memAfterOpen[0] as { content: string }).content)).toBe(envelopeContent)

    // 证据 R2（databus 召回链）：被压缩块的工具回合仍在，戳可精确召回全文
    const recalled = reopened.runtime.databus.turns().filter(t => stampOfToolTurn(t) === toolStamp)
    expect(recalled.length).toBeGreaterThan(0)
    expect(String(recalled[0]!.content)).toBe(toolFullContent)

    // 证据 R3（state_query 召回链）：按信封里的戳召回 curated 块
    const curated = reopened.runtime.stateLine.query({ layer: 'M1', stamps: [blockStamp] })
    expect(curated.length).toBe(1)
    expect((curated[0] as { task_goal?: string }).task_goal).toBe('create hello.txt')

    // 证据 R4（深召回链）：按戳取回原始消息序列（raw-archive）
    const raw = await reopened.runtime.stateLine.rawArchive.query({ summaryStamps: [blockStamp] })
    expect(raw.length).toBe(1)
    expect(raw[0]!.messages.length).toBeGreaterThan(0)
    // 原始序列含工具结果全文（与 databus 召回互为印证）
    const rawToolMsg = raw[0]!.messages.find(m => m.role === 'tool')
    expect(rawToolMsg).toBeDefined()
  })
})
