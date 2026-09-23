// v0.13 Batch 1b: skill loader tests.
//
// Each test writes skill source files into a fresh mkdtemp directory so there
// are no static fixtures to maintain. vitest's vite pipeline transpiles the
// dynamically-imported .ts modules, so both .js and .ts skills are exercised.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSkillsFromDir } from '../../src/skills/loader.js'
import { ToolRegistry } from '../../src/shell/registry.js'

describe('loadSkillsFromDir', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // ---------- happy paths ----------

  it('loads a .js module with a default export', async () => {
    writeFileSync(
      join(dir, 'hello.js'),
      `export default {
        name: 'hello',
        description: 'say hello',
        execute: async () => 'hi',
      };`,
    )
    const skills = await loadSkillsFromDir(dir)
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('hello')
    expect(await skills[0]!.execute({})).toBe('hi')
  })

  it('loads a .ts module with a named "skill" export', async () => {
    writeFileSync(
      join(dir, 'plan.ts'),
      `import type { SkillDefinition } from '../../src/skills/loader.js'
      // re-export via alias path so the type is local-friendly
      export const skill: SkillDefinition = {
        name: 'plan-step',
        description: 'produce a plan',
        execute: async () => ({ steps: [] }),
      };`,
    )
    const skills = await loadSkillsFromDir(dir)
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('plan-step')
    expect(await skills[0]!.execute({})).toEqual({ steps: [] })
  })

  it('prefers default export when both default and named "skill" exist', async () => {
    writeFileSync(
      join(dir, 'both.js'),
      `export const skill = { name: 'named-one', description: 'named', execute: async () => 'named' };
      export default { name: 'default-one', description: 'default', execute: async () => 'default' };`,
    )
    const skills = await loadSkillsFromDir(dir)
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('default-one')
  })

  it('accepts a skill with optional parameters schema (type object)', async () => {
    writeFileSync(
      join(dir, 'param.js'),
      `export default {
        name: 'with-params',
        description: 'has params',
        parameters: { type: 'object', properties: { x: {} }, required: ['x'] },
        execute: async (args) => args,
      };`,
    )
    const skills = await loadSkillsFromDir(dir)
    expect(skills[0]!.name).toBe('with-params')
    expect(skills[0]!.parameters).toBeDefined()
  })

  it('accepts a skill with no parameters field', async () => {
    writeFileSync(
      join(dir, 'bare.js'),
      `export default { name: 'bare', description: 'no params', execute: async () => null };`,
    )
    const skills = await loadSkillsFromDir(dir)
    expect(skills[0]!.parameters).toBeUndefined()
  })

  it('returns an empty array for an empty directory', async () => {
    const skills = await loadSkillsFromDir(dir)
    expect(skills).toEqual([])
  })

  it('ignores files with non-whitelisted extensions', async () => {
    writeFileSync(join(dir, 'readme.txt'), 'not a skill')
    writeFileSync(join(dir, 'notes.md'), '# not a skill')
    writeFileSync(
      join(dir, 'real.js'),
      `export default { name: 'real', description: 'ok', execute: async () => 1 };`,
    )
    const skills = await loadSkillsFromDir(dir)
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('real')
  })

  it('ignores .d.ts declaration files (extension parses as .ts otherwise)', async () => {
    writeFileSync(join(dir, 'web-search.d.ts'), 'export const x: number')
    writeFileSync(
      join(dir, 'real.js'),
      `export default { name: 'real', description: 'ok', execute: async () => 1 };`,
    )
    const skills = await loadSkillsFromDir(dir)
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('real')
  })

  // ---------- error paths ----------

  it('throws when the directory does not exist', async () => {
    await expect(loadSkillsFromDir(join(dir, 'nope'))).rejects.toThrow(
      /does not exist/,
    )
  })

  it('throws on an empty name', async () => {
    writeFileSync(
      join(dir, 'bad.js'),
      `export default { name: '', description: 'x', execute: async () => null };`,
    )
    await expect(loadSkillsFromDir(dir)).rejects.toThrow(/invalid name/)
  })

  it('throws on a name with illegal characters', async () => {
    writeFileSync(
      join(dir, 'bad.js'),
      `export default { name: 'bad name!', description: 'x', execute: async () => null };`,
    )
    await expect(loadSkillsFromDir(dir)).rejects.toThrow(/invalid name/)
  })

  it('throws on a name exceeding 64 characters', async () => {
    const longName = 'a'.repeat(65)
    writeFileSync(
      join(dir, 'bad.js'),
      `export default { name: ${JSON.stringify(longName)}, description: 'x', execute: async () => null };`,
    )
    await expect(loadSkillsFromDir(dir)).rejects.toThrow(/invalid name/)
  })

  it('throws when description is empty', async () => {
    writeFileSync(
      join(dir, 'bad.js'),
      `export default { name: 'x', description: '', execute: async () => null };`,
    )
    await expect(loadSkillsFromDir(dir)).rejects.toThrow(/empty description/)
  })

  it('throws when execute is missing', async () => {
    writeFileSync(
      join(dir, 'bad.js'),
      `export default { name: 'x', description: 'desc' };`,
    )
    await expect(loadSkillsFromDir(dir)).rejects.toThrow(/execute function/)
  })

  it('throws when execute is not a function', async () => {
    writeFileSync(
      join(dir, 'bad.js'),
      `export default { name: 'x', description: 'desc', execute: 'not-a-fn' };`,
    )
    await expect(loadSkillsFromDir(dir)).rejects.toThrow(/execute function/)
  })

  it('throws when parameters is present but not type object', async () => {
    writeFileSync(
      join(dir, 'bad.js'),
      `export default { name: 'x', description: 'desc', parameters: { type: 'string' }, execute: async () => null };`,
    )
    await expect(loadSkillsFromDir(dir)).rejects.toThrow(/type "object"/)
  })

  it('throws when no valid export is found', async () => {
    writeFileSync(join(dir, 'bad.js'), `export const nothing = 42;`)
    await expect(loadSkillsFromDir(dir)).rejects.toThrow(/no valid export/)
  })

  it('throws on duplicate names within the directory', async () => {
    writeFileSync(
      join(dir, 'a.js'),
      `export default { name: 'dup', description: 'first', execute: async () => 1 };`,
    )
    writeFileSync(
      join(dir, 'b.js'),
      `export default { name: 'dup', description: 'second', execute: async () => 2 };`,
    )
    await expect(loadSkillsFromDir(dir)).rejects.toThrow(/Duplicate skill name/)
  })

  it('throws when a skill name collides with an existing system tool', async () => {
    const registry = new ToolRegistry()
    registry.registerSystemTool({
      name: 'bash',
      description: 'system bash',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'sys',
    })
    writeFileSync(
      join(dir, 's.js'),
      `export default { name: 'bash', description: 'shadow', execute: async () => 'skill' };`,
    )
    await expect(loadSkillsFromDir(dir, { registry })).rejects.toThrow(
      /collides with an existing system tool/,
    )
  })

  it('throws when a skill name collides with an existing skill in the registry', async () => {
    const registry = new ToolRegistry()
    registry.registerSkill({
      name: 'echo',
      description: 'existing',
      execute: async () => 'old',
    })
    writeFileSync(
      join(dir, 's.js'),
      `export default { name: 'echo', description: 'new', execute: async () => 'new' };`,
    )
    await expect(loadSkillsFromDir(dir, { registry })).rejects.toThrow(
      /collides with an existing skill/,
    )
  })

  it('throws when a skill name collides with an MCP flat name (server__tool)', async () => {
    const registry = new ToolRegistry()
    registry.registerMCP('srv', [
      {
        name: 'tool',
        description: 'mcp tool',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'mcp',
      },
    ])
    writeFileSync(
      join(dir, 's.js'),
      `export default { name: 'srv__tool', description: 'shadow mcp', execute: async () => 'skill' };`,
    )
    await expect(loadSkillsFromDir(dir, { registry })).rejects.toThrow(
      /collides with MCP tool "srv__tool"/,
    )
  })

  it('does not register skills (returns defs only; registry stays empty)', async () => {
    const registry = new ToolRegistry()
    writeFileSync(
      join(dir, 's.js'),
      `export default { name: 'noop', description: 'd', execute: async () => null };`,
    )
    const skills = await loadSkillsFromDir(dir, { registry })
    expect(skills).toHaveLength(1)
    expect(registry.listSkills()).toEqual([])
  })

  // ---------- v0.10.6: form:'module' stamping ----------

  it('stamps form:"module" on every loaded def (distinguishes from text skills)', async () => {
    writeFileSync(
      join(dir, 'm.js'),
      `export default { name: 'mod', description: 'd', execute: async () => 1 };`,
    )
    const skills = await loadSkillsFromDir(dir)
    expect(skills).toHaveLength(1)
    expect(skills[0]!.form).toBe('module')
  })

  it('throws when a module skill name collides with an existing text skill', async () => {
    // v0.10.6: the module loader's collision check now also rejects names that
    // collide with a registered text skill (the 4th bucket). A module skill
    // shadowing a pre-injected text skill would silently change the resolution
    // kind from textSkill to skill, breaking compose's injection contract.
    const registry = new ToolRegistry()
    registry.registerTextSkill('dup', 'text body')
    writeFileSync(
      join(dir, 's.js'),
      `export default { name: 'dup', description: 'module', execute: async () => 1 };`,
    )
    await expect(loadSkillsFromDir(dir, { registry })).rejects.toThrow(
      /collides with an existing text skill/,
    )
  })
})
