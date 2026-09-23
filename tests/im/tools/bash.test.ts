// bash.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBashTool } from '../../../src/im/tools/bash.js'

// bash is not always present on Windows; skip these tests when unavailable.
const hasBash = (() => {
  if (process.platform === 'win32') {
    // The user has msys2 at C:\msys64; tool will try to find bash.
    return true
  }
  return true
})()

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-shell-bash-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

const skipIfNoBash = (): boolean => {
  if (!hasBash) return true
  // Quick check: try invoking bash with --version
  try {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
    const r = spawnSync('bash', ['-c', 'true'], { stdio: 'ignore' })
    return r.status === null
  } catch {
    return true
  }
}

describe('createBashTool', () => {
  it('returns a ToolDefinition with name, description, parameters, execute', () => {
    if (skipIfNoBash()) return
    const tool = createBashTool({ cwd })
    expect(tool.name).toBe('bash')
    expect(tool.description).toBeTruthy()
    expect(tool.parameters).toBeTruthy()
    expect((tool.parameters.properties as Record<string, unknown>).timeout).toMatchObject({ type: ['number', 'null'] })
    expect(typeof tool.execute).toBe('function')
  })

  it('execute returns stdout from a successful command', async () => {
    if (skipIfNoBash()) return
    const tool = createBashTool({ cwd })
    const out = await tool.execute({ command: 'echo hello', reason: 'verify echo' }) as string
    expect(out).toContain('hello')
  })

  it('execute returns non-zero exit info on failure', async () => {
    if (skipIfNoBash()) return
    const tool = createBashTool({ cwd })
    const out = await tool.execute({ command: 'false', reason: 'test false' }) as string
    expect(out).toMatch(/exit code|failed/i)
  })

  it('can create files via redirection', async () => {
    if (skipIfNoBash()) return
    const target = join(cwd, 'created.txt')
    const tool = createBashTool({ cwd })
    await tool.execute({ command: `echo hi > created.txt`, reason: 'create file' })
    expect(existsSync(target)).toBe(true)
    expect(require('node:fs').readFileSync(target, 'utf8').trim()).toBe('hi')
  })

  it('rejects empty command with a useful error message', async () => {
    if (skipIfNoBash()) return
    const tool = createBashTool({ cwd })
    // ADR-013 / P0: validation is a tool-level contract caught by
    // requireReason/wrapTool. wrapTool re-throws; loop.ts formats the
    // clean English sentence for the LLM. Here we assert the throw.
    await expect(tool.execute({ command: '', reason: 'test empty' })).rejects.toThrow(/command/i)
  })

  it('rejects missing reason with a useful error message', async () => {
    if (skipIfNoBash()) return
    const tool = createBashTool({ cwd })
    await expect(tool.execute({ command: 'echo hi' })).rejects.toThrow(/reason/i)
  })

  // v0.20 (ADR-025 T8): parallelSafe — conservative read-only detection.
  describe('parallelSafe (read-only command detection)', () => {
    it('is declared on the bash tool', () => {
      const tool = createBashTool({ cwd })
      expect(typeof tool.parallelSafe).toBe('function')
      expect(tool.category).toBe('command')
    })

    it('returns true for common read-only commands', () => {
      const tool = createBashTool({ cwd })
      const safe = tool.parallelSafe!
      expect(safe({ command: 'ls -la' })).toBe(true)
      expect(safe({ command: 'cat foo.txt' })).toBe(true)
      expect(safe({ command: 'grep -rn "pattern" src/' })).toBe(true)
      expect(safe({ command: 'rg pattern' })).toBe(true)
      expect(safe({ command: 'find . -name "*.ts"' })).toBe(true)
      expect(safe({ command: 'head -n 5 x.txt' })).toBe(true)
      expect(safe({ command: 'tail -f log.txt' })).toBe(true)
      expect(safe({ command: 'wc -l a.txt' })).toBe(true)
      expect(safe({ command: 'diff a.txt b.txt' })).toBe(true)
      expect(safe({ command: 'pwd' })).toBe(true)
      expect(safe({ command: 'echo hi' })).toBe(true)
      expect(safe({ command: 'which node' })).toBe(true)
      expect(safe({ command: 'stat x' })).toBe(true)
      expect(safe({ command: 'file x.bin' })).toBe(true)
    })

    it('returns false for write/execute commands', () => {
      const tool = createBashTool({ cwd })
      const safe = tool.parallelSafe!
      expect(safe({ command: 'rm -rf build' })).toBe(false)
      expect(safe({ command: 'npm install' })).toBe(false)
      expect(safe({ command: 'node script.js' })).toBe(false)
      expect(safe({ command: 'mkdir -p a/b' })).toBe(false)
      expect(safe({ command: 'mv a b' })).toBe(false)
      expect(safe({ command: 'cp a b' })).toBe(false)
    })

    it('returns false for composite commands (pipes, redirects, chains)', () => {
      const tool = createBashTool({ cwd })
      const safe = tool.parallelSafe!
      // Any metacharacter → not safe, even if the head looks read-only.
      expect(safe({ command: 'cat foo.txt > out.txt' })).toBe(false)
      expect(safe({ command: 'grep x f | tee out' })).toBe(false)
      expect(safe({ command: 'ls && rm -rf /' })).toBe(false)
      expect(safe({ command: 'echo $HOME' })).toBe(false)
      expect(safe({ command: 'cat `whoami`' })).toBe(false)
    })

    it('returns false for missing/empty/non-string command', () => {
      const tool = createBashTool({ cwd })
      const safe = tool.parallelSafe!
      expect(safe({})).toBe(false)
      expect(safe({ command: '' })).toBe(false)
      expect(safe({ command: 42 })).toBe(false)
      expect(safe(undefined)).toBe(false)
      expect(safe(null)).toBe(false)
    })
  })
})

// Avoid unused-write warning
void writeFileSync
