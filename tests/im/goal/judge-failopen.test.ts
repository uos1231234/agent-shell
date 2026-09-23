// v0.41 goal 模式 — judge 的失败语义与视野测试。
//
// 两条承重性质：
//  (1) **D3 全量视野**：judge 必须看到工作代理的完整 canonical，一条不少——
//      这是"独立裁决"有意义的前提，也是原则 2（judge 先于压缩）的落点。
//  (2) **D15 fail-open 且不撒谎**：任何失败都折叠成 judge_failed 续跑，
//      reason 如实带出原始错误，绝不编造一个"未达成理由"。

import { describe, it, expect } from 'vitest'
import { createGoalJudge, type GoalJudgeStreamChat } from '../../../src/im/goal/judge.js'
import { JUDGE_AGENT_PROMPT } from '../../../src/im/prompts/index.js'
import { ConversationMemory } from '../../../src/im/conversation-memory.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import { ToolRegistry } from '../../../src/shell/registry.js'
import { createNoopStateLine } from '../../../src/im/state-line/index.js'
import type { ChatMessage } from '../../../src/protocol/types.js'

type Captured = { url: string; messages: ChatMessage[]; tools: unknown }

/** 统一取消息文本：system/tool 是 string，user 可能是 ContentPart[]，assistant 可能是 null。 */
const contentOf = (m: ChatMessage): string => {
  const c = (m as { content?: unknown }).content
  if (typeof c === 'string') return c
  return c === undefined || c === null ? '' : JSON.stringify(c)
}

const makeStreamChat = (reply: string | Error): { streamChat: GoalJudgeStreamChat; captured: Captured[] } => {
  const captured: Captured[] = []
  const streamChat: GoalJudgeStreamChat = async function* (_url, request) {
    captured.push({ url: _url, messages: request.messages, tools: request.tools })
    if (reply instanceof Error) throw reply
    yield { type: 'content_delta', text: reply }
    yield { type: 'finish', reason: 'stop' }
    yield { type: 'usage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
    yield { type: 'done' }
  }
  return { streamChat, captured }
}

const memoryWith = (...contents: string[]): ConversationMemory => {
  const m = new ConversationMemory()
  contents.forEach((c, i) => {
    m.append(i % 2 === 0
      ? { id: `user-${i}`, role: 'user', content: c, at: i }
      : { id: `assistant-${i}`, role: 'assistant', content: c, at: i })
  })
  return m
}

const buildJudge = (reply: string | Error, opts?: { resolveLlm?: () => { url: string; model: string; streamChat: GoalJudgeStreamChat; strictAlternation: boolean } }) => {
  const { streamChat, captured } = makeStreamChat(reply)
  const judge = createGoalJudge({
    resolveLlm: opts?.resolveLlm ?? (() => ({ url: 'https://judge.test', model: 'judge-model', streamChat, strictAlternation: false })),
    mailbox: new Mailbox(),
    registry: new ToolRegistry(),
    stateLine: createNoopStateLine(),
  })
  return { judge, captured }
}

const okReply = JSON.stringify({ verdict: 'not_met', reason: 'b.txt 无写入证据' })

describe('createGoalJudge — D3 全量视野', () => {
  it('请求体 = 系统提示词 + 全量 canonical（逐条、按序）+ 裁决请求', async () => {
    const { judge, captured } = buildJudge(okReply)
    const memory = memoryWith('用户请求', '第一轮回答', '续跑提醒', '第二轮回答')

    await judge.evaluate({ condition: '写出 a.txt 与 b.txt', conversationMemory: memory, round: 1, maxRounds: 24, signal: undefined })

    expect(captured).toHaveLength(1)
    const messages = captured[0]!.messages
    // [0] 系统提示词（compose 会在其后追加 projection.systemSuffix，所以用 contains）
    expect(messages[0]!.role).toBe('system')
    expect(contentOf(messages[0]!)).toContain(JUDGE_AGENT_PROMPT.slice(0, 40))

    // 真实布局：[system, ...canonical 逐条按序, 裁决请求, 空 user 消息]。
    // 末尾那条空消息来自 createSystemAgent 硬编码的 userTemplate: ''——
    // omitUserTemplatePart（loop.ts:284）对空模板返回 false，所以
    // userTemplatePart('') 总被加上。这是**所有**系统智能体（compressor /
    // warehouse / recall）的既有形状，不是 judge 特有；本测试如实记录它，
    // 不去改共享行为。strictAlternation 转写（v0.41 Wave 5）会把它与裁决
    // 请求合并，正好消除这个相邻 user。
    const bodies = messages.slice(1).map(contentOf)
    expect(bodies.slice(0, 4)).toEqual(['用户请求', '第一轮回答', '续跑提醒', '第二轮回答'])
    expect(bodies[4]).toContain('#GOAL_CONDITION 写出 a.txt 与 b.txt')
    expect(bodies[5]).toBe('')
  })

  it('不暴露任何工具（toolRefs: [] → compose 省略空 tools 数组）', async () => {
    const { judge, captured } = buildJudge(okReply)
    await judge.evaluate({ condition: 'c', conversationMemory: memoryWith('u', 'a'), round: 1, maxRounds: 24, signal: undefined })
    // call.ts:74 —— 空 tools 数组被省略（OpenAI 形状 provider 拒绝 "tools": []）
    expect(captured[0]!.tools).toBeUndefined()
  })

  it('空历史也能裁决（只剩系统提示词 + 裁决请求 + 空模板）', async () => {
    const { judge, captured } = buildJudge(okReply)
    await judge.evaluate({ condition: 'c', conversationMemory: new ConversationMemory(), round: 1, maxRounds: 24, signal: undefined })
    const messages = captured[0]!.messages
    expect(messages).toHaveLength(3)
    expect(messages[0]!.role).toBe('system')
    expect(messages[1]!.role).toBe('user')
    expect(contentOf(messages[1]!)).toContain('#GOAL_CONDITION c')
    expect(contentOf(messages[2]!)).toBe('')
  })
})

describe('createGoalJudge — 正常裁决', () => {
  it('返回解析后的裁决', async () => {
    const { judge } = buildJudge(okReply)
    await expect(judge.evaluate({
      condition: 'c', conversationMemory: memoryWith('u', 'a'), round: 2, maxRounds: 24, signal: undefined,
    })).resolves.toEqual({ verdict: 'not_met', reason: 'b.txt 无写入证据' })
  })

  it('met 与 impossible 同样透传', async () => {
    for (const v of ['met', 'impossible'] as const) {
      const { judge } = buildJudge(JSON.stringify({ verdict: v, reason: 'r' }))
      await expect(judge.evaluate({
        condition: 'c', conversationMemory: memoryWith('u', 'a'), round: 1, maxRounds: 24, signal: undefined,
      })).resolves.toEqual({ verdict: v, reason: 'r' })
    }
  })

  it('每次 evaluate 现解析 provider（D18：跟随 /provider use 热切换）', async () => {
    const { streamChat, captured } = makeStreamChat(okReply)
    let call = 0
    const judge = createGoalJudge({
      resolveLlm: () => {
        call += 1
        return call === 1
          ? { url: 'https://a.test', model: 'model-a', streamChat, strictAlternation: false }
          : { url: 'https://b.test', model: 'model-b', streamChat, strictAlternation: false }
      },
      mailbox: new Mailbox(),
      registry: new ToolRegistry(),
      stateLine: createNoopStateLine(),
    })

    await judge.evaluate({ condition: 'c', conversationMemory: memoryWith('u', 'a'), round: 1, maxRounds: 24, signal: undefined })
    await judge.evaluate({ condition: 'c', conversationMemory: memoryWith('u', 'a'), round: 2, maxRounds: 24, signal: undefined })

    expect(call).toBe(2)
    expect(captured.map((c) => c.url)).toEqual(['https://a.test', 'https://b.test'])
  })
})

describe('createGoalJudge — D15 fail-open，且不撒谎', () => {
  it('streamChat 抛错 → judge_failed，reason 如实带出原始错误，不抛出', async () => {
    const { judge } = buildJudge(new Error('ETIMEDOUT after 30s'))
    const result = await judge.evaluate({
      condition: 'c', conversationMemory: memoryWith('u', 'a'), round: 4, maxRounds: 24, signal: undefined,
    })
    expect(result.verdict).toBe('judge_failed')
    expect(result.reason).toBe('judge 调用失败：ETIMEDOUT after 30s')
    // 不得伪装成一次真实裁决
    expect(result.reason).not.toContain('未达成')
  })

  it('回复不是合法 JSON → judge_failed', async () => {
    const { judge } = buildJudge('我觉得目标已经达成了')
    const result = await judge.evaluate({
      condition: 'c', conversationMemory: memoryWith('u', 'a'), round: 1, maxRounds: 24, signal: undefined,
    })
    expect(result.verdict).toBe('judge_failed')
    expect(result.reason).toMatch(/^judge 调用失败：/)
  })

  it('not_met 但 reason 为空 → judge_failed（空理由的裁决不可用）', async () => {
    const { judge } = buildJudge(JSON.stringify({ verdict: 'not_met', reason: '' }))
    const result = await judge.evaluate({
      condition: 'c', conversationMemory: memoryWith('u', 'a'), round: 1, maxRounds: 24, signal: undefined,
    })
    expect(result.verdict).toBe('judge_failed')
    expect(result.reason).toMatch(/non-empty string/)
  })

  it('LLM 自己吐出 judge_failed → 视为非法输出，仍走 fail-open', async () => {
    const { judge } = buildJudge(JSON.stringify({ verdict: 'judge_failed', reason: 'x' }))
    const result = await judge.evaluate({
      condition: 'c', conversationMemory: memoryWith('u', 'a'), round: 1, maxRounds: 24, signal: undefined,
    })
    expect(result.verdict).toBe('judge_failed')
    expect(result.reason).toMatch(/^judge 调用失败：/)
  })

  it('预先 abort 的信号 → judge_failed 而不是挂住（turn.cancel 穿透）', async () => {
    const { judge } = buildJudge(okReply)
    const ac = new AbortController()
    ac.abort()
    const result = await judge.evaluate({
      condition: 'c', conversationMemory: memoryWith('u', 'a'), round: 1, maxRounds: 24, signal: ac.signal,
    })
    expect(result.verdict).toBe('judge_failed')
    expect(result.reason).toMatch(/^judge 调用失败：/)
  })

  it('非 Error 抛出也能如实带出', async () => {
    const captured: Captured[] = []
    const streamChat: GoalJudgeStreamChat = async function* (_url, request) {
      captured.push({ url: _url, messages: request.messages, tools: request.tools })
      throw 'plain string failure'
    }
    const judge = createGoalJudge({
      resolveLlm: () => ({ url: 'https://x', model: 'm', streamChat, strictAlternation: false }),
      mailbox: new Mailbox(),
      registry: new ToolRegistry(),
      stateLine: createNoopStateLine(),
    })
    const result = await judge.evaluate({
      condition: 'c', conversationMemory: memoryWith('u', 'a'), round: 1, maxRounds: 24, signal: undefined,
    })
    expect(result).toEqual({ verdict: 'judge_failed', reason: 'judge 调用失败：plain string failure' })
  })
})
