// ls.ts
//
// Lists entries in a directory. Directories are suffixed with `/` so the
// LLM can tell them apart from files at a glance. Entries are sorted
// alphabetically.

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export type LsInput = {
  path: string
  limit?: number
  /** v0.29: 外部取消信号——单层 readdir 极快，但保持所有工具信号语义一致。 */
  signal?: AbortSignal
}

const DEFAULT_LIMIT = 500

export const lsDirectory = async (input: LsInput): Promise<string> => {
  const { path, limit = DEFAULT_LIMIT, signal } = input
  if (signal?.aborted === true) throw new Error('ls was aborted by the caller.')
  const entries = await readdir(path)
  const infos = await Promise.all(
    entries.map(async (name) => {
      if (signal?.aborted === true) throw new Error('ls was aborted by the caller.')
      try {
        const s = await stat(join(path, name))
        return { name, isDir: s.isDirectory() }
      } catch {
        return { name, isDir: false }
      }
    }),
  )
  infos.sort((a, b) => a.name.localeCompare(b.name))
  const limited = infos.slice(0, limit)
  return limited.map((e) => (e.isDir ? `${e.name}/` : e.name)).join('\n')
}
