// v0.11: run_subagent — invokes a previously defined sub-agent.
//
// The execution kernel lives in configured-subagent.ts so workflow-owned
// scouts and the public tool share tree, policy, prompt, session and guard
// behavior. This file remains the stable public tool surface.

import type { SystemTool } from '../../shell/registry.js'
import type { Mailbox } from '../mailbox/index.js'
import type { StateLine } from '../state-line/types.js'
import type { ContextInjector } from '../hooks/context-injection.js'
import type { StreamChunk, ChatMessage } from '../../protocol/types.js'
import type { ShellConfig } from '../../shell/config.js'
import { wrapTool, toSchema, reasonField } from './helpers.js'
import { SubAgentRegistry } from '../sub-agent/index.js'
import { runConfiguredSubagent } from './configured-subagent.js'
import type { TokenCounter } from '../../shared/token-counter.js'

export type SubAgentRunResult = {
  output: string
  status: 'completed' | 'guard-tripped'
  trippedHint?: 'iter' | 'token' | 'toolRate' | 'time' | 'errorRate'
}

export type ConfiguredSubagentRun = SubAgentRunResult & {
  instanceId: string
}

export type RunSubagentDeps = {
  llmStreamChat: (
    url: string,
    request: { model: string; messages: ChatMessage[]; tools: unknown[]; [k: string]: unknown },
  ) => AsyncIterable<StreamChunk>
  url: string
  model: string
  mailbox: Mailbox
  registry: import('../../shell/registry.js').ToolRegistry
  stateLine: StateLine
  defaultConfig?: ShellConfig
  workDir?: string
  contextInjector?: ContextInjector
  layeredPrompt?: string
  strictAlternation?: boolean | undefined
  tokenCounter?: TokenCounter | (() => TokenCounter)
}

export { runConfiguredSubagent }

export const createRunSubagentTool = (
  subAgentRegistry: SubAgentRegistry,
  deps: RunSubagentDeps,
): SystemTool => ({
  name: 'run_subagent',
  description:
    'Run a previously defined sub-agent with the given input. The sub-agent runs under its own guard-controlled loop '
    + 'and shares a databus with other sub-agents for cross-agent visibility.',
  parameters: toSchema({
    name: {
      type: 'string',
      description: 'Name of the sub-agent to run (must have been defined via define_subagent or loaded from disk)',
    },
    input: {
      type: 'string',
      description: 'User/task input passed to the sub-agent as a single user message',
    },
    reason: reasonField,
  }, ['name', 'input', 'reason']),
  execute: wrapTool('run_subagent', async (args, ctx) => {
    const a = args as { name: string; input: string; reason: string }
    const cfg = subAgentRegistry.get(a.name)
    if (!cfg) throw new Error(`Sub-agent "${a.name}" is not defined`)
    const run = await runConfiguredSubagent({
      cfg,
      input: a.input,
      deps,
      subAgentRegistry,
      ...(ctx !== undefined ? { callerContext: ctx } : {}),
    })
    const { instanceId: _instanceId, ...result } = run
    return result
  }),
})
