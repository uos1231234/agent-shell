// v0.41 goal 模式 — beforeComplete hook 在真实 loop 路径上的接缝测试。
//
// 钉住四件事：
//  (1) hook 返回 continueWith 时 loop 追加 canonical 回合 + 落盘 + 续跑，
//      返回 undefined 时维持既有 completed 行为；
//  (2) **hook 未提供时行为逐字节不变**（"最小接入口径"的硬判据，DoD）；
//  (3) 续跑回合经**既有 history 投影**上 wire，compose 层零改动，且
//      omitUserTemplatePart 的"用户文本每轮恰好一次"语义不破；
//  (4) 触发时机 = 只在"本应以 completed 终止"的那一轮，含工具调用的轮次不触发
//      （计划 §3.2：maxRounds 计的是分歧循环次数，不是 LLM 轮数）。

import { describe, it, expect, vi } from 'vitest'
import { runIMLoop } from '../../../src/im/loop.js'
import { ToolRegistry } from '../../../src/shell/registry.js'
import { createConfig } from '../../../src/shell/config.js'
import { createMetrics } from '../../../src/shell/metrics.js'
import { Databus } from '../../../src/im/databus.js'
import { ConversationMemory } from '../../../src/im/conversation-memory.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import { createNoopStateLine } from '../../../src/im/state-line/index.js'
import type { SystemAgent } from '../../../src/im/system-agent.js'
import type { ConversationTurn } from '../../../src/im/conversation-memory.js'
import type { ChatMessage } from '../../../src/protocol/types.js'
import type { LoopHooks, BeforeCompleteContext } from '../../../src/im/loop-hooks.js'
import { createScriptedStreamChat, type ScriptStep } from '../../harness/index.js'

const noopSystemAgent: SystemAgent = {
  run: async () => { throw new Error('noop') },
  stop() {},
  send() {},
}

const buildOpts = (
  streamChat: ReturnType<typeof createScriptedStreamChat>,
  registry: ToolRegistry,
  conversationMemory: ConversationMemory,
  extra?: { hooks?: LoopHooks; persistTurn?: (t: ConversationTurn) => Promise<void> },
) => ({
  config: createConfig(),
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
  systemToolRefs: [],
  mcpRefs: [],
  skillRefs: [],
  ...(extra?.hooks !== undefined ? { hooks: extra.hooks } : {}),
  ...(extra?.persistTurn !== undefined ? { persistTurn: extra.persistTurn } : {}),
})

const emptyRegistry = (): ToolRegistry => new ToolRegistry()

const toolRegistry = (): ToolRegistry => {
  const r = new ToolRegistry()
  r.registerSystemTool({
    name: 'probe',
    description: 'probe',
    parameters: { type: 'object', properties: {}, required: [] } as const,
    execute: async () => 'probe-ok',
  })
  return r
}

const textsInRequest = (request: { messages: ChatMessage[] }): string[] =>
  request.messages
    .filter((m): m is Extract<ChatMessage, { role: 'user' }> => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))

describe('replay: beforeComplete hook — 续跑与终止', () => {
  it('A: 第一次返回 continueWith → 追加 goal- 回合并续跑；第二次返回 undefined → completed', async () => {
    const scripted = createScriptedStreamChat([
      { kind: 'text', content: '我认为做完了' },
      { kind: 'text', content: '这次真的做完了' },
    ] satisfies ScriptStep[])
    const memory = new ConversationMemory()
    let calls = 0

    const result = await runIMLoop(buildOpts(scripted, emptyRegistry(), memory, {
      hooks: {
        beforeComplete: async () => {
          calls += 1
          if (calls === 1) return { continueWith: { content: '#GOAL_CONTINUATION 第一次提醒', idPrefix: 'goal' } }
          return undefined
        },
      },
    }))

    expect(result.reason).toBe('completed')
    expect(result.terminated).toBe(true)
    expect(result.turns).toBe(2)
    expect(calls).toBe(2)

    // canonical 形状：user(TEMPLATE) → assistant → goal- 提醒 → assistant
    const turns = memory.turns()
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(turns[2]!.id.startsWith('goal-')).toBe(true)
    expect(turns[2]!.role === 'user' && turns[2]!.content).toBe('#GOAL_CONTINUATION 第一次提醒')
  })

  it('B（对照）: 未提供 hook 时行为逐字节不变——一轮纯文本即 completed', async () => {
    const scripted = createScriptedStreamChat([{ kind: 'text', content: '做完了' }] satisfies ScriptStep[])
    const memory = new ConversationMemory()

    const result = await runIMLoop(buildOpts(scripted, emptyRegistry(), memory))

    expect(result.reason).toBe('completed')
    expect(result.turns).toBe(1)
    expect(memory.turns().map((t) => t.role)).toEqual(['user', 'assistant'])
    // 脚本只消费了一步：loop 没有多跑一轮
    expect(scripted.captured).toHaveLength(1)
  })

  it('B2（对照）: hook 存在但始终弃权时，与未提供 hook 完全同形', async () => {
    const scripted = createScriptedStreamChat([{ kind: 'text', content: '做完了' }] satisfies ScriptStep[])
    const memory = new ConversationMemory()
    const hook = vi.fn(async () => undefined)

    const result = await runIMLoop(buildOpts(scripted, emptyRegistry(), memory, {
      hooks: { beforeComplete: hook },
    }))

    expect(result.reason).toBe('completed')
    expect(result.turns).toBe(1)
    expect(hook).toHaveBeenCalledTimes(1)
    expect(memory.turns().map((t) => t.role)).toEqual(['user', 'assistant'])
  })

  it('E: 续跑回合经 persistTurn 落盘（否则恢复后看不到"为什么还在跑"）', async () => {
    const scripted = createScriptedStreamChat([
      { kind: 'text', content: '第一轮' },
      { kind: 'text', content: '第二轮' },
    ] satisfies ScriptStep[])
    const persisted: ConversationTurn[] = []

    await runIMLoop(buildOpts(scripted, emptyRegistry(), new ConversationMemory(), {
      persistTurn: async (t) => { persisted.push(t) },
      hooks: {
        beforeComplete: async (ctx) =>
          ctx.stepNumber === 1
            ? { continueWith: { content: '提醒正文', idPrefix: 'goal' } }
            : undefined,
      },
    }))

    const goalTurns = persisted.filter((t) => t.id.startsWith('goal-'))
    expect(goalTurns).toHaveLength(1)
    expect(goalTurns[0]!.role).toBe('user')
    expect(goalTurns[0]!.role === 'user' && goalTurns[0]!.content).toBe('提醒正文')
    // 落盘顺序：user(TEMPLATE) → assistant → goal- 提醒 → assistant
    expect(persisted.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('F: idPrefix 由 hook 生产方拥有（mem- / compaction-note- / sys- 同惯例）', async () => {
    const scripted = createScriptedStreamChat([
      { kind: 'text', content: '第一轮' },
      { kind: 'text', content: '第二轮' },
    ] satisfies ScriptStep[])
    const memory = new ConversationMemory()

    await runIMLoop(buildOpts(scripted, emptyRegistry(), memory, {
      hooks: {
        beforeComplete: async (ctx) =>
          ctx.stepNumber === 1
            ? { continueWith: { content: '提醒', idPrefix: 'custom-producer' } }
            : undefined,
      },
    }))

    const continuation = memory.turns()[2]!
    expect(continuation.id.startsWith('custom-producer-')).toBe(true)
    // 全局唯一（§6.7 mintTurnId 纪律）：不是 custom-producer-1 这种可撞车的短编号
    expect(continuation.id.length).toBeGreaterThan('custom-producer-'.length + 10)
  })
})

describe('replay: beforeComplete hook — 续跑回合经既有 history 投影上 wire', () => {
  it('C: 第二轮请求体里出现续跑回合，且 compose 层未做任何特殊处理', async () => {
    const scripted = createScriptedStreamChat([
      { kind: 'text', content: '第一轮' },
      { kind: 'text', content: '第二轮' },
    ] satisfies ScriptStep[])

    await runIMLoop(buildOpts(scripted, emptyRegistry(), new ConversationMemory(), {
      hooks: {
        beforeComplete: async (ctx) =>
          ctx.stepNumber === 1
            ? { continueWith: { content: 'MARKER-续跑提醒正文', idPrefix: 'goal' } }
            : undefined,
      },
    }))

    expect(scripted.captured).toHaveLength(2)
    const round2Users = textsInRequest(scripted.captured[1]!.request)
    // 续跑提醒作为 role:'user' 出现在第二轮请求里——纯靠 loop.ts:244 的
    // conversationTurns.map(turnToMessage) 投影，没有新增任何 compose 分支。
    expect(round2Users).toContain('MARKER-续跑提醒正文')
    // 第一轮请求里不该有它（那时它还不存在）
    expect(textsInRequest(scripted.captured[0]!.request).join('\n')).not.toContain('MARKER-续跑提醒正文')
  })

  it('D: userTemplate 在续跑轮里仍恰好出现一次（omitUserTemplatePart 去重不破）', async () => {
    const scripted = createScriptedStreamChat([
      { kind: 'text', content: '第一轮' },
      { kind: 'text', content: '第二轮' },
      { kind: 'text', content: '第三轮' },
    ] satisfies ScriptStep[])

    await runIMLoop(buildOpts(scripted, emptyRegistry(), new ConversationMemory(), {
      hooks: {
        beforeComplete: async (ctx) =>
          ctx.stepNumber <= 2
            ? { continueWith: { content: `提醒 ${ctx.stepNumber}`, idPrefix: 'goal' } }
            : undefined,
      },
    }))

    for (const [i, captured] of scripted.captured.entries()) {
      const occurrences = textsInRequest(captured.request)
        .filter((c) => c === 'TEMPLATE')
        .length
      expect(occurrences, `第 ${i + 1} 轮请求里 TEMPLATE 的出现次数`).toBe(1)
    }
  })

  // v0.41 后续补丁 (b)：u1 被压缩逐出后不得在请求尾部重新注入（幻影）。
  // 判据从内容扫描改为构造性事实（userTemplate 非空 = 入口已落 canonical），
  // 逐出后 omit 仍为 true → 不复活。修复前：逐出使扫描不命中 → 尾部重注入。
  it('E: u1 被逐出（模拟 G1）后续跑轮不再重注入 userTemplate（幻影消除）', async () => {
    const scripted = createScriptedStreamChat([
      { kind: 'text', content: '第一轮' },
      { kind: 'text', content: '第二轮' },
    ] satisfies ScriptStep[])
    const ENVELOPE = '#STAMP S-1\n#LAYER M1\n[任务] 目标\n#END_BLOCK'

    await runIMLoop(buildOpts(scripted, emptyRegistry(), new ConversationMemory(), {
      hooks: {
        beforeComplete: async (ctx) => {
          if (ctx.stepNumber === 1) {
            // 模拟 G1：把入口落下的 u1（index 0，content='TEMPLATE'）原位换成信封。
            const envelopeTurn: ConversationTurn = {
              id: 'mem-1', role: 'user', content: ENVELOPE, at: Date.now(),
            }
            ctx.conversationMemory.replaceRange(0, 1, [envelopeTurn])
            return { continueWith: { content: '提醒 1', idPrefix: 'goal' } }
          }
          return undefined
        },
      },
    }))

    // 第 1 轮：u1 还在 canonical，history 投影出 'TEMPLATE'（恰好一次）。
    expect(textsInRequest(scripted.captured[0]!.request)).toContain('TEMPLATE')
    // 第 2 轮（u1 已被逐出）：请求里**不得**再出现 'TEMPLATE'（幻影消除），
    // 但信封与续跑提醒经 history 投影正常在场。
    const round2 = textsInRequest(scripted.captured[1]!.request)
    expect(round2).not.toContain('TEMPLATE')
    expect(round2.some((t) => t.includes('#STAMP S-1'))).toBe(true)
    expect(round2.some((t) => t.includes('提醒 1'))).toBe(true)
  })
})

describe('replay: beforeComplete hook — 触发时机（计划 §3.2）', () => {
  it('G: 含工具调用的轮次不触发 hook，只有"本应 completed"的那轮触发', async () => {
    const scripted = createScriptedStreamChat([
      { kind: 'tool', name: 'probe', args: {} },
      { kind: 'tool', name: 'probe', args: {} },
      { kind: 'text', content: '现在做完了' },
    ] satisfies ScriptStep[])
    const memory = new ConversationMemory()
    const hook = vi.fn(async (_ctx: BeforeCompleteContext) => undefined)

    const result = await runIMLoop(buildOpts(scripted, toolRegistry(), memory, {
      hooks: { beforeComplete: hook },
    }))

    expect(result.reason).toBe('completed')
    expect(result.turns).toBe(3)
    // 三个 LLM 轮，但只有最后那个无工具轮触发 judge——maxRounds 计的是分歧
    // 循环次数而非 LLM 轮数，这个区别是 D17 默认值 24 的依据。
    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook.mock.calls[0]![0].stepNumber).toBe(3)
  })

  it('G2: 工具轮之间插入的续跑不改变工具配对（validatePairing 前提）', async () => {
    const scripted = createScriptedStreamChat([
      { kind: 'tool', name: 'probe', args: {} },
      { kind: 'text', content: '第一次收尾' },
      { kind: 'tool', name: 'probe', args: {} },
      { kind: 'text', content: '第二次收尾' },
    ] satisfies ScriptStep[])
    const memory = new ConversationMemory()

    const result = await runIMLoop(buildOpts(scripted, toolRegistry(), memory, {
      hooks: {
        beforeComplete: async (ctx) =>
          ctx.stepNumber === 2
            ? { continueWith: { content: '提醒', idPrefix: 'goal' } }
            : undefined,
      },
    }))

    expect(result.reason).toBe('completed')
    // user → assistant(tool_calls) → tool → assistant → goal-user → assistant(tool_calls) → tool → assistant
    expect(memory.turns().map((t) => t.role)).toEqual([
      'user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool', 'assistant',
    ])
    // 续跑回合落在"assistant 已收尾、无未决 tool_call"的位置——这正是原则 3
    // 的配对安全性依据：它不可能插在 assistant(tool_calls) 与其 tool 结果之间。
    const goalIdx = memory.turns().findIndex((t) => t.id.startsWith('goal-'))
    expect(memory.turns()[goalIdx - 1]!.role).toBe('assistant')
    const prev = memory.turns()[goalIdx - 1]!
    expect(prev.role === 'assistant' && prev.toolCalls).toBeUndefined()
  })
})

describe('replay: beforeComplete hook — ctx 内容', () => {
  it('H: ctx 带本轮真实 usage、canonical 与 databus 引用', async () => {
    const scripted = createScriptedStreamChat([
      { kind: 'text', content: '第一轮', usage: { promptTokens: 4321, completionTokens: 10, totalTokens: 4331 } },
    ] satisfies ScriptStep[])
    const memory = new ConversationMemory()
    const databus = new Databus()
    let seen: BeforeCompleteContext | undefined

    await runIMLoop({
      ...buildOpts(scripted, emptyRegistry(), memory),
      databus,
      hooks: {
        beforeComplete: async (ctx) => {
          seen = ctx
          return undefined
        },
      },
    })

    expect(seen).toBeDefined()
    // 与 :988 压缩喂值同口径：本轮协议层真实 usage，不是滞后的轮初估算。
    expect(seen!.lastRequestTokens).toBe(4321)
    expect(seen!.conversationMemory).toBe(memory)
    expect(seen!.databus).toBe(databus)
    expect(seen!.stepNumber).toBe(1)
    expect(seen!.turnId).toBeTypeOf('string')
    // hook 看到的 canonical 已含本轮 assistant 回合（finalizeRound 已跑完）
    expect(seen!.conversationMemory.turns().map((t) => t.role)).toEqual(['user', 'assistant'])
  })

  it('H2: hook 抛错被 callHook 吞成弃权，回合照常 completed（既有失败安全语义）', async () => {
    const scripted = createScriptedStreamChat([{ kind: 'text', content: '做完了' }] satisfies ScriptStep[])

    const result = await runIMLoop(buildOpts(scripted, emptyRegistry(), new ConversationMemory(), {
      hooks: {
        beforeComplete: async () => { throw new Error('judge 炸了') },
      },
    }))

    expect(result.reason).toBe('completed')
    expect(result.turns).toBe(1)
  })
})
