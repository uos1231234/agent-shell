/**
 * Real-LLM full-pipeline test with markdown task data.
 *
 * Verifies the complete read -> analyze -> write loop using the real ARK API:
 *   1. Creates a markdown file with structured task data
 *   2. Runs runIMLoop with the real LLM, asking it to read + summarize + write
 *   3. Verifies the output file was created with expected content
 *
 * Run: npx tsx examples/e2e-markdown-pipeline.ts
 */

import { createBuiltinTools } from '../src/im/tools/index.js'
import { createWriteApprovalDoor } from '../src/security/doors/write-approval.js'
import { createSensitivePathDoor } from '../src/security/doors/sensitive-path.js'
import { createDangerousCommandDoor } from '../src/security/doors/dangerous-command.js'
import { createBrowserToolsDoor } from '../src/security/doors/browser-tools.js'
import { createRealLLMStreamChat } from '../src/host/llm-adapter.js'
import { createMinimalIM } from '../src/im/minimal.js'
import { runIMLoop } from '../src/im/loop.js'
import { ConversationMemory } from '../src/im/conversation-memory.js'
import { createConfig } from '../src/shell/config.js'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'

const ARK_KEY = process.env.ARK_KEY
if (!ARK_KEY) { console.error('ARK_KEY not set'); process.exit(1) }
const ARK_URL = process.env.ARK_URL ?? 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions'
const ARK_MODEL = process.env.ARK_MODEL ?? 'glm-5.3-flash'

const TEST_DIR = process.cwd() + '/tmp-e2e-pipeline'
mkdirSync(TEST_DIR, { recursive: true })
const log = (...a: unknown[]) => console.log('[pipeline-e2e]', ...a)

// ---- 1. Create markdown task data -----------------------------------------
const MARKDOWN_INPUT = TEST_DIR + '/task-data.md'
const MARKDOWN_OUTPUT = TEST_DIR + '/task-summary.md'

const markdownContent = [
  '# Project Task Board - agent-shell v0.16.2',
  '',
  '## Current Iteration: Security Hardening + Engineering Search',
 '',
  '### Done',
  '| ID | Task | Status | Verify |',
  '|---|---|---|---|',
  '| T1 | search_replace write-path security | done | 17/17 bypass |',
  '| T2 | dangerous-command depth limit | done | 97 tests |',
  '| T3 | bash 600s cap + full-permission | done | 6 tests |',
  '| T4 | MultiDatabus subscriber leak fix | done | 12 tests |',
  '| T5 | H8 directory prefix grant | done | 16 tests |',
  '',
  '### In Progress',
  '| ID | Task | Owner | Note |',
  '|---|---|---|---|',
  '| T6 | Real API security e2e | agent | this test |',
  '| T7 | Markdown full-pipeline e2e | agent | this test |',
  '',
  '### Key Metrics',
  '- Test coverage: 1360 tests / 110 files',
  '- Security doors: 4 (sensitive-path, dangerous-command, write-approval, browser-tools)',
  '- Zero-trust review: 10 verification sub-agents',
  '',
  '### Risks & Open',
  '- H5: retry sleep counts toward time guard (semantic debate, currently counts)',
  '- H8: directory prefix matching landed, needs regression check',
  '',
  '## Summary',
  'v0.16.2 security hardening complete. Entering acceptance phase.',
].join('\n')

writeFileSync(MARKDOWN_INPUT, markdownContent, 'utf-8')
log('created markdown input: ' + MARKDOWN_INPUT)

// ---- 2. Build registry + run LLM -----------------------------------------
const registry = createBuiltinTools({ cwd: TEST_DIR })
registry.registerDoor(createSensitivePathDoor())
registry.registerDoor(createDangerousCommandDoor())
registry.registerDoor(createBrowserToolsDoor())
registry.registerDoor(createWriteApprovalDoor({
  handler: async () => 'approved',
  timeoutMs: 10_000,
}))

const conversationMemory = new ConversationMemory()
const streamChat = createRealLLMStreamChat({ url: ARK_URL, apiKey: ARK_KEY!, model: ARK_MODEL })

const prompt = [
  'Please do the following:',
  '1. Use the read tool to read the file ' + MARKDOWN_INPUT,
  '2. Analyze the content, extract the "In Progress" tasks and "Key Metrics"',
  '3. Use the write tool to write the analysis to ' + MARKDOWN_OUTPUT,
  '   Format as Markdown with: title, in-progress task table, key metrics list, and a short summary',
].join('\n')

const loopOpts = createMinimalIM({
  config: createConfig({ maxSteps: 6, maxToolCalls: 10, maxElapsedMs: 90_000 }),
  registry,
  streamChat,
  url: ARK_URL,
  model: ARK_MODEL,
  systemPrompt: 'You are a project assistant. Read the markdown file, analyze it, then write a summary to the output file. Execute directly without hesitation.',
  userTemplate: prompt,
  conversationMemory,
  workingAgentId: 'pipeline',
  systemToolRefs: ['read', 'write', 'bash'],
})

log('running real LLM pipeline...')
const result = await runIMLoop(loopOpts)

// ---- 3. Verify output -----------------------------------------------------
log('')
log('loop finished: reason=' + result.reason + ', turns=' + result.turns)

const toolCalls: string[] = []
for (const turn of conversationMemory.turns()) {
  if (turn.role === 'assistant' && turn.toolCalls) {
    for (const tc of turn.toolCalls) toolCalls.push(tc.function.name)
  }
}
log('tool calls: [' + toolCalls.join(', ') + ']')

let outputOk = false
let outputContent = ''
if (existsSync(MARKDOWN_OUTPUT)) {
  outputContent = readFileSync(MARKDOWN_OUTPUT, 'utf-8')
  const hasTitle = outputContent.includes('Summary') || outputContent.includes('Task')
  const hasMetrics = outputContent.includes('1360') || outputContent.includes('tests')
  outputOk = hasTitle && hasMetrics
  log('output file exists: ' + MARKDOWN_OUTPUT)
  log('output length: ' + outputContent.length + ' chars')
  log('has title: ' + hasTitle + ', has metrics: ' + hasMetrics)
} else {
  log('output file NOT created: ' + MARKDOWN_OUTPUT)
}

// ---- Report ---------------------------------------------------------------
console.log('\n' + '='.repeat(70))
console.log('MARKDOWN FULL-PIPELINE E2E REPORT')
console.log('='.repeat(70))
console.log('LLM: ' + ARK_MODEL)
console.log('reason: ' + result.reason)
console.log('turns: ' + result.turns)
console.log('tool calls: [' + toolCalls.join(', ') + ']')
console.log('output file created: ' + (existsSync(MARKDOWN_OUTPUT) ? 'YES' : 'NO'))
if (outputContent) {
  console.log('--- output preview ---')
  console.log(outputContent.slice(0, 400))
  console.log('--- end preview ---')
}
console.log('-'.repeat(70))

const pipelineOk = result.reason === 'completed' &&
  toolCalls.includes('read') &&
  toolCalls.includes('write') &&
  outputOk

console.log('RESULT: ' + (pipelineOk ? 'PASS' : 'FAIL') + ' - full pipeline ' + (pipelineOk ? 'working' : 'broken'))
if (!pipelineOk) process.exit(1)
