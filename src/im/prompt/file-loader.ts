/**
 * Prompt file loader — v0.19 D1
 *
 * Loads prompt layers from file system (managed → user → project → local).
 * Files that don't exist are silently skipped.
 * Files load in full (no truncation — 2026-09-12 user decision).
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PromptLayer } from './types.js'


export async function loadPromptLayers(opts: {
  basePath: string
  projectFile?: string
  localFile?: string
  globalPath?: string
  userPath?: string
}): Promise<PromptLayer[]> {
  const layers: PromptLayer[] = []
  const projectFile = opts.projectFile ?? 'AGENTS.md'
  const localFile = opts.localFile ?? '.claude/local.md'

  if (opts.globalPath) {
    const content = await safeRead(opts.globalPath)
    if (content) layers.push({ name: 'managed', content, priority: 0 })
  }

  const userPath = opts.userPath ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.agent-shell', 'PROMPT.md')
  const userContent = await safeRead(userPath)
  if (userContent) layers.push({ name: 'user', content: userContent, priority: 10 })

  const projectPath = join(opts.basePath, projectFile)
  const projectContent = await safeRead(projectPath)
  if (projectContent) layers.push({ name: 'project', content: projectContent, priority: 20 })

  const localPath = join(opts.basePath, localFile)
  const localContent = await safeRead(localPath)
  if (localContent) layers.push({ name: 'local', content: localContent, priority: 30 })

  return layers
}

async function safeRead(path: string): Promise<string | null> {
  try {
    // 不截断（2026-09-12 用户拍板）：分层文件全文装载。
    const content = await readFile(path, 'utf-8')
    return content.length > 0 ? content : null
  } catch {
    return null
  }
}
