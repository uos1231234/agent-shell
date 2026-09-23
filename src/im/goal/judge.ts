// v0.41 goal 模式 — 独立完成判定方（judge）。
//
// 为什么判定要外包（计划 D2 / 原则 1）：被测场景是"喂分块长上下文 + 末尾问针"，
// 工作代理有提前收工的动机——任务越长、上下文越满，它越倾向于把"我陈述了结论"
// 当成"我完成了目标"。judge 是**无工具、只判不做工**的独立裁决方，它的判据只能
// 是历史里的可验证证据，无法被工作代理的叙述说服。
//
// 视野 = 全量 canonical（D3，用户拍板）：与工作代理同视野，零截断。代价是每次
// 裁决一轮全上下文调用，总成本 maxRounds × 全上下文。

import { createSystemAgent } from '../system-agent.js'
import { JUDGE_AGENT_PROMPT } from '../prompts/index.js'
import { turnToMessage } from '../turn.js'
import { defaultLogger } from '../../shared/logger.js'
import type { Logger } from '../../shared/logger.js'
import type { ConversationMemory } from '../conversation-memory.js'
import type { Mailbox } from '../mailbox/index.js'
import type { ToolRegistry } from '../../shell/registry.js'
import type { StateLine } from '../state-line/types.js'
import type { ChatMessage, StreamChunk } from '../../protocol/types.js'
import type { GoalJudgement, GoalVerdictResult } from './types.js'
import { GENERIC_TOKEN_COUNTER, type TokenCounter } from '../../shared/token-counter.js'

/** 与 createSystemAgent 的 llmStreamChat 同形（那里是内联类型，无具名导出）。 */
export type GoalJudgeStreamChat = (
  url: string,
  request: { model: string; messages: ChatMessage[]; tools: unknown[]; [k: string]: unknown },
) => AsyncIterable<StreamChunk>

export type GoalJudgeDeps = {
  /**
   * 每次裁决现解析（D18：judge 用当前激活 provider，跟随 /provider use 热切换）。
   * 与 assembly 的 resolveCurrentPlan() 同源；createWikiGenerateManager 的
   * resolveLlm 是同一个形状的先例。
   *
   * `strictAlternation`（D19）：judge 把全量 canonical 逐字铺进自己的请求，
   * 而 goal 模式下的 canonical 会出现相邻 user（压缩信封 mem- 紧邻续跑提醒
   * goal-，G1 合并的块右边界正是提醒回合）。不转写的话严格交替 provider 会在
   * **裁决调用**上 400 → judge_failed → fail-open 空转，D19 想防的失败换了个
   * 位置发生。distiller 不需要（它的请求只有一条自造 user 消息）。
   */
  resolveLlm: () => { url: string; model: string; streamChat: GoalJudgeStreamChat; strictAlternation: boolean; tokenCounter?: TokenCounter }
  mailbox: Mailbox
  registry: ToolRegistry
  stateLine: StateLine
  logger?: Logger | undefined
}

export type GoalJudgeInput = {
  condition: string
  conversationMemory: ConversationMemory
  /** 从 1 起算的当前分歧循环序号。 */
  round: number
  maxRounds: number
  signal: AbortSignal | undefined
}

export type GoalJudge = {
  /**
   * **不抛错**（D15 fail-open）：任何失败都折叠成
   * `{ verdict: 'judge_failed', reason: 'judge 调用失败：<原始错误>' }`。
   *
   * reason 必须如实写失败，**不得编造一个未达成理由**——它逐字进下一轮提醒的
   * #JUDGE_REASON，编造等于让工作代理照着假理由改方向。
   */
  evaluate(input: GoalJudgeInput): Promise<GoalVerdictResult>
}

/**
 * 裁决请求——追加在全量历史之后作为最后一条 user 消息。形状与
 * judge-agent.md 的"你看到什么"§3 逐字对应（改一处必须同步另一处，
 * 有测试钉住）。
 */
export const buildJudgeRequest = (input: {
  condition: string
  round: number
  maxRounds: number
}): ChatMessage => ({
  role: 'user',
  content: [
    `#GOAL_CONDITION ${input.condition}`,
    `#ROUND ${input.round}/${input.maxRounds}`,
    '请裁决上面的完整历史是否已经达成 #GOAL_CONDITION。',
    '只输出纯 JSON：{"verdict":"met"|"not_met"|"impossible","reason":"..."}',
  ].join('\n'),
})

const isGoalJudgement = (v: unknown): v is GoalJudgement =>
  v === 'met' || v === 'not_met' || v === 'impossible'

/**
 * 解析 judge 回复。三段式与 parseCuratedMemoryOutput（drive-coordinator.ts:176-208）
 * 同构：纯 JSON → ```json 围栏回退 → 字段校验。校验失败一律抛错，由 evaluate
 * 折叠成 judge_failed。
 *
 * `reason` 必填非空：它逐字进下一轮提醒，是工作代理唯一的纠正依据。一个
 * not_met 却不给理由的裁决不可用——按解析失败处理，走 judge_failed 的如实
 * 上报路径，而不是拿空字符串糊过去。
 *
 * 'judge_failed' 不在此接受：那是 Node 侧在判定没跑成时合成的值，LLM 不得产出。
 */
export const parseGoalVerdict = (output: unknown): GoalVerdictResult => {
  if (typeof output !== 'string') {
    throw new Error('judge produced no reply text (expected verdict JSON)')
  }
  const trimmed = output.trim()
  if (trimmed.length === 0) {
    throw new Error('judge reply was empty (expected verdict JSON)')
  }

  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (!fence) {
      throw new Error('judge reply was not valid JSON and contained no ```json fenced block')
    }
    try {
      obj = JSON.parse(fence[1]!.trim())
    } catch {
      throw new Error('judge reply contained a ```json fenced block but its content was not valid JSON')
    }
  }

  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error(`judge reply was not a JSON object (got ${Array.isArray(obj) ? 'an array' : typeof obj})`)
  }
  const raw = obj as { verdict?: unknown; reason?: unknown }
  if (!isGoalJudgement(raw.verdict)) {
    throw new Error(`judge verdict must be one of met/not_met/impossible, got ${JSON.stringify(raw.verdict)}`)
  }
  if (typeof raw.reason !== 'string' || raw.reason.trim().length === 0) {
    throw new Error(`judge reason must be a non-empty string, got ${JSON.stringify(raw.reason)}`)
  }
  return { verdict: raw.verdict, reason: raw.reason }
}

export const createGoalJudge = (deps: GoalJudgeDeps): GoalJudge => {
  const log = (deps.logger ?? defaultLogger).child({ component: 'goal-judge' })

  return {
    evaluate: async (input) => {
      try {
        const { url, model, streamChat, strictAlternation, tokenCounter } = deps.resolveLlm()
        const agent = createSystemAgent({
          name: 'judge',
          systemPrompt: JUDGE_AGENT_PROMPT,
          // 无工具是 judge 独立性的结构保证：它没有能力"帮它补一步"，
          // 一旦能执行动作，裁决方就成了执行方。
          toolRefs: [],
          llmStreamChat: streamChat,
          url,
          model,
          mailbox: deps.mailbox,
          registry: deps.registry,
          stateLine: deps.stateLine,
          // turn.cancel 必须能穿透到在飞的 judge 调用（见 createSystemAgent
          // 的 signal opt 注释）。
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          // D19：与工作代理出站同一处转写（shell/call.ts），理由见 resolveLlm 注释。
          ...(strictAlternation ? { strictAlternation: true } : {}),
          tokenCounter: tokenCounter ?? GENERIC_TOKEN_COUNTER,
          // 刻意**不装** compaction（偏离计划 §5.3 的初稿，理由如下）。
          // judge 的判据必须是原始证据。若它自己的 loop 触发交接笔记压缩，
          // 它就在审摘要而不是审历史——正是原则 2（judge 先于压缩、必须看到
          // 未压缩证据）要防的失效模式，只是换了个位置发生。
          // 不装的后果：单轮超大时请求 400 → judge_failed → fail-open 续跑，
          // 而 G1 随即会把该块压掉，下一轮 judge 视野恢复有界（自愈）。
          // 诚实的失败优于静默的降级。
        })
        const messages: ChatMessage[] = [
          ...input.conversationMemory.turns().map(turnToMessage),
          buildJudgeRequest(input),
        ]
        const result = await agent.run({ messages, metadata: { kind: 'judge' } })
        return parseGoalVerdict(result.output)
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e)
        log.warn('goal judge failed (fail-open: continue)', { err, round: input.round })
        return { verdict: 'judge_failed', reason: `judge 调用失败：${err}` }
      }
    },
  }
}
