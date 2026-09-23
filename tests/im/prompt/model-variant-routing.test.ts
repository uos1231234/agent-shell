// Tests for model-family slot routing — v0.37, minimal routing added v0.39
//
// The full template is ONE artifact with two injectable slots
// ({persona_section} / {workflow_section}); the minimal (sub-agent) template
// carries the workflow slot only. These tests pin the structural guarantee
// that makes this design worth having: routing can change only the persona
// and workflow sections. Every shared section — safety rules, coding
// principles, the tool listing, the ARCHITECTURE.md / MEMORY.md contracts —
// survives intact for every model family, including unmatched ones.
//
// A variant that can silently drop a safety rule or an architecture contract is
// the exact failure this structure exists to prevent, so it is asserted, not
// assumed.

import { describe, it, expect } from 'vitest'
import {
  resolvePromptVariants,
  selectPromptTemplate,
  NONE_PROMPT_TEMPLATE,
} from '../../../src/im/prompt/static-prompt.js'

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1

/** Sections that must appear exactly once no matter which family was routed. */
const SHARED_SECTIONS = [
  '# Safety Rules',
  '# Coding Principles',
  '# Code-Information-Driven Programming',
  '# Tool Usage Guide',
  '# Action Strategy',
  '# 架构管理',
  '# 记忆管理',
]

describe('resolvePromptVariants — routing', () => {
  it('routes a deepseek id to the DeepSeek persona AND the DeepSeek workflow', () => {
    const v = resolvePromptVariants('deepseek-v3.2')
    expect(v.persona).toContain('Think step by step before writing')
    expect(v.persona).toContain('Never guess at an API')
    // The DeepSeek workflow carries the explicit bounded-exploration rule.
    expect(v.workflow).toContain('Bound this phase')
    expect(v.workflow).toContain('Stop and change approach immediately')
  })

  it('routes a glm id to the GLM persona but keeps the default workflow', () => {
    const glm = resolvePromptVariants('glm-4.6')
    const unmatched = resolvePromptVariants('some-unknown-model')
    expect(glm.persona).toContain('Think before you act')
    expect(glm.persona).not.toBe(unmatched.persona)
    // GLM reuses the base workflow — no family-specific workflow was written for it.
    expect(glm.workflow).toBe(unmatched.workflow)
  })

  it('matches case-insensitively and on substrings anywhere in the id', () => {
    expect(resolvePromptVariants('DeepSeek-V3').persona).toBe(resolvePromptVariants('deepseek-chat').persona)
    expect(resolvePromptVariants('vendor/GLM-4.6').persona).toBe(resolvePromptVariants('glm').persona)
    // v0.38 new families
    expect(resolvePromptVariants('Kimi-K2').persona).toBe(resolvePromptVariants('kimi').persona)
    expect(resolvePromptVariants('QWen3.5').persona).toBe(resolvePromptVariants('qwen').persona)
    expect(resolvePromptVariants('GPT-5.5').persona).toBe(resolvePromptVariants('gpt-oss').persona)
    expect(resolvePromptVariants('Claude-4').persona).toBe(resolvePromptVariants('claude').persona)
  })

  it('falls back to the base sections for an unmatched model id and for no id at all', () => {
    // avoid any family substring ('unknown-model', not a gpt/claude/etc id)
    const unknown = resolvePromptVariants('completely-unknown-model')
    const absent = resolvePromptVariants(undefined)
    expect(unknown.persona).toBe(absent.persona)
    expect(unknown.workflow).toBe(absent.workflow)
    // The base persona is the generic one, not a family variant.
    expect(unknown.persona).not.toContain('Think step by step before writing')
    expect(unknown.workflow).toContain('# Workflow')
  })
})

describe('selectPromptTemplate — slot filling', () => {
  it('fills both slots and leaves no placeholder behind (full mode)', () => {
    const out = selectPromptTemplate('full', 'deepseek-chat')
    expect(out).not.toContain('{persona_section}')
    expect(out).not.toContain('{workflow_section}')
    // The persona section brings {agent_name} back in; buildStaticPrompt replaces it.
    expect(out).toContain('{agent_name}')
    expect(out).toContain('# Workflow')
  })

  for (const modelId of [
    'deepseek-chat',
    'glm-4.6',
    'kimi-k2',
    'qwen3.5',
    'gpt-5.5',
    'claude-4',
    'some-unknown-model',
    undefined,
  ]) {
    it(`keeps every shared section exactly once for ${modelId ?? '(no model id)'}`, () => {
      const out = selectPromptTemplate('full', modelId)
      for (const section of SHARED_SECTIONS) {
        expect(count(out, section), `${section} should appear exactly once`).toBe(1)
      }
      // The two contracts this project cannot afford to lose:
      expect(out).toContain('ARCHITECTURE.md')
      expect(out).toContain('MEMORY.md')
      // Safety rules survive verbatim — not a reduced subset.
      expect(count(out, 'obtain authorization')).toBe(2) // delete + sudo rules
      expect(out).toContain('list_processes')
      expect(out).toContain('nginx.conf')
    })
  }

  it('routes the deepseek persona into the assembled prompt', () => {
    expect(selectPromptTemplate('full', 'deepseek-chat')).toContain('an engineer with a keyboard and a deadline')
  })

  it('routes the four new families to their persona/workflow (v0.38)', () => {
    const kimi = resolvePromptVariants('kimi-k2')
    expect(kimi.persona).toContain('Take action with tools')
    expect(kimi.workflow).toBe(resolvePromptVariants(undefined).workflow) // reuses base

    const qwen = resolvePromptVariants('qwen3.5')
    expect(qwen.persona).toContain('Search and read before you edit')
    expect(qwen.workflow).toContain('Stop searching and start editing')

    const gpt = resolvePromptVariants('gpt-5.5')
    expect(gpt.persona).toContain('Act first, ask only when blocked')
    expect(gpt.workflow).toContain('Investigate')

    const claude = resolvePromptVariants('claude-4')
    expect(claude.persona).toContain('do not quietly narrow, widen, or transform')
    expect(claude.workflow).toBe(resolvePromptVariants(undefined).workflow) // reuses base
  })

  it('routes the workflow slot in minimal mode (v0.39); none mode stays untouched', () => {
    // v0.39: minimal carries the workflow slot so family-tuned action
    // discipline reaches sub-agents — the surface that executes delegated work.
    const deepseek = selectPromptTemplate('minimal', 'deepseek-chat')
    expect(deepseek).not.toContain('{workflow_section}')
    expect(deepseek).toContain('# Workflow')
    // DeepSeek's bounded-exploration discipline reaches sub-agents too.
    expect(deepseek).toContain('Do not use shell commands to read or edit files')
    // The persona slot stays out of minimal: sub-agent identity is anchored by
    // cfg.systemPrompt (run-subagent layer ①), not by the family persona.
    expect(deepseek).not.toContain('{persona_section}')
    expect(deepseek).not.toContain('an engineer with a keyboard and a deadline')
    // Unmatched ids fall back to the base workflow, same as full mode.
    expect(selectPromptTemplate('minimal', 'completely-unknown-model')).toContain(
      'Follow these phases for every non-trivial task',
    )
    // none mode keeps its identity line and nothing else.
    expect(selectPromptTemplate('none', 'deepseek-chat')).toBe(NONE_PROMPT_TEMPLATE)
  })

  it('injects the delegation authorization into full mode only when granted (v0.40)', () => {
    const granted = selectPromptTemplate('full', 'glm-4.6', true)
    expect(granted).toContain('# Delegation Authorization')
    expect(granted).toContain('depth of 3')
    expect(granted).not.toContain('{delegation_section}')
    // Conditional is per-call: denied keeps the persona → Safety Rules layout.
    const denied = selectPromptTemplate('full', 'glm-4.6', false)
    expect(denied).not.toContain('# Delegation Authorization')
    expect(denied).not.toContain('{delegation_section}')
    // Omitted third arg behaves exactly like denied (backward compatible).
    expect(selectPromptTemplate('full', 'glm-4.6')).toBe(denied)
  })

  it('flips the minimal nesting prohibition into delegation teaching when granted (v0.40)', () => {
    const granted = selectPromptTemplate('minimal', 'deepseek-chat', true)
    expect(granted).toContain('You are authorized to spawn sub-agents')
    expect(granted).toContain('depth of 3')
    expect(granted).not.toContain('Do not spawn further sub-agents')
    expect(granted).not.toContain('{delegation_section}')

    const denied = selectPromptTemplate('minimal', 'deepseek-chat', false)
    expect(denied).toContain('Do not spawn further sub-agents. Complete the assignment yourself with the tools you have.')
    expect(denied).not.toContain('You are authorized to spawn sub-agents')
    // The pre-v0.40 minimal behavior is preserved verbatim when not granted.
    expect(selectPromptTemplate('minimal', 'deepseek-chat')).toBe(denied)
  })
})
