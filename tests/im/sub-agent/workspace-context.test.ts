// v0.34 D13：子代理工作区级上下文**接线验收**（AGENTS.md 层叠 + 四类注入）。
//
// 用户拍板（2026-09-10）：「子代理拿不到 AGENTS.md / ContextInjector 注入也需要执行」。
//
// 为什么需要这个测试：单测能证明 createSystemAgent 支持 contextInjector、run-subagent
// 会拼 layeredPrompt，但证明不了「装配层真的把它们传下去了」——那正是本项目反复
// 出现的「实现≠接线≠生效」（AGENTS.md §5）。本测试走**真实链路**：
//   registerSystemAgentTools（生产注册路径）→ run_subagent 工具 → createSystemAgent
//   → 子代理自己的 runIMLoop；用 scripted LLM 捕获子代理实际收到的 messages。
//
// 断言方式：scriptedStreamChat 的第二参就是完整请求体（含 messages），所以能直接
// 检查子代理系统提示词的内容与顺序，以及注入内容是否落到子代理上下文里。

import { describe, it, expect } from 'vitest'
import { runIMLoop, type IMLoopOptions } from '../../../src/im/loop.js'
import { ToolRegistry } from '../../../src/shell/registry.js'
import { createConfig } from '../../../src/shell/config.js'
import { ConversationMemory } from '../../../src/im/conversation-memory.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import { createNoopStateLine } from '../../../src/im/state-line/index.js'
import { registerSystemAgentTools } from '../../../src/im/system-agents/register.js'
import { SubAgentRegistry } from '../../../src/im/sub-agent/index.js'
import { ContextInjector } from '../../../src/im/hooks/context-injection.js'
import type { SystemAgent } from '../../../src/im/system-agent.js'
import type { ChatMessage, StreamChunk, ChatCompletionResponse } from '../../../src/protocol/types.js'

const noopSystemAgent: SystemAgent = {
  run: async () => { throw new Error('noop') },
  stop() {},
  send() {},
}

const AGENTS_MD = '# 项目约定\n这是 AGENTS.md 里的项目约定，子代理必须看到。'
const WORKSPACE = '/tmp/ws-d13'

/** 捕获每次 LLM 调用的 messages，供断言（子代理与工作代理共用一个 closure）。 */
const capturingStreamChat = (
  responses: ChatCompletionResponse[],
  captured: ChatMessage[][],
): IMLoopOptions['streamChat'] => {
  let i = 0
  return async function* (_url, request): AsyncIterable<StreamChunk> {
    captured.push(request.messages as ChatMessage[])
    const r = responses[i++]
    if (!r) return
    const msg = r.choices[0]?.message
    if (typeof msg?.content === 'string' && msg.content.length > 0) {
      yield { type: 'content_delta', text: msg.content }
    }
    if (msg?.tool_calls) {
      for (let k = 0; k < msg.tool_calls.length; k += 1) {
        const tc = msg.tool_calls[k]!
        yield { type: 'tool_call_delta', index: k, id: tc.id, name: tc.function.name }
        yield { type: 'tool_call_delta', index: k, arguments_delta: tc.function.arguments }
      }
    }
    yield { type: 'finish', reason: r.choices[0]?.finish_reason ?? 'stop' }
    if (r.usage) yield { type: 'usage', usage: r.usage }
    yield { type: 'done' }
  }
}

const systemTextOf = (messages: ChatMessage[]): string =>
  messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n---\n')

const allTextOf = (messages: ChatMessage[]): string =>
  messages
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n')

describe('D13：子代理拿到 AGENTS.md 与 ContextInjector 注入（接线验收）', () => {
  it('子代理系统提示词 = 工作区声明 → AGENTS.md 层叠 → 角色定义；且注入落到子代理上下文', async () => {
    const captured: ChatMessage[][] = []
    const responses: ChatCompletionResponse[] = [
      // 1) 工作代理 round 1：调用 run_subagent
      {
        id: 'w1', model: 'gpt-4',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'run_subagent', arguments: JSON.stringify({ name: 'reviewer', input: 'check this', reason: 'test' }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      // 2) 子代理 round 1：直接收尾
      {
        id: 's1', model: 'gpt-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'review complete' }, finish_reason: 'stop' }],
        usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
      },
      // 3) 工作代理 round 2：收尾
      {
        id: 'w2', model: 'gpt-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
        usage: { promptTokens: 30, completionTokens: 5, totalTokens: 35 },
      },
    ]

    const streamChat = capturingStreamChat(responses, captured)
    const registry = new ToolRegistry()
    const subAgentRegistry = new SubAgentRegistry()
    const mailbox = new Mailbox(subAgentRegistry.agentTree)
    const conversationMemory = new ConversationMemory()
    const stateLine = createNoopStateLine()

    await subAgentRegistry.register({
      name: 'reviewer',
      systemPrompt: 'You are a reviewer.',
      toolRefs: [],
    })

    // 注入源：内容带 agentId，用来证明注入器 **按子代理自己的身份** 求值，
    // 而不是把工作代理的上下文原样塞给子代理。
    const contextInjector = new ContextInjector()
    contextInjector.register({
      name: 'd13-probe',
      priority: 1,
      position: 'afterSystem',
      inject: async (ctx) => `INJECTED-FOR:${ctx.agentId}`,
    })

    // ---- 生产注册路径：contextInjector / layeredPrompt 经 subAgentDeps 下发 ----
    registerSystemAgentTools(
      registry,
      mailbox,
      { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
      subAgentRegistry,
      {
        llmStreamChat: streamChat as never,
        url: 'http://test',
        model: 'gpt-4',
        stateLine,
        workDir: WORKSPACE,
        contextInjector,
        layeredPrompt: AGENTS_MD,
      },
    )

    const loopOpts: IMLoopOptions = {
      config: createConfig(),
      registry,
      databus: subAgentRegistry.agentTree.root.ownDatabus,
      conversationMemory,
      workingAgentId: 'main',
      mailbox,
      systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
      streamChat: streamChat as never,
      url: 'http://test',
      model: 'gpt-4',
      systemPrompt: 'You are the working agent.',
      userTemplate: 'please review',
      systemToolRefs: ['run_subagent'],
      mcpRefs: [],
      skillRefs: [],
      stateLine,
      subAgentDepth: 0,
    }

    const result = await runIMLoop(loopOpts)
    expect(result.reason).toBe('completed')

    // 找出子代理那一次请求（系统提示词里含角色定义）。
    const subReq = captured.find((msgs) => systemTextOf(msgs).includes('You are a reviewer.'))
    expect(subReq, 'expected the sub-agent to make an LLM call').toBeDefined()
    const sys = systemTextOf(subReq!)

    // ---- 1) AGENTS.md 层叠真的进了子代理提示词（D13 核心）----
    expect(sys).toContain(AGENTS_MD)

    // ---- 2) 工作区声明也在（既有行为未被破坏）----
    expect(sys).toContain(WORKSPACE)

    // ---- 3) v0.38 顺序：角色定义 → 工作区声明 → 纪律基底 → AGENTS.md ----
    // 用户 2026-09-12 拍板：身份先锚定（角色置顶），再由一般（纪律）到特殊（项目约定）。
    const iRole = sys.indexOf('You are a reviewer.')
    const iWs = sys.indexOf(WORKSPACE)
    const iDiscipline = sys.indexOf('# Reporting Back')
    const iAgents = sys.indexOf(AGENTS_MD)
    expect(iRole).toBe(0)
    expect(iWs).toBeGreaterThan(iRole)
    expect(iDiscipline).toBeGreaterThan(iWs)
    expect(iAgents).toBeGreaterThan(iDiscipline)

    // ---- 4) ContextInjector 真的落到子代理上下文，且按子代理自己的 agentId 求值 ----
    const subAll = allTextOf(subReq!)
    expect(subAll).toContain('INJECTED-FOR:reviewer-')
    // 不能是工作代理的身份——若注入器被错接成父代理上下文，这里会看到 :main
    expect(subAll).not.toContain('INJECTED-FOR:main')
  })

  it('缺省不传时行为不变（旧调用方/测试向后兼容）', async () => {
    const captured: ChatMessage[][] = []
    const responses: ChatCompletionResponse[] = [
      {
        id: 'w1', model: 'gpt-4',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'run_subagent', arguments: JSON.stringify({ name: 'plain', input: 'x', reason: 'test' }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      },
      { id: 's1', model: 'gpt-4', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] },
      { id: 'w2', model: 'gpt-4', choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] },
    ]
    const streamChat = capturingStreamChat(responses, captured)
    const registry = new ToolRegistry()
    const subAgentRegistry = new SubAgentRegistry()
    const mailbox = new Mailbox(subAgentRegistry.agentTree)
    const stateLine = createNoopStateLine()

    await subAgentRegistry.register({ name: 'plain', systemPrompt: 'PLAIN_ROLE', toolRefs: [] })

    registerSystemAgentTools(
      registry, mailbox,
      { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
      subAgentRegistry,
      { llmStreamChat: streamChat as never, url: 'http://test', model: 'gpt-4', stateLine },
    )

    await runIMLoop({
      config: createConfig(), registry,
      databus: subAgentRegistry.agentTree.root.ownDatabus,
      conversationMemory: new ConversationMemory(),
      workingAgentId: 'main', mailbox,
      systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
      streamChat: streamChat as never, url: 'http://test', model: 'gpt-4',
      systemPrompt: 'You are the working agent.', userTemplate: 'go',
      systemToolRefs: ['run_subagent'], mcpRefs: [], skillRefs: [], stateLine, subAgentDepth: 0,
    })

    const subReq = captured.find((msgs) => systemTextOf(msgs).includes('PLAIN_ROLE'))
    expect(subReq).toBeDefined()
    // v0.38：没传 workDir/AGENTS.md/contextInjector 时，提示词 = 角色定义 +
    // 纪律基底（MINIMAL，所有子代理共享的硬底线）。此前纪律基底从不参与
    // 子代理组装，旧语义是"纯角色定义"，现改为"角色 + 纪律"。
    const sys = systemTextOf(subReq!)
    expect(sys.startsWith('PLAIN_ROLE')).toBe(true)
    expect(sys).toContain('# Reporting Back')
  })
})
