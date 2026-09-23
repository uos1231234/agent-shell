// index.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBuiltinTools } from '../../../src/im/tools/index.js'
import { ToolRegistry } from '../../../src/shell/registry.js'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-shell-tools-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('createBuiltinTools', () => {
  it('returns a ToolRegistry populated with all 8 tools', () => {
    const r = createBuiltinTools({ cwd })
    const names = r.listSystemTools()
    expect(names).toContain('read')
    expect(names).toContain('write')
    expect(names).toContain('edit')
    expect(names).toContain('ls')
    expect(names).toContain('find')
    expect(names).toContain('grep')
    expect(names).toContain('bash')
    // powershell is also registered but only on Windows by default
    if (process.platform === 'win32') {
      expect(names).toContain('powershell')
    }
  })

  it('registers open_url and read_media tools', () => {
    const r = createBuiltinTools({ cwd })
    const names = r.listSystemTools()
    expect(names).toContain('open_url')
    expect(names).toContain('read_media')

    // Verify schemas include reason field (ADR-013 contract)
    const schemas = r.toOpenAIToolSchemas()
    const openUrlSchema = schemas.find(s => s.function.name === 'open_url')
    expect(openUrlSchema).toBeDefined()
    expect(openUrlSchema!.function.parameters.properties).toHaveProperty('url')
    expect(openUrlSchema!.function.parameters.properties).toHaveProperty('reason')

    const readMediaSchema = schemas.find(s => s.function.name === 'read_media')
    expect(readMediaSchema).toBeDefined()
    expect(readMediaSchema!.function.parameters.properties).toHaveProperty('path')
    expect(readMediaSchema!.function.parameters.properties).toHaveProperty('reason')
  })

  it('end-to-end: write -> read -> edit', async () => {
    const r = createBuiltinTools({ cwd })
    // ADR-013: every tool call carries a `reason`. This is the contract the
    // LLM is expected to honor on its next turn.
    await r.execute('write', { path: join(cwd, 'a.txt'), content: 'line1\nline2\n', reason: 'create a.txt' })
    const read = await r.execute('read', { path: join(cwd, 'a.txt'), reason: 'verify write' }) as string
    expect(read).toBe('1\tline1\n2\tline2')
    await r.execute('edit', { path: join(cwd, 'a.txt'), edits: [{ oldText: 'line2', newText: 'LINE2' }], reason: 'uppercase' })
    const final = readFileSync(join(cwd, 'a.txt'), 'utf8')
    expect(final).toBe('line1\nLINE2\n')
  })

  it('end-to-end: ls + find + grep', async () => {
    const r = createBuiltinTools({ cwd })
    writeFileSync(join(cwd, 'a.ts'), 'foo\n')
    writeFileSync(join(cwd, 'b.ts'), 'bar\n')
    mkdirSync(join(cwd, 'sub'))
    writeFileSync(join(cwd, 'sub', 'c.ts'), 'foo\n')

    const ls = await r.execute('ls', { path: cwd, reason: 'list cwd' }) as string
    expect(ls).toContain('a.ts')
    expect(ls).toContain('b.ts')
    expect(ls).toContain('sub/')

    const found = await r.execute('find', { pattern: '**/*.ts', path: cwd, reason: 'find ts' }) as string
    expect(found).toContain('a.ts')
    expect(found).toContain('sub/c.ts')

    const grep = await r.execute('grep', { pattern: 'foo', path: cwd, reason: 'grep foo' }) as string
    expect(grep).toContain('a.ts:1:foo')
    expect(grep).toContain('sub/c.ts:1:foo')
  })

  it('passes tools through the registry -> OpenAI schema export', () => {
    const r = createBuiltinTools({ cwd })
    const schemas = r.toOpenAIToolSchemas()
    const names = schemas.map(s => s.function.name)
    expect(names).toContain('read')
    expect(names).toContain('edit')
    // The export shape is the OpenAI function-calling format.
    const readSchema = schemas.find(s => s.function.name === 'read')!
    expect(readSchema.type).toBe('function')
    expect(readSchema.function.parameters.type).toBe('object')
    expect(readSchema.function.parameters.properties).toHaveProperty('path')
    // ADR-013: every tool's schema declares a `reason` field.
    expect(readSchema.function.parameters.properties).toHaveProperty('reason')
  })
})

describe('path anchoring via tools/path.ts:resolvePath', () => {
  it('resolves relative paths against the tool cwd (regression: require is not defined)', async () => {
    // The factory's old local resolver called require('node:path') inside an
    // ESM module: ANY relative path blew up with "require is not defined".
    // This exercises that branch — a relative write/read round-trip.
    const r = createBuiltinTools({ cwd })
    await r.execute('write', { path: 'rel.txt', content: 'relative\n', reason: 'write a relative path' })
    const read = await r.execute('read', { path: 'rel.txt', reason: 'read a relative path' }) as string
    expect(read).toBe('1\trelative')
    expect(existsSync(join(cwd, 'rel.txt'))).toBe(true)
  })

  it('refuses a path that escapes the cwd via ..', async () => {
    const r = createBuiltinTools({ cwd })
    // P0: wrapTool re-throws; the tool no longer returns a formatted string.
    await expect(
      r.execute('read', { path: '../escape.txt', reason: 'try to escape' }),
    ).rejects.toThrow('escapes working directory')
  })

  it('refuses an absolute path outside the cwd', async () => {
    const r = createBuiltinTools({ cwd })
    // cwd is a fresh mkdtempSync subdirectory of tmpdir(), so tmpdir()
    // itself is an absolute path outside the cwd.
    // P0: wrapTool re-throws; the tool no longer returns a formatted string.
    await expect(
      r.execute('write', { path: tmpdir(), content: 'x', reason: 'try to escape' }),
    ).rejects.toThrow('escapes working directory')
  })
})

// The ToolRegistry class is imported for completeness; confirm we can still
// build a fresh registry without the tools.
void ToolRegistry
