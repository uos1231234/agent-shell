// 确定性重放测试 (B)：历史工具结果原位截断 + 戳召回（v0.38）在生产 loop 路径上是否真的生效。
//
// 用户拍板（2026-09-12，src/im/tools/history-tool-table.ts）：canonical 中
// 工具回合数超过热窗口 keepRecent（默认 20）后，窗口之外、result > 500 token
// 的工具回合原位截断 content 到 500 token + 追加带 12 位戳的截断标记。纯算法、
// 不调 LLM、databus 不动、不删 turn。
//
// 关键接线问题：截断的"执行点"是 HOOK 5 afterToolExecution。它不是 runIMLoop
// 自行调用的——必须由调用方传入 afterToolExecution hook。生产中由
// src/im/system-agent.ts:436 与 src/host/assembly.ts:761 接线。
// (B-1) 以与生产完全一致的方式接线，证明该机制能在真实 loop 路径上生效；
// (B-2) 做对照：不接线时截断不会发生——证明机制确实依赖调用方 hook。

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
import { foldOversizeToolTurns } from '../../../src/im/tools/history-tool-table.js'
import { createScriptedStreamChat, type ScriptStep } from '../../harness/index.js'
import type { LoopHooks } from '../../../src/im/loop-hooks.js'

const noopSystemAgent: SystemAgent = {
  run: async () => { throw new Error('noop') },
  stop() {},
  send() {},
}

const ROUNDS = 25 // 超过 keepRecent(20) 的热窗口
const LEGACY_TABLE_MARKER = '历史工具结果已按算法压缩为表格' // v0.37 旧表格标记，v0.38 后不应再出现
const STAMP_MARKER = '截断 2000→' // v0.39 截断标记

// 25 步大结果工具调用 + 1 步纯文本收尾（让 loop 正常 completed，而非因 guard 终止）
const buildScript = (n: number): ScriptStep[] => {
  const steps: ScriptStep[] = []
  for (let i = 0; i < n; i += 1) steps.push({ kind: 'tool', name: 'bigtool', args: { round: i } })
  steps.push({ kind: 'text', content: 'DONE' })
  return steps
}

// 大结果：ROUND{n}-MARKER + 10000 个 x（ASCII ~2500 token > 2000 阈值，必被截断）
const runBigTool = async (args: unknown): Promise<string> => {
  const r = (args as { round: number }).round
  return `ROUND${r}-MARKER ` + 'x'.repeat(10000)
}

const baseOpts = (streamChat: ReturnType<typeof createScriptedStreamChat>, registry: ToolRegistry, conversationMemory: ConversationMemory, hooks?: LoopHooks) => ({
  config: createConfig(), // 默认阈值：maxSteps=200，本测试不会被 guard 提前终止
  registry,
  databus: new Databus(),
  conversationMemory,
  workingAgentId: 'main' as const,
  mailbox: new Mailbox(),
  systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
  stateLine: createNoopStateLine(),
  initialMetrics: createMetrics(),
  streamChat,
  url: 'https://x',
  model: 'gpt-4',
  systemPrompt: 'SYS',
  userTemplate: 'TEMPLATE',
  systemToolRefs: ['bigtool'],
  mcpRefs: [],
  skillRefs: [],
  ...(hooks ? { hooks } : {}),
})

describe('replay: 历史工具结果原位截断 + 戳召回（v0.38）', () => {
  it('B-1: 经 HOOK 5 afterToolExecution 接线后，热窗口外工具结果在真实 loop 路径上被原位截断', async () => {
    const registry = new ToolRegistry()
    registry.registerSystemTool({
      name: 'bigtool',
      description: 'bigtool',
      parameters: { type: 'object', properties: { round: { type: 'number' } }, required: ['round'] } as const,
      execute: runBigTool,
    })
    const scripted = createScriptedStreamChat(buildScript(ROUNDS))
    const conversationMemory = new ConversationMemory()

    // 与 src/im/system-agent.ts:436 生产接线完全一致
    const result = await runIMLoop(baseOpts(scripted, registry, conversationMemory, {
      afterToolExecution: async (ctx) => {
        if (ctx.conversationMemory) foldOversizeToolTurns(ctx.conversationMemory)
        return undefined
      },
    }))

    expect(result.reason).toBe('completed')

    const turns = conversationMemory.turns()
    const toolTurns = turns.filter((t) => t.role === 'tool')
    const tableTurns = turns.filter(
      (t) => t.role === 'user' && typeof t.content === 'string' && t.content.includes(LEGACY_TABLE_MARKER),
    )

    // v0.38 废弃表格载体 → 不应再出现表格 turn
    expect(tableTurns.length).toBe(0)

    // 原位截断不删 turn：25 个 tool turn 全部保留
    expect(toolTurns.length).toBe(ROUNDS)

    // 最早 4 轮（round 0..3）在热窗外被截断：content 含戳标记
    // 注：fold 在「本轮工具结果 append 之前」执行（loop afterToolExecution 早于
    // appendCanonicalTurn），所以热窗口实际容纳 keepRecent+1=21 个 → 溢出 4 个
    const truncated = toolTurns.filter((t) => typeof t.content === 'string' && t.content.includes(STAMP_MARKER))
    expect(truncated.length).toBe(4)

    // round 0 的 MARKER 仍在（截断保留前 500 token，MARKER 在 content 开头）
    expect(toolTurns.some((t) => typeof t.content === 'string' && t.content.includes('ROUND0-MARKER'))).toBe(true)
    // round 0 也带戳（截断标记与 MARKER 同 turn）
    expect(toolTurns.some((t) => typeof t.content === 'string' && t.content.includes('ROUND0-MARKER') && t.content.includes(STAMP_MARKER))).toBe(true)

    // 最近一轮(round 24)的工具结果仍原样保留（在热窗口内，无截断标记）
    const r24 = toolTurns.find((t) => typeof t.content === 'string' && t.content.includes('ROUND24-MARKER'))!
    expect(r24.content as string).not.toContain(STAMP_MARKER)
  })

  it('B-2: 对照——runIMLoop 自身不接线截断；缺 afterToolExecution hook 时历史工具结果原样累积', async () => {
    const registry = new ToolRegistry()
    registry.registerSystemTool({
      name: 'bigtool',
      description: 'bigtool',
      parameters: { type: 'object', properties: { round: { type: 'number' } }, required: ['round'] } as const,
      execute: runBigTool,
    })
    const scripted = createScriptedStreamChat(buildScript(ROUNDS))
    const conversationMemory = new ConversationMemory()

    const result = await runIMLoop(baseOpts(scripted, registry, conversationMemory))

    expect(result.reason).toBe('completed')
    const turns = conversationMemory.turns()
    const toolTurns = turns.filter((t) => t.role === 'tool')
    const tableTurns = turns.filter(
      (t) => t.role === 'user' && typeof t.content === 'string' && t.content.includes(LEGACY_TABLE_MARKER),
    )

    // 不接线 → 不发生截断：25 个工具结果全部原样保留
    expect(toolTurns.length).toBe(ROUNDS)
    expect(tableTurns.length).toBe(0)
    // 无任何截断标记
    expect(toolTurns.some((t) => typeof t.content === 'string' && t.content.includes(STAMP_MARKER))).toBe(false)
    // round 0 原样（无截断标记）
    expect(toolTurns.some((t) => typeof t.content === 'string' && t.content.includes('ROUND0-MARKER'))).toBe(true)
  })
})
