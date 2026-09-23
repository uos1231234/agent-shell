// Tests for static-prompt templates — v0.19 D9/D10
//
// ⚠️ UPDATED FOR BENCHMARK TESTING: assertions changed from Chinese to English
// to match the translated templates. Revert when reverting to Chinese prompts.
// See: 测试阅读（测试结束记得删除）.md
//
// Invariants:
//   - FULL_PROMPT_TEMPLATE contains safety rules, coding principles,
//     code-info programming, tool usage guide, action strategy.
//   - MINIMAL_PROMPT_TEMPLATE omits tool usage guide and action strategy.
//   - NONE_PROMPT_TEMPLATE only contains the identity line.

import { describe, it, expect } from 'vitest'
import { FULL_PROMPT_TEMPLATE, MINIMAL_PROMPT_TEMPLATE, NONE_PROMPT_TEMPLATE, FULL_PROMPT_INJECTION_DEFENSE, MINIMAL_PROMPT_INJECTION_DEFENSE, MINIMAL_DELEGATION_PROHIBITION } from '../../../src/im/prompt/static-prompt.js'

describe('FULL_PROMPT_TEMPLATE', () => {
  it('contains safety rules section', () => {
    expect(FULL_PROMPT_TEMPLATE).toContain('# Safety Rules')
    expect(FULL_PROMPT_TEMPLATE).toContain('obtain authorization')
    expect(FULL_PROMPT_TEMPLATE).toContain('request_user_input')
    expect(FULL_PROMPT_TEMPLATE).toContain('sudo')
    expect(FULL_PROMPT_TEMPLATE).toContain('sensitive')
    expect(FULL_PROMPT_TEMPLATE).toContain('240-second timeout')
    expect(FULL_PROMPT_TEMPLATE).toContain('timeout: null')
    expect(FULL_PROMPT_TEMPLATE).toContain('find /')
  })

  it('contains {work_dir} placeholder in safety rules', () => {
    expect(FULL_PROMPT_TEMPLATE).toContain('{work_dir}')
    expect(MINIMAL_PROMPT_TEMPLATE).toContain('{work_dir}')
  })

  it('contains the delegation slot after the persona (v0.40)', () => {
    expect(FULL_PROMPT_TEMPLATE).toContain('{persona_section}\n\n{delegation_section}')
    expect(MINIMAL_PROMPT_TEMPLATE).toContain('{delegation_section}')
  })

  it('keeps the delegation prohibition as the verbatim fallback (v0.40)', () => {
    expect(MINIMAL_DELEGATION_PROHIBITION).toBe(
      '- Do not spawn further sub-agents. Complete the assignment yourself with the tools you have.',
    )
  })

  it('discloses the compression envelope (2026-09-13 原位信封替代)', () => {
    expect(FULL_PROMPT_TEMPLATE).toContain('## 2. Compressed conversation blocks')
    expect(FULL_PROMPT_TEMPLATE).toContain('#STAMP')
    expect(FULL_PROMPT_TEMPLATE).toContain('#END_BLOCK')
    expect(FULL_PROMPT_TEMPLATE).toContain('REPLACES the original span in place')
    // 用户指定的中文强调句。
    expect(FULL_PROMPT_TEMPLATE).toContain('压缩后的对话块会以信封形式留在原位置，戳就在信封里')
    // 方案 A：#NOTE 不再声称 raw-archive 一定有全文；工具戳在压缩后仍有效。
    expect(FULL_PROMPT_TEMPLATE).toContain('工具全文仍在 databus')
    expect(FULL_PROMPT_TEMPLATE).toContain('块压缩不清空 databus')
    // MINIMAL（子代理模板）不含压缩召回段。
    expect(MINIMAL_PROMPT_TEMPLATE).not.toContain('#STAMP')
  })

  it('discloses the mailbox: tombstones, the 50-mail cap, and delegation to the recall agent (2026-09-23)', () => {
    // 承重背景：mailbox 指引曾只写进 working-agent.md——那个文件**没有接线**
    // （只有测试引用），真提示词是本模板经 buildStaticPrompt 构建。结果 r7
    // 实测模型 0 次工具调用。本断言钉住：指引必须出现在**真提示词**里。
    expect(FULL_PROMPT_TEMPLATE).toContain('## 3. Mailbox')
    expect(FULL_PROMPT_TEMPLATE).toContain('swap-out tombstones')
    expect(FULL_PROMPT_TEMPLATE).toContain('mail bodies are NOT injected')
    expect(FULL_PROMPT_TEMPLATE).toContain('hard-capped at 50 mails per call')
    expect(FULL_PROMPT_TEMPLATE).toContain('mailbox_read_any')
    expect(FULL_PROMPT_TEMPLATE).toContain('delegate the bulk read')
    // MINIMAL（子代理模板）不含 mailbox 段。
    expect(MINIMAL_PROMPT_TEMPLATE).not.toContain('mailbox_read_any')
  })

  it('does NOT hard-code injection defense into the base template', () => {
    expect(FULL_PROMPT_TEMPLATE).not.toContain('Prompt injection defense')
    expect(FULL_PROMPT_TEMPLATE).not.toContain('third-party relay')
  })

  it('contains coding principles section', () => {
    expect(FULL_PROMPT_TEMPLATE).toContain('# Coding Principles')
    expect(FULL_PROMPT_TEMPLATE).toContain('cohesion')
    expect(FULL_PROMPT_TEMPLATE).toContain('correct code')
  })

  it('contains code-info programming section', () => {
    expect(FULL_PROMPT_TEMPLATE).toContain('# Code-Information-Driven Programming')
    expect(FULL_PROMPT_TEMPLATE).toContain('API behavior')
    expect(FULL_PROMPT_TEMPLATE).toContain('tsc --noEmit')
  })

  it('contains tool usage guide placeholder', () => {
    expect(FULL_PROMPT_TEMPLATE).toContain('# Tool Usage Guide')
    expect(FULL_PROMPT_TEMPLATE).toContain('{tooling_section}')
  })

  it('contains action strategy section', () => {
    expect(FULL_PROMPT_TEMPLATE).toContain('# Action Strategy')
    expect(FULL_PROMPT_TEMPLATE).toContain('Execute explicit instructions')
  })

  it('contains dynamic_sections placeholder', () => {
    expect(FULL_PROMPT_TEMPLATE).toContain('{dynamic_sections}')
  })

  it('carries the two model-family slots (v0.37) and no agent_name of its own', () => {
    expect(FULL_PROMPT_TEMPLATE).toContain('{persona_section}')
    expect(FULL_PROMPT_TEMPLATE).toContain('{workflow_section}')
    // {agent_name} now lives inside the persona section, not in the base template.
    expect(FULL_PROMPT_TEMPLATE).not.toContain('{agent_name}')
  })
})

describe('MINIMAL_PROMPT_TEMPLATE', () => {
  it('contains safety rules section', () => {
    expect(MINIMAL_PROMPT_TEMPLATE).toContain('# Safety Rules')
    expect(MINIMAL_PROMPT_TEMPLATE).toContain('240-second timeout')
    expect(MINIMAL_PROMPT_TEMPLATE).toContain('timeout: null')
  })

  it('contains coding principles section', () => {
    expect(MINIMAL_PROMPT_TEMPLATE).toContain('# Coding Principles')
  })

  it('contains code-info programming section', () => {
    expect(MINIMAL_PROMPT_TEMPLATE).toContain('# Code-Information-Driven Programming')
  })

  it('does NOT contain tool usage guide', () => {
    expect(MINIMAL_PROMPT_TEMPLATE).not.toContain('# Tool Usage Guide')
    expect(MINIMAL_PROMPT_TEMPLATE).not.toContain('{tooling_section}')
  })

  it('does NOT contain action strategy', () => {
    expect(MINIMAL_PROMPT_TEMPLATE).not.toContain('# Action Strategy')
  })

  it('contains workflow_section placeholder (family-routed for sub-agents, v0.39)', () => {
    expect(MINIMAL_PROMPT_TEMPLATE).toContain('{workflow_section}')
  })

  it('does NOT contain persona slot (sub-agent identity is anchored by cfg.systemPrompt)', () => {
    expect(MINIMAL_PROMPT_TEMPLATE).not.toContain('{persona_section}')
  })

  it('contains dynamic_sections placeholder', () => {
    expect(MINIMAL_PROMPT_TEMPLATE).toContain('{dynamic_sections}')
  })

  it('contains agent_name placeholder', () => {
    expect(MINIMAL_PROMPT_TEMPLATE).toContain('{agent_name}')
  })
})

describe('injection defense sections (optional, toggle-gated)', () => {
  it('FULL defense is opt-in and asks for this-turn authorization', () => {
    const d = FULL_PROMPT_INJECTION_DEFENSE
    // ⚠️ These constants are still in Chinese (not translated for benchmark)
    expect(d).toContain('提示词注入防御')
    expect(d).toContain('敏感')
    expect(d).toContain('request_user_input')
    expect(d).toContain('不可信')
  })

  it('MINIMAL defense routes through main agent', () => {
    const d = MINIMAL_PROMPT_INJECTION_DEFENSE
    expect(d).toContain('提示词注入防御')
    expect(d).toContain('主代理')
  })
})

describe('NONE_PROMPT_TEMPLATE', () => {
  it('only contains the identity line', () => {
    expect(NONE_PROMPT_TEMPLATE.trim()).toContain('{agent_name}')
  })

  it('does NOT contain any section headers', () => {
    expect(NONE_PROMPT_TEMPLATE).not.toContain('# Safety Rules')
    expect(NONE_PROMPT_TEMPLATE).not.toContain('# Coding Principles')
    expect(NONE_PROMPT_TEMPLATE).not.toContain('# Code-Information-Driven Programming')
    expect(NONE_PROMPT_TEMPLATE).not.toContain('# Tool Usage Guide')
    expect(NONE_PROMPT_TEMPLATE).not.toContain('# Action Strategy')
  })

  it('does NOT contain dynamic_sections placeholder', () => {
    expect(NONE_PROMPT_TEMPLATE).not.toContain('{dynamic_sections}')
  })
})

// ⚠️ REMOVED: 'templates are pure Chinese' test block
// This invariant no longer applies after English translation for benchmark testing.
// Revert this removal when reverting to Chinese prompts.
