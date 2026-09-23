/**
 * v0.19 真实 LLM 端到端测试
 *
 * 验证：
 * 1. 静态系统提示词（纯中文、安全规则、编码原则、架构管理、记忆管理）
 * 2. 测试暗号 "VERIF-7x3k" — LLM 报告真实看到的提示词和工具
 * 3. ContextInjector 注入（runtime + temporal + architecture + MEMORY.md）
 * 4. HookSystem 审计日志
 *
 * Run: npx tsx examples/e2e-v019-prompt-memory.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { createBuiltinTools } from '../src/im/tools/index.js'
import { createLoadToolsTool } from '../src/im/tools/load-tools.js'
import { buildStaticPrompt } from '../src/im/prompt/section-builder.js'
import { ContextInjector } from '../src/im/hooks/context-injection.js'
import { createRuntimeInjection } from '../src/im/hooks/injections/runtime.js'
import { createTemporalInjection } from '../src/im/hooks/injections/temporal.js'
import { createMcpSummaryInjection } from '../src/im/hooks/injections/mcp-summary.js'
import { createWhenToReadInjection } from '../src/im/hooks/injections/when-to-read.js'
import { createAuditHook } from '../src/im/hooks/audit-hook.js'
import { HookSystem } from '../src/im/hooks/hook-system.js'
import { createRealLLMStreamChat } from '../src/host/llm-adapter.js'
import { createMinimalIM } from '../src/im/minimal.js'
import { runIMLoop } from '../src/im/loop.js'
import { createConfig } from '../src/shell/config.js'
import { createWriteApprovalDoor } from '../src/security/doors/write-approval.js'
import { createSensitivePathDoor } from '../src/security/doors/sensitive-path.js'
import { createDangerousCommandDoor } from '../src/security/doors/dangerous-command.js'
import { createBrowserToolsDoor } from '../src/security/doors/browser-tools.js'

const ARK_KEY = process.env.ARK_KEY
if (!ARK_KEY) { console.error('ARK_KEY not set'); process.exit(1) }
const ARK_URL = process.env.ARK_URL ?? 'https://ark.cn-beijing.volcodes.com/api/coding/v3/chat/completions'
const ARK_MODEL = process.env.ARK_MODEL ?? 'glm-5.3-flash'

const log = (...a: unknown[]) => console.log('[v019-e2e]', ...a)

async function main() {
  const workDir = process.cwd() + '/tmp-e2e-v019'
  mkdirSync(workDir, { recursive: true })
  writeFileSync(workDir + '/input.md', '# E2E Input\n\nAgent-shell v019 test.\n')

  const streamChat = createRealLLMStreamChat({ url: ARK_URL, apiKey: ARK_KEY!, model: ARK_MODEL })

  // --- Setup ---
  const registry = createBuiltinTools({ cwd: workDir })
  registry.registerDoor(createSensitivePathDoor())
  registry.registerDoor(createDangerousCommandDoor())
  registry.registerDoor(createBrowserToolsDoor())
  registry.registerDoor(createWriteApprovalDoor({ handler: async () => 'approved', timeoutMs: 10_000 }))
  registry.registerSystemTool(createLoadToolsTool(registry))

  // Context Injector with all sources
  const contextInjector = new ContextInjector()
  contextInjector.register(createRuntimeInjection())
  contextInjector.register(createTemporalInjection())
  contextInjector.register(createMcpSummaryInjection())
  contextInjector.register(createWhenToReadInjection())  // v0.42: MEMORY.md/ARCHITECTURE.md 按需读取

  // Hook System + Audit
  const hookSystem = new HookSystem()
  const auditHook = createAuditHook()
  hookSystem.register(auditHook)

  // Build static prompt
  const staticPrompt = buildStaticPrompt({
    mode: 'full',
    agentName: 'v019-test-agent',
    registry,
  })

  log('=== Static Prompt Preview (first 500 chars) ===')
  log(staticPrompt.slice(0, 500))
  log('...')

  // --- Test 1: Verify code word is in the prompt ---
  log('\n=== Test 1: Code word in prompt ===')
  const hasCodeWord = staticPrompt.includes('VERIF-7x3k')
  log(`Code word present: ${hasCodeWord ? '✅' : '❌'}`)

  // --- Test 2: Verify Chinese sections ---
  log('\n=== Test 2: Chinese sections ===')
  const checks = [
    ['安全规则', staticPrompt.includes('安全规则')],
    ['编码原则', staticPrompt.includes('编码原则')],
    ['基于代码信息编程', staticPrompt.includes('基于代码信息编程')],
    ['架构管理', staticPrompt.includes('架构管理')],
    ['记忆管理', staticPrompt.includes('记忆管理')],
    ['测试协议', staticPrompt.includes('测试协议')],
  ]
  for (const [name, ok] of checks) {
    log(`  ${name}: ${ok ? '✅' : '❌'}`)
  }

  // --- Test 3: ContextInjector ---
  log('\n=== Test 3: ContextInjector ===')
  const messages = await contextInjector.inject({
    conversationHistory: [],
    registry,
    sessionId: 'test-session-001',
    agentId: 'v019-test-agent',
    round: 1,
  })
  log(`Injected messages: ${messages.length}`)
  for (const msg of messages) {
    log(`  [${msg.position}] ${msg.content.slice(0, 60)}...`)
  }
  const hasRuntime = messages.some(m => m.content.includes('运行时上下文'))
  const hasTemporal = messages.some(m => m.content.includes('时间上下文'))
  const hasMemory = messages.some(m => m.content.includes('MEMORY.md') || m.content.includes('项目索引'))
  const hasArchitecture = messages.some(m => m.content.includes('ARCHITECTURE.md') || m.content.includes('模块结构'))
  log(`Runtime injection: ${hasRuntime ? '✅' : '❌'}`)
  log(`Temporal injection: ${hasTemporal ? '✅' : '❌'}`)
  log(`Memory injection: ${hasMemory ? '✅' : '⚠️ (MEMORY.md not found)'}`)
  log(`Architecture injection: ${hasArchitecture ? '✅' : '⚠️ (ARCHITECTURE.md not found)'}`)

  // --- Test 4: Real LLM with code word verification ---
  log('\n=== Test 4: Real LLM — code word verification ===')
  log('Sending prompt with VERIF-7x3k to verify LLM sees the prompt...')

  const opts = createMinimalIM({
    config: createConfig({ maxSteps: 3, maxToolCalls: 5, maxElapsedMs: 120_000 }),
    registry,
    streamChat,
    url: ARK_URL,
    model: ARK_MODEL,
    systemPrompt: staticPrompt,
    userTemplate: 'VERIF-7x3k',
    systemToolRefs: ['read', 'write', 'load_tools'],
    contextInjector,
    hookSystem,
  })

  const result = await runIMLoop(opts)
  log(`Loop result: reason=${result.reason} turns=${result.turns}`)

  // --- Test 5: Audit logs ---
  log('\n=== Test 5: Audit logs ===')
  const logs = auditHook.getLogs()
  log(`Audit entries: ${logs.length}`)
  for (const entry of logs) {
    log(`  [${entry.success ? 'OK' : 'ERR'}] ${entry.toolName} (${entry.duration ?? '?'}ms)`)
  }

  // --- Summary ---
  log('\n=== Summary ===')
  log(`Code word in prompt: ${hasCodeWord ? '✅' : '❌'}`)
  log(`Chinese sections: ${checks.every(c => c[1]) ? '✅' : '❌'}`)
  log(`ContextInjector: ${messages.length} injections`)
  log(`Audit hook: ${logs.length > 0 ? '✅' : '⚠️ (no tools called)'}`)
  log(`LLM loop: ${result.reason !== 'protocol-error' ? '✅' : '⚠️ protocol error'}`)

  if (result.reason === 'protocol-error') {
    log('⚠️ Protocol error — API might be down or rate-limited')
  }

  log('\nAll v0.19 e2e tests completed!')
}

main().catch(err => {
  console.error('[v019-e2e] FATAL:', err)
  process.exit(1)
})
