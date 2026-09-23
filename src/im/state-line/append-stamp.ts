// Append a StampRecord to stamps.jsonl. No dedup — duplicate silently, reader de-duplicates (plan §7.2 #5).

import { appendJsonl } from './jsonl-writer.js'
import type { StampRecord } from './types.js'

export const appendStamp = (
  stampsJsonlPath: string,
  stamp: string,
  path: string,
  layer: 'M1' | 'M2' | 'M3',
): Promise<void> => {
  const record: StampRecord = { stamp, path, layer, written_at: Date.now() }
  return appendJsonl(stampsJsonlPath, record)
}
