import { describe, it, expect, vi } from 'vitest'
import { createRunSubagentTool } from '../../../src/im/tools/run-subagent.js'
import { createDatabusQueryTool } from '../../../src/im/tools/databus-query.js'
import { SubAgentRegistry, PERMISSIVE_SUB_AGENT_POLICY } from '../../../src/im/sub-agent/index.js'
import { ToolRegistry } from '../../../src/shell/registry.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import { Databus } from '../../../src/im/databus.js'
import type { ChatCompletionResponse, StreamChunk } from '../../../src/protocol/types.js'
import type { StateLine } from '../../../src/im/state-line/types.js'

// v0.12: run_subagent now derives bus wiring from the AgentTree. Each call
// mints a unique instance id (`<templateName>-<uuid>`) which becomes the
// sub-agent's sourceAgentId. The child's ownDatabus is the parent node's
// familyDatabus (siblings share it). The tree root is created by default in
// SubAgentRegistry with id 'main'. Tool execute calls below pass
// `{ agentId: 'main' }` so the tree resolves the working agent as the parent.

const noopStateLine: StateLine = {
  compressor: { async appendBlock() {} },
  warehouse: {
    async appendSummary() {},
    async queryM3() { return { ok: false, error: 'noop' } },
  },
  rawArchive: {
    async append() {},
    async query() { return [] },
  },
  query: () => [],
  subscribe: () => () => {},
  close() {},
}

const scriptedStreamChat = (
  responses: ChatCompletionResponse[],
): Parameters<typeof createRunSubagentTool>[1]['llmStreamChat'] => {
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

const makeRegistry = (): ToolRegistry => {
  const r = new ToolRegistry()
  r.registerSystemTool({
    name: 'echo',
    description: 'echo',
    parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
    execute: async (args) => ({ echo: (args as { x: string }).x }),
  })
  return r
}

describe('im/tools/run-subagent', () => {
  it('runs a defined sub-agent and returns its output', async () => {
    const registry = makeRegistry()
    const mailbox = new Mailbox()
    const sub = new SubAgentRegistry()
    await sub.register({
      name: 'reviewer',
      systemPrompt: 'You are a reviewer.',
      toolRefs: ['echo'],
    })

    const finalResponse: ChatCompletionResponse = {
      id: 'r1', model: 'gpt-4',
      choices: [{ index: 0, message: { role: 'assistant', content: 'review complete' }, finish_reason: 'stop' }],
    }

    const tool = createRunSubagentTool(sub, {
      llmStreamChat: scriptedStreamChat([finalResponse]),
      url: 'https://x',
      model: 'gpt-4',
      mailbox,
      registry,
      stateLine: noopStateLine,
    })

    const result = await tool.execute(
      { name: 'reviewer', input: 'check this', reason: 'run reviewer' },
      { agentId: 'main' },
    )
    expect(result).toMatchObject({ output: 'review complete', status: 'completed' })
  })

  it('throws when sub-agent is not defined', async () => {
    const registry = makeRegistry()
    const mailbox = new Mailbox()
    const sub = new SubAgentRegistry()
    const tool = createRunSubagentTool(sub, {
      llmStreamChat: scriptedStreamChat([]),
      url: 'https://x',
      model: 'gpt-4',
      mailbox,
      registry,
      stateLine: noopStateLine,
    })
    await expect(
      tool.execute(
        { name: 'missing', input: 'x', reason: 'run missing' },
        { agentId: 'main' },
      ),
    ).rejects.toThrow('Sub-agent "missing" is not defined')
  })

  it('prefixes the workspace declaration when deps.workDir is set', async () => {
    const registry = makeRegistry()
    const mailbox = new Mailbox()
    const sub = new SubAgentRegistry()
    await sub.register({
      name: 'reviewer',
      systemPrompt: 'You are a reviewer.',
      toolRefs: ['echo'],
    })

    // 捕获子代理发出的 LLM 请求，检查 system 消息内容。
    const seenSystem: string[] = []
    const captureStreamChat = async function* (
      _url: string,
      request: { model: string; messages: Array<{ role: string; content: unknown }> },
    ): AsyncIterable<StreamChunk> {
      const sys = request.messages.find((m) => m.role === 'system')
      if (sys) seenSystem.push(String(sys.content))
      yield { type: 'finish', reason: 'stop' }
      yield { type: 'done' }
    }

    const tool = createRunSubagentTool(sub, {
      llmStreamChat: captureStreamChat,
      url: 'https://x',
      model: 'gpt-4',
      mailbox,
      registry,
      stateLine: noopStateLine,
      workDir: '/workspace/proj',
    })

    await tool.execute(
      { name: 'reviewer', input: 'check this', reason: 'run reviewer' },
      { agentId: 'main' },
    )

    expect(seenSystem.length).toBeGreaterThan(0)
    const prompt = seenSystem[0]!
    // ⚠️ UPDATED: Chinese→English for benchmark testing (see 测试阅读.md)
    // 工作区声明已替换占位符（单一事实源 WORK_DIR_RULE）
    expect(prompt).toContain('Working directory: /workspace/proj')
    expect(prompt).not.toContain('{work_dir}')
    // 用户角色定义保留
    expect(prompt).toContain('You are a reviewer.')
    // v0.38: 角色置顶（身份先锚定），工作区声明与纪律基底在其后。
    expect(prompt.indexOf('You are a reviewer.')).toBeLessThan(prompt.indexOf('Working directory'))
    // 纪律基底已接入（此前 MINIMAL_PROMPT_TEMPLATE 是孤儿常量，从未参与子代理组装）。
    expect(prompt).toContain('# Reporting Back')
  })

  it('does NOT prefix workspace declaration when deps.workDir is absent', async () => {
    const registry = makeRegistry()
    const mailbox = new Mailbox()
    const sub = new SubAgentRegistry()
    await sub.register({
      name: 'reviewer',
      systemPrompt: 'You are a reviewer.',
      toolRefs: ['echo'],
    })

    const seenSystem: string[] = []
    const captureStreamChat = async function* (
      _url: string,
      request: { model: string; messages: Array<{ role: string; content: unknown }> },
    ): AsyncIterable<StreamChunk> {
      const sys = request.messages.find((m) => m.role === 'system')
      if (sys) seenSystem.push(String(sys.content))
      yield { type: 'finish', reason: 'stop' }
      yield { type: 'done' }
    }

    const tool = createRunSubagentTool(sub, {
      llmStreamChat: captureStreamChat,
      url: 'https://x',
      model: 'gpt-4',
      mailbox,
      registry,
      stateLine: noopStateLine,
      // 不传 workDir —— 行为与改动前完全一致
    })

    await tool.execute(
      { name: 'reviewer', input: 'check this', reason: 'run reviewer' },
      { agentId: 'main' },
    )

    expect(seenSystem.length).toBeGreaterThan(0)
    const prompt = seenSystem[0]!
    // v0.38: 角色仍置顶；没有 workDir 时工作区层跳过，但纪律基底照常跟随。
    expect(prompt.startsWith('You are a reviewer.')).toBe(true)
    expect(prompt).not.toContain('{work_dir}')
    expect(prompt).toContain('# Reporting Back')
  })

  it('assembles four layers in order: role → workspace → discipline → AGENTS.md (v0.38)', async () => {
    const registry = makeRegistry()
    const mailbox = new Mailbox()
    const sub = new SubAgentRegistry()
    await sub.register({ name: 'reviewer', systemPrompt: 'You are a reviewer.', toolRefs: ['echo'] })

    const seenSystem: string[] = []
    const captureStreamChat = async function* (
      _url: string,
      request: { model: string; messages: Array<{ role: string; content: unknown }> },
    ): AsyncIterable<StreamChunk> {
      const sys = request.messages.find((m) => m.role === 'system')
      if (sys) seenSystem.push(String(sys.content))
      yield { type: 'finish', reason: 'stop' }
      yield { type: 'done' }
    }

    const tool = createRunSubagentTool(sub, {
      llmStreamChat: captureStreamChat,
      url: 'https://x',
      model: 'gpt-4',
      mailbox,
      registry,
      stateLine: noopStateLine,
      workDir: '/workspace/proj',
      layeredPrompt: 'PROJECT CONVENTION MARKER',
    })

    await tool.execute({ name: 'reviewer', input: 'check this', reason: 'run reviewer' }, { agentId: 'main' })

    const prompt = seenSystem[0]!
    const role = prompt.indexOf('You are a reviewer.')
    const workspace = prompt.indexOf('Working directory')
    const discipline = prompt.indexOf('# Reporting Back')
    const convention = prompt.indexOf('PROJECT CONVENTION MARKER')
    // 用户 2026-09-12 拍板的顺序：身份先锚定，再由一般（纪律）到特殊（项目约定）。
    expect(role).toBe(0)
    expect(role).toBeLessThan(workspace)
    expect(workspace).toBeLessThan(discipline)
    expect(discipline).toBeLessThan(convention)
  })

  it('routes the discipline base workflow by the deps model family (v0.39)', async () => {
    const registry = makeRegistry()
    const mailbox = new Mailbox()
    const sub = new SubAgentRegistry()
    await sub.register({ name: 'dev', systemPrompt: 'You are a dev.', toolRefs: ['echo'] })

    const seenSystem: string[] = []
    const captureStreamChat = async function* (
      _url: string,
      request: { model: string; messages: Array<{ role: string; content: unknown }> },
    ): AsyncIterable<StreamChunk> {
      const sys = request.messages.find((m) => m.role === 'system')
      if (sys) seenSystem.push(String(sys.content))
      yield { type: 'finish', reason: 'stop' }
      yield { type: 'done' }
    }

    const tool = createRunSubagentTool(sub, {
      llmStreamChat: captureStreamChat,
      url: 'https://x',
      model: 'deepseek-v4-flash',
      mailbox,
      registry,
      stateLine: noopStateLine,
    })

    await tool.execute({ name: 'dev', input: 'do it', reason: 'run dev' }, { agentId: 'main' })

    const prompt = seenSystem[0]!
    // The DeepSeek workflow reaches the sub-agent discipline base — this is the
    // surface that executes delegated work, so family discipline must land here.
    expect(prompt).toContain('# Workflow')
    expect(prompt).toContain('Do not use shell commands to read or edit files')
    // Identity anchoring (layer ①) is untouched by routing.
    expect(prompt.startsWith('You are a dev.')).toBe(true)
  })

  it('falls back to the base workflow for an unmatched model family (v0.39)', async () => {
    const registry = makeRegistry()
    const mailbox = new Mailbox()
    const sub = new SubAgentRegistry()
    await sub.register({ name: 'dev', systemPrompt: 'You are a dev.', toolRefs: ['echo'] })

    const seenSystem: string[] = []
    const captureStreamChat = async function* (
      _url: string,
      request: { model: string; messages: Array<{ role: string; content: unknown }> },
    ): AsyncIterable<StreamChunk> {
      const sys = request.messages.find((m) => m.role === 'system')
      if (sys) seenSystem.push(String(sys.content))
      yield { type: 'finish', reason: 'stop' }
      yield { type: 'done' }
    }

    const tool = createRunSubagentTool(sub, {
      llmStreamChat: captureStreamChat,
      url: 'https://x',
      model: 'totally-unknown-model',
      mailbox,
      registry,
      stateLine: noopStateLine,
    })

    await tool.execute({ name: 'dev', input: 'do it', reason: 'run dev' }, { agentId: 'main' })

    const prompt = seenSystem[0]!
    expect(prompt).toContain('# Workflow')
    expect(prompt).toContain('Follow these phases for every non-trivial task')
    expect(prompt).not.toContain('Do not use shell commands to read or edit files')
  })

  it('swaps the nesting prohibition for delegation teaching when recursion is granted (v0.40)', async () => {
    const registry = makeRegistry()
    // run_subagent must resolve in the registry for the config to register.
    registry.registerSystemTool({
      name: 'run_subagent',
      description: 'run a sub-agent',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ ok: true }),
    } as never)
    const mailbox = new Mailbox()
    // Switch ON = the registry is built with the permissive environment policy,
    // exactly what resolveSubAgentToolPolicy returns when subAgentNesting=true.
    const sub = new SubAgentRegistry({ registry, toolPolicy: PERMISSIVE_SUB_AGENT_POLICY })
    await sub.register({
      name: 'nesting-dev',
      systemPrompt: 'You are a nesting dev.',
      toolRefs: ['echo', 'run_subagent'],
    })

    const seenSystem: string[] = []
    const captureStreamChat = async function* (
      _url: string,
      request: { model: string; messages: Array<{ role: string; content: unknown }> },
    ): AsyncIterable<StreamChunk> {
      const sys = request.messages.find((m) => m.role === 'system')
      if (sys) seenSystem.push(String(sys.content))
      yield { type: 'finish', reason: 'stop' }
      yield { type: 'done' }
    }

    const tool = createRunSubagentTool(sub, {
      llmStreamChat: captureStreamChat,
      url: 'https://x',
      model: 'deepseek-v4-flash',
      mailbox,
      registry,
      stateLine: noopStateLine,
    })

    await tool.execute({ name: 'nesting-dev', input: 'do it', reason: 'run dev' }, { agentId: 'main' })

    const prompt = seenSystem[0]!
    expect(prompt).toContain('You are authorized to spawn sub-agents')
    expect(prompt).toContain('depth of 3')
    expect(prompt).not.toContain('Do not spawn further sub-agents')
    // Identity anchoring (layer ①) is untouched.
    expect(prompt.startsWith('You are a nesting dev.')).toBe(true)
  })

  it('keeps the nesting prohibition when the sub-agent holds no recursion tool (v0.40)', async () => {
    const registry = makeRegistry()
    const mailbox = new Mailbox()
    // Switch ON, but this config's own toolRefs whitelist has no run_subagent —
    // the prompt must not claim a capability this sub-agent does not hold.
    const sub = new SubAgentRegistry({ registry, toolPolicy: PERMISSIVE_SUB_AGENT_POLICY })
    await sub.register({ name: 'plain-dev', systemPrompt: 'You are a plain dev.', toolRefs: ['echo'] })

    const seenSystem: string[] = []
    const captureStreamChat = async function* (
      _url: string,
      request: { model: string; messages: Array<{ role: string; content: unknown }> },
    ): AsyncIterable<StreamChunk> {
      const sys = request.messages.find((m) => m.role === 'system')
      if (sys) seenSystem.push(String(sys.content))
      yield { type: 'finish', reason: 'stop' }
      yield { type: 'done' }
    }

    const tool = createRunSubagentTool(sub, {
      llmStreamChat: captureStreamChat,
      url: 'https://x',
      model: 'deepseek-v4-flash',
      mailbox,
      registry,
      stateLine: noopStateLine,
    })

    await tool.execute({ name: 'plain-dev', input: 'do it', reason: 'run dev' }, { agentId: 'main' })

    const prompt = seenSystem[0]!
    expect(prompt).toContain('Do not spawn further sub-agents. Complete the assignment yourself with the tools you have.')
    expect(prompt).not.toContain('You are authorized to spawn sub-agents')
  })

  it('projects sub-agent tool turns into the family databus under the instance id', async () => {
    const registry = makeRegistry()
    const mailbox = new Mailbox()
    const sub = new SubAgentRegistry()
    await sub.register({ name: 'agent-a', systemPrompt: 'A', toolRefs: ['echo'] })

    const tcResponse: ChatCompletionResponse = {
      id: 'r1', model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'echo', arguments: '{"x":"hi"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    }
    const finalResponse: ChatCompletionResponse = {
      id: 'r2', model: 'gpt-4',
      choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
    }

    const tool = createRunSubagentTool(sub, {
      llmStreamChat: scriptedStreamChat([tcResponse, finalResponse]),
      url: 'https://x',
      model: 'gpt-4',
      mailbox,
      registry,
      stateLine: noopStateLine,
    })

    // v0.12: the projection bus is now the working agent's familyDatabus
    // (= root.familyDatabus, shared by all siblings), NOT the deprecated
    // sharedDatabus. The sub-agent's sourceAgentId is the instance id
    // (`agent-a-<uuid>`), so we query by prefix to find its events.
    const familyBus = sub.agentTree.root.familyDatabus
    await tool.execute(
      { name: 'agent-a', input: 'call echo', reason: 'test family databus' },
      { agentId: 'main' },
    )
    const events = familyBus.turns() as ReadonlyArray<{ sourceAgentId?: string; toolCallId?: string }>
    const aEvents = events.filter((e) => e.sourceAgentId?.startsWith('agent-a-'))
    expect(aEvents.length).toBeGreaterThanOrEqual(1)
    expect(aEvents[aEvents.length - 1]?.sourceAgentId).toMatch(/^agent-a-/)
  })

  it('sub-agent reads working agent tool events via ctxDatabus', async () => {
    // Register databus_query alongside echo so agent-b can actually call it.
    const registry = makeRegistry()
    registry.registerSystemTool(createDatabusQueryTool())
    const mailbox = new Mailbox()
    const sub = new SubAgentRegistry()
    await sub.register({ name: 'agent-a', systemPrompt: 'A', toolRefs: ['echo'] })
    await sub.register({ name: 'agent-b', systemPrompt: 'B', toolRefs: ['echo', 'databus_query'] })

    // v0.12: the working agent's private bus is root.ownDatabus. The sub-agent's
    // ctxDatabus is [child.ownDatabus (= root.familyDatabus), parent.ownDatabus
    // (= root.ownDatabus)], so databus_query can read events seeded on the
    // working agent's bus. Seed an event tagged 'agent-a' (the LLM will query
    // for that id). The instance id is `agent-a-<uuid>`, but the seeded event
    // keeps the literal 'agent-a' sourceAgentId so we can assert the cross-bus
    // read without coupling to the generated UUID.
    const workingBus = sub.agentTree.root.ownDatabus
    workingBus.append({
      id: 'seed', role: 'tool', toolCallId: 'tc-seed', content: '{"echo":"hello"}',
      sourceAgentId: 'agent-a', at: 1,
    })

    const tcResponse: ChatCompletionResponse = {
      id: 'r1', model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'databus_query', arguments: '{"sourceAgentIds":["agent-a"],"reason":"read a"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    }
    const finalResponse: ChatCompletionResponse = {
      id: 'r2', model: 'gpt-4',
      choices: [{ index: 0, message: { role: 'assistant', content: 'saw event' }, finish_reason: 'stop' }],
    }

    const tool = createRunSubagentTool(sub, {
      llmStreamChat: scriptedStreamChat([tcResponse, finalResponse]),
      url: 'https://x',
      model: 'gpt-4',
      mailbox,
      registry,
      stateLine: noopStateLine,
    })

    const result = await tool.execute(
      { name: 'agent-b', input: 'query agent-a', reason: 'cross-agent read' },
      { agentId: 'main' },
    )
    expect(result).toMatchObject({ output: 'saw event', status: 'completed' })

    // v0.12: the databus_query tool turn projects into the child's ownDatabus
    // (= root.familyDatabus). Its sourceAgentId is the agent-b instance id.
    const familyBus = sub.agentTree.root.familyDatabus
    const events = familyBus.turns() as ReadonlyArray<{ sourceAgentId?: string; toolCallId?: string; content?: string }>
    const bEvents = events.filter((e) => e.sourceAgentId?.startsWith('agent-b-'))
    expect(bEvents.length).toBeGreaterThanOrEqual(1)
    // The databus_query tool result should contain the seeded event from the
    // working agent's bus, proving the sub-agent could read across buses.
    const queryResult = bEvents.find(e => e.toolCallId === 'tc-1')
    expect(queryResult).toBeDefined()
    expect(queryResult!.content).toContain('seed')
    expect(queryResult!.content).toContain('agent-a')
  })

  it('sub-agent A writes event, sub-agent B reads it via databus_query', async () => {
    // v0.12: siblings share the same projection bus (parent.familyDatabus).
    // agent-a runs echo (writes to root.familyDatabus under an instance id),
    // then agent-b runs databus_query. Because agent-b's ctxDatabus includes
    // root.familyDatabus (= child.ownDatabus for siblings of the same parent),
    // agent-b sees agent-a's echo event. The LLM query asks for sourceAgentId
    // 'agent-a' literally — but the actual projected sourceAgentId is
    // 'agent-a-<uuid>', so to make this cross-sibling read observable we query
    // the family bus directly and assert the prefix match instead of relying
    // on the LLM's literal filter.
    const registry = makeRegistry()
    registry.registerSystemTool(createDatabusQueryTool())
    const mailbox = new Mailbox()
    const sub = new SubAgentRegistry()
    await sub.register({ name: 'agent-a', systemPrompt: 'A', toolRefs: ['echo'] })
    await sub.register({ name: 'agent-b', systemPrompt: 'B', toolRefs: ['echo', 'databus_query'] })

    // Phase 1: agent-a calls echo, projecting into root.familyDatabus.
    const aTc: ChatCompletionResponse = {
      id: 'a1', model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'tc-a', type: 'function', function: { name: 'echo', arguments: '{"x":"from-a"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    }
    const aFinal: ChatCompletionResponse = {
      id: 'a2', model: 'gpt-4',
      choices: [{ index: 0, message: { role: 'assistant', content: 'a done' }, finish_reason: 'stop' }],
    }
    const toolA = createRunSubagentTool(sub, {
      llmStreamChat: scriptedStreamChat([aTc, aFinal]),
      url: 'https://x', model: 'gpt-4',
      mailbox, registry, stateLine: noopStateLine,
    })
    await toolA.execute(
      { name: 'agent-a', input: 'say from-a', reason: 'phase 1' },
      { agentId: 'main' },
    )

    // agent-a's echo tool turn must be in the family bus now (instance id prefix).
    const familyBus = sub.agentTree.root.familyDatabus
    const aRuns = (familyBus.turns() as ReadonlyArray<{ sourceAgentId?: string }>)
      .filter((e) => e.sourceAgentId?.startsWith('agent-a-'))
    expect(aRuns.length).toBeGreaterThanOrEqual(1)

    // Phase 2: agent-b queries databus. Its ctxDatabus is
    // [child.ownDatabus (= root.familyDatabus), parent.ownDatabus (= root.ownDatabus)].
    // root.familyDatabus contains agent-a's echo turn, so databus_query should
    // return it when filtering by the agent-a instance id. We ask the LLM to
    // query for sourceAgentIds starting with 'agent-a-' by passing that prefix
    // as the filter — but databus_query matches exact ids, not prefixes. So
    // instead we read the family bus turn that carries agent-a's content and
    // feed it via a direct bus inspection. The scripted LLM call still runs to
    // exercise the full loop; the assertion below inspects the family bus.
    const aInstanceId = aRuns[aRuns.length - 1]!.sourceAgentId!
    const bTc: ChatCompletionResponse = {
      id: 'b1', model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'tc-b', type: 'function', function: { name: 'databus_query', arguments: JSON.stringify({ sourceAgentIds: [aInstanceId], reason: 'read a' }) } }],
        },
        finish_reason: 'tool_calls',
      }],
    }
    const bFinal: ChatCompletionResponse = {
      id: 'b2', model: 'gpt-4',
      choices: [{ index: 0, message: { role: 'assistant', content: 'b saw a' }, finish_reason: 'stop' }],
    }
    const toolB = createRunSubagentTool(sub, {
      llmStreamChat: scriptedStreamChat([bTc, bFinal]),
      url: 'https://x', model: 'gpt-4',
      mailbox, registry, stateLine: noopStateLine,
    })
    const result = await toolB.execute(
      { name: 'agent-b', input: 'query a', reason: 'phase 2' },
      { agentId: 'main' },
    )
    expect(result).toMatchObject({ output: 'b saw a', status: 'completed' })

    // Verify agent-b's databus_query result contained agent-a's echo event.
    const bRuns = (familyBus.turns() as ReadonlyArray<{ sourceAgentId?: string; toolCallId?: string; content?: string }>)
      .filter((e) => e.sourceAgentId?.startsWith('agent-b-'))
    const queryTurn = bRuns.find(e => e.toolCallId === 'tc-b')
    expect(queryTurn).toBeDefined()
    expect(queryTurn!.content).toContain('from-a')
  })

  it('requires reason', async () => {
    const registry = makeRegistry()
    const mailbox = new Mailbox()
    const sub = new SubAgentRegistry()
    await sub.register({ name: 'reviewer', systemPrompt: 'R', toolRefs: [] })
    const tool = createRunSubagentTool(sub, {
      llmStreamChat: scriptedStreamChat([]),
      url: 'https://x',
      model: 'gpt-4',
      mailbox,
      registry,
      stateLine: noopStateLine,
    })
    await expect(
      tool.execute(
        { name: 'reviewer', input: 'x' },
        { agentId: 'main' },
      ),
    ).rejects.toThrow('reason')
  })

  it('returns fallback when sub-agent produces no output', async () => {
    const registry = makeRegistry()
    const mailbox = new Mailbox()
    const sub = new SubAgentRegistry()
    await sub.register({ name: 'silent', systemPrompt: 'Silent.', toolRefs: [] })

    // Empty response stream (no content).
    const tool = createRunSubagentTool(sub, {
      llmStreamChat: scriptedStreamChat([]),
      url: 'https://x',
      model: 'gpt-4',
      mailbox,
      registry,
      stateLine: noopStateLine,
    })
    const result = await tool.execute(
      { name: 'silent', input: 'x', reason: 'silent run' },
      { agentId: 'main' },
    )
    expect(result).toMatchObject({ output: '(sub-agent produced no output)', status: 'completed' })
  })

  it('returns guard-tripped status when the sub-agent loop is tripped by the iter guard', async () => {
    const registry = makeRegistry()
    const mailbox = new Mailbox()
    // Register a sub-agent that keeps calling echo forever. With a tight
    // maxSteps override (via the sub-agent config field) the iter guard trips
    // the loop — stepCount > maxSteps fires on the 4th round (maxSteps=3).
    const sub = new SubAgentRegistry()
    await sub.register({
      name: 'runner',
      systemPrompt: 'R',
      toolRefs: ['echo'],
      config: { maxSteps: 3 },
    })

    const tcResponse = (): ChatCompletionResponse => ({
      id: 'r', model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'tc', type: 'function', function: { name: 'echo', arguments: '{"x":"y","reason":"loop"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    })
    // Supply enough scripted tool_call rounds that the generator does not run
    // dry before the iter guard trips.
    const responses: ChatCompletionResponse[] = Array.from({ length: 50 }, () => tcResponse())

    const tool = createRunSubagentTool(sub, {
      llmStreamChat: scriptedStreamChat(responses),
      url: 'https://x',
      model: 'gpt-4',
      mailbox,
      registry,
      stateLine: noopStateLine,
    })

    const result = await tool.execute(
      { name: 'runner', input: 'loop', reason: 'trip guard' },
      { agentId: 'main' },
    )
    expect(result).toMatchObject({ status: 'guard-tripped', trippedHint: 'iter' })
    // output is a string (empty when tripped before any final assistant turn)
    expect(typeof (result as { output: string }).output).toBe('string')
  })
})
