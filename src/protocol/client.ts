// ADR-007: protocol layer is a pure function (with an injectable fetcher for tests).
// ADR-008: 429/503 are retried 5x; other errors propagate.
// Returns an AsyncIterable<StreamChunk> so the shell can consume streaming or non-streaming responses uniformly.

import type { ChatCompletionRequest, StreamChunk, Usage } from './types.js'
import { ProtocolError } from './types.js'
import { parseSSEStream } from './stream.js'
import { withRetry } from './retry.js'

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

export type StreamOptions = {
  fetcher?: Fetcher                         // defaults to global fetch
  maxRetries?: number                       // retries for 429/503 after the first attempt (default 5)
  baseDelayMs?: number                      // first retry waits this much, doubling each time (default 100)
  onUsage: (u: Usage) => void               // shell receives usage here
  signal?: AbortSignal
}

const defaultFetcher: Fetcher = (url, init) => fetch(url, init)

const DEFAULT_MAX_RETRIES = 5
const DEFAULT_BASE_DELAY_MS = 100

// We always stream. The server may not produce [DONE] but will close the connection.
// The shell's loop will not consume the stream beyond its interest; an "ended" stream
// just stops yielding.
export async function* streamChat(
  url: string,
  request: ChatCompletionRequest,
  options: StreamOptions,
): AsyncIterable<StreamChunk> {
  const fetcher = options.fetcher ?? defaultFetcher
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS

  const doFetch = async (): Promise<Response> => {
    // The protocol layer always asks for a streaming response. The
    // OpenAI-compatible API only returns SSE when the request body
    // carries `stream: true`; without it the response is a single
    // JSON object that parseSSEStream would see as zero chunks, and
    // the IM would terminate with an empty `'completed'` answer.
    // We inject `stream: true` and `stream_options.include_usage`
    // automatically so the IM's `iter` / `token` / `time` guards are
    // reachable against every OpenAI-shaped provider. A caller that
    // explicitly sets `stream: false` keeps the caller's choice.
    const outgoing: ChatCompletionRequest = { ...request }
    if (outgoing.stream === undefined) outgoing.stream = true
    if (outgoing.stream === true) {
      const existing = (outgoing.stream_options ?? {}) as Record<string, unknown>
      outgoing.stream_options = { ...existing, include_usage: true }
    }
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(outgoing),
    }
    if (options.signal !== undefined) init.signal = options.signal

    let response: Response
    try {
      response = await fetcher(url, init)
    } catch (e) {
      // Caller-initiated abort propagates unchanged (no retry, no wrap).
      if (options.signal?.aborted) throw e
      // Connection failed before any response (DNS/TCP/TLS refusal).
      // Nothing was consumed, so retrying is safe.
      const msg = e instanceof Error ? e.message : String(e)
      throw new ProtocolError(0, `connection failed: ${msg}`, true)
    }
    if (!response.ok) {
      let body: unknown = null
      try { body = await response.json() } catch { /* keep body null */ }
      throw new ProtocolError(response.status, body, response.status === 429 || response.status === 503)
    }
    return response
  }

  const response = await withRetry(doFetch, { maxRetries, baseDelayMs })

  if (!response.body) {
    throw new ProtocolError(0, 'no response body', false)
  }

  // Forward the response body to the SSE parser, then re-emit StreamChunk events.
  try {
    for await (const ev of parseSSEStream(response.body)) {
      if (ev.data === '[DONE]') {
        yield { type: 'done' }
        return
      }
      let json: unknown
      try {
        json = JSON.parse(ev.data)
      } catch {
        // Skip non-JSON lines silently (e.g. heartbeat comments made it through).
        continue
      }
      // OpenAI streaming error frame: the stream reports a failure mid-way.
      // Partial content was already consumed, so retry is unsafe.
      if (typeof json === 'object' && json !== null) {
        const err = (json as Record<string, unknown>).error
        if (err) throw new ProtocolError(0, err, false)
      }
      yield* extractChunks(json, options.onUsage)
    }
  } catch (e) {
    if (e instanceof ProtocolError) throw e
    // Mid-stream interruption (reader.read() rejected, etc.).
    // Partial content was already consumed, so retry is unsafe.
    const msg = e instanceof Error ? e.message : String(e)
    throw new ProtocolError(0, `stream interrupted: ${msg}`, false)
  }
}

// OpenAI streaming format: each `data:` line carries a `choices[0].delta` with
// `content`, `tool_calls` (array of deltas), and at the end a top-level `usage`.
function* extractChunks(json: unknown, onUsage: (u: Usage) => void): Iterable<StreamChunk> {
  if (typeof json !== 'object' || json === null) return
  const j = json as Record<string, unknown>

  // Usage can appear on any chunk (typically the last one before [DONE]).
  if (j.usage) {
    const u = normalizeUsage(j.usage)
    if (u) {
      onUsage(u)
      yield { type: 'usage', usage: u }
    }
  }

  const choices = j.choices
  if (!Array.isArray(choices) || choices.length === 0) return
  const delta = choices[0]?.delta as Record<string, unknown> | undefined
  if (!delta) return

  if (typeof delta.content === 'string' && delta.content.length > 0) {
    yield { type: 'content_delta', text: delta.content }
  }

  // Reasoning models (GLM / DeepSeek-R1 on ARK, o1-style) stream their
  // thinking as `delta.reasoning_content` — verified against ARK
  // glm-5.3-flash 2026-09-06 (90 reasoning deltas in one streamed reply).
  // shellCall's aggregator ignores this chunk type (thinking is not reply
  // content); the signal-gate delta-bridge forwards it to the UI.
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
    yield { type: 'reasoning_delta', text: delta.reasoning_content }
  }

  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      if (typeof tc !== 'object' || tc === null) continue
      const t = tc as Record<string, unknown>
      const out: { type: 'tool_call_delta'; index: number; id?: string; name?: string; arguments_delta?: string } = {
        type: 'tool_call_delta',
        index: typeof t.index === 'number' ? t.index : 0,
      }
      if (typeof t.id === 'string') out.id = t.id
      if (typeof t.function === 'object' && t.function !== null) {
        const fn = t.function as Record<string, unknown>
        if (typeof fn.name === 'string') out.name = fn.name
        if (typeof fn.arguments === 'string') out.arguments_delta = fn.arguments
      }
      yield out
    }
  }

  const finish = (choices[0] as Record<string, unknown> | undefined)?.finish_reason
  if (typeof finish === 'string' && (finish === 'stop' || finish === 'tool_calls' || finish === 'length' || finish === 'content_filter')) {
    yield { type: 'finish', reason: finish }
  }
}

const normalizeUsage = (raw: unknown): Usage | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.prompt_tokens !== 'number' || typeof r.completion_tokens !== 'number' || typeof r.total_tokens !== 'number') {
    return null
  }
  // v0.32：推理 tokens（completion_tokens_details.reasoning_tokens，ARK 实测
  // deepseek-v4/glm-5 都带）——缺省省略，不为不支持的上游造 0 值。
  const details = r.completion_tokens_details as Record<string, unknown> | undefined
  const reasoningTokens = typeof details?.reasoning_tokens === 'number' ? details.reasoning_tokens : undefined
  return {
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    totalTokens: r.total_tokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  }
}
