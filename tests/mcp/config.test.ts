import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  validateMcpServerConfig,
  loadMcpConfigFile,
  defaultMcpConfigPath,
  DEFAULT_MCP_INSTRUCTIONS_MODE,
} from '../../src/mcp/config.js'

describe('mcp/config — validateMcpServerConfig', () => {
  describe('stdio branch (happy path)', () => {
    it('accepts a minimal stdio config (name + transport + command)', () => {
      const cfg = validateMcpServerConfig({
        name: 'local-fs',
        transport: 'stdio',
        command: 'node',
      })
      expect(cfg).toEqual({ name: 'local-fs', transport: 'stdio', command: 'node' })
    })

    it('accepts stdio with args, env, and timeoutMs', () => {
      const cfg = validateMcpServerConfig({
        name: 'srv-1',
        transport: 'stdio',
        command: 'node',
        args: ['server.js', '--port', '8080'],
        env: { FOO: 'bar' },
        timeoutMs: 5000,
      })
      expect(cfg).toEqual({
        name: 'srv-1',
        transport: 'stdio',
        command: 'node',
        args: ['server.js', '--port', '8080'],
        env: { FOO: 'bar' },
        timeoutMs: 5000,
      })
    })
  })

  describe('http branch (happy path)', () => {
    it('accepts a minimal http config (name + transport + url)', () => {
      const cfg = validateMcpServerConfig({
        name: 'remote',
        transport: 'http',
        url: 'http://127.0.0.1:8080/mcp',
      })
      expect(cfg).toEqual({ name: 'remote', transport: 'http', url: 'http://127.0.0.1:8080/mcp' })
    })

    it('accepts https url with headers and timeoutMs', () => {
      const cfg = validateMcpServerConfig({
        name: 'secure',
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
        timeoutMs: 10000,
      })
      expect(cfg).toEqual({
        name: 'secure',
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
        timeoutMs: 10000,
      })
    })
  })

  describe('name validation', () => {
    it('rejects non-string name', () => {
      expect(() => validateMcpServerConfig({ name: 123, transport: 'stdio', command: 'x' })).toThrow(
        /name/,
      )
    })

    it('rejects empty name', () => {
      expect(() => validateMcpServerConfig({ name: '', transport: 'stdio', command: 'x' })).toThrow(
        /name/,
      )
    })

    it('rejects name with disallowed characters', () => {
      expect(() =>
        validateMcpServerConfig({ name: 'bad name!', transport: 'stdio', command: 'x' }),
      ).toThrow(/name/)
    })

    it('rejects name longer than 64 characters', () => {
      expect(() =>
        validateMcpServerConfig({ name: 'a'.repeat(65), transport: 'stdio', command: 'x' }),
      ).toThrow(/name/)
    })

    it('accepts name with underscore and hyphen at boundaries (65 chars ok? no, 64 max)', () => {
      const cfg = validateMcpServerConfig({
        name: 'a-b_c',
        transport: 'stdio',
        command: 'x',
      })
      expect(cfg.name).toBe('a-b_c')
    })

    it('accepts name exactly 64 characters', () => {
      const cfg = validateMcpServerConfig({
        name: 'a'.repeat(64),
        transport: 'stdio',
        command: 'x',
      })
      expect(cfg.name).toHaveLength(64)
    })
  })

  describe('transport validation', () => {
    it('rejects missing transport', () => {
      expect(() => validateMcpServerConfig({ name: 's', command: 'x' })).toThrow(/transport/)
    })

    it('rejects unknown transport', () => {
      expect(() =>
        validateMcpServerConfig({ name: 's', transport: 'sse', command: 'x' }),
      ).toThrow(/transport/)
    })
  })

  describe('stdio-specific validation', () => {
    it('rejects missing command', () => {
      expect(() => validateMcpServerConfig({ name: 's', transport: 'stdio' })).toThrow(/command/)
    })

    it('rejects empty/whitespace command', () => {
      expect(() =>
        validateMcpServerConfig({ name: 's', transport: 'stdio', command: '   ' }),
      ).toThrow(/command/)
    })

    it('rejects non-string-array args', () => {
      expect(() =>
        validateMcpServerConfig({ name: 's', transport: 'stdio', command: 'x', args: 'nope' }),
      ).toThrow(/args/)
    })

    it('rejects env with non-string values', () => {
      expect(() =>
        validateMcpServerConfig({
          name: 's',
          transport: 'stdio',
          command: 'x',
          env: { K: 1 },
        }),
      ).toThrow(/env/)
    })
  })

  describe('http-specific validation', () => {
    it('rejects missing url', () => {
      expect(() => validateMcpServerConfig({ name: 's', transport: 'http' })).toThrow(/url/)
    })

    it('rejects malformed url', () => {
      expect(() =>
        validateMcpServerConfig({ name: 's', transport: 'http', url: 'not a url' }),
      ).toThrow(/url/)
    })

    it('rejects non-http(s) protocol', () => {
      expect(() =>
        validateMcpServerConfig({ name: 's', transport: 'http', url: 'ftp://x/y' }),
      ).toThrow(/http\(s\)/)
    })

    it('rejects headers with non-string values', () => {
      expect(() =>
        validateMcpServerConfig({
          name: 's',
          transport: 'http',
          url: 'http://x',
          headers: { K: 1 },
        }),
      ).toThrow(/headers/)
    })
  })

  describe('cross-branch field rejection', () => {
    it('rejects url on stdio config', () => {
      expect(() =>
        validateMcpServerConfig({
          name: 's',
          transport: 'stdio',
          command: 'x',
          url: 'http://x',
        }),
      ).toThrow(/url.*not allowed/)
    })

    it('rejects headers on stdio config', () => {
      expect(() =>
        validateMcpServerConfig({
          name: 's',
          transport: 'stdio',
          command: 'x',
          headers: { K: 'v' },
        }),
      ).toThrow(/headers.*not allowed/)
    })

    it('rejects command on http config', () => {
      expect(() =>
        validateMcpServerConfig({
          name: 's',
          transport: 'http',
          url: 'http://x',
          command: 'x',
        }),
      ).toThrow(/command.*not allowed/)
    })

    it('rejects args on http config', () => {
      expect(() =>
        validateMcpServerConfig({
          name: 's',
          transport: 'http',
          url: 'http://x',
          args: ['a'],
        }),
      ).toThrow(/args.*not allowed/)
    })

    it('rejects env on http config', () => {
      expect(() =>
        validateMcpServerConfig({
          name: 's',
          transport: 'http',
          url: 'http://x',
          env: { K: 'v' },
        }),
      ).toThrow(/env.*not allowed/)
    })
  })

  describe('timeoutMs validation', () => {
    it('rejects zero', () => {
      expect(() =>
        validateMcpServerConfig({ name: 's', transport: 'stdio', command: 'x', timeoutMs: 0 }),
      ).toThrow(/timeoutMs/)
    })

    it('rejects negative', () => {
      expect(() =>
        validateMcpServerConfig({ name: 's', transport: 'stdio', command: 'x', timeoutMs: -1 }),
      ).toThrow(/timeoutMs/)
    })

    it('rejects non-number', () => {
      expect(() =>
        validateMcpServerConfig({ name: 's', transport: 'stdio', command: 'x', timeoutMs: '5' }),
      ).toThrow(/timeoutMs/)
    })
  })

  describe('top-level shape', () => {
    it('rejects null', () => {
      expect(() => validateMcpServerConfig(null)).toThrow(/object/)
    })

    it('rejects array', () => {
      expect(() => validateMcpServerConfig([1, 2])).toThrow(/object/)
    })
  })
})

describe('mcp/config — loadMcpConfigFile', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-cfg-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('loads a valid file with multiple servers', () => {
    const path = join(dir, 'mcp.json')
    writeFileSync(
      path,
      JSON.stringify({
        servers: [
          { name: 'a', transport: 'stdio', command: 'node' },
          { name: 'b', transport: 'http', url: 'http://x/mcp' },
        ],
      }),
    )
    const cfgs = loadMcpConfigFile(path)
    expect(cfgs).toHaveLength(2)
    expect(cfgs[0]!.name).toBe('a')
    expect(cfgs[1]!.name).toBe('b')
  })

  it('throws on missing servers array', () => {
    const path = join(dir, 'mcp.json')
    writeFileSync(path, JSON.stringify({}))
    expect(() => loadMcpConfigFile(path)).toThrow(/servers/)
  })

  it('throws on invalid JSON', () => {
    const path = join(dir, 'mcp.json')
    writeFileSync(path, '{ not json')
    expect(() => loadMcpConfigFile(path)).toThrow(/JSON/)
  })

  it('throws on duplicate server names', () => {
    const path = join(dir, 'mcp.json')
    writeFileSync(
      path,
      JSON.stringify({
        servers: [
          { name: 'dup', transport: 'stdio', command: 'x' },
          { name: 'dup', transport: 'http', url: 'http://x' },
        ],
      }),
    )
    expect(() => loadMcpConfigFile(path)).toThrow(/duplicate.*dup/)
  })

  it('throws on a server with invalid shape (propagates validate error)', () => {
    const path = join(dir, 'mcp.json')
    writeFileSync(
      path,
      JSON.stringify({ servers: [{ name: 's', transport: 'stdio' /* no command */ }] }),
    )
    expect(() => loadMcpConfigFile(path)).toThrow(/command/)
  })

  it('throws when file is unreadable', () => {
    expect(() => loadMcpConfigFile(join(dir, 'nope.json'))).toThrow(/read/)
  })
})

describe('mcp/config — defaultMcpConfigPath', () => {
  it('returns ~/.databus/mcp.json', () => {
    const p = defaultMcpConfigPath()
    expect(p.endsWith(join('.databus', 'mcp.json'))).toBe(true)
  })
})

describe('mcp/config — mcpInstructionsMode', () => {
  it('DEFAULT_MCP_INSTRUCTIONS_MODE is "discard"', () => {
    expect(DEFAULT_MCP_INSTRUCTIONS_MODE).toBe('discard')
  })

  it('omits the field by default (absent ⇒ discard)', () => {
    const cfg = validateMcpServerConfig({
      name: 's',
      transport: 'stdio',
      command: 'x',
    })
    expect(cfg).not.toHaveProperty('mcpInstructionsMode')
  })

  it('accepts "discard" explicitly on stdio', () => {
    const cfg = validateMcpServerConfig({
      name: 's',
      transport: 'stdio',
      command: 'x',
      mcpInstructionsMode: 'discard',
    })
    expect(cfg.mcpInstructionsMode).toBe('discard')
  })

  it('accepts "allow" on http', () => {
    const cfg = validateMcpServerConfig({
      name: 's',
      transport: 'http',
      url: 'http://x/mcp',
      mcpInstructionsMode: 'allow',
    })
    expect(cfg.mcpInstructionsMode).toBe('allow')
  })

  it('rejects an unknown mode value', () => {
    expect(() =>
      validateMcpServerConfig({
        name: 's',
        transport: 'stdio',
        command: 'x',
        mcpInstructionsMode: 'inject',
      }),
    ).toThrow(/mcpInstructionsMode/)
  })

  it('rejects a non-string mode value', () => {
    expect(() =>
      validateMcpServerConfig({
        name: 's',
        transport: 'stdio',
        command: 'x',
        mcpInstructionsMode: 1,
      }),
    ).toThrow(/mcpInstructionsMode/)
  })
})
