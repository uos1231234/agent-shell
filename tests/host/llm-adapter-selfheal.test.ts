// v0.32 — llm-adapter 400 自愈 + reasoningTokens 贯通。
//
// 覆盖：
//   - 400 thinking 字段拒绝 → 剔除 thinking extra 透明重试（loop 只见成功流），
//     onHeal 通知一次；同实例后续请求不再发送 thinking
//   - 非 400 / 无关 400 / 无 thinking extra → 原样抛出（窄匹配不误伤）
//   - normalizeUsage 解析 completion_tokens_details.reasoning_tokens；缺失省略
//   - addUsage 累计 reasoningTokens（缺省 0）

import { describe, it, expect, vi } from 'vitest'
import { createRealLLMStreamChat } from '../../src/host/llm-adapter.js'
import { streamChat } from '../../src/protocol/client.js'
import { addUsage, createMetrics } from '../../src/shell/metrics.js'

// ---- 可编程 fetcher：按请求次序返回响应 ----
const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'

const makeFetcher = (bodies: Array<{ status: number; body: string }>) => {
  let call = 0
  const seenBodies: Array<Record<string, unknown>> = []
  const fetcher = async (_url: string, init: RequestInit): Promise<Response> => {
    seenBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    const b = bodies[Math.min(call, bodies.length - 1)]!
    call++
    return new Response(b.body, { status: b.status, headers: { 'content-type': 'text/event-stream' } })
  }
  return { fetcher, seenBodies }
}

const collect = async (chunks: AsyncIterable<{ type: string }>): Promise<string[]> => {
  const out: string[] = []
  for await (const c of chunks) out.push(c.type)
  return out
}

describe('llm-adapter 400 self-heal', () => {
  it('thinking rejection → strips thinking extra, retries transparently, heals persist', async () => {
    const reject400 =
      JSON.stringify({ error: { code: 'InvalidParameter', message: "thinking.type `disabled` is not supported by this model" } })
    const { fetcher, seenBodies } = makeFetcher([
      { status: 400, body: reject400 },
      { status: 200, body: sse },
      { status: 200, body: sse },
    ])
    const onHeal = vi.fn()
    const sc = createRealLLMStreamChat({
      url: 'https://x/chat',
      apiKey: 'k',
      model: 'm',
      requestExtras: { thinking: { type: 'enabled', reasoning_effort: 'max' }, max_tokens: 100 },
      onHeal,
      fetcher,
    })
    const sc2 = sc as (url: string, request: Record<string, unknown>) => AsyncIterable<{ type: string }>
    const types = await collect(sc2('https://x/chat', { model: 'm', messages: [] }))
    expect(types).toContain('done') // loop 只看到成功流
    await collect(sc2('https://x/chat', { model: 'm', messages: [] })) // 第二次调用验证记忆
    expect(onHeal).toHaveBeenCalledTimes(1)
    expect(onHeal).toHaveBeenCalledWith('thinking')
    expect(seenBodies[0]!['thinking']).toBeDefined() // 首次带 thinking
    expect(seenBodies[1]!['thinking']).toBeUndefined() // 重试已剔除
    expect(seenBodies[1]!['max_tokens']).toBe(100) // 无关 extra 不误伤
    expect(seenBodies[2]!['thinking']).toBeUndefined() // 记忆持续剔除
  })

  it('reasoning_effort rejection message also heals (strips the whole thinking extra)', async () => {
    const reject400 =
      JSON.stringify({ error: { code: 'InvalidParameter', message: 'The parameter `reasoning_effort` specified in the request are not valid: value `off` is invalid.' } })
    const { fetcher, seenBodies } = makeFetcher([
      { status: 400, body: reject400 },
      { status: 200, body: sse },
    ])
    const sc = createRealLLMStreamChat({
      url: 'https://x/chat',
      apiKey: 'k',
      model: 'm',
      requestExtras: { thinking: { type: 'enabled', reasoning_effort: 'off' } },
      fetcher,
    })
    await collect((sc as (url: string, request: Record<string, unknown>) => AsyncIterable<{ type: string }>)('https://x/chat', { model: 'm', messages: [] }))
    expect(seenBodies[1]!['thinking']).toBeUndefined()
  })

  it('unrelated 400 passes through unchanged (narrow match, no false heal)', async () => {
    const reject400 = JSON.stringify({ error: { message: 'max_tokens too large' } })
    const { fetcher } = makeFetcher([{ status: 400, body: reject400 }])
    const onHeal = vi.fn()
    const sc = createRealLLMStreamChat({
      url: 'https://x/chat',
      apiKey: 'k',
      model: 'm',
      requestExtras: { thinking: { type: 'enabled', reasoning_effort: 'max' } },
      onHeal,
      fetcher,
    })
    await expect(
      collect((sc as (url: string, request: Record<string, unknown>) => AsyncIterable<{ type: string }>)('https://x/chat', { model: 'm', messages: [] })),
    ).rejects.toThrow()
    expect(onHeal).not.toHaveBeenCalled()
    void fetcher
  })
})

describe('usage reasoning_tokens', () => {
  it('normalizeUsage parses completion_tokens_details.reasoning_tokens', async () => {
    const frames =
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"completion_tokens_details":{"reasoning_tokens":12}}}\n\n'
      + 'data: [DONE]\n\n'
    let got: unknown
    for await (const c of streamChat('https://x', { model: 'm', messages: [] }, {
      fetcher: async () => new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      onUsage: () => {},
    })) {
      if (c.type === 'usage') got = (c as { usage: unknown }).usage
    }
    expect(got).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30, reasoningTokens: 12 })
  })

  it('missing details → reasoningTokens omitted', async () => {
    const frames =
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n'
      + 'data: [DONE]\n\n'
    let got: unknown
    for await (const c of streamChat('https://x', { model: 'm', messages: [] }, {
      fetcher: async () => new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      onUsage: () => {},
    })) {
      if (c.type === 'usage') got = (c as { usage: unknown }).usage
    }
    expect(got).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 })
  })

  it('addUsage accumulates reasoningTokens (absent counts as 0)', () => {
    let m = createMetrics()
    m = addUsage(m, { promptTokens: 1, completionTokens: 2, totalTokens: 3, reasoningTokens: 5 })
    m = addUsage(m, { promptTokens: 1, completionTokens: 2, totalTokens: 3 })
    expect(m.reasoningTokens).toBe(5)
  })
})
