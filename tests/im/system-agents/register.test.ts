// v0.11: registerSystemAgentTools tests.
//
// Verifies that registerSystemAgentTools correctly registers all built-in
// system tools plus the v0.11 sub-agent tools (define_subagent, run_subagent)
// when subAgentRegistry + subAgentDeps are provided.

import { describe, it, expect } from 'vitest'
import { registerSystemAgentTools } from '../../../src/im/system-agents/register.js'
import { ToolRegistry } from '../../../src/shell/registry.js'
import { Mailbox } from '../../../src/im/mailbox/index.js'
import { SubAgentRegistry } from '../../../src/im/sub-agent/index.js'
import { createNoopStateLine } from '../../../src/im/state-line/index.js'
import type { SystemAgent } from '../../../src/im/system-agent.js'
import type { StreamChunk } from '../../../src/protocol/types.js'

const noopSystemAgent: SystemAgent = {
  run: async () => { throw new Error('noop') },
  stop() {},
  send() {},
}

const noopStreamChat = async function* (): AsyncIterable<never> {}

const makeDeps = () => ({
  llmStreamChat: noopStreamChat as unknown as Parameters<typeof registerSystemAgentTools>[4] extends infer T
    ? T extends { llmStreamChat: infer F } ? F : never : never,
  url: 'https://x',
  model: 'gpt-4',
  stateLine: createNoopStateLine(),
})

describe('im/system-agents/register', () => {
  it('registers all built-in system tools', () => {
    const registry = new ToolRegistry()
    const mailbox = new Mailbox()
    registerSystemAgentTools(
      registry, mailbox,
      { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
    )
    const tools = registry.listSystemTools()
    expect(tools).toContain('databus_query')
    expect(tools).toContain('databus_subscribe')
    expect(tools).toContain('state_query')
    // v0.12.2: compress_block is retired — no longer registered.
    expect(tools).not.toContain('compress_block')
    expect(tools).toContain('ask_recall')
    expect(tools).toContain('mailbox_send')
    expect(tools).toContain('mailbox_read')
    expect(tools).toContain('mailbox_status')
    expect(tools).toContain('mailbox_markread')
    // v0.12.4: record_curated_block is retired — the compressor returns
    // CuratedMemory JSON and the drive-coordinator persists it atomically.
    expect(tools).not.toContain('record_curated_block')
    expect(tools).toContain('record_m3_summary')
  })

  it('does NOT register sub-agent tools when subAgentRegistry is omitted', () => {
    const registry = new ToolRegistry()
    const mailbox = new Mailbox()
    registerSystemAgentTools(
      registry, mailbox,
      { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
    )
    const tools = registry.listSystemTools()
    expect(tools).not.toContain('define_subagent')
    expect(tools).not.toContain('run_subagent')
  })

  it('registers define_subagent + run_subagent when subAgentRegistry + deps provided', () => {
    const registry = new ToolRegistry()
    const mailbox = new Mailbox()
    const sub = new SubAgentRegistry()
    registerSystemAgentTools(
      registry, mailbox,
      { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
      sub,
      makeDeps(),
    )
    const tools = registry.listSystemTools()
    expect(tools).toContain('define_subagent')
    expect(tools).toContain('run_subagent')
  })

  it('does not register sub-agent tools when subAgentRegistry given but deps omitted', () => {
    const registry = new ToolRegistry()
    const mailbox = new Mailbox()
    const sub = new SubAgentRegistry()
    registerSystemAgentTools(
      registry, mailbox,
      { warehouse: noopSystemAgent, compressor: noopSystemAgent, recall: noopSystemAgent },
      sub,
      // deps intentionally omitted
    )
    const tools = registry.listSystemTools()
    expect(tools).not.toContain('define_subagent')
    expect(tools).not.toContain('run_subagent')
  })
})
