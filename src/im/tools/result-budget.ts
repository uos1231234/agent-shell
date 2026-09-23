import { GENERIC_TOKEN_COUNTER, type TokenCounter, truncateHeadTailWithCounter } from '../../shared/token-counter.js'

export type { TokenCounter } from '../../shared/token-counter.js'

export type TokenRange = {
  startToken: number
  endToken: number
}

export type ToolResultProjection = {
  visibleContent: string
  originalTokens: number
  visibleTokens: number
  omittedRanges: TokenRange[]
  stamp: string
  truncated: boolean
}

const DEFAULT_VISIBLE_TOKENS = 20_000
const MARKER_RESERVE = 420

export const ESTIMATE_TOKEN_COUNTER: TokenCounter = GENERIC_TOKEN_COUNTER

const markerFor = (input: {
  stamp: string
  originalTokens: number
  visibleTokens: number
  omitted: TokenRange
}): string => {
  const omittedTokens = Math.max(0, input.omitted.endToken - input.omitted.startToken)
  return [
    '',
    '[tool-result-projection]',
    `原始结果约 ${input.originalTokens} tokens；当前可见 ${input.visibleTokens} tokens；省略 ${omittedTokens} tokens。`,
    `省略范围：${input.omitted.startToken}..${input.omitted.endToken}（半开区间）。`,
    `完整结果戳：${input.stamp}。当前内容不是全文。`,
    `继续读取：databus_query({stamp:'${input.stamp}', tokenRange:{startToken:${input.omitted.startToken}, endToken:${input.omitted.endToken}}, reason:'read omitted range'})。`,
  ].join('\n')
}

const buildProjection = (
  content: string,
  stamp: string,
  tokenCounter: TokenCounter,
  maxVisibleTokens: number,
  bodyBudget: number,
): ToolResultProjection => {
  const originalTokens = tokenCounter.count(content)
  const headBudget = Math.floor(bodyBudget / 2)
  const tailBudget = Math.max(0, bodyBudget - headBudget)
  const { head, tail, truncated } = truncateHeadTailWithCounter(
    content,
    tokenCounter,
    headBudget,
    tailBudget,
  )
  if (!truncated) {
    return {
      visibleContent: content,
      originalTokens,
      visibleTokens: originalTokens,
      omittedRanges: [],
      stamp,
      truncated: false,
    }
  }

  const headTokens = tokenCounter.count(head)
  const tailTokens = tokenCounter.count(tail)
  const omitted: TokenRange = {
    startToken: headTokens,
    endToken: Math.max(headTokens, originalTokens - tailTokens),
  }
  const marker = markerFor({
    stamp,
    originalTokens,
    visibleTokens: headTokens + tailTokens,
    omitted,
  })
  const visibleContent = `${head}${tail}${marker}`
  const visibleTokens = tokenCounter.count(visibleContent)
  if (visibleTokens <= maxVisibleTokens) {
    return {
      visibleContent,
      originalTokens,
      visibleTokens,
      omittedRanges: [omitted],
      stamp,
      truncated: true,
    }
  }
  if (bodyBudget <= 1) {
    throw new Error('maxVisibleTokens is too small to include the tool-result projection marker')
  }
  return buildProjection(content, stamp, tokenCounter, maxVisibleTokens, Math.max(1, bodyBudget - (visibleTokens - maxVisibleTokens)))
}

export const projectToolResult = (input: {
  content: string
  stamp: string
  tokenCounter?: TokenCounter
  maxVisibleTokens?: number
}): ToolResultProjection => {
  const tokenCounter = input.tokenCounter ?? ESTIMATE_TOKEN_COUNTER
  const maxVisibleTokens = input.maxVisibleTokens ?? DEFAULT_VISIBLE_TOKENS
  if (maxVisibleTokens <= 0) throw new Error('maxVisibleTokens must be positive')
  const originalTokens = tokenCounter.count(input.content)
  if (originalTokens <= maxVisibleTokens) {
    return {
      visibleContent: input.content,
      originalTokens,
      visibleTokens: originalTokens,
      omittedRanges: [],
      stamp: input.stamp,
      truncated: false,
    }
  }
  return buildProjection(
    input.content,
    input.stamp,
    tokenCounter,
    maxVisibleTokens,
    Math.max(1, maxVisibleTokens - MARKER_RESERVE),
  )
}

export const DEFAULT_MODEL_VISIBLE_TOOL_TOKENS = DEFAULT_VISIBLE_TOKENS
export const DEFAULT_DIRECT_RECALL_TOKENS = 200_000
export const DEFAULT_HANDOFF_TRANSCRIPT_TOKENS = 300_000
