// v0.41 goal 模式 — G2 信封区间折叠（LLM 保守合并）。
//
// G2 存在的理由（计划 §3.5）：G1 的压缩率**只**来自丢掉输入材料，所以
// "短问题 + 长回答"的块 G1 几乎不压（1:1）。G2 用 N→1 提供与块形状无关的
// 比例下界。
//
// 力度 = 保守合并档（D10，用户在三档中选定）：只消除跨块冗余，具体事实
// （数值 / 路径 / 错误信息全文 / 判定结论 / **被否决的方案与否决理由**）逐字
// 全留。不是 参考实现 的 L2 提纯（30-40%）也不是 L3 定位器（≤5%）——后两者
// 会把"末尾问针"场景里的针压掉。
//
// 为什么压**信封**而不是像 参考实现 那样压原文：参考实现 每轮重建投影、原文
// 常驻 store，所以能把同一个块按 L1→L2→L3 重渲染（戳基于块身份稳定，
// pipeline.ts:841-843）。我们是**原位突变** canonical，原文只在 raw-archive。
// 压信封便宜得多（N×3K vs N×80K），而且因为 G1 不设上限（D9），信封是
// 高保真的——压它不会复利损失。这就是 D8/D9 与 D10/D13 之间的因果关系。

import { createSystemAgent } from '../system-agent.js'
import { DISTILL_AGENT_PROMPT } from '../prompts/index.js'
import { envelopeGeneration, parseCuratedMemoryOutput } from '../system-agents/drive-coordinator.js'
import { GENERIC_TOKEN_COUNTER, type TokenCounter } from '../../shared/token-counter.js'
import type { CuratedMemory } from '../state-line/types.js'
import type { StateLine } from '../state-line/types.js'
import type { ConversationTurn } from '../conversation-memory.js'
import type { Mailbox } from '../mailbox/index.js'
import type { ToolRegistry } from '../../shell/registry.js'
import type { ChatMessage, StreamChunk } from '../../protocol/types.js'
import type { Logger } from '../../shared/logger.js'
import { defaultLogger } from '../../shared/logger.js'
import type { GoalJudgeStreamChat } from './judge.js'

export type DistillRun = {
  /** 连续信封区间 [startIndex, endIndexExclusive)，供 replaceRange 折叠。 */
  startIndex: number
  endIndexExclusive: number
  /** 区间内每个信封的原戳，顺序与区间一致 → 新块的 _sourceStamps 血缘。 */
  stamps: string[]
  /** 区间原文拼接（喂给 distiller 的输入）。 */
  text: string
  tokens: number
}

const isEnvelope = (t: ConversationTurn): boolean =>
  t.role === 'user' && t.id.startsWith('mem-')

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  return JSON.stringify(content)
}

/**
 * 取信封的原戳。buildCompressionEnvelope 把 `#STAMP <stamp>` 放在**第一行**，
 * 所以只认第一行——不用全文多行匹配，否则信封正文里若引用了别的戳
 * （例如 G2 产物 #NOTE 的血缘行）会被误取。
 */
export const extractEnvelopeStamp = (content: string): string | undefined => {
  const firstLine = content.split('\n', 1)[0] ?? ''
  const m = firstLine.match(/^#STAMP\s+(\S+)$/)
  return m?.[1]
}

/**
 * 定位最旧的、同时满足两个触发条件的连续信封区间。
 *
 * **连续性是自然产物，不需要特殊构造**：G1 最旧优先，每个块的起点紧接上一个
 * 信封，所以连续 G1 会产出相邻信封——
 *   [mem-A][goal-r1][work][asst] → G1 → [mem-A][mem-B][goal-r2]… → [mem-A][mem-B][mem-C]…
 *
 * 两个条件都要满足（体量 + 块数）：折叠本身要一次 LLM 调用，门槛不必太低。
 *
 * v0.41 后续补丁 (a′)：入参改为阈值对象，支持位置触发（上下文 ≥400K 时
 * minBlocks 4→2、minTokens 失效）。调用方（hooks.ts）按压力选档传入。
 *
 * 缺戳的区间**跳过**而不是部分折叠：血缘不完整会让被吞掉的那几个块再也无法
 * 按原戳召回，那是静默断链。信封由 buildCompressionEnvelope 构造、首行必有戳，
 * 所以缺戳意味着别处出了 bug，跳过并留痕比猜一个更负责。
 *
 * **代数硬闸（用户拍板 2026-09-22）**：区间内任一二代信封（G2 产物，有
 * #LINEAGE 行）→ 整个区间跳过。只允许 G1→G2，禁止 G2→G3——二代信封是 LLM
 * 转写的产物，再折叠就是转写的转写（复利保真损失 p^n），血缘也要多跳。
 * 窗口压力由 M3 归档出口承接（换出 + 墓碑 + 可召回，信息零损失）。
 */
export const findDistillRun = (
  turns: readonly ConversationTurn[],
  thresholds: { minBlocks: number; minTokens: number },
  tokenCounter = GENERIC_TOKEN_COUNTER,
): DistillRun | undefined => {
  let i = 0
  while (i < turns.length) {
    if (!isEnvelope(turns[i]!)) {
      i += 1
      continue
    }
    let j = i
    while (j < turns.length && isEnvelope(turns[j]!)) j += 1

    if (j - i >= thresholds.minBlocks) {
      const slice = turns.slice(i, j)
      const stamps: string[] = []
      let complete = true
      for (const t of slice) {
        const stamp = extractEnvelopeStamp(textOf(t.content))
        if (stamp === undefined) {
          complete = false
          break
        }
        stamps.push(stamp)
      }
      // 硬闸：全一代才可折叠。二代信封在区间里就跳过——不是"部分折叠前面
      // 几个"，整段跳过，等区间被 M3 归档清走或下一代 G1 积累出新区间。
      const allGen1 = slice.every((t) => envelopeGeneration(textOf(t.content)) === 1)
      if (complete && allGen1) {
        const text = slice.map((t) => textOf(t.content)).join('\n\n')
        const tokens = tokenCounter.count(text)
        if (tokens >= thresholds.minTokens) {
          return { startIndex: i, endIndexExclusive: j, stamps, text, tokens }
        }
      }
    }
    i = j
  }
  return undefined
}

/**
 * 折叠请求。形状与 distill-agent.md 的"你看到什么"§2 逐字对应（改一处必须
 * 同步另一处，有测试钉住）。
 */
export const buildDistillRequest = (input: { run: DistillRun; condition: string }): ChatMessage => ({
  role: 'user',
  content: [
    `#GOAL_CONDITION ${input.condition}`,
    `#BLOCKS ${input.run.stamps.length}`,
    `#SOURCE_STAMPS ${input.run.stamps.join(' ')}`,
    '请把下面这些相邻的已压缩记忆块合并成一个 11 字段 CuratedMemory 对象。',
    '只输出纯 JSON，不要围栏、不要解释。',
    '',
    input.run.text,
  ].join('\n'),
})

export type DistillerDeps = {
  /** 每次折叠现解析（D18：跟随 /provider use 热切换，与 judge 同源）。 */
  resolveLlm: () => { url: string; model: string; streamChat: GoalJudgeStreamChat; tokenCounter?: TokenCounter }
  mailbox: Mailbox
  registry: ToolRegistry
  stateLine: StateLine
  logger?: Logger | undefined
}

export type Distiller = {
  /**
   * **抛错**表示折叠失败，由 hooks.ts 按 D16 降级为不折叠、下一轮再试。
   * 不在这里吞错：G2 的失败策略属于 goal 编排，不属于提纯器本身。
   */
  distill(input: { run: DistillRun; condition: string; signal: AbortSignal | undefined }): Promise<CuratedMemory>
}

export const createDistiller = (deps: DistillerDeps): Distiller => {
  const log = (deps.logger ?? defaultLogger).child({ component: 'goal-distill' })

  return {
    distill: async (input) => {
      const { url, model, streamChat, tokenCounter } = deps.resolveLlm()
      const agent = createSystemAgent({
        name: 'distill',
        systemPrompt: DISTILL_AGENT_PROMPT,
        // 无工具：distill-agent.md 的硬规则 6 明写"不得调工具去查原始对话，
        // 你收到的就是完整输入"。给工具就等于允许它去翻 raw-archive 再摘要一遍。
        toolRefs: [],
        llmStreamChat: streamChat as (
          url: string,
          request: { model: string; messages: ChatMessage[]; tools: unknown[]; [k: string]: unknown },
        ) => AsyncIterable<StreamChunk>,
        url,
        model,
        tokenCounter: tokenCounter ?? GENERIC_TOKEN_COUNTER,
        mailbox: deps.mailbox,
        registry: deps.registry,
        stateLine: deps.stateLine,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        // 与 judge 同理**不装** compaction：输入是 N 个已压缩信封（体量本就
        // 有界，触发条件 distillMinTokens 默认 40K），不需要再折叠自己；
        // 装了反而可能在提纯前先把输入改掉。
      })
      const result = await agent.run({
        messages: [buildDistillRequest(input)],
        metadata: { kind: 'distill' },
      })
      log.debug('distiller run finished', {
        blocks: input.run.stamps.length, reason: result.reason, finalState: result.finalState,
      })
      // 复用 compressor 的解析器：同一个 11 字段契约、同一套围栏回退与校验。
      // 不写第二个解析器（约束 7：换生产者，不换 schema）。
      return parseCuratedMemoryOutput(result.output)
    },
  }
}
