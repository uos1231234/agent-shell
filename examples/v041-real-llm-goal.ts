// v0.41 goal 模式 —— 真实 LLM 端到端验收。
//
// 走**生产装配**（createHostAssembly）而不是手搭系统智能体：goal 的价值全在接线
// （beforeComplete hook 挂在 runPromptOnce 合并链末端、goal.set 经 gate 路由到
// per-session GoalSessionState、judge 每轮热解析当前 provider），手搭一份就验不到
// 这些。接线点见 docs/v0.41-验收报告.md。
//
// 设计要点：**不指望真模型"失败"**。第一轮 prompt 显式要求"只创建 a.txt 就停下"，
// 而目标要求 a/b/c 三个文件都存在——judge 看到的历史里确实只有 a.txt，因此
// not_met 是被目标与首轮指令的**落差**逼出来的确定结果，不是靠模型碰巧偷懒。
// 这样验的是 judge 的判别力 + 续跑提醒的承载力，而不是运气。
//
// 用法：
//   ARK_KEY=... npx tsx examples/v041-real-llm-goal.ts
//
// 凭据只从环境读（ARK_KEY 必需；ARK_URL/ARK_MODEL 可选，缺省与 resolveLLMPlan
// 的回落一致）。providers.json / ~/.databus 都指向临时目录——示例不读也不写用户
// 的真实配置。

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHostAssembly } from '../src/host/assembly.js'
import type { HostAssembly } from '../src/host/assembly.js'
import type { GoalEvent } from '../src/im/goal/index.js'

const log = (...args: unknown[]): void => console.log('[v041-goal]', ...args)

const ARK_KEY = process.env['ARK_KEY']
if (ARK_KEY === undefined) {
  throw new Error('ARK_KEY environment variable is required. Set it before running this example.')
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'v041-real-goal-'))
const workDir = join(tmpRoot, 'ws')
const homeDir = join(tmpRoot, 'home')
mkdirSync(workDir, { recursive: true })
mkdirSync(homeDir, { recursive: true })

/** conversation.jsonl 里 role=user 且 id 以 goal- 开头的续跑提醒回合。 */
const readReminderTurns = (sessionId: string): Array<{ id: string; content: string }> => {
  const path = join(tmpRoot, 'data', sessionId, 'conversation.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { id?: string; role?: string; content?: unknown })
    .filter((t) => t.role === 'user' && typeof t.id === 'string' && t.id.startsWith('goal-'))
    .map((t) => ({ id: t.id as string, content: typeof t.content === 'string' ? t.content : JSON.stringify(t.content) }))
}

const describeEvent = (e: GoalEvent): string => {
  switch (e.status) {
    case 'set': return `set · 上限 ${e.maxRounds} 轮 · ${e.condition}`
    case 'round': return `round ${e.round}/${e.maxRounds} · 裁决 ${e.verdict.verdict} · ${e.verdict.reason}`
    case 'goal_block_merged':
      return `G1 块合并 · ${e.stamp} · ${e.blockTokens}→${e.envelopeTokens} tok · 触发 ${e.trigger}`
    case 'envelopes_distilled':
      return `G2 信封折叠 · ${e.stamp} ← [${e.sourceStamps.join(', ')}] · ${e.beforeTokens}→${e.afterTokens} tok`
    case 'distill_failed': return `G2 降级（不折叠，下轮再试）· ${e.err}`
    case 'met': return `met · 用了 ${e.roundsUsed} 轮`
    case 'impossible': return `impossible · ${e.roundsUsed} 轮 · ${e.reason}`
    case 'rounds_exhausted': return `rounds_exhausted · ${e.roundsUsed} 轮`
    case 'cleared': return 'cleared'
  }
}

async function main(): Promise<void> {
  log('=== v0.41 goal 模式 · 真实 LLM 端到端 ===')

  const assembly: HostAssembly = await createHostAssembly({
    dataDir: join(tmpRoot, 'data'),
    // 隔离：不读用户真实 providers.json / ~/.databus（MCP 连接池与 skills 也
    // 因此不装配，示例只验 goal 链路）。ARK_* 从进程 env 回落。
    providerLookup: { homeDir, env: process.env },
    settingsHomeDir: homeDir,
    promptLayerUserPath: join(homeDir, 'no-such-PROMPT.md'),
    logToStderr: false,
  })

  try {
    const handle = await assembly.handlers.session.create({ workDir, title: 'v041 goal probe' })
    const sessionId = handle.info.id
    // 写审批全自动通过：本示例验的是 goal 裁决链，不是审批门（--yolo 同义）。
    assembly.handlers.setFullPermission(sessionId, true)
    log(`会话 ${sessionId} · 工作区 ${workDir}`)

    const events: GoalEvent[] = []
    assembly.gate.on('goal.changed', (sig) => {
      if (sig.kind !== 'goal.changed' || sig.sessionId !== sessionId) return
      events.push(sig.event)
      log(`  ◆ goal.changed → ${describeEvent(sig.event)}`)
    })

    const condition = '工作区里 a.txt、b.txt、c.txt 三个文件都存在，且每个文件内容非空'
    // 上限给 6：够 judge 走完 not_met→续跑→met，又不会在真模型跑偏时烧太久。
    await assembly.handlers.goal!.set(sessionId, condition, 6)

    log('\n--- 第 1 轮 prompt（显式只要求部分完成）---')
    // 措辞刻意强硬：not_met 全靠"首轮指令只要 a.txt"与"目标要三个文件"之间的落差，
    // 模型若热心过头一次交付全部，第 1 轮就 met，续跑链路这一趟就验不到。
    const result = await assembly.handlers.runPrompt(
      sessionId,
      '本轮只允许创建 a.txt（内容写一行说明即可）。创建完立刻停止，只回复一句"已创建 a.txt"。'
      + '不得创建 b.txt 或 c.txt，不得提前完成目标——后续轮次我会另行指示。',
    )
    log(`runPrompt 收尾 reason=${result.reason} · turns=${result.turns}`)

    // ---------------------------------------------------------------------
    // 判据（真模型不确定性下仍成立的三条）
    // ---------------------------------------------------------------------
    const files = readdirSync(workDir).sort()
    log(`\n工作区文件: ${files.length === 0 ? '(空)' : files.join(', ')}`)

    const reminders = readReminderTurns(sessionId)
    const rounds = events.filter((e): e is Extract<GoalEvent, { status: 'round' }> => e.status === 'round')
    const terminal = events.find(
      (e) => e.status === 'met' || e.status === 'impossible' || e.status === 'rounds_exhausted',
    )
    const judgeOk = rounds.every((r) => r.verdict.verdict !== 'judge_failed')
    const sawNotMet = rounds.some((r) => r.verdict.verdict === 'not_met')

    log('\n--- 判据 ---')
    // 硬判据三条：judge 真的裁决了（不是 fail-open 空转）、拿到了终止事件、
    // 以及**若发生续跑**则提醒回合落盘且信封完整。
    log(`1. judge 每次都产出可解析裁决（无 judge_failed）: ${judgeOk ? 'PASS' : 'FAIL'}`)
    log(`2. 收到终止事件: ${terminal !== undefined ? `PASS（${terminal.status}）` : 'FAIL'}`)

    // 续跑是否发生是**观察项**而不是判据：模型若违抗"只做一部分"的指令一次交付
    // 全部，第 1 轮就 met，续跑链路这一趟本就走不到 —— 那是模型的功劳，
    // 不是 goal 机制的失败。发生续跑时才逐字核对提醒信封。
    log(`3. 出现 not_met 续跑（观察项）: ${sawNotMet ? `是（${rounds.length} 次裁决）` : `否 —— 首轮即 ${terminal?.status ?? '未终止'}`}`)

    let reminderOk = true
    if (sawNotMet) {
      log(`4. 续跑提醒回合落盘 canonical: ${reminders.length > 0 ? `PASS（${reminders.length} 条）` : 'FAIL'}`)
      const first = reminders[0]
      if (first === undefined) {
        reminderOk = false
      } else {
        log(`\n--- 首条续跑提醒回合（${first.id}）---`)
        log(first.content)
        const envelopeOk =
          first.content.includes('#GOAL_CONTINUATION')
          && first.content.includes('#OBJECTIVE')
          && first.content.includes('#ROUND')
          && first.content.includes('#VERDICT')
          && first.content.includes('#JUDGE_REASON')
          && first.content.includes('#END_GOAL')
        log(`\n信封标记完整: ${envelopeOk ? 'PASS' : 'FAIL'}`)
        reminderOk = reminders.length > 0 && envelopeOk
      }
    }

    // 目标达成时三个文件都该在；真模型若在提醒后仍只补一部分，终止事件会是
    // rounds_exhausted —— 如实报告，不粉饰。
    let diskConsistent = true
    if (terminal?.status === 'met') {
      const allThere = ['a.txt', 'b.txt', 'c.txt'].every((f) => files.includes(f))
      log(`5. met 与磁盘事实一致: ${allThere ? 'PASS' : 'FAIL（judge 判 met 但文件不全）'}`)
      diskConsistent = allThere
    }

    const overall = judgeOk && terminal !== undefined && reminderOk && diskConsistent
    log(`\nOverall: ${overall ? 'PASS' : 'FAIL —— 见上面逐条判据'}`)

    // goal 终止后状态应清空（met/impossible/exhausted 都清），get 回 undefined。
    const after = await assembly.handlers.goal!.get(sessionId)
    log(`终止后 goal.get: ${after === undefined ? 'undefined（PASS）' : JSON.stringify(after)}`)

    process.exitCode = overall ? 0 : 1
  } finally {
    await assembly.shutdown()
    rmSync(tmpRoot, { recursive: true, force: true })
    log(`已清理临时目录 ${tmpRoot}`)
  }
}

main().catch((err) => {
  console.error('[v041-goal] FATAL:', err)
  process.exit(1)
})
