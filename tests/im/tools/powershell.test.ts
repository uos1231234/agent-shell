// powershell.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPowerShellTool } from '../../../src/im/tools/powershell.js'

const hasPowerShell = (() => {
  try {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
    const r = spawnSync('powershell', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  }
})()

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-shell-ps-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

const skipIfNoPS = (): boolean => !hasPowerShell

describe('createPowerShellTool', () => {
  it('returns a ToolDefinition', () => {
    if (skipIfNoPS()) return
    const tool = createPowerShellTool({ cwd })
    expect(tool.name).toBe('powershell')
    expect(tool.description).toBeTruthy()
    expect(tool.parameters).toBeTruthy()
    expect(typeof tool.execute).toBe('function')
  })

  it('execute returns stdout from a successful command', async () => {
    if (skipIfNoPS()) return
    const tool = createPowerShellTool({ cwd })
    const out = await tool.execute({ command: 'Write-Host hello', reason: 'verify' }) as string
    expect(out).toContain('hello')
  })

  it('execute returns non-zero exit info on failure', async () => {
    if (skipIfNoPS()) return
    const tool = createPowerShellTool({ cwd })
    const out = await tool.execute({ command: 'exit 7', reason: 'test exit' }) as string
    expect(out).toMatch(/exit code|failed/i)
  })

  it('rejects empty command with a useful error message', async () => {
    if (skipIfNoPS()) return
    const tool = createPowerShellTool({ cwd })
    // ADR-013 / P0: validation is a tool-level contract caught by
    // requireReason/wrapTool. wrapTool re-throws; loop.ts formats the
    // clean English sentence for the LLM. Here we assert the throw.
    await expect(tool.execute({ command: '', reason: 'test empty' })).rejects.toThrow(/command/i)
  })

  it('rejects missing reason with a useful error message', async () => {
    if (skipIfNoPS()) return
    const tool = createPowerShellTool({ cwd })
    await expect(tool.execute({ command: 'Write-Host hello' })).rejects.toThrow(/reason/i)
  })

  it('can read file content', async () => {
    if (skipIfNoPS()) return
    const target = join(cwd, 'a.txt')
    const fs = require('node:fs') as typeof import('node:fs')
    fs.writeFileSync(target, 'sample data')
    const tool = createPowerShellTool({ cwd })
    const out = await tool.execute({ command: `Get-Content a.txt`, reason: 'read' }) as string
    expect(out).toContain('sample data')
  })

  void existsSync
})
