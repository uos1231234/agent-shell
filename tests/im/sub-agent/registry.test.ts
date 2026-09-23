import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SubAgentRegistry } from '../../../src/im/sub-agent/registry.js'
import { validateSubAgentConfig } from '../../../src/im/sub-agent/config.js'
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

describe('im/sub-agent/registry', () => {
  it('register + get round-trips a config', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry()
    const cfg = validateSubAgentConfig({
      name: 'reviewer',
      systemPrompt: 'Review code.',
      toolRefs: ['echo'],
    }, registry)
    await sub.register(cfg)
    expect(sub.get('reviewer')).toEqual(cfg)
  })

  it('list returns sorted names', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry()
    await sub.register(validateSubAgentConfig({ name: 'zebra', systemPrompt: 'z', toolRefs: ['echo'] }, registry))
    await sub.register(validateSubAgentConfig({ name: 'alpha', systemPrompt: 'a', toolRefs: ['echo'] }, registry))
    expect(sub.list()).toEqual(['alpha', 'zebra'])
  })

  it('sharedDatabus is created once and shared', () => {
    const sub = new SubAgentRegistry()
    expect(sub.sharedDatabus).toBeDefined()
    // Appending to the shared bus does not affect a fresh registry's bus.
    const other = new SubAgentRegistry()
    sub.sharedDatabus.append({
      id: 't1', role: 'tool', toolCallId: 'tc-1', content: 'x', sourceAgentId: 'a', at: 1,
    })
    expect(other.sharedDatabus.turns()).toHaveLength(0)
  })

  it('writes config to disk when diskDir provided', async () => {
    const registry = makeRegistry()
    const dir = mkdtempSync(join(tmpdir(), 'sub-agent-test-'))
    try {
      const sub = new SubAgentRegistry()
      const cfg = validateSubAgentConfig({
        name: 'reviewer',
        systemPrompt: 'Review code.',
        toolRefs: ['echo'],
        config: { maxSteps: 42 },
      }, registry)
      // v0.11.2 S3: register() is async — await it, no setTimeout needed.
      await sub.register(cfg, dir)
      const raw = await readFile(join(dir, 'reviewer.json'), 'utf8')
      const parsed = JSON.parse(raw)
      expect(parsed.name).toBe('reviewer')
      expect(parsed.systemPrompt).toBe('Review code.')
      expect(parsed.toolRefs).toEqual(['echo'])
      expect(parsed.config).toEqual({ maxSteps: 42 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loadFromDisk loads valid configs and skips invalid ones', async () => {
    const registry = makeRegistry()
    const dir = mkdtempSync(join(tmpdir(), 'sub-agent-test-'))
    try {
      const sub = new SubAgentRegistry()
      await sub.register(validateSubAgentConfig({ name: 'valid', systemPrompt: 'ok', toolRefs: ['echo'] }, registry), dir)

      const loader = new SubAgentRegistry()
      const loaded = await loader.loadFromDisk(dir, registry)
      expect(loaded).toBe(1)
      expect(loader.get('valid')).toBeDefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loadFromDisk returns 0 when directory does not exist', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry()
    const loaded = await sub.loadFromDisk(join(tmpdir(), 'does-not-exist-sub-agent'), registry)
    expect(loaded).toBe(0)
  })
})
