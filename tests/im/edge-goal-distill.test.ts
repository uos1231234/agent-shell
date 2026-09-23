// v0.41 G2 — 信封折叠的端到端测试（真实 StateLine + 真实 coordinator）。
//
// 这里跑的是一条完整的梯度：连续四次 G1 产出四个相邻信封 → findDistillRun 定位
// → distillEnvelopes 折叠成一个带血缘的新块。用真实的 G1 产出而不是手搓信封，
// 是为了同时验证"G1 最旧优先 ⇒ 信封天然相邻"这个承重前提（计划 §5.3）。
//
// 钉住的关键性质：
//  (1) N→1 折叠后 canonical 长度正确、其余回合未被波及；
//  (2) `_sourceStamps` 结构化血缘（戳 + covers + 代际）落盘，且**原戳仍可
//      state_query 解析**（召回不断链）；信封 #LINEAGE 逐戳交代内容与代际；
//  (3) G2 **不写 raw-archive**——原文在各自 G1 时已归档，再写是同一批消息的重复归档；
//  (4) 新块标 'M1'（D11，避开 selectStateLineBlocks 的 M2 投影缝隙）；
//  (5) 新信封仍被 findNextTaskBlock 跳过（mem- 前缀），不会被当块再压一遍；
//  (6) 区间失效 / 落盘失败时不折叠且 canonical 未被改动（D16）；
//  (7) 代数硬闸（2026-09-22 拍板）：新信封是二代，#LINEAGE 在 → 含它的区间
//      永不被 findDistillRun 选中（G2→G3 禁止）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createDriveCoordinator,
  findNextTaskBlock,
  estimateBlockTokens,
  envelopeGeneration,
  type DriveCoordinator,
} from '../../src/im/system-agents/drive-coordinator.js'
import { mergeGoalBlock } from '../../src/im/goal/block-merge.js'
import { findDistillRun, extractEnvelopeStamp } from '../../src/im/goal/distill.js'
import { ConversationMemory } from '../../src/im/conversation-memory.js'
import { Databus } from '../../src/im/databus.js'
import { Mailbox } from '../../src/im/mailbox/index.js'
import { createSignalBus } from '../../src/im/memory-layers.js'
import { createStateLine } from '../../src/im/state-line/index.js'
import { appendCanonicalTurn } from '../../src/im/turn.js'
import type { ConversationTurn } from '../../src/im/conversation-memory.js'
import type { StateLine, RawArchiveRecord, CuratedMemory, StampLineageEntry } from '../../src/im/state-line/types.js'
import type { SystemAgent } from '../../src/im/system-agent.js'
import type { ChatMessage } from '../../src/protocol/types.js'

const neverAgent = (label: string): SystemAgent & { calls: number } => {
  const a = {
    calls: 0,
    async run(_input: { messages: ChatMessage[]; metadata?: Record<string, unknown> }) {
      a.calls += 1
      throw new Error(`${label} 不该被调用`)
    },
    stop() {},
    send() {},
  }
  return a
}

const DISTILLED: CuratedMemory = {
  task_goal: '四块共同服务的上层目标',
  causal_steps: [],
  evidence_fragments: [],
  conclusion: '四块合并后的结论：a.txt 已写入，b.txt 仍缺',
  next_action: '补写 b.txt',
  working_state: {
    current_goal: '四块共同服务的上层目标',
    effective_decisions: [],
    rejected_decisions: ['被否决的方案 A：因为权限不足'],
    architecture_boundaries: [],
    remaining_work: ['补写 b.txt'],
  },
  status_hint: 'PENDING',
}

let n = 0
const nid = (p: string): string => `${p}-${n++}`
const user = (content: string, prefix = 'user'): ConversationTurn => ({ id: nid(prefix), role: 'user', content, at: n })
const assistant = (content: string): ConversationTurn => ({ id: nid('assistant'), role: 'assistant', content, at: n })

describe('edge: G2 信封折叠（真实 StateLine + 真实 G1 产出）', () => {
  let tmp: string
  let stateLine: StateLine
  let dc: DriveCoordinator
  let compressor: ReturnType<typeof neverAgent>
  let conv: ConversationMemory
  let bus: Databus

  const readJsonl = <T>(file: string): T[] => {
    const p = join(tmp, 'state', file)
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as T)
  }
  const contentOf = (t: ConversationTurn): string =>
    typeof t.content === 'string' ? t.content : JSON.stringify(t.content)

  /** 跑一次 G1：定位最旧的已关闭块 → 本地合并 → 落盘。返回新戳。 */
  const runG1 = async (condition: string, reason: string): Promise<string> => {
    const block = findNextTaskBlock(conv.turns())
    if (block === undefined) throw new Error('没有已关闭块可合并')
    const memory = mergeGoalBlock({ block, condition, verdictReason: reason, inputKeepTokens: 1_000 })
    const r = await dc.mergeGoalBlock!({
      snapshot: { contextTokens: estimateBlockTokens(block), conversation: conv, databus: bus },
      block,
      memory,
    })
    if (r === undefined) throw new Error('G1 未落盘')
    return r.stamp
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'goal-g2-'))
    stateLine = createStateLine({ databusPath: tmp })
    compressor = neverAgent('compressor')
    dc = createDriveCoordinator({
      bus: createSignalBus(),
      compressor,
      warehouse: neverAgent('warehouse'),
      stateLine,
      mailbox: new Mailbox(),
      workingAgentId: 'main',
      goalModeActive: () => true,
    })
    conv = new ConversationMemory()
    bus = new Databus()
    // 四个 goal 轮的形状：[真实输入 + 回答] 然后三轮 [提醒 + 回答]，末尾再一个
    // 提醒作为第四块的右边界。这正是 goal 模式跑起来后 canonical 的真实样子。
    for (const t of [
      user('第一轮的输入材料'), assistant('第一轮的结论'),
      user('提醒一', 'goal'), assistant('第二轮的结论'),
      user('提醒二', 'goal'), assistant('第三轮的结论'),
      user('提醒三', 'goal'), assistant('第四轮的结论'),
      user('提醒四', 'goal'),
    ]) appendCanonicalTurn(conv, bus, t)
  })

  afterEach(() => {
    stateLine.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('连续四次 G1 产出四个**相邻**信封（G2 的连续性前提）', async () => {
    for (let i = 0; i < 4; i += 1) await runG1('目标', `第 ${i + 1} 次未达成理由`)

    const turns = conv.turns()
    expect(turns.slice(0, 4).every((t) => t.id.startsWith('mem-'))).toBe(true)
    // G1 全程不调 LLM（原则 4）
    expect(compressor.calls).toBe(0)
    // 四次 G1 各归档一次原文
    expect(readJsonl<RawArchiveRecord>('raw-archive.jsonl')).toHaveLength(4)
  })

  it('N→1 折叠：canonical 缩短 3、血缘落盘、原戳仍可召回、不写新 raw-archive', async () => {
    for (let i = 0; i < 4; i += 1) await runG1('目标', `理由 ${i + 1}`)
    const before = conv.turns().length
    const archivesBefore = readJsonl<RawArchiveRecord>('raw-archive.jsonl').length

    const run = findDistillRun(conv.turns(), { minBlocks: 4, minTokens: 1 })
    expect(run).toBeDefined()
    expect(run!.stamps).toHaveLength(4)

    const r = await dc.distillEnvelopes!({
      snapshot: { contextTokens: 100, conversation: conv, databus: bus },
      memory: DISTILLED,
      range: {
        startIndex: run!.startIndex,
        endIndexExclusive: run!.endIndexExclusive,
        sourceStamps: run!.stamps,
      },
    })

    expect(r).toBeDefined()
    // (1) 4 个信封 → 1 个
    expect(conv.turns()).toHaveLength(before - 3)
    const folded = conv.turns()[0]!
    expect(folded.id.startsWith('mem-')).toBe(true)
    const envelopeText = contentOf(folded)
    expect(envelopeText).toContain(`#STAMP ${r!.stamp}`)
    expect(envelopeText).toContain('[结论] 四块合并后的结论：a.txt 已写入，b.txt 仍缺')
    // 可发现性（§6.26）：#LINEAGE 逐戳交代原戳、代际与 covers（任务/结论一行式）
    expect(envelopeText).toContain('#LINEAGE gen=2 sources=4')
    for (const s of run!.stamps) {
      expect(envelopeText).toContain(`- ${s} (gen=1): `)
    }
    // covers 来自各 G1 信封正文（task_goal=条件逐字、conclusion=最终 assistant 正文）
    expect(envelopeText).toContain('任务=目标；结论=第一轮的结论')
    expect(envelopeText).toContain('任务=目标；结论=第四轮的结论')
    // 折叠后的区间之后的回合未被波及
    expect(contentOf(conv.turns()[1]!)).toBe('提醒四')

    // (2) 结构化血缘落盘 + 原戳仍可解析
    const blocks = readJsonl<CuratedMemory & { _stamp?: string; _sourceStamps?: StampLineageEntry[] }>('curatedMemory.jsonl')
    expect(blocks).toHaveLength(5) // 4 个 G1 + 1 个 G2
    const g2 = blocks[4]!
    expect(g2._stamp).toBe(r!.stamp)
    expect(g2._sourceStamps).toHaveLength(4)
    expect(g2._sourceStamps!.map((e) => e.stamp)).toEqual(run!.stamps)
    expect(g2._sourceStamps!.every((e) => e.generation === 1)).toBe(true)
    expect(g2._sourceStamps![0]!.covers).toBe('任务=目标；结论=第一轮的结论')
    expect(g2.conclusion).toBe(DISTILLED.conclusion)
    // 被否决的方案逐字保留（D10 保守合并档的核心要求）
    expect(g2.working_state.rejected_decisions).toEqual(['被否决的方案 A：因为权限不足'])
    for (const s of run!.stamps) {
      expect(stateLine.query({ stamps: [s] })).toHaveLength(1)
    }
    // 新戳同样可查
    expect(stateLine.query({ stamps: [r!.stamp] })).toHaveLength(1)

    // (3) G2 不写 raw-archive
    expect(readJsonl<RawArchiveRecord>('raw-archive.jsonl')).toHaveLength(archivesBefore)

    // (4) 标 M1（D11）：stamps.jsonl 的 layer 记录
    const stamps = readJsonl<{ stamp: string; layer: string }>('stamps.jsonl')
    expect(stamps.find((x) => x.stamp === r!.stamp)!.layer).toBe('M1')

    // (5) 新信封仍被 findNextTaskBlock 跳过——不会被当块再压一遍。
    // 折叠后 canonical 是 [新信封, 提醒四]，而"提醒四"没有右边界（本轮还没收尾），
    // 所以先补一个收尾边界让块存在，才能验证"起点是提醒四而不是信封"。
    appendCanonicalTurn(conv, bus, user('收尾边界'))
    const nextBlock = findNextTaskBlock(conv.turns())
    expect(nextBlock).toBeDefined()
    expect(nextBlock!.startIndex).toBe(1) // 从"提醒四"开始，不是从信封开始
    expect(conv.turns()[0]!.id.startsWith('mem-')).toBe(true)
    expect(conv.turns()[nextBlock!.startIndex]!.id.startsWith('mem-')).toBe(false)
  })

  it('折叠体量指标：beforeTokens 是四个信封之和，afterTokens 是新信封', async () => {
    for (let i = 0; i < 4; i += 1) await runG1('目标', `理由 ${i}`)
    const run = findDistillRun(conv.turns(), { minBlocks: 4, minTokens: 1 })!
    const beforeSum = conv.turns().slice(run.startIndex, run.endIndexExclusive)
      .reduce((a, t) => a + contentOf(t).length, 0)

    const r = await dc.distillEnvelopes!({
      snapshot: { contextTokens: 100, conversation: conv, databus: bus },
      memory: DISTILLED,
      range: { startIndex: run.startIndex, endIndexExclusive: run.endIndexExclusive, sourceStamps: run.stamps },
    })

    expect(r!.beforeTokens).toBeGreaterThan(0)
    expect(r!.afterTokens).toBeGreaterThan(0)
    // 新信封比四个旧信封加起来小（保守合并档仍有 N→1 的结构性收益）
    expect(contentOf(conv.turns()[0]!).length).toBeLessThan(beforeSum)
  })

  it('区间失效（不再是信封）→ 不折叠，canonical 未被改动', async () => {
    for (let i = 0; i < 4; i += 1) await runG1('目标', 'r')
    const before = conv.turns().length

    const r = await dc.distillEnvelopes!({
      snapshot: { contextTokens: 100, conversation: conv, databus: bus },
      memory: DISTILLED,
      // 故意给一个覆盖到非信封回合的区间
      range: { startIndex: 0, endIndexExclusive: 6, sourceStamps: ['S-x'] },
    })

    expect(r).toBeUndefined()
    expect(conv.turns()).toHaveLength(before)
    // 什么都没落盘
    expect(readJsonl('curatedMemory.jsonl')).toHaveLength(4)
  })

  it('落盘失败（appendBlock 抛错）→ 不折叠，canonical 未被改动', async () => {
    for (let i = 0; i < 4; i += 1) await runG1('目标', 'r')
    const before = conv.turns().length
    const run = findDistillRun(conv.turns(), { minBlocks: 4, minTokens: 1 })!

    const brokenLine: StateLine = {
      ...stateLine,
      compressor: { async appendBlock() { throw new Error('disk full') } },
    }
    const brokenDc = createDriveCoordinator({
      bus: createSignalBus(), compressor: neverAgent('compressor'), warehouse: neverAgent('warehouse'),
      stateLine: brokenLine, mailbox: new Mailbox(), workingAgentId: 'main',
    })

    const r = await brokenDc.distillEnvelopes!({
      snapshot: { contextTokens: 100, conversation: conv, databus: bus },
      memory: DISTILLED,
      range: { startIndex: run.startIndex, endIndexExclusive: run.endIndexExclusive, sourceStamps: run.stamps },
    })

    expect(r).toBeUndefined()
    // appendBlock 在 replaceRange 之前 → 四个信封原样保留，下一轮再试（D16）
    expect(conv.turns()).toHaveLength(before)
    expect(conv.turns().slice(0, 4).every((t) => t.id.startsWith('mem-'))).toBe(true)
    expect(findDistillRun(conv.turns(), { minBlocks: 4, minTokens: 1 })).toBeDefined()
  })

  it('stop() 之后不折叠', async () => {
    for (let i = 0; i < 4; i += 1) await runG1('目标', 'r')
    dc.stop()
    const run = findDistillRun(conv.turns(), { minBlocks: 4, minTokens: 1 })!
    const r = await dc.distillEnvelopes!({
      snapshot: { contextTokens: 100, conversation: conv, databus: bus },
      memory: DISTILLED,
      range: { startIndex: run.startIndex, endIndexExclusive: run.endIndexExclusive, sourceStamps: run.stamps },
    })
    expect(r).toBeUndefined()
    expect(conv.turns().slice(0, 4).filter((t) => t.id.startsWith('mem-'))).toHaveLength(4)
  })

  it('折叠后的新信封仍带完整标记族（模型视野判据）', async () => {
    for (let i = 0; i < 4; i += 1) await runG1('目标', 'r')
    const run = findDistillRun(conv.turns(), { minBlocks: 4, minTokens: 1 })!
    const r = await dc.distillEnvelopes!({
      snapshot: { contextTokens: 100, conversation: conv, databus: bus },
      memory: DISTILLED,
      range: { startIndex: run.startIndex, endIndexExclusive: run.endIndexExclusive, sourceStamps: run.stamps },
    })

    const text = contentOf(conv.turns()[0]!)
    expect(extractEnvelopeStamp(text)).toBe(r!.stamp)
    expect(text).toContain('#LAYER M1')
    expect(text).toContain('#STATUS PENDING')
    expect(text).toContain('#NOTE')
    expect(text).toContain('state_query')
    expect(text.trimEnd().endsWith('#END_BLOCK')).toBe(true)
    // 新信封是二代（带 #LINEAGE）。代数硬闸（2026-09-22 拍板）：G2→G3 禁止，
    // 它不会再被任何一轮 G2 折叠——集成级验证见下一个用例。
    expect(envelopeGeneration(text)).toBe(2)
  })

  it('代数硬闸（集成）：二代信封与三个新 G1 相邻成 4 连，含它的区间不被选中', async () => {
    for (let i = 0; i < 4; i += 1) await runG1('目标', 'r')
    const run = findDistillRun(conv.turns(), { minBlocks: 4, minTokens: 1 })!
    await dc.distillEnvelopes!({
      snapshot: { contextTokens: 100, conversation: conv, databus: bus },
      memory: DISTILLED,
      range: { startIndex: run.startIndex, endIndexExclusive: run.endIndexExclusive, sourceStamps: run.stamps },
    })
    // 折叠后 canonical = [mem-二代, 提醒四]。补三个"已关闭块"再各跑一次 G1，
    // 造出 [二代, G1, G1, G1] 四连——块数够、体量够，唯一障碍是硬闸。
    appendCanonicalTurn(conv, bus, user('边界甲'))
    await runG1('目标', 'r')
    appendCanonicalTurn(conv, bus, user('边界乙'))
    await runG1('目标', 'r')
    appendCanonicalTurn(conv, bus, user('边界丙'))
    await runG1('目标', 'r')

    const turns = conv.turns()
    expect(turns.slice(0, 4).every((t) => t.id.startsWith('mem-'))).toBe(true)
    expect(envelopeGeneration(contentOf(turns[0]!))).toBe(2)
    expect(envelopeGeneration(contentOf(turns[1]!))).toBe(1)
    // 4 个连续信封、远超体量门控，但含二代 → 整个区间跳过（不部分折叠）
    expect(findDistillRun(turns, { minBlocks: 4, minTokens: 1 })).toBeUndefined()
  })
})
