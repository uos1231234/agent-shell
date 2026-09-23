// Real-LLM compression + recall smoke test.
//
// Builds minimal SYNTHETIC conversation data (not the full corpus), feeds it
// into the compressor agent backed by a REAL LLM (ARK / glm-5.3-flash), and
// verifies:
//   1. Compression: compressor replies with a CuratedMemory JSON object as
//      its final output (v0.12.4 contract — record_curated_block is retired;
//      the drive-coordinator parses that JSON and persists it). This example
//      stands in for the coordinator's persistence step by calling the same
//      primitive (stateLine.compressor.appendBlock), then verifies the block
//      is queryable via stateLine.
//   2. Recall: recall agent answers a question about the compressed data,
//      using state_query to read the block back. Returns a non-empty answer.
//
// The StateLine writes to a temp directory so no real ~/.databus is touched.
//
// Usage:
//   ARK_KEY=... npx tsx examples/real-llm-compression-recall.ts
//
// Credentials are read from env (ARK_KEY required; ARK_URL/ARK_MODEL optional
// with the known defaults baked in). Never hardcode the key.

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'

import { createSystemAgent } from '../src/im/system-agent.js'
import { registerSystemAgentTools } from '../src/im/system-agents/register.js'
import { createStateLine } from '../src/im/state-line/index.js'
import { Mailbox } from '../src/im/mailbox/index.js'
import { ToolRegistry } from '../src/shell/registry.js'
import { createRealLLMStreamChat } from '../src/host/llm-adapter.js'
import {
  COMPRESSOR_AGENT_PROMPT,
  RECALL_AGENT_PROMPT,
  WAREHOUSE_AGENT_PROMPT,
} from '../src/im/prompts/index.js'
import { createConfig } from '../src/shell/config.js'
import { parseCuratedMemoryOutput } from '../src/im/system-agents/drive-coordinator.js'
import type { ChatMessage } from '../src/protocol/types.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ARK_URL = process.env.ARK_URL ?? 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions'
// SECURITY: API key must come from environment — never hardcoded in source.
const ARK_KEY: string = (() => {
  const key = process.env.ARK_KEY
  if (!key) {
    throw new Error('ARK_KEY environment variable is required. Set it before running this example.')
  }
  return key
})()
const ARK_MODEL = process.env.ARK_MODEL ?? 'glm-5.3-flash'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = (...args: unknown[]): void => console.log('[real-llm-cr]', ...args)

const makeTempDir = (): string => {
  const dir = join(tmpdir(), `real-llm-cr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log('=== Real-LLM Compression + Recall Smoke Test ===')
  log(`LLM: ${ARK_MODEL} @ ${ARK_URL}`)

  // 1. Temp dir for StateLine (no real ~/.databus touched).
  const tempDir = makeTempDir()
  log(`StateLine temp dir: ${tempDir}`)

  // 2. Infrastructure.
  const stateLine = createStateLine({ databusPath: tempDir })
  const mailbox = new Mailbox()
  const registry = new ToolRegistry()

  // 3. Real LLM adapter.
  const streamChat = createRealLLMStreamChat({
    url: ARK_URL,
    apiKey: ARK_KEY,
    model: ARK_MODEL,
    onUsage: (u) => log(`  [usage] prompt=${u.promptTokens} completion=${u.completionTokens}`),
  })

  // 4. Tight config so the LLM loop doesn't run for 200 steps.
  const agentConfig = createConfig({
    maxSteps: 12,
    maxToolCalls: 30,
    maxElapsedMs: 10 * 60 * 1000,
  })

  // 5. Three system agents. registerSystemAgentTools expects all three even if
  //    warehouse is not exercised. Each agent is created individually (not via
  //    createSystemAgents batch factory) so we can pass the tight config.
  const compressor = createSystemAgent({
    name: 'compressor',
    systemPrompt: COMPRESSOR_AGENT_PROMPT,
    toolRefs: ['databus_query', 'state_query', 'mailbox_send', 'mailbox_read', 'record_curated_block'],
    llmStreamChat: streamChat, url: ARK_URL, model: ARK_MODEL,
    mailbox, registry, stateLine, config: agentConfig,
  })
  const warehouse = createSystemAgent({
    name: 'warehouse',
    systemPrompt: WAREHOUSE_AGENT_PROMPT,
    toolRefs: ['databus_query', 'databus_subscribe', 'mailbox_send', 'mailbox_read', 'record_m3_summary'],
    llmStreamChat: streamChat, url: ARK_URL, model: ARK_MODEL,
    mailbox, registry, stateLine, config: agentConfig,
  })
  const recall = createSystemAgent({
    name: 'recall',
    systemPrompt: RECALL_AGENT_PROMPT,
    toolRefs: ['databus_query', 'state_query', 'mailbox_send', 'mailbox_read'],
    llmStreamChat: streamChat, url: ARK_URL, model: ARK_MODEL,
    mailbox, registry, stateLine, config: agentConfig,
  })

  registerSystemAgentTools(registry, mailbox, { warehouse, compressor, recall })
  log('Registered system tools')

  // -------------------------------------------------------------------------
  // Phase 1: Compression — feed a small synthetic task block to the compressor.
  // -------------------------------------------------------------------------
  log('\n--- Phase 1: Compression (synthetic block → M1) ---')

  // A realistic task block: user asks, assistant calls a tool, tool returns,
  // assistant answers. The compressor distills this into the 11-field schema.
  const syntheticMessages: ChatMessage[] = [
    {
      role: 'user',
      content:
        'I need to refactor the path resolution module to use ESM imports instead of CommonJS require. Can you check the current state?',
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'databus_query',
            arguments: '{"reason":"checking current path module state"}',
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call-1',
      content:
        'The path module currently uses require() in 3 files: path-resolver.ts, path-utils.ts, and path-config.ts. All imports are CommonJS style.',
    },
    {
      role: 'assistant',
      content:
        'I found 3 files using CommonJS require(). I will now convert them to ESM imports. The main changes are: require("path") to import path from "path", require("./utils") to import { utils } from "./utils.js". This should be straightforward since the project already has "type": "module" in package.json.',
    },
  ]

  const compressStart = Date.now()
  const compressResult = await compressor.run({
    messages: syntheticMessages,
    metadata: { zone: 'M1' },
  })
  const compressMs = Date.now() - compressStart
  log(`Compressor finished in ${compressMs}ms`)
  log(`  reason: ${compressResult.reason}`)
  log(`  output: ${JSON.stringify(compressResult.output).slice(0, 160)}`)

  // v0.12.4 契约：压缩器的最终回复就是 CuratedMemory JSON（record_curated_block
  // 已退役）。生产里由 drive-coordinator 解析并持久化；本示例用同一个解析器 +
  // 同一个持久化原语（stateLine.compressor.appendBlock）代行 coordinator 那一步。
  try {
    const parsed = parseCuratedMemoryOutput(compressResult.output)
    log(`  parsed task_goal: ${String(parsed.task_goal ?? '').slice(0, 120)}`)
    const stamp = `S-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await stateLine.compressor.appendBlock(parsed, 'M1', stamp)
  } catch (e) {
    log(`  parse/persist failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  const m1Blocks = stateLine.query({ layer: 'M1' })
  log(`M1 blocks persisted: ${m1Blocks.length}`)

  let compressPass = false
  if (m1Blocks.length >= 1) {
    const block = m1Blocks[0] as Record<string, unknown>
    log('  First M1 block:')
    log(`    task_goal: ${String(block.task_goal ?? '').slice(0, 160)}`)
    log(`    conclusion: ${String(block.conclusion ?? '').slice(0, 160)}`)
    log(`    next_action: ${String(block.next_action ?? '').slice(0, 160)}`)
    compressPass = true
  }
  log(`Compression phase: ${compressPass ? 'PASS' : 'FAIL'}`)

  // -------------------------------------------------------------------------
  // Phase 2: Recall — ask the recall agent about the compressed data.
  // -------------------------------------------------------------------------
  log('\n--- Phase 2: Recall (query about the refactoring) ---')

  // Recall agent expects the same structured shape ask_recall sends it.
  const recallQuery = {
    kind: 'ask_recall' as const,
    query: 'What was the path resolution refactoring about?',
    scope: 'compressed' as const,
  }

  const recallStart = Date.now()
  const recallResult = await recall.run({
    messages: [{ role: 'user', content: JSON.stringify(recallQuery) }],
  })
  const recallMs = Date.now() - recallStart
  log(`Recall finished in ${recallMs}ms`)
  log(`  reason: ${recallResult.reason}`)

  const recallOutput = recallResult.output
  const recallStr = typeof recallOutput === 'string' ? recallOutput : JSON.stringify(recallOutput)
  log(`  output (first 400 chars): ${recallStr.slice(0, 400)}`)

  // Non-empty, non-undefined answer that mentions path/ESM/refactoring content.
  let recallPass = false
  if (recallStr && recallStr.trim().length > 0 && recallStr !== 'undefined') {
    const lower = recallStr.toLowerCase()
    const mentionsPathOrEsm =
      lower.includes('path') || lower.includes('esm') || lower.includes('require') || lower.includes('import') || lower.includes('refactor')
    recallPass = mentionsPathOrEsm
    if (!mentionsPathOrEsm) {
      log('  NOTE: answer non-empty but did not mention path/esm/refactor keywords — marking FAIL')
    }
  }
  log(`Recall phase: ${recallPass ? 'PASS' : 'FAIL'}`)

  // -------------------------------------------------------------------------
  // Summary + cleanup
  // -------------------------------------------------------------------------
  log('\n=== Summary ===')
  log(`Compression: ${compressPass ? 'PASS' : 'FAIL'}`)
  log(`Recall:      ${recallPass ? 'PASS' : 'FAIL'}`)
  const overall = compressPass && recallPass
  log(`\nOverall: ${overall ? 'PASS — compression + recall work with real LLM' : 'PARTIAL — see failures above'}`)

  rmSync(tempDir, { recursive: true, force: true })
  log(`Cleaned up temp dir: ${tempDir}`)

  process.exit(overall ? 0 : 1)
}

main().catch((err) => {
  console.error('[real-llm-cr] FATAL:', err)
  process.exit(1)
})
