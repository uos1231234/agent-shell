// v0.13 incremental: text skill loader tests.
//
// Each test writes .md / .txt files into a fresh mkdtemp directory — same手法
// as tests/skills/loader.test.ts. No network, no dynamic import: text-loader
// only reads files, so vitest runs them as plain unit tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTextSkillsFromDir } from '../../src/skills/text-loader.js'
import { ToolRegistry } from '../../src/shell/registry.js'

// Write a text skill file with the given frontmatter name/description and body.
const writeTextSkill = (
  dir: string,
  fileName: string,
  name: string,
  description: string,
  body: string,
): void => {
  writeFileSync(
    join(dir, fileName),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}`,
  )
}

// Write a text skill file with an extra `when_to_use` frontmatter key.
const writeTextSkillWithHint = (
  dir: string,
  fileName: string,
  name: string,
  description: string,
  whenToUse: string,
  body: string,
): void => {
  writeFileSync(
    join(dir, fileName),
    `---\nname: ${name}\ndescription: ${description}\nwhen_to_use: ${whenToUse}\n---\n${body}`,
  )
}

describe('loadTextSkillsFromDir', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'text-skills-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // ---------- happy paths ----------

  it('loads a .md file with frontmatter; execute returns the body', async () => {
    writeTextSkill(dir, 'guide.md', 'style-guide', '写诗风格规则', '\n# Rules\n- 每行不超过 12 字\n')
    const skills = await loadTextSkillsFromDir(dir)
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('style-guide')
    expect(skills[0]!.description).toBe('写诗风格规则')
    expect(skills[0]!.parameters).toBeUndefined()
    expect(await skills[0]!.execute({})).toBe('\n# Rules\n- 每行不超过 12 字\n')
  })

  it('loads a .txt file the same way as .md', async () => {
    writeTextSkill(dir, 'notes.txt', 'notes', 'plain notes', '\nKeep it short.\n')
    const skills = await loadTextSkillsFromDir(dir)
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('notes')
    expect(await skills[0]!.execute({})).toBe('\nKeep it short.\n')
  })

  it('preserves multi-paragraph markdown in the body verbatim', async () => {
    const body = [
      '',
      '# Title',
      '',
      'First paragraph with **bold**.',
      '',
      '- item one',
      '- item two',
      '',
      '```',
      'code block',
      '```',
      '',
    ].join('\n')
    writeTextSkill(dir, 'doc.md', 'doc', 'a doc', body)
    const skills = await loadTextSkillsFromDir(dir)
    // Body is everything after the closing `---` line, joined back with \n.
    expect(await skills[0]!.execute({})).toBe(body)
  })

  it('returns an empty array for an empty directory', async () => {
    const skills = await loadTextSkillsFromDir(dir)
    expect(skills).toEqual([])
  })

  it('ignores files with non-whitelisted extensions', async () => {
    writeFileSync(join(dir, 'data.json'), '{"not":"a skill"}')
    writeFileSync(join(dir, 'script.js'), 'export default {}')
    writeTextSkill(dir, 'real.md', 'real', 'ok', '\nbody\n')
    const skills = await loadTextSkillsFromDir(dir)
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('real')
  })

  it('ignores dotfiles and extensionless files', async () => {
    // `.hidden` has no whitelisted extension (its only dot is at position 0,
    // so lastIndexOf('.') <= 0 → filtered). `.hidden.md` WOULD be loaded
    // (trailing .md is a whitelisted ext) — that is the same behavior as
    // loader.ts, which keys on extension, not on leading-dot. We test the
    // true-extensionless + non-whitelisted cases here.
    writeFileSync(join(dir, '.hidden'), '---\nname: x\ndescription: y\n---\nbody')
    writeFileSync(join(dir, 'noext'), '---\nname: z\ndescription: w\n---\nbody')
    const skills = await loadTextSkillsFromDir(dir)
    expect(skills).toEqual([])
  })

  it('does not register skills (returns defs only; registry stays empty)', async () => {
    const registry = new ToolRegistry()
    writeTextSkill(dir, 's.md', 'noop', 'd', '\nbody\n')
    const skills = await loadTextSkillsFromDir(dir, { registry })
    expect(skills).toHaveLength(1)
    expect(registry.listSkills()).toEqual([])
  })

  // ---------- error paths ----------

  it('throws when the directory does not exist', async () => {
    await expect(loadTextSkillsFromDir(join(dir, 'nope'))).rejects.toThrow(
      /does not exist/,
    )
  })

  it('throws when the file has no frontmatter', async () => {
    writeFileSync(join(dir, 'bare.md'), '# just markdown\nno frontmatter')
    await expect(loadTextSkillsFromDir(dir)).rejects.toThrow(/no frontmatter/)
  })

  it('throws when the frontmatter is unclosed (no second ---)', async () => {
    writeFileSync(join(dir, 'open.md'), '---\nname: x\ndescription: y\nbody without close')
    await expect(loadTextSkillsFromDir(dir)).rejects.toThrow(/unclosed frontmatter/)
  })

  it('throws when name is missing from frontmatter', async () => {
    writeFileSync(join(dir, 'bad.md'), '---\ndescription: y\n---\nbody')
    await expect(loadTextSkillsFromDir(dir)).rejects.toThrow(/missing the "name"/)
  })

  it('throws when description is missing from frontmatter', async () => {
    writeFileSync(join(dir, 'bad.md'), '---\nname: x\n---\nbody')
    await expect(loadTextSkillsFromDir(dir)).rejects.toThrow(/missing the "description"/)
  })

  it('throws when the body is empty (whitespace only)', async () => {
    writeFileSync(join(dir, 'bad.md'), '---\nname: x\ndescription: y\n---\n   \n  \n')
    await expect(loadTextSkillsFromDir(dir)).rejects.toThrow(/empty body/)
  })

  it('throws on a name with illegal characters', async () => {
    writeTextSkill(dir, 'bad.md', 'bad name!', 'd', '\nbody\n')
    await expect(loadTextSkillsFromDir(dir)).rejects.toThrow(/invalid name/)
  })

  it('throws on a name exceeding 64 characters', async () => {
    const longName = 'a'.repeat(65)
    writeTextSkill(dir, 'bad.md', longName, 'd', '\nbody\n')
    await expect(loadTextSkillsFromDir(dir)).rejects.toThrow(/invalid name/)
  })

  it('throws on an empty name', async () => {
    writeTextSkill(dir, 'bad.md', '', 'd', '\nbody\n')
    await expect(loadTextSkillsFromDir(dir)).rejects.toThrow(/invalid name/)
  })

  it('throws on duplicate names within the directory', async () => {
    writeTextSkill(dir, 'a.md', 'dup', 'first', '\nbody1\n')
    writeTextSkill(dir, 'b.md', 'dup', 'second', '\nbody2\n')
    await expect(loadTextSkillsFromDir(dir)).rejects.toThrow(/Duplicate text skill name/)
  })

  it('throws when a text skill name collides with an existing system tool', async () => {
    const registry = new ToolRegistry()
    registry.registerSystemTool({
      name: 'bash',
      description: 'system bash',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'sys',
    })
    writeTextSkill(dir, 's.md', 'bash', 'shadow', '\nbody\n')
    await expect(loadTextSkillsFromDir(dir, { registry })).rejects.toThrow(
      /collides with an existing system tool/,
    )
  })

  it('throws when a text skill name collides with an existing skill in the registry', async () => {
    const registry = new ToolRegistry()
    registry.registerSkill({
      name: 'echo',
      description: 'existing',
      execute: async () => 'old',
    })
    writeTextSkill(dir, 's.md', 'echo', 'new', '\nbody\n')
    await expect(loadTextSkillsFromDir(dir, { registry })).rejects.toThrow(
      /collides with an existing skill/,
    )
  })

  it('throws when a text skill name collides with an MCP flat name (server__tool)', async () => {
    const registry = new ToolRegistry()
    registry.registerMCP('srv', [
      {
        name: 'tool',
        description: 'mcp tool',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'mcp',
      },
    ])
    writeTextSkill(dir, 's.md', 'srv__tool', 'shadow mcp', '\nbody\n')
    await expect(loadTextSkillsFromDir(dir, { registry })).rejects.toThrow(
      /collides with MCP tool "srv__tool"/,
    )
  })

  it('ignores unknown frontmatter keys (only name/description matter)', async () => {
    writeFileSync(
      join(dir, 'extra.md'),
      '---\nname: x\ndescription: y\nversion: 1.0\nauthor: me\n---\nbody',
    )
    const skills = await loadTextSkillsFromDir(dir)
    expect(skills[0]!.name).toBe('x')
    expect(await skills[0]!.execute({})).toBe('body')
  })

  // ---------- v0.10.6: form / body / when_to_use assertions ----------

  it('stamps form:"text" and attaches the verbatim body on every loaded def', async () => {
    const body = '\n# Rules\n- 每行不超过 12 字\n'
    writeTextSkill(dir, 'guide.md', 'style-guide', '写诗风格规则', body)
    const skills = await loadTextSkillsFromDir(dir)
    expect(skills).toHaveLength(1)
    const def = skills[0]!
    // form discriminates the pre-injection path from the tool_call path.
    expect(def.form).toBe('text')
    // body is the raw file content after the closing ---, used by
    // registerTextSkill and compose's skillText injection.
    expect(def.body).toBe(body)
    // when_to_use is absent on this file → field should be undefined
    // (exactOptionalPropertyTypes: a present-but-undefined field is illegal).
    expect(def.when_to_use).toBeUndefined()
  })

  it('parses the when_to_use frontmatter key and exposes it on the def', async () => {
    writeTextSkillWithHint(
      dir,
      'guide.md',
      'style-guide',
      '写诗风格规则',
      '用户要求写诗或押韵时',
      '\n# Rules\n',
    )
    const skills = await loadTextSkillsFromDir(dir)
    expect(skills).toHaveLength(1)
    const def = skills[0]!
    expect(def.form).toBe('text')
    expect(def.when_to_use).toBe('用户要求写诗或押韵时')
    expect(def.body).toBe('\n# Rules\n')
  })

  it('omits when_to_use (does not set undefined) when the frontmatter lacks the key', async () => {
    // exactOptionalPropertyTypes: a present-but-undefined field is a tsc error
    // for callers that spread the def. Verify the field is genuinely absent.
    writeTextSkill(dir, 'plain.md', 'plain', 'd', '\nbody\n')
    const skills = await loadTextSkillsFromDir(dir)
    const def = skills[0]!
    expect(def.when_to_use).toBeUndefined()
    // The def object should not have the key as an own property at all.
    expect(Object.prototype.hasOwnProperty.call(def, 'when_to_use')).toBe(false)
  })

  it('preserves when_to_use with special characters (no stripping beyond trim)', async () => {
    writeTextSkillWithHint(
      dir,
      'g.md',
      'g',
      'd',
      'when: the user says "write a poem" (see §3)',
      '\nbody\n',
    )
    const skills = await loadTextSkillsFromDir(dir)
    expect(skills[0]!.when_to_use).toBe('when: the user says "write a poem" (see §3)')
  })

  it('ignores an empty when_to_use value but keeps the field defined (user surfaces at injection)', async () => {
    // An explicit `when_to_use:` with empty value parses to an empty string.
    // validateTextSkill does NOT reject it (only name/description/body are
    // required). The empty hint is surfaced at injection time as an empty
    // comment, which is a user-visible signal — consistent with the loader's
    // philosophy of not silently coercing.
    writeFileSync(
      join(dir, 'empty-hint.md'),
      '---\nname: x\ndescription: y\nwhen_to_use:\n---\nbody',
    )
    const skills = await loadTextSkillsFromDir(dir)
    expect(skills[0]!.when_to_use).toBe('')
  })
})
