// v0.41 goal 模式 — 生产装配接线验收（AGENTS.md §5：实现 ≠ 接线 ≠ 生效，
// 验收口径 = 真实 createHostAssembly 跑出来的行为，不是单元测试的桩）。
//
// 钉住四个接线点（行号见 docs/v0.41-验收报告.md 的接线点表）：
//   1. `attachHandle` 建 GoalSessionState + createGoalHooks → SessionAssets.goalHooks
//   2. `runPromptOnce` 的 mergeLoopHooks 第四路（goal 只产出 beforeComplete）
//   3. `handlers.goal` 三命令 + gate.emit('goal.changed')
//   4. `createDriveCoordinator({ goalModeActive })` —— D7 互斥：goal 激活时
//      tick 的块压缩派发关掉，压缩交给 G1/G2
// 外加 D19 的出站转写覆盖面：工作代理与 judge 两条出站路径都要转写。
//
// 两段验证：
//   A. mock 路径（judge/distill 锚点在 src/host/mock.ts）——续跑回合真的落进
//      canonical 与磁盘，事件序列如实。
//   B. 本地 http "服务商"——G1 经 resolveDriveCoordinator getter 真的落盘
//      （hooks.ts 警告的持值版本会静默拿到 noop）、信封 + 提醒产生相邻 user、
//      strictAlternation 开关决定出站是否合并。

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createHostAssembly, resolveLLMPlan } from '../../src/host/assembly.js'
import type { HostAssembly } from '../../src/host/assembly.js'
import { DEFAULT_GOAL_MAX_ROUNDS } from '../../src/im/goal/types.js'
import type { GoalEvent, GoalState } from '../../src/im/goal/types.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'host-goal-'))

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// A 段：mock 路径
// ---------------------------------------------------------------------------

/** 封闭装配：mock LLM + 不存在的 providerLookup 家目录（绝不读真实用户配置）。 */
const makeMockAssembly = (name: string): Promise<HostAssembly> =>
  createHostAssembly({
    dataDir: join(tmpRoot, `sessions-${name}`),
    mock: true,
    providerLookup: { homeDir: join(tmpRoot, `home-${name}`), env: {} },
    promptLayerUserPath: join(tmpRoot, `home-${name}`, 'no-such-PROMPT.md'),
  })

/**
 * 跑一条 prompt 并批准 mock 剧本发起的 write。
 *
 * 每个装配只跑一次 prompt——mock 的 callCount 只在第一次工作代理调用发 write
 * （后续调用恒回完成文本），所以"必有一次审批"在单 prompt 前提下是确定的。
 */
const runOnePromptApproved = async (
  assembly: HostAssembly,
  sessionId: string,
  text: string,
): Promise<string> => {
  const approvalIds: string[] = []
  assembly.gate.on('approval', (req) => {
    if (req.kind === 'approval') approvalIds.push(req.requestId)
  })
  const pending = assembly.handlers.runPrompt(sessionId, text)
  await vi.waitFor(() => expect(approvalIds.length).toBeGreaterThan(0), { timeout: 5000 })
  assembly.gate.resolve(approvalIds[0]!, 'approved')
  const result = await pending
  expect(result.reason).toBe('completed')
  return result.reason
}

const collectGoalEvents = (assembly: HostAssembly, sessionId: string): GoalEvent[] => {
  const events: GoalEvent[] = []
  assembly.gate.on('goal.changed', (s) => {
    if (s.kind === 'goal.changed' && s.sessionId === sessionId) events.push(s.event)
  })
  return events
}

describe('goal wiring through the production assembly (mock LLM)', () => {
  it('set → not_met → 续跑回合落进 canonical 与磁盘 → met → goal 自动关闭', { timeout: 30_000 }, async () => {
    const ws = join(tmpRoot, 'ws-core')
    mkdirSync(ws, { recursive: true })
    const assembly = await makeMockAssembly('core')
    try {
      const handle = await assembly.handlers.session.create({ workDir: ws })
      const sessionId = handle.info.id
      const events = collectGoalEvents(assembly, sessionId)

      const condition = '把工作区里的报告写完并落盘'
      await assembly.gate.command({ kind: 'goal.set', sessionId, condition })

      await runOnePromptApproved(assembly, sessionId, 'hi')

      // 事件序列 = 一次裁决恰好一个事件（src/im/goal/types.ts 的不变量）。
      // mock 剧本：judge 第一次 not_met（驱动一次续跑）、第二次 met（收尾）。
      expect(events.map((e) => e.status)).toEqual(['set', 'round', 'met'])
      const round = events[1]
      expect(round?.status === 'round' ? round.round : null).toBe(1)
      expect(round?.status === 'round' ? round.maxRounds : null).toBe(DEFAULT_GOAL_MAX_ROUNDS)
      expect(round?.status === 'round' ? round.verdict.verdict : null).toBe('not_met')
      expect(events[2]).toEqual({ status: 'met', roundsUsed: 2 })

      // 续跑回合真的在 canonical 里（模型下一轮看得见——§6.26 模型视野判据），
      // 且 id 前缀是 goal-（下游据此区分真实用户输入与 harness 生成的续跑）。
      const turns = handle.runtime.conversationMemory.turns()
      const reminder = turns.find((t) => t.id.startsWith('goal-'))
      expect(reminder).toBeDefined()
      expect(reminder?.role).toBe('user')
      const content = typeof reminder?.content === 'string' ? reminder.content : ''
      expect(content).toContain('#GOAL_CONTINUATION')
      // D23：条件每轮逐字重述——原始用户回合所在的块会被压缩逐出，条件靠提醒活着。
      expect(content).toContain(`#OBJECTIVE ${condition}`)
      expect(content).toContain('#ROUND 1/24')
      expect(content).toContain('#VERDICT not_met')
      // judge 的理由逐字进提醒（fail-open 的诚实性要求同样适用于面向模型的文本）。
      expect(content).toContain('#JUDGE_REASON 只看到 hello.txt 一处产出')
      expect(content.trimEnd().endsWith('#END_GOAL')).toBe(true)

      // 落盘：persistTurn 走的是 loop 入口同一条写路径（恢复后提醒仍在）。
      await vi.waitFor(() => {
        const disk = readFileSync(join(tmpRoot, 'sessions-core', sessionId, 'conversation.jsonl'), 'utf8')
          .split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; content: string })
        const persisted = disk.find((r) => r.id.startsWith('goal-'))
        expect(persisted).toBeDefined()
        expect(persisted?.content).toContain('#GOAL_CONTINUATION')
      }, { timeout: 5000 })

      // met 之后 goal 自动关闭（会话回到普通模式，跨越驱动压缩随之恢复）。
      const got = await assembly.gate.command({ kind: 'goal.get', sessionId })
      expect(got).toBeUndefined()
    } finally {
      await assembly.shutdown()
    }
  })

  it('goal 未激活：零事件、零续跑回合（beforeComplete 第一行弃权）', { timeout: 30_000 }, async () => {
    const ws = join(tmpRoot, 'ws-idle')
    mkdirSync(ws, { recursive: true })
    const assembly = await makeMockAssembly('idle')
    try {
      const handle = await assembly.handlers.session.create({ workDir: ws })
      const events = collectGoalEvents(assembly, handle.info.id)

      await runOnePromptApproved(assembly, handle.info.id, 'hi')

      expect(events).toEqual([])
      expect(handle.runtime.conversationMemory.turns().some((t) => t.id.startsWith('goal-'))).toBe(false)
      expect(await assembly.gate.command({ kind: 'goal.get', sessionId: handle.info.id })).toBeUndefined()
    } finally {
      await assembly.shutdown()
    }
  })

  it('goal.set/clear/get 经 gate 路由：maxRounds 缺省由宿主补、clear 幂等、未打开会话干净报错', async () => {
    const ws = join(tmpRoot, 'ws-routing')
    mkdirSync(ws, { recursive: true })
    const assembly = await makeMockAssembly('routing')
    try {
      const handle = await assembly.handlers.session.create({ workDir: ws })
      const sessionId = handle.info.id
      const events = collectGoalEvents(assembly, sessionId)

      // 显式 maxRounds 原样透传（宿主不改写语义）。
      await assembly.gate.command({ kind: 'goal.set', sessionId, condition: '显式上限', maxRounds: 5 })
      expect(await assembly.gate.command({ kind: 'goal.get', sessionId })).toEqual({
        condition: '显式上限', maxRounds: 5, roundsUsed: 0,
      } satisfies GoalState)

      // 缺省 maxRounds → 宿主用 goal/types.ts 的 DEFAULT_GOAL_MAX_ROUNDS。
      // 重设即重置：roundsUsed 归零、lastVerdict 丢弃。
      await assembly.gate.command({ kind: 'goal.set', sessionId, condition: '缺省上限' })
      expect(await assembly.gate.command({ kind: 'goal.get', sessionId })).toEqual({
        condition: '缺省上限', maxRounds: DEFAULT_GOAL_MAX_ROUNDS, roundsUsed: 0,
      } satisfies GoalState)

      await assembly.gate.command({ kind: 'goal.clear', sessionId })
      expect(await assembly.gate.command({ kind: 'goal.get', sessionId })).toBeUndefined()
      // 幂等：本来就没有 goal 也回 cleared（用户按下"关闭"就该拿到确认）。
      await assembly.gate.command({ kind: 'goal.clear', sessionId })

      expect(events.map((e) => e.status)).toEqual(['set', 'set', 'cleared', 'cleared'])

      await expect(
        assembly.gate.command({ kind: 'goal.set', sessionId: 'no-such-session', condition: 'x' }),
      ).rejects.toThrow(/is not open/)
    } finally {
      await assembly.shutdown()
    }
  })
})

// ---------------------------------------------------------------------------
// B 段：本地 http "服务商" —— G1 落盘 + D7 互斥 + D19 出站转写
// ---------------------------------------------------------------------------

type CapturedBody = { messages: Array<{ role: string; content?: unknown }> }

let captured: CapturedBody[] = []
let judgeCalls = 0
let server: Server
let port = 0

/** judge 前两次 not_met（第二次触发 G1）、第三次 met 收尾。 */
const sse = (text: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }], usage: null })}\n\n`
  // prompt_tokens 是 G1 水位触发的喂值（hooks.ts 用 ctx.lastRequestTokens）。
  + `data: ${JSON.stringify({
    choices: [{ delta: {} }],
    usage: { prompt_tokens: 5000, completion_tokens: 5, total_tokens: 5005 },
  })}\n\n`
  + 'data: [DONE]\n\n'

const systemText = (body: CapturedBody): string => {
  const first = body.messages[0]
  return first?.role === 'system' && typeof first.content === 'string' ? first.content : ''
}

const roles = (body: CapturedBody): string[] => body.messages.map((m) => m.role)

const hasAdjacentUser = (body: CapturedBody): boolean => {
  const r = roles(body)
  return r.some((role, i) => i > 0 && role === 'user' && r[i - 1] === 'user')
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw) as CapturedBody
      captured.push(body)
      const isJudge = systemText(body).includes('Judge Agent')
      // v0.41 后续补丁 (a)：floor=10K 要求块 ≥10K 才触发 watermark。
      // 工作代理回复用 12K CJK 填充（1字=1tok）确保块超过 floor。
      let text = isJudge ? '' : '分析结果'.repeat(3000) // ~12K tok
      if (isJudge) {
        judgeCalls += 1
        text = JSON.stringify(judgeCalls < 3
          ? { verdict: 'not_met', reason: `第 ${judgeCalls} 轮：证据仍不足。` }
          : { verdict: 'met', reason: '证据齐了。' })
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse(text))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const writeProviders = (strictAlternation: boolean | undefined): string => {
  const home = mkdtempSync(join(tmpRoot, 'home-sa-'))
  const capabilities: Record<string, unknown> = { maxInputTokens: 1_000_000, maxOutputTokens: 384_000 }
  if (strictAlternation !== undefined) capabilities['strictAlternation'] = strictAlternation
  writeFileSync(join(home, 'providers.json'), JSON.stringify({
    active: 'test',
    providers: {
      test: { url: `http://127.0.0.1:${port}/chat`, apiKey: 'test-key', model: 'test-model', capabilities },
    },
  }))
  return home
}

/**
 * 跑一条带 goal 的 prompt，让 G1 在第二次裁决时合并掉首个已关闭块。
 *
 * 阈值 m1MinTokens=1 是为了让 G1 的水位触发线确定性命中（尺寸线默认 80K，
 * e2e 里堆不出那么多料）。同一个阈值也会让 loop 每轮的 tick 跨越 M0→M1——
 * 那正是 D7 互斥要拦的，所以这里同时是互斥的验收现场。
 */
const runGoalRound = async (name: string, strictAlternation: boolean | undefined): Promise<{
  events: GoalEvent[]
  workingBodies: CapturedBody[]
  judgeBodies: CapturedBody[]
}> => {
  captured = []
  judgeCalls = 0
  const home = writeProviders(strictAlternation)
  const ws = join(tmpRoot, `ws-${name}`)
  mkdirSync(ws, { recursive: true })
  const assembly = await createHostAssembly({
    dataDir: join(tmpRoot, `sessions-${name}`),
    providerLookup: { homeDir: home, env: {} },
    promptLayerUserPath: join(home, 'no-such-PROMPT.md'),
    memoryConfig: { m1MinTokens: 1, m2MinTokens: 500_000, m3MinTokens: 900_000 },
  })
  try {
    const handle = await assembly.handlers.session.create({ workDir: ws })
    const sessionId = handle.info.id
    const events = collectGoalEvents(assembly, sessionId)
    await assembly.gate.command({ kind: 'goal.set', sessionId, condition: '把全部材料分析完' })

    const result = await assembly.handlers.runPrompt(sessionId, 'hi')
    expect(result.reason).toBe('completed')

    // 按系统提示词锚点分流（不能按"#STAMP 出现在正文里"筛——静态系统提示词
    // 本身就讲解了信封标记格式，会误命中合并前的请求）。
    const isJudge = (b: CapturedBody): boolean => systemText(b).includes('Judge Agent')
    return {
      events,
      workingBodies: captured.filter((b) => !isJudge(b)),
      judgeBodies: captured.filter(isJudge),
    }
  } finally {
    await assembly.shutdown()
  }
}

describe('goal compression + strict alternation through the production assembly (local provider)', () => {
  it('resolveLLMPlan 读 capabilities.strictAlternation（缺省 false）', () => {
    expect(resolveLLMPlan({ lookup: { homeDir: writeProviders(true), env: {} } }).strictAlternation).toBe(true)
    expect(resolveLLMPlan({ lookup: { homeDir: writeProviders(false), env: {} } }).strictAlternation).toBe(false)
    expect(resolveLLMPlan({ lookup: { homeDir: writeProviders(undefined), env: {} } }).strictAlternation).toBe(false)
  })

  it('strictAlternation=true：G1 落盘 + D7 互斥 + 工作代理与 judge 出站都合并相邻 user', { timeout: 60_000 }, async () => {
    const { events, workingBodies, judgeBodies } = await runGoalRound('sa-on', true)

    // 接线证据 1：G1 真的落盘了。hooks.ts 的 resolveDriveCoordinator 若是持值
    // 版本就会静默拿到 noop coordinator（assembly 在 createSession 之后才覆盖
    // runtime.driveCoordinator），这个事件永远不会出现。
    // met 之后还有一个 goal_block_merged：收尾分支同样跑梯度（2026-09-17 用户
    // 拍板），顺序固定为"裁决 → 补压"（judge 必须先看证据原文，原则 2）。
    expect(events.map((e) => e.status)).toEqual(
      ['set', 'round', 'round', 'goal_block_merged', 'met', 'goal_block_merged'],
    )
    const merged = events.find((e) => e.status === 'goal_block_merged')
    expect(merged?.status === 'goal_block_merged' ? merged.trigger : null).toBe('watermark')
    expect(merged?.status === 'goal_block_merged' ? merged.stamp.startsWith('S-') : null).toBe(true)

    // 接线证据 2（D7 互斥）：m1MinTokens=1 让每轮 tick 都跨越 M0→M1，但 goal
    // 激活期间块压缩派发被 goalModeActive 关掉——压缩智能体一次都没被调用。
    expect(captured.some((b) => systemText(b).includes('Compressor Agent'))).toBe(false)
    expect(events.some((e) => e.status === 'envelopes_distilled')).toBe(false)

    // 三次裁决 = 三个工作代理轮次（W1 首轮 / W2 提醒后 / W3 G1 合并后）。
    expect(workingBodies).toHaveLength(3)
    expect(judgeBodies).toHaveLength(3)

    // 接线证据 3（D19）：W3 的 canonical = [信封(user), 提醒(user), assistant, 提醒2(user)]
    // ——信封紧邻提醒是 goal 模式的固有形状（G1 合并的块右边界正是提醒回合）。
    // 出站前被合并，且**合并不是丢弃**：两段内容都还在。
    const w3 = workingBodies[2]!
    expect(hasAdjacentUser(w3)).toBe(false)
    const w3User = w3.messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n')
    expect(w3User).toContain('#STAMP S-')
    expect(w3User).toContain('#END_BLOCK')
    expect(w3User).toContain('#GOAL_CONTINUATION')
    // 对照：合并前的 W2 本就没有相邻 user（信封还没产生）。
    expect(hasAdjacentUser(workingBodies[1]!)).toBe(false)

    // judge 把全量 canonical 逐字铺进请求，尾部还跟着 createSystemAgent 硬编码的
    // 空 userTemplate——所以**每个** judge 请求都有一对相邻 user。不转写的话严格
    // provider 会在裁决调用上 400 → judge_failed → fail-open 空转。
    for (const body of judgeBodies) {
      expect(hasAdjacentUser(body)).toBe(false)
    }
  })

  it('strictAlternation 缺省：同一条链路出站保留相邻 user（开关是形状差异的唯一原因）', { timeout: 60_000 }, async () => {
    const { events, workingBodies, judgeBodies } = await runGoalRound('sa-off', undefined)

    // 压缩与裁决链路完全一致（对照组只差一个开关）。
    expect(events.map((e) => e.status)).toEqual(
      ['set', 'round', 'round', 'goal_block_merged', 'met', 'goal_block_merged'],
    )
    expect(workingBodies).toHaveLength(3)
    expect(hasAdjacentUser(workingBodies[2]!)).toBe(true)
    // judge 侧同样保留（尾部的空 userTemplate 紧邻裁决请求）。
    expect(judgeBodies).toHaveLength(3)
    for (const body of judgeBodies) {
      expect(hasAdjacentUser(body)).toBe(true)
    }
  })
})
