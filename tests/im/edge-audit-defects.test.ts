// 审计缺陷回归测试（2026-09-13 拍板修复后）——断言缺陷已消除。

import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ConversationMemory } from '../../src/im/conversation-memory.js'
import { Databus, stampOfToolTurn } from '../../src/im/databus.js'
import { SessionStore } from '../../src/im/session/session-store.js'
import { foldOversizeToolTurns } from '../../src/im/tools/history-tool-table.js'
import { createDatabusQueryTool } from '../../src/im/tools/databus-query.js'
import { appendCanonicalTurn } from '../../src/im/turn.js'
import type { ConversationTurn } from '../../src/im/conversation-memory.js'
import type { ToolTurn } from '../../src/im/databus.js'

const toolTurn = (id: string, content: string): ConversationTurn =>
  ({ id, role: 'tool', toolCallId: `tc-${id}`, content, sourceAgentId: 'main', at: Date.now() } as ToolTurn)

describe('audit defect regressions (2026-09-13 fixes)', () => {
  it('A: fold is idempotent — already-folded turn is not re-folded', async () => {
    const conv = new ConversationMemory()
    const bus = new Databus()
    const full = 'HEAD_KEEP_' + 'X'.repeat(5000) + 'MIDDLE_' + 'Z'.repeat(2000) + '_TAIL_KEEP'
    appendCanonicalTurn(conv, bus, toolTurn('big', full))
    for (let i = 0; i < 24; i += 1) {
      appendCanonicalTurn(conv, bus, toolTurn(`s${i}`, `small-${i}`))
    }

    const r1 = foldOversizeToolTurns(conv, { keepRecent: 5, resultTokenCeiling: 100 })
    expect(r1?.folded).toBeGreaterThanOrEqual(1)

    const after1 = String((conv.turns()[0] as { content: string }).content)
    const markers1 = (after1.match(/戳 /g) ?? []).length
    expect(markers1).toBe(1)
    expect(after1).toContain('HEAD_KEEP_')
    expect(after1).toContain('TAIL_KEEP')
    const stamp1 = stampOfToolTurn(bus.turns()[0]!)

    // 再跑 10 轮：不得再折叠、不得堆标记、不得吞尾
    for (let k = 0; k < 10; k += 1) {
      const r = foldOversizeToolTurns(conv, { keepRecent: 5, resultTokenCeiling: 100 })
      expect(r?.folded ?? 0).toBe(0)
    }
    const after10 = String((conv.turns()[0] as { content: string }).content)
    expect((after10.match(/戳 /g) ?? []).length).toBe(1)
    expect(after10).toContain('TAIL_KEEP')
    expect(after10).toBe(after1)

    // 戳仍可召回全文
    const dq = createDatabusQueryTool()
    const recall = await dq.execute({ stamp: stamp1, reason: 'p' }, { databus: bus } as never)
    const parsed = JSON.parse(String(recall)) as Array<{ content: string }>
    expect(parsed.length).toBe(1)
    expect(parsed[0]!.content).toContain('HEAD_KEEP_')
  })

  it('B: rewrite captures snapshot at enqueue — no duplicate rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-race-'))
    try {
      const store = new SessionStore({ basePath: dir })
      await store.writeInfo({
        id: 's1', title: 't', workingAgentId: 'main',
        createdAt: Date.now(), lastActiveAt: Date.now(),
        turnCount: 0, layer: 'M0', snapshotExpired: false,
      })

      let chain: Promise<void> = Promise.resolve()
      const enqueue = (job: () => Promise<void>): Promise<void> => {
        const run = chain.then(job)
        chain = run.catch(() => {})
        return run
      }
      const persistTurn = async (t: ConversationTurn): Promise<void> => {
        await enqueue(async () => { await store.appendConversationTurn('s1', t) })
      }
      // 与生产 session-manager 同语义：入队时冻结
      const rewriteAtEnqueue = (conv: ConversationMemory): Promise<void> => {
        const snapshot = [...conv.turns()]
        return enqueue(async () => { await store.rewriteConversation('s1', snapshot) })
      }

      const conv = new ConversationMemory()
      const t1 = { id: 't1', role: 'user', content: 'a', at: 1 } as ConversationTurn
      conv.append(t1)
      await persistTurn(t1)

      const t2 = { id: 't2', role: 'user', content: 'b', at: 2 } as ConversationTurn
      const rp = rewriteAtEnqueue(conv) // 捕获时内存只有 t1
      conv.append(t2)
      const p2 = persistTurn(t2)
      await Promise.all([rp, p2])

      const ids = readFileSync(join(dir, 's1', 'conversation.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id)
      // 无重复：t1 由 rewrite 写入，t2 由 append 追加
      expect(ids).toEqual(['t1', 't2'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('C: fork copySnapshot copies state/ — envelope stamp recallable in fork', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-fork-'))
    try {
      const store = new SessionStore({ basePath: dir })
      await store.writeInfo({
        id: 'src', title: 's', workingAgentId: 'main',
        createdAt: Date.now(), lastActiveAt: Date.now(),
        turnCount: 0, layer: 'M0', snapshotExpired: false,
      })
      await store.appendConversationTurn('src', {
        id: 'mem-abc', role: 'user',
        content: '#STAMP S-1\n#LAYER M1\n#END_BLOCK', at: 1,
      } as ConversationTurn)
      mkdirSync(join(dir, 'src', 'state'), { recursive: true })
      writeFileSync(join(dir, 'src', 'state', 'curatedMemory.jsonl'),
        JSON.stringify({ task_goal: 'x', _stamp: 'S-1' }) + '\n')

      await store.copySnapshot('src', 'dst')
      expect(existsSync(join(dir, 'dst', 'conversation.jsonl'))).toBe(true)
      expect(existsSync(join(dir, 'dst', 'state', 'curatedMemory.jsonl'))).toBe(true)
      const curated = readFileSync(join(dir, 'dst', 'state', 'curatedMemory.jsonl'), 'utf8')
      expect(curated).toContain('S-1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
