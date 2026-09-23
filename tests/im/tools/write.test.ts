// write.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile } from '../../../src/im/tools/write.js'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-shell-write-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('writeFile', () => {
  it('creates a new file with the given content', async () => {
    const p = join(cwd, 'a.txt')
    const result = await writeFile({ path: p, content: 'hello\nworld\n' })
    expect(result).toContain('wrote')
    expect(readFileSync(p, 'utf8')).toBe('hello\nworld\n')
  })

  it('overwrites an existing file', async () => {
    const p = join(cwd, 'a.txt')
    await writeFile({ path: p, content: 'first' })
    await writeFile({ path: p, content: 'second' })
    expect(readFileSync(p, 'utf8')).toBe('second')
  })

  it('creates parent directories as needed', async () => {
    const p = join(cwd, 'deep', 'nested', 'a.txt')
    await writeFile({ path: p, content: 'data' })
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p, 'utf8')).toBe('data')
  })

  it('refuses a path into an OS-protected directory (Windows System32)', async () => {
    // This exercises the defense-in-depth backstop in write.ts:isBlocked.
    // (The factory's resolvePath discards absolute escapes before the tool
    // sees them; this lower-level branch guards direct tool calls.)
    await expect(writeFile({ path: 'C:\\Windows\\System32\\evil.txt', content: 'x' }))
      .rejects.toThrow(/OS-protected|escape/i)
  })
})
