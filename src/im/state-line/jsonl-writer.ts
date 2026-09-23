// Dumb storage: append one JSON line to a file. mkdir -p parent, no lock.

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export const appendJsonl = async <T>(filePath: string, record: T): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true })
  await appendFile(filePath, JSON.stringify(record) + '\n')
}
