// rg-runner.test.ts
//
// Tests for the ripgrep process executor. These tests spawn real rg
// processes against temp directories — they require rg on PATH (which the
// CI/dev environment provides). The parseOutput tests are pure and do not
// spawn anything.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRg } from '../../../../src/im/tools/search/rg-resolver.js'
import {
  RgRunner,
  parseRgJsonOutput,
  type RgMatch,
} from '../../../../src/im/tools/search/rg-runner.js'

// All tests share one resolved runner; if rg is not available these tests
// are skipped.
let runner: RgRunner | null = null
let rgAvailable = false

beforeEach(async () => {
  try {
    const res = await resolveRg()
    runner = new RgRunner(res.path)
    rgAvailable = true
  } catch {
    runner = null
    rgAvailable = false
  }
})

// Helper to skip tests when rg is not installed.
const rgTest = (name: string, fn: () => Promise<void>, timeout?: number): void => {
  it(name, async () => {
    if (!rgAvailable || !runner) {
      console.warn(`[skipped] rg not available: ${name}`)
      return
    }
    await fn()
  }, timeout)
}

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-shell-rg-runner-'))
})

afterEach(() => {
  // On Windows, the rg child process may still hold file handles briefly
  // after being killed. Retry the cleanup a few times with a small delay.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(cwd, { recursive: true, force: true })
      return
    } catch {
      // Back off and retry — the process is likely still dying.
      const start = Date.now()
      while (Date.now() - start < 200) { /* spin-wait 200ms */ }
    }
  }
  // Final attempt — if this throws, let it surface.
  rmSync(cwd, { recursive: true, force: true })
})

const writeFile = (rel: string, content: string): string => {
  const abs = join(cwd, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

// ---------------------------------------------------------------------------
// parseRgJsonOutput — pure unit tests (no rg spawn needed)
// ---------------------------------------------------------------------------

describe('parseRgJsonOutput', () => {
  it('parses match lines correctly', () => {
    const raw = [
      '{"type":"begin","data":{"path":{"text":"a.txt"}}}',
      '{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"hello\\n"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"hello"},"start":0,"end":5}]}}',
      '{"type":"match","data":{"path":{"text":"a.txt"},"lines":{"text":"world\\n"},"line_number":2,"absolute_offset":6,"submatches":[]}}',
      '{"type":"end","data":{"path":{"text":"a.txt"}}}',
      '{"type":"summary","data":{}}',
    ].join('\n')

    const matches = parseRgJsonOutput(raw)
    expect(matches).toHaveLength(2)
    expect(matches[0]).toEqual<RgMatch>({
      path: 'a.txt',
      lineNumber: 1,
      content: 'hello',
      isContext: false,
    })
    expect(matches[1]).toEqual<RgMatch>({
      path: 'a.txt',
      lineNumber: 2,
      content: 'world',
      isContext: false,
    })
  })

  it('distinguishes match from context lines', () => {
    const raw = [
      '{"type":"context","data":{"path":{"text":"b.txt"},"lines":{"text":"before\\n"},"line_number":1,"absolute_offset":0,"submatches":[]}}',
      '{"type":"match","data":{"path":{"text":"b.txt"},"lines":{"text":"MATCH\\n"},"line_number":2,"absolute_offset":7,"submatches":[{"match":{"text":"MATCH"},"start":0,"end":5}]}}',
      '{"type":"context","data":{"path":{"text":"b.txt"},"lines":{"text":"after\\n"},"line_number":3,"absolute_offset":13,"submatches":[]}}',
    ].join('\n')

    const matches = parseRgJsonOutput(raw)
    expect(matches).toHaveLength(3)
    expect(matches[0]!.isContext).toBe(true)
    expect(matches[0]!.content).toBe('before')
    expect(matches[1]!.isContext).toBe(false)
    expect(matches[1]!.content).toBe('MATCH')
    expect(matches[2]!.isContext).toBe(true)
    expect(matches[2]!.content).toBe('after')
  })

  it('skips begin / end / summary lines', () => {
    const raw = [
      '{"type":"begin","data":{"path":{"text":"x.txt"}}}',
      '{"type":"end","data":{"path":{"text":"x.txt"}}}',
      '{"type":"summary","data":{}}',
    ].join('\n')

    const matches = parseRgJsonOutput(raw)
    expect(matches).toHaveLength(0)
  })

  it('skips non-JSON lines gracefully', () => {
    const raw = [
      'this is not json',
      '{"type":"match","data":{"path":{"text":"y.txt"},"lines":{"text":"hi\\n"},"line_number":1,"absolute_offset":0,"submatches":[]}}',
      '',
      '{"broken json',
    ].join('\n')

    const matches = parseRgJsonOutput(raw)
    expect(matches).toHaveLength(1)
    expect(matches[0]!.content).toBe('hi')
  })

  it('strips trailing newline and \\r from content', () => {
    const raw = [
      '{"type":"match","data":{"path":{"text":"c.txt"},"lines":{"text":"hello\\r\\n"},"line_number":1,"absolute_offset":0,"submatches":[]}}',
    ].join('\n')

    const matches = parseRgJsonOutput(raw)
    expect(matches[0]!.content).toBe('hello')
  })

  it('returns empty array for empty input', () => {
    expect(parseRgJsonOutput('')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// RgRunner.run — integration tests (require real rg on PATH)
// ---------------------------------------------------------------------------

describe('RgRunner.run', () => {
  rgTest('returns matches for a simple pattern', async () => {
    writeFile('a.txt', 'hello\nworld\nhello again\n')
    const matches = await runner!.run(
      ['--json', '--color', 'never', '--line-number', '--', 'hello', '.'],
      { cwd },
    )
    expect(matches.length).toBe(2)
    expect(matches[0]!.lineNumber).toBe(1)
    expect(matches[1]!.lineNumber).toBe(3)
    expect(matches.every((m: RgMatch) => !m.isContext)).toBe(true)
  })

  rgTest('returns empty array on no matches (exit code 1)', async () => {
    writeFile('a.txt', 'hello\n')
    const matches = await runner!.run(
      ['--json', '--color', 'never', '--line-number', '--', 'nonexistent', '.'],
      { cwd },
    )
    expect(matches).toHaveLength(0)
  })

  rgTest('throws on rg error (exit code 2) for bad regex', async () => {
    writeFile('a.txt', 'hello\n')
    // An invalid regex pattern causes rg to exit with code 2.
    await expect(
      runner!.run(
        ['--json', '--color', 'never', '--line-number', '--', '(unclosed', '.'],
        { cwd },
      ),
    ).rejects.toThrow(/ripgrep error/)
  })

  rgTest('respects context lines', async () => {
    writeFile('a.txt', 'line1\nMATCH\nline3\n')
    const matches = await runner!.run(
      ['--json', '--color', 'never', '--line-number', '-C', '1', '--', 'MATCH', '.'],
      { cwd },
    )
    // Should get: context(line1), match(MATCH), context(line3)
    expect(matches.length).toBe(3)
    expect(matches[0]!.isContext).toBe(true)
    expect(matches[0]!.content).toBe('line1')
    expect(matches[1]!.isContext).toBe(false)
    expect(matches[1]!.content).toBe('MATCH')
    expect(matches[2]!.isContext).toBe(true)
    expect(matches[2]!.content).toBe('line3')
  })

  rgTest('throws on timeout', async () => {
    // Create a large file that takes a while to search with a complex regex.
    // We use a very short timeout (50ms) to force a timeout.
    let body = ''
    for (let i = 0; i < 1000; i += 1) body += `line ${i} ${'x'.repeat(100)}\n`
    writeFile('big.txt', body)
    // Use a catastrophic backtracking pattern with a 50ms timeout.
    await expect(
      runner!.run(
        ['--json', '--color', 'never', '--line-number', '--', '(a+)+$', '.'],
        { cwd, timeout: 50 },
      ),
    ).rejects.toThrow()
  }, 15000)

  rgTest('throws on abort signal', async () => {
    let body = ''
    for (let i = 0; i < 5000; i += 1) body += `line ${i} ${'x'.repeat(200)}\n`
    writeFile('huge.txt', body)

    const controller = new AbortController()
    // Abort almost immediately.
    setTimeout(() => controller.abort(), 10)

    await expect(
      runner!.run(
        ['--json', '--color', 'never', '--line-number', '--', '(a+)+$', '.'],
        { cwd, signal: controller.signal },
      ),
    ).rejects.toThrow(/aborted/)
  }, 15000)

  rgTest('throws on spawn failure (bad rg path)', async () => {
    const badRunner = new RgRunner('/nonexistent/path/to/rg')
    await expect(
      badRunner.run(
        ['--json', '--', 'x', '.'],
        { cwd },
      ),
    ).rejects.toThrow(/Failed to spawn ripgrep/)
  })

  rgTest('respects --max-count to limit matches', async () => {
    let body = ''
    for (let i = 0; i < 20; i += 1) body += 'match\n'
    writeFile('many.txt', body)
    const matches = await runner!.run(
      ['--json', '--color', 'never', '--line-number', '--max-count', '5', '--', 'match', '.'],
      { cwd },
    )
    expect(matches.length).toBe(5)
  })
})
