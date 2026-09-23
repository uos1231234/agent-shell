import { estimateTokens, estimateTokensDeepSeek } from './token-estimate.js'

export type TokenCounter = {
  id: string
  count(text: string): number
  slice(text: string, startToken: number, endToken: number): string
}

export type TokenHeadTail = {
  head: string
  tail: string
  truncated: boolean
  totalTokens: number
}

const isCjk = (cp: number): boolean =>
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x20000 && cp <= 0x2a6df) ||
  (cp >= 0x3000 && cp <= 0x303f) ||
  (cp >= 0xff00 && cp <= 0xffef) ||
  (cp >= 0x3040 && cp <= 0x30ff)

const isDeepSeekCjk = (cp: number): boolean =>
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x20000 && cp <= 0x2a6df) ||
  (cp >= 0x2a700 && cp <= 0x2b73f) ||
  (cp >= 0x2b740 && cp <= 0x2b81f) ||
  (cp >= 0x2b820 && cp <= 0x2ceaf) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0x2f800 && cp <= 0x2fa1f)

const isWhitespace = (cp: number): boolean =>
  cp === 0x20 || (cp >= 0x09 && cp <= 0x0d) || cp === 0xa0 || cp === 0x1680 ||
  (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 ||
  cp === 0x202f || cp === 0x205f || cp === 0x3000 || cp === 0xfeff

const sliceGeneric = (text: string, startToken: number, endToken: number): string => {
  if (endToken <= startToken) return ''
  const cps = Array.from(text)
  const fullTokens = estimateTokens(text)
  let cjk = 0
  let other = 0
  let start = -1
  let end = cps.length
  for (let i = 0; i < cps.length; i += 1) {
    const cp = cps[i]!.codePointAt(0) ?? 0
    if (isCjk(cp)) cjk += 1
    else other += 1
    const next = cjk + Math.ceil(other / 4)
    if (start < 0 && next > startToken) start = i
    if (endToken >= fullTokens) {
      end = cps.length
      continue
    }
    if (next >= endToken) {
      end = i + 1
      break
    }
  }
  if (start < 0) return ''
  return cps.slice(start, end).join('')
}

const sliceDeepSeek = (text: string, startToken: number, endToken: number): string => {
  if (endToken <= startToken) return ''
  const cps = Array.from(text)
  const fullTokens = estimateTokensDeepSeek(text)
  let total = 0
  let previousWhitespace = false
  let start = -1
  let end = cps.length
  for (let i = 0; i < cps.length; i += 1) {
    const cp = cps[i]!.codePointAt(0) ?? 0
    if (isDeepSeekCjk(cp)) {
      total += 0.6
      previousWhitespace = false
    } else if (isWhitespace(cp)) {
      if (!previousWhitespace) total += 1
      previousWhitespace = true
    } else {
      total += 0.3
      previousWhitespace = false
    }
    const next = Math.ceil(total)
    if (start < 0 && next > startToken) start = i
    if (endToken >= fullTokens) {
      end = cps.length
      continue
    }
    if (next >= endToken) {
      end = i + 1
      break
    }
  }
  if (start < 0) return ''
  return cps.slice(start, end).join('')
}

export const GENERIC_TOKEN_COUNTER: TokenCounter = {
  id: 'agent-shell-estimateTokens-v1',
  count: estimateTokens,
  slice: sliceGeneric,
}

export const DEEPSEEK_TOKEN_COUNTER: TokenCounter = {
  id: 'agent-shell-estimateTokens-deepseek-v1',
  count: estimateTokensDeepSeek,
  slice: sliceDeepSeek,
}

export const truncateHeadTailWithCounter = (
  text: string,
  counter: TokenCounter,
  headTokens: number,
  tailTokens: number,
): TokenHeadTail => {
  const totalTokens = counter.count(text)
  if (totalTokens <= headTokens + tailTokens) {
    return { head: text, tail: '', truncated: false, totalTokens }
  }
  const head = counter.slice(text, 0, Math.max(0, headTokens))
  const tailStart = Math.max(0, totalTokens - Math.max(0, tailTokens))
  const tail = counter.slice(text, tailStart, totalTokens)
  return { head, tail, truncated: true, totalTokens }
}

export const resolveTokenCounter = (input: {
  model: string
  providerName?: string | undefined
}): TokenCounter => {
  const routeKey = `${input.providerName ?? ''}/${input.model}`.toLowerCase()
  return routeKey.includes('deepseek') ? DEEPSEEK_TOKEN_COUNTER : GENERIC_TOKEN_COUNTER
}
