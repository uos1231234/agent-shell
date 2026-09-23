// ADR-003: shell has no business fields. Only generic runtime metrics.
// These are physical quantities about THIS shell instance, not about the business domain.
//
// Every metric field has exactly one producer and at least one reader (a guard):
// ADR-014 forbids "reserved" fields - a metric nobody produces and nobody
// reads is dead weight that silently rots into unreachable guards.
//
// Field semantics (P3):
//   - lastRequestTokens: per-request size (overwritten each round, NOT accumulated).
//     Producer: call.ts. Reader: token guard. This is the guard's input.
//   - totalTokens / promptTokens / completionTokens: cumulative spend across all
//     rounds. Producers: call.ts (via addUsage). No guard reader — these are
//     report-only for the caller/tests. They must NOT be used for tripping.
//   - reasoningTokens (v0.32): cumulative thinking tokens. Producer: call.ts
//     via addUsage (upstream completion_tokens_details.reasoning_tokens when
//     present). Report-only — no guard reader.

export type Metrics = {
  lastRequestTokens: number
  totalTokens: number
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  stepCount: number
  toolCallCount: number
  consecutiveToolErrors: number
  elapsedMs: number
}

export type Usage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  reasoningTokens?: number
}

export const createMetrics = (): Metrics => ({
  lastRequestTokens: 0,
  totalTokens: 0,
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  stepCount: 0,
  toolCallCount: 0,
  consecutiveToolErrors: 0,
  elapsedMs: 0,
})

export const addUsage = (m: Metrics, u: Usage): Metrics => ({
  ...m,
  totalTokens: m.totalTokens + u.totalTokens,
  promptTokens: m.promptTokens + u.promptTokens,
  completionTokens: m.completionTokens + u.completionTokens,
  reasoningTokens: m.reasoningTokens + (u.reasoningTokens ?? 0),
})

export const addStep = (m: Metrics): Metrics => ({ ...m, stepCount: m.stepCount + 1 })

export const addToolCalls = (m: Metrics, n: number): Metrics => ({
  ...m,
  toolCallCount: m.toolCallCount + n,
})

export const addToolError = (m: Metrics): Metrics => ({
  ...m,
  consecutiveToolErrors: m.consecutiveToolErrors + 1,
})

export const resetToolErrors = (m: Metrics): Metrics => ({ ...m, consecutiveToolErrors: 0 })
