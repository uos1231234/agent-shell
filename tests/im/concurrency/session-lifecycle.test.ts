// 真实并发测试（场景 4 / 场景 6）：同一 session 并发提问、session 生命周期竞态。
//
// ===== 场景 6（确定性通过的部分）=====
// 机制来源（已读代码）：
//   src/host/assembly.ts:753-761  detachSession(id)
//     - cancelSignals.get(id)?.abort()  ← close/delete 通过 abort 终止在途回合
//     - assets.handle.close()（stateLine.close）+ openHandles.delete(id)
//   src/host/assembly.ts:902-909  session.close / session.delete → detachSession
//   src/im/loop.ts:602-624,535   abort 经 signal 透传进 loop，边界 throwIfAborted 终止。
// 结论：close/delete 对在途 turn 的终止是「fire-and-forget」——它 abort 信号，
//       在途 loop 在下一个 await 边界自我终止（reason='shell-terminated'），无悬挂。
//       本文件确定性验证该路径（用直接 abort 传入 loop 的 controller 模拟 detachSession）。
//
// ===== 场景 4（发现缺陷 → it.todo）=====
// 机制来源（已读代码）：
//   src/host/assembly.ts:766-817  runPromptOnce
//     - 没有任何「该 session 是否已有在途 turn」的互斥/队列保护；
//     - 每次调用新建 AbortController 并 cancelSignals.set(sessionId, controller)
//       （第 774-775 行）——**两次并发 prompt 会互相覆盖 cancelSignals**，
//       导致对第一个在途 turn 的 turn.cancel 失效（abort 的是第二个的 controller）；
//     - 两个并发 runIMLoop 共享同一 session 的 conversationMemory / databus /
//       stateLine（buildLoopOptions 复用 handle.runtime），无锁地交错 append 会
//       破坏 canonical 顺序与 tool↔tool_call 配对。
//   设计意图：代码里没有 concurrency guard。按任务要求写成 it.todo + 报告说明，
//   不擅自修复 src。
//
// ===== 场景 6 的另一处竞态（→ it.todo）=====
//   detachSession 先 abort 再 handle.close()（stateLine.close 关闭 jsonl 文件句柄），
//   但并未 await 在途 loop 结束。若此时 loop 内的 persistTurn（或 fireDriveCoordinator
//   的压缩写）仍持有 append 进行中，写已关闭的文件句柄会抛错。证据：
//   assembly.ts:757-760（abort + delete + handle.close 顺序，无 await loop）、
//   session-manager.ts:169-173 handle.close → stateLine.close。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runIMLoop } from '../../../src/im/loop.js'
import { createHostAssembly, type HostAssembly } from '../../../src/host/assembly.js'
import { isQueuedPromptReceipt } from '../../../src/signals/session-queue.js'
import { ToolRegistry } from '../../../src/shell/registry.js'
import { createConfig } from '../../../src/shell/config.js'
import { createMetrics } from '../../../src/shell/metrics.js'
import { Databus } from '../../../src/im/databus.js'
import { ConversationMemory } from '../../../src/im/conversation-memory.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import { createNoopStateLine } from '../../../src/im/state-line/index.js'
import type { SystemAgent } from '../../../src/im/system-agent.js'
import { createScriptedStreamChat } from '../../harness/index.js'

const noopSystemAgent: SystemAgent = { run: async () => { throw new Error('noop') }, stop() {}, send() {} }

describe('concurrency: session 生命周期竞态', () => {
  it('close/delete 触发的 abort 让在途 turn 一致终止，无悬挂、状态完整', async () => {
    const ac = new AbortController()
    let toolStarted = false
    let gateResolve!: () => void
    const gateP = new Promise<void>((res) => { gateResolve = res })
    const registry = new ToolRegistry()
    registry.registerSystemTool({
      name: 'slow',
      description: 'slow tool',
      category: 'command',
      parameters: { type: 'object', properties: {} },
      execute: async () => { toolStarted = true; await gateP; return 'OUT' },
    })
    const scripted = createScriptedStreamChat([{ kind: 'tool', name: 'slow', args: {} }, { kind: 'text', content: 'DONE' }])
    const mem = new ConversationMemory()
    const loopP = runIMLoop({
      config: createConfig({ maxSteps: 50 }),
      registry,
      databus: new Databus(),
      conversationMemory: mem,
      workingAgentId: 'main',
      mailbox: new Mailbox(),
      systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
      stateLine: createNoopStateLine(),
      initialMetrics: createMetrics(),
      streamChat: scripted,
      url: 'https://x',
      model: 'gpt-4',
      systemPrompt: 'SYS',
      userTemplate: 'TEMPLATE',
      systemToolRefs: ['slow'],
      mcpRefs: [],
      skillRefs: [],
      signal: ac.signal,
    })

    while (!toolStarted) await Promise.resolve()
    ac.abort() // 模拟 detachSession 里的 cancelSignals.get(id)?.abort()
    gateResolve()

    const result = await loopP
    expect(result.reason).toBe('shell-terminated') // 在途 turn 被干净终止
    // canonical 状态完整：user + assistant(tool_calls) + 工具回合，配对未损坏
    expect(mem.turns().length).toBeGreaterThanOrEqual(2)
    const toolTurns = mem.turns().filter((t) => t.role === 'tool') as Array<{ toolCallId: string; content: string }>
    expect(toolTurns).toHaveLength(1)
    expect(toolTurns[0]!.toolCallId).toBe('call_0_0')
    expect(toolTurns[0]!.content).toBe('OUT')
  })

  // 场景 4 与场景 6 原先各有一个 it.todo，记录两个当时无法修复的缺陷。
  // v0.34 收口（2026-09-10）：
  //   - 场景 4「同 session 并发 prompt 无互斥」→ **已修**：并发防线落在 gate 层
  //     （session-queue.ts + gate.ts），第二条消息排队而非并发。改为下面的真实
  //     测试，走**生产装配**（gate.command）而非直接调 runIMLoop——装配级才算
  //     接线验收（AGENTS.md §5）。
  //   - 场景 6「close 在在途 turn 结束前关闭 stateLine 文件句柄」→ **前提被核实
  //     为不存在**：`stateLine.close()` 只做 `subscribers.length = 0`（无文件
  //     操作），落盘走 `appendJsonl` → `appendFile`（每次开-写-关，不持有长期
  //     句柄）。故不存在"写已关闭句柄"。改为断言实际行为：close 时有在途 turn
  //     不抛错、回合干净收尾。
})

// ---------------------------------------------------------------------------
// v0.34 C1：生产装配级的同会话串行化（原 it.todo 的收口）
// ---------------------------------------------------------------------------

describe('concurrency: 生产装配的同会话并发（v0.34 C1）', () => {
  let tmpRoot: string
  let assembly: HostAssembly

  const waitFor = async (cond: () => Promise<boolean>, timeoutMs = 5000): Promise<boolean> => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await cond()) return true
      await new Promise((r) => setTimeout(r, 10))
    }
    return cond()
  }

  const newSession = async (): Promise<string> => {
    const handle = await assembly.handlers.session.create({ workDir: join(tmpRoot, 'ws') })
    // mock 回合会发起可能需要审批的工具调用；没有前端应答时 gate.request 会挂到
    // 300s 超时 → 回合永不收尾（这正是本测试第一次跑超时的原因）。先授全权限，
    // 让回合能走完——本测试关心的是**并发串行化**，不是审批。
    await assembly.gate.command({ kind: 'permission.full', sessionId: handle.info.id, enabled: true })
    return handle.info.id
  }

  const userTexts = async (sessionId: string): Promise<string[]> => {
    const hist = await assembly.handlers.session.history(sessionId)
    return hist
      .filter((t) => t.role === 'user')
      .map((t) => (typeof t.content === 'string' ? t.content : ''))
  }

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'session-lifecycle-'))
    assembly = await createHostAssembly({ dataDir: join(tmpRoot, 'sessions'), mock: true })
  })

  afterAll(async () => {
    await assembly?.shutdown()
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('同会话并发 prompt 被串行化：第二条返回排队回执，按序执行、无交错（场景 4 已修）', async () => {
    const sessionId = await newSession()

    // 并发发出两条：第一条立即执行，第二条应当**排队**（不并发、不丢弃、不顶替）。
    const first = assembly.gate.command({ kind: 'user.prompt', sessionId, text: 'FIRST' })
    const second = await assembly.gate.command({ kind: 'user.prompt', sessionId, text: 'SECOND' })

    expect(isQueuedPromptReceipt(second), 'second prompt must be queued, not run concurrently').toBe(true)
    expect((second as { position: number }).position).toBe(1)

    await first
    // 第二条由 gate 在第一条收尾后出队执行 —— 等它落到 canonical。
    // 注意：这是**两轮串行** mock 回合，比单轮测试慢，故 waitFor 给到 15s。
    const done = await waitFor(async () => (await userTexts(sessionId)).length >= 2, 15_000)
    expect(done, 'queued prompt must eventually run').toBe(true)

    // 顺序正确 = 无交错损坏（原缺陷会产出两份交错的 user/assistant 回合）
    const texts = await userTexts(sessionId)
    expect(texts.indexOf('FIRST')).toBeGreaterThanOrEqual(0)
    expect(texts.indexOf('SECOND')).toBeGreaterThan(texts.indexOf('FIRST'))
  }, 30_000)

  it('取消后的排队消息不再执行（D3），在途 turn 仍干净收尾', async () => {
    const sessionId = await newSession()

    const first = assembly.gate.command({ kind: 'user.prompt', sessionId, text: 'RUNNING' })
    await assembly.gate.command({ kind: 'user.prompt', sessionId, text: 'DROPPED' })
    await assembly.gate.command({ kind: 'turn.cancel', sessionId })

    await first
    // 给被丢弃的排队消息足够时间"本不该执行"——它不该出现在 canonical 里
    await new Promise((r) => setTimeout(r, 50))
    const texts = await userTexts(sessionId)
    expect(texts).not.toContain('DROPPED')
  })

  it('close 时有在途 turn 不抛错（场景 6：原前提已核实为不存在）', async () => {
    const sessionId = await newSession()

    const inFlight = assembly.gate.command({ kind: 'user.prompt', sessionId, text: 'IN_FLIGHT' })
    // 让回合真正启动（runIMLoop 已进到 mock streamChat）
    await new Promise((r) => setTimeout(r, 0))

    await assembly.gate.command({ kind: 'session.close', sessionId })

    // 关键断言：不抛错。stateLine.close() 无文件操作、落盘是 appendFile（无长期
    // 句柄），所以"写已关闭句柄"这件事根本不可能发生。
    await expect(inFlight).resolves.toBeDefined()
  })
})
