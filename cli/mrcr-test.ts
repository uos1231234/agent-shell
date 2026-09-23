// mrcr-test.ts — drive agent-shell over an MRCR sample, then ask once at the end.
//
// Protocol (fixed, do not "improve"):
//   1. Each block is delivered as its OWN user turn. NEVER concatenate them into
//      one giant prompt: harness memory mechanisms key off user input, and a
//      single mega-request degrades into a test of the model's native long-context
//      ability rather than of the harness.
//   2. Nothing is asked mid-stream. A mid-stream question measures "read and
//      answer as you go", not recall decay.
//   3. The ask happens ONCE, after every block has been consumed, in ONE turn.
//
// Chunk mode is deliberately NOT enabled: we do the chunking ourselves so the
// block boundaries are ours and observable.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { createHostAssembly } from '../src/host/index.js'

const BLOCKS_FILE = String(process.env['MRCR_BLOCKS'] ?? '')
const ASK_FILE = String(process.env['MRCR_ASK'] ?? '')
const REPLY_FILE = String(process.env['MRCR_REPLY'] ?? '')
const LOG = String(process.env['MRCR_LOG'] ?? '')
// FULL, UNFILTERED log-signal trace. The first 1M attempt filtered log signals by
// a keyword regex, which silently dropped `runIMLoop completed` — the one line
// carrying the working agent's real `lastRequestTokens`, i.e. exactly the number
// that decides the memory layer and therefore whether compression fires at all.
// Never filter this channel again; write every signal to JSONL instead.
const TRACE = String(process.env['MRCR_TRACE'] ?? '')
// Revive mode: re-open a persisted session instead of creating one, then ask.
// agent-shell persists the model's context verbatim (conversation.jsonl +
// databus.jsonl) and recoverSession() rebuilds it from those files, so a finished
// 1M-token run can be re-questioned without re-ingesting anything.
const RESUME = String(process.env['MRCR_RESUME'] ?? '')
const WORKDIR = String(process.env['MRCR_WORKDIR'] ?? '')
const DATADIR = String(process.env['MRCR_DATADIR'] ?? '')
const SYSTEM_AGENT = process.env['MRCR_PROVIDER'] ?? undefined

if (BLOCKS_FILE === '' || ASK_FILE === '' || REPLY_FILE === '' || LOG === '' || WORKDIR === '' || DATADIR === '') {
  console.error('need MRCR_BLOCKS, MRCR_ASK, MRCR_REPLY, MRCR_LOG, MRCR_WORKDIR, MRCR_DATADIR env')
  process.exit(2)
}

const log = (msg: string): void => {
  const line = `[${new Date().toISOString()}] ${msg}`
  appendFileSync(LOG, line + '\n')
  process.stderr.write(line + '\n')
}

const main = async (): Promise<number> => {
  mkdirSync(path.dirname(LOG), { recursive: true })

  const blocks = JSON.parse(readFileSync(BLOCKS_FILE, 'utf8')) as string[]
  const ask = readFileSync(ASK_FILE, 'utf8')
  log(`blocks=${blocks.length} total_chars=${blocks.reduce((a, b) => a + b.length, 0)}`)
  log(`ask=${JSON.stringify(ask.slice(0, 200))}`)

  const assembly = await createHostAssembly({
    dataDir: DATADIR,
    logComponent: 'mrcr-test',
    logToStderr: false,
    noNetworkTools: true,
    ...(SYSTEM_AGENT !== undefined ? { systemAgentProvider: SYSTEM_AGENT } : {}),
  })

  let turnEnds = 0
  const memEvents: string[] = []
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
    assembly.gate.on('log', (sig) => {
      if (sig.kind !== 'log') return
      // UNFILTERED trace: every signal, verbatim. See the TRACE comment above for
      // why a keyword filter here cost us the whole first 1M diagnosis.
      if (TRACE !== '') {
        appendFileSync(
          TRACE,
          JSON.stringify({ at: Date.now(), level: sig.level, msg: sig.msg, fields: sig.fields ?? null }) + '\n',
        )
      }
      // Human-readable channel stays filtered to keep the run log scannable.
      const combo = sig.msg + JSON.stringify(sig.fields ?? {})
      if (/compress|archive|drive|memory|layer|overflow|compact|M[0-3]|runIMLoop|tick|token/i.test(combo)) {
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

    await assembly.gate.command({ kind: 'permission.full', sessionId, enabled: true })
    log('yolo enabled; chunk mode NOT enabled (we chunk explicitly)')

    for (let i = 0; i < blocks.length; i += 1) {
      const b0 = Date.now()
      const target = turnEnds + 1
      await assembly.gate.command({ kind: 'user.prompt', sessionId, text: blocks[i]! })
      await waitForTurn(target, 15 * 60 * 1000)
      log(`BLOCK ${i + 1}/${blocks.length} done chars=${blocks[i]!.length} in ${Math.round((Date.now() - b0) / 1000)}s`)
    }

    // FINAL ASK — one turn, after everything has been consumed.
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

    // Collect EVERY assistant message produced after the ask, not just the last one:
    // the agent may interleave tool calls with its answer, and taking only the final
    // turn would silently drop an answer that appeared earlier. (On the first 1M
    // attempt the last assistant message was a mid-thought line, which is how the
    // run looked like an empty reply.)
    const history = (await assembly.gate.command({
      kind: 'session.history',
      sessionId,
    })) as readonly { role: string; content: string }[]
    const after = history.slice(markBeforeAsk)
    const assistantTexts = after
      .filter((t) => t.role === 'assistant' && typeof t.content === 'string' && t.content.trim() !== '')
      .map((t) => t.content)
    // Prefer the concatenation of everything said after the ask; fall back to the
    // final assistant turn of the whole session if the slice came back empty.
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
      `wrote reply (${lastReply.length} chars, ${assistantTexts.length} assistant msgs after ask) ` +
        `-> ${REPLY_FILE}`,
    )

    const drainDeadline = new Promise<void>((resolve) => {
      setTimeout(resolve, 180_000).unref()
    })
    await Promise.race([handle.runtime.driveCoordinator.drain(), drainDeadline])
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
