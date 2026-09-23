// v0.14: maxSubAgentDepth is now configurable via ShellConfig / SubAgentConfig.config.
// Verifies:
//   1. validateShellConfigOverrides accepts maxSubAgentDepth ≤ DEFAULT (3).
//   2. validateShellConfigOverrides rejects maxSubAgentDepth > DEFAULT (3).
//   3. run_subagent depth check respects a custom (lower) maxSubAgentDepth
//      passed via RunSubagentDeps.defaultConfig.
//   4. run_subagent depth check respects a sub-agent's own config override.

import { describe, it, expect } from 'vitest'
import { createRunSubagentTool, type RunSubagentDeps } from '../../../src/im/tools/run-subagent.js'
import { SubAgentRegistry, generateInstanceId } from '../../../src/im/sub-agent/index.js'
import { validateSubAgentConfig } from '../../../src/im/sub-agent/config.js'
import { ToolRegistry } from '../../../src/shell/registry.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import { createNoopStateLine } from '../../../src/im/state-line/index.js'
import { DEFAULT_CONFIG, createConfig } from '../../../src/shell/config.js'
import type { ToolContext } from '../../../src/shared/tool-context.js'
import type { StreamChunk, ChatCompletionResponse } from '../../../src/protocol/types.js'

const makeRegistry = (): ToolRegistry => {
  const r = new ToolRegistry()
  r.registerSystemTool({
    name: 'echo',
    description: 'echo',
    parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
    execute: async (args) => (args as { x: string }).x,
  })
  return r
}

const noopStreamChat = (response: ChatCompletionResponse): RunSubagentDeps['llmStreamChat'] => {
  return async function* (): AsyncIterable<StreamChunk> {
    yield { type: 'content_delta', text: response.choices[0]?.message?.content ?? 'ok' }
    yield { type: 'finish', reason: 'stop' }
    yield { type: 'usage', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    yield { type: 'done' }
  } as unknown as RunSubagentDeps['llmStreamChat']
}

const finalResponse: ChatCompletionResponse = {
  id: 'r1', model: 'gpt-4',
  choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
}

describe('validateShellConfigOverrides: maxSubAgentDepth (v0.14)', () => {
  const registry = makeRegistry()

  it('accepts maxSubAgentDepth = 1 (lower than default 3)', () => {
    const cfg = validateSubAgentConfig(
      { name: 'shallow', systemPrompt: 's', toolRefs: ['echo'], config: { maxSubAgentDepth: 1 } },
      registry,
    )
    expect(cfg.config?.maxSubAgentDepth).toBe(1)
  })

  it('accepts maxSubAgentDepth = 3 (equal to default)', () => {
    const cfg = validateSubAgentConfig(
      { name: 'default', systemPrompt: 's', toolRefs: ['echo'], config: { maxSubAgentDepth: 3 } },
      registry,
    )
    expect(cfg.config?.maxSubAgentDepth).toBe(3)
  })

  it('rejects maxSubAgentDepth = 4 (exceeds default 3)', () => {
    expect(() =>
      validateSubAgentConfig(
        { name: 'too-deep', systemPrompt: 's', toolRefs: ['echo'], config: { maxSubAgentDepth: 4 } },
        registry,
      ),
    ).toThrow('cannot exceed default 3')
  })

  it('rejects maxSubAgentDepth = 0 (not a positive int)', () => {
    expect(() =>
      validateSubAgentConfig(
        { name: 'zero', systemPrompt: 's', toolRefs: ['echo'], config: { maxSubAgentDepth: 0 } },
        registry,
      ),
    ).toThrow('positive integer')
  })
})

describe('run_subagent depth check with custom maxSubAgentDepth (v0.14)', () => {
  const registry = makeRegistry()

  const makeDeps = (overrides?: Partial<RunSubagentDeps>): RunSubagentDeps => ({
    llmStreamChat: noopStreamChat(finalResponse),
    url: 'https://x',
    model: 'gpt-4',
    mailbox: new Mailbox(),
    registry,
    stateLine: createNoopStateLine(),
    ...overrides,
  })

  it('defaultConfig.maxSubAgentDepth = 1 blocks depth 1', async () => {
    const sub = new SubAgentRegistry()
    await sub.register({ name: 'worker', systemPrompt: 'do work', toolRefs: ['echo'] })
    const tool = createRunSubagentTool(sub, makeDeps({
      defaultConfig: createConfig({ maxSubAgentDepth: 1 }),
    }))
    const ctx: ToolContext = { subAgentDepth: 1, agentId: 'main' }
    await expect(
      tool.execute({ name: 'worker', input: 'hi', reason: 'test' }, ctx),
    ).rejects.toThrow('nesting limit (1)')
  })

  it('defaultConfig.maxSubAgentDepth = 1 still allows depth 0', async () => {
    const sub = new SubAgentRegistry()
    await sub.register({ name: 'worker', systemPrompt: 'do work', toolRefs: ['echo'] })
    const tool = createRunSubagentTool(sub, makeDeps({
      defaultConfig: createConfig({ maxSubAgentDepth: 1 }),
    }))
    const ctx: ToolContext = { subAgentDepth: 0, agentId: 'main' }
    const result = await tool.execute({ name: 'worker', input: 'hi', reason: 'test' }, ctx)
    expect(result).toBeDefined()
  })

  it('sub-agent config override maxSubAgentDepth = 2 takes precedence over defaultConfig', async () => {
    const sub = new SubAgentRegistry()
    await sub.register({
      name: 'limited',
      systemPrompt: 'do work',
      toolRefs: ['echo'],
      config: { maxSubAgentDepth: 2 },
    })
    // defaultConfig says 3, but the sub-agent's own config says 2.
    const tool = createRunSubagentTool(sub, makeDeps({
      defaultConfig: DEFAULT_CONFIG, // maxSubAgentDepth = 3
    }))
    // Depth 2 should be blocked because the sub-agent's own limit is 2.
    const ctx: ToolContext = { subAgentDepth: 2, agentId: 'main' }
    await expect(
      tool.execute({ name: 'limited', input: 'hi', reason: 'test' }, ctx),
    ).rejects.toThrow('nesting limit (2)')
  })

  it('sub-agent config override maxSubAgentDepth = 2 allows depth 1', async () => {
    const sub = new SubAgentRegistry()
    await sub.register({
      name: 'limited',
      systemPrompt: 'do work',
      toolRefs: ['echo'],
      config: { maxSubAgentDepth: 2 },
    })
    const tool = createRunSubagentTool(sub, makeDeps({
      defaultConfig: DEFAULT_CONFIG,
    }))
    // v0.39 特权不放大：嵌套调用者按生产现实建模（instanceId 形态的
    // agentId + 调用者模板覆盖目标 toolRefs）。
    await sub.register({
      name: 'runner',
      systemPrompt: 'runner',
      toolRefs: ['echo'],
    })
    // 调用者节点真实存在于树中（生产里 run 链路会先 registerChild）。
    // instanceId 用生产同款生成器（保证 `${templateName}-${uuid}` 格式）。
    const instanceId = generateInstanceId('runner', sub.agentTree.root)
    sub.agentTree.registerChild('main', instanceId)
    const ctx: ToolContext = { subAgentDepth: 1, agentId: instanceId }
    const result = await tool.execute({ name: 'limited', input: 'hi', reason: 'test' }, ctx)
    expect(result).toBeDefined()
  })

  it('no defaultConfig falls back to DEFAULT_CONFIG.maxSubAgentDepth = 3', async () => {
    // When deps.defaultConfig is omitted, the tool uses DEFAULT_CONFIG.
    const sub = new SubAgentRegistry()
    await sub.register({ name: 'worker', systemPrompt: 'do work', toolRefs: ['echo'] })
    const tool = createRunSubagentTool(sub, makeDeps())
    // Depth 3 should be blocked (default 3).
    const ctx: ToolContext = { subAgentDepth: 3, agentId: 'main' }
    await expect(
      tool.execute({ name: 'worker', input: 'hi', reason: 'test' }, ctx),
    ).rejects.toThrow('nesting limit (3)')
  })
})
