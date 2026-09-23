import { describe, expect, it } from 'vitest'

import { createSubmitCuratedMemoryTool } from '../../../src/im/tools/submit-curated-memory.js'

const validMemory = {
  task_goal: 'compress the task block',
  causal_steps: [{
    intent: 'inspect the block',
    tool_action: 'read',
    result: 'block inspected',
  }],
  evidence_fragments: [{
    source: 'tool',
    fragment: 'evidence',
    relevance: 'supports the conclusion',
  }],
  conclusion: 'compression completed',
  next_action: 'none',
  working_state: {
    current_goal: 'finish compression',
    effective_decisions: [],
    rejected_decisions: [],
    architecture_boundaries: [],
    remaining_work: [],
  },
  status_hint: 'DONE',
}

describe('submit_curated_memory identity and validation', () => {
  it('accepts a valid submission from the compressor', async () => {
    const tool = createSubmitCuratedMemoryTool()
    const result = await tool.execute(
      { memory: validMemory, reason: 'submit compressed block' },
      { agentId: 'compressor' },
    )

    expect(result).toBe(JSON.stringify({ ok: true }))
  })

  it('rejects an invalid submission in-conversation without throwing', async () => {
    const tool = createSubmitCuratedMemoryTool()
    const result = await tool.execute(
      {
        memory: { ...validMemory, working_state: undefined },
        reason: 'submit incomplete block',
      },
      { agentId: 'compressor' },
    )

    expect(result).toContain('提交被拒绝')
    expect(result).toContain('working_state')
  })

  it.each([
    ['main', { agentId: 'main' }],
    ['warehouse', { agentId: 'warehouse' }],
    ['recall', { agentId: 'recall' }],
    ['missing context', undefined],
  ])('rejects execution from %s', async (_label, ctx) => {
    const tool = createSubmitCuratedMemoryTool()

    await expect(
      tool.execute(
        { memory: validMemory, reason: 'unauthorized submission' },
        ctx,
      ),
    ).rejects.toThrow('restricted to the compressor system agent')
  })
})
