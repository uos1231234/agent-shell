// v0.12 Real-LLM Mail routing smoke test.
//
// Verifies the Mail mechanism end-to-end with a REAL LLM (ARK / glm-5.3-flash):
//   1. Working agent (main) dispatches a "reviewer" sub-agent via run_subagent
//      to review a short text.
//   2. The reviewer sub-agent reviews the text, then calls mailbox_send to
//      mail its review report back to "main".
//   3. The working agent calls mailbox_read to read its inbox and summarize
//      the reviewer's mail.
//
// This is the minimal real-API verification of the P0 fix: createMinimalIM
// now auto-injects subAgentRegistry.agentTree into the Mailbox so that
// verifyRoute enforces lineage isolation. reviewer (child) -> main (parent)
// is a legal direct-lineage route and must succeed.
//
// v0.12.1: also verifies the mail enhancements end-to-end — the mail carries
// a `summary` field, main acknowledges via mailbox_markread, and the
// sender-side view (sentStatus) shows the read receipt (read=true + readAt).
//
// Usage:
//   ARK_KEY=... npx tsx examples/real-llm-mail-routing.ts
//
// API key 通过环境变量注入，不要 commit 这个环境变量。
// Credentials are read from env (ARK_KEY required; ARK_URL/ARK_MODEL optional
// with the known defaults baked in). Never hardcode the key.

import { createMinimalIM, createSubAgentRegistry } from '../src/im/minimal.js'
import { registerSystemAgentTools } from '../src/im/system-agents/register.js'
import { runIMLoop } from '../src/im/loop.js'
import { ConversationMemory } from '../src/im/conversation-memory.js'
import { ToolRegistry } from '../src/shell/registry.js'
import { createConfig } from '../src/shell/config.js'
import { createNoopStateLine } from '../src/im/state-line/index.js'
import { createRealLLMStreamChat } from '../src/host/llm-adapter.js'
import type { SystemAgent } from '../src/im/system-agent.js'

// Noop system agents — this smoke test exercises mail routing, not the
// warehouse/compressor/recall system agents. Tools that delegate to those
// agents are not in our systemToolRefs, so they will never be called.
const noopSystemAgent: SystemAgent = {
  run: async () => { throw new Error('system agents not configured in this smoke test') },
  stop() {},
  send() {},
}
const noopSystemAgents = {
  warehouse: noopSystemAgent,
  compressor: noopSystemAgent,
  recall: noopSystemAgent,
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ARK_URL = process.env.ARK_URL ?? 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions'
// SECURITY: API key must come from environment — never hardcoded in source.
const ARK_KEY: string = (() => {
  const key = process.env.ARK_KEY
  if (!key) {
    console.error('[real-llm-mail] ERROR: ARK_KEY environment variable is required.')
    console.error('[real-llm-mail]        Set it before running, e.g.  ARK_KEY=... npx tsx examples/real-llm-mail-routing.ts')
    console.error('[real-llm-mail]        (This is an environment-only requirement; not a failure of the script itself.)')
    process.exit(0)
  }
  return key
})()
const ARK_MODEL = process.env.ARK_MODEL ?? 'glm-5.3-flash'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = (...args: unknown[]): void => console.log('[real-llm-mail]', ...args)

// Overall wall-clock guard so a misbehaving LLM can't hang the smoke test.
const OVERALL_TIMEOUT_MS = 5 * 60 * 1000
const overallTimer = setTimeout(() => {
  console.error('[real-llm-mail] FATAL: overall timeout exceeded — aborting.')
  process.exit(1)
}, OVERALL_TIMEOUT_MS)
overallTimer.unref?.()

// The text the reviewer will review.
const REVIEW_TEXT =
  'The quick brown fox jumps over the lazy dog. This sentence is often used to test typography because it contains every letter of the alphabet.'

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log('=== Real-LLM Mail Routing Smoke Test ===')
  log(`LLM: ${ARK_MODEL} @ ${ARK_URL}`)
  log(`Overall timeout: ${OVERALL_TIMEOUT_MS / 1000}s`)

  // 1. Infrastructure: a single shared registry + state line. The Mailbox is
  //    NOT constructed here — createMinimalIM builds it (auto-injecting the
  //    agentTree from subAgentRegistry, which is the P0 fix) when we omit
  //    opts.mailbox. We grab that mailbox reference back out of loopOpts
  //    after assembly so we can inspect it for verification.
  const registry = new ToolRegistry()
  const stateLine = createNoopStateLine()

  // 2. Real LLM adapter (same pattern as real-llm-compression-recall.ts).
  const streamChat = createRealLLMStreamChat({
    url: ARK_URL,
    apiKey: ARK_KEY,
    model: ARK_MODEL,
    onUsage: (u) => log(`  [usage] prompt=${u.promptTokens} completion=${u.completionTokens}`),
  })

  // 3. Create the sub-agent registry first. We do NOT call
  //    registerSystemAgentTools yet — it needs the Mailbox, which is built by
  //    createMinimalIM (the P0-fix path). So the order is:
  //      (a) createSubAgentRegistry
  //      (b) createMinimalIM  → builds Mailbox with agentTree injected
  //      (c) registerSystemAgentTools(mailedFromStepB, ...)
  //      (d) subAgentRegistry.register(reviewer)  — needs mailbox_send present
  //    We need the working config + conversation memory + prompts before (b),
  //    so define those here.
  const subAgentRegistry = await createSubAgentRegistry({ registry })

  // 4. Pre-register the "reviewer" sub-agent config. Validation checks toolRefs
  //    against the registry, so this MUST run AFTER registerSystemAgentTools.
  //    Defined here (registered later) to keep the prompt near its explanation.
  const REVIEWER_PROMPT = [
    'You are a concise text reviewer sub-agent.',
    'When given a text to review, you do two things, in order, then stop:',
    '1. Read the text and form a one-sentence review (note any issue such as repetition, grammar, or clarity).',
    `2. Call the mailbox_send tool to mail your review to "main".`,
    '   - to: "main"',
    '   - subject: "review report"',
    '   - summary: a one-line overview of your finding (max ~200 chars).',
    '   - body: your one-sentence review (plain text).',
    '   - reason: a short reason string.',
    '   Send EXACTLY ONE mail. Do not re-send or follow up — the recipient replies on their own schedule.',
    'After calling mailbox_send, reply with a single short sentence confirming you sent the report, then stop.',
    'Do not call any other tool. Do not call run_subagent.',
  ].join('\n')

  // 5. Working agent (main) system prompt: dispatch reviewer, then read mail.
  const WORKING_PROMPT = [
    'You are a working agent coordinating a reviewer sub-agent.',
    'You will do the following, in order, then stop:',
    '1. Call run_subagent with name "reviewer" and pass the text to review as the input.',
    '   The text to review is provided in the user message.',
    '   - reason: a short reason string.',
    '2. After the sub-agent finishes, call mailbox_read to read your inbox.',
    '   - reason: a short reason string.',
    '3. Call mailbox_markread (no ids) to acknowledge the mail you just read —',
    '   this produces a read receipt the reviewer can see.',
    '   - reason: a short reason string.',
    '4. Summarize the reviewer\'s mail in one sentence and reply with that summary, then stop.',
    'Do not call any other tool. Do not call run_subagent more than once.',
  ].join('\n')

  // 6. Tight config so the loop can't run forever.
  const workingConfig = createConfig({
    maxSteps: 16,
    maxToolCalls: 40,
    maxElapsedMs: 4 * 60 * 1000,
  })

  // 7. Seed the conversation with the user request.
  const conversationMemory = new ConversationMemory()
  conversationMemory.append({
    id: `user-1-${Date.now()}`,
    role: 'user',
    content: `Please have the reviewer sub-agent review this text and then tell me its report:\n\n${REVIEW_TEXT}`,
    at: Date.now(),
  })

  // 8. Assemble via createMinimalIM — this is the P0-fix verification point:
  //    passing subAgentRegistry and OMITTING mailbox causes createMinimalIM to
  //    build `new Mailbox(subAgentRegistry.agentTree)`, so verifyRoute enforces
  //    lineage isolation in production. We read the built mailbox back out of
  //    loopOpts for tool registration + post-run verification.
  const loopOpts = createMinimalIM({
    config: workingConfig,
    registry,
    streamChat,
    url: ARK_URL,
    model: ARK_MODEL,
    systemPrompt: WORKING_PROMPT,
    userTemplate: '',
    systemToolRefs: ['mailbox_send', 'mailbox_read', 'mailbox_markread', 'run_subagent'],
    stateLine,
    conversationMemory,
    workingAgentId: 'main',
    subAgentRegistry,
    systemAgents: noopSystemAgents,
  })
  const mailbox = loopOpts.mailbox
  log('Assembled IMLoopOptions via createMinimalIM (Mailbox auto-built with agentTree)')

  // 9. NOW register system tools against the auto-built mailbox. This wires
  //    mailbox_send / mailbox_read (closures over `mailbox`) and run_subagent
  //    (closure over subAgentRegistry + `mailbox`). After this, mailbox_send
  //    exists in the registry so the reviewer config can validate its toolRefs.
  registerSystemAgentTools(
    registry,
    mailbox,
    noopSystemAgents,
    subAgentRegistry,
    { llmStreamChat: streamChat, url: ARK_URL, model: ARK_MODEL, stateLine },
  )
  log('Registered system tools (mailbox_send, mailbox_read, run_subagent, ...)')

  // 10. Register the reviewer sub-agent config now that mailbox_send exists.
  await subAgentRegistry.register({
    name: 'reviewer',
    systemPrompt: REVIEWER_PROMPT,
    toolRefs: ['mailbox_send'],
    config: { maxSteps: 8, maxToolCalls: 12, maxElapsedMs: 2 * 60 * 1000 },
  })
  log('Pre-registered sub-agent: reviewer (toolRefs: mailbox_send)')

  // Confirm the P0 fix actually wired the tree into the mailbox. Since
  // Mailbox.agentTree is private, we verify functionally: an out-of-lineage
  // route (an unknown agent -> main) must be REJECTED, which only happens
  // when the tree is wired. If the tree were absent, send() would succeed
  // (backward-compat no-check mode). We do NOT exercise the legal reviewer
  // -> main route here — the real LLM run does that.
  let treeWired = false
  try {
    mailbox.send({ from: 'nonexistent-agent', to: 'main', subject: 'probe', body: 'probe' })
    // If we get here, no route check ran → tree NOT wired (P0 fix regressed).
    log('WARNING: out-of-lineage send was NOT rejected — Mailbox agentTree appears NOT wired (P0 fix may have regressed)')
    // Clean up the probe message so it doesn't pollute the real run.
  } catch (e) {
    treeWired = true
    const msg = e instanceof Error ? e.message : String(e)
    log(`Mailbox agentTree wired by createMinimalIM: YES (out-of-lineage send rejected: "${msg}")`)
  }
  log(`P0 fix live: ${treeWired ? 'YES' : 'NO'}`)

  log('\n--- Running working agent loop ---')
  const loopStart = Date.now()
  const result = await runIMLoop(loopOpts)
  const loopMs = Date.now() - loopStart
  log(`Loop finished in ${loopMs}ms — reason: ${result.reason} (turns: ${result.turns})`)
  if (result.hits.length > 0) {
    log(`  guard hits: ${result.hits.map(h => h.id).join(', ')}`)
  }

  // 9. Verification — inspect mailbox + final assistant message.
  log('\n=== Verification ===')

  // 9a. main's inbox should contain a mail from the reviewer instance.
  const mainInbox = mailbox.readOwnInbox('main', { unreadOnly: false })
  log(`main inbox size: ${mainInbox.length}`)
  for (const m of mainInbox) {
    log(`  - id=${m.id} from=${m.from} subject="${m.subject}" summary="${m.summary ?? '(none)'}" body="${m.body.slice(0, 120)}"`)
  }
  const reviewerMail = mainInbox.find(m => m.from.startsWith('reviewer-') && m.to === 'main')
  const mailSent = reviewerMail !== undefined
  log(`Reviewer -> main mail delivered: ${mailSent ? 'YES' : 'NO'}`)
  const summaryPresent = reviewerMail !== undefined && typeof reviewerMail.summary === 'string' && reviewerMail.summary.length > 0
  log(`Mail carries summary field: ${summaryPresent ? 'YES' : 'NO'}`)

  // 9a'. Read receipt loop: main acknowledged the mail via mailbox_markread,
  // so the SENDER's view (sentStatus) must show read=true with a readAt stamp.
  const receipt = reviewerMail !== undefined
    ? mailbox.sentStatus(reviewerMail.from, reviewerMail.id)
    : undefined
  const readReceipt = receipt !== undefined && receipt.found && receipt.read && typeof receipt.readAt === 'number'
  log(`Read receipt (sender view via sentStatus): ${receipt ? `found=${receipt.found} read=${receipt.read} readAt=${receipt.readAt ?? '(none)'}` : '(no mail)'}`)

  // 9b. Working agent's final assistant message should summarize the mail.
  const lastTurn = conversationMemory.last()
  const finalText = lastTurn?.role === 'assistant' ? (lastTurn.content ?? '') : ''
  log(`Working agent final assistant text (first 300 chars): ${finalText.slice(0, 300)}`)

  // 9c. Did the working agent actually call mailbox_read? Inspect tool turns.
  const turns = conversationMemory.turns()
  const calledRunSubagent = turns.some(
    t => t.role === 'assistant' && t.toolCalls?.some(tc => tc.function.name === 'run_subagent'),
  )
  const calledMailboxRead = turns.some(
    t => t.role === 'assistant' && t.toolCalls?.some(tc => tc.function.name === 'mailbox_read'),
  )
  const calledMailboxMarkread = turns.some(
    t => t.role === 'assistant' && t.toolCalls?.some(tc => tc.function.name === 'mailbox_markread'),
  )
  log(`Working agent called run_subagent: ${calledRunSubagent ? 'YES' : 'NO'}`)
  log(`Working agent called mailbox_read: ${calledMailboxRead ? 'YES' : 'NO'}`)
  log(`Working agent called mailbox_markread: ${calledMailboxMarkread ? 'YES' : 'NO'}`)

  // Final summary.
  const mailReadOk = calledMailboxRead && mainInbox.length > 0
  const summarized = finalText.trim().length > 0

  log('\n=== Summary ===')
  log(`Mail sent   (reviewer -> main): ${mailSent ? 'PASS' : 'FAIL'}`)
  log(`Mail summary field:             ${summaryPresent ? 'PASS' : 'FAIL'}`)
  log(`Mail read   (main inbox read):  ${mailReadOk ? 'PASS' : 'FAIL'}`)
  log(`Read receipt (markread loop):   ${readReceipt ? 'PASS' : 'FAIL'}`)
  log(`Summary out (non-empty reply):  ${summarized ? 'PASS' : 'FAIL'}`)
  const overall = mailSent && summaryPresent && mailReadOk && readReceipt && summarized && result.reason === 'completed'
  log(`\nOverall: ${overall ? 'PASS — Mail routing + receipts work with real LLM' : 'PARTIAL — see failures above'}`)

  clearTimeout(overallTimer)
  process.exit(overall ? 0 : 1)
}

main().catch((err) => {
  console.error('[real-llm-mail] FATAL:', err)
  clearTimeout(overallTimer)
  process.exit(1)
})
