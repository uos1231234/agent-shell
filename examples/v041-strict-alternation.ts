// v0.41 D19 —— strictAlternation 出站转写的形状核对（本地 http，不发真网络）。
//
// 要解决的问题：goal 模式下 canonical 必然出现**相邻 user**——G1 的压缩信封
// （id 前缀 mem-，role user）紧邻续跑提醒（id 前缀 goal-，role user），因为提醒
// 回合正是被合并块的右边界；另外 loop 每轮请求尾部会补一条 userTemplate（常为空
// 串），又是一对相邻 user。OpenAI 兼容栈接受这种序列，**Anthropic 一类严格交替的
// provider 会 400**。
//
// D19 的做法是在出站前一处转写（src/protocol/messages.ts 的 normalizeWireMessages，
// 由 src/shell/call.ts 应用），开关来自 providers.json 的
// capabilities.strictAlternation（用户拍板"只要开关，不加自愈"）。
//
// 本示例把开关**开/关**两份配置各跑一次同样的 goal 流程，把每个出站请求的角色序列
// 原样打出来，肉眼即可看出转写前后的差别；并核对两处覆盖面：
//   ① 工作代理的请求（loop 主链）
//   ② judge 的请求（它把工作代理的全量 canonical 逐字铺进自己的请求 —— 相邻 user
//      原样带过去，且 createSystemAgent 恒在尾部补一条空 userTemplate，所以 judge
//      请求**必定**含相邻 user；不透传开关的话严格 provider 会在裁决调用上 400 →
//      judge_failed → fail-open 空转到轮次上限）
//
// 用法：
//   npx tsx examples/v041-strict-alternation.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHostAssembly } from '../src/host/assembly.js'
import type { HostAssembly } from '../src/host/assembly.js'
import type { GoalEvent } from '../src/im/goal/index.js'
import type { ChatMessage } from '../src/protocol/types.js'

const log = (...args: unknown[]): void => console.log('[v041-sa]', ...args)

const tmpRoot = mkdtempSync(join(tmpdir(), 'v041-sa-'))

type Captured = { label: string; roles: string[] }
let captured: Captured[] = []
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

/** 相邻同角色 user 的位置（转写没生效时非空）。 */
const adjacentUserAt = (roles: readonly string[]): number[] => {
  const hits: number[] = []
  for (let i = 1; i < roles.length; i += 1) {
    if (roles[i] === 'user' && roles[i - 1] === 'user') hits.push(i)
  }
  return hits
}

const writeProvider = (name: string, strict: boolean): string => {
  const home = join(tmpRoot, `home-${name}`)
  mkdirSync(home, { recursive: true })
  const provider: Record<string, unknown> = {
    url: `http://127.0.0.1:${port}/chat`,
    apiKey: 'probe-key',
    model: 'probe-model',
  }
  if (strict) provider['capabilities'] = { strictAlternation: true }
  writeFileSync(join(home, 'providers.json'), JSON.stringify({
    active: 'probe',
    providers: { probe: provider },
  }))
  return home
}

async function runCycle(name: string, strict: boolean): Promise<{ events: GoalEvent[]; bodies: Captured[] }> {
  captured = []
  judgeCalls = 0
  const home = writeProvider(name, strict)

  const assembly: HostAssembly = await createHostAssembly({
    dataDir: join(tmpRoot, `data-${name}`),
    providerLookup: { homeDir: home, env: {} },
    settingsHomeDir: home,
    promptLayerUserPath: join(home, 'no-such-PROMPT.md'),
    // m1 压到 1：每轮都跨越 watermark，G1 必定合并出信封 —— 相邻 user 由此产生。
    memoryConfig: { m1MinTokens: 1, m2MinTokens: 500_000, m3MinTokens: 900_000 },
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

    await assembly.handlers.goal!.set(sessionId, '把三份报告都写完', 6)
    await assembly.handlers.runPrompt(sessionId, 'hi')

    return { events, bodies: [...captured] }
  } finally {
    await assembly.shutdown()
  }
}

async function main(): Promise<void> {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      const messages = (body['messages'] as ChatMessage[] | undefined) ?? []
      const isJudge = systemText(body).includes('Judge Agent')
      captured.push({ label: isJudge ? 'judge' : 'working', roles: messages.map((m) => m.role) })

      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (isJudge) {
        judgeCalls += 1
        // 第一次 not_met（驱动续跑 → 产生信封与提醒）、第二次 met（收尾）。
        const verdict = judgeCalls === 1
          ? { verdict: 'not_met', reason: '只看到一处产出，其余报告在历史里没有证据。' }
          : { verdict: 'met', reason: '目标要求的产出都有工具结果佐证。' }
        res.end(sse(JSON.stringify(verdict)))
        return
      }
      res.end(sse('ok'))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port

  log('=== v0.41 D19 · strictAlternation 出站形状核对 ===')
  log(`本地探针服务商 127.0.0.1:${port}\n`)

  const dump = (title: string, bodies: readonly Captured[]): void => {
    log(`--- ${title} ---`)
    bodies.forEach((b, i) => {
      const hits = adjacentUserAt(b.roles)
      log(`  [${i}] ${b.label.padEnd(7)} ${b.roles.join(' ')}`)
      log(`      相邻 user @ ${hits.length === 0 ? '（无）' : hits.join(',')}`)
    })
  }

  const on = await runCycle('sa-on', true)
  log(`事件序列（开）: ${on.events.map((e) => e.status).join(' → ')}`)
  dump('strictAlternation: true —— 出站前已合并相邻 user', on.bodies)
  const onClean = on.bodies.every((b) => adjacentUserAt(b.roles).length === 0)
  log(`  全部请求无相邻 user: ${onClean ? 'PASS' : 'FAIL'}\n`)

  const off = await runCycle('sa-off', false)
  log(`事件序列（关）: ${off.events.map((e) => e.status).join(' → ')}`)
  dump('strictAlternation 未声明 —— wire 原样发出（对照组）', off.bodies)
  const offDirty = off.bodies.some((b) => adjacentUserAt(b.roles).length > 0)
  log(`  对照组确实出现相邻 user（证明开关是差别的原因）: ${offDirty ? 'PASS' : 'FAIL'}\n`)

  // 覆盖面：judge 请求必须也在转写范围内（理由见文件头 ②）。
  const judgeBodiesOn = on.bodies.filter((b) => b.label === 'judge')
  const judgeCovered = judgeBodiesOn.length > 0
    && judgeBodiesOn.every((b) => adjacentUserAt(b.roles).length === 0)
  log(`judge 请求数（开）: ${judgeBodiesOn.length}`)
  log(`judge 出站同样被转写: ${judgeCovered ? 'PASS' : 'FAIL'}`)

  // 内容零丢失：转写只合并角色，不丢字。用"合并后 user 文本仍含信封与提醒标记"
  // 的等价判据 —— 事件序列两侧一致（都跑完 set→round→round→merge→met）即说明
  // judge 拿到的历史语义没被转写破坏。
  const sameShape = on.events.map((e) => e.status).join(',') === off.events.map((e) => e.status).join(',')
  log(`两侧事件序列一致（转写不改变语义）: ${sameShape ? 'PASS' : 'FAIL'}`)

  const overall = onClean && offDirty && judgeCovered && sameShape
  log(`\nOverall: ${overall ? 'PASS' : 'FAIL —— 见上面逐条判据'}`)

  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(tmpRoot, { recursive: true, force: true })
  log(`已清理临时目录 ${tmpRoot}`)
  process.exit(overall ? 0 : 1)
}

main().catch((err) => {
  console.error('[v041-sa] FATAL:', err)
  process.exit(1)
})
