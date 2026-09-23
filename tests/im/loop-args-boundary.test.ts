// v0.24 改动②③ 的边界测试。改动③ 已于 v0.30（2026-09-09 用户拍板）撤销：
// args 随落盘全量保留（databus 消费方是 LLM 侧工具活动理解，args 是工具事件
// 语义核心；恢复后内存 Databus 与热路径行为一致），敏感内容取舍写入用户协议。
// 现契约：内存（canonical memory / databus）、gate 信号、persistTurn 落盘三处
// args 一致；估算口径（改动②）不变——args 仍不进 prompt 序列化。
//
// 改动②：estimateContextTokens 回退口径 = wire format（turnToMessage 投影），
// 排除 id/at/sourceAgentId/toolName/args 等不进 prompt 的字段。

import { describe, it, expect } from 'vitest'
import { runIMLoop, type IMLoopOptions } from '../../src/im/loop.js'
import { ToolRegistry } from '../../src/shell/registry.js'
import { createConfig } from '../../src/shell/config.js'
import { Databus, type ToolTurn } from '../../src/im/databus.js'
import { ConversationMemory } from '../../src/im/conversation-memory.js'
import { Mailbox } from '../../src/im/mailbox/index.js'
import { createNoopStateLine } from '../../src/im/state-line/index.js'
import { turnToMessage } from '../../src/im/turn.js'
import { estimateTokensDeepSeek } from '../../src/shared/token-estimate.js'
import type { SystemAgent } from '../../src/im/system-agent.js'
import type { ConversationTurn } from '../../src/im/conversation-memory.js'
import type { StreamChunk, ChatCompletionResponse } from '../../src/protocol/types.js'

const noopSystemAgent: SystemAgent = {
  run: async () => { throw new Error('noop') },
  stop() {},
  send() {},
}

const scriptedStreamChat = (responses: ChatCompletionResponse[]): IMLoopOptions['streamChat'] => {
  let i = 0
  return async function* (_url, _request): AsyncIterable<StreamChunk> {
    const r = responses[i++]
    if (!r) return
    const msg = r.choices[0]?.message
    if (typeof msg?.content === 'string' && msg.content.length > 0) {
      yield { type: 'content_delta', text: msg.content }
    }
    if (msg?.tool_calls) {
      for (let k = 0; k < msg.tool_calls.length; k += 1) {
        const tc = msg.tool_calls[k]!
        yield { type: 'tool_call_delta', index: k, id: tc.id, name: tc.function.name }
        yield { type: 'tool_call_delta', index: k, arguments_delta: tc.function.arguments }
      }
    }
    yield { type: 'finish', reason: r.choices[0]?.finish_reason ?? 'stop' }
    if (r.usage) yield { type: 'usage', usage: r.usage }
    yield { type: 'done' }
  }
}

const baseOptions = (overrides: Partial<IMLoopOptions> = {}): IMLoopOptions => {
  const registry = new ToolRegistry()
  registry.registerSystemTool({
    name: 'write', description: 'write',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path'] } as const,
    execute: async (args) => ({ wrote: (args as { path: string }).path }),
  })
  return {
    config: createConfig(),
    registry,
    databus: new Databus(),
    conversationMemory: new ConversationMemory(),
    workingAgentId: 'main',
    mailbox: new Mailbox(),
    systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
    stateLine: createNoopStateLine(),
    streamChat: scriptedStreamChat([]),
    url: 'https://x',
    model: 'gpt-4',
    systemPrompt: 'SYS',
    userTemplate: 'TEMPLATE',
    systemToolRefs: ['write'],
    mcpRefs: [],
    skillRefs: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 改动②：估算口径 = wire format
// ---------------------------------------------------------------------------

describe('estimateContextTokens 计数口径 = wire format（本地 DeepSeek 加权）', () => {
  it('含 args 的历史经估算后不含 args 值 / id / sourceAgentId 等非 wire 字段，含 content 与 function.arguments', async () => {
    // 触发口径已去上游化：estimateContextTokens 恒对实际上 wire 的 canonical 做
    // 本地 DeepSeek 加权计数（beforeShellCall 的 promptTokens 即该结果），不再读
    // provider usage，也无"回退"分支。
    const opts = baseOptions()
    const memory = opts.conversationMemory
    memory.append({ id: 'user-1', role: 'user', content: 'USER_QUESTION', at: 1 })
    memory.append({
      id: 'assistant-1', role: 'assistant', content: null, at: 2,
      toolCalls: [{
        id: 'tc-1', type: 'function' as const,
        function: { name: 'write', arguments: JSON.stringify({ path: 'a.txt', content: 'WIRE_ARGS_PAYLOAD' }) },
      }],
    })
    memory.append({
      id: 'tool-1', role: 'tool', toolCallId: 'tc-1', content: 'TOOL_RESULT_PAYLOAD',
      sourceAgentId: 'main', at: 3, toolName: 'write',
      args: { blob: 'X'.repeat(8000), secret: 'NON_WIRE_SECRET' },
    })

    // 期望值口径 = v0.27 后的第一轮估算：run 入口已把 userTemplate 落为
    // canonical u1（content 恒等于 userTemplate），估算与 compose 同口径去重
    // ——userTemplate 不再单独计入，u1 作为第 4 条 turn 计入。
    const turnsAtEstimate = [
      ...memory.turns(),
      { role: 'user', content: opts.userTemplate } as ConversationTurn,
    ]
    const wireText = opts.systemPrompt
      + turnsAtEstimate.map(t => JSON.stringify(turnToMessage(t))).join('')
    const legacyText = opts.systemPrompt + opts.userTemplate
      + memory.turns().map(t => JSON.stringify(t)).join('')

    const observed: number[] = []
    opts.hooks = {
      beforeShellCall: async (ctx) => { observed.push(ctx.promptTokens); return undefined },
    }
    opts.streamChat = scriptedStreamChat([
      { id: 'r1', model: 'gpt-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] },
    ])

    await runIMLoop(opts)

    // 前置条件：function.arguments 属于 wire format（计入），args 值与非 wire
    // 字段不属于（排除）——保证下面的数值断言方向正确。
    expect(wireText).toContain('WIRE_ARGS_PAYLOAD')
    expect(wireText).toContain('TOOL_RESULT_PAYLOAD')
    expect(wireText).not.toContain('NON_WIRE_SECRET')
    expect(wireText).not.toContain('user-1')
    expect(wireText).not.toContain('sourceAgentId')
    expect(wireText).not.toContain('toolName')
    expect(legacyText).toContain('NON_WIRE_SECRET')

    // 单轮 → 恰好一次估算，且精确等于 wire 口径（本地 DeepSeek 加权计数）。
    expect(observed).toHaveLength(1)
    expect(observed[0]).toBe(estimateTokensDeepSeek(wireText))
    // 旧口径（stringify 整个 turn，含 8000 字符 args blob）显著更大——证明
    // 非 wire 字段没有混进来。
    expect(observed[0]!).toBeLessThan(estimateTokensDeepSeek(legacyText))
  })
})

// ---------------------------------------------------------------------------
// 改动③（v0.30 撤销 v0.24 剥离）：persistTurn 落盘路径带 args
// ---------------------------------------------------------------------------

describe('persistTurn 落盘带 args（v0.30 撤销 v0.24 改动③）', () => {
  it('落盘收到的 tool turn args 与原参数一致，且与 canonical memory / databus 的同名 turn 相同', async () => {
    const persisted: ConversationTurn[] = []
    const opts = baseOptions({
      streamChat: scriptedStreamChat([
        { id: 'r1', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'tc-1', type: 'function' as const,
              function: { name: 'write', arguments: JSON.stringify({ path: 'a.txt', content: 'ARGS_IN_MEMORY' }) } }],
          }, finish_reason: 'tool_calls' }] },
        { id: 'r2', model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] },
      ]),
      persistTurn: async (t) => { persisted.push(t) },
    })

    await runIMLoop(opts)

    const persistedTool = persisted.filter((t): t is ToolTurn => t.role === 'tool')
    expect(persistedTool).toHaveLength(1)
    // v0.30: args 随落盘全量保留（与内存 canonical / databus 一致）。
    expect(persistedTool[0]!.args).toEqual({ path: 'a.txt', content: 'ARGS_IN_MEMORY' })
    expect(persistedTool[0]!.toolCallId).toBe('tc-1')

    const memoryTool = opts.conversationMemory.turns().filter((t): t is ToolTurn => t.role === 'tool')
    expect(memoryTool).toHaveLength(1)
    expect(memoryTool[0]!.args).toEqual({ path: 'a.txt', content: 'ARGS_IN_MEMORY' })

    const databusTool = opts.databus.turns().filter(t => t.toolCallId === 'tc-1')
    expect(databusTool).toHaveLength(1)
    expect(databusTool[0]!.args).toEqual({ path: 'a.txt', content: 'ARGS_IN_MEMORY' })
  })
})
