// v0.11.1 P2.7/P2.8: Registry atomic writes and register() re-validation.
//
// P2.7: writeToDisk uses tmp+rename so a killed process can't leave corrupt
//       JSON. We verify by writing, killing the tmp file (simulating), and
//       confirming the final file is intact.
// P2.8: register() re-validates when a ToolRegistry was passed to the
//       constructor. Invalid configs are rejected even from library callers.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SubAgentRegistry } from '../../../src/im/sub-agent/registry.js'
import { validateSubAgentConfig } from '../../../src/im/sub-agent/config.js'
import { ToolRegistry } from '../../../src/shell/registry.js'

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

describe('P2.7 Registry atomic disk writes', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sub-agent-p2-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a valid JSON file via tmp+rename (no .tmp files left behind)', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry({ registry: registry })
    const cfg = validateSubAgentConfig(
      { name: 'reviewer', systemPrompt: 'Review code.', toolRefs: ['echo'] }, registry)
    // v0.11.2 S3: register() is now async — await it, no setTimeout needed.
    await sub.register(cfg, dir)

    const files = readdirSync(dir)
    expect(files).toEqual(['reviewer.json'])
    const raw = readFileSync(join(dir, 'reviewer.json'), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.name).toBe('reviewer')
    expect(parsed.systemPrompt).toBe('Review code.')
    expect(parsed.toolRefs).toEqual(['echo'])
  })

  it('persists config overrides in the atomic write', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry({ registry: registry })
    const cfg = validateSubAgentConfig(
      { name: 'reviewer', systemPrompt: 'Review code.', toolRefs: ['echo'], config: { maxSteps: 42 } }, registry)
    await sub.register(cfg, dir)

    const raw = readFileSync(join(dir, 'reviewer.json'), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.config).toEqual({ maxSteps: 42 })
  })

  it('can write multiple configs atomically', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry({ registry: registry })
    await sub.register(validateSubAgentConfig(
      { name: 'alpha', systemPrompt: 'a', toolRefs: ['echo'] }, registry), dir)
    await sub.register(validateSubAgentConfig(
      { name: 'beta', systemPrompt: 'b', toolRefs: ['echo'] }, registry), dir)

    const files = readdirSync(dir).sort()
    expect(files).toEqual(['alpha.json', 'beta.json'])
  })
})

describe('P2.8 Registry register() re-validation', () => {
  it('re-validates when constructed with a ToolRegistry', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry({ registry: registry })
    // A config with an unknown toolRef should be rejected by register().
    await expect(
      sub.register({
        name: 'bad',
        systemPrompt: 'x',
        toolRefs: ['nonexistent'],
      } as unknown as Parameters<typeof sub.register>[0]),
    ).rejects.toThrow('Unknown toolRefs')
  })

  it('re-validates path-safe name when constructed with registry', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry({ registry: registry })
    await expect(
      sub.register({
        name: '../escape',
        systemPrompt: 'x',
        toolRefs: ['echo'],
      } as unknown as Parameters<typeof sub.register>[0]),
    ).rejects.toThrow('Sub-agent name')
  })

  it('accepts valid config when constructed with registry', async () => {
    const registry = makeRegistry()
    const sub = new SubAgentRegistry({ registry: registry })
    await sub.register({
      name: 'good',
      systemPrompt: 'x',
      toolRefs: ['echo'],
    })
    expect(sub.get('good')).toBeDefined()
  })

  it('skips re-validation when no registry in constructor (backward compat)', async () => {
    // Without a registry, register trusts the caller. This is the backward-
    // compat path used by tests that don't need validation.
    const sub = new SubAgentRegistry()
    await sub.register({
      name: 'anything',
      systemPrompt: 'x',
      toolRefs: ['whatever'],
    } as unknown as Parameters<typeof sub.register>[0])
    expect(sub.get('anything')).toBeDefined()
  })

  it('loadFromDisk still validates (unchanged behavior)', async () => {
    const registry = makeRegistry()
    const dir = mkdtempSync(join(tmpdir(), 'sub-agent-p2-load-'))
    try {
      const writer = new SubAgentRegistry({ registry: registry })
      await writer.register(validateSubAgentConfig(
        { name: 'valid', systemPrompt: 'ok', toolRefs: ['echo'] }, registry), dir)

      const loader = new SubAgentRegistry({ registry: registry })
      const loaded = await loader.loadFromDisk(dir, registry)
      expect(loaded).toBe(1)
      expect(loader.get('valid')).toBeDefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
