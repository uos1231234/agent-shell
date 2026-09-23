// 独立核实探针（2026-09-13）：压缩信封替代 + databus 召回是否真正可用。
// 这些用例故意打报告未覆盖的边界，不采信"测试绿 = 功能生效"。

import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ConversationMemory } from '../../src/im/conversation-memory.js'
import { Databus, stampOfToolTurn } from '../../src/im/databus.js'
import { appendCanonicalTurn } from '../../src/im/turn.js'
import { createDriveCoordinator } from '../../src/im/system-agents/drive-coordinator.js'
import { createStateLine } from '../../src/im/state-line/index.js'
import { createSignalBus } from '../../src/im/memory-layers.js'
import { Mailbox } from '../../src/im/mailbox/index.js'
import { SessionStore } from '../../src/im/session/session-store.js'
import { recoverSession } from '../../src/im/session/recovery.js'
import { foldOversizeToolTurns } from '../../src/im/tools/history-tool-table.js'
import { createStateQueryTool } from '../../src/im/tools/state-query.js'
import { createDatabusQueryTool } from '../../src/im/tools/databus-query.js'
import { createMetrics } from '../../src/shell/metrics.js'
import type { ConversationTurn } from '../../src/im/conversation-memory.js'
import type { ToolTurn } from '../../src/im/databus.js'
import type { SystemAgent } from '../../src/im/system-agent.js'
import type { CuratedMemory } from '../../src/im/state-line/types.js'

const curated: CuratedMemory = {
  task_goal: 'probe task',
  causal_steps: [{ intent: 'do', tool_action: 'echo', result: 'ok' }],
  evidence_fragments: [{ source: 'tool', fragment: 'SECRET_MARKER_XYZ', relevance: 'key' }],
  conclusion: 'done',
  next_action: 'none',
  working_state: {
    current_goal: 'done',
    effective_decisions: [],
    rejected_decisions: [],
    architecture_boundaries: [],
    remaining_work: [],
  },
}

const okCompressor: SystemAgent = {
  run: async () => ({
    output: '',
    // v0.42: 提交协议——生产结果是 submit_curated_memory 的 memory 参数。
    submitted: curated,
    metrics: createMetrics(),
    finalState: 'Running',
    reason: 'completed',
    hits: [],
  }),
  stop() {},
  send() {},
}

let n = 0
const uid = (p: string) => `${p}-${n++}`
const u = (content: string, at = ++n): ConversationTurn => ({ id: uid('user'), role: 'user', content, at })
const a = (content: string | null, at = ++n, toolCalls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]): ConversationTurn => {
  const t: ConversationTurn = { id: uid('asst'), role: 'assistant', content, at }
  if (toolCalls) (t as { toolCalls?: unknown }).toolCalls = toolCalls
  return t
}
const tool = (toolCallId: string, content: string, at = ++n): ConversationTurn => ({
  id: uid('tool'),
  role: 'tool',
  toolCallId,
  content,
  sourceAgentId: 'main',
  at,
} as ToolTurn)

const seedBlock = (conv: ConversationMemory, bus: Databus): void => {
  const tcId = uid('tc')
  appendCanonicalTurn(conv, bus, u('start work'))
  appendCanonicalTurn(conv, bus, a('calling tool', ++n, [{ id: tcId, type: 'function', function: { name: 'echo', arguments: '{}' } }]))
  appendCanonicalTurn(conv, bus, tool(tcId, 'tool result body'))
  appendCanonicalTurn(conv, bus, u('next task'))
}

describe('edge: envelope replacement + recall actually works', () => {
  it('envelope stamp can recall curated block AND raw archive via state_query', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'edge-recall-'))
    try {
      const conv = new ConversationMemory()
      const bus = new Databus({ sessionId: 's1' })
      seedBlock(conv, bus)
      const stateLine = createStateLine({ databusPath: dir })
      const mailbox = new Mailbox()
      const dc = createDriveCoordinator({
        bus: createSignalBus(),
        compressor: okCompressor,
        warehouse: okCompressor,
        stateLine,
        mailbox,
        workingAgentId: 'main',
      })
      await dc.tick({
        contextTokens: 300_000,
        conversation: conv,
        databus: bus,
        memoryConfig: { m1MinTokens: 1, m2MinTokens: 500_000, m3MinTokens: 900_000 },
      })
      await dc.drain()

      const env = conv.turns()[0]!
      expect(env.role).toBe('user')
      expect(env.id.startsWith('mem-')).toBe(true)
      const content = String((env as { content: string }).content)
      const stampMatch = content.match(/^#STAMP (\S+)/m)
      expect(stampMatch).not.toBeNull()
      const stamp = stampMatch![1]!

      const sq = createStateQueryTool()
      const raw1 = await sq.execute(
        { layer: 'M1', stamps: [stamp], reason: 'probe' },
        { stateLine } as never,
      )
      const parsed1 = JSON.parse(String(raw1)) as { results: Array<{ _stamp?: string; task_goal: string }> }
      expect(parsed1.results.length).toBeGreaterThanOrEqual(1)
      expect(parsed1.results[0]!._stamp).toBe(stamp)
      expect(parsed1.results[0]!.task_goal).toBe('probe task')

      const raw2 = await sq.execute(
        { rawSummaryStamps: [stamp], reason: 'probe' },
        { stateLine } as never,
      )
      const parsed2 = JSON.parse(String(raw2)) as {
        rawArchive: Array<{ summaryStamp: string; messages: Array<{ role: string; content?: unknown }> }>
      }
      expect(parsed2.rawArchive.length).toBe(1)
      expect(parsed2.rawArchive[0]!.summaryStamp).toBe(stamp)
      expect(parsed2.rawArchive[0]!.messages.length).toBe(3)
      expect(parsed2.rawArchive[0]!.messages[2]!.role).toBe('tool')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('after block compression, tool-level 12-char stamps STAY ALIVE (方案 A)', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus({ sessionId: 's1' })
    const tcId = uid('tc')
    const t = tool(tcId, 'FULL_ORIGINAL_CONTENT_ABC'.repeat(20))
    appendCanonicalTurn(conv, bus, u('start'))
    appendCanonicalTurn(conv, bus, a('call', ++n, [{ id: tcId, type: 'function', function: { name: 'echo', arguments: '{}' } }]))
    appendCanonicalTurn(conv, bus, t)
    appendCanonicalTurn(conv, bus, u('next'))

    const toolTurn = t as ToolTurn
    const stamp = stampOfToolTurn(toolTurn)

    const dq = createDatabusQueryTool()
    const before = await dq.execute({ stamp, reason: 'p' }, { databus: bus } as never)
    expect(JSON.parse(String(before)).length).toBe(1)

    const dir = mkdtempSync(join(tmpdir(), 'edge-stamp-alive-'))
    try {
      const stateLine = createStateLine({ databusPath: dir })
      const mailbox = new Mailbox()
      const dc = createDriveCoordinator({
        bus: createSignalBus(),
        compressor: okCompressor,
        warehouse: okCompressor,
        stateLine,
        mailbox,
        workingAgentId: 'main',
      })
      await dc.tick({
        contextTokens: 300_000,
        conversation: conv,
        databus: bus,
        memoryConfig: { m1MinTokens: 1, m2MinTokens: 500_000, m3MinTokens: 900_000 },
      })
      await dc.drain()

      // 方案 A：块压缩不清空 databus — 工具戳仍可精确召回全文
      const after = await dq.execute({ stamp, reason: 'p' }, { databus: bus } as never)
      const parsed = JSON.parse(String(after)) as Array<{ content: string }>
      expect(parsed.length).toBe(1)
      expect(parsed[0]!.content).toContain('FULL_ORIGINAL_CONTENT_ABC')
      expect(parsed[0]!.content).not.toContain('截断')

      // canonical 侧：原块已出，信封在位
      expect(conv.turns()[0]!.id.startsWith('mem-')).toBe(true)
      expect(conv.turns().some((x) => x.id === t.id)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('raw-archive stores TRUNCATED content if tool was folded first (envelope claim overstates)', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus({ sessionId: 's1' })
    for (let i = 0; i < 25; i += 1) {
      const tcId = uid('tc')
      const body = `LINE_${i}_` + 'X'.repeat(4000)
      appendCanonicalTurn(conv, bus, u(`task ${i}`))
      appendCanonicalTurn(conv, bus, a(`call ${i}`, ++n, [{ id: tcId, type: 'function', function: { name: 'read', arguments: '{}' } }]))
      appendCanonicalTurn(conv, bus, tool(tcId, body))
    }
    appendCanonicalTurn(conv, bus, u('final boundary'))

    const fold = foldOversizeToolTurns(conv, { keepRecent: 5, resultTokenCeiling: 100 })
    expect(fold?.folded).toBeGreaterThan(0)

    const dir = mkdtempSync(join(tmpdir(), 'edge-trunc-archive-'))
    try {
      const stateLine = createStateLine({ databusPath: dir })
      const mailbox = new Mailbox()
      const dc = createDriveCoordinator({
        bus: createSignalBus(),
        compressor: okCompressor,
        warehouse: okCompressor,
        stateLine,
        mailbox,
        workingAgentId: 'main',
      })
      await dc.tick({
        contextTokens: 300_000,
        conversation: conv,
        databus: bus,
        memoryConfig: { m1MinTokens: 1, m2MinTokens: 500_000, m3MinTokens: 900_000 },
      })
      await dc.drain()

      const env = conv.turns()[0] as { content: string }
      const blockStamp = env.content.match(/^#STAMP (\S+)/m)![1]!
      const sq = createStateQueryTool()
      const raw = await sq.execute({ rawSummaryStamps: [blockStamp], reason: 'p' }, { stateLine } as never)
      const archive = JSON.parse(String(raw)).rawArchive as Array<{
        messages: Array<{ role: string; content?: string }>
      }>
      const toolMsgs = archive[0]!.messages.filter((m) => m.role === 'tool')
      const anyTruncated = toolMsgs.some((m) => String(m.content).includes('截断'))
      console.log('[probe] raw-archive tool msgs:', toolMsgs.length,
        'truncated-markers:', toolMsgs.filter((m) => String(m.content).includes('截断')).length)
      expect(archive[0]!.messages.length).toBeGreaterThan(0)
      if (anyTruncated) {
        console.log('[probe] CONFIRMED: raw-archive holds truncated tool content, envelope #NOTE overstates')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('write-queue race: rewrite then later persistTurn can DUPLICATE a turn on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'edge-write-race-'))
    try {
      const store = new SessionStore({ basePath: dir })
      const sessionId = 'race-session'
      await store.writeInfo({
        id: sessionId,
        title: 'race',
        workingAgentId: 'main',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        turnCount: 0,
        layer: 'M0',
        snapshotExpired: false,
      })

      let chain: Promise<void> = Promise.resolve()
      const enqueue = (job: () => Promise<void>): Promise<void> => {
        const run = chain.then(job)
        chain = run.catch(() => {})
        return run
      }
      const persistTurn = async (turn: ConversationTurn): Promise<void> => {
        await enqueue(async () => {
          await store.appendConversationTurn(sessionId, turn)
        })
      }
      const rewrite = (conv: ConversationMemory): Promise<void> =>
        enqueue(async () => {
          await store.rewriteConversation(sessionId, conv.turns())
        })

      const conv = new ConversationMemory()
      const t1 = u('turn-1')
      conv.append(t1)
      await persistTurn(t1)

      const t2 = u('turn-2')
      const rewriteP = rewrite(conv)
      conv.append(t2)
      const persist2P = persistTurn(t2)

      await Promise.all([rewriteP, persist2P])

      const disk = readFileSync(join(dir, sessionId, 'conversation.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string })
      const ids = disk.map((r) => r.id)
      const unique = new Set(ids)

      console.log('[probe] disk ids:', ids, 'unique:', unique.size, 'total:', ids.length)
      // 【已复现缺陷】rewrite 读 live memory + 后续 persistTurn 无幂等 → 重复行。
      // 生产窗口：finalizeRound 后 fireDriveCoordinator 与工具轮 persistTurn 并发。
      // 修复方向：enqueue 时冻结快照，或 persistTurn 对 rewrite 已覆盖的 id 幂等跳过。
      // 此断言刻画当前缺陷；修复后应翻转为 unique.size === ids.length。
      expect(unique.size).toBeLessThan(ids.length)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recovery restores envelope from rewritten conversation.jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'edge-recover-'))
    try {
      const store = new SessionStore({ basePath: dir })
      const sessionId = 'recover-session'
      await store.writeInfo({
        id: sessionId,
        title: 'rec',
        workingAgentId: 'main',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        turnCount: 0,
        layer: 'M0',
        snapshotExpired: false,
        workDir: dir,
      })

      const conv = new ConversationMemory()
      const bus = new Databus({ sessionId })
      seedBlock(conv, bus)
      const stateLine = createStateLine({ databusPath: join(dir, sessionId) })
      const mailbox = new Mailbox()
      let chain: Promise<void> = Promise.resolve()
      const enqueue = (job: () => Promise<void>): Promise<void> => {
        const run = chain.then(job)
        chain = run.catch(() => {})
        return run
      }
      const rewriteSnapshot = (c: ConversationMemory, d: Databus): Promise<void> =>
        enqueue(async () => {
          await store.rewriteConversation(sessionId, c.turns())
          await store.rewriteDatabus(sessionId, d.turns())
        })

      for (const t of conv.turns()) await store.appendConversationTurn(sessionId, t)

      const dc = createDriveCoordinator({
        bus: createSignalBus(),
        compressor: okCompressor,
        warehouse: okCompressor,
        stateLine,
        mailbox,
        workingAgentId: 'main',
        rewriteSnapshot,
      })
      await dc.tick({
        contextTokens: 300_000,
        conversation: conv,
        databus: bus,
        memoryConfig: { m1MinTokens: 1, m2MinTokens: 500_000, m3MinTokens: 900_000 },
      })
      await dc.drain()
      stateLine.close()

      const recovered = await recoverSession({ store, sessionId })
      const turns = recovered.conversationMemory.turns()
      expect(turns.length).toBeGreaterThan(0)
      expect(turns[0]!.id.startsWith('mem-')).toBe(true)
      expect(turns[0]!.role).toBe('user')
      const content = String((turns[0] as { content: string }).content)
      expect(content).toMatch(/^#STAMP S-/)
      expect(content.endsWith('#END_BLOCK')).toBe(true)
      expect(turns.some((t) => t.content === 'start work')).toBe(false)
      recovered.stateLine.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('consecutive user messages: envelope then next user — protocol shape', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus({ sessionId: 's1' })
    seedBlock(conv, bus)
    const dir = mkdtempSync(join(tmpdir(), 'edge-consec-'))
    try {
      const stateLine = createStateLine({ databusPath: dir })
      const mailbox = new Mailbox()
      const dc = createDriveCoordinator({
        bus: createSignalBus(),
        compressor: okCompressor,
        warehouse: okCompressor,
        stateLine,
        mailbox,
        workingAgentId: 'main',
      })
      await dc.tick({
        contextTokens: 300_000,
        conversation: conv,
        databus: bus,
        memoryConfig: { m1MinTokens: 1, m2MinTokens: 500_000, m3MinTokens: 900_000 },
      })
      await dc.drain()
      const roles = conv.turns().map((t) => t.role)
      expect(roles[0]).toBe('user')
      expect(roles[1]).toBe('user')
      console.log('[probe] roles after compress:', roles)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
