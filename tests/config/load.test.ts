// Tests for provider config service — paths + load + validation.
//
// Invariants:
//   - resolveShellHome: explicit homeDir > env AGENT_SHELL_HOME > ~/.agent-shell.
//   - loadProviderConfig: missing file → undefined (normal, env fallback);
//     invalid JSON / bad shape → throw with config path in message;
//     unknown fields ignored; active entry resolved (explicit or first).
//   - upstreamTrusted: boolean when present; absent → true semantics at caller.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveShellHome, resolveConfigPath, ensureShellHome } from '../../src/config/paths.js'
import { loadProviderConfig, CONFIG_FILE } from '../../src/config/load.js'

describe('resolveShellHome', () => {
  it('explicit homeDir wins over env and default', () => {
    expect(resolveShellHome('/explicit/home', { AGENT_SHELL_HOME: '/env/home' })).toBe('/explicit/home')
  })

  it('env AGENT_SHELL_HOME wins over default', () => {
    expect(resolveShellHome(undefined, { AGENT_SHELL_HOME: '/env/home' })).toBe('/env/home')
  })

  it('falls back to ~/.agent-shell when neither set', () => {
    const result = resolveShellHome(undefined, {})
    expect(result).toContain('.agent-shell')
  })
})

describe('resolveConfigPath', () => {
  it('explicit configPath wins', () => {
    expect(resolveConfigPath({ configPath: '/custom/my.json' })).toBe('/custom/my.json')
  })

  it('joins shell home + providers.json otherwise', () => {
    const result = resolveConfigPath({ homeDir: '/home/dir' })
    expect(result).toBe(join('/home/dir', 'providers.json'))
    expect(CONFIG_FILE).toBe('providers.json')
  })

  it('env AGENT_SHELL_HOME feeds the path', () => {
    const result = resolveConfigPath({ env: { AGENT_SHELL_HOME: '/env/home' } })
    expect(result).toBe(join('/env/home', 'providers.json'))
  })
})

describe('ensureShellHome', () => {
  it('creates the directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shell-home-'))
    const target = join(dir, 'nested', 'home')
    ensureShellHome(target)
    expect(existsSync(target)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('loadProviderConfig', () => {
  let tmpDir: string
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-shell-cfg-'))
  })
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const writeConfig = (content: string): string => {
    const p = join(tmpDir, 'case-' + Math.random().toString(36).slice(2) + '.json')
    writeFileSync(p, content)
    return p
  }

  it('returns undefined when file does not exist (normal state, env fallback)', () => {
    expect(loadProviderConfig({ configPath: join(tmpDir, 'missing.json') })).toBeUndefined()
  })

  it('throws clean error on invalid JSON', () => {
    const p = writeConfig('{ not valid json')
    expect(() => loadProviderConfig({ configPath: p })).toThrowError(/not valid JSON/)
  })

  it('throws when top level is not an object', () => {
    const p = writeConfig('[1,2,3]')
    expect(() => loadProviderConfig({ configPath: p })).toThrowError(/top level must be an object/)
  })

  it('throws when active names a missing provider', () => {
    const p = writeConfig(JSON.stringify({ active: 'missing', providers: { ark: { url: 'https://x', model: 'm' } } }))
    expect(() => loadProviderConfig({ configPath: p })).toThrowError(/"active" must name an entry/)
  })

  it('throws when providers missing but active set', () => {
    const p = writeConfig(JSON.stringify({ active: 'ark' }))
    expect(() => loadProviderConfig({ configPath: p })).toThrowError(/"active" must name/)
  })

  it('validates url must be http(s)', () => {
    const p = writeConfig(JSON.stringify({ active: 'ark', providers: { ark: { url: 'ftp://x', model: 'm' } } }))
    expect(() => loadProviderConfig({ configPath: p })).toThrowError(/"url" must be an http\(s\) URL/)
  })

  it('validates model must be non-empty string', () => {
    const p = writeConfig(JSON.stringify({ active: 'ark', providers: { ark: { url: 'https://x', model: '' } } }))
    expect(() => loadProviderConfig({ configPath: p })).toThrowError(/"model" must be a non-empty/)
  })

  it('validates upstreamTrusted must be boolean', () => {
    const p = writeConfig(JSON.stringify({ active: 'ark', providers: { ark: { url: 'https://x', model: 'm', upstreamTrusted: 'yes' } } }))
    expect(() => loadProviderConfig({ configPath: p })).toThrowError(/"upstreamTrusted" must be a boolean/)
  })

  // v0.41 D19：严格角色交替开关。坏配置 throw 不静默（本文件既有风格）。
  it('validates capabilities.strictAlternation must be boolean', () => {
    const p = writeConfig(JSON.stringify({
      active: 'ark',
      providers: { ark: { url: 'https://x', model: 'm', capabilities: { strictAlternation: 'yes' } } },
    }))
    expect(() => loadProviderConfig({ configPath: p })).toThrowError(/"capabilities\.strictAlternation" must be a boolean/)
  })

  it('accepts capabilities.strictAlternation true and false and reads it back', () => {
    for (const v of [true, false]) {
      const p = writeConfig(JSON.stringify({
        active: 'ark',
        providers: { ark: { url: 'https://x', model: 'm', capabilities: { strictAlternation: v } } },
      }))
      expect(loadProviderConfig({ configPath: p })?.provider.capabilities?.strictAlternation).toBe(v)
    }
  })

  it('capabilities.strictAlternation 缺省为 undefined（宽松：既有会话 wire 形状零变化）', () => {
    const p = writeConfig(JSON.stringify({
      active: 'ark',
      providers: { ark: { url: 'https://x', model: 'm', capabilities: { maxInputTokens: 1000 } } },
    }))
    expect(loadProviderConfig({ configPath: p })?.provider.capabilities?.strictAlternation).toBeUndefined()
  })

  it('strictAlternation 与既有的正整数 capabilities 字段共存', () => {
    const p = writeConfig(JSON.stringify({
      active: 'ark',
      providers: {
        ark: {
          url: 'https://x', model: 'm',
          capabilities: { maxInputTokens: 1000000, maxOutputTokens: 384000, strictAlternation: true },
        },
      },
    }))
    const caps = loadProviderConfig({ configPath: p })?.provider.capabilities
    expect(caps).toEqual({ maxInputTokens: 1000000, maxOutputTokens: 384000, strictAlternation: true })
  })

  it('validates apiKey must be string when present', () => {
    const p = writeConfig(JSON.stringify({ active: 'ark', providers: { ark: { url: 'https://x', model: 'm', apiKey: 123 } } }))
    expect(() => loadProviderConfig({ configPath: p })).toThrowError(/"apiKey" must be a string/)
  })

  it('ignores unknown fields (forward compatibility)', () => {
    const p = writeConfig(JSON.stringify({
      active: 'ark',
      futureField: { anything: true },
      providers: { ark: { url: 'https://x', model: 'm', unknownLater: 1 } },
    }))
    const result = loadProviderConfig({ configPath: p })
    expect(result?.provider.model).toBe('m')
  })

  it('resolves explicit active entry', () => {
    const p = writeConfig(JSON.stringify({
      active: 'ark',
      providers: {
        other: { url: 'https://other', model: 'other-model' },
        ark: { url: 'https://ark', model: 'ark-model', apiKey: 'k1', upstreamTrusted: false },
      },
    }))
    const result = loadProviderConfig({ configPath: p })
    expect(result?.name).toBe('ark')
    expect(result?.provider.model).toBe('ark-model')
    expect(result?.provider.upstreamTrusted).toBe(false)
    expect(result?.provider.apiKey).toBe('k1')
  })

  it('falls back to first provider when active omitted', () => {
    const p = writeConfig(JSON.stringify({
      providers: { ark: { url: 'https://ark', model: 'ark-model' } },
    }))
    const result = loadProviderConfig({ configPath: p })
    expect(result?.name).toBe('ark')
    expect(result?.provider.model).toBe('ark-model')
  })

  it('throws on empty config object (no resolvable provider)', () => {
    const p = writeConfig('{}')
    expect(() => loadProviderConfig({ configPath: p })).toThrowError(/"active" must name/)
  })

  it('homeDir + default filename compose the path', () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-shell-home-'))
    writeFileSync(join(home, 'providers.json'), JSON.stringify({
      active: 'p1',
      providers: { p1: { url: 'https://x', model: 'm1' } },
    }))
    const result = loadProviderConfig({ homeDir: home })
    expect(result?.configPath).toBe(join(home, 'providers.json'))
    expect(result?.name).toBe('p1')
    rmSync(home, { recursive: true, force: true })
  })
})
