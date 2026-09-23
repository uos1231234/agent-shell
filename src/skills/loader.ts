// v0.13 Batch 1b + v0.10.6: Skill module loader.
//
// Loads JS/TS modules from a directory, each exporting a SkillDefinition.
// Each loaded definition is stamped form:'module' (v0.10.6) so the registry
// can distinguish callable-tool skills from pre-injected text skills. The
// form is added here (not in the user's module) so existing skill modules
// keep working unchanged — the loader owns the classification.
//
// Validates per D5 (name shape, description, execute fn, optional parameters
// schema) and rejects name collisions against the loaded batch and (optionally)
// the registry's existing flat names — registry.execute dispatches
// system → mcp → module skill on the first name hit, so a collision would
// silently shadow one definition; we fail at load time instead. v0.10.6 also
// rejects collisions against the registry's text-skill bucket (a module skill
// sharing a name with a text skill would shadow the text skill in resolveRef).
//
// Runtime prerequisite: .ts / .mts skill files require a TS-capable runtime
// (tsx, vitest's vite pipeline, or ts-node). Plain `node` can only execute
// .js / .mjs files. This is a known constraint of the dynamic import() approach;
// it is documented here, not worked around.

import { readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import type { SkillDefinition, ToolRegistry } from '../shell/registry.js'

const ALLOWED_EXTENSIONS = new Set(['.ts', '.js', '.mts', '.mjs'])

// D5: name must be 1-64 chars of [a-zA-Z0-9_-]
const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

export type LoadSkillsOptions = {
  registry?: ToolRegistry
}

/**
 * Discover and validate skill modules in `dir`.
 *
 * Scans direct files only (no recursion). Each file is dynamically imported;
 * its `default` export takes precedence over a named `skill` export. Validated
 * definitions are returned — registration is the caller's responsibility
 * (extensions.ts), per the ownership table in the v0.13 plan §3.4.
 *
 * Throws on: missing dir, invalid export, validation failure, or name
 * collision (within the batch or against the registry).
 */
export async function loadSkillsFromDir(
  dir: string,
  opts?: LoadSkillsOptions,
): Promise<SkillDefinition[]> {
  const absDir = resolve(dir)

  let entries: string[]
  try {
    entries = await readdir(absDir)
  } catch (err: unknown) {
    // Distinguish "does not exist" from other errors for a clean message.
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      throw new Error(`Skills directory does not exist: ${absDir}`)
    }
    throw err
  }

  const skillFiles = entries.filter((name) => {
    // 排除声明文件（web-search.d.ts 的扩展名判定为 .ts，需先排除）
    if (name.endsWith('.d.ts') || name.endsWith('.d.mts')) return false
    const dot = name.lastIndexOf('.')
    if (dot <= 0) return false // no extension or dotfile
    const ext = name.slice(dot).toLowerCase()
    return ALLOWED_EXTENSIONS.has(ext)
  })

  const loaded: SkillDefinition[] = []
  const seenNames = new Set<string>()

  for (const fileName of skillFiles) {
    const filePath = resolve(absDir, fileName)
    const fileUrl = pathToFileURL(filePath).href

    let mod: unknown
    try {
      mod = await import(fileUrl)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to import skill module ${fileName}: ${msg}`)
    }

    const def = extractSkillDefinition(mod, fileName)
    validateSkillDefinition(def, fileName)

    if (seenNames.has(def.name)) {
      throw new Error(
        `Duplicate skill name "${def.name}" within directory (file: ${fileName})`,
      )
    }
    if (opts?.registry) {
      assertNoRegistryCollision(def.name, opts.registry, fileName)
    }

    seenNames.add(def.name)
    // v0.10.6: stamp form:'module' on every loaded module skill so the
    // registry can route it to the tool_call path (registerSkill accepts
    // form:'module' or undefined; registerTextSkill rejects anything not
    // text-form). We set it post-validation so the user's module export shape
    // is checked before we mutate.
    loaded.push({ ...def, form: 'module' })
  }

  return loaded
}

/**
 * Resolve a skill definition from a module: `default` export wins over a
 * named `skill` export. Throws if neither yields a usable object.
 */
function extractSkillDefinition(mod: unknown, fileName: string): SkillDefinition {
  const modRecord = mod as Record<string, unknown> | null
  const candidate = modRecord?.default ?? modRecord?.skill
  if (candidate == null || typeof candidate !== 'object') {
    throw new Error(
      `Skill module ${fileName} has no valid export: expected a default export or a named "skill" export that is a SkillDefinition object`,
    )
  }
  return candidate as SkillDefinition
}

/**
 * D5 validation. Throws clean English errors including the file name.
 */
function validateSkillDefinition(def: SkillDefinition, fileName: string): void {
  if (typeof def.name !== 'string' || !NAME_PATTERN.test(def.name)) {
    throw new Error(
      `Skill module ${fileName} has an invalid name: ${JSON.stringify(def.name)} (must be 1-64 chars of [a-zA-Z0-9_-])`,
    )
  }
  if (typeof def.description !== 'string' || def.description.length === 0) {
    throw new Error(
      `Skill module ${fileName} (name "${def.name}") has an empty description`,
    )
  }
  if (typeof def.execute !== 'function') {
    throw new Error(
      `Skill module ${fileName} (name "${def.name}") is missing a callable execute function`,
    )
  }
  if (def.parameters !== undefined) {
    // Shallow check: when present, parameters must be a JSON schema with
    // type:'object'. Deep schema validation is out of scope (plan §5 principle
    // "校验在边界" — validate shape at load, trust at runtime).
    if (
      typeof def.parameters !== 'object' ||
      def.parameters === null ||
      def.parameters.type !== 'object'
    ) {
      throw new Error(
        `Skill module ${fileName} (name "${def.name}") has parameters that are not a JSON schema with type "object"`,
      )
    }
  }
}

/**
 * Reject names that already exist in the registry under any of the four
 * dispatch buckets (system / mcp-flat / module skill / text skill).
 * registry.execute resolves system → mcp → module skill on first hit, so any
 * collision silently shadows — we surface it here. v0.10.6 also checks the
 * text-skill bucket: a module skill sharing a name with a text skill would
 * shadow it in resolveRef (which checks textSkills last) and confuse compose.
 */
function assertNoRegistryCollision(
  name: string,
  registry: ToolRegistry,
  fileName: string,
): void {
  if (registry.getSystemTool(name)) {
    throw new Error(
      `Skill name "${name}" (file: ${fileName}) collides with an existing system tool`,
    )
  }
  if (registry.getSkill(name)) {
    throw new Error(
      `Skill name "${name}" (file: ${fileName}) collides with an existing skill`,
    )
  }
  // v0.10.6: also reject collisions with text skills.
  if (registry.getTextSkill(name)) {
    throw new Error(
      `Skill name "${name}" (file: ${fileName}) collides with an existing text skill`,
    )
  }
  // MCP flat names are `server__tool`; enumerate to cover all servers.
  for (const server of registry.listMCPServers()) {
    for (const toolName of registry.listMCPTools(server)) {
      if (`${server}__${toolName}` === name) {
        throw new Error(
          `Skill name "${name}" (file: ${fileName}) collides with MCP tool "${server}__${toolName}"`,
        )
      }
    }
  }
}
