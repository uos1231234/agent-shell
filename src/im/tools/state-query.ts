// state_query: v0.10.2 real implementation.
// metadata-only queries via jsonl (stamps/range/layer) or chromadb RAG (queryText).
// No LLM in either branch — LLM synthesis is ask_recall's job (plan §7.2 #1).
// ADR-016 §2.2: stamp is a stable string (not a timestamp number).

import type { SystemTool } from '../../shell/registry.js'
import type { ToolContext } from '../../shared/tool-context.js'
import type { StateLine } from '../state-line/types.js'
import { wrapTool, toSchema, reasonField } from './helpers.js'

export const createStateQueryTool = (): SystemTool => ({
  name: 'state_query',
  description:
    '直查 curated memory 与被驱逐的原始历史。持 stamp 时精确取块（免费、不走 LLM embedding）；'
    + '持 rawArchiveIds（M3 摘要的 raw_archive_ids 字段）时可复原**被压缩驱逐的完整原始消息**——那是你窗口里已经消失的对话。'
    + '不知道 stamp 时，给 state_query 传 **queryText 参数**做 M3 语义搜索。',
  parameters: toSchema({
    stamps: {
      type: 'array',
      items: { type: 'string' },
      description: 'Stable string stamps to filter by (see ADR-016 §2.2)',
    },
    range: {
      type: 'array',
      items: { type: 'number' },
      minItems: 2,
      maxItems: 2,
      description: '[startAt, endAt] time range filter',
    },
    layer: {
      type: 'string',
      description: 'Memory layer to query (e.g. "M1", "M2", "M3")',
    },
    queryText: {
      type: 'string',
      description: 'Free-text semantic query for M3 RAG recall via chromadb',
    },
    rawArchiveIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'Raw-archive archiveIds to fetch the original canonical ChatMessage[] behind a curated block (M3 deep recall). Returns { rawArchive: RawArchiveRecord[] }.',
    },
    rawSummaryStamps: {
      type: 'array',
      items: { type: 'string' },
      description: 'CuratedMemory block _stamps to look up their raw-archive records. Returns { rawArchive: RawArchiveRecord[] }.',
    },
    limit: {
      type: 'number',
      description: 'Maximum number of results to return (default 10)',
    },
    reason: reasonField,
  }, ['reason']),
  execute: wrapTool('state_query', async (args: unknown, ctx?: ToolContext) => {
    if (!ctx?.stateLine) {
      return 'state-line not configured; provide a StateLine instance to enable state_query'
    }

    const sl = ctx.stateLine as StateLine

    const a = args as {
      stamps?: string[]
      range?: [number, number]
      layer?: 'M1' | 'M2' | 'M3'
      queryText?: string
      rawArchiveIds?: string[]
      rawSummaryStamps?: string[]
      limit?: number
    }

    // Raw-archive branch: fetch original canonical ChatMessage[] by archiveId
    // or summaryStamp. This is the M3 deep-recall path — recall goes M3 →
    // raw_archive_ids → state_query({ rawArchiveIds }) to recover the full
    // evicted history. Placed BEFORE the RAG and metadata branches so raw
    // lookups are never shadowed by a coincidental queryText/stamps.
    if (a.rawArchiveIds !== undefined || a.rawSummaryStamps !== undefined) {
      const records = await sl.rawArchive.query({
        ...(a.rawArchiveIds ? { archiveIds: a.rawArchiveIds } : {}),
        ...(a.rawSummaryStamps ? { summaryStamps: a.rawSummaryStamps } : {}),
        ...(a.limit !== undefined ? { limit: a.limit } : {}),
      })
      return JSON.stringify({ rawArchive: records })
    }

    // RAG branch: queryText → chromadb via warehouse.queryM3.
    if (a.queryText) {
      const limit = a.limit ?? 10
      const result = await sl.warehouse.queryM3(a.queryText, limit)
      return JSON.stringify(result)
    }

    // Metadata branch: stamps/range/layer → jsonl direct read.
    const filter: {
      stamps?: string[]
      range?: [number, number]
      layer?: 'M1' | 'M2' | 'M3'
      limit?: number
    } = {}
    if (a.stamps) filter.stamps = a.stamps
    if (a.range) filter.range = a.range
    if (a.layer) filter.layer = a.layer
    if (a.limit !== undefined) filter.limit = a.limit
    const entries = sl.query(filter)
    return JSON.stringify({ results: entries })
  }),
})
