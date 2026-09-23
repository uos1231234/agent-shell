// Tests for buildStaticPrompt — template + registry tool listing assembly.
//
// Invariants:
//   - full mode includes all sections.
//   - minimal mode omits tool guide and action strategy.
//   - none mode returns only "你是 {agent_name}。".
//   - agentName is correctly substituted.
//   - toolingContent parameter overrides auto-generated tool listing.

import { describe, it, expect } from 'vitest'
import { buildStaticPrompt } from '../../../src/im/prompt/section-builder.js'
import type { ToolRegistry } from '../../../src/shell/registry.js'

function createMockRegistry(opts: {
  systemTools?: Array<{ name: string; description: string }>
  mcpServers?: Array<{ name: string; description: string; toolNames: string[] }>
  skills?: Array<{ name: string; description: string }>
} = {}): ToolRegistry {
  const systemTools = opts.systemTools ?? []
  const mcpServers = opts.mcpServers ?? []
  const skills = opts.skills ?? []

  const mcpMap = new Map(mcpServers.map(s => [s.name, { description: s.description, toolNames: s.toolNames }]))
  const skillMap = new Map(skills.map(s => [s.name, { description: s.description }]))

  return {
    listSystemTools: () => systemTools.map(t => t.name),
    getSystemTool: (name: string) => systemTools.find(t => t.name === name)
      ? { name: systemTools.find(t => t.name === name)!.description, description: systemTools.find(t => t.name === name)!.description, parameters: {} }
      : undefined,
    listMCPServerMetas: () => mcpMap,
    listLoadableSkillMetas: () => skillMap,
  } as unknown as ToolRegistry
}

describe('buildStaticPrompt — full mode', () => {
  it('contains all sections', () => {
    const registry = createMockRegistry({
      systemTools: [{ name: 'read', description: '读文件' }, { name: 'write', description: '写文件' }],
    })
    const result = buildStaticPrompt({ mode: 'full', agentName: '主代理', registry })
    expect(result).toContain('# Safety Rules')
    expect(result).toContain('# Coding Principles')
    expect(result).toContain('# Code-Information-Driven Programming')
    expect(result).toContain('# Tool Usage Guide')
    expect(result).toContain('# Action Strategy')
  })

  it('substitutes agentName', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({ mode: 'full', agentName: '测试助手', registry })
    expect(result).toContain('You are 测试助手')
    expect(result).not.toContain('{agent_name}')
  })

  it('replaces tooling_section with auto-generated tool listing', () => {
    const registry = createMockRegistry({
      systemTools: [{ name: 'read', description: '读文件' }],
    })
    const result = buildStaticPrompt({ mode: 'full', agentName: '代理', registry })
    expect(result).toContain('read：读文件')
    expect(result).not.toContain('{tooling_section}')
  })

  it('preserves dynamic_sections placeholder', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({ mode: 'full', agentName: '代理', registry })
    expect(result).toContain('{dynamic_sections}')
  })
})

describe('buildStaticPrompt — minimal mode', () => {
  it('omits tool guide and action strategy', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({ mode: 'minimal', agentName: '子代理', registry })
    expect(result).toContain('# Safety Rules')
    expect(result).toContain('# Coding Principles')
    expect(result).toContain('# Code-Information-Driven Programming')
    expect(result).not.toContain('# Tool Usage Guide')
    expect(result).not.toContain('# Action Strategy')
  })

  it('substitutes agentName', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({ mode: 'minimal', agentName: '子代理A', registry })
    expect(result).toContain('You are 子代理A')
  })

  it('preserves dynamic_sections placeholder', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({ mode: 'minimal', agentName: '子代理', registry })
    expect(result).toContain('{dynamic_sections}')
  })
})

describe('buildStaticPrompt — delegationAuthorization (v0.40)', () => {
  it('full mode: injects the authorization block only when granted', () => {
    const registry = createMockRegistry()
    const granted = buildStaticPrompt({
      mode: 'full', agentName: '代理', registry, delegationAuthorization: true,
    })
    expect(granted).toContain('# Delegation Authorization')
    expect(granted).not.toContain('{delegation_section}')

    const denied = buildStaticPrompt({ mode: 'full', agentName: '代理', registry })
    expect(denied).not.toContain('# Delegation Authorization')
    expect(denied).not.toContain('{delegation_section}')
    // Denied layout is exactly the pre-v0.40 template for the same model.
    expect(denied).toBe(buildStaticPrompt({ mode: 'full', agentName: '代理', registry, delegationAuthorization: false }))
  })

  it('minimal mode: teaching when granted, prohibition when not', () => {
    const registry = createMockRegistry()
    const granted = buildStaticPrompt({
      mode: 'minimal', agentName: '子代理', registry, delegationAuthorization: true,
    })
    expect(granted).toContain('You are authorized to spawn sub-agents')
    expect(granted).not.toContain('Do not spawn further sub-agents')

    const denied = buildStaticPrompt({ mode: 'minimal', agentName: '子代理', registry })
    expect(denied).toContain('Do not spawn further sub-agents')
    expect(denied).not.toContain('You are authorized to spawn sub-agents')
    expect(denied).not.toContain('{delegation_section}')
  })
})

describe('buildStaticPrompt — none mode', () => {
  it('returns only identity line', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({ mode: 'none', agentName: '无名代理', registry })
    expect(result.trim()).toBe('你是 无名代理。')
  })

  it('does not contain any sections', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({ mode: 'none', agentName: '代理', registry })
    expect(result).not.toContain('# Safety Rules')
    expect(result).not.toContain('# Tool Usage Guide')
    expect(result).not.toContain('{dynamic_sections}')
    expect(result).not.toContain('{tooling_section}')
  })
})

describe('buildStaticPrompt — workDir placeholder', () => {
  it('full mode: replaces {work_dir} with the given path', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({
      mode: 'full', agentName: '代理', registry,
      workDir: '/home/user/my-project',
    })
    expect(result).toContain('Working directory: /home/user/my-project')
    expect(result).not.toContain('{work_dir}')
  })

  it('full mode: removes the placeholder line when workDir absent', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({ mode: 'full', agentName: '代理', registry })
    expect(result).not.toContain('{work_dir}')
    expect(result).not.toContain('Working directory')
  })

  it('minimal mode: replaces {work_dir} with the given path', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({
      mode: 'minimal', agentName: '子代理', registry,
      workDir: '/workspace/proj',
    })
    expect(result).toContain('Working directory: /workspace/proj')
    expect(result).not.toContain('{work_dir}')
  })

  it('minimal mode: removes the placeholder line when workDir absent', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({ mode: 'minimal', agentName: '子代理', registry })
    expect(result).not.toContain('{work_dir}')
    expect(result).not.toContain('Working directory')
  })
})

describe('buildStaticPrompt — promptInjectionDefense toggle', () => {
  it('full mode: default (off) does not inject the defense section', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({ mode: 'full', agentName: '代理', registry })
    expect(result).not.toContain('提示词注入防御（上游为中转站时启用）')
    expect(result).not.toContain('中转站')
  })

  it('full mode: toggle on injects the defense section', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({
      mode: 'full', agentName: '代理', registry,
      promptInjectionDefense: true,
    })
    expect(result).toContain('提示词注入防御（上游为中转站时启用）')
    expect(result).toContain('第三方中转站')
  })

  it('minimal mode: toggle on injects minimal defense', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({
      mode: 'minimal', agentName: '子代理', registry,
      promptInjectionDefense: true,
    })
    expect(result).toContain('提示词注入防御（上游为中转站时启用）')
    expect(result).toContain('主代理转达的用户本轮次批准')
  })

  it('none mode: toggle on is ignored', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({
      mode: 'none', agentName: '无名代理', registry,
      promptInjectionDefense: true,
    })
    expect(result.trim()).toBe('你是 无名代理。')
  })
})

describe('buildStaticPrompt — toolingContent override', () => {
  it('uses toolingContent instead of auto-generated listing', () => {
    const registry = createMockRegistry({
      systemTools: [{ name: 'read', description: '读文件' }],
    })
    const customTooling = '自定义工具列表：\n- custom_tool：自定义工具描述'
    const result = buildStaticPrompt({
      mode: 'full',
      agentName: '代理',
      registry,
      toolingContent: customTooling,
    })
    expect(result).toContain('自定义工具列表')
    expect(result).toContain('custom_tool：自定义工具描述')
    expect(result).not.toContain('read：读文件')
    expect(result).not.toContain('{tooling_section}')
  })
})

describe('buildStaticPrompt — exposedSystemToolRefs (v0.25)', () => {
  it('lists only the exposed refs when provided', () => {
    const registry = createMockRegistry({
      systemTools: [
        { name: 'read', description: '读文件' },
        { name: 'write', description: '写文件' },
        { name: 'record_m3_summary', description: 'compressor 专用' },
      ],
    })
    const result = buildStaticPrompt({
      mode: 'full',
      agentName: '代理',
      registry,
      exposedSystemToolRefs: ['read', 'write'],
    })
    expect(result).toContain('read：读文件')
    expect(result).toContain('write：写文件')
    expect(result).not.toContain('record_m3_summary')
  })

  it('skips refs that do not exist in the registry', () => {
    const registry = createMockRegistry({
      systemTools: [{ name: 'read', description: '读文件' }],
    })
    const result = buildStaticPrompt({
      mode: 'full',
      agentName: '代理',
      registry,
      exposedSystemToolRefs: ['read', 'no_such_tool'],
    })
    expect(result).toContain('read：读文件')
    expect(result).not.toContain('no_such_tool')
  })

  it('empty exposed array produces the header but no tool lines', () => {
    const registry = createMockRegistry({
      systemTools: [{ name: 'read', description: '读文件' }],
    })
    const result = buildStaticPrompt({
      mode: 'full',
      agentName: '代理',
      registry,
      exposedSystemToolRefs: [],
    })
    expect(result).toContain('你可以使用以下工具完成任务：')
    expect(result).not.toContain('read：读文件')
  })

  it('omitting exposed keeps the current full-listing behavior', () => {
    const registry = createMockRegistry({
      systemTools: [
        { name: 'read', description: '读文件' },
        { name: 'record_m3_summary', description: 'compressor 专用' },
      ],
    })
    const result = buildStaticPrompt({ mode: 'full', agentName: '代理', registry })
    expect(result).toContain('read：读文件')
    expect(result).toContain('record_m3_summary：compressor 专用')
  })

  it('mcp/skill meta display is unchanged when exposed is provided', () => {
    const registry = createMockRegistry({
      systemTools: [{ name: 'read', description: '读文件' }],
      mcpServers: [{ name: 'srv', description: '一个 server', toolNames: ['srv__t'] }],
    })
    const result = buildStaticPrompt({
      mode: 'full',
      agentName: '代理',
      registry,
      exposedSystemToolRefs: ['read'],
    })
    expect(result).toContain('load_tools')
  })
})

describe('buildStaticPrompt — deliverable path guidance (v0.24 P2)', () => {
  it('full mode: action strategy guides inline-code file path references', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({ mode: 'full', agentName: '代理', registry })
    expect(result).toContain('inline code')
    expect(result).toContain('relative paths')
    expect(result).toContain('In final responses')
  })

  it('minimal mode: final report guides inline-code file path references', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({ mode: 'minimal', agentName: '子代理', registry })
    expect(result).toContain('inline code')
    expect(result).toContain('relative paths')
    expect(result).toContain('In final reports')
  })

  it('none mode: identity shell does not contain the guidance', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({ mode: 'none', agentName: '无名代理', registry })
    expect(result).not.toContain('inline code')
    expect(result).not.toContain('relative paths')
  })
})

describe('buildStaticPrompt — model-family slot routing (v0.37)', () => {
  // The assembly passes the session's model id (assembly.ts:779). These
  // assertions prove the parameter is actually consumed end to end —
  // assembly -> buildStaticPrompt -> selectPromptTemplate -> resolvePromptVariants
  // — rather than merely accepted. The previous attempt at model-family
  // variants shipped a route that no caller ever fed.
  it('fills the persona slot from the deepseek family', () => {
    const result = buildStaticPrompt({
      mode: 'full',
      agentName: '代理',
      registry: createMockRegistry(),
      modelId: 'deepseek-v4-flash',
    })
    expect(result).toContain('Think step by step before writing')
    // DeepSeek gets the workflow with the bounded-exploration rule.
    expect(result).toContain('Bound this phase')
  })

  it('fills the persona slot from the glm family', () => {
    const result = buildStaticPrompt({
      mode: 'full',
      agentName: '代理',
      registry: createMockRegistry(),
      modelId: 'glm-5.3-flash',
    })
    expect(result).toContain('Think before you act')
    expect(result).not.toContain('Think step by step before writing')
  })

  it('falls back to the base persona when the id matches no family', () => {
    const result = buildStaticPrompt({
      mode: 'full',
      agentName: '代理',
      registry: createMockRegistry(),
      modelId: 'some-unlisted-model',
    })
    expect(result).toContain('Push forward when the goal is clear')
    expect(result).not.toContain('Think step by step before writing')
    expect(result).not.toContain('Think before you act')
  })

  it('leaves no slot placeholder behind, for any family', () => {
    for (const modelId of ['deepseek-v4-flash', 'glm-5.3-flash', 'some-unlisted-model', undefined]) {
      const result = buildStaticPrompt({
        mode: 'full',
        agentName: '代理',
        registry: createMockRegistry(),
        ...(modelId !== undefined ? { modelId } : {}),
      })
      expect(result).not.toContain('{persona_section}')
      expect(result).not.toContain('{workflow_section}')
    }
  })

  it('keeps the shared sections regardless of family', () => {
    for (const modelId of ['deepseek-v4-flash', 'glm-5.3-flash', 'some-unlisted-model']) {
      const result = buildStaticPrompt({ mode: 'full', agentName: '代理', registry: createMockRegistry(), modelId })
      expect(result).toContain('# Safety Rules')
      expect(result).toContain('# 架构管理')
      expect(result).toContain('# 记忆管理')
    }
  })

  it('does not route in minimal mode', () => {
    const result = buildStaticPrompt({
      mode: 'minimal',
      agentName: '子代理',
      registry: createMockRegistry(),
      modelId: 'deepseek-v4-flash',
    })
    expect(result).not.toContain('Think step by step before writing')
  })
})

describe('buildStaticPrompt — goal mode compression section (v0.41)', () => {
  it('full mode: goal=false preserves the default compression section', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({ mode: 'full', agentName: '代理', registry })
    // 原段包含截断戳示例
    expect(result).toContain('Truncated tool results (databus)')
    expect(result).toContain('Compressed conversation blocks')
    expect(result).not.toContain('Goal 模式下，上下文压缩由 harness 自动处理')
  })

  it('full mode: goal=true replaces compression section with goal-mode text', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({ mode: 'full', agentName: '代理', registry, goal: true })
    // goal 模式文本已注入
    expect(result).toContain('Goal 模式下，上下文压缩由 harness 自动处理')
    expect(result).toContain('#OBJECTIVE')
    expect(result).toContain('G1 本地合并')
    expect(result).toContain('G2 信封折叠')
    // 原段已被替换
    expect(result).not.toContain('Truncated tool results (databus)')
    expect(result).not.toContain('Compressed conversation blocks')
  })

  it('full mode: goal=true keeps other sections intact', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({ mode: 'full', agentName: '代理', registry, goal: true })
    expect(result).toContain('# Safety Rules')
    expect(result).toContain('# Coding Principles')
    expect(result).toContain('# 记忆管理')
    expect(result).toContain('# 架构管理')
    expect(result).toContain('{dynamic_sections}')
  })

  it('minimal mode: goal=true is ignored (no compression section to replace)', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({ mode: 'minimal', agentName: '子代理', registry, goal: true })
    expect(result).not.toContain('Goal 模式下，上下文压缩由 harness 自动处理')
    expect(result).not.toContain('Truncated tool results')
  })

  it('none mode: goal=true is ignored', () => {
    const registry = createMockRegistry()
    const result = buildStaticPrompt({ mode: 'none', agentName: '无名代理', registry, goal: true })
    expect(result.trim()).toBe('你是 无名代理。')
  })
})
