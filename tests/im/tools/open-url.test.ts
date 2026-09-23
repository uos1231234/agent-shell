// open-url.test.ts — scheme validation + headless rejection + launcher selection.
//
// We mock child_process.spawn so no real process is launched. The test
// verifies: (1) http/https pass, (2) file:// / javascript: / data: are
// rejected, (3) headless Linux (no DISPLAY/WAYLAND) is rejected,
// (4) the correct launcher command is selected per platform.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'

// Capture spawn calls so we can assert the command + args.
const spawnCalls: { cmd: string; args: string[] }[] = []
vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[], opts: unknown) => {
    spawnCalls.push({ cmd, args })
    // Return a fake child with unref + on, mimicking ChildProcess enough.
    return {
      unref: () => {},
      on: () => {},
      stdio: [],
      pid: 12345,
    }
  },
}))

// We must import AFTER the mock is registered.
// Use dynamic import in a top-level await (vitest supports this in ESM).
const { openUrl, OpenUrlError } = await import('../../../src/im/tools/open-url.js')

const origPlatform = process.platform
const origEnv = { ...process.env }

describe('openUrl — scheme validation', () => {
  beforeEach(() => { spawnCalls.length = 0 })
  afterEach(() => {
    // Restore platform/env if a test changed them.
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
    // Restore env keys we might have deleted.
    for (const k of Object.keys(origEnv)) {
      if (process.env[k] === undefined) process.env[k] = origEnv[k]
    }
  })

  it('accepts http:// URLs', () => {
    // Ensure not headless linux
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const msg = openUrl('http://example.com')
    expect(msg).toContain('http://example.com')
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]!.args).toEqual(['http://example.com'])
  })

  it('accepts https:// URLs', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    openUrl('https://example.com/path?q=1')
    expect(spawnCalls[0]!.args).toEqual(['https://example.com/path?q=1'])
  })

  it('rejects file:// scheme', () => {
    expect(() => openUrl('file:///etc/passwd')).toThrow(OpenUrlError)
    expect(() => openUrl('file:///etc/passwd')).toThrow(/http\/https/)
  })

  it('rejects javascript: scheme', () => {
    expect(() => openUrl('javascript:alert(1)')).toThrow(OpenUrlError)
  })

  it('rejects data: scheme', () => {
    expect(() => openUrl('data:text/html,<script>1</script>')).toThrow(OpenUrlError)
  })

  it('rejects malformed URLs', () => {
    expect(() => openUrl('not a url at all')).toThrow(OpenUrlError)
  })
})

describe('openUrl — platform launcher selection', () => {
  beforeEach(() => { spawnCalls.length = 0 })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
  })

  it('uses "open" on macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    openUrl('https://example.com')
    expect(spawnCalls[0]!.cmd).toBe('open')
  })

  it('uses "explorer" on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    openUrl('https://example.com')
    expect(spawnCalls[0]!.cmd).toBe('explorer')
  })

  it('uses "xdg-open" on Linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    process.env['DISPLAY'] = ':0'
    openUrl('https://example.com')
    expect(spawnCalls[0]!.cmd).toBe('xdg-open')
    delete process.env['DISPLAY']
  })
})

describe('openUrl — headless environment rejection', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
    // Restore DISPLAY/WAYLAND
    if (origEnv['DISPLAY'] !== undefined) process.env['DISPLAY'] = origEnv['DISPLAY']
    else delete process.env['DISPLAY']
    if (origEnv['WAYLAND_DISPLAY'] !== undefined) process.env['WAYLAND_DISPLAY'] = origEnv['WAYLAND_DISPLAY']
    else delete process.env['WAYLAND_DISPLAY']
  })

  it('rejects on headless Linux (no DISPLAY, no WAYLAND_DISPLAY)', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    delete process.env['DISPLAY']
    delete process.env['WAYLAND_DISPLAY']
    expect(() => openUrl('https://example.com')).toThrow(OpenUrlError)
    expect(() => openUrl('https://example.com')).toThrow(/headless/)
  })

  it('allows on Linux with WAYLAND_DISPLAY set', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    delete process.env['DISPLAY']
    process.env['WAYLAND_DISPLAY'] = 'wayland-0'
    expect(() => openUrl('https://example.com')).not.toThrow()
  })
})

// Keep the spawn import "used" so TS doesn't complain about the mock target.
void spawn
