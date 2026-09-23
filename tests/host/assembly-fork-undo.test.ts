// v0.29 Wave B2 — assembly 的 session.fork / session.undo 宿主接线测试。
//
// fork：源快照零污染、副本 conversation.jsonl 与源逐行一致、副本可 open
//（recoverSession 按副本快照重建）。
// undo：撤回逻辑在 src/host/session-undo.ts——这里经 gate 命令驱动真实
// runtime（mock 第一轮 write + 直接经 appendCanonicalTurn/persistTurn 造假
// 第二块——undo 的契约只消费 canonical 状态，不关心回合的来源）：
//   - N=1/2 撤回正确（canonical/journal/databus 三处一致）
//   - 撤回范围含已压缩归档 → 拒绝（用真实 stateLine.rawArchive.append 造记录）
//   - journal 重写后 recoverSession 读回一致

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { createHostAssembly } from '../../src/host/assembly.js'
import type { HostAssembly } from '../../src/host/assembly.js'
import { SessionStore } from '../../src/im/session/index.js'
import type { SessionHandle, SessionInfo } from '../../src/im/session/types.js'
import type { ConversationTurn } from '../../src/im/conversation-memory.js'
import { appendCanonicalTurn } from '../../src/im/turn.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'host-fork-undo-test-'))

afterAll(async () => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

const boot = async (name: string): Promise<HostAssembly> =>
  createHostAssembly({ dataDir: join(tmpRoot, name, 'sessions'), mock: true })

const newSession = async (local: HostAssembly, wsDir: string): Promise<SessionHandle> => {
  mkdirSync(wsDir, { recursive: true })
  return local.handlers.session.create({ workDir: wsDir })
}

/** 跑一轮 mock prompt（write hello.txt，审批经 gate 闭环）——与 assembly.test.ts 同款。 */
const runMockPrompt = async (local: HostAssembly, sessionId: string): Promise<void> => {
  const approvalIds: string[] = []
  local.gate.on('approval', (req) => {
    if (req.kind === 'approval') approvalIds.push(req.requestId)
  })
  const pending = local.handlers.runPrompt(sessionId, 'hi')
  await vi.waitFor(() => expect(approvalIds.length).toBeGreaterThan(0), { timeout: 5000 })
  local.gate.resolve(approvalIds[0]!, 'approved')
  const result = await pending
  expect(result.reason).toBe('completed')
}

/** 伪造一个完整任务块（user + assistant(工具调用) + tool）+ 块边界 user。 */
const fabricateBlock = async (handle: SessionHandle, blockIndex: number): Promise<void> => {
  const rt = handle.runtime
  const at = Date.now()
  const turns: ConversationTurn[] = [
    { id: `u${blockIndex}`, role: 'user', content: `task ${blockIndex}`, at },
    {
      id: `u${blockIndex}-a`,
      role: 'assistant',
      content: 'working',
      toolCalls: [
        { id: `u${blockIndex}-c`, type: 'function', function: { name: 'write', arguments: '{"path":"x.txt"}' } },
      ],
      at,
    },
    { id: `u${blockIndex}-t`, role: 'tool', toolCallId: `u${blockIndex}-c`, content: 'ok', sourceAgentId: 'main', at, toolName: 'write' },
  ]
  for (const t of turns) {
    appendCanonicalTurn(rt.conversationMemory, rt.databus, t)
    await rt.persistTurn(t)
  }
  // 块边界（下一个 user）——本块的 endIndexExclusive 依据。
  const boundary: ConversationTurn = { id: `u${blockIndex}-next`, role: 'user', content: 'next', at }
  appendCanonicalTurn(rt.conversationMemory, rt.databus, boundary)
  await rt.persistTurn(boundary)
}

const jsonlLines = (path: string): string[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '')
    : []

// ---------------------------------------------------------------------------
// session.fork
// ---------------------------------------------------------------------------

describe('assembly session.fork (v0.29 Wave B2)', () => {
  it('fork 后副本 conversation.jsonl 与源逐行一致、源零污染、新会话可 open', async () => {
    const local = await boot('fork')
    try {
      const ws = join(tmpRoot, 'fork', 'ws')
      const handle = await newSession(local, ws)
      await runMockPrompt(local, handle.info.id)

      const store = new SessionStore({ basePath: join(tmpRoot, 'fork', 'sessions') })
      const srcConvBefore = jsonlLines(store.conversationFile(handle.info.id))
      const srcDbBefore = jsonlLines(store.databusFile(handle.info.id))
      expect(srcConvBefore.length).toBeGreaterThan(0)

      const forked = (await local.gate.command({
        kind: 'session.fork',
        sessionId: handle.info.id,
      })) as SessionInfo

      expect(forked.id).not.toBe(handle.info.id)
      expect(forked.title).toBe(`${handle.info.title} (fork)`)
      expect(forked.workDir).toBe(ws)

      // 副本快照逐行一致（copyFile 字节级复制）。
      expect(jsonlLines(store.conversationFile(forked.id))).toEqual(srcConvBefore)
      expect(jsonlLines(store.databusFile(forked.id))).toEqual(srcDbBefore)

      // 源零污染。源无 state/ 时 fork 也无（copyDirIfExists no-op）。
      expect(jsonlLines(store.conversationFile(handle.info.id))).toEqual(srcConvBefore)
      expect(jsonlLines(store.databusFile(handle.info.id))).toEqual(srcDbBefore)
      expect(existsSync(join(tmpRoot, 'fork', 'sessions', forked.id, 'state'))).toBe(false)

      // 副本可 open；history 与源当前 canonical 等长（副本无 state/ → 全量回内存）。
      const reopened = await local.handlers.session.open(forked.id)
      const forkedTurns = await local.handlers.session.history(forked.id)
      const srcTurns = await local.handlers.session.history(handle.info.id)
      expect(forkedTurns.length).toBe(srcTurns.length)
      expect(reopened.info.id).toBe(forked.id)
    } finally {
      await local.shutdown()
    }
  })

  it('fork 未知会话 → 干净错误', async () => {
    const local = await boot('fork-unknown')
    try {
      await expect(local.gate.command({ kind: 'session.fork', sessionId: 'ghost' })).rejects.toThrow(
        /Session not found: ghost/,
      )
    } finally {
      await local.shutdown()
    }
  })
})

// ---------------------------------------------------------------------------
// session.undo
// ---------------------------------------------------------------------------

describe('assembly session.undo (v0.29 Wave B2)', () => {
  it('N=1：撤回尾部块，canonical/journal/databus 三处一致；recoverSession 读回一致', async () => {
    const local = await boot('undo-1')
    try {
      const handle = await newSession(local, join(tmpRoot, 'undo-1', 'ws'))
      await runMockPrompt(local, handle.info.id)
      await fabricateBlock(handle, 2) // u2,a2,t2 + 边界 u2-next → 两个完整块

      const store = new SessionStore({ basePath: join(tmpRoot, 'undo-1', 'sessions') })
      // mock 轮 canonical = u, a(工具调用), t, a(收尾文本) = 4 条 + 伪造块 4 条 = 8。
      expect(jsonlLines(store.conversationFile(handle.info.id))).toHaveLength(8)
      expect(jsonlLines(store.databusFile(handle.info.id))).toHaveLength(2)

      const receipt = (await local.gate.command({
        kind: 'session.undo',
        sessionId: handle.info.id,
        blocks: 1,
      })) as { blocks: number; evicted: number }
      expect(receipt).toEqual({ blocks: 1, evicted: 3 })

      // 内存 canonical：块 2（u2..u2-t）被撤，尾部边界 user 保留。
      const live = (await local.handlers.session.history(handle.info.id)).map((t) => t.id)
      expect(live).toEqual([
        expect.any(String), expect.any(String), expect.any(String), expect.any(String), // mock 轮 u,a,t,a
        'u2-next',
      ])

      // journal 重写：只删撤回的 id，更早历史保留。
      expect(jsonlLines(store.conversationFile(handle.info.id)).map((l) => JSON.parse(l).id)).toEqual([
        expect.any(String), expect.any(String), expect.any(String), expect.any(String), 'u2-next',
      ])
      expect(jsonlLines(store.databusFile(handle.info.id)).map((l) => JSON.parse(l).id)).toHaveLength(1)

      // recoverSession 读回一致：close（去 attach）→ history 重开。
      await local.handlers.session.close(handle.info.id)
      const recovered = (await local.handlers.session.history(handle.info.id)).map((t) => t.id)
      expect(recovered).toEqual(live)
    } finally {
      await local.shutdown()
    }
  })

  it('N=2：两块全撤，journal 只剩边界 user；databus 清空后恢复读回一致', async () => {
    const local = await boot('undo-2')
    try {
      const handle = await newSession(local, join(tmpRoot, 'undo-2', 'ws'))
      await runMockPrompt(local, handle.info.id)
      await fabricateBlock(handle, 2)

      const receipt = (await local.gate.command({
        kind: 'session.undo',
        sessionId: handle.info.id,
        blocks: 2,
      })) as { blocks: number; evicted: number }
      // mock 轮块 4 条 + 伪造块 3 条 = 7。
      expect(receipt).toEqual({ blocks: 2, evicted: 7 })

      const live = (await local.handlers.session.history(handle.info.id)).map((t) => t.id)
      expect(live).toEqual(['u2-next'])

      await local.handlers.session.close(handle.info.id)
      const recovered = (await local.handlers.session.history(handle.info.id)).map((t) => t.id)
      expect(recovered).toEqual(['u2-next'])
    } finally {
      await local.shutdown()
    }
  })

  it('撤回范围含已压缩归档 → 拒绝（raw-archive 记录 fixture）；块数不足/越界同样拒绝', async () => {
    const local = await boot('undo-guard')
    try {
      const handle = await newSession(local, join(tmpRoot, 'undo-guard', 'ws'))
      await runMockPrompt(local, handle.info.id)
      await fabricateBlock(handle, 2)

      // fixture：往真实 raw archive 追加一条覆盖 u2（撤回范围内）的记录。
      await handle.runtime.stateLine.rawArchive.append({
        archiveId: 'arch-fixture-1',
        sourceTurnIds: ['u2'],
        messages: [],
        layer: 'M1',
        at: Date.now(),
        summaryStamp: 'stamp-fixture-1',
      })

      await expect(
        local.gate.command({ kind: 'session.undo', sessionId: handle.info.id, blocks: 1 }),
      ).rejects.toThrow(/already compressed/)

      // 未触归档时：块数不足（只有 2 个完整块）。
      await expect(
        local.gate.command({ kind: 'session.undo', sessionId: handle.info.id, blocks: 3 }),
      ).rejects.toThrow(/only 2 complete task block/)

      // 越界（0 / 11）。
      await expect(
        local.gate.command({ kind: 'session.undo', sessionId: handle.info.id, blocks: 0 }),
      ).rejects.toThrow(/integer blocks in \[1, 10\]/)
      await expect(
        local.gate.command({ kind: 'session.undo', sessionId: handle.info.id, blocks: 11 }),
      ).rejects.toThrow(/integer blocks in \[1, 10\]/)

      // 未打开的会话。
      await expect(
        local.gate.command({ kind: 'session.undo', sessionId: 'never-opened', blocks: 1 }),
      ).rejects.toThrow(/is not open/)
    } finally {
      await local.shutdown()
    }
  })
})
