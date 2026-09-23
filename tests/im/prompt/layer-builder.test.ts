// Tests for buildLayeredPrompt — priority-based merging of prompt layers.
//
// Invariants:
//   - Layers are sorted ascending by priority (lower priority first).
//   - Empty-content layers are filtered out.
//   - Multiple layers are joined with '\n\n'.
//   - Original order is preserved for equal priorities (stable sort).

import { describe, it, expect } from 'vitest'
import { buildLayeredPrompt } from '../../../src/im/prompt/layer-builder.js'
import type { PromptLayer } from '../../../src/im/prompt/types.js'

describe('buildLayeredPrompt', () => {
  it('returns empty string for empty array', () => {
    expect(buildLayeredPrompt([])).toBe('')
  })

  it('returns single layer content unchanged', () => {
    const layers: PromptLayer[] = [
      { name: 'project', content: 'hello world', priority: 20 },
    ]
    expect(buildLayeredPrompt(layers)).toBe('hello world')
  })

  it('sorts layers by priority ascending', () => {
    const layers: PromptLayer[] = [
      { name: 'local', content: 'local content', priority: 30 },
      { name: 'managed', content: 'managed content', priority: 0 },
      { name: 'project', content: 'project content', priority: 20 },
      { name: 'user', content: 'user content', priority: 10 },
    ]
    const result = buildLayeredPrompt(layers)
    expect(result).toBe(
      'managed content\n\nuser content\n\nproject content\n\nlocal content'
    )
  })

  it('preserves original order for equal priorities', () => {
    const layers: PromptLayer[] = [
      { name: 'project', content: 'first', priority: 20 },
      { name: 'local', content: 'second', priority: 20 },
    ]
    const result = buildLayeredPrompt(layers)
    // Both have priority 20; original order should be preserved
    expect(result).toBe('first\n\nsecond')
  })

  it('filters out empty-content layers', () => {
    const layers: PromptLayer[] = [
      { name: 'managed', content: 'managed content', priority: 0 },
      { name: 'user', content: '', priority: 10 },
      { name: 'project', content: 'project content', priority: 20 },
    ]
    const result = buildLayeredPrompt(layers)
    expect(result).toBe('managed content\n\nproject content')
  })

  it('joins multiple layers with double newline', () => {
    const layers: PromptLayer[] = [
      { name: 'managed', content: 'a', priority: 0 },
      { name: 'user', content: 'b', priority: 10 },
    ]
    expect(buildLayeredPrompt(layers)).toBe('a\n\nb')
  })

  it('does not mutate the input array', () => {
    const layers: PromptLayer[] = [
      { name: 'local', content: 'local', priority: 30 },
      { name: 'managed', content: 'managed', priority: 0 },
    ]
    const original = [...layers]
    buildLayeredPrompt(layers)
    expect(layers).toEqual(original)
  })
})
