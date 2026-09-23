// History tool-turn truncation (v0.30 D 机制, v0.38 重构)。
//
// 用户拍板（2026-09-12）：
//   1. 废弃 markdown 表格载体（不合理）→ tool turn 原位截断 content
//   2. 去掉批次扩展（不因大的截断而连坐同批次的小结果）→ 按单条判定
//   3. ceiling 100 → 500 token
//   4. 截断标记内联 12 位内容哈希戳（databus_query({stamp}) 可精确取回全文）
//
// 与 l1-demo handlers/compress.py 的同构点：戳内联进截断标记（"戳的可见性
// = 可发现性"），模型读 canonical 就能拿到召回钥匙。差异：l1-demo 用 LLM
// 压缩旧轮语义合并，我们用纯算法截断（不要语义合并 → 不调 LLM）。
//
// 执行点：afterToolExecution hook（HOOK 5）——工具执行后、本轮结果 append 前。
// 配对保持：原位截断只改 tool turn 的 content，不删 turn、不动 assistant
// toolCalls → 不产生孤儿 tool_call，无需配对保护（旧表格版需要，因为整批
// 删除会留下孤儿 assistant tool_calls 让 provider 400）。

import { GENERIC_TOKEN_COUNTER, type TokenCounter, truncateHeadTailWithCounter } from '../../shared/token-counter.js'
import { stampOfToolTurn } from '../databus.js'
import type { ConversationMemory, ConversationTurn } from '../conversation-memory.js'

export type ToolTableFoldOptions = {
  /** 热窗口：保留最近 N 个工具回合原样不动。默认 20（用户拍板）。 */
  keepRecent?: number
  /** result 超过此 token 数才截断；小结果保留原样。默认 2000（v0.39：500→2000，
   * 数据表明 Run2 max=3480 几乎全 <2000，500 截太狠；保头保尾各 1000）。 */
  resultTokenCeiling?: number
  tokenCounter?: TokenCounter
}

export type ToolTableFoldResult = {
  /** 被截断的 tool 回合数。 */
  folded: number
}

const RESULT_CELL_TOKENS = 2000

// 召回工具返回的内容本身就是从窗口外取回的证据。把它再次折叠会让
// "取回全文" 退化成"取回一段前后缀"；原始内容仍在各自的后端存储里，
// 但模型在当前轮已经拿到的召回证据不应被这个通用历史保护再次截断。
const RECALL_TOOL_NAMES = new Set(['state_query', 'ask_recall', 'databus_query'])

/**
 * 原位截断热窗口之外的超大工具结果。无可截断内容时返回 undefined
 * （canonical 零改动）。
 */
export const foldOversizeToolTurns = (
  conversationMemory: ConversationMemory,
  opts: ToolTableFoldOptions = {},
): ToolTableFoldResult | undefined => {
  const keepRecent = opts.keepRecent ?? 20
  const ceiling = opts.resultTokenCeiling ?? RESULT_CELL_TOKENS
  const turns = [...conversationMemory.turns()]

  // 工具回合索引表。
  const toolIdx: number[] = []
  for (let i = 0; i < turns.length; i += 1) {
    if (turns[i]!.role === 'tool') toolIdx.push(i)
  }
  if (toolIdx.length <= keepRecent) return undefined

  // 热区边界：最后 keepRecent 个工具回合中最早的索引；只截断它之前的。
  const hotBoundary = toolIdx[toolIdx.length - keepRecent]!
  const candidates = toolIdx.filter((i) => {
    const t = turns[i]!
    if (t.role !== 'tool' || i >= hotBoundary) return false
    if (t.toolName !== undefined && RECALL_TOOL_NAMES.has(t.toolName)) return false
    const content = String(t.content ?? '')
    // 幂等守卫（2026-09-13）：折叠后 content ≈ ceiling + 标记，仍会 > ceiling。
    // 不跳过则每轮 HOOK 5 再折叠一次，标记堆进尾部预算、真实尾内容被吞。
    if (content.includes('…（截断')) return false
    return (opts.tokenCounter ?? GENERIC_TOKEN_COUNTER).count(content) > ceiling
  })
  if (candidates.length === 0) return undefined

  // 从后往前原位截断（保索引不偏移；戳用原始 content，从后往前确保前面还没改）。
  // v0.39：保头 + 保尾各 ceiling/2。数据表明模型读中段/尾部（Run2 read offset
  // 中位 640、bash 中段定位占 60%），保头弃尾丢错方向；测试输出的 FAILED 摘要在末尾。
  const headBudget = Math.floor(ceiling / 2)
  const tailBudget = ceiling - headBudget
  for (const i of [...candidates].reverse()) {
    const t = turns[i] as Extract<ConversationTurn, { role: 'tool' }>
    const originalContent = String(t.content ?? '')
    const stamp = stampOfToolTurn(t)
    const counter = opts.tokenCounter ?? GENERIC_TOKEN_COUNTER
    const { head, tail, truncated, totalTokens } = truncateHeadTailWithCounter(
      originalContent,
      counter,
      headBudget,
      tailBudget,
    )
    if (!truncated) continue  // candidates 已过滤 >ceiling，此分支是边界保底
    // 2026-09-12 用户拍板：截断标记固定追加在内容**末尾**（不插头尾之间）——
    // 模型读完保留下来的头尾后，视线落点就是戳的位置。
    const marker =
      `\n\n…（截断 ${ceiling}→${totalTokens} token；戳 ${stamp}；` +
      `用 databus_query({stamp:'${stamp}'}) 取回全文）`
    conversationMemory.replaceRange(i, i + 1, [{ ...t, content: head + tail + marker }])
  }

  return { folded: candidates.length }
}
