// CJK-aware token estimator — shared by every compaction path.
//
// Why not chars/4: Chinese text is roughly 1 token per character on the
// providers this harness targets (ARK glm/deepseek family); chars/4
// underestimates CJK context size by 3-6x, which delays compression
// triggers badly on Chinese-heavy sessions (2026-09-09 user-approved
// finding from the v0.29 acceptance data).
//
// This is an ESTIMATE, not a tokenizer: the authoritative count is always
// the provider-returned usage.prompt_tokens (shell/call.ts lastRequestTokens).
// This function is only used where no usage exists yet (pre-request checks,
// tool-result folding, user-message budgets).

const isCJK = (c: number): boolean =>
  (c >= 0x4e00 && c <= 0x9fff) ||   // CJK unified ideographs
  (c >= 0x3400 && c <= 0x4dbf) ||   // CJK extension A
  (c >= 0x20000 && c <= 0x2a6df) || // CJK extension B
  (c >= 0x3000 && c <= 0x303f) ||   // CJK punctuation
  (c >= 0xff00 && c <= 0xffef) ||   // fullwidth forms
  (c >= 0x3040 && c <= 0x30ff)      // hiragana / katakana

export const estimateTokens = (text: string): number => {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (isCJK(ch.codePointAt(0) ?? 0)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

// DeepSeek-weighted CJK ranges (wider than isCJK above — includes the astral
// extension planes and compatibility ideographs DeepSeek's tokenizer treats as
// CJK). Mirrors 参考实现 token-estimation/tokenizer.ts estimateDeepSeekTokens,
// which cites DeepSeek's published token_usage doc.
const isCJKDeepSeek = (cp: number): boolean =>
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x20000 && cp <= 0x2a6df) ||
  (cp >= 0x2a700 && cp <= 0x2b73f) ||
  (cp >= 0x2b740 && cp <= 0x2b81f) ||
  (cp >= 0x2b820 && cp <= 0x2ceaf) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0x2f800 && cp <= 0x2fa1f)

// JS \s equivalence by code point (ASCII whitespace + the Unicode spaces \s matches).
const isWhitespace = (cp: number): boolean =>
  cp === 0x20 || (cp >= 0x09 && cp <= 0x0d) || cp === 0xa0 || cp === 0x1680 ||
  (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 ||
  cp === 0x202f || cp === 0x205f || cp === 0x3000 || cp === 0xfeff

/**
 * DeepSeek-weighted local token estimate: CJK ≈ 0.6 token/char, a run of
 * consecutive whitespace ≈ 1 token, everything else ≈ 0.3 token/char (DeepSeek
 * token_usage doc; ported from 宿主应用). Deterministic and computed over the
 * exact content we are about to put on the wire — it never depends on the
 * provider's reported usage.prompt_tokens, which under-reports under prompt
 * caching (a warm cache makes the relay bill only the uncached delta, pinning
 * any usage-driven memory-layer trigger far below the real context size).
 *
 * Over-estimates highly repetitive corpora (MRCR filler) versus the relay's own
 * tokenizer; that is the SAFE direction for a compression trigger — it fires
 * early, so the real provider window is never exceeded.
 */
export const estimateTokensDeepSeek = (text: string): number => {
  let total = 0
  let prevSpace = false
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (isCJKDeepSeek(cp)) {
      total += 0.6
      prevSpace = false
    } else if (isWhitespace(cp)) {
      if (!prevSpace) {
        total += 1
        prevSpace = true
      }
    } else {
      total += 0.3
      prevSpace = false
    }
  }
  return Math.max(Math.ceil(total), 1)
}

// Truncate text to at most `max` tokens under the same CJK-aware accounting,
// appending a truncation marker. Used by the history-tool-table fold to keep
// each result cell bounded (user-approved 100-token ceiling, 2026-09-09).
export const truncateToTokens = (text: string, max: number): string => {
  if (max <= 0) return ''
  const cps = Array.from(text)
  let tokens = 0
  let otherRun = 0
  for (let i = 0; i < cps.length; i += 1) {
    const c = cps[i]!.codePointAt(0) ?? 0
    if (isCJK(c)) {
      tokens += 1
    } else {
      otherRun += 1
      if (otherRun % 4 === 0) tokens += 1
    }
    if (tokens >= max) {
      if (i + 1 >= cps.length) return text
      return `${cps.slice(0, i + 1).join('')}…（截断）`
    }
  }
  return text
}

// Truncate keeping both head and tail under CJK-aware accounting.
//
// Why head+tail (not head-only): the v0.38 acceptance data (2026-09-12) showed
// the model reads tool results from the MIDDLE — 97% of `read` calls in Run2
// carried an offset (median 640, max 2569), and 65% of `bash` localization reads
// targeted mid/tail. A head-only truncation (the old truncateToTokens) drops
// exactly the part the model wants: code bodies, pytest's `short test summary
// info` / FAILED block (which lives at the END of test output).
//
// Returns head + tail separately so the caller splices its own marker between
// them. When the text fits within headTokens + tailTokens, `truncated` is false
// and `head` holds the original text (caller leaves the turn alone).
export type HeadTailTruncation = {
  head: string
  tail: string
  truncated: boolean
  totalTokens: number
}

export const truncateHeadTail = (
  text: string,
  headTokens: number,
  tailTokens: number,
): HeadTailTruncation => {
  const totalTokens = estimateTokens(text)
  if (headTokens <= 0 && tailTokens <= 0) {
    return { head: '', tail: '', truncated: false, totalTokens }
  }
  const cps = Array.from(text)

  // Head: walk forward, accumulate to headTokens.
  let headEnd = 0
  let tokens = 0
  let otherRun = 0
  while (headEnd < cps.length) {
    const c = cps[headEnd]!.codePointAt(0) ?? 0
    if (isCJK(c)) tokens += 1
    else { otherRun += 1; if (otherRun % 4 === 0) tokens += 1 }
    if (tokens >= headTokens) break
    headEnd += 1
  }

  // Tail: walk backward from the end, accumulate to tailTokens.
  let tailStart = cps.length
  let tTokens = 0
  let tOtherRun = 0
  while (tailStart > headEnd) {
    const c = cps[tailStart - 1]!.codePointAt(0) ?? 0
    if (isCJK(c)) tTokens += 1
    else { tOtherRun += 1; if (tOtherRun % 4 === 0) tTokens += 1 }
    if (tTokens >= tailTokens) break
    tailStart -= 1
  }

  // Overlap or full coverage → no truncation needed.
  if (tailStart <= headEnd) {
    return { head: text, tail: '', truncated: false, totalTokens }
  }
  return {
    head: cps.slice(0, headEnd).join(''),
    tail: cps.slice(tailStart).join(''),
    truncated: true,
    totalTokens,
  }
}
