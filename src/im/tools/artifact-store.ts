// artifact-store.ts
//
// Pure in-memory content-addressed store for tool outputs that were truncated.
// v2 will wire bash/read/grep to call store.put() and emit an artifactId in
// truncation markers; v1 only provides the store + query surface.
//
// Design:
//   - Key = sha256(content).slice(0,16) → idempotent (same content, same id)
//   - get() slices by character (not byte) so CJK text never splits mid-codepoint
//   - Zero dependencies: node:crypto for hash, plain Map for storage

import { createHash } from 'node:crypto'

export class ArtifactStore {
  private readonly entries = new Map<string, string>()

  /** Store content and return its artifactId (content hash, first 16 hex chars). */
  put(content: string): string {
    const id = createHash('sha256').update(content).digest('hex').slice(0, 16)
    this.entries.set(id, content)
    return id
  }

  /**
   * Retrieve a slice of a stored artifact.
   * offset default 0, limit default rest-of-content.
   * Missing id → throw clean English sentence (loop formats as Tool "X" failed).
   */
  get(id: string, offset: number = 0, limit?: number): string {
    const content = this.entries.get(id)
    if (content === undefined) {
      throw new Error(`artifact not found: ${id}`)
    }
    if (offset < 0) {
      throw new Error(`offset must be non-negative, got ${offset}`)
    }
    if (limit !== undefined) {
      if (limit < 0) {
        throw new Error(`limit must be non-negative, got ${limit}`)
      }
      if (limit === 0) return ''
    }
    const end = limit !== undefined ? offset + limit : undefined
    return content.slice(offset, end)
  }
}
