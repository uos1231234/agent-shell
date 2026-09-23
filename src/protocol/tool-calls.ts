// Parsing of LLM responses, both non-streaming and streaming-delta accumulation.
// ADR-005: native OpenAI function calling. Schemas are passed through as-is.
//
// The tool-call argument parser is the only place that inspects wire JSON.
// It returns a success boolean (with the parsed value) or a failure boolean
// (with no message). The caller is responsible for writing the user-facing
// English description when ok is false — keeping the protocol layer
// completely free of UI-level text.

import type { ToolCall } from './types.js'

export type ToolCallAccumulator = {
  id: string
  name: string
  arguments: string
}

// ---------- argument parsing ----------

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false }

export const parseToolCallArguments = (raw: string): ParseResult<unknown> => {
  if (raw.length === 0) return { ok: true, value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false }
  }
  return { ok: true, value: parsed }
}

// ---------- streaming delta accumulation ----------

export const accumulateToolCall = (
  acc: ToolCallAccumulator,
  delta: { index: number; id?: string; name?: string; arguments_delta?: string },
): ToolCallAccumulator => ({
  id: delta.id ?? acc.id,
  name: delta.name ?? acc.name,
  arguments:
    delta.arguments_delta !== undefined
      ? acc.arguments + delta.arguments_delta
      : acc.arguments,
})

// Finalize a list of accumulators into ToolCall objects ready for the response.
export const finalizeToolCalls = (accs: ToolCallAccumulator[]): ToolCall[] =>
  accs.map(a => ({
    id: a.id,
    type: 'function',
    function: { name: a.name, arguments: a.arguments },
  }))
