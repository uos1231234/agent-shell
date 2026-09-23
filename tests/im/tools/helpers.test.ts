// Tests for the shared tool helpers extracted in v0.10.2.1.
//
// These pin the three behaviours that wrapTool must guarantee for every
// tool (v0.9 builtins + v0.10 system-agent tools):
//   1. Missing/empty `reason` → re-throws (loop.ts formats the sentence).
//   2. A thrown error inside the executor → re-throws unchanged.
//   3. The optional ctx (ToolContext) is passed through to the executor.
//
// P0 (修复方案1.md): wrapTool re-throws instead of catching. Sentence
// formatting happens exactly once in loop.ts:executeToolCalls' catch
// (the single isError marking point, ADR-013). Swallowing here made the
// errorRate guard blind to all wrapped (production) tool failures.

import { describe, it, expect } from 'vitest'
import { wrapTool, requireReason, toSchema, reasonField, dropReason } from '../../../src/im/tools/helpers.js'
import type { ToolContext } from '../../../src/shared/tool-context.js'

describe('im/tools/helpers', () => {
  describe('requireReason', () => {
    it('returns the reason string when present', () => {
      expect(requireReason({ reason: 'because' }, 'my_tool')).toBe('because')
    })

    it('throws when reason is missing', () => {
      expect(() => requireReason({}, 'my_tool')).toThrow('my_tool requires a "reason"')
    })

    it('throws when reason is empty string', () => {
      expect(() => requireReason({ reason: '' }, 'my_tool')).toThrow('my_tool requires a "reason"')
    })

    it('throws when reason is not a string', () => {
      expect(() => requireReason({ reason: 42 }, 'my_tool')).toThrow('my_tool requires a "reason"')
    })
  })

  describe('wrapTool', () => {
    it('returns executor result on success', async () => {
      const wrapped = wrapTool('test_tool', async (args: { reason?: unknown }) => {
        return `got: ${args.reason}`
      })
      const result = await wrapped({ reason: 'hello' })
      expect(result).toBe('got: hello')
    })

    it('re-throws when reason is missing', async () => {
      const wrapped = wrapTool('test_tool', async () => 'should not reach')
      await expect(wrapped({})).rejects.toThrow('test_tool requires a "reason"')
    })

    it('re-throws when executor throws', async () => {
      const wrapped = wrapTool('boom_tool', async () => {
        throw new Error('explosion')
      })
      await expect(wrapped({ reason: 'go' })).rejects.toThrow('explosion')
    })

    it('passes ctx through to the executor', async () => {
      const ctx: ToolContext = { stateLine: { query: () => null } as never }
      const wrapped = wrapTool('ctx_tool', async (_args, c) => {
        return c === ctx ? 'ctx passed' : 'ctx lost'
      })
      const result = await wrapped({ reason: 'test' }, ctx)
      expect(result).toBe('ctx passed')
    })

    it('works with null raw input (defaults to empty object)', async () => {
      const wrapped = wrapTool('null_tool', async () => 'ok')
      // null → {} → missing reason → re-throws
      await expect(wrapped(null)).rejects.toThrow(/null_tool requires a "reason"/)
    })
  })

  describe('toSchema', () => {
    it('builds an object schema with properties and required', () => {
      const schema = toSchema(
        { x: { type: 'string' }, reason: reasonField },
        ['x'],
      )
      expect(schema.type).toBe('object')
      expect(schema.properties).toHaveProperty('x')
      expect(schema.properties).toHaveProperty('reason')
      expect(schema.required).toEqual(['x'])
    })

    it('reason is NOT in required (ADR-013)', () => {
      const schema = toSchema(
        { reason: reasonField },
        [],
      )
      expect(schema.required).not.toContain('reason')
    })
  })

  describe('reasonField', () => {
    it('is a string type with a description mentioning required', () => {
      expect(reasonField.type).toBe('string')
      expect(reasonField.description).toMatch(/required/i)
    })
  })

  describe('dropReason', () => {
    it('removes reason from the object', () => {
      const input = { x: 1, reason: 'because' }
      const result = dropReason(input)
      expect(result).toEqual({ x: 1 })
      expect(result).not.toHaveProperty('reason')
    })

    it('works on objects without reason', () => {
      const result = dropReason({ x: 1 })
      expect(result).toEqual({ x: 1 })
    })
  })
})
