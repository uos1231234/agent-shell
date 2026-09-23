// v0.41 D19 — shell/call.ts 的出站转写接线测试。
//
// 钉住三件事：
//  (1) 开关缺省 / false 时，出站 wire 与 FinalPrompt **逐字节相同**——既有
//      OpenAI 兼容会话零行为变化，这是"最小接入口径"的硬判据；
//  (2) 开关 true 时相邻 user 在出站前被合并，且这是唯一应用点（所有注入的
//      streamChat 都经过它，包括测试用的 fake——放在 protocol/client.ts 里
//      就会被绕过，测试永远抓不到交替问题）；
//  (3) lastRequestTokens 的文本估算 fallback 用的是**规范化后**的数组——
//      否则估算的是一个从未真正发出去的形状。

import { describe, it, expect } from 'vitest'
import { shellCall, type ShellDeps } from '../../src/shell/call.js'
import { ToolRegistry } from '../../src/shell/registry.js'
import { createConfig } from '../../src/shell/config.js'
import { createMetrics } from '../../src/shell/metrics.js'
import type { FinalPrompt } from '../../src/shell/compose.js'
import type { ChatMessage, StreamChunk } from '../../src/protocol/types.js'
import { normalizeStrictAlternation } from '../../src/protocol/messages.js'

type Captured = { url: string; messages: ChatMessage[]; tools: unknown }

/** usage 可选：不给时 call.ts 走 JSON.stringify 长度 / 4 的文本估算 fallback。 */
const fakeStreamChat = (captured: Captured[], withUsage: boolean) =>
  async function* (
    url: string,
    request: { model: string; messages: FinalPrompt['messages']; tools?: FinalPrompt['tools'] },
  ): AsyncIterable<StreamChunk> {
    captured.push({ url, messages: request.messages, tools: request.tools })
    yield { type: 'content_delta', text: 'ok' }
    yield { type: 'finish', reason: 'stop' }
    if (withUsage) {
      yield { type: 'usage', usage: { promptTokens: 777, completionTokens: 1, totalTokens: 778 } }
    }
    yield { type: 'done' }
  }

const buildDeps = (captured: Captured[], opts: { strictAlternation?: boolean; withUsage?: boolean }): ShellDeps => ({
  config: createConfig(),
  registry: new ToolRegistry(),
  state: 'Running',
  metrics: createMetrics(),
  streamChat: fakeStreamChat(captured, opts.withUsage ?? true) as ShellDeps['streamChat'],
  url: 'https://api.example.com/v1/chat/completions',
  model: 'gpt-4',
  ...(opts.strictAlternation !== undefined ? { strictAlternation: opts.strictAlternation } : {}),
})

/** goal 模式的真实出站形状：信封 user 紧邻续跑提醒 user。 */
const promptWithAdjacentUsers = (): FinalPrompt => ({
  messages: [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: '#STAMP S-1\n#LAYER M1\n[结论] 旧结论\n#END_BLOCK' },
    { role: 'user', content: '#GOAL_CONTINUATION\n#OBJECTIVE 写出 a.txt\n#END_GOAL' },
    { role: 'assistant', content: '继续' },
  ],
  tools: [],
})

const promptAlreadyAlternating = (): FinalPrompt => ({
  messages: [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '回答' },
  ],
  tools: [],
})

describe('shellCall — strictAlternation 缺省时零行为变化', () => {
  it('不传该字段：出站 messages 与 FinalPrompt 逐条相同（相邻 user 原样发出）', async () => {
    const captured: Captured[] = []
    const request = promptWithAdjacentUsers()
    await shellCall(buildDeps(captured, {}), request)

    expect(captured).toHaveLength(1)
    expect(captured[0]!.messages).toEqual(request.messages)
    expect(captured[0]!.messages).toHaveLength(4)
    expect(captured[0]!.messages[1]!.role).toBe('user')
    expect(captured[0]!.messages[2]!.role).toBe('user')
  })

  it('显式 false：同样不转写', async () => {
    const captured: Captured[] = []
    const request = promptWithAdjacentUsers()
    await shellCall(buildDeps(captured, { strictAlternation: false }), request)

    expect(captured[0]!.messages).toEqual(request.messages)
  })
})

describe('shellCall — strictAlternation 为 true 时出站前合并', () => {
  it('相邻 user 被合并成一条，其余消息不动', async () => {
    const captured: Captured[] = []
    await shellCall(buildDeps(captured, { strictAlternation: true }), promptWithAdjacentUsers())

    const out = captured[0]!.messages
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant'])
    const merged = out[1]!
    expect(merged.role).toBe('user')
    const content = typeof merged.content === 'string' ? merged.content : ''
    expect(content).toContain('#STAMP S-1')
    expect(content).toContain('#GOAL_CONTINUATION')
    expect(content).toContain('#OBJECTIVE 写出 a.txt')
  })

  it('已交替的序列不被改动', async () => {
    const captured: Captured[] = []
    const request = promptAlreadyAlternating()
    await shellCall(buildDeps(captured, { strictAlternation: true }), request)
    expect(captured[0]!.messages).toEqual(request.messages)
  })

  it('空 tools 数组仍然被省略（既有适配不受转写影响）', async () => {
    const captured: Captured[] = []
    await shellCall(buildDeps(captured, { strictAlternation: true }), promptWithAdjacentUsers())
    expect(captured[0]!.tools).toBeUndefined()
  })
})

describe('shellCall — lastRequestTokens 的估算口径与出站一致', () => {
  it('provider 给了 usage 时直接用 usage，与转写无关', async () => {
    const captured: Captured[] = []
    const r = await shellCall(buildDeps(captured, { strictAlternation: true }), promptWithAdjacentUsers())
    expect(r.updatedMetrics.lastRequestTokens).toBe(777)
  })

  it('无 usage 时用**规范化后**的数组估算，而不是原始 FinalPrompt', async () => {
    const captured: Captured[] = []
    const request = promptWithAdjacentUsers()
    const r = await shellCall(buildDeps(captured, { strictAlternation: true, withUsage: false }), request)

    const normalized = normalizeStrictAlternation(request.messages)
    expect(r.updatedMetrics.lastRequestTokens).toBe(Math.ceil(JSON.stringify(normalized).length / 4))
    // 且确实与"按原始数组估算"不同——否则这条断言证明不了口径修正
    const naive = Math.ceil(JSON.stringify(request.messages).length / 4)
    expect(r.updatedMetrics.lastRequestTokens).not.toBe(naive)
    // 出站的就是规范化后的那份
    expect(captured[0]!.messages).toEqual(normalized)
  })

  it('开关关闭时估算仍按原始数组（零行为变化）', async () => {
    const captured: Captured[] = []
    const request = promptWithAdjacentUsers()
    const r = await shellCall(buildDeps(captured, { withUsage: false }), request)
    expect(r.updatedMetrics.lastRequestTokens).toBe(Math.ceil(JSON.stringify(request.messages).length / 4))
  })
})
