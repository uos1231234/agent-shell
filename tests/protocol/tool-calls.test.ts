import { describe, it, expect } from 'vitest'
import {
  parseToolCallArguments,
  accumulateToolCall,
  type ToolCallAccumulator,
} from '../../src/protocol/tool-calls.js'

describe('protocol/tool-calls', () => {
  describe('parseToolCallArguments', () => {
    it('parses valid JSON', () => {
      const r = parseToolCallArguments('{"path": "/tmp/foo"}')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value).toEqual({ path: '/tmp/foo' })
    })

    it('rejects invalid JSON with a descriptive error', () => {
      const r = parseToolCallArguments('not json')
      expect(r.ok).toBe(false)
    })

    it('rejects non-object JSON (e.g. arrays, primitives)', () => {
      const r1 = parseToolCallArguments('[1,2,3]')
      expect(r1.ok).toBe(false)
      const r2 = parseToolCallArguments('"hello"')
      expect(r2.ok).toBe(false)
      const r3 = parseToolCallArguments('42')
      expect(r3.ok).toBe(false)
    })
  })

  describe('accumulateToolCall', () => {
    it('builds a complete ToolCall from streamed deltas', () => {
      let acc: ToolCallAccumulator = { id: '', name: '', arguments: '' }
      acc = accumulateToolCall(acc, { index: 0, id: 'tc-1', name: 'read_file' })
      acc = accumulateToolCall(acc, { index: 0, arguments_delta: '{"path"' })
      acc = accumulateToolCall(acc, { index: 0, arguments_delta: ':"/tmp/a"}' })
      expect(acc.id).toBe('tc-1')
      expect(acc.name).toBe('read_file')
      expect(acc.arguments).toBe('{"path":"/tmp/a"}')
    })

    it('handles empty deltas (no-op)', () => {
      const acc = accumulateToolCall({ id: 'a', name: 'b', arguments: '{}' }, { index: 0 })
      expect(acc).toEqual({ id: 'a', name: 'b', arguments: '{}' })
    })
  })
})
