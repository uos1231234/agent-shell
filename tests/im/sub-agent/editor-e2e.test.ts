// v0.38 end-to-end: the built-in editor sub-agent can ACTUALLY write code.
//
// This answers the user's question "现在写代码的子代理能写代码吗?" with a real
// chain, not a unit test of the policy: the parent loop delegates to a
// sub-agent, the sub-agent's LLM issues a `write` tool call, and the file must
// land on disk — plus the mirror image: the default policy blocks the same
// call for a role without the editor override.
//
// The full sub-agent loop stack is real here: run_subagent tool → four-layer
// prompt composition → child system agent → its own IMLoop → registry.execute
// → tool policy → write tool. Only the LLM is mocked.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '../../../src/shell/registry.js'
import { createBuiltinTools } from '../../../src/im/tools/index.js'
import { SubAgentRegistry } from '../../../src/im/sub-agent/index.js'
import { BUILTIN_SUB_AGENT_CONFIGS } from '../../../src/im/prompt/subagent-roles.js'
import { registerSystemAgentTools } from '../../../src/im/system-agents/register.js'
import { runIMLoop, type IMLoopOptions } from '../../../src/im/loop.js'
import { ConversationMemory } from '../../../src/im/conversation-memory.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import { createNoopStateLine } from '../../../src/im/state-line/index.js'
import { createConfig } from '../../../src/shell/config.js'
import type { SystemAgent } from '../../../src/im/system-agent.js'
import type { ChatMessage, StreamChunk, ChatCompletionResponse } from '../../../src/protocol/types.js'

const noopSystemAgent: SystemAgent = {
  run: async () => { throw new Error('noop') },
  stop() {},
  send() {},
}

const capturingStreamChat = (
  responses: ChatCompletionResponse[],
  captured: ChatMessage[][],
): IMLoopOptions['streamChat'] => {
  let i = 0
  return async function* (_url, request): AsyncIterable<StreamChunk> {
    captured.push(request.messages as ChatMessage[])
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

/** Register `write` into the registry like the assembly exposes it. */
const addWriteTool = (registry: ToolRegistry, dir: string): void => {
  const systemTools = createBuiltinTools({ cwd: dir, dataDir: dir })
  const tool = (systemTools as unknown as { getSystemTool(name: string): unknown }).getSystemTool('write')
  if (!tool) throw new Error('write not found in builtin tools')
  registry.registerSystemTool(tool as never)
}

/** Register the read-side tools the editor whitelist references. */
const addReadTools = (registry: ToolRegistry, dir: string): void => {
  const systemTools = createBuiltinTools({ cwd: dir, dataDir: dir })
  for (const ref of ['read', 'ls', 'find', 'grep', 'ast_grep', 'edit', 'search_replace']) {
    const tool = (systemTools as unknown as { getSystemTool(name: string): unknown }).getSystemTool(ref)
    if (tool) registry.registerSystemTool(tool as never)
  }
}

describe('v0.38 end-to-end — the editor sub-agent really writes code', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'editor-e2e-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('editor role: parent delegates → editor issues write → file lands on disk', async () => {
    const target = join(dir, 'generated.ts')
    const captured: ChatMessage[][] = []
    const responses: ChatCompletionResponse[] = [
      // 1) Parent: delegate to the built-in editor.
      {
        id: 'p1', model: 'gpt-4',
        choices: [{
          index: 0,
          message: {
            role: 'assistant', content: '',
            tool_calls: [{
              id: 'c1', type: 'function',
              function: { name: 'run_subagent', arguments: JSON.stringify({ name: 'editor', input: 'create the module', reason: 'delegate' }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      },
      // 2) Editor: issue a real write tool call.
      {
        id: 'e1', model: 'gpt-4',
        choices: [{
          index: 0,
          message: {
            role: 'assistant', content: '',
            tool_calls: [{
              id: 'c2', type: 'function',
              function: { name: 'write', arguments: JSON.stringify({ path: target, content: 'export const answer = 42\n', reason: 'create file' }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      },
      // 3) Editor: report back.
      { id: 'e2', model: 'gpt-4', choices: [{ index: 0, message: { role: 'assistant', content: 'file created' }, finish_reason: 'stop' }] },
      // 4) Parent: done.
      { id: 'p2', model: 'gpt-4', choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] },
    ]

    const streamChat = capturingStreamChat(responses, captured)
    const registry = new ToolRegistry()
    addReadTools(registry, dir)
    addWriteTool(registry, dir)
    const subAgentRegistry = new SubAgentRegistry({ registry })
    // Register the built-in editor role exactly as createSubAgentRegistry does —
    // v0.39: its toolPolicy travels IN the config (identity, not environment).
    const editorCfg = BUILTIN_SUB_AGENT_CONFIGS.find((c) => c.name === 'editor')!
    await subAgentRegistry.register({
      name: editorCfg.name,
      systemPrompt: editorCfg.systemPrompt,
      toolRefs: [...editorCfg.toolRefs],
      ...(editorCfg.toolPolicy !== undefined ? { toolPolicy: editorCfg.toolPolicy } : {}),
    })
    const mailbox = new Mailbox(subAgentRegistry.agentTree)
    const stateLine = createNoopStateLine()

    registerSystemAgentTools(
      registry, mailbox,
      { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
      subAgentRegistry,
      { llmStreamChat: streamChat as never, url: 'http://test', model: 'gpt-4', stateLine },
    )
    subAgentRegistry.agentTree.rebindRoot({ rootId: 'main', sessionId: 's-e2e', rootOwnDatabus: subAgentRegistry.agentTree.root.ownDatabus })

    await runIMLoop({
      config: createConfig(), registry,
      databus: subAgentRegistry.agentTree.root.ownDatabus,
      conversationMemory: new ConversationMemory(),
      workingAgentId: 'main', mailbox,
      systemAgents: { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
      streamChat: streamChat as never, url: 'http://test', model: 'gpt-4',
      systemPrompt: 'You are the working agent.', userTemplate: 'delegate the work',
      systemToolRefs: ['run_subagent'], mcpRefs: [], skillRefs: [], stateLine, subAgentDepth: 0,
      workDir: dir,
    })

    // THE assertion: the editor's write call physically landed on disk.
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('export const answer = 42\n')
  })

  it('default policy: registering a writer-holding role without the override is REFUSED at registration', async () => {
    // The wall is at registration, not at tool-call time: a role whose
    // toolRefs include a writer cannot even be registered under the default
    // policy. (The built-in editor gets through only via its policy override.)
    const registry = new ToolRegistry()
    addReadTools(registry, dir)
    addWriteTool(registry, dir)
    const subAgentRegistry = new SubAgentRegistry({ registry })

    await expect(
      subAgentRegistry.register({ name: 'auditor', systemPrompt: 'You are an auditor.', toolRefs: ['write'] }),
    ).rejects.toThrow(/'write' is not allowed by sub-agent policy/)
    expect(subAgentRegistry.get('auditor')).toBeUndefined()
  })
})
