// v0.11.3 P0-2: Verify that a custom SubAgentToolPolicy passed to the
// SubAgentRegistry constructor is actually applied in register() and
// loadFromDisk() — closing the dead extension point where validateSubAgentConfig
// accepted toolPolicy but no caller wired it through.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SubAgentRegistry } from '../../../src/im/sub-agent/registry.js'
import { ToolRegistry } from '../../../src/shell/registry.js'
import type { SubAgentToolPolicy } from '../../../src/im/sub-agent/policy.js'

const makeRegistry = (): ToolRegistry => {
  const r = new ToolRegistry()
  r.registerSystemTool({
    name: 'echo',
    description: 'echo',
    parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
    execute: async (args) => (args as { x: string }).x,
  })
  // 'bash' registered so it's "available" — the policy decides allow/deny.
  r.registerSystemTool({
    name: 'bash',
    description: 'shell',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
    execute: async () => '',
  })
  return r
}

// A strict policy: default deny, only echo allowed. This is stricter than
// DEFAULT_SUB_AGENT_TOOL_POLICY (which allows echo + denies a fixed list).
const strictPolicy: SubAgentToolPolicy = {
  default: 'deny',
  rules: [{ mode: 'allow', pattern: 'echo' }],
}

describe('P0-2 policy integration: register() applies constructor toolPolicy', () => {
  it('rejects a toolRef denied by the custom policy', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry({ registry: registry, toolPolicy: strictPolicy })
    // bash is registered (available) but the strict policy denies it.
    await expect(
      sub.register({
        name: 'bot',
        systemPrompt: 'x',
        toolRefs: ['bash'],
      } as unknown as Parameters<typeof sub.register>[0]),
    ).rejects.toThrow('not allowed by sub-agent policy')
  })

  it('accepts a toolRef allowed by the custom policy', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry({ registry: registry, toolPolicy: strictPolicy })
    await sub.register({
      name: 'bot',
      systemPrompt: 'x',
      toolRefs: ['echo'],
    })
    expect(sub.get('bot')).toBeDefined()
    expect(sub.get('bot')?.toolRefs).toEqual(['echo'])
  })

  it('custom policy overrides the default (allows bash when policy permits)', async () => {
    // A permissive policy that explicitly allows bash — overriding the
    // DEFAULT_SUB_AGENT_TOOL_POLICY which denies it.
    const allowBashPolicy: SubAgentToolPolicy = {
      default: 'deny',
      rules: [
        { mode: 'allow', pattern: 'echo' },
        { mode: 'allow', pattern: 'bash' },
      ],
    }
    const registry = makeRegistry()
    const sub = new SubAgentRegistry({ registry: registry, toolPolicy: allowBashPolicy })
    await sub.register({
      name: 'shell-bot',
      systemPrompt: 'x',
      toolRefs: ['bash'],
    })
    expect(sub.get('shell-bot')?.toolRefs).toEqual(['bash'])
  })

  it('defaults to DEFAULT_SUB_AGENT_TOOL_POLICY when no policy passed', async () => {
    // Omitting toolPolicy must preserve v0.11.2 behavior: bash is denied.
    const registry = makeRegistry()
    const sub = new SubAgentRegistry({ registry: registry })
    await expect(
      sub.register({
        name: 'bot',
        systemPrompt: 'x',
        toolRefs: ['bash'],
      } as unknown as Parameters<typeof sub.register>[0]),
    ).rejects.toThrow('not allowed by sub-agent policy')
  })
})

describe('P0-2 policy integration: loadFromDisk() applies constructor toolPolicy', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'policy-integration-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('skips configs whose toolRefs violate the custom policy', async () => {
    const registry = makeRegistry()

    // Write a config that uses bash directly to disk (bypassing register()).
    // loadFromDisk must reject it under the strict policy.
    const bashBot = {
      name: 'bash-bot',
      systemPrompt: 'x',
      toolRefs: ['bash'],
    }
    writeFileSync(join(dir, 'bash-bot.json'), JSON.stringify(bashBot), 'utf8')

    // Write a valid config that only uses echo.
    const echoBot = {
      name: 'echo-bot',
      systemPrompt: 'x',
      toolRefs: ['echo'],
    }
    writeFileSync(join(dir, 'echo-bot.json'), JSON.stringify(echoBot), 'utf8')

    const loader = new SubAgentRegistry({ registry: registry, toolPolicy: strictPolicy })
    const loaded = await loader.loadFromDisk(dir, registry)

    // Only echo-bot passes the strict policy; bash-bot is skipped.
    expect(loaded).toBe(1)
    expect(loader.get('echo-bot')).toBeDefined()
    expect(loader.get('bash-bot')).toBeUndefined()
  })
})

describe('P0-2 policy integration: define_subagent inherits registry policy', () => {
  it('define_subagent rejects toolRefs denied by the registry policy', async () => {
    const { createDefineSubagentTool } = await import('../../../src/im/tools/define-subagent.js')
    const registry = makeRegistry()
    // The SubAgentRegistry carries the strict policy; define_subagent
    // delegates to register() which applies it.
    const sub = new SubAgentRegistry({ registry: registry, toolPolicy: strictPolicy })
    const tool = createDefineSubagentTool(sub, registry)

    await expect(
      tool.execute({
        name: 'bot',
        systemPrompt: 'x',
        toolRefs: ['bash'],
        reason: 'should be denied by strict policy',
      }),
    ).rejects.toThrow('not allowed by sub-agent policy')

    // 拒绝的配置不进入注册表（不落盘、不入内存）。
    expect(sub.get('bot')).toBeUndefined()
  })

  it('define_subagent accepts toolRefs allowed by the registry policy', async () => {
    const { createDefineSubagentTool } = await import('../../../src/im/tools/define-subagent.js')
    const registry = makeRegistry()
    const sub = new SubAgentRegistry({ registry: registry, toolPolicy: strictPolicy })
    const tool = createDefineSubagentTool(sub, registry)

    const result = await tool.execute({
      name: 'echo-bot',
      systemPrompt: 'x',
      toolRefs: ['echo'],
      reason: 'allowed by strict policy',
    })
    expect(result).toContain('echo-bot')
    expect(sub.get('echo-bot')?.toolRefs).toEqual(['echo'])
  })
})
