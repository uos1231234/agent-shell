import { describe, it, expect } from 'vitest'
import { parseSSEStream, type SSEEvent } from '../../src/protocol/stream.js'

// Helper: turn a multi-line SSE blob into a ReadableStream<Uint8Array>
const blob = (s: string): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(s))
      controller.close()
    },
  })
}

const collect = async (stream: ReadableStream<Uint8Array>): Promise<SSEEvent[]> => {
  const out: SSEEvent[] = []
  for await (const ev of parseSSEStream(stream)) {
    out.push(ev)
  }
  return out
}

describe('protocol/stream', () => {
  it('parses a single complete SSE event', async () => {
    const evs = await collect(blob('data: {"a":1}\n\n'))
    expect(evs).toEqual([{ data: '{"a":1}' }])
  })

  it('parses multiple events in one chunk', async () => {
    const evs = await collect(blob('data: a\n\ndata: b\n\n'))
    expect(evs).toEqual([{ data: 'a' }, { data: 'b' }])
  })

  it('handles chunk boundaries within an event (partial line)', async () => {
    // Two chunks that together form one SSE event
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: hel'))
        controller.enqueue(enc.encode('lo\n\n'))
        controller.close()
      },
    })
    const evs = await collect(stream)
    expect(evs).toEqual([{ data: 'hello' }])
  })

  it('handles line boundaries within a chunk (split at \n)', async () => {
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: first\n'))
        controller.enqueue(enc.encode('\ndata: second\n\n'))
        controller.close()
      },
    })
    const evs = await collect(stream)
    expect(evs).toEqual([{ data: 'first' }, { data: 'second' }])
  })

  it('ignores comment lines (starting with :)', async () => {
    const evs = await collect(blob(': this is a comment\ndata: payload\n\n'))
    expect(evs).toEqual([{ data: 'payload' }])
  })

  it('captures event type when present', async () => {
    const evs = await collect(blob('event: message\ndata: hello\n\n'))
    expect(evs).toEqual([{ event: 'message', data: 'hello' }])
  })

  it('joins multi-line `data:` fields with newlines', async () => {
    const evs = await collect(blob('data: line1\ndata: line2\n\n'))
    expect(evs).toEqual([{ data: 'line1\nline2' }])
  })

  it('emits nothing for an empty stream', async () => {
    const evs = await collect(blob(''))
    expect(evs).toEqual([])
  })

  it('emits the [DONE] sentinel as a data event (parser is protocol-agnostic)', async () => {
    const evs = await collect(blob('data: [DONE]\n\n'))
    expect(evs).toEqual([{ data: '[DONE]' }])
  })

  it('throws when a single SSE event exceeds 1MB without a terminator', async () => {
    // > 1MB of data with no \n\n terminator — malformed / malicious stream.
    const big = 'x'.repeat(1024 * 1024 + 1)
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(`data: ${big}`))
        controller.close()
      },
    })
    await expect(collect(stream)).rejects.toThrow(/malformed/)
  })
})
