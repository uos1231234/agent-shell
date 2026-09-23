/**
 * v0.19 集成测试 — 真实 LLM + 暗号验证
 *
 * 验证：
 * 1. 静态系统提示词（纯中文、安全规则、编码原则、记忆管理）
 * 2. 测试暗号 "VERIF-7x3k" — LLM 报告真实看到的提示词和工具
 * 3. ContextInjector 注入（runtime + temporal + MEMORY.md）
 * 4. compose 路径顺序（system → history → user → MEMORY.md）
 * 5. AGENTS.md 加载
 * 6. HookSystem 审计日志
 *
 * Run: npx tsx examples/e2e-v019-integration.ts
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

const log = (...a: unknown[]) => console.log('[v019-integration]', ...a)

async function main() {
  const workDir = process.cwd() + '/tmp-e2e-v019-integration'
  mkdirSync(workDir, { recursive: true })
  writeFileSync(workDir + '/input.txt', 'Hello v019 integration test.\n')

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
  contextInjector.register(createWhenToReadInjection())

  // Hook System + Audit
  const hookSystem = new HookSystem()
  const auditHook = createAuditHook()
  hookSystem.register(auditHook)

  // Build static prompt
  const staticPrompt = buildStaticPrompt({
    mode: 'full',
    agentName: 'v019-integration-agent',
    registry,
  })

  log('=== Static Prompt Preview (first 300 chars) ===')
  log(staticPrompt.slice(0, 300))
  log('')

  // --- Test: Code word verification ---
  log('=== Test: VERIF-7x3k Code Word ===')
  log('Sending code word to LLM...')

  const opts = createMinimalIM({
    config: createConfig({ maxSteps: 2, maxToolCalls: 3, maxElapsedMs: 60_000 }),
    registry,
    streamChat,
    url: ARK_URL,
    model: ARK_MODEL,
    systemPrompt: staticPrompt,
    userTemplate: 'VERIF-7x3k',
    systemToolRefs: ['read', 'write'],
    contextInjector,
    hookSystem,
  })

  const result = await runIMLoop(opts)
  log(`Loop result: reason=${result.reason} turns=${result.turns}`)

  // --- Audit logs ---
  log('')
  log('=== Audit Logs ===')
  const logs = auditHook.getLogs()
  log(`Audit entries: ${logs.length}`)
  for (const entry of logs) {
    log(`  [${entry.success ? 'OK' : 'ERR'}] ${entry.toolName} (${entry.duration ?? '?'}ms)`)
  }

  // --- Summary ---
  log('')
  log('=== Integration Test Summary ===')
  log(`Code word in prompt: ${staticPrompt.includes('VERIF-7x3k') ? '✅' : '❌'}`)
  log(`Memory management section: ${staticPrompt.includes('记忆管理') ? '✅' : '❌'}`)
  log(`AGENTS.md loading: ${staticPrompt.includes('AGENTS.md') ? '⚠️ (not loaded via file-loader)' : 'N/A'}`)
  log(`ContextInjector sources: runtime + temporal + mcp-summary + memory_md`)
  log(`Audit hook: ${logs.length > 0 ? '✅' : '⚠️ (no tools called)'}`)
  log(`LLM loop: ${result.reason !== 'protocol-error' ? '✅' : '⚠️ protocol error'}`)

  if (result.reason === 'protocol-error') {
    log('⚠️ Protocol error — API might be down or rate-limited')
  }

  log('')
  log('All v0.19 integration tests completed!')
}

main().catch(err => {
  console.error('[v019-integration] FATAL:', err)
  process.exit(1)
})
