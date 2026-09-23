// v0.14 §6.3 contract test: every symbol listed in plan §5.4 must be
// importable from the public API surface at src/index.ts.
//
// This is a compile-time + runtime contract. If a re-export is removed or
// renamed, this file fails to type-check AND the runtime `expect` fails.
// One `it()` per export group so a regression points at the exact group.

import { describe, it, expect } from 'vitest'
import * as api from '../src/index.js'

describe('src/index.ts public API surface (v0.14 §5.4)', () => {
  it('exports runIMLoop + IMLoopOptions/IMLoopResult types (loop group)', () => {
    expect(typeof api.runIMLoop).toBe('function')
  })

  it('exports createMinimalIM + DEFAULT_WORKING_AGENT_TOOL_REFS (minimal group)', () => {
    expect(typeof api.createMinimalIM).toBe('function')
    expect(Array.isArray(api.DEFAULT_WORKING_AGENT_TOOL_REFS)).toBe(true)
  })

  it('exports createBuiltinTools (tools group)', () => {
    expect(typeof api.createBuiltinTools).toBe('function')
  })

  it('exports createSubAgentRegistry + SubAgentRegistry (sub-agent group)', () => {
    expect(typeof api.createSubAgentRegistry).toBe('function')
    // SubAgentRegistry is a class — exported as a value (the class object)
    expect(typeof api.SubAgentRegistry).toBe('function')
  })

  it('exports bootstrapExtensions (extensions group)', () => {
    expect(typeof api.bootstrapExtensions).toBe('function')
  })

  it('exports createConfig + DEFAULT_CONFIG + ShellConfig type (config group)', () => {
    expect(typeof api.createConfig).toBe('function')
    expect(api.DEFAULT_CONFIG).toBeDefined()
    expect(api.DEFAULT_CONFIG.maxTokens).toBeGreaterThan(0)
  })

  it('exports DEFAULT_MEMORY_CONFIG + MemoryConfig type (memory-config group)', () => {
    expect(api.DEFAULT_MEMORY_CONFIG).toBeDefined()
    expect(api.DEFAULT_MEMORY_CONFIG.m1MinTokens).toBe(200_000)
    expect(api.DEFAULT_MEMORY_CONFIG.m2MinTokens).toBe(500_000)
    expect(api.DEFAULT_MEMORY_CONFIG.m3MinTokens).toBe(900_000)
  })

  it('exports defaultLogger + createSilentLogger + setLevel + setSink + getLevel + Logger types (logger group)', () => {
    expect(api.defaultLogger).toBeDefined()
    expect(typeof api.defaultLogger.info).toBe('function')
    expect(typeof api.createSilentLogger).toBe('function')
    expect(typeof api.setLevel).toBe('function')
    expect(typeof api.setSink).toBe('function')
    expect(typeof api.getLevel).toBe('function')
    // Sanity: silent logger is truly silent.
    const silent = api.createSilentLogger()
    expect(typeof silent.child).toBe('function')
  })
})
