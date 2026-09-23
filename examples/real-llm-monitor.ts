// v0.11.2 Phase H: Real-LLM harness monitor.
//
// Boots a real working agent loop against the provided LLM endpoint, then
// prints a structured trace of what the harness actually does: every round's
// tokens, every tool call and its result, guard status, and the final
// termination reason. This is the "see how the harness runs with a real LLM"
// observation tool the user asked for.
//
// Usage:
//   ARK_API_KEY=ark-... npx tsx examples/real-llm-monitor.ts
//
// Or edit the constants below. The script is read-only against the
// filesystem — it only talks to the LLM endpoint and prints to stdout.

import { runIMLoop } from '../src/im/loop.js'
import { Databus } from '../src/im/databus.js'
import { ConversationMemory } from '../src/im/conversation-memory.js'
import { Mailbox } from '../src/im/mailbox/index.js'
import { ToolRegistry } from '../src/shell/registry.js'
import { createConfig } from '../src/shell/config.js'
import { createMetrics } from '../src/shell/metrics.js'
import { createNoopStateLine } from '../src/im/state-line/index.js'
import type { ToolContext } from '../src/shared/tool-context.js'
import type { SystemAgent } from '../src/im/system-agent.js'
import type { Usage, StreamChunk } from '../src/protocol/types.js'
import { createRealLLMStreamChat } from '../src/host/llm-adapter.js'

// --- Configuration (edit or use env vars) ---
const LLM_URL = process.env.ARK_URL
  ?? 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions'
// SECURITY: API key must come from environment — never hardcoded in source.
// Env contract (shared by all real-llm-* examples): ARK_KEY is the primary
// variable; ARK_API_KEY is accepted as a legacy alias.
const LLM_KEY: string = (() => {
  const key = process.env.ARK_KEY ?? process.env.ARK_API_KEY
  if (!key) {
    throw new Error('ARK_KEY environment variable is required. Set it before running this example.')
  }
  return key
})()
const LLM_MODEL = process.env.ARK_MODEL ?? 'glm-5.3-flash'

// --- A real tool the LLM can call ---
const registry = new ToolRegistry()
registry.registerSystemTool({
  name: 'calculate',
  description: 'Evaluate a simple arithmetic expression like "2+3*4". Only supports +, -, *, /, and integers.',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'The arithmetic expression to evaluate' },
      reason: { type: 'string', description: 'Why this tool is being called' },
    },
    required: ['expression', 'reason'],
  },
  execute: async (args: unknown) => {
    const { expression, reason } = args as { expression: string; reason: string }
    if (!reason || reason.length === 0) throw new Error('calculate requires a reason')
    // Safe-ish arithmetic: only digits, operators, parens, whitespace.
    if (!/^[\d+\-*/()\s]+$/.test(expression)) {
      throw new Error(`calculate: expression contains disallowed characters: ${expression}`)
    }
    const result = Function(`"use strict"; return (${expression})`)()
    return { expression, result: String(result) }
  },
})

const noopSystemAgent: SystemAgent = {
  run: async () => { throw new Error('system agents not configured in monitor') },
  stop() {},
  send() {},
}

// --- Usage tracker for the monitor ---
let cumulativeUsage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
let roundCount = 0

const realStreamChat = createRealLLMStreamChat({
  url: LLM_URL,
  apiKey: LLM_KEY,
  model: LLM_MODEL,
  onUsage: (u: Usage) => {
    cumulativeUsage = {
      promptTokens: cumulativeUsage.promptTokens + u.promptTokens,
      completionTokens: cumulativeUsage.completionTokens + u.completionTokens,
      totalTokens: cumulativeUsage.totalTokens + u.totalTokens,
    }
  },
})

// --- Monitor: intercept tool execution to log it ---
// We wrap the registry's execute to trace tool calls.
const originalGetSystemTool = registry.getSystemTool.bind(registry)
registry.getSystemTool = (name: string) => {
  const tool = originalGetSystemTool(name)
  if (!tool) return tool
  const originalExecute = tool.execute.bind(tool)
  tool.execute = async (args: unknown, ctx?: ToolContext) => {
    const agentId = (ctx as { agentId?: string })?.agentId ?? '?'
    const argsPreview = JSON.stringify(args).slice(0, 120)
    console.log(`  [tool] ${agentId} → ${name}(${argsPreview})`)
    const t0 = Date.now()
    try {
      const result = await originalExecute(args, ctx)
      const dt = Date.now() - t0
      const resultPreview = JSON.stringify(result).slice(0, 120)
      console.log(`  [tool] ${name} ← ${resultPreview} (${dt}ms)`)
      return result
    } catch (e) {
      const dt = Date.now() - t0
      console.log(`  [tool] ${name} ✗ ${(e as Error).message} (${dt}ms)`)
      throw e
    }
  }
  return tool
}

// --- Build the loop ---
const databus = new Databus()
const conversationMemory = new ConversationMemory()
const taskPrompt = 'What is 17 * 23 + 5? Use the calculate tool to get the exact answer, then tell me the result.'
conversationMemory.append({ id: 'user-1', role: 'user', content: taskPrompt, at: Date.now() })

console.log('=== Real-LLM Monitor ===')
console.log(`Endpoint: ${LLM_URL}`)
console.log(`Model:    ${LLM_MODEL}`)
console.log(`Task:     ${taskPrompt}`)
console.log(`Tools:    calculate`)
console.log('')

// --- Run with a tight config so we can observe the loop boundary ---
const config = createConfig({
  maxSteps: 10,        // 10 rounds max
  maxElapsedMs: 60_000, // 1 minute
  maxTokens: 100_000,
})

console.log('[loop] starting...')
const t0 = Date.now()
const result = await runIMLoop({
  config,
  registry,
  databus,
  conversationMemory,
  workingAgentId: 'main',
  mailbox: new Mailbox(),
  systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
  stateLine: createNoopStateLine(),
  initialMetrics: createMetrics(),
  streamChat: realStreamChat as ((url: string, request: { model: string; messages: unknown[]; tools?: unknown[]; [k: string]: unknown }) => AsyncIterable<StreamChunk>) as Parameters<typeof runIMLoop>[0]['streamChat'],
  url: LLM_URL,
  model: LLM_MODEL,
  systemPrompt: 'You are a helpful assistant. When asked to compute something, use the calculate tool. Always provide a reason when calling a tool.',
  userTemplate: '',
  systemToolRefs: ['calculate'],
  mcpRefs: [],
  skillRefs: [],
})
const elapsed = Date.now() - t0

// --- Report ---
console.log('')
console.log('=== Monitor Report ===')
console.log(`Terminated:   ${result.terminated}`)
console.log(`Reason:       ${result.reason}`)
console.log(`Rounds:       ${result.turns}`)
console.log(`Elapsed:      ${elapsed}ms`)
console.log(`Cumulative usage:`, cumulativeUsage)

const finalAssistant = [...conversationMemory.turns()].reverse().find(t => t.role === 'assistant')
console.log(`Final answer: ${finalAssistant?.content ?? '(none)'}`)

const toolTurns = databus.query({ sourceAgentIds: ['main'] }).filter(t => t.toolCallId)
console.log(`Tool turns:   ${toolTurns.length}`)
for (const t of toolTurns) {
  console.log(`  - ${t.toolCallId}: ${t.content.slice(0, 100)}`)
}

console.log('')
console.log('=== Monitor complete ===')
