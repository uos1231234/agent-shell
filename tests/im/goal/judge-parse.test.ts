// v0.41 goal 模式 — judge 裁决解析与请求构造（纯函数）测试。
//
// parseGoalVerdict 是 judge 的唯一信任边界：LLM 的输出在这里变成机器可读的
// 裁决。它必须严格——一个 not_met 却没有理由的裁决不可用（理由会逐字进下一轮
// 提醒，是工作代理唯一的纠正依据），拿空字符串糊过去等于让代理照着空气改方向。

import { describe, it, expect } from 'vitest'
import { parseGoalVerdict, buildJudgeRequest } from '../../../src/im/goal/judge.js'
import { JUDGE_AGENT_PROMPT } from '../../../src/im/prompts/index.js'

const json = (o: unknown): string => JSON.stringify(o)

describe('parseGoalVerdict — 正常形态', () => {
  it('纯 JSON 的三种合法裁决', () => {
    expect(parseGoalVerdict(json({ verdict: 'met', reason: '两个文件的写入证据都在' })))
      .toEqual({ verdict: 'met', reason: '两个文件的写入证据都在' })
    expect(parseGoalVerdict(json({ verdict: 'not_met', reason: 'b.txt 无写入证据' })))
      .toEqual({ verdict: 'not_met', reason: 'b.txt 无写入证据' })
    expect(parseGoalVerdict(json({ verdict: 'impossible', reason: '目标要求的权限不存在' })))
      .toEqual({ verdict: 'impossible', reason: '目标要求的权限不存在' })
  })

  it('前后空白被容忍', () => {
    expect(parseGoalVerdict(`\n\n  ${json({ verdict: 'met', reason: 'ok' })}  \n`))
      .toEqual({ verdict: 'met', reason: 'ok' })
  })

  it('```json 围栏回退（部分模型无视"不要围栏"的指令）', () => {
    const fenced = '```json\n' + json({ verdict: 'not_met', reason: '缺证据' }) + '\n```'
    expect(parseGoalVerdict(fenced)).toEqual({ verdict: 'not_met', reason: '缺证据' })
  })

  it('无语言标注的 ``` 围栏同样回退', () => {
    const fenced = '```\n' + json({ verdict: 'met', reason: 'ok' }) + '\n```'
    expect(parseGoalVerdict(fenced)).toEqual({ verdict: 'met', reason: 'ok' })
  })

  it('围栏外有废话也能取出（模型加了前言）', () => {
    const noisy = '好的，我的裁决如下：\n```json\n' + json({ verdict: 'met', reason: 'ok' }) + '\n```'
    expect(parseGoalVerdict(noisy)).toEqual({ verdict: 'met', reason: 'ok' })
  })

  it('schema 之外的多余字段被忽略（与 validateCuratedMemory 同宽容度）', () => {
    expect(parseGoalVerdict(json({ verdict: 'met', reason: 'ok', confidence: 0.9, metadata: {} })))
      .toEqual({ verdict: 'met', reason: 'ok' })
  })
})

describe('parseGoalVerdict — 非法输入一律抛错（由 evaluate 折叠成 judge_failed）', () => {
  it('非字符串输出', () => {
    expect(() => parseGoalVerdict(undefined)).toThrow(/no reply text/)
    expect(() => parseGoalVerdict(null)).toThrow(/no reply text/)
    expect(() => parseGoalVerdict({ verdict: 'met' })).toThrow(/no reply text/)
  })

  it('空字符串与纯空白', () => {
    expect(() => parseGoalVerdict('')).toThrow(/was empty/)
    expect(() => parseGoalVerdict('   \n  ')).toThrow(/was empty/)
  })

  it('既不是 JSON 也没有围栏', () => {
    expect(() => parseGoalVerdict('我认为目标已经达成了')).toThrow(/not valid JSON/)
  })

  it('围栏里的内容不是 JSON', () => {
    expect(() => parseGoalVerdict('```json\n这不是 JSON\n```')).toThrow(/not valid JSON/)
  })

  it('JSON 但不是对象', () => {
    expect(() => parseGoalVerdict('[1,2,3]')).toThrow(/not a JSON object/)
    expect(() => parseGoalVerdict('"met"')).toThrow(/not a JSON object/)
    expect(() => parseGoalVerdict('42')).toThrow(/not a JSON object/)
  })

  it('verdict 缺失或不是合法值', () => {
    expect(() => parseGoalVerdict(json({ reason: 'ok' }))).toThrow(/must be one of met\/not_met\/impossible/)
    expect(() => parseGoalVerdict(json({ verdict: 'done', reason: 'ok' }))).toThrow(/must be one of/)
    expect(() => parseGoalVerdict(json({ verdict: 'MET', reason: 'ok' }))).toThrow(/must be one of/)
    expect(() => parseGoalVerdict(json({ verdict: true, reason: 'ok' }))).toThrow(/must be one of/)
  })

  it("verdict 为 'judge_failed' 被拒——那是 Node 侧合成值，LLM 不得产出", () => {
    expect(() => parseGoalVerdict(json({ verdict: 'judge_failed', reason: 'x' }))).toThrow(/must be one of/)
  })

  it('reason 缺失 / 空 / 纯空白 / 非字符串', () => {
    expect(() => parseGoalVerdict(json({ verdict: 'not_met' }))).toThrow(/non-empty string/)
    expect(() => parseGoalVerdict(json({ verdict: 'not_met', reason: '' }))).toThrow(/non-empty string/)
    expect(() => parseGoalVerdict(json({ verdict: 'not_met', reason: '   ' }))).toThrow(/non-empty string/)
    expect(() => parseGoalVerdict(json({ verdict: 'not_met', reason: null }))).toThrow(/non-empty string/)
    expect(() => parseGoalVerdict(json({ verdict: 'met', reason: 42 }))).toThrow(/non-empty string/)
  })

  it('met 与 impossible 同样要求 reason（审计需要知道据何判定）', () => {
    expect(() => parseGoalVerdict(json({ verdict: 'met' }))).toThrow(/non-empty string/)
    expect(() => parseGoalVerdict(json({ verdict: 'impossible', reason: '' }))).toThrow(/non-empty string/)
  })
})

describe('buildJudgeRequest — 请求形状与提示词文档逐字对应', () => {
  const req = buildJudgeRequest({ condition: '写出 a.txt 与 b.txt', round: 3, maxRounds: 24 })

  it('是一条 role:user 消息（追加在全量历史之后，保持角色交替）', () => {
    expect(req.role).toBe('user')
  })

  it('四行结构与 judge-agent.md 的示例一致', () => {
    const content = typeof req.content === 'string' ? req.content : ''
    const lines = content.split('\n')
    expect(lines).toEqual([
      '#GOAL_CONDITION 写出 a.txt 与 b.txt',
      '#ROUND 3/24',
      '请裁决上面的完整历史是否已经达成 #GOAL_CONDITION。',
      '只输出纯 JSON：{"verdict":"met"|"not_met"|"impossible","reason":"..."}',
    ])
  })

  it('goal 条件逐字进 #GOAL_CONDITION（不改写、不概括）', () => {
    const condition = '目标含特殊字符 → 原样：a.txt、b.txt、100% 完成'
    const content = buildJudgeRequest({ condition, round: 1, maxRounds: 24 }).content
    expect(content).toContain(`#GOAL_CONDITION ${condition}`)
  })

  it('提示词里记载的示例形状与本函数产出一致（改一处必须同步另一处）', () => {
    // judge-agent.md 的"你看到什么"§3 展示了请求形状。两者漂移会让提示词
    // 描述一个模型实际收不到的格式。
    expect(JUDGE_AGENT_PROMPT).toContain('#GOAL_CONDITION <目标条件原文>')
    expect(JUDGE_AGENT_PROMPT).toContain('#ROUND <当前是第几次分歧循环>/<上限>')
    expect(JUDGE_AGENT_PROMPT).toContain('请裁决上面的完整历史是否已经达成 #GOAL_CONDITION。')
    expect(JUDGE_AGENT_PROMPT).toContain('只输出纯 JSON：{"verdict":"met"|"not_met"|"impossible","reason":"..."}')
  })
})
