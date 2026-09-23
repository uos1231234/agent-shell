// v0.13 Batch 2: sub-agent policy now governs MCP/skill tool access (decision
// D7). The v0.12.2 blanket "system-tools-only" rejection is gone; permission
// is policy-driven, and config.ts only rejects refs that resolve to nothing.
//
// These tests cover:
//   - default policy allows MCP flat names + skill names
//   - custom deny policy rejects by pattern (error names the matched pattern)
//   - custom deny of a named skill rejects it
//   - unknown refs (resolving to nothing in all three registries) still throw
//   - system-agent routes MCP refs into mcpRefs and a scripted LLM call reaches
//     the fake MCP executor end-to-end

import { describe, it, expect } from 'vitest'
import { validateSubAgentConfig } from '../../../src/im/sub-agent/config.js'
import { ToolRegistry } from '../../../src/shell/registry.js'
import type { SubAgentToolPolicy } from '../../../src/im/sub-agent/policy.js'
import { createSystemAgent } from '../../../src/im/system-agent.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import { createNoopStateLine } from '../../../src/im/state-line/index.js'
import type { StreamChunk, ChatCompletionResponse, ToolCall } from '../../../src/protocol/types.js'

const params = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } as const

// Registry with a system tool, a fake MCP server, and a fake skill. The MCP
// and skill executors are spies so the integration test can observe calls.
const makeRegistry = (opts?: {
  mcpExecute?: (args: unknown) => Promise<unknown>
  skillExecute?: (args: unknown) => Promise<unknown>
}): { registry: ToolRegistry; mcpCalls: unknown[]; skillCalls: unknown[] } => {
  const mcpCalls: unknown[] = []
  const skillCalls: unknown[] = []
  const registry = new ToolRegistry()
  registry.registerSystemTool({
    name: 'echo',
    description: 'echo',
    parameters: params,
    execute: async (args) => ({ echo: (args as { x: string }).x }),
  })
  registry.registerMCP('safe', [
    {
      name: 'tool',
      description: 'a safe mcp tool',
      parameters: params,
      execute: async (args) => {
        mcpCalls.push(args)
        return opts?.mcpExecute ? opts.mcpExecute(args) : { ok: (args as { x: string }).x }
      },
    },
  ])
  registry.registerMCP('other', [
    {
      name: 'tool',
      description: 'another mcp tool',
      parameters: params,
      execute: async () => 'other',
    },
  ])
  registry.registerSkill({
    name: 'plan-skill',
    description: 'a skill',
    execute: async (args) => {
      skillCalls.push(args)
      return opts?.skillExecute ? opts.skillExecute(args) : { planned: true }
    },
  })
  return { registry, mcpCalls, skillCalls }
}

describe('v0.13 sub-agent policy: MCP/skill refs (default policy)', () => {
  it('accepts toolRefs containing MCP flat names and skill names', () => {
    const { registry } = makeRegistry()
    const cfg = validateSubAgentConfig(
      {
        name: 'bot',
        systemPrompt: 'x',
        toolRefs: ['echo', 'safe__tool', 'plan-skill'],
      },
      registry,
    )
    expect(cfg.toolRefs).toEqual(['echo', 'safe__tool', 'plan-skill'])
  })

  it('rejects an unknown ref that resolves to nothing in all three registries', () => {
    const { registry } = makeRegistry()
    expect(() =>
      validateSubAgentConfig(
        { name: 'bot', systemPrompt: 'x', toolRefs: ['echo', 'ghost__tool'] },
        registry,
      ),
    ).toThrow('Unknown toolRefs in sub-agent config: ghost__tool')
  })

  it('rejects an unknown skill name', () => {
    const { registry } = makeRegistry()
    expect(() =>
      validateSubAgentConfig(
        { name: 'bot', systemPrompt: 'x', toolRefs: ['no-such-skill'] },
        registry,
      ),
    ).toThrow('Unknown toolRefs in sub-agent config: no-such-skill')
  })
})

describe('v0.13 sub-agent policy: custom deny patterns', () => {
  // default deny, only allow 'safe__*' MCP namespace.
  const allowSafeOnly: SubAgentToolPolicy = {
    default: 'deny',
    rules: [{ mode: 'allow', pattern: 'safe__*' }],
  }

  it('allows a ref matching the allow pattern', () => {
    const { registry } = makeRegistry()
    const cfg = validateSubAgentConfig(
      { name: 'bot', systemPrompt: 'x', toolRefs: ['safe__tool'] },
      registry,
      { toolPolicy: allowSafeOnly },
    )
    expect(cfg.toolRefs).toEqual(['safe__tool'])
  })

  it('rejects a ref denied by default (no pattern match) and names the policy', () => {
    const { registry } = makeRegistry()
    expect(() =>
      validateSubAgentConfig(
        { name: 'bot', systemPrompt: 'x', toolRefs: ['other__tool'] },
        registry,
        { toolPolicy: allowSafeOnly },
      ),
    ).toThrow(/denied by default policy/)
  })

  it('rejects a named skill under a deny pattern and reports the matched pattern', () => {
    const denySkill: SubAgentToolPolicy = {
      default: 'allow',
      rules: [{ mode: 'deny', pattern: 'plan-skill' }],
    }
    const { registry } = makeRegistry()
    expect(() =>
      validateSubAgentConfig(
        { name: 'bot', systemPrompt: 'x', toolRefs: ['plan-skill'] },
        registry,
        { toolPolicy: denySkill },
      ),
    ).toThrow(/matched deny pattern: 'plan-skill'/)
  })

  it('rejects an MCP namespace via deny glob', () => {
    const denyOther: SubAgentToolPolicy = {
      default: 'allow',
      rules: [{ mode: 'deny', pattern: 'other__*' }],
    }
    const { registry } = makeRegistry()
    expect(() =>
      validateSubAgentConfig(
        { name: 'bot', systemPrompt: 'x', toolRefs: ['other__tool'] },
        registry,
        { toolPolicy: denyOther },
      ),
    ).toThrow(/matched deny pattern: 'other__\*'/)
  })
})

// --- system-agent routing integration ---
//
// Verify that createSystemAgent routes an MCP ref into mcpRefs (not the old
// hardcoded []) so a scripted LLM tool_call reaches the fake MCP executor.
// Uses the same scriptedStreamChat pattern as loop-run-subagent.test.ts.

const scriptedStreamChat = (responses: ChatCompletionResponse[]) => {
  let i = 0
  return async function* (_url: string, _request: unknown): AsyncIterable<StreamChunk> {
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

describe('v0.13 system-agent: routes MCP refs so a scripted LLM call reaches the MCP executor', () => {
  it('a sub-agent with an MCP toolRef invokes the fake MCP executor', async () => {
    const { registry, mcpCalls } = makeRegistry()
    const mailbox = new Mailbox()
    const stateLine = createNoopStateLine()

    // Scripted responses in call order:
    // 1. Sub-agent round 1: calls safe__tool(x="hi")
    // 2. Sub-agent round 2: final text "done" (no tool calls → completed)
    const responses: ChatCompletionResponse[] = [
      {
        id: 's1', model: 'gpt-4',
        choices: [{
          index: 0,
          message: {
            role: 'assistant', content: null,
            tool_calls: [{
              id: 'tc-1', type: 'function',
              function: { name: 'safe__tool', arguments: '{"x":"hi","reason":"call mcp"}' },
            } as ToolCall],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        id: 's2', model: 'gpt-4',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'done' },
          finish_reason: 'stop',
        }],
        usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
      },
    ]

    const agent = createSystemAgent({
      name: 'mcp-bot',
      systemPrompt: 'You call safe__tool.',
      toolRefs: ['safe__tool'],
      llmStreamChat: scriptedStreamChat(responses) as unknown as Parameters<typeof createSystemAgent>[0]['llmStreamChat'],
      url: 'https://x',
      model: 'gpt-4',
      mailbox,
      registry,
      stateLine,
    })

    const result = await agent.run({ messages: [{ role: 'user', content: 'go' }] })

    // The MCP executor was reached (proving mcpRefs was populated, not []).
    expect(mcpCalls).toHaveLength(1)
    expect(mcpCalls[0]).toEqual({ x: 'hi', reason: 'call mcp' })
    // Loop completed with the final assistant text.
    expect(result.reason).toBe('completed')
    expect(result.output).toBe('done')
  })

  it('a sub-agent with a skill toolRef invokes the fake skill executor', async () => {
    const { registry, skillCalls } = makeRegistry()
    const mailbox = new Mailbox()
    const stateLine = createNoopStateLine()

    const responses: ChatCompletionResponse[] = [
      {
        id: 's1', model: 'gpt-4',
        choices: [{
          index: 0,
          message: {
            role: 'assistant', content: null,
            tool_calls: [{
              id: 'tc-1', type: 'function',
              function: { name: 'plan-skill', arguments: '{"reason":"plan"}' },
            } as ToolCall],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        id: 's2', model: 'gpt-4',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'planned' },
          finish_reason: 'stop',
        }],
        usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
      },
    ]

    const agent = createSystemAgent({
      name: 'skill-bot',
      systemPrompt: 'You call plan-skill.',
      toolRefs: ['plan-skill'],
      llmStreamChat: scriptedStreamChat(responses) as unknown as Parameters<typeof createSystemAgent>[0]['llmStreamChat'],
      url: 'https://x',
      model: 'gpt-4',
      mailbox,
      registry,
      stateLine,
    })

    const result = await agent.run({ messages: [{ role: 'user', content: 'go' }] })

    expect(skillCalls).toHaveLength(1)
    expect(result.reason).toBe('completed')
    expect(result.output).toBe('planned')
  })
})
