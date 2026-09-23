// v0.41 G2 — 信封区间定位与折叠请求（纯函数）测试。
//
// findDistillRun 的正确性决定 G2 会不会吞掉不该合并的回合：它必须只认**连续的**
// mem- 信封，且血缘（戳）必须完整——缺戳就跳过整个区间，因为部分折叠会让被吞掉
// 的那几个块再也无法按原戳召回（静默断链）。另有一条代数硬闸（用户拍板
// 2026-09-22）：区间内任一二代信封（G2 产物）→ 整段跳过，只允许 G1→G2。

import { describe, it, expect } from 'vitest'
import { findDistillRun, extractEnvelopeStamp, buildDistillRequest } from '../../../src/im/goal/distill.js'
import { envelopeGeneration, parseEnvelopeCovers } from '../../../src/im/system-agents/drive-coordinator.js'
import { DISTILL_AGENT_PROMPT } from '../../../src/im/prompts/index.js'
import type { ConversationTurn } from '../../../src/im/conversation-memory.js'

let n = 0
const nid = (p: string): string => `${p}-${n++}`

/** 一个 mem- 信封回合，形状与 buildCompressionEnvelope 的产出一致。 */
const envelope = (stamp: string, bodyTokens = 0): ConversationTurn => ({
  id: nid('mem'),
  role: 'user',
  content: [
    `#STAMP ${stamp}`,
    '#LAYER M1',
    '#STATUS PENDING',
    "#NOTE 对话序列经 raw-archive 保留；块召回：state_query({stamps:['" + stamp + "'}])",
    `[任务] 目标 ${stamp}`,
    `[结论] 结论 ${stamp} ${'x'.repeat(bodyTokens * 4)}`,
    '#END_BLOCK',
  ].join('\n'),
  at: n,
})

/** 一个二代信封（G2 产物）：带 #LINEAGE 血缘块，形状与 buildCompressionEnvelope 的产出一致。 */
const gen2Envelope = (stamp: string, sources: string[]): ConversationTurn => ({
  id: nid('mem'),
  role: 'user',
  content: [
    `#STAMP ${stamp}`,
    '#LAYER M1',
    '#STATUS PENDING',
    '#NOTE 块召回：state_query',
    `#LINEAGE gen=2 sources=${sources.length}`,
    ...sources.map((s) => `  - ${s} (gen=1): 任务=旧任务 ${s}；结论=旧结论 ${s}`),
    `[任务] 合并任务 ${stamp}`,
    `[结论] 合并结论 ${stamp}`,
    '#END_BLOCK',
  ].join('\n'),
  at: n,
})

const plain = (role: 'user' | 'assistant', prefix: string): ConversationTurn => ({
  id: nid(prefix), role, content: `${prefix} 正文`, at: n,
})

const FOUR = 4
const LOW_TOKENS = 1 // 让体量门槛形同虚设，专测块数/连续性逻辑

describe('extractEnvelopeStamp', () => {
  it('取首行的 #STAMP 值', () => {
    expect(extractEnvelopeStamp('#STAMP S-123-abc\n#LAYER M1\n正文')).toBe('S-123-abc')
  })

  it('只认首行——#LINEAGE 血缘块里的原戳不会被误取', () => {
    // 二代信封的 #LINEAGE 带原戳清单；若用全文多行匹配就会取错。
    const content = String(gen2Envelope('S-NEW', ['S-OLD-1', 'S-OLD-2']).content)
    expect(extractEnvelopeStamp(content)).toBe('S-NEW')
  })

  it('首行不是 #STAMP 时返回 undefined', () => {
    expect(extractEnvelopeStamp('#LAYER M1\n#STAMP S-1')).toBeUndefined()
    expect(extractEnvelopeStamp('普通用户消息')).toBeUndefined()
    expect(extractEnvelopeStamp('')).toBeUndefined()
  })

  it('#STAMP 行尾有多余内容时不匹配（要求整行就是戳）', () => {
    expect(extractEnvelopeStamp('#STAMP S-1 附加说明')).toBeUndefined()
  })
})

describe('findDistillRun — 触发条件', () => {
  const FOUR = 4
  const LOW_TOKENS = 100
  const thresholds = { minBlocks: FOUR, minTokens: LOW_TOKENS }

  it('连续 4 个信封且体量达标 → 返回区间、戳序列与拼接原文', () => {
    const turns = [
      envelope('S-1', 200), envelope('S-2', 200), envelope('S-3', 200), envelope('S-4', 200),
      plain('user', 'goal'), plain('assistant', 'a'),
    ]
    const run = findDistillRun(turns, thresholds)

    expect(run).toBeDefined()
    expect(run!.startIndex).toBe(0)
    expect(run!.endIndexExclusive).toBe(4)
    expect(run!.stamps).toEqual(['S-1', 'S-2', 'S-3', 'S-4'])
    expect(run!.tokens).toBeGreaterThan(100)
    // 拼接原文含每个块的完整内容（喂给 distiller 的输入）
    for (const s of ['S-1', 'S-2', 'S-3', 'S-4']) {
      expect(run!.text).toContain(`#STAMP ${s}`)
      expect(run!.text).toContain(`[结论] 结论 ${s}`)
    }
  })

  it('块数不足 → undefined（折叠要一次 LLM 调用，门槛不该太低）', () => {
    const turns = [envelope('S-1', 500), envelope('S-2', 500), envelope('S-3', 500), plain('user', 'goal')]
    expect(findDistillRun(turns, thresholds)).toBeUndefined()
  })

  it('体量不足 → undefined，即使块数够', () => {
    const turns = [envelope('S-1'), envelope('S-2'), envelope('S-3'), envelope('S-4')]
    expect(findDistillRun(turns, { minBlocks: FOUR, minTokens: 10_000_000 })).toBeUndefined()
  })

  it('恰好达标（边界含等号）', () => {
    const turns = [envelope('S-1', 100), envelope('S-2', 100), envelope('S-3', 100), envelope('S-4', 100)]
    const tokens = findDistillRun(turns, thresholds)!.tokens
    expect(findDistillRun(turns, { minBlocks: FOUR, minTokens: tokens })).toBeDefined()
    expect(findDistillRun(turns, { minBlocks: FOUR, minTokens: tokens + 1 })).toBeUndefined()
  })
})

describe('findDistillRun — 只认连续信封', () => {
  const FOUR = 4
  const LOW_TOKENS = 100
  const thresholds = { minBlocks: FOUR, minTokens: LOW_TOKENS }

  it('被非信封回合隔开的两段各 2 个 → 都不达标，undefined', () => {
    const turns = [
      envelope('S-1', 500), envelope('S-2', 500),
      plain('assistant', 'a'),
      envelope('S-3', 500), envelope('S-4', 500),
    ]
    expect(findDistillRun(turns, thresholds)).toBeUndefined()
  })

  it('隔开时不会把两段当成一个区间（否则会吞掉中间的 assistant 回合）', () => {
    const turns = [
      envelope('S-1', 500), envelope('S-2', 500), envelope('S-3', 500),
      plain('user', 'goal'),
      envelope('S-4', 500),
    ]
    // 前三个连续但不足 4；第 4 个孤立。都不该被选中。
    expect(findDistillRun(turns, thresholds)).toBeUndefined()
  })

  it('前面有非信封回合时，区间下标正确偏移', () => {
    const turns = [
      plain('user', 'user'), plain('assistant', 'a'),
      envelope('S-1', 300), envelope('S-2', 300), envelope('S-3', 300), envelope('S-4', 300),
    ]
    const run = findDistillRun(turns, thresholds)!
    expect(run.startIndex).toBe(2)
    expect(run.endIndexExclusive).toBe(6)
    expect(run.stamps).toEqual(['S-1', 'S-2', 'S-3', 'S-4'])
  })

  it('多个达标区间时取最旧的那个（与 G1 的最旧优先一致）', () => {
    const turns = [
      envelope('S-1', 300), envelope('S-2', 300), envelope('S-3', 300), envelope('S-4', 300),
      plain('assistant', 'a'),
      envelope('S-5', 300), envelope('S-6', 300), envelope('S-7', 300), envelope('S-8', 300),
    ]
    const run = findDistillRun(turns, thresholds)!
    expect(run.stamps).toEqual(['S-1', 'S-2', 'S-3', 'S-4'])
  })

  it('超过 4 个连续信封时整段作为一个区间（N→1，N 可以大于 4）', () => {
    const turns = [
      envelope('S-1', 100), envelope('S-2', 100), envelope('S-3', 100),
      envelope('S-4', 100), envelope('S-5', 100), envelope('S-6', 100),
    ]
    const run = findDistillRun(turns, thresholds)!
    expect(run.stamps).toHaveLength(6)
    expect(run.endIndexExclusive - run.startIndex).toBe(6)
  })

  it('没有信封 → undefined', () => {
    expect(findDistillRun([plain('user', 'user'), plain('assistant', 'a')], thresholds)).toBeUndefined()
    expect(findDistillRun([], thresholds)).toBeUndefined()
  })
})

describe('findDistillRun — 血缘完整性', () => {
  const FOUR = 4
  const LOW_TOKENS = 100
  const thresholds = { minBlocks: FOUR, minTokens: LOW_TOKENS }

  it('区间内有信封缺戳 → 跳过该区间（部分折叠会造成静默断链）', () => {
    const broken: ConversationTurn = { id: nid('mem'), role: 'user', content: '#LAYER M1\n[结论] 没有戳', at: n }
    const turns = [envelope('S-1', 500), broken, envelope('S-3', 500), envelope('S-4', 500)]
    expect(findDistillRun(turns, thresholds)).toBeUndefined()
  })

  it('缺戳区间被跳过后，后面完整的区间仍能被选中', () => {
    const broken: ConversationTurn = { id: nid('mem'), role: 'user', content: '没有戳', at: n }
    const turns = [
      envelope('S-1', 300), broken, envelope('S-3', 300), envelope('S-4', 300),
      plain('assistant', 'a'),
      envelope('S-5', 300), envelope('S-6', 300), envelope('S-7', 300), envelope('S-8', 300),
    ]
    const run = findDistillRun(turns, thresholds)!
    expect(run.stamps).toEqual(['S-5', 'S-6', 'S-7', 'S-8'])
  })

  it('goal- 续跑提醒不是信封，不会被卷进区间', () => {
    const turns = [
      envelope('S-1', 300), envelope('S-2', 300), envelope('S-3', 300),
      plain('user', 'goal'), // id 前缀 goal-，role user
      envelope('S-4', 300),
    ]
    expect(findDistillRun(turns, thresholds)).toBeUndefined()
  })
})

describe('findDistillRun — 代数硬闸（只允许 G1→G2，禁止 G2→G3）', () => {
  const thresholds = { minBlocks: 4, minTokens: 100 }

  it('区间内任一二代信封 → 整个区间跳过（不部分折叠）', () => {
    const turns = [
      envelope('S-1', 300), envelope('S-2', 300),
      gen2Envelope('S-3', ['S-a', 'S-b']),
      envelope('S-4', 300),
    ]
    expect(findDistillRun(turns, thresholds)).toBeUndefined()
  })

  it('含二代信封的区间被跳过后，后面全一代的区间仍能被选中', () => {
    const turns = [
      envelope('S-1', 300), envelope('S-2', 300),
      gen2Envelope('S-3', ['S-a', 'S-b']),
      envelope('S-4', 300),
      plain('assistant', 'a'),
      envelope('S-5', 300), envelope('S-6', 300), envelope('S-7', 300), envelope('S-8', 300),
    ]
    const run = findDistillRun(turns, thresholds)!
    expect(run.stamps).toEqual(['S-5', 'S-6', 'S-7', 'S-8'])
  })
})

describe('envelopeGeneration — 世代判据', () => {
  it('无 #LINEAGE 行 → 一代（G1 直接压缩产物）', () => {
    expect(envelopeGeneration(String(envelope('S-1').content))).toBe(1)
  })

  it('有 #LINEAGE 行 → 二代（G2 折叠产物）', () => {
    expect(envelopeGeneration(String(gen2Envelope('S-2', ['S-a']).content))).toBe(2)
  })
})

describe('parseEnvelopeCovers — 戳→内容一行式', () => {
  it('取 [任务] 与 [结论] 拼成一行', () => {
    expect(parseEnvelopeCovers(String(envelope('S-1').content))).toBe('任务=目标 S-1；结论=结论 S-1')
  })

  it('超长字段截断（任务 60 / 结论 80），防 #LINEAGE 清单被撑爆', () => {
    const long = 'x'.repeat(200)
    const covers = parseEnvelopeCovers(`#STAMP S-1\n[任务] ${long}\n[结论] ${long}\n#END_BLOCK`)
    expect(covers).toContain(`任务=${'x'.repeat(60)}…`)
    expect(covers).toContain(`结论=${'x'.repeat(80)}…`)
    expect(covers.length).toBeLessThan(170)
  })

  it('两行都缺 → 兜底文案', () => {
    expect(parseEnvelopeCovers('#STAMP S-1\n#END_BLOCK')).toBe('（信封无任务/结论行）')
  })
})

describe('buildDistillRequest — 与 distill-agent.md 文档逐字对应', () => {
  const run = {
    startIndex: 0, endIndexExclusive: 2,
    stamps: ['S-aaa', 'S-bbb'],
    text: '#STAMP S-aaa\n[结论] 甲\n#END_BLOCK\n\n#STAMP S-bbb\n[结论] 乙\n#END_BLOCK',
    tokens: 50,
  }

  it('是一条 role:user 消息，头部三行 + 任务说明 + 空行 + 区间原文', () => {
    const req = buildDistillRequest({ run, condition: '写出 a.txt 与 b.txt' })
    expect(req.role).toBe('user')
    const lines = String(req.content).split('\n')
    expect(lines[0]).toBe('#GOAL_CONDITION 写出 a.txt 与 b.txt')
    expect(lines[1]).toBe('#BLOCKS 2')
    expect(lines[2]).toBe('#SOURCE_STAMPS S-aaa S-bbb')
    expect(lines[3]).toContain('合并成一个 11 字段 CuratedMemory 对象')
    expect(lines[4]).toContain('只输出纯 JSON')
    expect(lines[5]).toBe('')
    expect(lines.slice(6).join('\n')).toBe(run.text)
  })

  it('区间原文逐字进请求（distiller 的输入就是全部证据，它没有工具可查）', () => {
    const content = String(buildDistillRequest({ run, condition: 'c' }).content)
    expect(content).toContain('[结论] 甲')
    expect(content).toContain('[结论] 乙')
  })

  it('提示词里记载的请求形状与本函数产出一致（改一处必须同步另一处）', () => {
    expect(DISTILL_AGENT_PROMPT).toContain('#GOAL_CONDITION <目标条件原文>')
    expect(DISTILL_AGENT_PROMPT).toContain('#BLOCKS <N>')
    expect(DISTILL_AGENT_PROMPT).toContain('#SOURCE_STAMPS S-aaa S-bbb S-ccc')
    expect(DISTILL_AGENT_PROMPT).toContain('请把下面这些相邻的已压缩记忆块合并成一个 11 字段 CuratedMemory 对象。')
    expect(DISTILL_AGENT_PROMPT).toContain('只输出纯 JSON，不要围栏、不要解释。')
  })

  it('提示词明确要求不得把原戳抄进字段（血缘由运行时记 _sourceStamps）', () => {
    expect(DISTILL_AGENT_PROMPT).toContain('_sourceStamps')
    expect(DISTILL_AGENT_PROMPT).toMatch(/不要把.*戳抄进任何字段/)
  })
})
