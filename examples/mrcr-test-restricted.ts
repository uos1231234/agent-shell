// mrcr-test-restricted.ts — 3M recall probe with ONLY compression/recall tools.
//
// Protocol (same as mrcr-test.ts): blocks as own user turns, one FINAL ASK.
// Differences (2026-09-22 user order):
//   1. allowedToolRefs = recall-only (databus_query / state_query / ask_recall)
//      + mailbox 只读三件套（r8 起，2026-09-23 用户拍板）：mailbox_read /
//      mailbox_status / mailbox_markread——验证 50 封/批上限报错 → 分页或
//      委派 ask_recall（recall 用 mailbox_read_any 代读）的完整链路。
//      不给 mailbox_send（发信非本测试所需）。
//   2. NO permission.full — headless fail-closed doors stay armed. Any write/
//      bash attempt is denied and logged; watcher must flag violations.
//   3. Compression remains system-side (drive-coordinator / compressor).

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { createHostAssembly } from '../src/host/index.js'

const BLOCKS_FILE = String(process.env['MRCR_BLOCKS'] ?? '')
const ASK_FILE = String(process.env['MRCR_ASK'] ?? '')
const REPLY_FILE = String(process.env['MRCR_REPLY'] ?? '')
const LOG = String(process.env['MRCR_LOG'] ?? '')
const TRACE = String(process.env['MRCR_TRACE'] ?? '')
const RESUME = String(process.env['MRCR_RESUME'] ?? '')
const WORKDIR = String(process.env['MRCR_WORKDIR'] ?? '')
const DATADIR = String(process.env['MRCR_DATADIR'] ?? '')
const SYSTEM_AGENT = process.env['MRCR_PROVIDER'] ?? undefined
const VIOLATION_FILE = String(process.env['MRCR_VIOLATIONS'] ?? path.join(path.dirname(LOG), 'violations.jsonl'))

const ALLOWED_TOOLS = [
  'databus_query', 'state_query', 'ask_recall',
  'mailbox_read', 'mailbox_status', 'mailbox_markread',
] as const

// 复活模式（2026-09-23）：MRCR_SKIP_BLOCKS=1 + MRCR_RESUME=<sessionId> —
// 跳过 64 块灌入，只对复活会话问最后一个问题。用来验证"新提示词+新工具
// 下，模型会不会用 mailbox / 召回智能体"而不必重跑一小时灌入。
const SKIP_BLOCKS = process.env['MRCR_SKIP_BLOCKS'] === '1'

if (BLOCKS_FILE === '' || ASK_FILE === '' || REPLY_FILE === '' || LOG === '' || WORKDIR === '' || DATADIR === '') {
  console.error('need MRCR_BLOCKS, MRCR_ASK, MRCR_REPLY, MRCR_LOG, MRCR_WORKDIR, MRCR_DATADIR env')
  process.exit(2)
}

const log = (msg: string): void => {
  const line = `[${new Date().toISOString()}] ${msg}`
  appendFileSync(LOG, line + '\n')
  process.stderr.write(line + '\n')
}

const flagViolation = (kind: string, detail: unknown): void => {
  const rec = { at: new Date().toISOString(), kind, detail }
  appendFileSync(VIOLATION_FILE, JSON.stringify(rec) + '\n')
  log(`VIOLATION ${kind} ${JSON.stringify(detail).slice(0, 400)}`)
}

const main = async (): Promise<number> => {
  mkdirSync(path.dirname(LOG), { recursive: true })
  mkdirSync(WORKDIR, { recursive: true })

  const blocks = JSON.parse(readFileSync(BLOCKS_FILE, 'utf8')) as string[]
  const ask = readFileSync(ASK_FILE, 'utf8')
  log(`blocks=${blocks.length} total_chars=${blocks.reduce((a, b) => a + b.length, 0)}`)
  log(`TOOL_ALLOWLIST=${ALLOWED_TOOLS.join(',')}`)

  const assembly = await createHostAssembly({
    dataDir: DATADIR,
    logComponent: 'mrcr-test-restricted',
    logToStderr: false,
    noNetworkTools: true,
    allowedToolRefs: [...ALLOWED_TOOLS],
    ...(SYSTEM_AGENT !== undefined ? { systemAgentProvider: SYSTEM_AGENT } : {}),
  })

  let turnEnds = 0
  const memEvents: string[] = []
  const toolCallNames: string[] = []
  let waiting: { target: number; resolve: () => void } | undefined

  const unsubs = [
    assembly.gate.on('turn.end', () => {
      turnEnds += 1
      log(`TURN.END #${turnEnds}`)
      if (waiting && turnEnds >= waiting.target) {
        const w = waiting
        waiting = undefined
        w.resolve()
      }
    }),
    assembly.gate.on('memory.activity', (sig) => {
      if (sig.kind !== 'memory.activity') return
      const d = (sig.detail ?? {}) as { layer?: unknown; stamp?: unknown }
      const rec = `activity=${sig.activity} layer=${String(d.layer ?? '')} stamp=${String(d.stamp ?? '')}`
      memEvents.push(rec)
      log(`MEMORY ${rec}`)
    }),
    assembly.gate.on('tool.started', (sig) => {
      if (sig.kind !== 'tool.started') return
      const name = String(sig.toolName ?? '')
      toolCallNames.push(name)
      if (!(ALLOWED_TOOLS as readonly string[]).includes(name)) {
        flagViolation('tool-not-allowed', { toolName: name, callId: sig.callId })
      }
      log(`TOOL.START ${name}`)
    }),
    assembly.gate.on('tool.result', (sig) => {
      if (sig.kind !== 'tool.result') return
      const name = String(sig.toolName ?? '')
      const turn = sig.result as { isError?: boolean }
      if (!(ALLOWED_TOOLS as readonly string[]).includes(name)) {
        flagViolation('tool-not-allowed', { toolName: name, isError: turn.isError === true })
      }
      log(`TOOL.RESULT ${name} isError=${turn.isError === true}`)
    }),
    assembly.gate.on('log', (sig) => {
      if (sig.kind !== 'log') return
      if (TRACE !== '') {
        appendFileSync(
          TRACE,
          JSON.stringify({ at: Date.now(), level: sig.level, msg: sig.msg, fields: sig.fields ?? null }) + '\n',
        )
      }
      const combo = sig.msg + JSON.stringify(sig.fields ?? {})
      if (/write|bash|grep|denied|door|approval|escape|Path escapes|not allowed|restricted/i.test(combo)) {
        flagViolation('log-suspect', { msg: sig.msg, fields: sig.fields ?? null })
      }
      if (/compress|archive|drive|memory|layer|M[0-3]|runIMLoop|token/i.test(combo)) {
        log(`LOG[${sig.level}] ${sig.msg} ${JSON.stringify(sig.fields ?? {}).slice(0, 400)}`)
      }
    }),
  ]

  const waitForTurn = (target: number, timeoutMs: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (turnEnds >= target) {
        resolve()
        return
      }
      waiting = { target, resolve }
      setTimeout(resolve, timeoutMs).unref()
    })

  try {
    const handle = (await (RESUME !== ''
      ? assembly.gate.command({ kind: 'session.open', sessionId: RESUME })
      : assembly.gate.command({
          kind: 'session.create',
          payload: { workDir: WORKDIR },
        }))) as { info: { id: string }; runtime: { driveCoordinator: { drain: () => Promise<void> } } }
    const sessionId = handle.info.id
    log(`${RESUME !== '' ? 'session.opened (revived)' : 'session.created'} ${sessionId}`)
    // NO permission.full — doors stay armed (fail-closed in headless).

    if (SKIP_BLOCKS && RESUME === '') {
      console.error('MRCR_SKIP_BLOCKS=1 requires MRCR_RESUME=<sessionId> (revive mode asks the final question only)')
      process.exit(2)
    }
    log(`SKIP_BLOCKS=${SKIP_BLOCKS ? '1 (revive: final question only)' : '0'}`)

    // 复活模式：灌入 0 块，直接问最后一题（历史=被复活会话的既有 canonical）。
    for (let i = 0; i < (SKIP_BLOCKS ? 0 : blocks.length); i += 1) {
      const b0 = Date.now()
      const target = turnEnds + 1
      await assembly.gate.command({ kind: 'user.prompt', sessionId, text: blocks[i]! })
      await waitForTurn(target, 15 * 60 * 1000)
      log(`BLOCK ${i + 1}/${blocks.length} done chars=${blocks[i]!.length} in ${Math.round((Date.now() - b0) / 1000)}s`)
    }

    log(`--- FINAL ASK (single turn, ${ask.length} chars) ---`)
    const historyBeforeAsk = (await assembly.gate.command({
      kind: 'session.history',
      sessionId,
    })) as readonly { role: string; content: string }[]
    const markBeforeAsk = historyBeforeAsk.length

    const a0 = Date.now()
    const target = turnEnds + 1
    await assembly.gate.command({ kind: 'user.prompt', sessionId, text: ask })
    await waitForTurn(target, 15 * 60 * 1000)
    log(`FINAL ASK done in ${Math.round((Date.now() - a0) / 1000)}s`)

    const history = (await assembly.gate.command({
      kind: 'session.history',
      sessionId,
    })) as readonly { role: string; content: string }[]
    const after = history.slice(markBeforeAsk)
    const assistantTexts = after
      .filter((t) => t.role === 'assistant' && typeof t.content === 'string' && t.content.trim() !== '')
      .map((t) => t.content)
    const joined = assistantTexts.join('\n\n')
    const lastReply =
      joined.trim() !== ''
        ? joined
        : ([...history]
            .reverse()
            .find((t) => t.role === 'assistant' && typeof t.content === 'string' && t.content.trim() !== '')
            ?.content ?? '')
    writeFileSync(REPLY_FILE, lastReply, 'utf8')
    log(
      `wrote reply (${lastReply.length} chars, ${assistantTexts.length} assistant msgs after ask) -> ${REPLY_FILE}`,
    )

    const drainDeadline = new Promise<void>((resolve) => {
      setTimeout(resolve, 180_000).unref()
    })
    await Promise.race([handle.runtime.driveCoordinator.drain(), drainDeadline])
    const hist: Record<string, number> = {}
    for (const n of toolCallNames) hist[n] = (hist[n] ?? 0) + 1
    log(`tool_histogram=${JSON.stringify(hist)}`)
    log(`drain done; memory.activity events=${memEvents.length}`)
    for (const r of memEvents) log(`  FINAL ${r}`)

    return 0
  } catch (e: unknown) {
    log(`FATAL ${e instanceof Error ? e.message : String(e)}`)
    return 1
  } finally {
    for (const unsub of unsubs) unsub()
    await assembly.shutdown()
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    log(`FATAL ${String(e)}`)
    process.exit(1)
  })
