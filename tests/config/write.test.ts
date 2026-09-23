// v0.23 — providers.json 写路径（upsert/delete/activate）单元测试。
//
// 覆盖：
//   - upsert：新建文件 / 追加条目 / 覆盖同名字段 / 坏 url 拒绝
//   - delete：条目不存在抛错；删 active 抛错；删非 active 成功且 active 保持
//   - activate：条目不存在抛错；切换 active 落盘
//   - 原子写 + .bak 备份；写后 config 合法（active 指向存在的条目）

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  upsertProvider,
  deleteProvider,
  activateProvider,
} from '../../src/config/write.js'
import { loadProviderConfig } from '../../src/config/load.js'

let tmpDir: string
let configPath: string

const provider = (overrides?: Partial<{ url: string; apiKey: string; model: string; upstreamTrusted: boolean }>) => ({
  url: 'https://api.example.com/v3/chat/completions',
  model: 'test-model',
  ...overrides,
})

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'write-test-'))
  configPath = join(tmpDir, 'providers.json')
})

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

describe('upsertProvider', () => {
  it('creates the file on first upsert', () => {
    const res = upsertProvider({ name: 'ark', provider: provider(), configPath })

    expect(existsSync(configPath)).toBe(true)
    expect(res.configPath).toBe(configPath)
    const reloaded = loadProviderConfig({ configPath })
    expect(reloaded?.provider.model).toBe('test-model')
    // 无 active 字段时 upsert 不推断 active——由 activate 显式设置。
    expect(reloaded?.name).toBe('ark') // active = 第一个 key
  })

  it('upserts an existing entry (overwrite same-name fields)', () => {
    upsertProvider({ name: 'ark', provider: provider(), configPath })
    upsertProvider({ name: 'ark', provider: provider({ model: 'new-model' }), configPath })

    const reloaded = loadProviderConfig({ configPath })
    expect(reloaded?.provider.model).toBe('new-model')
  })

  it('rejects an invalid url with a clean error naming the provider', () => {
    expect(() =>
      upsertProvider({ name: 'bad', provider: provider({ url: 'not-a-url' }), configPath }),
    ).toThrow(/provider "bad"/)
    // 坏数据写不进文件。
    expect(existsSync(configPath)).toBe(false)
  })
})

describe('deleteProvider', () => {
  beforeEach(() => {
    upsertProvider({ name: 'a', provider: provider(), configPath })
    upsertProvider({ name: 'b', provider: provider(), configPath })
  })

  it('throws when the provider does not exist', () => {
    expect(() => deleteProvider({ name: 'ghost', configPath })).toThrow(/does not exist/)
  })

  it('throws when deleting the active provider', () => {
    activateProvider({ name: 'a', configPath })
    expect(() => deleteProvider({ name: 'a', configPath })).toThrow(/is active/)
  })

  it('deletes a non-active provider and keeps active', () => {
    activateProvider({ name: 'a', configPath })
    const res = deleteProvider({ name: 'b', configPath })

    expect(res.config.providers).toEqual({ a: provider() })
    expect(res.config.active).toBe('a')
    const reloaded = loadProviderConfig({ configPath })
    expect(reloaded?.name).toBe('a')
  })
})

describe('activateProvider', () => {
  it('throws when the provider does not exist', () => {
    expect(() => activateProvider({ name: 'ghost', configPath })).toThrow(/does not exist/)
  })

  it('switches active and persists to disk', () => {
    upsertProvider({ name: 'a', provider: provider(), configPath })
    upsertProvider({ name: 'b', provider: provider(), configPath })

    const res = activateProvider({ name: 'b', configPath })
    expect(res.config.active).toBe('b')
    expect(loadProviderConfig({ configPath })?.name).toBe('b')
  })
})

describe('atomic write + backup', () => {
  it('leaves a .bak of the previous version and no .tmp residue', () => {
    upsertProvider({ name: 'a', provider: provider({ model: 'v1' }), configPath })
    upsertProvider({ name: 'a', provider: provider({ model: 'v2' }), configPath })

    const bakPath = `${configPath}.bak`
    expect(existsSync(bakPath)).toBe(true)
    // .bak 是上一版（v1）。
    const bak = JSON.parse(readFileSync(bakPath, 'utf8'))
    expect(bak.providers.a.model).toBe('v1')
    // .tmp 被 rename 消费，不留残留。
    expect(existsSync(`${configPath}.tmp`)).toBe(false)
  })

  it('writes valid JSON with a trailing newline', () => {
    upsertProvider({ name: 'a', provider: provider(), configPath })
    const text = readFileSync(configPath, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toEqual({ providers: { a: provider() } })
  })

  it('preserves unrelated top-level shape when writing (active points at existing entry)', () => {
    // 模拟手工写了一个 active 指向存在的条目的配置。
    writeFileSync(configPath, JSON.stringify({ active: 'a', providers: { a: provider() } }))
    activateProvider({ name: 'a', configPath })

    const raw = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(raw.active).toBe('a')
    expect(raw.providers.a).toEqual(provider())
  })
})
