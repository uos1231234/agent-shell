// v0.11.1 P2.3: recursion depth limit for run_subagent.
//
// Verifies that run_subagent checks ctx.subAgentDepth and refuses to launch
// when the nesting limit is reached.

import { describe, it, expect, vi } from 'vitest'
import { createRunSubagentTool, type RunSubagentDeps } from '../../../src/im/tools/run-subagent.js'
import { SubAgentRegistry, generateInstanceId } from '../../../src/im/sub-agent/index.js'
import { validateSubAgentConfig } from '../../../src/im/sub-agent/config.js'
import { ToolRegistry } from '../../../src/shell/registry.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import { createNoopStateLine } from '../../../src/im/state-line/index.js'
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

const noopStreamChat = async function* (): AsyncIterable<StreamChunk> {
  yield { type: 'content_delta', text: 'ok' }
  yield { type: 'finish', reason: 'stop' }
  yield { type: 'usage', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
  yield { type: 'done' }
} as unknown as (url: string, req: unknown) => AsyncIterable<StreamChunk>

const makeDeps = (registry: ToolRegistry): RunSubagentDeps => ({
  llmStreamChat: noopStreamChat,
  url: 'https://x',
  model: 'gpt-4',
  mailbox: new Mailbox(),
  registry,
  stateLine: createNoopStateLine(),
})

describe('P2.3 run_subagent recursion depth limit', () => {
  it('allows depth 0 (working agent calling sub-agent)', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry()
    await sub.register(validateSubAgentConfig(
      { name: 'worker', systemPrompt: 'do work', toolRefs: ['echo'] }, registry))
    const tool = createRunSubagentTool(sub, makeDeps(registry))
    const ctx: ToolContext = { subAgentDepth: 0, agentId: 'main' }
    const result = await tool.execute(
      { name: 'worker', input: 'hello', reason: 'test' },
      ctx,
    )
    expect(result).toBeDefined()
  })

  it('allows depth 1 and depth 2 (nested sub-agents within limit)', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry()
    await sub.register(validateSubAgentConfig(
      { name: 'worker', systemPrompt: 'do work', toolRefs: ['echo'] }, registry))
    // v0.39 特权不放大：嵌套调用者按生产现实建模——agentId 是 instanceId
    // （`${templateName}-${uuid}`），且其模板 toolRefs 覆盖目标子代理的
    // toolRefs（echo ∈ caller.echo）。'main' + depth≥1 不是合法生产场景。
    await sub.register(validateSubAgentConfig(
      { name: 'runner', systemPrompt: 'runner', toolRefs: ['echo'] }, registry))
    const tool = createRunSubagentTool(sub, makeDeps(registry))
    for (const depth of [1, 2]) {
      // 调用者节点真实存在于树中（生产里 run 链路会先 registerChild）。
      // instanceId 用生产同款生成器（保证 `${templateName}-${uuid}` 格式，
      // caller-scope 反解才认）。
      const instanceId = generateInstanceId('runner', sub.agentTree.root)
      sub.agentTree.registerChild('main', instanceId)
      const ctx: ToolContext = { subAgentDepth: depth, agentId: instanceId }
      const result = await tool.execute(
        { name: 'worker', input: 'hello', reason: 'test' },
        ctx,
      )
      expect(result).toBeDefined()
    }
  })

  it('rejects depth 3 (at MAX_SUB_AGENT_DEPTH)', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry()
    await sub.register(validateSubAgentConfig(
      { name: 'worker', systemPrompt: 'do work', toolRefs: ['echo'] }, registry))
    const tool = createRunSubagentTool(sub, makeDeps(registry))
    const ctx: ToolContext = { subAgentDepth: 3, agentId: 'main' }
    await expect(
      tool.execute({ name: 'worker', input: 'hello', reason: 'test' }, ctx),
    ).rejects.toThrow('nesting limit')
  })

  it('rejects depth 4 and beyond', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry()
    await sub.register(validateSubAgentConfig(
      { name: 'worker', systemPrompt: 'do work', toolRefs: ['echo'] }, registry))
    const tool = createRunSubagentTool(sub, makeDeps(registry))
    for (const depth of [4, 5, 10]) {
      const ctx: ToolContext = { subAgentDepth: depth, agentId: 'main' }
      await expect(
        tool.execute({ name: 'worker', input: 'hello', reason: 'test' }, ctx),
      ).rejects.toThrow('nesting limit')
    }
  })

  it('defaults to depth 0 when ctx has no subAgentDepth', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry()
    await sub.register(validateSubAgentConfig(
      { name: 'worker', systemPrompt: 'do work', toolRefs: ['echo'] }, registry))
    const tool = createRunSubagentTool(sub, makeDeps(registry))
    // ctx without subAgentDepth should be treated as depth 0 — succeeds.
    // agentId 'main' resolves to the tree root (default AgentTree).
    const result = await tool.execute(
      { name: 'worker', input: 'hello', reason: 'test' },
      { agentId: 'main' },
    )
    expect(result).toBeDefined()
  })
})
