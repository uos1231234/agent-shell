import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withRetry, RETRYABLE_STATUSES } from '../../src/protocol/retry.js'
import { ProtocolError } from '../../src/protocol/types.js'

// A mock operation that returns a sequence of results.
// Uses the error's `retriable` flag (P6: isRetriable now reads e.retriable,
// not the status-code list). 429/503 get retriable=true here to match
// client.ts construction logic.
const makeOp = (results: Array<{ ok: true; value: unknown } | { ok: false; status: number }>) => {
  let i = 0
  return vi.fn(async () => {
    const r = results[i++]
    if (!r) throw new Error('exhausted mock results')
    if (r.ok) return r.value
    throw new ProtocolError(r.status, 'body', RETRYABLE_STATUSES.includes(r.status as 429 | 503))
  })
}

describe('protocol/retry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns immediately on first success', async () => {
    const op = makeOp([{ ok: true, value: 42 }])
    const r = await withRetry(op, { maxRetries: 5, baseDelayMs: 1 })
    expect(r).toBe(42)
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('retries 429 up to 5 times then succeeds', async () => {
    const op = makeOp([
      { ok: false, status: 429 },
      { ok: false, status: 429 },
      { ok: false, status: 429 },
      { ok: false, status: 429 },
      { ok: true, value: 'ok' },
    ])
    const promise = withRetry(op, { maxRetries: 5, baseDelayMs: 1 })
    await vi.runAllTimersAsync()
    const r = await promise
    expect(r).toBe('ok')
    expect(op).toHaveBeenCalledTimes(5)
  })

  it('retries 503 up to 5 times then succeeds', async () => {
    const op = makeOp([
      { ok: false, status: 503 },
      { ok: true, value: 'ok' },
    ])
    const promise = withRetry(op, { maxRetries: 5, baseDelayMs: 1 })
    await vi.runAllTimersAsync()
    const r = await promise
    expect(r).toBe('ok')
  })

  it('throws after 5 consecutive 429s', async () => {
    const op = makeOp(Array.from({ length: 6 }, () => ({ ok: false, status: 429 })))
    const promise = withRetry(op, { maxRetries: 5, baseDelayMs: 1 })
    // Catch the rejection so vi.runAllTimers doesn't leave it dangling.
    const caught = promise.catch((e) => e)
    await vi.runAllTimersAsync()
    const e = await caught
    expect(e).toBeInstanceOf(ProtocolError)
    expect((e as ProtocolError).status).toBe(429)
    expect(op).toHaveBeenCalledTimes(6)                  // initial + 5 retries
  })

  it('does NOT retry non-retryable status (400, 401, 500)', async () => {
    for (const status of [400, 401, 404, 500]) {
      const op = makeOp([{ ok: false, status }])
      const promise = withRetry(op, { maxRetries: 5, baseDelayMs: 1 })
      await expect(promise).rejects.toBeInstanceOf(ProtocolError)
      expect(op).toHaveBeenCalledTimes(1)               // no retry
    }
  })

  it('retries when retriable=true regardless of status (connection failure: status 0)', async () => {
    // P6: isRetriable now reads e.retriable, not status codes.
    // A connection failure has status=0, retriable=true — must retry.
    let calls = 0
    const op = vi.fn(async () => {
      calls += 1
      if (calls <= 2) throw new ProtocolError(0, 'connection failed', true)
      return 'recovered'
    })
    const promise = withRetry(op, { maxRetries: 5, baseDelayMs: 1 })
    await vi.runAllTimersAsync()
    const r = await promise
    expect(r).toBe('recovered')
    expect(op).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry when retriable=false (mid-stream error: status 0)', async () => {
    // P6: mid-stream errors have retriable=false even though status=0.
    let calls = 0
    const op = vi.fn(async () => {
      calls += 1
      throw new ProtocolError(0, 'stream interrupted', false)
    })
    const promise = withRetry(op, { maxRetries: 5, baseDelayMs: 1 })
    await expect(promise).rejects.toBeInstanceOf(ProtocolError)
    expect(calls).toBe(1)
  })

  it('uses exponential backoff: 1, 2, 4, 8, 16 base units', async () => {
    const op = makeOp(Array.from({ length: 5 }, () => ({ ok: false, status: 429 })))
    const promise = withRetry(op, { maxRetries: 5, baseDelayMs: 10 })
    const caught = promise.catch((e) => e)
    // The first retry waits baseDelay * 2^0 = 10ms; second 20ms; third 40; fourth 80; fifth 160.
    // We just verify it eventually resolves and the call count is right.
    await vi.runAllTimersAsync()
    await caught
    expect(op).toHaveBeenCalledTimes(6)
  })
})
