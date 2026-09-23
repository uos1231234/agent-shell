// v0.14 P0-2: MCP stdio env whitelist.
//
// buildSafeEnv replaces the prior { ...getDefaultEnvironment(), ...cfg.env }
// merge (which forwarded the SDK's broad default env — effectively all of
// process.env) with an explicit allow-list. Secret-bearing variables
// (ARK_KEY, OPENAI_API_KEY, AWS_*, …) MUST NOT reach spawned MCP servers
// unless explicitly listed in cfg.env.
//
// Tests mock process.env (saving/restoring) so the assertions don't depend
// on the host's actual environment.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildSafeEnv } from '../../src/mcp/connection.js'

describe('mcp/connection — buildSafeEnv (v0.14 P0-2)', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    // Capture the vars we plan to mutate so afterEach can restore exactly.
    for (const k of [
      'PATH', 'Path', 'HOME', 'HOMEPATH', 'USERPROFILE',
      'LANG', 'LANGUAGE', 'LC_ALL', 'TZ', 'TMPDIR', 'TMP', 'TEMP',
      'ARK_KEY', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'CUSTOM_VAR',
    ]) {
      saved[k] = process.env[k]
    }
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('does NOT forward ARK_KEY from process.env when cfgEnv is empty', () => {
    process.env['ARK_KEY'] = 'leak-me'
    const env = buildSafeEnv(undefined)
    expect(env['ARK_KEY']).toBeUndefined()
  })

  it('does NOT forward OPENAI_API_KEY from process.env', () => {
    process.env['OPENAI_API_KEY'] = 'sk-leak'
    const env = buildSafeEnv(undefined)
    expect(env['OPENAI_API_KEY']).toBeUndefined()
  })

  it('does NOT forward AWS_SECRET_ACCESS_KEY from process.env', () => {
    process.env['AWS_SECRET_ACCESS_KEY'] = 'aws-leak'
    const env = buildSafeEnv(undefined)
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined()
  })

  it('forwards PATH from process.env', () => {
    process.env['PATH'] = '/usr/bin:/bin'
    const env = buildSafeEnv(undefined)
    expect(env['PATH']).toBe('/usr/bin:/bin')
  })

  it('forwards HOME from process.env', () => {
    process.env['HOME'] = '/home/test'
    const env = buildSafeEnv(undefined)
    expect(env['HOME']).toBe('/home/test')
  })

  it('forwards TZ / TMPDIR / TEMP from process.env', () => {
    process.env['TZ'] = 'UTC'
    process.env['TMPDIR'] = '/tmp'
    process.env['TEMP'] = 'C:\\Temp'
    const env = buildSafeEnv(undefined)
    expect(env['TZ']).toBe('UTC')
    expect(env['TMPDIR']).toBe('/tmp')
    expect(env['TEMP']).toBe('C:\\Temp')
  })

  it('forwards cfgEnv vars (explicit caller overrides)', () => {
    const env = buildSafeEnv({ CUSTOM_VAR: 'x' })
    expect(env['CUSTOM_VAR']).toBe('x')
  })

  it('cfgEnv wins when both process.env and cfgEnv define the same var', () => {
    process.env['ARK_KEY'] = 'from-process-env'
    const env = buildSafeEnv({ ARK_KEY: 'from-cfg' })
    expect(env['ARK_KEY']).toBe('from-cfg')
  })

  it('cfgEnv can inject a secret the caller explicitly wants forwarded', () => {
    process.env['OPENAI_API_KEY'] = 'should-not-leak-automatically'
    const env = buildSafeEnv({ OPENAI_API_KEY: 'explicitly-provided' })
    expect(env['OPENAI_API_KEY']).toBe('explicitly-provided')
  })

  it('returns an empty object when no safe vars are set and cfgEnv is empty', () => {
    // Clear all safe vars for this isolated case.
    for (const k of [
      'PATH', 'Path', 'HOME', 'HOMEPATH', 'USERPROFILE',
      'LANG', 'LANGUAGE', 'LC_ALL', 'TZ', 'TMPDIR', 'TMP', 'TEMP',
    ]) {
      delete process.env[k]
    }
    const env = buildSafeEnv(undefined)
    expect(env).toEqual({})
  })

  it('only contains whitelisted process.env keys + cfgEnv keys', () => {
    process.env['ARK_KEY'] = 'leak'
    process.env['PATH'] = '/bin'
    process.env['HOME'] = '/h'
    const env = buildSafeEnv({ EXTRA: '1' })
    const keys = Object.keys(env)
    // ARK_KEY must never appear; PATH/HOME/EXTRA are allowed.
    expect(keys).not.toContain('ARK_KEY')
    expect(keys).toContain('PATH')
    expect(keys).toContain('HOME')
    expect(keys).toContain('EXTRA')
  })
})
