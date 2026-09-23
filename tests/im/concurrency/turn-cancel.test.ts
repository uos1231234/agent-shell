// 真实并发测试（场景 5）：turn.cancel → AbortSignal → 工具执行竞态。
//
// 机制来源（已读代码）：
//   src/im/loop.ts:602-624  外部 signal 桥接到内部 AbortController；
//                           acSignal.throwIfAborted() 在每个 await 边界检查。
//   src/im/loop.ts:535      ctx.signal = opts.signal —— 取消信号透传给工具层，
//                           阻塞型工具据此与 abort 竞速。
//   src/host/assembly.ts:974-976  gate 'turn.cancel' → cancelSignals.get(id)?.abort()
//                           （即本测试里直接 abort 传入 loop 的 controller）。
//
// 测试：取消信号在「尚未开始 / 工具执行中 / 工具返回瞬间」三种时机到达，
// 状态是否一致、是否残留（用假工具验证 signal 传播与清理）。

import { describe, it, expect } from 'vitest'
import { runIMLoop } from '../../../src/im/loop.js'
import { ToolRegistry } from '../../../src/shell/registry.js'
import { createConfig } from '../../../src/shell/config.js'
import { createMetrics } from '../../../src/shell/metrics.js'
import { Databus } from '../../../src/im/databus.js'
import { ConversationMemory } from '../../../src/im/conversation-memory.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import { createNoopStateLine } from '../../../src/im/state-line/index.js'
import type { SystemAgent } from '../../../src/im/system-agent.js'
import { createScriptedStreamChat } from '../../harness/index.js'
import type { ToolContext } from '../../../src/shared/tool-context.js'

const noopSystemAgent: SystemAgent = { run: async () => { throw new Error('noop') }, stop() {}, send() {} }

const runOnce = (opts: {
  registry: ToolRegistry
  signal?: AbortSignal
  scripted: ReturnType<typeof createScriptedStreamChat>
  userTemplate?: string
}) => {
  const mem = new ConversationMemory()
  const bus = new Databus()
  const loopP = runIMLoop({
    config: createConfig({ maxSteps: 50 }),
    registry: opts.registry,
    databus: bus,
    conversationMemory: mem,
    workingAgentId: 'main',
    mailbox: new Mailbox(),
    systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
    stateLine: createNoopStateLine(),
    initialMetrics: createMetrics(),
    streamChat: opts.scripted,
    url: 'https://x',
    model: 'gpt-4',
    systemPrompt: 'SYS',
    userTemplate: opts.userTemplate ?? 'TEMPLATE',
    systemToolRefs: ['slow'],
    mcpRefs: [],
    skillRefs: [],
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  })
  return { loopP, mem, bus }
}

describe('concurrency: turn.cancel / AbortSignal 竞态', () => {
  it('取消在回合开始前到达（预 abort）：立即 shell-terminated，无工具执行', async () => {
    const ac = new AbortController()
    ac.abort() // 进入 loop 前已 abort
    const registry = new ToolRegistry()
    let executed = false
    registry.registerSystemTool({
      name: 'slow',
      description: 'slow tool',
      category: 'command',
      parameters: { type: 'object', properties: {} },
      execute: async () => { executed = true; return 'OUT' },
    })
    const scripted = createScriptedStreamChat([{ kind: 'tool', name: 'slow', args: {} }, { kind: 'text', content: 'DONE' }])
    const { loopP } = runOnce({ registry, signal: ac.signal, scripted })
    const result = await loopP

    expect(result.reason).toBe('shell-terminated')
    expect(executed).toBe(false) // 工具从未执行
  })

  it('取消在工具执行中到达：信号透传给工具（ctx.signal），工具清理后 loop 一致终止', async () => {
    const ac = new AbortController()
    let toolStarted = false
    let cleanedUp = false
    let gateResolve!: () => void
    const gateP = new Promise<void>((res) => { gateResolve = res })

    const registry = new ToolRegistry()
    registry.registerSystemTool({
      name: 'slow',
      description: 'slow tool',
      category: 'command',
      parameters: { type: 'object', properties: {} },
      execute: async (_args: unknown, ctx?: ToolContext) => {
        toolStarted = true
        await gateP // 模拟阻塞型工具（如子进程）挂起
        // 良态工具：观测到 abort 后清理并返回（不残留孤儿进程）
        if (ctx?.signal?.aborted) {
          cleanedUp = true
          return 'CLEANED_UP'
        }
        return 'OUT'
      },
    })
    const scripted = createScriptedStreamChat([{ kind: 'tool', name: 'slow', args: {} }, { kind: 'text', content: 'DONE' }])
    const { loopP, mem } = runOnce({ registry, signal: ac.signal, scripted })

    // 等工具真正进入挂起态再取消（确定性，不靠 sleep）
    while (!toolStarted) await Promise.resolve()
    ac.abort()
    gateResolve() // 放行工具

    const result = await loopP
    expect(result.reason).toBe('shell-terminated') // loop 因 abort 终止
    expect(cleanedUp).toBe(true) // 取消信号确实透传到了工具层
    // 状态一致：工具回合（清理结果）已落 canonical，且 toolCallId 配对无损坏
    const toolTurns = mem.turns().filter((t) => t.role === 'tool') as Array<{ toolCallId: string; content: string }>
    expect(toolTurns).toHaveLength(1)
    expect(toolTurns[0]!.toolCallId).toBe('call_0_0')
    expect(toolTurns[0]!.content).toBe('CLEANED_UP')
  })

  it('取消在工具返回瞬间到达：loop 仍一致终止，无遗留半写状态', async () => {
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
      execute: async () => {
        toolStarted = true
        await gateP
        return 'OUT' // 正常返回（未主动观测 abort）
      },
    })
    const scripted = createScriptedStreamChat([{ kind: 'tool', name: 'slow', args: {} }, { kind: 'text', content: 'DONE' }])
    const { loopP, mem } = runOnce({ registry, signal: ac.signal, scripted })
    while (!toolStarted) await Promise.resolve()
    ac.abort()
    gateResolve()

    const result = await loopP
    expect(result.reason).toBe('shell-terminated')
    // 工具结果（含配对 toolCallId）已完整落盘，无半写/损坏
    const toolTurns = mem.turns().filter((t) => t.role === 'tool') as Array<{ toolCallId: string; content: string }>
    expect(toolTurns).toHaveLength(1)
    expect(toolTurns[0]!.toolCallId).toBe('call_0_0')
    expect(toolTurns[0]!.content).toBe('OUT')
  })
})
