// edit.ts
//
// Applies one or more targeted string replacements to a file. The matching
// rules match pi's `edit` tool:
//   - Each `oldText` is matched against the ORIGINAL file content (not the
//     result of earlier edits in the same call).
//   - Each `oldText` must occur exactly once in the original content.
//   - Two `oldText` ranges may not overlap.
//   - All edits are applied atomically: if any check fails the file is
//     left untouched.

import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises'
import { decodeForEdit, encode } from './encoding.js'
import { snapshotGapNotice, type SnapshotContext } from './file-history.js'

export type Edit = { oldText: string; newText: string }

export type EditInput = {
  path: string
  edits: Edit[]
}

// Promise-chain that serializes mutations through a per-path queue. This
// prevents two concurrent edit calls (e.g. two LLM tool calls in flight)
// from clobbering each other.
const fileLocks = new Map<string, Promise<unknown>>()

const withFileLock = <T>(path: string, op: () => Promise<T>): Promise<T> => {
  const prev = fileLocks.get(path) ?? Promise.resolve()
  // Always run `op` on a fresh branch, even if the previous op rejected.
  // We must NOT use `then(op, op)` here: that would pass the rejection
  // reason as `op`'s argument and turn a thrown error inside `op` into
  // a swallowed success.
  const opPromise = prev.then(
    () => op(),
    () => op(),
  )
  // Track the in-flight op so subsequent calls wait for it. We swallow
  // errors on the bookkeeping chain so it never produces an unhandled
  // rejection — the actual error is surfaced through `opPromise` itself.
  const tracked = opPromise.then(
    () => undefined,
    () => undefined,
  )
  tracked.finally(() => {
    if (fileLocks.get(path) === tracked) fileLocks.delete(path)
  }).catch(() => { /* double safety: never let cleanup reject */ })
  fileLocks.set(path, tracked)
  return opPromise
}

const countOccurrences = (haystack: string, needle: string): number => {
  if (needle === '') return 0
  let count = 0
  let from = 0
  for (;;) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) return count
    count += 1
    from = idx + needle.length
  }
}

const intervalsOverlap = (a: [number, number], b: [number, number]): boolean =>
  a[0] < b[1] && b[0] < a[1]

export const editFile = async (input: EditInput, snapshot?: SnapshotContext): Promise<string> => {
  const { path, edits } = input
  if (edits.length === 0) {
    throw new Error('editFile: edits array must not be empty')
  }
  return withFileLock(path, async () => {
    const buf = await fsReadFile(path)
    const decoded = decodeForEdit(buf, path)
    if (!decoded) {
      throw new Error(`editFile: file is neither valid UTF-8 nor lossless GB18030 (round-trip guard failed), refusing to edit to avoid corruption: ${path}`)
    }
    const { text: original, encoding } = decoded

    // Step 1: find every match position against the ORIGINAL content.
    type Match = { edit: Edit; range: [number, number] }
    const matches: Match[] = []
    for (const edit of edits) {
      if (edit.oldText === '') {
        throw new Error('editFile: oldText must be non-empty')
      }
      const count = countOccurrences(original, edit.oldText)
      if (count === 0) {
        throw new Error(`editFile: oldText not found in ${path} (0 occurrences): ${JSON.stringify(edit.oldText)}`)
      }
      if (count > 1) {
        throw new Error(`editFile: oldText is not unique in ${path} (${count} occurrences): ${JSON.stringify(edit.oldText)}`)
      }
      const start = original.indexOf(edit.oldText)
      matches.push({ edit, range: [start, start + edit.oldText.length] })
    }

    // Step 2: check for overlap (sort by start, scan pairs).
    matches.sort((a, b) => a.range[0] - b.range[0])
    for (let i = 1; i < matches.length; i += 1) {
      if (intervalsOverlap(matches[i - 1]!.range, matches[i]!.range)) {
        throw new Error(`editFile: overlapping edits detected for ${path}: ${JSON.stringify(matches.map(m => m.edit.oldText))}`)
      }
    }

    // Step 3: build the new content by walking the original and splicing.
    let out = ''
    let cursor = 0
    for (const m of matches) {
      out += original.slice(cursor, m.range[0])
      out += m.edit.newText
      cursor = m.range[1]
    }
    out += original.slice(cursor)

    // v0.36: 写盘前留底（buf 是原始字节——正是回滚时要还原的东西）。
    // v0.36.1: 留底没成时必须告知，不让用户误以为这次改动可撤。
    const recorded = snapshot === undefined ? undefined : await snapshot.history.record(path, snapshot.sessionId)
    await fsWriteFile(path, encode(out, encoding))
    const gap = recorded === undefined ? undefined : snapshotGapNotice(recorded)
    return `${matches.length} replacement${matches.length === 1 ? '' : 's'} applied to ${path}${gap === undefined ? '' : `\n${gap}`}`
  })
}
