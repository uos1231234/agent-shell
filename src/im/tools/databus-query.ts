// databus_query: deterministic read of the calling loop's databus. No LLM.
// (v0.10.3.2: the v0.10.3.1 version delegated to warehouse.run(), and
// warehouse's own toolRefs included databus_query — infinite recursion.)
//
// v0.38（2026-09-12，用户拍板）：召回必须全量。参数扩展 stamp / toolName /
// keyword，让模型能精确取回被折叠截断的完整工具结果。戳内联在
// history-tool-table.ts 的截断标记里（"戳的可见性 = 可发现性"，对齐
// l1-demo handlers/retrieve.py 的 retrieve_by_stamp）。返回匹配条目的完整
// content —— 召回若再截断，召回就无意义（用户原话）。
//
// 两条路线分清（用户 2026-09-12 拍板）：压缩（纯算法截断，不调 LLM）与
// 召回（纯参数过滤，不调 LLM）各自独立，唯stamp 是两者的握手点。l1-demo
// 在召回侧调 LLM 做语义定位，是它 StampStore 不能按内容过滤的妥协；
// 我们 databus 有 toolName/keyword 过滤，不需要。

import type { SystemTool } from '../../shell/registry.js'
import type { Databus, ToolTurn } from '../databus.js'
import { stampOfToolTurn } from '../databus.js'
import type { ToolContext } from '../../shared/tool-context.js'
import { wrapTool, toSchema, reasonField } from './helpers.js'
import {
  clampTokenRange,
  createDirectRecallLedger,
  DEFAULT_DIRECT_RECALL_TOKENS,
  DEFAULT_RECALL_PAGE_TOKENS,
  rangeSize,
  type TokenRange,
} from './databus-recall.js'
import { GENERIC_TOKEN_COUNTER } from '../../shared/token-counter.js'

const RECORD_CURSOR = /^record:(\d+):(\d+)$/
const PAGE_RESPONSE_RESERVE_TOKENS = 512

const parseRecordCursor = (cursor: string | undefined): { recordIndex: number; tokenOffset: number } => {
  if (cursor === undefined) return { recordIndex: 0, tokenOffset: 0 }
  const record = RECORD_CURSOR.exec(cursor)
  if (record !== null) {
    return {
      recordIndex: Number.parseInt(record[1]!, 10),
      tokenOffset: Number.parseInt(record[2]!, 10),
    }
  }
  return { recordIndex: Math.max(0, Number.parseInt(cursor, 10) || 0), tokenOffset: 0 }
}

// keyword 匹配的文本源：content + args.reason + args.path（工具调用里最常
// 携带可检索线索的字段）。args 是 unknown，安全访问。
const keywordHaystack = (t: ToolTurn): string => {
  const parts: string[] = [String(t.content ?? '')]
  const args = t.args as { reason?: unknown; path?: unknown } | undefined
  if (args && typeof args === 'object') {
    if (typeof args.reason === 'string') parts.push(args.reason)
    if (typeof args.path === 'string') parts.push(args.path)
  }
  return parts.join('\n')
}

export const createDatabusQueryTool = (): SystemTool => ({
  name: 'databus_query',
  description:
    'Recall full tool-event records from the shared databus (pull, deterministic, no LLM). '
    + 'Use this to recover the complete original content of a tool result that was truncated in the conversation '
    + "— the truncation marker in canonical carries a 12-char stamp; pass it here as `stamp` to fetch the full text back. "
    + 'Also filterable by tool name, keyword (matched against result content + args.reason + args.path), '
    + 'source agent, time range, and a recent-N cap. For large fields use tokenRange/cursor: '
    + 'each direct page is at most 20K token-equivalent and carries the next cursor. '
    + 'A single field or cumulative direct read over 200K is delegated to the temporary read-only recall agent. '
    + 'For real-time push of NEW events use databus_subscribe instead.',
  parameters: toSchema({
    stamp: {
      type: 'string',
      description: '12-char content-hash stamp (find it in the truncation marker of a folded tool result). Exact recall of that turn.',
    },
    toolName: {
      type: 'string',
      description: 'Filter by tool name (e.g. "read", "bash").',
    },
    keyword: {
      type: 'string',
      description: 'Substring matched against result content + args.reason + args.path. Case-sensitive.',
    },
    sourceAgentIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'Agent IDs to filter by. Omit for all agents.',
    },
    range: {
      type: 'array',
      items: { type: 'number' },
      minItems: 2,
      maxItems: 2,
      description: '[startAt, endAt] time range filter',
    },
    limit: {
      type: 'integer',
      description: 'Maximum number of recent turns to return (applied AFTER stamp/toolName/keyword filtering)',
    },
    tokenRange: {
      type: 'object',
      properties: {
        startToken: { type: 'integer', minimum: 0 },
        endToken: { type: 'integer', minimum: 0 },
      },
      description: 'Content token range [startToken,endToken) for an exact stamp recall.',
    },
    cursor: {
      type: 'string',
      description: 'Next-page token returned by a previous token-range recall.',
    },
    reason: reasonField,
  }, ['reason']),
  execute: wrapTool('databus_query', async (args, ctx) => {
    if (!ctx?.databus) {
      throw new Error('databus_query requires a databus in the tool context')
    }
    const databus = ctx.databus as Databus
    const a = args as {
      stamp?: string
      toolName?: string
      keyword?: string
      sourceAgentIds?: string[]
      range?: [number, number]
      limit?: number
      tokenRange?: TokenRange
      cursor?: string
      reason?: string
    }
    // 1. 先用 databus 原生过滤（sourceAgentIds / range / limit）取候选集
    const filter: { sourceAgentIds?: string[]; range?: [number, number]; limit?: number } = {}
    if (a.sourceAgentIds) filter.sourceAgentIds = a.sourceAgentIds
    if (a.range) filter.range = a.range
    if (a.limit !== undefined) filter.limit = a.limit
    let result: readonly ToolTurn[] = databus.query(filter)

    // 2. 工具层二次过滤：stamp / toolName / keyword（databus.ts 保持通用，召回专属逻辑在此）
    if (a.stamp !== undefined && a.stamp.length > 0) {
      result = result.filter((t) => stampOfToolTurn(t) === a.stamp)
    }
    if (a.toolName !== undefined && a.toolName.length > 0) {
      result = result.filter((t) => t.toolName === a.toolName)
    }
    if (a.keyword !== undefined && a.keyword.length > 0) {
      result = result.filter((t) => keywordHaystack(t).includes(a.keyword!))
    }

    const ledger = ctx.directRecallLedger ?? createDirectRecallLedger()
    const directLimit = ctx.directRecallLimitTokens ?? DEFAULT_DIRECT_RECALL_TOKENS
    const ledgerKey = a.stamp ?? JSON.stringify({
      toolName: a.toolName,
      keyword: a.keyword,
      sourceAgentIds: a.sourceAgentIds,
      range: a.range,
      limit: a.limit,
    })
    const target = a.stamp !== undefined ? result[0] : undefined
    if (a.stamp !== undefined && result.length === 0) return JSON.stringify([])

    // Legacy small queries retain the array response shape. Large or ranged
    // queries use an envelope so the model can distinguish a page from the
    // complete result and continue with a cursor.
    if (target !== undefined) {
      const counter = ctx.tokenCounter ?? GENERIC_TOKEN_COUNTER
      const totalTokens = counter.count(target.content)
      if (a.tokenRange === undefined && a.cursor === undefined && totalTokens <= DEFAULT_RECALL_PAGE_TOKENS) {
        const completeRange: TokenRange = { startToken: 0, endToken: totalTokens }
        if (ledger.wouldExceed(completeRange, directLimit, ledgerKey)) {
          if (ctx.largeRecall === undefined) {
            throw new Error('databus_query requires a temporary recall agent for a result over 200K tokens')
          }
          const delegated = await ctx.largeRecall({
            question: a.reason ?? 'read the requested Databus result',
            ...(a.stamp !== undefined ? { stamp: a.stamp } : {}),
            requestedRange: completeRange,
            sourceDatabus: ctx.databus,
            ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          })
          return JSON.stringify(delegated)
        }
        ledger.noteDelivered(completeRange, ledgerKey)
        return JSON.stringify(result)
      }
      const requested = a.tokenRange ?? {
        startToken: a.cursor !== undefined ? Number(a.cursor) : 0,
        endToken: totalTokens,
      }
      const bounded = clampTokenRange(requested, totalTokens)
      if (bounded.endToken <= bounded.startToken) {
        return JSON.stringify({ records: [], stamp: a.stamp, returnedRange: bounded, totalTokens, mode: 'direct' })
      }
      const pageEnd = Math.min(
        bounded.endToken,
        bounded.startToken + Math.max(1, DEFAULT_RECALL_PAGE_TOKENS - PAGE_RESPONSE_RESERVE_TOKENS),
      )
      const page: TokenRange = { startToken: bounded.startToken, endToken: pageEnd }
      if (rangeSize(bounded) > directLimit || ledger.wouldExceed(page, directLimit, ledgerKey)) {
        if (ctx.largeRecall === undefined) {
          throw new Error('databus_query requires a temporary recall agent for a range over 200K tokens')
        }
        const delegated = await ctx.largeRecall({
          question: a.reason ?? 'read the requested Databus range',
          ...(a.stamp !== undefined ? { stamp: a.stamp } : {}),
          requestedRange: bounded,
          sourceDatabus: ctx.databus,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        })
        return JSON.stringify(delegated)
      }
      ledger.noteDelivered(page, ledgerKey)
      const content = counter.slice(target.content, page.startToken, page.endToken)
      return JSON.stringify({
        records: [{ ...target, content }],
        stamp: a.stamp,
        returnedRange: page,
        totalTokens,
        nextCursor: page.endToken < bounded.endToken ? String(page.endToken) : undefined,
        mode: 'direct',
        evidenceStamps: [a.stamp],
      })
    }

    const serialized = JSON.stringify(result)
    const counter = ctx.tokenCounter ?? GENERIC_TOKEN_COUNTER
    const totalTokens = counter.count(serialized)
    const { recordIndex: startIndex, tokenOffset: startTokenOffset } = parseRecordCursor(a.cursor)
    const pageRecords: ToolTurn[] = []
    let pageTokens = 0
    let nextCursor: string | undefined
    for (const turn of result.slice(startIndex)) {
      const recordIndex = startIndex + pageRecords.length
      const offset = recordIndex === startIndex ? startTokenOffset : 0
      const turnTokens = counter.count(JSON.stringify(turn))
      if (offset > 0 || turnTokens > DEFAULT_RECALL_PAGE_TOKENS - PAGE_RESPONSE_RESERVE_TOKENS) {
        const contentTokens = counter.count(turn.content)
        const emptyContentTokens = counter.count(JSON.stringify({ ...turn, content: '' }))
        const availableContentTokens = DEFAULT_RECALL_PAGE_TOKENS
          - PAGE_RESPONSE_RESERVE_TOKENS
          - pageTokens
          - emptyContentTokens
          - 8
        if (availableContentTokens <= 0) {
          throw new Error('databus_query record metadata exceeds the 20K direct page budget')
        }
        const endToken = Math.min(contentTokens, offset + availableContentTokens)
        const partialTurn = { ...turn, content: counter.slice(turn.content, offset, endToken) }
        pageRecords.push(partialTurn)
        pageTokens += counter.count(JSON.stringify(partialTurn))
        nextCursor = endToken < contentTokens
          ? `record:${recordIndex}:${endToken}`
          : recordIndex + 1 < result.length ? String(recordIndex + 1) : undefined
        break
      }
      if (pageRecords.length > 0 && pageTokens + turnTokens + PAGE_RESPONSE_RESERVE_TOKENS > DEFAULT_RECALL_PAGE_TOKENS) break
      pageRecords.push(turn)
      pageTokens += turnTokens
    }
    const prefixTokens = result
      .slice(0, startIndex)
      .reduce((sum, turn) => sum + counter.count(JSON.stringify(turn)), 0)
    const pageRange: TokenRange = { startToken: prefixTokens, endToken: prefixTokens + pageTokens }
    if (totalTokens > directLimit || ledger.wouldExceed(pageRange, directLimit, ledgerKey)) {
      if (ctx.largeRecall === undefined) {
        throw new Error('databus_query requires a temporary recall agent for a result over 200K tokens')
      }
      const delegated = await ctx.largeRecall({
        question: a.reason ?? 'read the requested Databus result',
        requestedRange: totalTokens > directLimit ? { startToken: 0, endToken: totalTokens } : pageRange,
        sourceDatabus: ctx.databus,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      })
      return JSON.stringify(delegated)
    }
    if (totalTokens <= DEFAULT_RECALL_PAGE_TOKENS && a.tokenRange === undefined && a.cursor === undefined) {
      const completeRange: TokenRange = { startToken: 0, endToken: totalTokens }
      if (ledger.wouldExceed(completeRange, directLimit, ledgerKey)) {
        if (ctx.largeRecall === undefined) {
          throw new Error('databus_query requires a temporary recall agent for a result over 200K tokens')
        }
        const delegated = await ctx.largeRecall({
          question: a.reason ?? 'read the requested Databus result',
          requestedRange: completeRange,
          sourceDatabus: ctx.databus,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        })
        return JSON.stringify(delegated)
      }
      ledger.noteDelivered(completeRange, ledgerKey)
      return JSON.stringify(result)
    }
    ledger.noteDelivered(pageRange, ledgerKey)
    return JSON.stringify({
      records: pageRecords,
      returnedRange: pageRange,
      totalTokens,
      nextCursor: nextCursor ?? (startIndex + pageRecords.length < result.length ? String(startIndex + pageRecords.length) : undefined),
      mode: 'direct',
      evidenceStamps: pageRecords.map(stampOfToolTurn),
    })
  }),
})
