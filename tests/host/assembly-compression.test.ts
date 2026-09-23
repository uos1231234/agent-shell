// v0.27 后置条件补齐：压缩调度接线端到端验证。
//
// 此前生产装配的 driveCoordinator 恒为 noop（session-manager create 路径硬
// 编码 + open 路径 compression 口子无人传），M1/M2/M3 压缩与 M3 入库永不调度。
// 本测试证明：attachHandle 覆盖后的真 coordinator 在生产装配形态下完整走通
// 「切块（user 边界，v0.27 起存在）→ 压缩 → curated 落盘 → raw archive →
// canonical 驱逐」管线——经 gate 的 runPrompt + mock 流（write 工具轮 +
// 完成轮）+ fake compressor（小阈值 m1MinTokens=1 触发 M1 跨越）。
//
// 全进程内经 Signal Gate 交互（审批经 gate.request），与 assembly.test.ts 同款。

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { createHostAssembly } from '../../src/host/assembly.js'
import type { HostAssembly } from '../../src/host/assembly.js'
import type { SystemAgent } from '../../src/im/system-agent.js'
import { createMetrics } from '../../src/shell/metrics.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'host-compression-test-'))

let assembly: HostAssembly

afterAll(async () => {
  await assembly?.shutdown()
  rmSync(tmpRoot, { recursive: true, force: true })
})

// 合法 CuratedMemory（validateCuratedMemory 必过）——mock LLM 产出不了这种
// 结构化回复，所以走 compressorOverride 注入。
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

describe('compression pipeline wired through the gate (drive coordinator no longer noop)', () => {
  it('real coordinator dispatches on M1 crossing → block compressed → curated persisted → canonical evicted', { timeout: 20_000 }, async () => {
    const ws = join(tmpRoot, 'ws-1')
    mkdirSync(ws, { recursive: true })

    assembly = await createHostAssembly({
      dataDir: join(tmpRoot, 'sessions'),
      mock: true,
      // 不传 memoryConfig：默认 200K 阈值下 loop 的每轮自动 tick 都停在 M0
      // （不消费跨越）；M0→M1 跨越由下面的手动 tick 精确控制。若在这里传
      // m1MinTokens=1，loop 第一轮 tick 就会消费掉跨越（M1/M2 跨越一次性
      // 触发），后续手动 tick 因 layer === lastLayer 直接 return。
      compressorOverride: fakeCompressor,
    })

    const approvalIds: string[] = []
    assembly.gate.on('approval', (req) => {
      if (req.kind === 'approval') approvalIds.push(req.requestId)
    })

    const handle = await assembly.handlers.session.create({ workDir: ws })
    const pending = assembly.handlers.runPrompt(handle.info.id, 'hi')
    await vi.waitFor(() => expect(approvalIds.length).toBeGreaterThan(0), { timeout: 5000 })
    assembly.gate.resolve(approvalIds[0]!, 'approved')

    const result = await pending
    expect(result.reason).toBe('completed')

    // mock 首轮 write hello.txt 正常落盘（压缩不应破坏主流程产物）。
    expect(readFileSync(join(ws, 'hello.txt'), 'utf8')).toBe('hello from web-host (mock)\n')

    // 第二条 prompt：形成完整任务块。findNextTaskBlock 的块边界是"下一条
    // user 回合"（无边界 = 任务块未完成，永不压缩）——单条 prompt 的会话
    // 永远没有可压缩块，这是设计语义而非缺陷。
    const pending2 = assembly.handlers.runPrompt(handle.info.id, 'again')
    const result2 = await pending2
    expect(result2.reason).toBe('completed')

    // 手动触发一次 M1 跨越 tick（确定性；loop 内的自动 tick 由 loop 测试覆盖）。
    // 跨越语义：M1/M2 只在 layer 变更时 dispatch 一次——真实会话里 200K 阈值
    // 的跨越时刻任务块早已完整；e2e 里块完整后再跨越，同一语义。noop
    // coordinator 对 tick 无响应——管线走通即证明 runtime 里装的是真
    // coordinator（attachHandle 覆盖生效）。
    await handle.runtime.driveCoordinator.tick({
      contextTokens: 1, // m1MinTokens=1 → M0→M1 跨越
      conversation: handle.runtime.conversationMemory,
      databus: handle.runtime.databus,
      memoryConfig: { m1MinTokens: 1, m2MinTokens: 500_000, m3MinTokens: 900_000 },
    })

    // 证据 1：curated 块 + raw archive 落进会话 state 目录。
    await vi.waitFor(() => {
      const files = readdirSync(join(tmpRoot, 'sessions', handle.info.id, 'state'), { recursive: true })
      const names = files.map((f) => String(f))
      expect(names.some((n) => n.endsWith('curatedMemory.jsonl'))).toBe(true)
      expect(names.some((n) => n.endsWith('raw-archive.jsonl'))).toBe(true)
    }, { timeout: 5000 })

    // 证据 2：压缩块被信封替代块原位替换（2026-09-13，机制参考同类实现）。
    // canonical = [信封(envelope), 边界 user 回合, assistant 回答]。信封是
    // role:'user' 替代回合，内容为闭合信封（#STAMP 头 + #END_BLOCK 尾，
    // 完整渲染 CuratedMemory，不截断）。
    await vi.waitFor(() => {
      const turns = handle.runtime.conversationMemory.turns()
      expect(turns.map((t) => t.role)).toEqual(['user', 'user', 'assistant'])
      const envelopeContent = (turns[0] as { content: string }).content
      expect(envelopeContent).toMatch(/^#STAMP S-/)
      expect(envelopeContent).toContain('#LAYER M1')
      expect(envelopeContent).toContain('#STATUS PENDING')
      expect(envelopeContent).toContain('[任务]')
      expect(envelopeContent.endsWith('#END_BLOCK')).toBe(true)
    }, { timeout: 5000 })

    // 证据 3（跨重启落盘）：磁盘快照 ≡ 模型所见——conversation.jsonl 已按
    // 内存现状（含信封）经 runtime.enqueueSnapshotWrite 原子重写。
    await vi.waitFor(() => {
      const disk = readFileSync(
        join(tmpRoot, 'sessions', handle.info.id, 'conversation.jsonl'), 'utf8',
      ).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; content: string })
      const mem = handle.runtime.conversationMemory.turns()
      expect(disk).toHaveLength(mem.length)
      expect(disk.map((r) => r.id)).toEqual(mem.map((t) => t.id))
      expect(disk[0]!.content).toContain('#END_BLOCK')
    }, { timeout: 5000 })
  })
})
