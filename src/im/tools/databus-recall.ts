import { estimateTokens } from '../../shared/token-estimate.js'
import type { TokenRange } from './result-budget.js'

export type { TokenRange }

export const DEFAULT_DIRECT_RECALL_TOKENS = 200_000
export const DEFAULT_RECALL_PAGE_TOKENS = 20_000

const mergeRanges = (ranges: readonly TokenRange[]): TokenRange[] => {
  const ordered = [...ranges]
    .filter((r) => r.endToken > r.startToken)
    .sort((a, b) => a.startToken - b.startToken)
  const merged: TokenRange[] = []
  for (const range of ordered) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && range.startToken <= previous.endToken) {
      previous.endToken = Math.max(previous.endToken, range.endToken)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

const mergedTokens = (ranges: readonly TokenRange[]): number =>
  ranges.reduce((sum, range) => sum + range.endToken - range.startToken, 0)

export type DirectRecallLedger = {
  noteDelivered(range: TokenRange, key?: string): void
  deliveredTokens(key?: string): number
  exceeds(limitTokens?: number, key?: string): boolean
  wouldExceed(range: TokenRange, limitTokens?: number, key?: string): boolean
  ranges(key?: string): readonly TokenRange[]
}

export const createDirectRecallLedger = (): DirectRecallLedger => {
  const deliveredByKey = new Map<string, TokenRange[]>()
  const rangesFor = (key: string): TokenRange[] => deliveredByKey.get(key) ?? []
  return {
    noteDelivered(range, key = 'default') {
      deliveredByKey.set(key, mergeRanges([...rangesFor(key), range]))
    },
    deliveredTokens(key = 'default') {
      return rangesFor(key).reduce((sum, range) => sum + range.endToken - range.startToken, 0)
    },
    exceeds(limitTokens = DEFAULT_DIRECT_RECALL_TOKENS, key = 'default') {
      return this.deliveredTokens(key) > limitTokens
    },
    wouldExceed(range, limitTokens = DEFAULT_DIRECT_RECALL_TOKENS, key = 'default') {
      return mergedTokens(mergeRanges([...rangesFor(key), range])) > limitTokens
    },
    ranges(key = 'default') {
      return rangesFor(key).map((range) => ({ ...range }))
    },
  }
}

export const tokenRangeForText = (text: string): TokenRange => ({
  startToken: 0,
  endToken: estimateTokens(text),
})

export const clampTokenRange = (range: TokenRange, totalTokens: number): TokenRange => ({
  startToken: Math.max(0, Math.min(totalTokens, Math.floor(range.startToken))),
  endToken: Math.max(0, Math.min(totalTokens, Math.floor(range.endToken))),
})

export const rangeSize = (range: TokenRange): number => Math.max(0, range.endToken - range.startToken)

export const directRecallRequiresDelegation = (
  requested: TokenRange | undefined,
  ledger: DirectRecallLedger | undefined,
  directLimitTokens = DEFAULT_DIRECT_RECALL_TOKENS,
  key = 'default',
): boolean => {
  if (requested !== undefined && rangeSize(requested) > directLimitTokens) return true
  return ledger?.exceeds(directLimitTokens, key) === true
}
