/**
 * Real-LLM multi-session + history recovery e2e.
 *
 * Verifies the complete v0.17 session layer with the real ARK API:
 *   1. Create a session (mints a UUID, writes session.json)
 *   2. Run a real-LLM loop for a few rounds (read a file, write a summary)
 *   3. Close the session
 *   4. Re-open it — recovery should reconstruct ConversationMemory + Databus
 *      from the snapshot (conversation.jsonl + databus.jsonl), and the
 *      per-session StateLine gradient should inject on the resumed loop
 *   5. Run the resumed loop to confirm it can continue
 *
 * Run: npx tsx examples/e2e-session-resume.ts
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { createBuiltinTools } from '../src/im/tools/index.js'
import { createWriteApprovalDoor } from '../src/security/doors/write-approval.js'
import { createSensitivePathDoor } from '../src/security/doors/sensitive-path.js'
import { createDangerousCommandDoor } from '../src/security/doors/dangerous-command.js'
import { createBrowserToolsDoor } from '../src/security/doors/browser-tools.js'
import { createRealLLMStreamChat } from '../src/host/llm-adapter.js'
import { createMinimalIM } from '../src/im/minimal.js'
import { runIMLoop } from '../src/im/loop.js'
import { createConfig } from '../src/shell/config.js'
import { createSessionManager } from '../src/im/session/index.js'
import type { SessionHandle } from '../src/im/session/index.js'

const ARK_KEY = process.env.ARK_KEY
if (!ARK_KEY) { console.error('ARK_KEY not set'); process.exit(1) }
const ARK_URL = process.env.ARK_URL ?? 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions'
const ARK_MODEL = process.env.ARK_MODEL ?? 'glm-5.3-flash'

const log = (...a: unknown[]) => console.log('[session-e2e]', ...a)

async function main() {
  const basePath = process.cwd() + '/tmp-e2e-sessions'
  mkdirSync(basePath, { recursive: true })
  const workDir = process.cwd() + '/tmp-e2e-session-work'
  mkdirSync(workDir, { recursive: true })
  writeFileSync(workDir + '/input.md', '# E2E Input\n\nAgent-shell session resume test.\n\n## Sections\n- multi-session window\n- history recovery\n- gradient compression\n')

  const streamChat = createRealLLMStreamChat({ url: ARK_URL, apiKey: ARK_KEY!, model: ARK_MODEL })

  function buildRegistry() {
    const r = createBuiltinTools({ cwd: workDir })
    r.registerDoor(createSensitivePathDoor())
    r.registerDoor(createDangerousCommandDoor())
    r.registerDoor(createBrowserToolsDoor())
    r.registerDoor(createWriteApprovalDoor({ handler: async () => 'approved', timeoutMs: 10_000 }))
    return r
  }

  const sessionManager = createSessionManager({ basePath })

  // ---- 1. create + first run ----------------------------------------------
  log('=== 1. createSession ===')
  const handle = await sessionManager.createSession({ title: 'session-resume-e2e', workingAgentId: 'main' })
  log('sessionId: ' + handle.info.id)
  log('dir exists: ' + existsSync(basePath + '/' + handle.info.id + '/session.json'))

  log('=== 2. first run (real LLM) ===')
  const firstOpts = handle.buildLoopOptions({
    config: createConfig({ maxSteps: 4, maxToolCalls: 8, maxElapsedMs: 60_000 }),
    registry: buildRegistry(),
    streamChat,
    url: ARK_URL,
    model: ARK_MODEL,
    systemPrompt: 'You are an assistant. Read the file and summarize it. Execute directly.',
    userTemplate: 'Read ' + workDir + '/input.md and write a one-line summary to ' + workDir + '/out1.txt using the write tool.',
    systemToolRefs: ['read', 'write'],
  })
  const firstResult = await runIMLoop(firstOpts)
  log('first run reason=' + firstResult.reason + ' turns=' + firstResult.turns)
  log('snapshot conversation lines: ' + countLines(basePath + '/' + handle.info.id + '/conversation.jsonl'))
  log('snapshot databus lines: ' + countLines(basePath + '/' + handle.info.id + '/databus.jsonl'))

  // ---- 3. close -----------------------------------------------------------
  log('=== 3. closeSession ===')
  await handle.close()

  // ---- 4. reopen (recovery) ----------------------------------------------
  log('=== 4. openSession (recovery) ===')
  const reopened = await sessionManager.openSession(handle.info.id)
  log('reopened turnCount in memory: ' + reopened.runtime.conversationMemory.turns().length)
  log('reopened databus turns: ' + reopened.runtime.databus.turns().length)
  log('reopened stateLine present: ' + !!reopened.runtime.stateLine)

  // ---- 5. resume run ------------------------------------------------------
  log('=== 5. resume run (real LLM) ===')
  const resumeOpts = reopened.buildLoopOptions({
    config: createConfig({ maxSteps: 4, maxToolCalls: 8, maxElapsedMs: 60_000 }),
    registry: buildRegistry(),
    streamChat,
    url: ARK_URL,
    model: ARK_MODEL,
    systemPrompt: 'You are an assistant. You are continuing a prior session. Read the file again if needed.',
    userTemplate: 'Continue: read ' + workDir + '/input.md and write a two-line summary to ' + workDir + '/out2.txt using the write tool.',
    systemToolRefs: ['read', 'write'],
  })
  const resumeResult = await runIMLoop(resumeOpts)
  log('resume reason=' + resumeResult.reason + ' turns=' + resumeResult.turns)

  // ---- verify -------------------------------------------------------------
  const out1 = existsSync(workDir + '/out1.txt')
  const out2 = existsSync(workDir + '/out2.txt')
  const snapshotGrew = countLines(basePath + '/' + handle.info.id + '/conversation.jsonl') > 0

  console.log('\n' + '='.repeat(70))
  console.log('SESSION RESUME E2E REPORT')
  console.log('='.repeat(70))
  console.log('LLM: ' + ARK_MODEL)
  console.log('sessionId: ' + handle.info.id)
  console.log('first run: ' + firstResult.reason)
  console.log('reopen memory turns: ' + reopened.runtime.conversationMemory.turns().length)
  console.log('reopen databus turns: ' + reopened.runtime.databus.turns().length)
  console.log('resume run: ' + resumeResult.reason)
  console.log('out1.txt created (first run): ' + out1)
  console.log('out2.txt created (resume): ' + out2)
  console.log('snapshot persisted: ' + snapshotGrew)
  console.log('-'.repeat(70))

  const ok = firstResult.reason === 'completed' &&
    reopened.runtime.conversationMemory.turns().length > 0 &&
    resumeResult.reason === 'completed' &&
    out1 && out2 && snapshotGrew
  console.log('RESULT: ' + (ok ? 'PASS' : 'FAIL'))
  if (!ok) process.exit(1)
}

function countLines(path: string): number {
  if (!existsSync(path)) return 0
  return readFileSync(path, 'utf-8').split('\n').filter((l: string) => l.trim().length > 0).length
}

main().catch(e => { console.error(e); process.exit(1) })
