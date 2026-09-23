// v0.10.4 context projection: decides what the working agent sees beyond the
// canonical conversation turns. The working prompt is now assembled from
// ConversationMemory turns only (see loop.ts); projection contributes only
// the state-line block fragment and the system suffix (mailbox / M3 hint).
//
// Layer-aware projection:
//   M0 — no state-line blocks
//   M1 — M1 blocks
//   M2 — M1 blocks + M2 blocks (scheme B: two queries, merged)
//   M3 — no blocks; M3 is query-on-demand via state_query/ask_recall
//
// Pure module: no state, no I/O, no side effects.

import type { AgentId } from './databus.js'
import type { Mailbox } from './mailbox/mailbox.js'
import type { StateLine, CuratedMemory } from './state-line/types.js'
import type { MemoryLayer } from './memory-layers.js'
import { classifyMemoryLayer } from './memory-layers.js'
import type { MemoryConfig } from '../shell/memory-config.js'
import { DEFAULT_MEMORY_CONFIG } from '../shell/memory-config.js'
import type { PromptPart } from '../shell/compose.js'

export type ContextProjectionConfig = {
  readonly stateLineMaxBlocks: number
  readonly conversationMaxTokens: number
}

export const DEFAULT_CONTEXT_PROJECTION_CONFIG: ContextProjectionConfig = {
  stateLineMaxBlocks: 20,
  conversationMaxTokens: 50_000,
}

export type ProjectionInput = {
  stateLine: StateLine
  mailbox: Mailbox
  workingAgentId: AgentId
  estimatedTokens: number
  config?: ContextProjectionConfig
  // v0.14: caller-supplied memory-layer thresholds. When omitted, the
  // classifier uses DEFAULT_MEMORY_CONFIG (200K/500K/900K) — identical to the
  // pre-v0.14 module-constant path. This is plumbed from IMLoopOptions.memoryConfig.
  memoryConfig?: MemoryConfig
  // v0.12.2: the agent's systemToolRefs, used to tailor the M3 overflow hint
  // so we never mention a tool the agent does not have (e.g. a sub-agent whose
  // recall is a noop and whose toolRefs omit ask_recall).
  availableToolRefs?: readonly string[]
}

export type ProjectionResult = {
  stateLinePart: PromptPart | null
  systemSuffix: string
  layer: MemoryLayer
}

// --- helpers ---

export const estimateTokensFromText = (text: string): number =>
  Math.ceil(text.length / 4)

// selectStateLineBlocks only queries M1/M2 layers, which return CuratedMemory
// variants (never M3Summary). The entry type is narrowed accordingly.
type TaggedBlock = { layer: 'M1' | 'M2'; entry: CuratedMemory & { _stamp?: string } }

const selectStateLineBlocks = (
  stateLine: StateLine,
  layer: MemoryLayer,
  maxBlocks: number,
): readonly TaggedBlock[] => {
  if (layer === 'M1') {
    return stateLine
      .query({ layer: 'M1' })
      .slice(-maxBlocks)
      .map(entry => ({ layer: 'M1', entry: entry as CuratedMemory & { _stamp?: string } }))
  }
  if (layer === 'M2') {
    // Scheme B: two single-layer queries. StateLineQueryFilter.layer is a
    // single value, so the M1/M2 split is done by budget halving, not by
    // widening the filter to an array.
    const half = Math.ceil(maxBlocks / 2)
    const m1: readonly TaggedBlock[] = stateLine.query({ layer: 'M1' }).slice(-half).map(entry => ({ layer: 'M1', entry: entry as CuratedMemory & { _stamp?: string } }))
    const m2: readonly TaggedBlock[] = stateLine.query({ layer: 'M2' }).slice(-half).map(entry => ({ layer: 'M2', entry: entry as CuratedMemory & { _stamp?: string } }))
    return [...m1, ...m2]
  }
  // M0 — raw context is still small enough; M3 — query-on-demand only.
  return []
}

const formatStateLinePrompt = (blocks: readonly TaggedBlock[]): string => {
  let out = ''
  for (const { layer, entry } of blocks) {
    const { _stamp, ...rest } = entry
    out += `### ${layer} block stamp=${_stamp ?? 'unknown'}\n${JSON.stringify(rest)}\n`
  }
  return out
}

const buildSystemSuffix = (
  mailbox: Mailbox,
  agentId: AgentId,
  layer: MemoryLayer,
  availableToolRefs: readonly string[],
): string => {
  const unread = mailbox.readOwnInbox(agentId).length
  const parts: string[] = []
  if (unread > 0) {
    parts.push(`[mailbox] you have ${unread} unread`)
  }
  if (layer === 'M3') {
    // v0.12.2: tailor the M3 hint to the tools this agent actually has, so we
    // never tell a sub-agent (whose recall is a noop and whose toolRefs omit
    // ask_recall) to use a tool it cannot call.
    const hasRecall = availableToolRefs.includes('ask_recall')
    const hasStateQuery = availableToolRefs.includes('state_query')
    if (hasRecall) {
      parts.push(`[context overflow] M3 available via state_query/ask_recall`)
    } else if (hasStateQuery) {
      parts.push(`[context overflow] M3 available via state_query`)
    } else {
      parts.push(`[context overflow] context has overflowed to M3 storage; delegate retrieval to an agent that has state_query/ask_recall`)
    }
  }
  return parts.length > 0 ? '\n\n' + parts.join('\n') : ''
}

// --- main ---

export function buildContextProjection(input: ProjectionInput): ProjectionResult {
  const config = input.config ?? DEFAULT_CONTEXT_PROJECTION_CONFIG
  const memoryConfig = input.memoryConfig ?? DEFAULT_MEMORY_CONFIG
  const layer = classifyMemoryLayer(input.estimatedTokens, memoryConfig)

  const blocks = selectStateLineBlocks(input.stateLine, layer, config.stateLineMaxBlocks)
  const stateLinePart: PromptPart | null = blocks.length > 0
    ? { type: 'system', content: formatStateLinePrompt(blocks) }
    : null

  const systemSuffix = buildSystemSuffix(
    input.mailbox,
    input.workingAgentId,
    layer,
    input.availableToolRefs ?? [],
  )

  return { stateLinePart, systemSuffix, layer }
}
