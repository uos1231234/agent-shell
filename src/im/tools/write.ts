// write.ts
//
// Writes a string to a file. The whole file is replaced (no append).
// Parent directories are created as needed.
//
// This tool refuses to write into OS-protected directories (e.g. the
// Windows System32 tree) as a hard refusal for obviously dangerous paths.
// The `tools/index.ts` factory anchors every path through
// `path.ts:resolvePath`, which confines it to the tool's working directory;
// this check is a backstop in case the resolver's scope ever changes. It is
// deliberately narrow — not a full sandbox of its own.

import { writeFile as fsWriteFile, mkdir } from 'node:fs/promises'
import { dirname, sep } from 'node:path'
import { snapshotGapNotice, type SnapshotContext } from './file-history.js'

export type WriteInput = {
  path: string
  content: string
}

const isBlocked = (p: string): boolean => {
  const lower = p.toLowerCase().replace(/\//g, sep)
  if (process.platform === 'win32') {
    return lower.startsWith(`c:${sep}windows${sep}`)
  }
  return lower.startsWith('/etc/') || lower.startsWith('/boot/') || lower.startsWith('/proc/') || lower.startsWith('/sys/')
}

export const writeFile = async (input: WriteInput, snapshot?: SnapshotContext): Promise<string> => {
  const { path, content } = input
  if (isBlocked(path)) {
    throw new Error(`writeFile: refusing to write to an OS-protected path: ${path}`)
  }
  await mkdir(dirname(path), { recursive: true })
  // v0.36: 覆盖前留底（含"原本不存在"的情形——回滚时据此删除新建文件）。
  // v0.36.1: 留底没成时必须告知——否则用户以为 /rewind 兜住了一切。
  const recorded = snapshot === undefined ? undefined : await snapshot.history.record(path, snapshot.sessionId)
  await fsWriteFile(path, content, 'utf8')
  const gap = recorded === undefined ? undefined : snapshotGapNotice(recorded)
  return `wrote ${content.length} bytes to ${path}${gap === undefined ? '' : `\n${gap}`}`
}
