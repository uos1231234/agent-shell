// v0.25 Wave B — mcp.json 写路径（listMcpServers / upsertMcpServer /
// deleteMcpServer）单元测试。
//
// 覆盖：
//   - list：文件缺失 → exists:false；存在 → 逐条校验返回
//   - upsert：首次创建；同名覆盖保持原位置；新名追加尾部；非法 server 拒绝
//   - delete：不存在 throw；存在成功
//   - 原子写：.bak 保留上一版 + 无 .tmp 残留

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  listMcpServers,
  upsertMcpServer,
  deleteMcpServer,
} from '../../src/mcp/write.js'

let tmpDir: string
let homeDir: string
let configPath: string

const stdioServer = (name: string, overrides?: Partial<{ command: string; description: string }>) => ({
  name,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'some-server'],
  ...overrides,
})

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mcp-write-test-'))
  homeDir = join(tmpDir, 'home')
  configPath = join(homeDir, '.databus', 'mcp.json')
})

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

describe('listMcpServers', () => {
  it('reports exists:false with an empty server list when the file is missing', () => {
    const res = listMcpServers({ configPath })
    expect(res).toEqual({ exists: false, configPath, servers: [] })
  })

  it('returns validated servers when the file exists', () => {
    upsertMcpServer({ server: stdioServer('a'), configPath })
    const res = listMcpServers({ configPath })
    expect(res.exists).toBe(true)
    expect(res.servers).toHaveLength(1)
    expect(res.servers[0]!.name).toBe('a')
  })
})

describe('upsertMcpServer', () => {
  it('creates the file on first upsert', () => {
    const res = upsertMcpServer({ server: stdioServer('a'), configPath })
    expect(res.configPath).toBe(configPath)
    expect(existsSync(configPath)).toBe(true)
    expect(JSON.parse(readFileSync(configPath, 'utf8')).servers).toHaveLength(1)
  })

  it('appends new names at the tail and overwrites same names in place', () => {
    upsertMcpServer({ server: stdioServer('a'), configPath })
    upsertMcpServer({ server: stdioServer('b'), configPath })
    upsertMcpServer({ server: stdioServer('a', { command: 'node' }), configPath })

    const { servers } = listMcpServers({ configPath })
    // 同名覆盖保持原位置：顺序仍是 [a, b]，a 的 command 已更新。
    expect(servers.map((s) => s.name)).toEqual(['a', 'b'])
    expect(servers[0]).toMatchObject({ transport: 'stdio', command: 'node' })
  })

  it('rejects an invalid server via validateMcpServerConfig and writes nothing', () => {
    expect(() =>
      upsertMcpServer({ server: { name: 'bad', transport: 'stdio', url: 'http://x' }, configPath }),
    ).toThrow(/not allowed for its transport type/)
    expect(existsSync(configPath)).toBe(false)
  })

  it('rejects a non-object server', () => {
    expect(() => upsertMcpServer({ server: 'npx -y something', configPath })).toThrow(
      /must be a JSON object/,
    )
  })
})

describe('deleteMcpServer', () => {
  beforeEach(() => {
    upsertMcpServer({ server: stdioServer('a'), configPath })
    upsertMcpServer({ server: stdioServer('b'), configPath })
  })

  it('throws when the server does not exist', () => {
    expect(() => deleteMcpServer({ name: 'ghost', configPath })).toThrow(
      /MCP server "ghost" does not exist/,
    )
  })

  it('throws when the config file does not exist', () => {
    expect(() => deleteMcpServer({ name: 'a', configPath: join(tmpDir, 'nope.json') })).toThrow(
      /does not exist/,
    )
  })

  it('deletes an existing server and keeps the rest', () => {
    deleteMcpServer({ name: 'a', configPath })
    const { servers } = listMcpServers({ configPath })
    expect(servers.map((s) => s.name)).toEqual(['b'])
  })
})

describe('atomic write + backup', () => {
  it('leaves a .bak of the previous version and no .tmp residue', () => {
    upsertMcpServer({ server: stdioServer('a', { command: 'cmd-v1' }), configPath })
    upsertMcpServer({ server: stdioServer('a', { command: 'cmd-v2' }), configPath })

    const bakPath = `${configPath}.bak`
    expect(existsSync(bakPath)).toBe(true)
    const bak = JSON.parse(readFileSync(bakPath, 'utf8'))
    expect(bak.servers[0].command).toBe('cmd-v1')
    expect(existsSync(`${configPath}.tmp`)).toBe(false)
  })

  it('writes valid JSON with a trailing newline and the {servers} shape', () => {
    upsertMcpServer({ server: stdioServer('a'), configPath })
    const text = readFileSync(configPath, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    const raw = JSON.parse(text)
    expect(Object.keys(raw)).toEqual(['servers'])
  })
})
