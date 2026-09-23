// v0.13 incremental + v0.10.6: plain-text skill loader (.md / .txt).
//
// Loads SKILL.md-style text files: a frontmatter block (between the first two
// `---` lines) declaring `name`, `description`, and (optionally) `when_to_use`,
// followed by a markdown/plain body. Each file becomes a SkillDefinition with:
//   - form: 'text'           — marks it for the pre-injection path
//   - body: <file content>   — the verbatim body, used by registerTextSkill
//   - when_to_use?: <hint>   — optional frontmatter field, prepended to the
//                              injected body as a comment at compose time
//   - execute: async () => body — kept for backward compatibility with callers
//                              that still treat text skills as tools. The
//                              registry's registerTextSkill path ignores it.
//   - NO parameters          — text skills take no args (compose fills nothing)
//
// v0.10.6 routing: text skills are NOT registered via registerSkill. They go
// through registry.registerTextSkill(name, body, whenToUse) and live in the
// registry's textSkills store; compose injects them as `skillText` parts into
// the system prompt. The legacy "调用即注入" (call-as-injection) tool_call
// semantics are retained only as a fallback for callers that bypass
// bootstrapExtensions and call registerSkill directly — but registerSkill now
// throws on form:'text', so the only supported path is registerTextSkill.
//
// Division of labor with the module skill loader (loader.ts):
//   - module skill  → form:'module', logic: code that computes a result from args
//   - text skill    → form:'text', pure content: rules, guides, reference text
//                     the LLM should read before answering (pre-injected, not
//                     called)
//
// File format example (style-guide.md):
//   ---
//   name: style-guide
//   description: 写诗风格规则
//   when_to_use: 用户要求写诗或押韵时
//   ---
//   # Style rules
//   - 每行不超过 12 字
//   - 押 ang 韵
//
// Validation mirrors the module loader's D5 rules (loader.ts): name 1-64 chars
// of [a-zA-Z0-9_-], description non-empty, body non-empty after trim. Name
// collisions are rejected against the batch and (when a registry is passed)
// against the registry's four dispatch buckets (system / mcp-flat / module
// skill / text skill), using the SAME enumeration手法 as loader.ts. The
// text-skill bucket is new in v0.10.6 — a text skill sharing a name with an
// already-registered text skill would silently overwrite the body, so we
// surface it at load time.

import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { SkillDefinition, ToolRegistry } from '../shell/registry.js'

const ALLOWED_EXTENSIONS = new Set(['.md', '.txt'])

// D5: name must be 1-64 chars of [a-zA-Z0-9_-] (same shape as loader.ts).
const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

export type LoadTextSkillsOptions = {
  registry?: ToolRegistry
}

/**
 * Discover and validate plain-text skill files in `dir`.
 *
 * Scans direct files only (no recursion); only `.md` / `.txt` are considered.
 * Each file is parsed (frontmatter + body), validated, and returned as a
 * SkillDefinition with form:'text' and the body attached. Registration is the
 * caller's responsibility (extensions.ts), identical to the module loader's
 * ownership boundary — but the caller MUST use registry.registerTextSkill (not
 * registerSkill, which throws on form:'text').
 *
 * Throws on: missing dir, parse failure (no/missing frontmatter), validation
 * failure, or name collision (within the batch or against the registry).
 */
export async function loadTextSkillsFromDir(
  dir: string,
  opts?: LoadTextSkillsOptions,
): Promise<SkillDefinition[]> {
  const absDir = resolve(dir)

  let entries: string[]
  try {
    entries = await readdir(absDir)
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      throw new Error(`Text skills directory does not exist: ${absDir}`)
    }
    throw err
  }

  const textFiles = entries.filter((name) => {
    const dot = name.lastIndexOf('.')
    if (dot <= 0) return false // no extension or dotfile
    const ext = name.slice(dot).toLowerCase()
    return ALLOWED_EXTENSIONS.has(ext)
  })

  const loaded: SkillDefinition[] = []
  const seenNames = new Set<string>()

  for (const fileName of textFiles) {
    const filePath = resolve(absDir, fileName)
    const raw = await readFile(filePath, 'utf8')
    const { name, description, whenToUse, body } = parseTextSkill(raw, fileName)
    validateTextSkill(name, description, body, fileName)

    if (seenNames.has(name)) {
      throw new Error(
        `Duplicate text skill name "${name}" within directory (file: ${fileName})`,
      )
    }
    if (opts?.registry) {
      assertNoRegistryCollision(name, opts.registry, fileName)
    }

    seenNames.add(name)
    // form:'text' + body + when_to_use mark this for the pre-injection path.
    // execute is retained (returns body) for backward compatibility with any
    // caller that still probes the definition directly; registerTextSkill
    // ignores it and stores body separately.
    const def: SkillDefinition = {
      name,
      description,
      form: 'text',
      body,
      execute: async () => body,
    }
    if (whenToUse !== undefined) {
      def.when_to_use = whenToUse
    }
    loaded.push(def)
  }

  return loaded
}

/**
 * Parse a text skill file into { name, description, whenToUse, body }.
 *
 * Frontmatter is the block between the first two lines that are exactly `---`.
 * Read keys: `name`, `description`, `when_to_use` (all simple `key: value` line
 * splits, first colon wins — no YAML library). Everything after the closing
 * `---` line is the body, preserved verbatim (newlines, markdown, leading
 * blank line). `when_to_use` is optional and returned as `undefined` when
 * absent.
 *
 * Throws a clean English error naming the file when frontmatter is absent,
 * the closing delimiter is missing, or a required key (name/description) is
 * absent.
 */
function parseTextSkill(
  raw: string,
  fileName: string,
): { name: string; description: string; whenToUse?: string; body: string } {
  const lines = raw.split('\n')
  if (lines.length === 0 || lines[0]!.trim() !== '---') {
    throw new Error(
      `Text skill ${fileName} has no frontmatter: expected the first line to be "---"`,
    )
  }

  // Find the closing `---` (a line whose trimmed content is exactly `---`),
  // scanning from the second line onward.
  let closeIdx = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === '---') {
      closeIdx = i
      break
    }
  }
  if (closeIdx === -1) {
    throw new Error(
      `Text skill ${fileName} has an unclosed frontmatter: no second "---" delimiter found`,
    )
  }

  const fmLines = lines.slice(1, closeIdx)
  let name: string | undefined
  let description: string | undefined
  let whenToUse: string | undefined
  for (const line of fmLines) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue // blank line or no key
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (key === 'name') name = value
    else if (key === 'description') description = value
    else if (key === 'when_to_use') whenToUse = value
    // Unknown keys are ignored — only name/description/when_to_use matter.
  }

  if (name === undefined) {
    throw new Error(
      `Text skill ${fileName} is missing the "name" field in frontmatter`,
    )
  }
  if (description === undefined) {
    throw new Error(
      `Text skill ${fileName} is missing the "description" field in frontmatter`,
    )
  }

  const body = lines.slice(closeIdx + 1).join('\n')
  // whenToUse stays undefined when the frontmatter had no when_to_use line;
  // we deliberately do NOT coerce empty-string to undefined here because an
  // explicit `when_to_use:` with empty value is a user error worth surfacing
  // at injection time (the comment would be empty). The validate step below
  // does not reject empty whenToUse — only name/description/body are required.
  return whenToUse === undefined
    ? { name, description, body }
    : { name, description, whenToUse, body }
}

/**
 * D5 validation for text skills. Throws clean English errors including the
 * file name. Mirrors loader.ts validateSkillDefinition, minus the execute /
 * parameters checks (text skills have a fixed execute and no parameters).
 */
function validateTextSkill(
  name: string,
  description: string,
  body: string,
  fileName: string,
): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `Text skill ${fileName} has an invalid name: ${JSON.stringify(name)} (must be 1-64 chars of [a-zA-Z0-9_-])`,
    )
  }
  if (description.length === 0) {
    throw new Error(
      `Text skill ${fileName} (name "${name}") has an empty description`,
    )
  }
  if (body.trim().length === 0) {
    throw new Error(
      `Text skill ${fileName} (name "${name}") has an empty body`,
    )
  }
}

/**
 * Reject names that already exist in the registry under any of the four
 * dispatch buckets (system / mcp-flat / module skill / text skill). Identical
 * logic + message shapes to loader.ts assertNoRegistryCollision — duplicated
 * deliberately (see file header). The text-skill bucket check is new in
 * v0.10.6: a text skill sharing a name with an already-registered text skill
 * would silently overwrite the body in registerTextSkill's Map.set, so we
 * surface it at load time.
 */
function assertNoRegistryCollision(
  name: string,
  registry: ToolRegistry,
  fileName: string,
): void {
  if (registry.getSystemTool(name)) {
    throw new Error(
      `Text skill name "${name}" (file: ${fileName}) collides with an existing system tool`,
    )
  }
  if (registry.getSkill(name)) {
    throw new Error(
      `Text skill name "${name}" (file: ${fileName}) collides with an existing skill`,
    )
  }
  // v0.10.6: also reject collisions with already-registered text skills.
  if (registry.getTextSkill(name)) {
    throw new Error(
      `Text skill name "${name}" (file: ${fileName}) collides with an existing text skill`,
    )
  }
  for (const server of registry.listMCPServers()) {
    for (const toolName of registry.listMCPTools(server)) {
      if (`${server}__${toolName}` === name) {
        throw new Error(
          `Text skill name "${name}" (file: ${fileName}) collides with MCP tool "${server}__${toolName}"`,
        )
      }
    }
  }
}
