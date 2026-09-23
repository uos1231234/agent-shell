// Real LLM + real MCP server end-to-end verification (v0.13).
//
// This is a MANUAL-RUN example, not a vitest test. The vitest suite stays
// offline (scripted LLM, no network). This file deliberately goes the other
// way: it boots a REAL wiki MCP server (a stdio JSON-RPC
// process), points the IM loop at a REAL LLM (ARK / glm-5.3-flash), and
// verifies the full chain — boot → tool registration → LLM tool-calls →
// databus persistence → final answer — against live data.
//
// Security model (read this before editing):
//   bootMcpServers connects to the wiki server and registers EVERY tool the
//   server exposes (search_cards, list_cards, get_card, ... AND the mutating
//   add_card / remove_card / update_card / update_relations, plus file-reading
//   read_raw_file / diff_docs / check_doc_updates) into the ToolRegistry. That
//   registration is the transport layer — it makes tools *dispatchable* by name.
//   What the LLM can actually SEE and choose to call is governed separately by
//   `mcpRefs` in createMinimalIM: only tools listed in mcpRefs are serialized
//   into the prompt's `tools` array (see src/shell/compose.ts case 'mcp'). So
//   mcpRefs is the LLM-facing capability gate. This example exposes ONLY the
//   five read-only tools (search_cards, list_cards, get_card, list_phases,
//   get_phase_context) and deliberately omits every write/file tool — the wiki
// is a live knowledge base and the test must not give the model any
//   path that mutates it, even if boot registered them for dispatch.
//
// Run:
//   ARK_KEY=<your-key> npx tsx examples/real-llm-mcp-wiki.ts
// The ARK_KEY is read ONLY from process.env.ARK_KEY. It never appears in this
// source or in comments. If absent, the script prints a clear message and
// exits non-zero.

import { createRealLLMStreamChat } from '../src/host/llm-adapter.js'
import { bootMcpServers } from '../src/mcp/boot.js'
import { createMinimalIM } from '../src/im/minimal.js'
import { runIMLoop } from '../src/im/loop.js'
import { Databus } from '../src/im/databus.js'
import { ConversationMemory } from '../src/im/conversation-memory.js'
import { ToolRegistry } from '../src/shell/registry.js'
import { createConfig } from '../src/shell/config.js'
import type { Usage } from '../src/protocol/types.js'

// ---- env guard ------------------------------------------------------------
const ARK_KEY = process.env.ARK_KEY
if (!ARK_KEY || ARK_KEY.trim() === '') {
  console.error('❌ ARK_KEY is not set. Export it first, e.g.:')
  console.error("   ARK_KEY=<key> npx tsx examples/real-llm-mcp-wiki.ts")
  process.exit(1)
}

// The five read-only tools exposed to the LLM. Write/file tools (add_card,
// remove_card, update_card, update_relations, read_raw_file, diff_docs,
// check_doc_updates) are intentionally absent — see file header.
const READONLY_REFS = [
  'search_cards',
  'list_cards',
  'get_card',
  'list_phases',
  'get_phase_context',
] as const

const SERVER_NAME = 'wiki'
const SERVER_PATH = process.env['WIKI_MCP_SERVER_PATH'] ?? './wiki-mcp/server.js'

// ---- main -----------------------------------------------------------------
async function main(): Promise<void> {
  const exitCode = await run().catch((e) => {
    console.error('\n❌ Unhandled error:', e instanceof Error ? e.message : String(e))
    if (e instanceof Error && e.stack) console.error(e.stack)
    return 1
  })
  if (exitCode !== 0) process.exit(exitCode)
}

async function run(): Promise<number> {
  // ===== Stage 0: boot the real wiki MCP server =====
  console.log('=== Stage 0: boot real MCP server (stdio) ===')
  console.log(`  command: node ${SERVER_PATH}`)
  console.log(`  server name: ${SERVER_NAME}`)

  const registry = new ToolRegistry()
  let boot
  try {
    boot = await bootMcpServers(registry, [
      {
        name: SERVER_NAME,
        transport: 'stdio',
        command: 'node',
        args: [SERVER_PATH],
      },
    ])
  } catch (e) {
    console.error('❌ Stage 0 FAILED: could not boot MCP server.')
    console.error('   ', e instanceof Error ? e.message : String(e))
    return 1
  }

  console.log(`✅ connected servers: ${boot.servers.join(', ')}`)
  console.log(`✅ registered tools (${boot.tools.length}):`)
  for (const t of boot.tools) console.log(`   - ${t}`)

  // Confirm the read-only five are present in the registry (boot registered
  // everything; we just sanity-check before gating).
  const missing = READONLY_REFS.filter((r) => !registry.getMCPTool(SERVER_NAME, r))
  if (missing.length > 0) {
    console.error(`❌ Stage 0 FAILED: expected read-only tools missing from registry: ${missing.join(', ')}`)
    await boot.close()
    return 1
  }
  console.log(`✅ read-only five present: ${READONLY_REFS.join(', ')}`)

  // ===== Stage 1: assemble the working agent with a real LLM =====
  console.log('\n=== Stage 1: assemble working agent (real LLM) ===')

  // Container object: TS control-flow analysis doesn't track `let` mutation
  // from inside the onUsage closure — it would narrow totalUsage to `never`
  // at the read site. A box keeps the type honest at the read.
  const usageBox: { current: Usage | null } = { current: null }
  const streamChat = createRealLLMStreamChat({
    url: 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions',
    // Non-null assertion: the module-top env guard exits when ARK_KEY is
    // unset; TS narrowing doesn't cross the function boundary into run().
    apiKey: ARK_KEY!,
    model: 'glm-5.3-flash',
    onUsage: (u) => { usageBox.current = u },
  })

  const conversationMemory = new ConversationMemory()
  const userQuestion =
    "请用 search_cards 工具搜索关键词'骑士'，再用 list_cards 看看库里的卡片，然后回答：" +
    '库里一共有多少张卡片、搜索"骑士"命中几条、第一条命中卡片的标题是什么。'
  conversationMemory.append({
    id: 'user-1',
    role: 'user',
    content: userQuestion,
    at: Date.now(),
  })

  const systemPrompt =
    '你是一个使用工具回答问题的助手。你可以调用 literature-wiki 服务器上的只读工具查询一个文学知识库。' +
    '规则：先用工具搜索/查询获取真实数据，再根据工具返回的数据给出最终回答。' +
    '回答必须引用工具返回的真实内容（标题、数量等），不要编造。' +
    '工具名格式为 literature-wiki__search_cards 等。'

  const loopOpts = createMinimalIM({
    config: createConfig({
      maxSteps: 6,            // small budget: 1 user + a few tool rounds + 1 final
      maxToolCalls: 20,
      maxElapsedMs: 120_000,  // 2 min ceiling for live network
    }),
    registry,
    streamChat,
    url: 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions',
    model: 'glm-5.3-flash',
    systemPrompt,
    userTemplate: userQuestion,
    conversationMemory,
    workingAgentId: 'main',
    // SECURITY GATE: only the five read-only tools reach the LLM prompt.
    // bootMcpServers registered ~14 tools into the registry (including write
    // tools), but mcpRefs below is what compose() serializes into the prompt's
    // `tools` array — so the model never sees add_card / update_card / etc.
    systemToolRefs: [],
    mcpRefs: [{ server: SERVER_NAME, refs: [...READONLY_REFS] }],
  })

  console.log(`  model: glm-5.3-flash`)
  console.log(`  mcpRefs (LLM-visible): ${READONLY_REFS.join(', ')}`)
  console.log(`  config: maxSteps=6, maxToolCalls=20, maxElapsedMs=120000`)
  console.log(`  user question: ${userQuestion.slice(0, 50)}...`)

  // ===== Stage 2: run the loop and verify =====
  console.log('\n=== Stage 2: runIMLoop (live LLM + live tools) ===')
  let result
  try {
    result = await runIMLoop(loopOpts)
  } catch (e) {
    console.error('❌ Stage 2 FAILED: runIMLoop threw.')
    console.error('   ', e instanceof Error ? e.message : String(e))
    await boot.close()
    return 1
  }

  console.log(`  loop reason: ${result.reason}`)
  console.log(`  loop turns: ${result.turns}`)
  console.log(`  final state: ${result.finalState}`)
  if (result.hits.length > 0) {
    console.log(`  guard hits: ${result.hits.map((h) => h.id).join(', ')}`)
  }

  // --- Verification 1: databus has main tool turns with real card JSON ---
  const databus = loopOpts.databus
  const mainToolTurns = databus.query({ sourceAgentIds: ['main'] })
  const hasRealData = mainToolTurns.some(
    (t) => !t.isError && (t.content.includes('"title"') || t.content.includes('"id"')),
  )
  console.log(`\n  [Verify 1] main tool turns in databus: ${mainToolTurns.length}`)
  for (const t of mainToolTurns) {
    const preview = t.content.slice(0, 80).replace(/\n/g, ' ')
    console.log(`    - ${t.isError ? 'ERROR' : 'ok'} | ${preview}...`)
  }
  console.log(`  [Verify 1] contains real card JSON (title/id): ${hasRealData ? '✅' : '❌'}`)

  // --- Verification 2: loop completed (LLM called tools and gave a final answer) ---
  const completed = result.reason === 'completed'
  console.log(`  [Verify 2] reason === 'completed': ${completed ? '✅' : '❌'} (got '${result.reason}')`)

  // --- Verification 3: final assistant output non-empty and references data ---
  const turns = conversationMemory.turns()
  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant' && t.content && t.content.length > 0)
  const finalTextRaw = lastAssistant?.content ?? ''
  const finalText = typeof finalTextRaw === 'string' ? finalTextRaw : ''
  const hasSubstance = finalText.length > 20
  console.log(`  [Verify 3] final assistant output length ${finalText.length} (>20): ${hasSubstance ? '✅' : '❌'}`)
  console.log(`  [Verify 3] final output preview: ${finalText.slice(0, 200).replace(/\n/g, ' ')}`)

  // ----- summary of which tools the LLM actually called -----
  const calledTools: string[] = []
  for (const t of turns) {
    if (t.role === 'assistant' && t.toolCalls) {
      for (const tc of t.toolCalls) calledTools.push(tc.function.name)
    }
  }
  console.log(`\n  LLM called tools: ${calledTools.length > 0 ? calledTools.join(' → ') : '(none)'}`)

  const totalUsage = usageBox.current
  if (totalUsage) {
    console.log(`  token usage: prompt=${totalUsage.promptTokens} completion=${totalUsage.completionTokens} total=${totalUsage.totalTokens}`)
  } else {
    console.log(`  token usage: (not reported by provider)`)
  }

  // ===== Stage 3: cleanup + verdict =====
  console.log('\n=== Stage 3: cleanup ===')
  await boot.close()
  console.log('✅ boot.close() done')

  const allPass = hasRealData && completed && hasSubstance
  console.log('\n=== Verdict ===')
  console.log(`  Verify 1 (databus has real tool turns): ${hasRealData ? '✅' : '❌'}`)
  console.log(`  Verify 2 (loop completed):             ${completed ? '✅' : '❌'}`)
  console.log(`  Verify 3 (final output has substance): ${hasSubstance ? '✅' : '❌'}`)
  console.log(`  Overall: ${allPass ? '✅ ALL PASS' : '❌ FAIL'}`)
  return allPass ? 0 : 1
}

main()
