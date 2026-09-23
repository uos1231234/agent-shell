// chunk-test.ts — 切块机制触发压缩验证驱动（评测用，一次性）。
//
// 为什么不用 CLI -p：950K token 文本约 4.4M 字符，塞不进 Windows 命令行
// （-p 参数上限 ~32K 字符）。本驱动从文件读 prompt，复用 headless 的 gate
// 调用序列：session.create → yolo permission.full → chunk.set(true) →
// user.prompt。监听 memory.activity（压缩/归档）+ log（drive-coordinator
// tick/dispatch）来验证压缩是否触发。
//
// 只用切块机制，不启 goal（gate 强制二者互斥，见 gate.ts:418）。

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { createHostAssembly } from '../src/host/index.js'

const JSONL = String(process.env['NIAH_JSONL'] ?? '')
const WORKDIR = String(process.env['CHUNK_WORKDIR'] ?? '')
const DATADIR = String(process.env['CHUNK_DATADIR'] ?? '')
const LOG = String(process.env['CHUNK_LOG'] ?? '')
const SAMPLE_IDX = Number(process.env['SAMPLE_IDX'] ?? '0')
const SYSTEM_AGENT = process.env['SYSTEM_AGENT_PROVIDER'] ?? undefined
// recall 测试支持：续跑已有会话 + 跳过已消费字符 + 末尾追加召回提问。
const RESUME_SESSION = process.env['RESUME_SESSION'] ?? undefined
const CHAR_OFFSET = Number(process.env['CHAR_OFFSET'] ?? '0')
const RECALL_QUESTION = process.env['RECALL_QUESTION'] ?? undefined

if (JSONL === '' || WORKDIR === '' || DATADIR === '' || LOG === '') {
  console.error('need NIAH_JSONL, CHUNK_WORKDIR, CHUNK_DATADIR, CHUNK_LOG env')
  process.exit(2)
}

const log = (msg: string): void => {
  const line = `[${new Date().toISOString()}] ${msg}`
  appendFileSync(LOG, line + '\n')
  process.stderr.write(line + '\n')
}

const main = async (): Promise<number> => {
  mkdirSync(path.dirname(LOG), { recursive: true })
  const lines = readFileSync(JSONL, 'utf8').trim().split('\n')
  const sample = JSON.parse(lines[SAMPLE_IDX]!) as {
    input: string
    outputs: string[]
    length: number
    token_position_answer: number
  }
  const text = sample.input
  // recall 续跑：跳过已消费的前 CHAR_OFFSET 字符，只喂剩余部分。
  const feedText = CHAR_OFFSET > 0 ? text.slice(CHAR_OFFSET) : text
  log(
    `sample[${SAMPLE_IDX}] length_tokens=${sample.length} chars=${text.length} ` +
      `feed_chars=${feedText.length} char_offset=${CHAR_OFFSET} ` +
      `outputs=${JSON.stringify(sample.outputs)} answer_pos=${sample.token_position_answer}` +
      (RESUME_SESSION !== undefined ? ` resume=${RESUME_SESSION}` : '') +
      (RECALL_QUESTION !== undefined ? ` recall=${RECALL_QUESTION.slice(0, 40)}...` : ''),
  )

  const assembly = await createHostAssembly({
    dataDir: DATADIR,
    logComponent: 'chunk-test',
    logToStderr: false,
    noNetworkTools: true,
    ...(SYSTEM_AGENT !== undefined ? { systemAgentProvider: SYSTEM_AGENT } : {}),
  })

  const memEvents: string[] = []
  // 切块模式：user.prompt await 首个分卷完成后返回 {chunked,chunks}，其余分卷
  // 由 advanceQueue 链式后台驱动，每卷完成 emit turn.end。靠数 turn.end 等全部。
  let turnEnds = 0
  let expectedChunks = 0
  let resolveAllDone: (() => void) | undefined
  const allDone = new Promise<void>((resolve) => {
    resolveAllDone = resolve
  })
  const unsubs = [
    assembly.gate.on('turn.end', (sig) => {
      if (sig.kind !== 'turn.end') return
      turnEnds += 1
      log(`TURN.END #${turnEnds}/${expectedChunks || '?'} reason=${String((sig as { reason?: unknown }).reason ?? '')}`)
      if (expectedChunks > 0 && turnEnds >= expectedChunks) resolveAllDone?.()
    }),
    assembly.gate.on('memory.activity', (sig) => {
      if (sig.kind !== 'memory.activity') return
      const d = (sig.detail ?? {}) as { layer?: unknown; stamp?: unknown; taskGoal?: unknown }
      const rec = `activity=${sig.activity} layer=${String(d.layer ?? '')} stamp=${String(d.stamp ?? '')}`
      memEvents.push(rec)
      log(`MEMORY ${rec}`)
    }),
    assembly.gate.on('log', (sig) => {
      if (sig.kind !== 'log') return
      // 只留压缩相关日志（drive-coordinator / compressor / memory），避免刷屏
      const msg = sig.msg
      const fields = JSON.stringify(sig.fields ?? {})
      const combo = msg + fields
      if (/compress|archive|drive|memory|layer|overflow|compact|M[0-3]/i.test(combo)) {
        log(`LOG[${sig.level}] ${msg} ${fields.slice(0, 300)}`)
      }
    }),
    assembly.gate.on('chunk.changed', (sig) => {
      if (sig.kind !== 'chunk.changed') return
      log(`CHUNK enabled=${String(sig.enabled)} tokens=${String(sig.chunkTokens ?? '')}`)
    }),
  ]

  try {
    // resume 已有会话（续跑：session.open）或新建（session.create）。
    const handle = (await (RESUME_SESSION !== undefined
      ? assembly.gate.command({ kind: 'session.open', sessionId: RESUME_SESSION })
      : assembly.gate.command({
          kind: 'session.create',
          payload: { workDir: WORKDIR },
        }))) as { info: { id: string }; runtime: { driveCoordinator: { drain: () => Promise<void> } } }
    const sessionId = handle.info.id
    log(`${RESUME_SESSION !== undefined ? 'session.opened' : 'session.created'} ${sessionId}`)

    await assembly.gate.command({ kind: 'permission.full', sessionId, enabled: true })
    await assembly.gate.command({ kind: 'chunk.set', sessionId, enabled: true })
    log('yolo + chunk enabled; sending prompt (this feeds ~110 chunks serially)...')

    const started = Date.now()
    const receipt = (await assembly.gate.command({
      kind: 'user.prompt',
      sessionId,
      text: feedText,
    })) as { chunked?: boolean; chunks?: number; reason?: string }
    const secs = Math.round((Date.now() - started) / 1000)
    if (receipt.chunked === true) {
      expectedChunks = receipt.chunks ?? 0
      log(`user.prompt chunked: ${expectedChunks} chunks; first chunk done in ${secs}s; waiting for remaining...`)
      // 等全部分卷完成（每卷一次 LLM 调用，950K→~110 卷，给足超时）
      const timeoutMs = 4 * 3600_000
      await Promise.race([
        allDone,
        new Promise<void>((resolve) => {
          setTimeout(resolve, timeoutMs).unref()
        }),
      ])
      log(`all chunks done (or timeout); turnEnds=${turnEnds}/${expectedChunks} elapsed_total=${Math.round((Date.now() - started) / 1000)}s`)
    } else {
      log(`user.prompt non-chunked receipt: ${JSON.stringify(receipt).slice(0, 200)} elapsed=${secs}s`)
    }

    // recall 测试：全部分卷读完后，追加一轮提问针值，捕获 assistant 回复。
    if (RECALL_QUESTION !== undefined) {
      log(`--- RECALL PHASE: asking "${RECALL_QUESTION}" ---`)
      const recallStart = Date.now()
      const recallReceipt = (await assembly.gate.command({
        kind: 'user.prompt',
        sessionId,
        text: RECALL_QUESTION,
      })) as { chunked?: boolean; chunks?: number }
      log(`recall prompt done in ${Math.round((Date.now() - recallStart) / 1000)}s receipt=${JSON.stringify(recallReceipt).slice(0, 120)}`)
      // 取 session.history 的最后一条 assistant 回复。
      const history = (await assembly.gate.command({
        kind: 'session.history',
        sessionId,
      })) as readonly { role: string; content: string }[]
      const assistants = history.filter((t) => t.role === 'assistant' && typeof t.content === 'string' && t.content.trim() !== '')
      const lastReply = assistants[assistants.length - 1]?.content ?? ''
      log(`--- RECALL ANSWER (last assistant, ${lastReply.length} chars) ---`)
      log(lastReply.slice(0, 2000))
      // 命中判定：回复里是否含针值。
      const needle = sample.outputs[0] ?? ''
      const hit = needle !== '' && lastReply.includes(needle)
      log(`--- RECALL VERDICT: needle=${needle} hit=${hit} ---`)
    }

    // drain 压缩落盘（同 headless 收尾纪律，带超时）
    const drainDeadline = new Promise<void>((resolve) => {
      setTimeout(resolve, 120_000).unref()
    })
    await Promise.race([handle.runtime.driveCoordinator.drain(), drainDeadline])
    log(`drain done; total memory.activity events=${memEvents.length}`)
    for (const r of memEvents) log(`  FINAL ${r}`)

    return turnEnds > 0 || (RECALL_QUESTION !== undefined && memEvents.length === 0) ? 0 : 1
  } finally {
    for (const unsub of unsubs) unsub()
    await assembly.shutdown()
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    log(`FATAL ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  })
