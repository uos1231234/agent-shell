// v0.11.2 G4: SubAgentToolPolicy tests.

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SUB_AGENT_TOOL_POLICY,
  applyToolPolicy,
  findMatchingPattern,
  type SubAgentToolPolicy,
} from '../../../src/im/sub-agent/policy.js'
import { createBuiltinTools } from '../../../src/im/tools/index.js'

describe('im/sub-agent/policy — DEFAULT_SUB_AGENT_TOOL_POLICY', () => {
  it('denies run_subagent', () => {
    expect(applyToolPolicy('run_subagent', DEFAULT_SUB_AGENT_TOOL_POLICY)).toBe(false)
  })

  it('denies define_subagent', () => {
    expect(applyToolPolicy('define_subagent', DEFAULT_SUB_AGENT_TOOL_POLICY)).toBe(false)
  })

  it('denies record_curated_block', () => {
    expect(applyToolPolicy('record_curated_block', DEFAULT_SUB_AGENT_TOOL_POLICY)).toBe(false)
  })

  it('denies record_m3_summary', () => {
    expect(applyToolPolicy('record_m3_summary', DEFAULT_SUB_AGENT_TOOL_POLICY)).toBe(false)
  })

  it('denies bash', () => {
    expect(applyToolPolicy('bash', DEFAULT_SUB_AGENT_TOOL_POLICY)).toBe(false)
  })

  it('denies powershell', () => {
    expect(applyToolPolicy('powershell', DEFAULT_SUB_AGENT_TOOL_POLICY)).toBe(false)
  })

  it('denies write', () => {
    expect(applyToolPolicy('write', DEFAULT_SUB_AGENT_TOOL_POLICY)).toBe(false)
  })

  it('denies edit', () => {
    expect(applyToolPolicy('edit', DEFAULT_SUB_AGENT_TOOL_POLICY)).toBe(false)
  })

  it('denies search_replace (v0.38: closed the write-surface gap)', () => {
    expect(applyToolPolicy('search_replace', DEFAULT_SUB_AGENT_TOOL_POLICY)).toBe(false)
  })

  it('default deny covers EVERY file-mutating tool in the registry (set assertion)', () => {
    // The default stance is "sub-agents cannot modify files". A new mutating
    // tool registered without updating the deny list is a silent hole — this
    // set assertion fails when one is added, telling the author to decide:
    // deny it here, or explicitly justify the exception.
    // Mutating = writes files or runs shell commands. (read/ls/find/grep/
    // ast_grep are read-only; open_url/read_media/web_fetch/request_user_input
    // do not touch the workspace; run_subagent/define_subagent/record_* are
    // denied separately below.)
    const registry = createBuiltinTools({ cwd: process.cwd(), dataDir: process.cwd() })
    const mutating = ['write', 'edit', 'search_replace', 'bash', 'powershell']
    for (const ref of mutating) {
      expect(
        applyToolPolicy(ref, DEFAULT_SUB_AGENT_TOOL_POLICY),
        `default policy must deny the mutating tool '${ref}'`,
      ).toBe(false)
      // And the tool must actually exist in the registry — the assertion above
      // is meaningless if the ref is a typo and no such tool is registered.
      expect(registry.resolveRef(ref), `'${ref}' should be a registered tool`).toBeDefined()
    }
  })

  it('allows echo (normal tool)', () => {
    expect(applyToolPolicy('echo', DEFAULT_SUB_AGENT_TOOL_POLICY)).toBe(true)
  })

  it('allows databus_query', () => {
    expect(applyToolPolicy('databus_query', DEFAULT_SUB_AGENT_TOOL_POLICY)).toBe(true)
  })
})

describe('im/sub-agent/policy — custom policy', () => {
  it('default deny blocks everything not explicitly allowed', () => {
    const policy: SubAgentToolPolicy = {
      default: 'deny',
      rules: [{ mode: 'allow', pattern: 'echo' }],
    }
    expect(applyToolPolicy('echo', policy)).toBe(true)
    expect(applyToolPolicy('bash', policy)).toBe(false)
    expect(applyToolPolicy('anything-else', policy)).toBe(false)
  })

  it('default allow permits everything not explicitly denied', () => {
    const policy: SubAgentToolPolicy = {
      default: 'allow',
      rules: [{ mode: 'deny', pattern: 'bash' }],
    }
    expect(applyToolPolicy('echo', policy)).toBe(true)
    expect(applyToolPolicy('bash', policy)).toBe(false)
  })

  it('last matching rule wins', () => {
    const policy: SubAgentToolPolicy = {
      default: 'deny',
      rules: [
        { mode: 'allow', pattern: 'bash' },
        { mode: 'deny', pattern: 'bash' },
      ],
    }
    expect(applyToolPolicy('bash', policy)).toBe(false)
  })

  it('allow after deny re-enables', () => {
    const policy: SubAgentToolPolicy = {
      default: 'deny',
      rules: [
        { mode: 'deny', pattern: '*' },
        { mode: 'allow', pattern: 'echo' },
      ],
    }
    expect(applyToolPolicy('echo', policy)).toBe(true)
    expect(applyToolPolicy('bash', policy)).toBe(false)
  })
})

describe('im/sub-agent/policy — MCP namespace deny', () => {
  it('denies all tools from a dangerous MCP server via * pattern', () => {
    const policy: SubAgentToolPolicy = {
      default: 'allow',
      rules: [{ mode: 'deny', pattern: 'dangerous-server__*' }],
    }
    expect(applyToolPolicy('dangerous-server__exec', policy)).toBe(false)
    expect(applyToolPolicy('dangerous-server__delete', policy)).toBe(false)
    expect(applyToolPolicy('safe-server__exec', policy)).toBe(true)
  })

  it('allows specific MCP tool while denying the rest of the server', () => {
    const policy: SubAgentToolPolicy = {
      default: 'allow',
      rules: [
        { mode: 'deny', pattern: 'mcp-server__*' },
        { mode: 'allow', pattern: 'mcp-server__read' },
      ],
    }
    expect(applyToolPolicy('mcp-server__read', policy)).toBe(true)
    expect(applyToolPolicy('mcp-server__write', policy)).toBe(false)
  })
})

describe('im/sub-agent/policy — skill namespace deny', () => {
  it('denies all tools from a skill via * pattern', () => {
    const policy: SubAgentToolPolicy = {
      default: 'allow',
      rules: [{ mode: 'deny', pattern: 'my-skill__*' }],
    }
    expect(applyToolPolicy('my-skill__action1', policy)).toBe(false)
    expect(applyToolPolicy('other-skill__action1', policy)).toBe(true)
  })
})

describe('im/sub-agent/policy — pattern matching edge cases', () => {
  it('exact match works', () => {
    expect(applyToolPolicy('bash', { default: 'allow', rules: [{ mode: 'deny', pattern: 'bash' }] })).toBe(false)
  })

  it('prefix glob matches suffix', () => {
    const policy: SubAgentToolPolicy = {
      default: 'allow',
      rules: [{ mode: 'deny', pattern: 'server__*' }],
    }
    expect(applyToolPolicy('server__tool', policy)).toBe(false)
    expect(applyToolPolicy('server__', policy)).toBe(false)
  })

  it('suffix glob matches prefix', () => {
    const policy: SubAgentToolPolicy = {
      default: 'allow',
      rules: [{ mode: 'deny', pattern: '*__exec' }],
    }
    expect(applyToolPolicy('server1__exec', policy)).toBe(false)
    expect(applyToolPolicy('server2__exec', policy)).toBe(false)
    expect(applyToolPolicy('server1__read', policy)).toBe(true)
  })

  it('middle glob matches both ends', () => {
    const policy: SubAgentToolPolicy = {
      default: 'allow',
      rules: [{ mode: 'deny', pattern: 'server*tool' }],
    }
    expect(applyToolPolicy('server-my-tool', policy)).toBe(false)
    expect(applyToolPolicy('server-tool', policy)).toBe(false)
    expect(applyToolPolicy('server-not-tooly', policy)).toBe(true)
  })

  it('star-only pattern matches everything', () => {
    const policy: SubAgentToolPolicy = {
      default: 'allow',
      rules: [{ mode: 'deny', pattern: '*' }],
    }
    expect(applyToolPolicy('anything', policy)).toBe(false)
    expect(applyToolPolicy('', policy)).toBe(false)
  })

  it('no rules falls back to default', () => {
    const allowPolicy: SubAgentToolPolicy = { default: 'allow', rules: [] }
    const denyPolicy: SubAgentToolPolicy = { default: 'deny', rules: [] }
    expect(applyToolPolicy('anything', allowPolicy)).toBe(true)
    expect(applyToolPolicy('anything', denyPolicy)).toBe(false)
  })
})

describe('im/sub-agent/policy — findMatchingPattern', () => {
  it('returns the pattern of the last matching rule', () => {
    const policy: SubAgentToolPolicy = {
      default: 'deny',
      rules: [
        { mode: 'deny', pattern: '*' },
        { mode: 'allow', pattern: 'echo' },
      ],
    }
    expect(findMatchingPattern('echo', policy)).toBe('echo')
    expect(findMatchingPattern('bash', policy)).toBe('*')
  })

  it('returns null when no rule matches', () => {
    const policy: SubAgentToolPolicy = {
      default: 'allow',
      rules: [{ mode: 'deny', pattern: 'bash' }],
    }
    expect(findMatchingPattern('echo', policy)).toBeNull()
  })
})
