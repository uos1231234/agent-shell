// v0.12.4: compress-zone propagation test — rewritten.
//
// Before v0.12.4 this file tested `metadata.zone → ToolContext.compressZone →
// record_curated_block layer`. That chain is gone: record_curated_block is
// retired. v0.42（用户拍板 2026-09-16）：压缩提交协议对齐参考实现
// curator-client.ts —— 压缩机调用 submit_curated_memory 工具提交 11 字段，
// 不再回复自由文本 JSON。
//
// This file verifies the new contract: the compressor agent with
// `submitToolName` captures the last submit_curated_memory `memory` argument
// into `result.submitted`, and system-agent ignores metadata.zone (it does not
// thread it anywhere — the zone is determined by the coordinator's
// dispatchCompression call, covered in drive-coordinator.test.ts).

import { describe, it, expect } from 'vitest'
import { createSystemAgent } from '../../src/im/system-agent.js'
import { ToolRegistry } from '../../src/shell/registry.js'
import { Mailbox } from '../../src/im/mailbox/index.js'
import { createStateLine } from '../../src/im/state-line/index.js'
import type { StateLine } from '../../src/im/state-line/types.js'
import { createConfig } from '../../src/shell/config.js'
import type { StreamChunk, ChatCompletionResponse, ToolCall } from '../../src/protocol/types.js'
import { createSubmitCuratedMemoryTool } from '../../src/im/tools/submit-curated-memory.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'

const makeTempStateLine = (): { sl: StateLine; dir: string } => {
  const dir = join(tmpdir(), `compress-zone-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return { sl: createStateLine({ databusPath: dir }), dir }
}

const scriptedStreamChat = (
  responses: ChatCompletionResponse[],
): ((url: string, request: { model: string; messages: unknown[]; tools?: unknown[] }) => AsyncIterable<StreamChunk>) => {
  let i = 0
  return async function* (_url, _request): AsyncIterable<StreamChunk> {
    const r = responses[i++]
    if (!r) return
    const msg = r.choices[0]?.message
    const tcs = Array.isArray((msg as { tool_calls?: ToolCall[] } | undefined)?.tool_calls)
      ? (msg as { tool_calls: ToolCall[] }).tool_calls
      : []
    for (const tc of tcs) {
      yield { type: 'tool_call_delta', index: 0, id: tc.id, name: tc.function.name }
      yield { type: 'tool_call_delta', index: 0, arguments_delta: tc.function.arguments }
    }
    if (typeof msg?.content === 'string' && msg.content.length > 0) {
      yield { type: 'content_delta', text: msg.content }
    }
    yield { type: 'finish', reason: r.choices[0]?.finish_reason ?? (tcs.length > 0 ? 'tool_calls' : 'stop') }
    if (r.usage) yield { type: 'usage', usage: r.usage }
    yield { type: 'done' }
  }
}

// A valid 11-field CuratedMemory block that the scripted LLM "submits" via the
// submit_curated_memory tool (v0.42 protocol).
const sampleBlock = {
  task_goal: 'compress task block (zone test)',
  causal_steps: [
    { intent: 'read user request', tool_action: 'parse', result: 'parsed' },
  ],
  evidence_fragments: [
    { source: 'corpus', fragment: 'sample fragment', relevance: 'load-bearing' },
  ],
  conclusion: 'block compressed',
  next_action: 'evict canonical range',
  working_state: {
    current_goal: 'drive compression',
    effective_decisions: ['mock persisted via appendBlock'],
    rejected_decisions: [],
    architecture_boundaries: ['state-line is append-only'],
    remaining_work: [],
  },
  status_hint: 'DONE',
}

describe('compress zone: v0.42 — compressor submits via submit_curated_memory, system-agent ignores metadata.zone', () => {
  it('captures the submit_curated_memory memory argument into result.submitted; no curated block is written by the agent', async () => {
    const { sl, dir } = makeTempStateLine()
    try {
      const registry = new ToolRegistry()
      registry.registerSystemTool(createSubmitCuratedMemoryTool())
      const mailbox = new Mailbox()
      const agentConfig = createConfig({ maxSteps: 5, maxToolCalls: 10, maxElapsedMs: 30_000 })

      // Round 1: assistant calls submit_curated_memory with the 11 fields.
      // Round 2: assistant closes with a one-line acknowledgement (loop ends).
      const responses: ChatCompletionResponse[] = [
        {
          id: 'r1', model: 'gpt-4',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call-1',
                type: 'function',
                function: {
                  name: 'submit_curated_memory',
                  arguments: JSON.stringify({ memory: sampleBlock, reason: 'compress this block' }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        },
        {
          id: 'r2', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
        },
      ]

      const compressor = createSystemAgent({
        name: 'compressor',
        systemPrompt: 'You are the compressor.',
        toolRefs: ['submit_curated_memory'],
        // 提交协议：捕获最后一次 submit_curated_memory 的 memory 参数。
        submitToolName: 'submit_curated_memory',
        llmStreamChat: scriptedStreamChat(responses),
        url: 'https://x',
        model: 'gpt-4',
        mailbox,
        registry,
        stateLine: sl,
        config: agentConfig,
      })

      const result = await compressor.run({
        messages: [{ role: 'user', content: 'compress this block' }],
        metadata: { kind: 'compress', zone: 'M2' },
      })

      // The submission payload was captured from the tool call arguments
      // (server-schema-constrained JSON object), not parsed from reply text.
      expect(result.submitted).toEqual(sampleBlock)

      // No curated block was written by the agent — it has no persistence tool.
      // The coordinator (not tested here) would validate + appendBlock with the
      // zone it chose.
      expect(sl.query({ layer: 'M1' })).toHaveLength(0)
      expect(sl.query({ layer: 'M2' })).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an invalid submission in-conversation: tool result reports missing fields, model resubmits, final capture wins', async () => {
    const { sl, dir } = makeTempStateLine()
    try {
      const registry = new ToolRegistry()
      registry.registerSystemTool(createSubmitCuratedMemoryTool())
      const mailbox = new Mailbox()
      const agentConfig = createConfig({ maxSteps: 5, maxToolCalls: 10, maxElapsedMs: 30_000 })

      // Round 1: submit a payload missing working_state → tool rejects with a
      // missing-fields message (not a throw). Round 2: the model fixes and
      // resubmits the complete block. Round 3: closes.
      const responses: ChatCompletionResponse[] = [
        {
          id: 'r1', model: 'gpt-4',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call-1',
                type: 'function',
                function: {
                  name: 'submit_curated_memory',
                  arguments: JSON.stringify({ memory: { task_goal: 'incomplete' }, reason: 'first try' }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        },
        {
          id: 'r2', model: 'gpt-4',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call-2',
                type: 'function',
                function: {
                  name: 'submit_curated_memory',
                  arguments: JSON.stringify({ memory: sampleBlock, reason: 'fixed' }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        },
        {
          id: 'r3', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
        },
      ]

      const compressor = createSystemAgent({
        name: 'compressor',
        systemPrompt: 'You are the compressor.',
        toolRefs: ['submit_curated_memory'],
        submitToolName: 'submit_curated_memory',
        llmStreamChat: scriptedStreamChat(responses),
        url: 'https://x',
        model: 'gpt-4',
        mailbox,
        registry,
        stateLine: sl,
        config: agentConfig,
      })

      const result = await compressor.run({
        messages: [{ role: 'user', content: 'compress this block' }],
        metadata: { kind: 'compress', zone: 'M2' },
      })

      // 对话内修复：最后一次（修复后的）提交生效。
      expect(result.submitted).toEqual(sampleBlock)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})