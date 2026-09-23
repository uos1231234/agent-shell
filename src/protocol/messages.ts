// 出站 wire 规范化 —— v0.41 D19（用户拍板："协议问题可以在协议层做一个转写"）。
//
// 问题：canonical 里会出现相邻的 role:'user' 回合。两个已知来源：
//   1. 压缩信封（`mem-`）紧邻 goal 续跑提醒（`goal-`）——goal 模式下每次块
//      合并必发（AGENTS.md §6.27 ④ 记录在案的适配点）；
//   2. 系统智能体的请求尾部：createSystemAgent 硬编码 userTemplate: ''，而
//      omitUserTemplatePart 对空模板返回 false，所以裁决/压缩请求后面总跟着
//      一条空 user 消息（compressor / warehouse / recall / judge / distill 全都如此）。
//
// OpenAI 兼容栈容忍相邻 user；**Anthropic 的严格交替会 400**。
//
// 分层：canonical 保持诚实结构（信封与提醒是两个独立回合，落盘 / 恢复 / 轨迹
// 视图都看得到），只在**出站 wire** 上合并。规则本体住在这里（与 wire 词汇、
// tool-calls.ts 同层），唯一应用点在 shell/call.ts 构造 fullRequest 处——那是
// 所有 streamChat 实现（内置 client / llm-adapter / mock）的必经之路，对齐
// §6.14 "extractChunks 唯一翻译点" 的纪律。
//
// **无损**：合并是拼接，不丢弃任何非空内容。它不是截断机制（AGENTS.md 铁律）。

import type { ChatMessage, ContentPart } from './types.js'

/** 合并相邻 user 消息时插入的分隔。两个空行：markdown 段落边界，不吞正文。 */
const MERGE_SEPARATOR = '\n\n'

const isBlank = (text: string): boolean => text.trim().length === 0

/**
 * 把一段连续的 user 消息合并成一条。
 *
 * 全是字符串时产出字符串（保持最常见形态不变，也让 judge/compressor 那条
 * "请求 + 空模板"合并后仍是纯文本）；任一条带 ContentPart（图片）时产出
 * ContentPart[]，字符串段转成 text part。
 *
 * 空白段被跳过：空字符串不携带信息，留着只会在正文里插一串多余的分隔符
 * （来源 2 的空 userTemplate 正是这种情况）。这不是截断——没有任何非空内容
 * 被丢弃。
 */
const mergeUserRun = (run: readonly ChatMessage[]): ChatMessage => {
  const allStrings = run.every((m) => m.role === 'user' && typeof m.content === 'string')
  if (allStrings) {
    const text = run
      .map((m) => (m.role === 'user' && typeof m.content === 'string' ? m.content : ''))
      .filter((s) => !isBlank(s))
      .join(MERGE_SEPARATOR)
    return { role: 'user', content: text }
  }

  const parts: ContentPart[] = []
  for (const m of run) {
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') {
      if (!isBlank(m.content)) parts.push({ type: 'text', text: m.content })
    } else {
      parts.push(...m.content)
    }
  }
  return { role: 'user', content: parts }
}

/**
 * 合并相邻的 `role:'user'` 消息，让严格交替的 provider 不会 400。
 *
 * **只处理 user**，其余角色刻意不动，每个排除都有具体理由：
 * - `tool`：连续的 tool 消息是协议合法的（每个 tool_call_id 一条），合并会
 *   摧毁 tool_call_id ↔ 结果的配对。
 * - `assistant`：合并会有 tool_calls 配对风险；且我们的 canonical 不产出相邻
 *   assistant（finalizeRound 每轮只 append 一个，工具轮之间必隔着 tool 回合）。
 * - `system`：多条 system part 是刻意的（系统提示词 + runtime/temporal 注入 +
 *   MEMORY.md 注入，见 loop.ts:239-252 的组装顺序）；严格交替约束的是
 *   user/assistant 轮次，而 Anthropic 把 system 作为顶层独立字段传递。
 *
 * 无相邻 user 时返回内容等价的副本（调用方可安全复用）。幂等：对已规范化的
 * 序列再跑一次结果不变。
 */
export const normalizeStrictAlternation = (messages: readonly ChatMessage[]): ChatMessage[] => {
  const out: ChatMessage[] = []
  let run: ChatMessage[] = []

  const flush = (): void => {
    if (run.length === 0) return
    if (run.length === 1) out.push(run[0]!)
    else out.push(mergeUserRun(run))
    run = []
  }

  for (const m of messages) {
    if (m.role === 'user') {
      run.push(m)
      continue
    }
    flush()
    out.push(m)
  }
  flush()
  return out
}

/** 序列里是否存在相邻 user（供日志与测试判定"这次转写是否真的改了形状"）。 */
export const hasAdjacentUserMessages = (messages: readonly ChatMessage[]): boolean => {
  for (let i = 1; i < messages.length; i += 1) {
    if (messages[i]!.role === 'user' && messages[i - 1]!.role === 'user') return true
  }
  return false
}
