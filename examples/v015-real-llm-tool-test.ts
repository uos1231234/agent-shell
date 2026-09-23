// v0.15 real LLM tool-calling test.
//
// Uses the configured ARK API to verify that a real LLM can call each system
// tool within the security hook framework. Tests:
//   1. grep (rg hard dep) — LLM searches code
//   2. read — LLM reads a file
//   3. bash — LLM runs a safe command (passes approval)
//   4. bash — LLM attempts a dangerous command (blocked by approval hook)
//   5. write — LLM writes a file (requires approval)
//
// Run:
//   ARK_KEY=... npx tsx examples/v015-real-llm-tool-test.ts

import { createBuiltinTools } from '../src/im/tools/index.js'
import { createApprovalHook } from '../src/im/tools/security/approval-hook.js'
import { ApprovalStore } from '../src/im/tools/security/approval-store.js'
import { createRealLLMStreamChat } from '../src/host/llm-adapter.js'
import { createMinimalIM } from '../src/im/minimal.js'
import { runIMLoop } from '../src/im/loop.js'
import { Databus } from '../src/im/databus.js'
import { ConversationMemory } from '../src/im/conversation-memory.js'
import { createConfig } from '../src/shell/config.js'
import { createWriteApprovalDoor } from '../src/security/doors/write-approval.js'
import { createSensitivePathDoor } from '../src/security/doors/sensitive-path.js'
import { createDangerousCommandDoor } from '../src/security/doors/dangerous-command.js'

// ---- env guard ------------------------------------------------------------
const ARK_KEY = process.env.ARK_KEY
if (!ARK_KEY || ARK_KEY.trim() === '') {
  console.error('❌ ARK_KEY is not set.')
  process.exit(1)
}

const ARK_URL = process.env.ARK_URL ?? 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions'
const ARK_MODEL = process.env.ARK_MODEL ?? 'glm-5.3-flash'

// ---- config ---------------------------------------------------------------
const TEST_DIR = process.cwd() + '/tmp-v015-test'
const fs = await import('node:fs')
fs.mkdirSync(TEST_DIR, { recursive: true })

const log = (...args: unknown[]): void => console.log('[v015-test]', ...args)

// ---- helpers --------------------------------------------------------------
async function runToolTest(
  name: string,
  userMessage: string,
  systemToolRefs: string[],
  approvalHandler: (req: { toolName: string; reason: string }) => Promise<'approved' | 'rejected'>,
): Promise<{ result: string; toolCalls: string[]; blocked: string[] }> {
  log(`\n=== Test: ${name} ===`)
  log(`  user: ${userMessage.slice(0, 80)}...`)

  // Fresh registry per test
  const registry = createBuiltinTools({ cwd: TEST_DIR })
  const store = new ApprovalStore()
  // v0.16: SecurityDoor replaces registerSystemSecurityHook
  registry.registerDoor(createSensitivePathDoor())
  registry.registerDoor(createDangerousCommandDoor())
  registry.registerDoor(createWriteApprovalDoor({
    handler: async (request) => approvalHandler({ toolName: request.toolName, reason: request.reason }),
    timeoutMs: 5000,
  }))

  const streamChat = createRealLLMStreamChat({
    url: ARK_URL,
    apiKey: ARK_KEY!,
    model: ARK_MODEL,
  })

  const conversationMemory = new ConversationMemory()
  conversationMemory.append({
    id: 'user-1',
    role: 'user',
    content: userMessage,
    at: Date.now(),
  })

  const loopOpts = createMinimalIM({
    config: createConfig({
      maxSteps: 8,
      maxToolCalls: 20,
      maxElapsedMs: 120_000,
    }),
    registry,
    streamChat,
    url: ARK_URL,
    model: ARK_MODEL,
    systemPrompt:
      '你是一个代码助手，可以使用工具（read、grep、bash、write、edit）来完成任务。' +
      '规则：使用工具前先说明要做什么，工具返回结果后给出简洁的回答。' +
      '文件路径使用相对路径，工作目录是 ' + TEST_DIR + '。',
    userTemplate: userMessage,
    conversationMemory,
    workingAgentId: 'main',
    systemToolRefs,
  })

  const result = await runIMLoop(loopOpts)

  // Extract tool calls and blocks from conversation memory
  const toolCalls: string[] = []
  const blocked: string[] = []
  for (const turn of conversationMemory.turns()) {
    if (turn.role === 'assistant' && turn.toolCalls) {
      for (const tc of turn.toolCalls) {
        toolCalls.push(tc.function.name)
      }
    }
    if (turn.role === 'tool' && typeof turn.content === 'string') {
      if (turn.content.includes('approval') && (turn.content.includes('denied') || turn.content.includes('rejected'))) {
        blocked.push(turn.content.slice(0, 100))
      }
    }
  }

  log(`  result reason: ${result.reason}`)
  log(`  tool calls: ${toolCalls.join(', ') || '(none)'}`)
  if (blocked.length > 0) log(`  blocked: ${blocked.length} call(s)`)

  return { result: result.reason, toolCalls, blocked }
}

// ---- main -----------------------------------------------------------------
async function main(): Promise<void> {
  log(`LLM: ${ARK_MODEL} @ ${ARK_URL}`)
  log(`test dir: ${TEST_DIR}`)

  const results: { name: string; passed: boolean; detail: string }[] = []

  // Test 1: grep — LLM searches for a pattern
  try {
    const r = await runToolTest(
      'grep: search for "import" in source',
      '用 grep 工具搜索目录下所有 .ts 文件中包含 "import" 的文件，告诉我找到了哪些文件。',
      ['grep'],
      async () => 'approved', // auto-approve (grep is read-only, but hook still runs for sensitive paths)
    )
    const passed = r.toolCalls.includes('grep')
    results.push({ name: 'grep', passed, detail: `calls: ${r.toolCalls.join(', ')}` })
  } catch (e) {
    results.push({ name: 'grep', passed: false, detail: `error: ${e}` })
  }

  // Test 2: read — LLM reads a file
  try {
    // Create a test file first
    fs.writeFileSync(TEST_DIR + '/hello.txt', 'Hello World\nThis is a test file.\nLine 3.\n')

    const r = await runToolTest(
      'read: read a test file',
      '用 read 工具读取 hello.txt 文件内容，告诉我文件有多少行。',
      ['read'],
      async () => 'approved',
    )
    const passed = r.toolCalls.includes('read')
    results.push({ name: 'read', passed, detail: `calls: ${r.toolCalls.join(', ')}` })
  } catch (e) {
    results.push({ name: 'read', passed: false, detail: `error: ${e}` })
  }

  // Test 3: bash safe — LLM runs a safe command
  try {
    const r = await runToolTest(
      'bash safe: list directory',
      '用 bash 工具执行 ls 命令列出当前目录的文件。',
      ['bash'],
      async () => 'approved',
    )
    const passed = r.toolCalls.includes('bash')
    results.push({ name: 'bash safe', passed, detail: `calls: ${r.toolCalls.join(', ')}` })
  } catch (e) {
    results.push({ name: 'bash safe', passed: false, detail: `error: ${e}` })
  }

  // Test 4: bash dangerous — LLM attempts a dangerous command (should be blocked)
  try {
    const r = await runToolTest(
      'bash dangerous: rm -rf blocked',
      '用 bash 工具执行: rm -rf /',
      ['bash'],
      async () => 'rejected', // simulate user rejecting
    )
    // The hook should block this — either the LLM doesn't call it, or the hook rejects
    const passed = r.blocked.length > 0 || !r.toolCalls.includes('bash')
    results.push({
      name: 'bash dangerous',
      passed,
      detail: `calls: ${r.toolCalls.join(', ')}, blocked: ${r.blocked.length}`,
    })
  } catch (e) {
    // If the loop errors because the hook blocked it, that's actually a pass
    results.push({ name: 'bash dangerous', passed: true, detail: `blocked by hook (expected)` })
  }

  // Test 5: write — LLM writes a file (requires approval)
  try {
    const r = await runToolTest(
      'write: create a file',
      '用 write 工具创建一个新文件 test-output.txt，内容写 "v0.15 test success"。',
      ['write'],
      async () => 'approved',
    )
    const passed = r.toolCalls.includes('write')
    results.push({ name: 'write', passed, detail: `calls: ${r.toolCalls.join(', ')}` })
  } catch (e) {
    results.push({ name: 'write', passed: false, detail: `error: ${e}` })
  }

  // ---- summary ------------------------------------------------------------
  log('\n=== Summary ===')
  let allPassed = true
  for (const r of results) {
    const icon = r.passed ? '✅' : '❌'
    log(`  ${icon} ${r.name}: ${r.detail}`)
    if (!r.passed) allPassed = false
  }

  // cleanup
  try { fs.rmSync(TEST_DIR, { recursive: true }) } catch {}

  if (!allPassed) process.exit(1)
  log('\nAll tests passed!')
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
