// v0.41 D7 — goal 模式与既有跨越驱动压缩的互斥，以及 G1 的落盘通道。
//
// 互斥是必需而非洁癖（`[已验证]`）：两条路径共用 inFlightBlockKey 单飞守卫与
// 同一个 findNextTaskBlock(turns) 从 0 扫描，会争抢同一个块；更严重的是跨越
// 驱动会用 11 字段 LLM 形态压掉 goal 块——一个 80K 的信息分析块被压成结构化
// 摘要，正是 G1"结论逐字全量、不设上限"（D9）要避免的损失。
//
// 但**只互斥块压缩派发**：M3 归档驱动与 lastLayer 记账保留（归档与块压缩是
// 两个关注点，warehouse 索引不该因 goal 断供）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createDriveCoordinator,
  findNextTaskBlock,
  type DriveDeps,
  type DriveSnapshot,
} from '../../../src/im/system-agents/drive-coordinator.js'
import { mergeGoalBlock } from '../../../src/im/goal/block-merge.js'
import { ConversationMemory } from '../../../src/im/conversation-memory.js'
import { Databus } from '../../../src/im/databus.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import { createSignalBus } from '../../../src/im/memory-layers.js'
import { createStateLine } from '../../../src/im/state-line/index.js'
import { appendCanonicalTurn } from '../../../src/im/turn.js'
import type { ConversationTurn } from '../../../src/im/conversation-memory.js'
import type { StateLine, StateLineEntry, RawArchiveRecord, CuratedMemory } from '../../../src/im/state-line/types.js'
import type { SystemAgent } from '../../../src/im/system-agent.js'
import type { ChatMessage } from '../../../src/protocol/types.js'
import type { Logger, LogFields } from '../../../src/shared/logger.js'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type AgentCall = { messages: ChatMessage[]; metadata: Record<string, unknown> | undefined }

const fakeAgent = (label: string): SystemAgent & { calls: AgentCall[] } => {
  const calls: AgentCall[] = []
  return {
    calls,
    async run(input) {
      calls.push({ messages: input.messages, metadata: input.metadata })
      throw new Error(`${label} 不该被调用`)
    },
    stop() {},
    send() {},
  }
}

/** warehouse 需要能成功跑完 M3 归档，所以它不抛错。 */
const okAgent = (): SystemAgent & { calls: AgentCall[] } => {
  const calls: AgentCall[] = []
  return {
    calls,
    async run(input) {
      calls.push({ messages: input.messages, metadata: input.metadata })
      return {
        output: 'archived',
        metrics: {} as never,
        finalState: 'Running' as never,
        reason: 'completed' as const,
        hits: [],
      }
    },
    stop() {},
    send() {},
  }
}

const mockStateLine = (entries: { M1?: StateLineEntry[]; M2?: StateLineEntry[] } = {}): StateLine & { raw: RawArchiveRecord[] } => {
  const raw: RawArchiveRecord[] = []
  return {
    raw,
    compressor: { async appendBlock() {} },
    warehouse: { async appendSummary() {}, async queryM3() { return { ok: false, error: 'mock' } } },
    rawArchive: {
      async append(r: RawArchiveRecord) { raw.push(r) },
      async query() { return raw },
    },
    query(filter) {
      if (filter.layer === 'M1') return entries.M1 ?? []
      if (filter.layer === 'M2') return entries.M2 ?? []
      return [...(entries.M1 ?? []), ...(entries.M2 ?? [])]
    },
    subscribe() { return () => {} },
    close() {},
  }
}

type LogRecord = { level: string; msg: string; fields?: LogFields }
const fakeLogger = (): Logger & { records: LogRecord[] } => {
  const records: LogRecord[] = []
  const make = (bindings: LogFields): Logger => {
    const push = (level: string) => (msg: string, fields?: LogFields): void => {
      records.push({ level, msg, fields: { ...bindings, ...fields } })
    }
    return {
      trace: push('trace'), debug: push('debug'), info: push('info'),
      warn: push('warn'), error: push('error'),
      child(b: LogFields) { return make({ ...bindings, ...b }) },
    }
  }
  return Object.assign(make({}), { records })
}

// ---------------------------------------------------------------------------
// Canonical fixtures
// ---------------------------------------------------------------------------

let n = 0
const nid = (p: string): string => `${p}-${n++}`

const user = (content: string, prefix = 'user'): ConversationTurn => ({ id: nid(prefix), role: 'user', content, at: n })
const assistant = (content: string): ConversationTurn => ({ id: nid('assistant'), role: 'assistant', content, at: n })

/** 两个已关闭块：[u1 a1] 由 goal 提醒关闭，[goal-r1 a2] 由 u3 关闭。 */
const seedTwoClosedBlocks = (): { conv: ConversationMemory; bus: Databus } => {
  const conv = new ConversationMemory()
  const bus = new Databus()
  for (const t of [
    user('第一块的输入材料'), assistant('第一块的结论'),
    user('续跑提醒', 'goal'), assistant('第二块的结论'),
    user('第三块起始（右边界）'),
  ]) appendCanonicalTurn(conv, bus, t)
  return { conv, bus }
}

const snapshotOf = (conv: ConversationMemory, bus: Databus, contextTokens: number): DriveSnapshot => ({
  contextTokens, conversation: conv, databus: bus,
})

// ---------------------------------------------------------------------------

describe('drive-coordinator — goal 模式互斥（D7）', () => {
  let compressor: ReturnType<typeof fakeAgent>
  let warehouse: ReturnType<typeof okAgent>
  let deps: DriveDeps

  beforeEach(() => {
    compressor = fakeAgent('compressor')
    warehouse = okAgent()
    deps = {
      bus: createSignalBus(),
      compressor,
      warehouse,
      stateLine: mockStateLine(),
      mailbox: new Mailbox(),
      workingAgentId: 'main',
    }
  })

  it('goal 激活 → M0→M1 跨越不派发 compressor', async () => {
    const { conv, bus } = seedTwoClosedBlocks()
    const dc = createDriveCoordinator({ ...deps, goalModeActive: () => true })

    await dc.tick(snapshotOf(conv, bus, 250_000)) // 跨进 M1

    expect(compressor.calls).toHaveLength(0)
    // canonical 未被改动：两块都还在，没有信封
    expect(conv.turns()).toHaveLength(5)
    expect(conv.turns().some((t) => t.id.startsWith('mem-'))).toBe(false)
  })

  it('goal 激活 → M3 sustained 也不派发 compressor', async () => {
    const { conv, bus } = seedTwoClosedBlocks()
    const dc = createDriveCoordinator({ ...deps, goalModeActive: () => true })

    // 先跨进 M3（无 M1/M2 curated 块 → 归档分支跳过），再 tick 一次触发 sustained
    await dc.tick(snapshotOf(conv, bus, 950_000))
    await dc.tick(snapshotOf(conv, bus, 950_000))

    expect(compressor.calls).toHaveLength(0)
    expect(conv.turns()).toHaveLength(5)
  })

  it('goal 激活 → M3 归档驱动**照跑**（归档与块压缩是两个关注点）', async () => {
    const { conv, bus } = seedTwoClosedBlocks()
    const curated: StateLineEntry[] = [{
      task_goal: '已压块', causal_steps: [], evidence_fragments: [],
      conclusion: 'c', next_action: 'n',
      working_state: { current_goal: 'g', effective_decisions: [], rejected_decisions: [], architecture_boundaries: [], remaining_work: [] },
      status_hint: 'DONE', _stamp: 'S-1',
    }]
    const dc = createDriveCoordinator({
      ...deps,
      stateLine: mockStateLine({ M1: curated }),
      goalModeActive: () => true,
    })

    await dc.tick(snapshotOf(conv, bus, 950_000)) // 跨进 M3

    expect(warehouse.calls).toHaveLength(1)
    expect(warehouse.calls[0]!.metadata).toMatchObject({ kind: 'archive', zone: 'M3', sourceStamps: ['S-1'] })
    // 归档照跑，但块压缩仍被互斥挡住
    expect(compressor.calls).toHaveLength(0)
  })

  it('goal 激活期间块压缩让位 goal 路径；goal 结束后持续档恢复派发', async () => {
    const { conv, bus } = seedTwoClosedBlocks()
    let goalOn = true
    const dc = createDriveCoordinator({ ...deps, goalModeActive: () => goalOn })

    await dc.tick(snapshotOf(conv, bus, 250_000)) // goal 开着 → 块压缩移交 goal 路径，tick 不派发
    expect(compressor.calls).toHaveLength(0)

    // 持续档（2026-09-16 修复）：goal 关闭后，M1 不再是"跨越消费即静默"，
    // 下一个 tick 直接恢复每-tick-一块的派发 → 压掉首个可压块。
    goalOn = false
    await dc.tick(snapshotOf(conv, bus, 250_000))
    expect(compressor.calls).toHaveLength(1)
  })

  it('goal 未激活（缺省）→ 跨越派发照常，行为逐字节不变', async () => {
    const { conv, bus } = seedTwoClosedBlocks()
    const reply: CuratedMemory = {
      task_goal: 't', causal_steps: [], evidence_fragments: [],
      conclusion: 'c', next_action: 'n',
      working_state: { current_goal: 'g', effective_decisions: [], rejected_decisions: [], architecture_boundaries: [], remaining_work: [] },
      status_hint: 'DONE',
    }
    const compressor2: SystemAgent & { calls: AgentCall[] } = {
      calls: [],
      async run(input) {
        this.calls.push({ messages: input.messages, metadata: input.metadata })
        return { output: '', submitted: reply, metrics: {} as never, finalState: 'Running' as never, reason: 'completed' as const, hits: [] }
      },
      stop() {}, send() {},
    }
    const dc = createDriveCoordinator({ ...deps, compressor: compressor2 })

    await dc.tick(snapshotOf(conv, bus, 250_000))

    expect(compressor2.calls).toHaveLength(1)
    // 最旧的那块被压掉并换成信封
    expect(conv.turns()[0]!.id.startsWith('mem-')).toBe(true)
  })

  it('goalModeActive 返回 false 与缺省等价', async () => {
    const { conv, bus } = seedTwoClosedBlocks()
    const dc = createDriveCoordinator({ ...deps, goalModeActive: () => false })
    // 会派发 → compressor 抛错（fakeAgent）→ 走 failed 分支，但不该被互斥挡住
    await dc.tick(snapshotOf(conv, bus, 250_000))
    expect(compressor.calls).toHaveLength(1)
  })

  it('stop() 之后 tick 与 mergeGoalBlock 都不工作', async () => {
    const { conv, bus } = seedTwoClosedBlocks()
    const dc = createDriveCoordinator({ ...deps, goalModeActive: () => true })
    dc.stop()
    await dc.tick(snapshotOf(conv, bus, 950_000))
    expect(warehouse.calls).toHaveLength(0)

    const block = findNextTaskBlock(conv.turns())!
    const r = await dc.mergeGoalBlock!({
      snapshot: snapshotOf(conv, bus, 100),
      block,
      memory: mergeGoalBlock({ block, condition: 'c', verdictReason: 'r', inputKeepTokens: 100 }),
    })
    expect(r).toBeUndefined()
  })
})

describe('drive-coordinator — mergeGoalBlock 落盘（G1 通道）', () => {
  let tmp: string

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'goal-g1-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  const readJsonl = <T>(file: string): T[] => {
    const p = join(tmp, 'state', file)
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as T)
  }

  const build = (log?: Logger) => {
    const compressor = fakeAgent('compressor')
    const stateLine = createStateLine({ databusPath: tmp })
    const dc = createDriveCoordinator({
      bus: createSignalBus(),
      compressor,
      warehouse: okAgent(),
      stateLine,
      mailbox: new Mailbox(),
      workingAgentId: 'main',
      ...(log !== undefined ? { logger: log } : {}),
    })
    return { dc, compressor, stateLine }
  }

  it('走真实 StateLine：curated 块 + raw-archive 原文落盘，canonical 逐出并插入带戳信封', async () => {
    const { dc, compressor, stateLine } = build()
    const { conv, bus } = seedTwoClosedBlocks()
    const block = findNextTaskBlock(conv.turns())!
    const memory = mergeGoalBlock({ block, condition: '目标条件', verdictReason: '缺证据', inputKeepTokens: 1_000 })

    const r = await dc.mergeGoalBlock!({ snapshot: snapshotOf(conv, bus, 100), block, memory })
    stateLine.close()

    expect(r).toBeDefined()
    // **G1 不调 LLM**：compressor 一次都没被调用（原则 4）
    expect(compressor.calls).toHaveLength(0)

    // curated 块落盘，带 G1 的字段形态
    const blocks = readJsonl<CuratedMemory & { _stamp?: string }>('curatedMemory.jsonl')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!._stamp).toBe(r!.stamp)
    expect(blocks[0]!.task_goal).toBe('目标条件')
    expect(blocks[0]!.conclusion).toBe('第一块的结论')
    expect(blocks[0]!.status_hint).toBe('PENDING')
    // 空数组原样落盘（约束 7：validateCuratedMemory 只校验存在性）
    expect(blocks[0]!.causal_steps).toEqual([])

    // 原文全量进 raw-archive（模型视野判据：逐出后仍可召回）
    const raw = readJsonl<RawArchiveRecord>('raw-archive.jsonl')
    expect(raw).toHaveLength(1)
    expect(raw[0]!.summaryStamp).toBe(r!.stamp)
    expect(raw[0]!.sourceTurnIds).toEqual(block.turns.map((t) => t.id))
    expect(raw[0]!.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    // 原文逐字保留，不截断
    expect(raw[0]!.messages[0]!.role === 'user' && raw[0]!.messages[0]!.content).toBe('第一块的输入材料')

    // canonical：原范围逐出 + 原位插入信封
    const turns = conv.turns()
    expect(turns[0]!.id.startsWith('mem-')).toBe(true)
    expect(turns[0]!.role).toBe('user')
    const envelope = String((turns[0] as { content: unknown }).content)
    expect(envelope).toContain(`#STAMP ${r!.stamp}`)
    expect(envelope).toContain('#LAYER M1')
    expect(envelope).toContain('#STATUS PENDING')
    expect(envelope).toContain('[结论] 第一块的结论')
    expect(envelope).toContain('#END_BLOCK')
    // 其余回合未动：5 - 2（逐出）+ 1（信封）= 4
    expect(turns).toHaveLength(4)
  })

  it('低压缩率时 log.warn 留痕，但**不加 cap、不拒绝、不重试**（D12）', async () => {
    const log = fakeLogger()
    const { dc, stateLine } = build(log)
    const { conv, bus } = seedTwoClosedBlocks()
    const block = findNextTaskBlock(conv.turns())!
    // 结论逐字全量（D9）→ 信封几乎和原块一样大 → 必然触发低压缩率告警
    const memory = mergeGoalBlock({ block, condition: 'c', verdictReason: 'r', inputKeepTokens: 1_000 })

    const r = await dc.mergeGoalBlock!({ snapshot: snapshotOf(conv, bus, 100), block, memory })
    stateLine.close()

    expect(r).toBeDefined()
    const warn = log.records.find((x) => x.level === 'warn' && x.msg === 'low compression ratio')
    expect(warn).toBeDefined()
    expect(warn!.fields).toMatchObject({ label: 'mergeGoalBlock', stamp: r!.stamp })
    expect(typeof warn!.fields!.blockTokens).toBe('number')
    expect(typeof warn!.fields!.envelopeTokens).toBe('number')
    expect(typeof warn!.fields!.ratio).toBe('number')
    // 仍然落盘成功了——告警不阻断
    expect(readJsonl('curatedMemory.jsonl')).toHaveLength(1)
  })

  it('高压缩率时不告警', async () => {
    const log = fakeLogger()
    const { dc, stateLine } = build(log)
    const conv = new ConversationMemory()
    const bus = new Databus()
    for (const t of [
      user('M'.repeat(400_000)), // 100K token 的输入材料
      assistant('短结论'),
      user('右边界'),
    ]) appendCanonicalTurn(conv, bus, t)

    const block = findNextTaskBlock(conv.turns())!
    const memory = mergeGoalBlock({ block, condition: 'c', verdictReason: 'r', inputKeepTokens: 1_000 })
    await dc.mergeGoalBlock!({ snapshot: snapshotOf(conv, bus, 100), block, memory })
    stateLine.close()

    expect(log.records.some((x) => x.msg === 'low compression ratio')).toBe(false)
    // 材料被锚截断 + 结论很短 → 信封远小于原块
    const turns = conv.turns()
    expect(String((turns[0] as { content: unknown }).content).length).toBeLessThan(20_000)
  })

  it('落盘失败（appendBlock 抛错）→ 返回 undefined 且 canonical 未被改动', async () => {
    const compressor = fakeAgent('compressor')
    const stateLine = createStateLine({ databusPath: tmp })
    const broken: StateLine = {
      ...stateLine,
      compressor: { async appendBlock() { throw new Error('disk full') } },
    }
    const dc = createDriveCoordinator({
      bus: createSignalBus(), compressor, warehouse: okAgent(),
      stateLine: broken, mailbox: new Mailbox(), workingAgentId: 'main',
    })
    const { conv, bus } = seedTwoClosedBlocks()
    const before = conv.turns().length
    const block = findNextTaskBlock(conv.turns())!
    const memory = mergeGoalBlock({ block, condition: 'c', verdictReason: 'r', inputKeepTokens: 1_000 })

    const r = await dc.mergeGoalBlock!({ snapshot: snapshotOf(conv, bus, 100), block, memory })
    stateLine.close()

    expect(r).toBeUndefined()
    // appendBlock 在 evictRange 之前 → 原文完好，模型直接看到原块仍在
    expect(conv.turns()).toHaveLength(before)
    expect(conv.turns().some((t) => t.id.startsWith('mem-'))).toBe(false)
    expect(existsSync(join(tmp, 'state', 'raw-archive.jsonl'))).toBe(false)
  })
})
