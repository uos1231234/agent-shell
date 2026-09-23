import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDefineSubagentTool } from '../../../src/im/tools/define-subagent.js'
import { SubAgentRegistry } from '../../../src/im/sub-agent/registry.js'
import { ToolRegistry } from '../../../src/shell/registry.js'
import { readFile } from 'node:fs/promises'

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

describe('im/tools/define-subagent', () => {
  it('defines a sub-agent in the registry', async () => {
    const registry = makeRegistry()
    // v0.11.3 P0-2: register() now owns validation, so the registry must be
    // passed to the SubAgentRegistry constructor for re-validation to run.
    const sub = new SubAgentRegistry({ registry: registry })
    const tool = createDefineSubagentTool(sub, registry)
    const result = await tool.execute({
      name: 'reviewer',
      systemPrompt: 'Review code.',
      toolRefs: ['echo'],
      reason: 'create reviewer agent',
    })
    expect(result).toBe("Defined session-scoped sub-agent 'reviewer' with tools: echo")
    expect(sub.get('reviewer')).toBeDefined()
    expect(sub.get('reviewer')?.toolRefs).toEqual(['echo'])
    // v0.30（用户拍板 2026-09-09）：AI 定义的子代理 = 会话内存资产，
    // createdBy: 'agent'——回收由会话销毁自然实现，不落盘。
    expect(sub.get('reviewer')?.createdBy).toBe('agent')
  })

  it('rejects invalid toolRefs', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry({ registry: registry })
    const tool = createDefineSubagentTool(sub, registry)
    await expect(tool.execute({
      name: 'bad',
      systemPrompt: 'Bad.',
      toolRefs: ['nonexistent'],
      reason: 'should fail',
    })).rejects.toThrow('Unknown toolRefs')
  })

  it('requires reason', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry({ registry: registry })
    const tool = createDefineSubagentTool(sub, registry)
    await expect(tool.execute({
      name: 'noreason',
      systemPrompt: 'No reason.',
      toolRefs: ['echo'],
    })).rejects.toThrow('reason')
  })

  it('does NOT persist AI-defined sub-agents to disk (session-scoped lifecycle)', async () => {
    const registry = makeRegistry()
    const dir = mkdtempSync(join(tmpdir(), 'define-subagent-test-'))
    try {
      const sub = new SubAgentRegistry({ registry: registry })
      // v0.30: 工具不再接受 diskDir——AI 定义只进会话内存。
      const tool = createDefineSubagentTool(sub, registry)
      await tool.execute({
        name: 'reviewer',
        systemPrompt: 'Review code.',
        toolRefs: ['echo'],
        config: { maxSteps: 10 },
        reason: 'define reviewer',
      })
      expect(sub.get('reviewer')).toBeDefined()
      // 不落盘：磁盘目录保持为空（无 reviewer.json）。
      await expect(readFile(join(dir, 'reviewer.json'), 'utf8')).rejects.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('session-scoped recycle: a fresh registry (new session) does not see AI-defined agents', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry({ registry: registry })
    const tool = createDefineSubagentTool(sub, registry)
    await tool.execute({
      name: 'temp-bot',
      systemPrompt: 'Temp.',
      toolRefs: ['echo'],
      reason: 'temp agent for this session',
    })
    expect(sub.get('temp-bot')).toBeDefined()
    // 新会话 = 新 registry（磁盘唯一持久源是用户配置；AI 定义的只有内存）——
    // 模拟新会话注册表：不带磁盘加载，也看不到 AI 定义。
    const fresh = new SubAgentRegistry({ registry: registry })
    expect(fresh.get('temp-bot')).toBeUndefined()
    expect(fresh.list()).toEqual([])
  })

  it('references a user-configured sub-agent by ref with no overrides', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry({ registry: registry })
    // 预置用户配置（loadFromDisk 的效果）
    await sub.register({
      name: 'file-reader',
      systemPrompt: 'You are file-reader.',
      toolRefs: ['echo'],
    })

    const tool = createDefineSubagentTool(sub, registry)
    const result = await tool.execute({
      ref: 'file-reader',
      reason: 'reference user agent',
    })
    // name 缺省 = ref 同名；systemPrompt/toolRefs 继承被引用配置
    expect(result).toBe("Defined session-scoped sub-agent 'file-reader' with tools: echo")
    expect(sub.get('file-reader')?.systemPrompt).toBe('You are file-reader.')
  })

  it('allows overrides on top of a referenced config', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry({ registry: registry })
    await sub.register({
      name: 'file-reader',
      systemPrompt: 'You are file-reader.',
      toolRefs: ['echo'],
    })

    const tool = createDefineSubagentTool(sub, registry)
    const result = await tool.execute({
      ref: 'file-reader',
      name: 'reader-v2',
      systemPrompt: 'You are reader-v2, stricter.',
      reason: 'override referenced agent',
    })
    expect(result).toContain("'reader-v2'")
    expect(sub.get('reader-v2')?.systemPrompt).toBe('You are reader-v2, stricter.')
    // toolRefs 未覆盖 → 继承被引用配置
    expect(sub.get('reader-v2')?.toolRefs).toEqual(['echo'])
    // 原配置未被改动
    expect(sub.get('file-reader')?.systemPrompt).toBe('You are file-reader.')
  })

  it('throws with an available list when ref does not exist', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry({ registry: registry })
    await sub.register({
      name: 'file-reader',
      systemPrompt: 'You are file-reader.',
      toolRefs: ['echo'],
    })

    const tool = createDefineSubagentTool(sub, registry)
    await expect(tool.execute({
      ref: 'missing',
      reason: 'should fail',
    })).rejects.toThrow(/"missing" not found among user-configured sub-agents; available: file-reader/)
  })

  it('still requires name/systemPrompt/toolRefs when ref is absent', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry({ registry: registry })
    const tool = createDefineSubagentTool(sub, registry)
    await expect(tool.execute({
      name: 'bare',
      reason: 'incomplete',
    })).rejects.toThrow(/without ref, name, systemPrompt and toolRefs are all required/)
  })
})
