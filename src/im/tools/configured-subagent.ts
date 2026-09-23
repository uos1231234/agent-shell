import type { ChatMessage, StreamChunk } from '../../protocol/types.js'
import type { ToolContext } from '../../shared/tool-context.js'
import type { SubAgentRegistry } from '../sub-agent/index.js'
import { effectiveToolPolicy, applyToolPolicy } from '../sub-agent/index.js'
import { resolveCallerToolRefs } from '../sub-agent/caller-scope.js'
import { generateInstanceId } from '../sub-agent/tree.js'
import { createSystemAgent } from '../system-agent.js'
import { createConfig, DEFAULT_CONFIG } from '../../shell/config.js'
import { WORK_DIR_RULE } from '../prompt/static-prompt.js'
import { buildStaticPrompt } from '../prompt/section-builder.js'
import type { GuardId } from '../../shell/guards.js'
import type {
  ConfiguredSubagentRun,
  RunSubagentDeps,
  SubAgentRunResult,
} from './run-subagent.js'

const GUARD_ID_TO_HINT: Record<GuardId, SubAgentRunResult['trippedHint']> = {
  iter: 'iter',
  token: 'token',
  toolRate: 'toolRate',
  time: 'time',
  errorRate: 'errorRate',
}

export type RunConfiguredSubagentOptions = {
  cfg: import('../sub-agent/config.js').SubAgentConfig
  input: string
  deps: RunSubagentDeps
  subAgentRegistry: SubAgentRegistry
  callerContext?: ToolContext
  parentAgentId?: string
}

/** Shared execution kernel for public run_subagent and workflow scouts. */
export const runConfiguredSubagent = async (
  options: RunConfiguredSubagentOptions,
): Promise<ConfiguredSubagentRun> => {
  const { cfg, input, deps, subAgentRegistry } = options
  const ctx = options.callerContext
  const effectiveMaxDepth = cfg.config?.maxSubAgentDepth
    ?? deps.defaultConfig?.maxSubAgentDepth
    ?? DEFAULT_CONFIG.maxSubAgentDepth
  const currentDepth = ctx?.subAgentDepth ?? 0
  if (currentDepth >= effectiveMaxDepth) {
    throw new Error(`Sub-agent nesting limit (${effectiveMaxDepth}) reached`)
  }

  const callerToolRefs = resolveCallerToolRefs(ctx, subAgentRegistry)
  if (callerToolRefs !== undefined) {
    const violations = cfg.toolRefs.filter((ref) => !callerToolRefs.includes(ref))
    if (violations.length > 0) {
      throw new Error(
        `run_subagent: "${cfg.name}" would hold tools its caller does not have `
        + `(${violations.join(', ')}) — sub-agents cannot amplify privileges. `
        + 'Run it from the top level instead, or give the caller those tools first.',
      )
    }
  }

  const tree = subAgentRegistry.agentTree
  const parentAgentId = options.parentAgentId ?? ctx?.agentId ?? 'main'
  const parentNode = tree.get(parentAgentId)
  if (parentNode === undefined) {
    throw new Error(`run_subagent: current agent "${parentAgentId}" not found in AgentTree`)
  }
  const instanceId = generateInstanceId(cfg.name, parentNode)
  const childNode = tree.registerChild(parentAgentId, instanceId)
  const inheritedSessionId = subAgentRegistry.sessionId ?? ctx?.sessionId
  const policy = effectiveToolPolicy(cfg)
  const tokenCounter = ctx?.tokenCounter
    ?? (typeof deps.tokenCounter === 'function' ? deps.tokenCounter() : deps.tokenCounter)
  const delegationGranted = cfg.toolRefs.includes('run_subagent') && applyToolPolicy('run_subagent', policy)
  const disciplineBase = buildStaticPrompt({
    mode: 'minimal',
    agentName: cfg.name,
    registry: deps.registry,
    modelId: deps.model,
    delegationAuthorization: delegationGranted,
  })
  const composedSystemPrompt = [
    cfg.systemPrompt,
    deps.workDir !== undefined ? WORK_DIR_RULE.replace('{work_dir}', deps.workDir) : '',
    disciplineBase,
    deps.layeredPrompt ?? '',
  ].filter((part) => part.length > 0).join('\n\n')

  const agentConfig: Parameters<typeof createSystemAgent>[0] = {
    name: instanceId,
    systemPrompt: composedSystemPrompt,
    ...(deps.workDir !== undefined ? { workDir: deps.workDir } : {}),
    ...(deps.contextInjector !== undefined ? { contextInjector: deps.contextInjector } : {}),
    toolRefs: cfg.toolRefs,
    toolPolicy: policy,
    llmStreamChat: deps.llmStreamChat,
    url: deps.url,
    model: deps.model,
    mailbox: deps.mailbox,
    registry: deps.registry,
    stateLine: deps.stateLine,
    databus: childNode.ownDatabus,
    sharedDatabus: [childNode.ownDatabus, parentNode.ownDatabus],
    subAgentDepth: currentDepth + 1,
    ...(inheritedSessionId !== undefined ? { sessionId: inheritedSessionId } : {}),
    ...(ctx?.hooks !== undefined ? { hooks: ctx.hooks as Parameters<typeof createSystemAgent>[0]['hooks'] } : {}),
    compaction: {},
    workingAgentId: parentAgentId,
    ...(deps.strictAlternation === true ? { strictAlternation: true } : {}),
    ...(tokenCounter !== undefined ? { tokenCounter } : {}),
  }
  if (cfg.config) agentConfig.config = createConfig(cfg.config)

  const result = await createSystemAgent(agentConfig).run({
    messages: [{ role: 'user', content: input } as ChatMessage],
  })
  const tripped = result.reason === 'guard-tripped' || result.finalState === 'Tripped'
  const output = typeof result.output === 'string' && result.output.length > 0
    ? result.output
    : tripped ? '' : '(sub-agent produced no output)'
  if (tripped) {
    const hint = result.hits[0] ? GUARD_ID_TO_HINT[result.hits[0].id] : undefined
    const base: ConfiguredSubagentRun = { instanceId, output, status: 'guard-tripped' }
    return hint === undefined ? base : { ...base, trippedHint: hint }
  }
  return { instanceId, output, status: 'completed' }
}

export type _ConfiguredSubagentStreamShape = (
  url: string,
  request: { model: string; messages: ChatMessage[]; tools: unknown[]; [k: string]: unknown },
) => AsyncIterable<StreamChunk>
