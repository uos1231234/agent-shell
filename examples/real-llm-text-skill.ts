// v0.13 incremental: real-LLM verification of plain-text skills.
//
// Manual smoke test (NOT a vitest test). Verifies the "调用即注入" (call-as-
// injection) end-to-end with a REAL LLM (ARK / glm-5.3-flash):
//   1. mkdtemp a text skill file `style-guide.md` (frontmatter + 4 poetry rules)
//   2. bootstrapExtensions({ textSkillsDir }) registers it as a callable tool
//   3. createMinimalIM({ skillRefs: ['style-guide'] }) exposes it to the LLM
//   4. systemPrompt instructs: "写诗前必须先调用 style-guide 工具获取规则"
//   5. runIMLoop drives the real LLM with the user question "请按风格规则写一首四行短诗"
//   6. verify three points ✅/❌:
//      (a) databus/conversationMemory has a tool turn for style-guide whose
//          content contains the body rules (the LLM called the tool → body
//          entered the context = injection happened)
//      (b) loop completed (result.reason === 'completed')
//      (c) final assistant output is non-empty
//
// Usage:
//   ARK_KEY=... npx tsx examples/real-llm-text-skill.ts
//
// API key comes from env (ARK_KEY required). Never hardcoded in source.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ToolRegistry } from '../src/shell/registry.js'
import { createConfig } from '../src/shell/config.js'
import { ConversationMemory } from '../src/im/conversation-memory.js'
import { createNoopStateLine } from '../src/im/state-line/index.js'
import { createMinimalIM } from '../src/im/minimal.js'
import { runIMLoop } from '../src/im/loop.js'
import { bootstrapExtensions } from '../src/extensions.js'
import { createRealLLMStreamChat } from '../src/host/llm-adapter.js'
import type { Usage } from '../src/protocol/types.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ARK_URL = process.env.ARK_URL ?? 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions'
// SECURITY: API key must come from environment — never hardcoded in source.
const ARK_KEY: string = (() => {
  const key = process.env.ARK_KEY
  if (!key) {
    console.error('[real-llm-text-skill] ERROR: ARK_KEY environment variable is required.')
    console.error('[real-llm-text-skill]        Set it before running, e.g.  ARK_KEY=... npx tsx examples/real-llm-text-skill.ts')
    process.exit(0)
  }
  return key
})()
const ARK_MODEL = process.env.ARK_MODEL ?? 'glm-5.3-flash'

const log = (...args: unknown[]): void => console.log('[real-llm-text-skill]', ...args)

// Overall wall-clock guard so a misbehaving LLM can't hang the smoke test.
const OVERALL_TIMEOUT_MS = 4 * 60 * 1000
const overallTimer = setTimeout(() => {
  console.error('[real-llm-text-skill] FATAL: overall timeout exceeded — aborting.')
  process.exit(1)
}, OVERALL_TIMEOUT_MS)
overallTimer.unref?.()

// The poetry rules injected as the text skill body. These exact strings are
// what we look for in the tool-turn content to confirm injection happened.
const RULE_LINE_1 = '每行不超过 12 字'
const RULE_LINE_2 = '押 ang 韵'
const RULE_LINE_3 = '意象用自然物'
const RULE_LINE_4 = '结尾必须留白'
const SKILL_BODY = `\n# 写诗风格规则\n\n写诗前必须遵守以下四条：\n\n1. ${RULE_LINE_1}\n2. ${RULE_LINE_2}\n3. ${RULE_LINE_3}\n4. ${RULE_LINE_4}\n`

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log('=== Real-LLM Text Skill Smoke Test ===')
  log(`LLM: ${ARK_MODEL} @ ${ARK_URL}`)
  log(`Overall timeout: ${OVERALL_TIMEOUT_MS / 1000}s`)

  // 1. Write the text skill into a temp dir.
  const textDir = mkdtempSync(join(tmpdir(), 'real-text-skill-'))
  try {
    writeFileSync(
      join(textDir, 'style-guide.md'),
      `---\nname: style-guide\ndescription: 写诗风格规则\n---\n${SKILL_BODY}`,
    )
    log(`Wrote style-guide.md into ${textDir}`)

    // 2. bootstrapExtensions — only textSkillsDir. No MCP, no module skills.
    const registry = new ToolRegistry()
    const ext = await bootstrapExtensions({ registry, textSkillsDir: textDir })
    log(`Bootstrapped: textSkills=${JSON.stringify(ext.textSkills)}`)
    log(`  registry.listSkills()=${JSON.stringify(registry.listSkills())}`)

    // 3. Real LLM adapter.
    // usageBox holds the last reported Usage; TS control-flow can't see the
    // onUsage closure mutation, so a mutable container avoids the `never`
    // narrowing on a plain `let`.
    const usageBox: { current: Usage | null } = { current: null }
    const streamChat = createRealLLMStreamChat({
      url: ARK_URL,
      apiKey: ARK_KEY,
      model: ARK_MODEL,
      onUsage: (u) => {
        usageBox.current = u
        log(`  [usage] prompt=${u.promptTokens} completion=${u.completionTokens} total=${u.totalTokens}`)
      },
    })

    // 4. Tight config so the loop can't run forever.
    const config = createConfig({
      maxSteps: 6,
      maxToolCalls: 12,
      maxElapsedMs: 3 * 60 * 1000,
    })

    // 5. Seed the conversation with the user request.
    const conversationMemory = new ConversationMemory()
    conversationMemory.append({
      id: `user-1-${Date.now()}`,
      role: 'user',
      content: '请按风格规则写一首四行短诗',
      at: Date.now(),
    })

    // 6. Assemble via createMinimalIM. skillRefs exposes `style-guide` to the
    //    LLM; systemPrompt forces the LLM to call it before writing.
    const WORKING_PROMPT = [
      '你是一个写诗助手。',
      '写诗前必须先调用 style-guide 工具获取风格规则，读完规则后再按规则写诗。',
      '调用 style-guide 时 reason 写"读取风格规则"。',
      '读完规则后，直接输出一首四行短诗作为最终回复，然后停止。',
      '不要调用其它工具。不要重复调用 style-guide。',
    ].join('\n')

    const loopOpts = createMinimalIM({
      config,
      registry,
      streamChat,
      url: ARK_URL,
      model: ARK_MODEL,
      systemPrompt: WORKING_PROMPT,
      userTemplate: '',
      skillRefs: ['style-guide'],
      stateLine: createNoopStateLine(),
      conversationMemory,
      workingAgentId: 'main',
    })

    // 7. Run the loop.
    log('\n--- Running working agent loop ---')
    const loopStart = Date.now()
    const result = await runIMLoop(loopOpts)
    const loopMs = Date.now() - loopStart
    log(`Loop finished in ${loopMs}ms — reason: ${result.reason} (turns: ${result.turns})`)
    if (result.hits.length > 0) {
      log(`  guard hits: ${result.hits.map(h => h.id).join(', ')}`)
    }

    // 8. Verification.
    log('\n=== Verification ===')

    // (a) A tool turn for style-guide exists whose content contains the rules.
    const turns = conversationMemory.turns()
    const skillToolTurns = turns.filter(
      t => t.role === 'tool' && typeof t.content === 'string' && (
        t.content.includes(RULE_LINE_1) || t.content.includes(RULE_LINE_2)
      ),
    )
    const injected = skillToolTurns.length > 0
    log(`(1) style-guide tool turn with body rules present: ${injected ? 'YES' : 'NO'}`)
    if (injected) {
      const c = skillToolTurns[0]!.content as string
      log(`    tool-turn content (first 200 chars): ${c.slice(0, 200)}`)
    } else {
      log(`    no tool turn carried the rules; all tool turns:`)
      for (const t of turns.filter(x => x.role === 'tool')) {
        log(`      - toolCallId=${t.toolCallId} content=${String(t.content).slice(0, 120)}`)
      }
    }

    // (b) Loop completed.
    const completed = result.reason === 'completed'
    log(`(2) loop completed: ${completed ? 'YES' : 'NO'} (reason=${result.reason})`)

    // (c) Final assistant output non-empty.
    const lastTurn = conversationMemory.last()
    const finalText = lastTurn?.role === 'assistant' ? (lastTurn.content ?? '') : ''
    const nonEmpty = finalText.trim().length > 0
    log(`(3) final assistant output non-empty: ${nonEmpty ? 'YES' : 'NO'}`)
    log(`    final output (first 300 chars): ${finalText.slice(0, 300)}`)

    // Summary.
    log('\n=== Summary ===')
    log(`(1) Injection (style-guide body entered context): ${injected ? 'PASS' : 'FAIL'}`)
    log(`(2) Loop completed:                                ${completed ? 'PASS' : 'FAIL'}`)
    log(`(3) Non-empty output:                              ${nonEmpty ? 'PASS' : 'FAIL'}`)
    if (usageBox.current) {
      const u = usageBox.current
      log(`Token usage: prompt=${u.promptTokens} completion=${u.completionTokens} total=${u.totalTokens}`)
    }
    const overall = injected && completed && nonEmpty
    log(`\nOverall: ${overall ? 'PASS — text skill 调用即注入 verified with real LLM' : 'PARTIAL — see failures above'}`)

    await ext.close()
    clearTimeout(overallTimer)
    process.exit(overall ? 0 : 1)
  } finally {
    rmSync(textDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('[real-llm-text-skill] FATAL:', err)
  clearTimeout(overallTimer)
  process.exit(1)
})
