import { describe, it, expect } from 'vitest'
import { streamChat, type StreamOptions } from '../../src/protocol/client.js'
import type { ChatCompletionRequest, StreamChunk } from '../../src/protocol/types.js'
import { ProtocolError } from '../../src/protocol/types.js'
import { parseSSEStream } from '../../src/protocol/stream.js'
import {
  accumulateToolCall,
  finalizeToolCalls,
  type ToolCallAccumulator,
} from '../../src/protocol/tool-calls.js'

// ---------- Test fixtures ----------

const echoParams = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } as const

const makeRequest = (): ChatCompletionRequest => ({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{
    type: 'function',
    function: { name: 'echo', description: 'echo', parameters: echoParams },
  }],
})

// ---------- Tool execution path ----------

describe('protocol tool execution (integrates with shell/registry)', () => {
  it('reconstructs a complete tool call from streamed deltas', () => {
    let acc: ToolCallAccumulator = { id: '', name: '', arguments: '' }
    acc = accumulateToolCall(acc, { index: 0, id: 'tc-2', name: 'echo' })
    acc = accumulateToolCall(acc, { index: 0, arguments_delta: '{"x":"' })
    acc = accumulateToolCall(acc, { index: 0, arguments_delta: 'world"}' })
    const finalized = finalizeToolCalls([acc])
    expect(finalized[0]?.function.arguments).toBe('{"x":"world"}')
  })
})

// ---------- Stream parsing from a fake response ----------

describe('protocol SSE → StreamChunk conversion', () => {
  it('yields content_delta then finish chunks for a simple text response', async () => {
    const enc = new TextEncoder()
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode(sseBody)); c.close() },
    })
    const events: StreamChunk[] = []
    for await (const ev of parseSSEStream(stream)) {
      if (ev.data === '[DONE]') {
        events.push({ type: 'done' })
        continue
      }
      const json = JSON.parse(ev.data)
      const delta = json.choices?.[0]?.delta
      if (delta?.content) events.push({ type: 'content_delta', text: delta.content })
      if (json.usage) {
        events.push({
          type: 'usage',
          usage: { promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens, totalTokens: json.usage.total_tokens },
        })
      }
    }
    expect(events).toEqual([
      { type: 'content_delta', text: 'Hello' },
      { type: 'content_delta', text: ' world' },
      { type: 'usage', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } },
      { type: 'done' },
    ])
  })
})

// ---------- streamChat happy path: uses a custom fetcher ----------

describe('streamChat (with injected fetcher)', () => {
  it('sends the request body to the URL and returns parsed chunks', async () => {
    let receivedUrl: string | undefined
    let receivedBody: unknown
    const fetcher: typeof fetch = async (url, init) => {
      receivedUrl = String(url)
      receivedBody = JSON.parse(String(init?.body))
      const enc = new TextEncoder()
      return new Response(
        enc.encode([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: [DONE]\n\n',
        ].join('')),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }
    const opts: StreamOptions = { fetcher, maxRetries: 5, baseDelayMs: 1, onUsage: () => {} }
    const chunks: StreamChunk[] = []
    for await (const c of streamChat('https://api.example.com/v1/chat/completions', makeRequest(), opts)) {
      chunks.push(c)
    }
    expect(receivedUrl).toBe('https://api.example.com/v1/chat/completions')
    expect((receivedBody as ChatCompletionRequest).model).toBe('gpt-4')
    expect((receivedBody as ChatCompletionRequest).messages[0]).toEqual({ role: 'user', content: 'hi' })
    expect((receivedBody as ChatCompletionRequest).tools).toHaveLength(1)
    expect(chunks).toEqual([
      { type: 'content_delta', text: 'ok' },
      { type: 'done' },
    ])
  })

  it('calls onUsage with the usage object when the stream ends with usage data', async () => {
    const usage: unknown[] = []
    const enc = new TextEncoder()
    const fetcher: typeof fetch = async () =>
      new Response(
        enc.encode([
          'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
          'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
          'data: [DONE]\n\n',
        ].join('')),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    const opts: StreamOptions = { fetcher, maxRetries: 5, baseDelayMs: 1, onUsage: (u) => usage.push(u) }
    for await (const _ of streamChat('https://x', makeRequest(), opts)) { /* drain */ }
    expect(usage).toEqual([{ promptTokens: 3, completionTokens: 1, totalTokens: 4 }])
  })

  it('auto-injects stream: true and stream_options.include_usage when the caller did not set them', async () => {
    // The OpenAI-shaped API only returns SSE when the request body carries
    // `stream: true`. Without it the response is a single JSON object and
    // the IM loop would terminate with an empty 'completed' answer. The
    // protocol layer injects both fields so the IM's `iter` / `token` /
    // `time` guards are reachable on every OpenAI-shaped provider.
    let receivedBody: unknown
    const enc = new TextEncoder()
    const fetcher: typeof fetch = async (_url, init) => {
      receivedBody = JSON.parse(String(init?.body))
      return new Response(enc.encode('data: [DONE]\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const opts: StreamOptions = { fetcher, maxRetries: 0, baseDelayMs: 1, onUsage: () => {} }
    for await (const _ of streamChat('https://x', makeRequest(), opts)) { /* drain */ }
    const body = receivedBody as ChatCompletionRequest
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('preserves a caller-supplied stream: false (does not override to true)', async () => {
    // If a caller really wants the non-streaming path, the protocol layer
    // must respect that. (Today the only caller is tests; the rule still
    // matters for direct integrations.)
    let receivedBody: unknown
    const enc = new TextEncoder()
    const fetcher: typeof fetch = async (_url, init) => {
      receivedBody = JSON.parse(String(init?.body))
      return new Response(enc.encode('data: [DONE]\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const opts: StreamOptions = { fetcher, maxRetries: 0, baseDelayMs: 1, onUsage: () => {} }
    const req: ChatCompletionRequest = { ...makeRequest(), stream: false }
    for await (const _ of streamChat('https://x', req, opts)) { /* drain */ }
    const body = receivedBody as ChatCompletionRequest
    expect(body.stream).toBe(false)
    // stream_options is NOT auto-injected when stream: false — the
    // include_usage opt-in only makes sense on the streaming path.
    expect(body.stream_options).toBeUndefined()
  })

  it('throws ProtocolError on non-2xx status', async () => {
    const fetcher: typeof fetch = async () =>
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
    const opts: StreamOptions = { fetcher, maxRetries: 5, baseDelayMs: 1, onUsage: () => {} }
    const iter = streamChat('https://x', makeRequest(), opts)[Symbol.asyncIterator]()
    await expect(iter.next()).rejects.toThrow(/401/)
  })

  it('retries 429 up to 5 times then propagates', async () => {
    let count = 0
    const enc = new TextEncoder()
    const fetcher: typeof fetch = async () => {
      count += 1
      if (count <= 5) return new Response('rate limit', { status: 429 })
      return new Response(
        enc.encode(['data: [DONE]\n\n'].join('')),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }
    const opts: StreamOptions = { fetcher, maxRetries: 5, baseDelayMs: 1, onUsage: () => {} }
    const iter = streamChat('https://x', makeRequest(), opts)
    // 5 retries of 429 then a 200 — the 6th call returns a single [DONE] event
    // so the loop terminates cleanly without throwing. We just check that the
    // fetcher was called exactly 6 times.
    let chunks = 0
    for await (const _ of iter) chunks += 1
    expect(count).toBe(6)
    // The 6th call returns a single [DONE] event; the parser turns that
    // into a `{ type: 'done' }` chunk before returning. We expect at
    // most one terminal chunk, no content deltas.
    expect(chunks).toBe(1)
  })

  // ---- P6: connection failure → ProtocolError(retriable=true) ----

  it('wraps connection failure (fetcher rejects) as ProtocolError with retriable=true', async () => {
    const fetcher: typeof fetch = async () => {
      throw new TypeError('getaddrinfo ENOTFOUND api.example.com')
    }
    const opts: StreamOptions = { fetcher, maxRetries: 2, baseDelayMs: 1, onUsage: () => {} }
    const iter = streamChat('https://x', makeRequest(), opts)[Symbol.asyncIterator]()
    let e: unknown
    try {
      await iter.next()
    } catch (err) {
      e = err
    }
    expect(e).toBeInstanceOf(ProtocolError)
    const pe = e as ProtocolError
    expect(pe.retriable).toBe(true)
    expect(pe.status).toBe(0)
    expect(pe.message).toContain('connection failed')
  })

  // ---- P6: OpenAI streaming error frame → ProtocolError(retriable=false) ----

  it('throws ProtocolError with retriable=false on a streaming error frame', async () => {
    const enc = new TextEncoder()
    const fetcher: typeof fetch = async () =>
      new Response(
        enc.encode([
          'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
          'data: {"error":{"message":"boom","type":"server_error"}}\n\n',
        ].join('')),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    const opts: StreamOptions = { fetcher, maxRetries: 5, baseDelayMs: 1, onUsage: () => {} }
    const iter = streamChat('https://x', makeRequest(), opts)[Symbol.asyncIterator]()
    // First chunk (content_delta) is fine
    const first = await iter.next()
    expect(first.value).toEqual({ type: 'content_delta', text: 'partial' })
    // Next should throw because of the error frame
    let e: unknown
    try {
      await iter.next()
    } catch (err) {
      e = err
    }
    expect(e).toBeInstanceOf(ProtocolError)
    const pe = e as ProtocolError
    expect(pe.retriable).toBe(false)
  })

  // ---- P6: mid-stream read() rejection → ProtocolError(retriable=false) ----

  it('wraps mid-stream read() rejection as ProtocolError with retriable=false', async () => {
    // Create a stream that yields one chunk, then errors on the next read.
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'))
      },
      pull(c) {
        // Simulate a network drop on the second read.
        c.error(new Error('network reset'))
      },
    })
    const fetcher: typeof fetch = async () =>
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const opts: StreamOptions = { fetcher, maxRetries: 5, baseDelayMs: 1, onUsage: () => {} }
    const iter = streamChat('https://x', makeRequest(), opts)[Symbol.asyncIterator]()
    // First chunk (content_delta) is fine
    const first = await iter.next()
    expect(first.value).toEqual({ type: 'content_delta', text: 'x' })
    // Next should throw — stream interrupted, not retriable
    let e: unknown
    try {
      await iter.next()
    } catch (err) {
      e = err
    }
    expect(e).toBeInstanceOf(ProtocolError)
    const pe = e as ProtocolError
    expect(pe.retriable).toBe(false)
    expect(pe.message).toContain('stream interrupted')
  })
})
