// v0.41 D19 覆盖面扩展（用户拍板 2026-09-14："扩到全部系统智能体与子代理"）。
//
// 为什么系统智能体与子代理同样需要出站转写：createSystemAgent 硬编码
// `userTemplate: ''`，而 omitUserTemplatePart 对空模板返回 false —— 每个系统
// 智能体/子代理的请求尾部都跟着一条空 user 消息，紧邻它前面的任务 user 消息，
// 构成 `src/protocol/messages.ts:6-8` 记录的"相邻 user 来源之二"。严格交替
// provider（Anthropic 系）会在这条请求上 400 —— 压缩、召回、仓库、知识卡片、
// 子代理全线失败，而 D19 最初只覆盖了工作代理与 judge。
//
// 钉住三件事：
//  (1) 开关缺省时形状**逐字节不变**：尾部那条空 user 消息仍在（既有 OpenAI
//      兼容会话零行为变化，"最小接入口径"的硬判据）；
//  (2) 开关 true 时三个系统智能体（warehouse/compressor/recall）与 run_subagent
//      创建的子代理，出站 body 里都不再有相邻 user，且任务文本逐字保留；
//  (3) 覆盖面是**装配层透传**，不是各工厂自己猜：createSystemAgents /
//      createRunSubagentTool 都只认 deps.strictAlternation。

import { describe, it, expect } from 'vitest'
import { createSystemAgent } from '../../src/im/system-agent.js'
import { createSystemAgents } from '../../src/im/system-agents/index.js'
import { createRunSubagentTool, type RunSubagentDeps } from '../../src/im/tools/run-subagent.js'
import { SubAgentRegistry } from '../../src/im/sub-agent/index.js'
import { ToolRegistry } from '../../src/shell/registry.js'
import { Mailbox } from '../../src/im/mailbox/index.js'
import { createNoopStateLine } from '../../src/im/state-line/index.js'
import { hasAdjacentUserMessages } from '../../src/protocol/messages.js'
import type { ChatMessage, StreamChunk } from '../../src/protocol/types.js'

type Body = { messages: ChatMessage[] }

/** 每次调用记一份出站 messages，回一句纯文本（无 tool_calls → 单轮收尾）。 */
const capturingStreamChat = (captured: Body[]) =>
  async function* (
    _url: string,
    request: { model: string; messages: ChatMessage[]; tools: unknown[] },
  ): AsyncIterable<StreamChunk> {
    captured.push({ messages: request.messages })
    yield { type: 'content_delta', text: 'ok' }
    yield { type: 'finish', reason: 'stop' }
    yield { type: 'done' }
  }

const TASK = '把 a.txt 的结论汇总成一段话'

describe('v0.41 D19 覆盖面：系统智能体与子代理的出站转写', () => {
  it('开关缺省：请求尾部仍跟着空 userTemplate（形状逐字节不变）', async () => {
    const captured: Body[] = []
    const agent = createSystemAgent({
      name: 'compressor',
      systemPrompt: 'You are the compressor.',
      toolRefs: [],
      llmStreamChat: capturingStreamChat(captured),
      url: 'https://x',
      model: 'm',
      mailbox: new Mailbox(),
      registry: new ToolRegistry(),
      stateLine: createNoopStateLine(),
    })
    await agent.run({ messages: [{ role: 'user', content: TASK }] })

    const body = captured[0]
    expect(body).toBeDefined()
    // 相邻 user 确实存在：任务消息 + 空 userTemplate。这就是严格交替 provider
    // 会 400 的形状，也是本测试存在的理由。
    expect(hasAdjacentUserMessages(body!.messages)).toBe(true)
    const last = body!.messages.at(-1)
    expect(last?.role).toBe('user')
    expect(last?.content).toBe('')
  })

  it('开关 true：相邻 user 在出站前合并，任务文本逐字保留', async () => {
    const captured: Body[] = []
    const agent = createSystemAgent({
      name: 'compressor',
      systemPrompt: 'You are the compressor.',
      toolRefs: [],
      llmStreamChat: capturingStreamChat(captured),
      url: 'https://x',
      model: 'm',
      mailbox: new Mailbox(),
      registry: new ToolRegistry(),
      stateLine: createNoopStateLine(),
      strictAlternation: true,
    })
    await agent.run({ messages: [{ role: 'user', content: TASK }] })

    const body = captured[0]!
    expect(hasAdjacentUserMessages(body.messages)).toBe(false)
    // 无损：空白段被跳过，任务文本原样在那条合并后的 user 消息里。
    const users = body.messages.filter((m) => m.role === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]!.content).toBe(TASK)
  })

  it('createSystemAgents：warehouse / compressor / recall 三个都覆盖', async () => {
    const run = async (strictAlternation: boolean): Promise<Record<string, boolean>> => {
      const captured: Body[] = []
      const agents = createSystemAgents({
        llmStreamChat: capturingStreamChat(captured),
        url: 'https://x',
        model: 'm',
        mailbox: new Mailbox(),
        registry: new ToolRegistry(),
        stateLine: createNoopStateLine(),
        ...(strictAlternation ? { strictAlternation: true } : {}),
      })
      // 三个 agent 依次各跑一次；captured 顺序 = 调用顺序。
      await agents.warehouse.run({ messages: [{ role: 'user', content: TASK }] })
      await agents.compressor.run({ messages: [{ role: 'user', content: TASK }] })
      await agents.recall.run({ messages: [{ role: 'user', content: TASK }] })
      const names = ['warehouse', 'compressor', 'recall'] as const
      const out: Record<string, boolean> = {}
      names.forEach((n, i) => {
        out[n] = hasAdjacentUserMessages(captured[i]!.messages)
      })
      return out
    }

    // 对照组：不传开关 → 三个都带相邻 user（既有形状）。
    expect(await run(false)).toEqual({ warehouse: true, compressor: true, recall: true })
    // 开关 true → 三个都不再有相邻 user。
    expect(await run(true)).toEqual({ warehouse: false, compressor: false, recall: false })
  })

  it('run_subagent：子代理 loop 也走转写', async () => {
    const runChild = async (strictAlternation: boolean): Promise<Body> => {
      const captured: Body[] = []
      const registry = new ToolRegistry()
      const subAgentRegistry = new SubAgentRegistry()
      await subAgentRegistry.register({
        name: 'reviewer',
        systemPrompt: 'You are a reviewer.',
        toolRefs: [],
      })
      const deps: RunSubagentDeps = {
        llmStreamChat: capturingStreamChat(captured),
        url: 'https://x',
        model: 'm',
        mailbox: new Mailbox(subAgentRegistry.agentTree),
        registry,
        stateLine: createNoopStateLine(),
        ...(strictAlternation ? { strictAlternation: true } : {}),
      }
      const tool = createRunSubagentTool(subAgentRegistry, deps)
      await tool.execute({ name: 'reviewer', input: TASK, reason: 'delegate the summary' })
      expect(captured.length).toBeGreaterThan(0)
      return captured[0]!
    }

    expect(hasAdjacentUserMessages((await runChild(false)).messages)).toBe(true)
    const on = await runChild(true)
    expect(hasAdjacentUserMessages(on.messages)).toBe(false)
    // 子代理的任务输入逐字保留（合并只吃空白段）。
    const users = on.messages.filter((m) => m.role === 'user')
    expect(users.some((u) => u.content === TASK)).toBe(true)
  })
})
