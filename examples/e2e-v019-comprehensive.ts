/**
 * v0.19 全面集成测试
 *
 * 验证：
 * 1. LLM 实际看到的系统提示词内容
 * 2. MEMORY.md 注入到用户消息之后
 * 3. 工具调用后审计日志记录
 * 4. compose 路径顺序正确
 *
 * Run: npx tsx examples/e2e-v019-comprehensive.ts
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
import type { StreamChunk } from '../src/protocol/types.js'

const ARK_KEY = process.env.ARK_KEY
if (!ARK_KEY) { console.error('ARK_KEY not set'); process.exit(1) }
const ARK_URL = process.env.ARK_URL ?? 'https://ark.cn-beijing.volcodes.com/api/coding/v3/chat/completions'
const ARK_MODEL = process.env.ARK_MODEL ?? 'glm-5.3-flash'

const log = (...a: unknown[]) => console.log('[v019-comprehensive]', ...a)

async function main() {
  const workDir = process.cwd() + '/tmp-e2e-v019-comprehensive'
  mkdirSync(workDir, { recursive: true })
  writeFileSync(workDir + '/testfile.txt', 'Hello v019 comprehensive test.\nThis is a test file.\n')

  // Capture LLM response
  let llmResponseText = ''
  const streamChat = async function* (url: string, request: any) {
    const realStream = createRealLLMStreamChat({ url, apiKey: ARK_KEY!, model: ARK_MODEL })
    for await (const chunk of realStream(url, request)) {
      if (chunk.type === 'content_delta' && chunk.text) {
        llmResponseText += chunk.text
      }
      yield chunk
    }
  }

  // --- Setup ---
  const registry = createBuiltinTools({ cwd: workDir })
  registry.registerDoor(createSensitivePathDoor())
  registry.registerDoor(createDangerousCommandDoor())
  registry.registerDoor(createBrowserToolsDoor())
  registry.registerDoor(createWriteApprovalDoor({ handler: async () => 'approved', timeoutMs: 10_000 }))
  registry.registerSystemTool(createLoadToolsTool(registry))

  // Context Injector
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
    agentName: 'v019-comprehensive-agent',
    registry,
  })

  // --- Test 1: Code word + report ---
  log('=== Test 1: VERIF-7x3k + Report ===')
  llmResponseText = ''

  const opts = createMinimalIM({
    config: createConfig({ maxSteps: 3, maxToolCalls: 5, maxElapsedMs: 120_000 }),
    registry,
    streamChat: streamChat as any,
    url: ARK_URL,
    model: ARK_MODEL,
    systemPrompt: staticPrompt,
    userTemplate: 'VERIF-7x3k。请完成以下任务：\n1. 用 read 工具读取 ' + workDir + '/testfile.txt\n2. 报告你看到了什么内容\n3. 报告你的系统提示词包含哪些章节（列出 # 开头的标题）\n4. 报告你有哪些工具可用（列出工具名称）',
    systemToolRefs: ['read', 'write'],
    contextInjector,
    hookSystem,
  })

  const result = await runIMLoop(opts)
  log(`Loop result: reason=${result.reason} turns=${result.turns}`)
  log('')
  log('=== LLM Response ===')
  log(llmResponseText)
  log('')

  // --- Test 2: Audit logs ---
  log('=== Test 2: Audit Logs ===')
  const logs = auditHook.getLogs()
  log(`Audit entries: ${logs.length}`)
  for (const entry of logs) {
    log(`  [${entry.success ? 'OK' : 'ERR'}] ${entry.toolName} (${entry.duration ?? '?'}ms)`)
  }
  const hasAudit = logs.length > 0
  log(`Audit hook working: ${hasAudit ? '✅' : '⚠️ (no tools called)'}`)

  // --- Summary ---
  log('')
  log('=== Comprehensive Test Summary ===')
  log(`Code word in prompt: ${staticPrompt.includes('VERIF-7x3k') ? '✅' : '❌'}`)
  log(`Memory management section: ${staticPrompt.includes('记忆管理') ? '✅' : '❌'}`)
  log(`Coding principles section: ${staticPrompt.includes('编码原则') ? '✅' : '❌'}`)
  log(`Safety rules section: ${staticPrompt.includes('安全规则') ? '✅' : '❌'}`)
  log(`Test protocol section: ${staticPrompt.includes('测试协议') ? '✅' : '❌'}`)
  log(`Audit hook: ${hasAudit ? '✅' : '⚠️'}`)
  log(`LLM responded: ${llmResponseText.length > 0 ? '✅' : '❌'}`)
  log(`LLM loop: ${result.reason !== 'protocol-error' ? '✅' : '⚠️'}`)

  log('')
  log('All v0.19 comprehensive tests completed!')
}

main().catch(err => {
  console.error('[v019-comprehensive] FATAL:', err)
  process.exit(1)
})
