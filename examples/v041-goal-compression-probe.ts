// v0.41 goal 压缩梯度探针（G1/G2）—— 落盘核对，不发真网络。
//
// 三档各验一件事：
//   A1 · G1 触发 B（watermark）：m1MinTokens 压到 1，块再小也跨越水位 → 合并。
//        顺带把"块比信封小 → 上下文净膨胀"的形态打出来（低压缩率 warn 的由来）。
//   A2 · G1 触发 A（size）+ 逐字不截断：水位抬到 500K（够不着），工作回复 90K
//        token 把块推过 80K 门控；然后核对落盘的 conclusion 与出站回复**逐字相等**
//        —— AGENTS.md「不准截断信息」铁律在生产路径上的正面证明。
//   B  · G2 信封折叠血缘：4 个相邻信封 ≥40K → findDistillRun 识别区间 → 真
//        distiller（假 LLM 回合法 11 字段 JSON）→ appendBlock 把 _sourceStamps
//        （戳 + covers + 代际）写进 curatedMemory.jsonl → 折叠后信封的 #LINEAGE
//        逐戳交代内容与代际（§6.26 可发现性判据：信息变形后模型必须能发现并按原戳召回）。
//
// 为什么 G1 走生产装配、G2 走模块级：G1 的两条触发线都能经 memoryConfig（--m1）
// 与回复体量在装配层驱动；G2 的门控是绝对常量（DEFAULT_GOAL_DISTILL_MIN_TOKENS
// 40K / MIN_BLOCKS 4），装配层不给旋钮，而信封只有百余 token —— 要凑够 4×40K
// 得先跑几十轮真压缩。所以 B 用真实模块函数 + 合成信封驱动（mergeGoalBlock /
// buildCompressionEnvelope / findDistillRun / createDistiller / appendBlock 都是
// 生产同一批函数，不是替身）；G2 经 coordinator 的完整折叠路径由
// tests/im/edge-goal-distill.test.ts 钉住。
//
// 为什么不用 mock：mock 的 judge 剧本是"第一次 not_met、之后恒 met"，只有一次
// 续跑；而 G1/G2 只在续跑分支执行（goal/hooks.ts 的 met/impossible 直接返回），
// 且块要由**下一轮**的提醒回合关闭才成为可压块 —— 一次续跑永远凑不出已关闭块。
//
// 用法：
//   npx tsx examples/v041-goal-compression-probe.ts [--m1 <token 阈值>]
//   （--m1 只作用于 A1，缺省 1）

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHostAssembly } from '../src/host/assembly.js'
import type { HostAssembly } from '../src/host/assembly.js'
import { ConversationMemory } from '../src/im/conversation-memory.js'
import type { ConversationTurn } from '../src/im/conversation-memory.js'
import {
  DEFAULT_GOAL_BLOCK_MIN_TOKENS,
  DEFAULT_GOAL_DISTILL_MIN_BLOCKS,
  DEFAULT_GOAL_DISTILL_MIN_TOKENS,
} from '../src/im/goal/types.js'
import type { GoalEvent } from '../src/im/goal/index.js'
import { createDistiller, findDistillRun } from '../src/im/goal/distill.js'
import type { GoalJudgeStreamChat } from '../src/im/goal/judge.js'
import { Mailbox } from '../src/im/mailbox/index.js'
import { createStateLine } from '../src/im/state-line/index.js'
import type { CuratedMemory, StampLineageEntry } from '../src/im/state-line/types.js'
import { buildCompressionEnvelope, envelopeGeneration, parseEnvelopeCovers } from '../src/im/system-agents/drive-coordinator.js'
import { ToolRegistry } from '../src/shell/registry.js'
import type { ChatMessage, StreamChunk } from '../src/protocol/types.js'

const log = (...args: unknown[]): void => console.log('[v041-probe]', ...args)

const M1 = (() => {
  const i = process.argv.indexOf('--m1')
  if (i === -1) return 1
  const n = Number(process.argv[i + 1])
  if (!Number.isFinite(n) || n < 1) throw new Error('--m1 需要一个正数（token 阈值）')
  return n
})()

const tmpRoot = mkdtempSync(join(tmpdir(), 'v041-probe-'))
const CONDITION = '把三份报告都写完'

// ---------------------------------------------------------------------------
// 本地探针服务商：judge 前两次 not_met（驱动两次续跑）、第三次 met；工作代理回
// workingReply（A2 把它换成 90K token 的 CJK 洪泛以推过 size 门控）。
// ---------------------------------------------------------------------------

let workingReply = 'ok'
let judgeCalls = 0
let server: Server
let port = 0

const sse = (text: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }], usage: null })}\n\n`
  + 'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5000,"completion_tokens":20,"total_tokens":5020}}\n\n'
  + 'data: [DONE]\n\n'

const systemText = (body: Record<string, unknown>): string => {
  const messages = (body['messages'] as ChatMessage[] | undefined) ?? []
  const sys = messages.find((m) => m.role === 'system')
  return typeof sys?.content === 'string' ? sys.content : ''
}

const startServer = async (): Promise<void> => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (systemText(body).includes('Judge Agent')) {
        judgeCalls += 1
        const verdict = judgeCalls <= 2
          ? { verdict: 'not_met', reason: '只看到部分报告，其余在历史里没有产出证据。' }
          : { verdict: 'met', reason: '目标要求的产出都有工具结果佐证。' }
        res.end(sse(JSON.stringify(verdict)))
        return
      }
      res.end(sse(workingReply))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
}

// ---------------------------------------------------------------------------
// 落盘读取
// ---------------------------------------------------------------------------

const readJsonl = (path: string): Array<Record<string, unknown>> =>
  existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : []

/** 递归找一个文件名（会话数据在 <dataDir>/<sessionId>/state/ 下，层级由宿主决定）。 */
const findFile = (root: string, name: string): string | undefined => {
  for (const entry of readdirSync(root)) {
    const p = join(root, entry)
    if (statSync(p).isDirectory()) {
      const hit = findFile(p, name)
      if (hit !== undefined) return hit
    } else if (entry === name) {
      return p
    }
  }
  return undefined
}

const writeProvider = (name: string): string => {
  const home = join(tmpRoot, `home-${name}`)
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'providers.json'), JSON.stringify({
    active: 'probe',
    providers: {
      probe: { url: `http://127.0.0.1:${port}/chat`, apiKey: 'probe-key', model: 'probe-model' },
    },
  }))
  return home
}

/** 跑一个完整 goal 流程（两次续跑 + 收尾），回事件序列与会话数据目录。 */
const runCycle = async (name: string, m1MinTokens: number): Promise<{
  events: GoalEvent[]
  dataDir: string
}> => {
  judgeCalls = 0
  const dataDir = join(tmpRoot, `data-${name}`)
  const home = writeProvider(name)
  const assembly: HostAssembly = await createHostAssembly({
    dataDir,
    memoryConfig: { m1MinTokens, m2MinTokens: 5_000_000, m3MinTokens: 9_000_000 },
    providerLookup: { homeDir: home, env: {} },
    settingsHomeDir: home,
    promptLayerUserPath: join(home, 'no-such-PROMPT.md'),
    logToStderr: false,
  })
  try {
    const workDir = join(tmpRoot, `ws-${name}`)
    mkdirSync(workDir, { recursive: true })
    const handle = await assembly.handlers.session.create({ workDir })
    const sessionId = handle.info.id
    assembly.handlers.setFullPermission(sessionId, true)

    const events: GoalEvent[] = []
    assembly.gate.on('goal.changed', (sig) => {
      if (sig.kind === 'goal.changed' && sig.sessionId === sessionId) events.push(sig.event)
    })

    await assembly.handlers.goal!.set(sessionId, CONDITION, 6)
    await assembly.handlers.runPrompt(sessionId, 'hi')
    return { events, dataDir }
  } finally {
    await assembly.shutdown()
  }
}

const mergedOf = (events: readonly GoalEvent[]): Extract<GoalEvent, { status: 'goal_block_merged' }> | undefined =>
  events.find((e): e is Extract<GoalEvent, { status: 'goal_block_merged' }> => e.status === 'goal_block_merged')

const PHRASE = '洪泛填充内容'
/** 目标 token 数的 CJK 填充：estimateTokens 对 CJK 计 1 字 = 1 token，字符数即 token 数。 */
const cjkFiller = (tokens: number): string =>
  PHRASE.repeat(Math.ceil(tokens / PHRASE.length)).slice(0, tokens)

// ===========================================================================
// A1 — G1 触发 B（watermark）
// ===========================================================================

async function phaseA1(): Promise<boolean> {
  log('\n=== A1 · G1 watermark 触发（生产装配）===')
  log(`m1MinTokens = ${M1}（m2/m3 抬到 5M/9M，避免无关档位干扰）`)
  workingReply = 'ok'

  const { events, dataDir } = await runCycle('a1', M1)
  log(`事件序列: ${events.map((e) => e.status).join(' → ')}`)

  const merged = mergedOf(events)
  if (merged === undefined) {
    log('未观察到 goal_block_merged —— G1 没触发 · FAIL')
    return false
  }
  log(`G1: ${merged.stamp} · ${merged.blockTokens}→${merged.envelopeTokens} tok · 触发 ${merged.trigger}`)
  const triggerOk = merged.trigger === 'watermark'
  log(`触发线 = watermark: ${triggerOk ? 'PASS' : 'FAIL'}`)
  // 块比信封小时合并会**净膨胀**上下文（11 字段信封的固定开销 > 小块本体）。
  // D12 拍板是"只加可观测、不加 cap 不拒绝不重试"，这里把形态如实打出来。
  if (merged.envelopeTokens > merged.blockTokens) {
    log(`⚠ 净膨胀：信封比块大 ${merged.envelopeTokens - merged.blockTokens} tok`
      + `（比例 ${(merged.blockTokens / merged.envelopeTokens).toFixed(2)}）—— drive-coordinator 会 log.warn('low compression ratio')`)
  }

  // ---- 模型可见面（§6.26：信息变形后模型在原位置看到什么）----
  const conv = readJsonl(findFile(dataDir, 'conversation.jsonl') ?? '')
  const envelopeIdx = conv.findIndex((t) => t['role'] === 'user' && String(t['id'] ?? '').startsWith('mem-'))
  const reminderIdx = conv.findIndex((t) => t['role'] === 'user' && String(t['id'] ?? '').startsWith('goal-'))
  log(`\ncanonical 共 ${conv.length} 回合 · 信封 @${envelopeIdx}（原位替代，不是留洞）· 提醒 @${reminderIdx}`)
  const envelope = envelopeIdx >= 0 ? conv[envelopeIdx]! : undefined
  const envelopeOk = envelope !== undefined && String(envelope['content'] ?? '').includes(merged.stamp)
  log(`信封在原位且带本次戳: ${envelopeOk ? 'PASS' : 'FAIL'}`)
  log('\n--- 信封全文（模型逐字看到的东西）---')
  log(String(envelope?.['content'] ?? '(缺失)'))

  // ---- D7 互斥：这一块出自 G1 的本地合并，不是 LLM 压缩器 ----
  // 判据是**产物指纹**而不是"没发请求"：mergeGoalBlock 把 goal 条件逐字写进
  // task_goal、status_hint 恒为 PENDING、causal_steps 由工具链派生；LLM 压缩器
  // 的产物是它自己写的句子、status_hint 由它判断。
  const block = readJsonl(findFile(dataDir, 'curatedMemory.jsonl') ?? '')
    .find((b) => b['_stamp'] === merged.stamp)
  const fromG1 = block !== undefined && block['task_goal'] === CONDITION && block['status_hint'] === 'PENDING'
  log(`\ncuratedMemory.jsonl 命中该戳: ${block !== undefined ? 'PASS' : 'FAIL'}`)
  log(`产物指纹 = G1 本地合并（task_goal 逐字等于 goal 条件 + status_hint PENDING）: ${fromG1 ? 'PASS' : 'FAIL'}`)
  log('  → D7 互斥成立：goal 激活时常规 LLM 压缩派发未参与')

  // ---- raw-archive：被逐出的原始消息完整可溯 ----
  const rec = readJsonl(findFile(dataDir, 'raw-archive.jsonl') ?? '')
    .find((r) => r['summaryStamp'] === merged.stamp)
  const msgs = (rec?.['messages'] as ChatMessage[] | undefined) ?? []
  log(`\nraw-archive.jsonl 同戳记录: ${rec !== undefined ? 'PASS' : 'FAIL'}`)
  log(`  归档消息 ${msgs.length} 条 · 角色序列 ${msgs.map((m) => m.role).join(',')} · sourceTurnIds ${(rec?.['sourceTurnIds'] as string[] | undefined)?.length ?? 0}`)
  const archiveOk = rec !== undefined && msgs.length > 0

  const ok = triggerOk && envelopeOk && fromG1 && archiveOk
  log(`\nA1: ${ok ? 'PASS' : 'FAIL'}`)
  return ok
}

// ===========================================================================
// A2 — G1 触发 A（size）+ 逐字不截断
// ===========================================================================

async function phaseA2(): Promise<boolean> {
  log('\n=== A2 · G1 size 触发 + 结论逐字不截断（生产装配）===')
  const REPLY_TOKENS = DEFAULT_GOAL_BLOCK_MIN_TOKENS + 10_000
  workingReply = cjkFiller(REPLY_TOKENS)
  log(`工作回复 ${workingReply.length} 字符（CJK 计 1 字 = 1 token）· 块门控 ${DEFAULT_GOAL_BLOCK_MIN_TOKENS}`)
  // 水位抬到 5M：contextTokens（探针 usage 恒 5000）永远够不着，于是触发只可能来自 size 线。
  const { events, dataDir } = await runCycle('a2', 5_000_000)
  log(`事件序列: ${events.map((e) => e.status).join(' → ')}`)

  const merged = mergedOf(events)
  if (merged === undefined) {
    log('未观察到 goal_block_merged —— FAIL')
    return false
  }
  log(`G1: ${merged.stamp} · ${merged.blockTokens}→${merged.envelopeTokens} tok · 触发 ${merged.trigger}`)
  const triggerOk = merged.trigger === 'size'
  log(`触发线 = size（水位够不着，两线独立）: ${triggerOk ? 'PASS' : 'FAIL'}`)
  const ratio = merged.blockTokens / Math.max(1, merged.envelopeTokens)
  log(`压缩率 ${ratio.toFixed(1)}x（${merged.blockTokens} → ${merged.envelopeTokens} tok）`)

  // 「不准截断信息」的正面证明：落盘 conclusion 与模型出站回复逐字相等。
  const block = readJsonl(findFile(dataDir, 'curatedMemory.jsonl') ?? '')
    .find((b) => b['_stamp'] === merged.stamp)
  const conclusion = String(block?.['conclusion'] ?? '')
  const verbatim = conclusion === workingReply
  log(`\n落盘 conclusion ${conclusion.length} 字符 / 出站回复 ${workingReply.length} 字符`)
  log(`逐字全量保留（无截断、无摘要、无上限）: ${verbatim ? 'PASS' : 'FAIL'}`)
  log(`  → G1 的比例只来自丢掉**输入材料**，最终结论一个字符不少`)

  // 信封里也是全文（模型可见面同样不截断）。
  const conv = readJsonl(findFile(dataDir, 'conversation.jsonl') ?? '')
  const envelope = conv.find((t) => t['role'] === 'user' && String(t['id'] ?? '').startsWith('mem-'))
  const envelopeFull = String(envelope?.['content'] ?? '').includes(workingReply)
  log(`信封正文含全文: ${envelopeFull ? 'PASS' : 'FAIL'}`)

  const ok = triggerOk && verbatim && envelopeFull
  log(`\nA2: ${ok ? 'PASS' : 'FAIL'}`)
  return ok
}

// ===========================================================================
// B — G2 信封折叠血缘
// ===========================================================================

const curated = (conclusion: string): CuratedMemory => ({
  task_goal: CONDITION,
  causal_steps: [],
  evidence_fragments: [],
  conclusion,
  next_action: '继续写剩下的两份',
  working_state: {
    current_goal: CONDITION,
    effective_decisions: [],
    rejected_decisions: [],
    architecture_boundaries: [],
    remaining_work: ['b.txt', 'c.txt'],
  },
  status_hint: 'PENDING',
})

async function phaseB(): Promise<boolean> {
  log(`\n=== B · G2 信封折叠血缘（门控 ${DEFAULT_GOAL_DISTILL_MIN_TOKENS} tok / ${DEFAULT_GOAL_DISTILL_MIN_BLOCKS} 块）===`)

  const basePath = join(tmpRoot, 'state-b')
  mkdirSync(basePath, { recursive: true })
  const stateLine = createStateLine({ databusPath: basePath })

  // 4 个相邻信封，每个 15K token → 合计 60K，越过 40K 门控。真实场景里它们来自
  // 4 次 G1；这里用生产同一个 buildCompressionEnvelope 渲染，格式不另写一份。
  const envMem = new ConversationMemory()
  const stamps: string[] = []
  for (let i = 0; i < DEFAULT_GOAL_DISTILL_MIN_BLOCKS; i += 1) {
    const stamp = `S-170000000${i}-probe${i}`
    stamps.push(stamp)
    const turn: ConversationTurn = {
      id: `mem-${i}`,
      role: 'user',
      content: buildCompressionEnvelope(stamp, 'M1', curated(cjkFiller(15_000))),
      at: 10 + i,
    }
    envMem.append(turn)
  }

  const run = findDistillRun(envMem.turns(), { minBlocks: DEFAULT_GOAL_DISTILL_MIN_BLOCKS, minTokens: DEFAULT_GOAL_DISTILL_MIN_TOKENS })
  if (run === undefined) {
    log('findDistillRun 未识别出折叠区间 —— FAIL')
    return false
  }
  log(`区间 [${run.startIndex},${run.endIndexExclusive}) · ${run.tokens} tok · 原戳 [${run.stamps.join(', ')}]`)
  const runOk = run.stamps.join(',') === stamps.join(',')
  log(`原戳按区间顺序完整回收（血缘不丢不乱）: ${runOk ? 'PASS' : 'FAIL'}`)

  // 假 distiller LLM：回合法 11 字段 JSON（G2 与 compressor 同一契约）。
  const fakeStreamChat: GoalJudgeStreamChat = () => {
    const payload = JSON.stringify(curated('四份信封合并后的结论：三份报告已全部写完。'))
    return (async function* () {
      yield { type: 'content_delta', text: payload } as StreamChunk
      yield { type: 'finish', reason: 'stop' } as StreamChunk
      yield { type: 'done' } as StreamChunk
    })()
  }
  const distiller = createDistiller({
    resolveLlm: () => ({ url: `http://127.0.0.1:${port}/chat`, model: 'probe-model', streamChat: fakeStreamChat }),
    mailbox: new Mailbox(),
    registry: new ToolRegistry(),
    stateLine,
  })
  const distilled = await distiller.distill({ run, condition: CONDITION, signal: undefined })

  const newStamp = 'S-1700000099-probe'
  // 与 coordinator 的 distillEnvelopes 同一步：血缘由 Node 侧从实际信封文本构建
  // （戳 + covers 一行式 + 代际），LLM 永不产出（distill-agent.md 硬规则明写
  // "不要把戳抄进任何字段"）。
  const lineage: StampLineageEntry[] = run.stamps.map((s, i) => {
    const text = String(envMem.turns()[run.startIndex + i]!.content)
    return { stamp: s, generation: envelopeGeneration(text), covers: parseEnvelopeCovers(text) }
  })
  await stateLine.compressor.appendBlock({ ...distilled, _sourceStamps: lineage }, 'M1', newStamp)

  const onDisk = readJsonl(join(basePath, 'state', 'curatedMemory.jsonl')).find((r) => r['_stamp'] === newStamp)
  const onDiskLineage = onDisk?.['_sourceStamps'] as StampLineageEntry[] | undefined
  log(`\ncuratedMemory.jsonl 落盘血缘 _sourceStamps: ${JSON.stringify(onDiskLineage)}`)
  const lineageOk = onDiskLineage !== undefined
    && onDiskLineage.map((e) => e.stamp).join(',') === stamps.join(',')
    && onDiskLineage.every((e) => e.generation === 1 && e.covers.includes('结论='))
  log(`血缘与原戳一致（含 covers 与代际）: ${lineageOk ? 'PASS' : 'FAIL'}`)

  const folded = buildCompressionEnvelope(newStamp, 'M1', distilled, lineage)
  log('\n--- 折叠后信封的 #LINEAGE（模型据此知道每个原戳讲什么、第几代、可按戳召回）---')
  log(folded.split('\n').filter((l) => l.startsWith('#LINEAGE') || l.startsWith('  - ')).join('\n'))
  const noteOk = folded.includes('#LINEAGE') && stamps.every((s) => folded.includes(s))
  log(`#LINEAGE 逐戳交代内容与代际（§6.26 可发现性）: ${noteOk ? 'PASS' : 'FAIL'}`)

  // 折叠**不写** raw-archive：被折叠那几块的原文在各自 G1 时已归档，召回链靠
  // 血缘 + 原块既有记录（drive-coordinator.ts distillEnvelopes 注释 2）。
  const archiveCount = readJsonl(join(basePath, 'state', 'raw-archive.jsonl')).length
  log(`\nG2 未新增 raw-archive 记录（原文在各自 G1 时已归档）: ${archiveCount === 0 ? `PASS（${archiveCount} 条）` : `FAIL（${archiveCount} 条）`}`)

  const ok = runOk && lineageOk && noteOk && archiveCount === 0
  log(`\nB: ${ok ? 'PASS' : 'FAIL'}`)
  return ok
}

async function main(): Promise<void> {
  log('=== v0.41 goal 压缩梯度探针 ===')
  await startServer()
  log(`本地探针服务商 127.0.0.1:${port}`)

  const a1 = await phaseA1()
  const a2 = await phaseA2()
  const b = await phaseB()

  log(`\nOverall: ${a1 && a2 && b ? 'PASS' : 'FAIL —— 见上面逐条判据'}`)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(tmpRoot, { recursive: true, force: true })
  log(`已清理临时目录 ${tmpRoot}`)
  process.exit(a1 && a2 && b ? 0 : 1)
}

main().catch((err) => {
  console.error('[v041-probe] FATAL:', err)
  process.exit(1)
})
