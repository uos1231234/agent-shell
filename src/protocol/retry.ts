// ADR-008: retry decisions are driven by the error's `retriable` flag,
// not a hardcoded status-code list. 429/503 get retriable=true at
// construction time in client.ts; connection failures also get
// retriable=true. Mid-stream errors get retriable=false because partial
// content was already consumed.
//
// RETRYABLE_STATUSES is retained for backward compatibility with tests
// that construct ProtocolError using the status-based helper.

import { ProtocolError } from './types.js'

export const RETRYABLE_STATUSES = [429, 503] as const
export type RetryableStatus = (typeof RETRYABLE_STATUSES)[number]

export const isRetriable = (e: unknown): boolean =>
  e instanceof ProtocolError && e.retriable

export type RetryOptions = {
  maxRetries: number                  // number of retries AFTER the first attempt
  baseDelayMs: number                 // first retry waits this much; doubles each time
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export const withRetry = async <T>(
  op: () => Promise<T>,
  options: RetryOptions,
): Promise<T> => {
  let attempt = 0
  while (true) {
    try {
      return await op()
    } catch (e) {
      if (!isRetriable(e) || attempt >= options.maxRetries) {
        throw e
      }
      const delay = options.baseDelayMs * 2 ** attempt
      attempt += 1
      await sleep(delay)
    }
  }
}
