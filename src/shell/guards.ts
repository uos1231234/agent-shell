// ADR-002 + ADR-009: guards are pure functions, configured, no hot-plug, no defense layers.
// A guard returns a "hit" only when its threshold is exceeded (strict greater-than).
// Multiple guards can hit at the same time; runGuards returns them all.

import type { Metrics } from './metrics.js'
import type { ShellConfig } from './config.js'

export type GuardId = 'token' | 'iter' | 'toolRate' | 'time' | 'errorRate'

export type GuardHit = {
  id: GuardId
  reason: string
}

export const runGuards = (m: Metrics, c: ShellConfig): GuardHit[] => {
  const hits: GuardHit[] = []

  if (m.lastRequestTokens > c.maxTokens) {
    hits.push({ id: 'token', reason: `request tokens ${m.lastRequestTokens} > limit ${c.maxTokens}` })
  }
  if (m.stepCount > c.maxSteps) {
    hits.push({ id: 'iter', reason: `step count ${m.stepCount} > limit ${c.maxSteps}` })
  }
  if (m.toolCallCount > c.maxToolCalls) {
    hits.push({ id: 'toolRate', reason: `tool call count ${m.toolCallCount} > limit ${c.maxToolCalls}` })
  }
  if (m.elapsedMs > c.maxElapsedMs) {
    hits.push({ id: 'time', reason: `elapsed ${m.elapsedMs}ms > limit ${c.maxElapsedMs}ms` })
  }
  if (m.consecutiveToolErrors > c.maxConsecutiveToolErrors) {
    hits.push({ id: 'errorRate', reason: `consecutive tool errors ${m.consecutiveToolErrors} > limit ${c.maxConsecutiveToolErrors}` })
  }

  return hits
}
