// v0.25 Wave B — ~/.databus/settings.json 读写（readDatabusSettings /
// writeDatabusSettings）单元测试。
//
// 覆盖：
//   - read：文件缺失 → {}；手写坏文件（非法 JSON / 字段类型非法）→ throw
//   - write：首次写入创建文件；patch 合并不丢既有键；未知字段保留（前向兼容）
//   - 非法 patch / 非法既有内容 → throw 且坏数据不落盘
//   - 原子写：.bak 保留上一版 + 无 .tmp 残留 + 尾随换行

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  readDatabusSettings,
  writeDatabusSettings,
} from '../../src/config/databus-settings.js'

let tmpDir: string
let homeDir: string
let settingsPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'databus-settings-test-'))
  // homeDir 注入的是 OS 家目录位（settings.json 固定在其下 .databus/ 子目录）。
  homeDir = join(tmpDir, 'home')
  settingsPath = join(homeDir, '.databus', 'settings.json')
})

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

/** 手写坏文件用：先确保 .databus 目录存在（模拟用户手工放置的配置）。 */
const writeRaw = (content: string): void => {
  mkdirSync(dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, content)
}

describe('readDatabusSettings', () => {
  it('returns {} when the file is missing (settings are optional)', () => {
    expect(readDatabusSettings({ homeDir })).toEqual({})
  })

  it('reads back what was written', () => {
    writeDatabusSettings({ subAgentNesting: true, skillsDir: '/skills' }, { homeDir })
    expect(readDatabusSettings({ homeDir })).toEqual({
      subAgentNesting: true,
      skillsDir: '/skills',
    })
  })

  it('throws on a hand-crafted file with an invalid field type', () => {
    writeRaw(JSON.stringify({ subAgentNesting: 'yes' }))
    expect(() => readDatabusSettings({ homeDir })).toThrow(/"subAgentNesting" must be a boolean/)
  })

  it('throws on invalid JSON', () => {
    writeRaw('{ not json')
    expect(() => readDatabusSettings({ homeDir })).toThrow(/not valid JSON/)
  })
})

describe('writeDatabusSettings', () => {
  it('creates the file (and .databus dir) on first write', () => {
    const out = writeDatabusSettings({ subAgentNesting: true }, { homeDir })
    expect(existsSync(settingsPath)).toBe(true)
    expect(out).toEqual({ subAgentNesting: true })
  })

  it('merges the patch without dropping existing keys', () => {
    writeDatabusSettings({ subAgentNesting: true, skillsDir: '/skills' }, { homeDir })
    const out = writeDatabusSettings({ textSkillsDir: '/text' }, { homeDir })
    expect(out).toEqual({ subAgentNesting: true, skillsDir: '/skills', textSkillsDir: '/text' })
    expect(readDatabusSettings({ homeDir }).skillsDir).toBe('/skills')
  })

  it('preserves unknown fields (forward compatibility)', () => {
    writeDatabusSettings({ subAgentNesting: true }, { homeDir })
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8'))
    raw.futureField = { a: 1 }
    writeRaw(JSON.stringify(raw))

    writeDatabusSettings({ skillsDir: '/s' }, { homeDir })
    const after = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(after.futureField).toEqual({ a: 1 })
    expect(after.skillsDir).toBe('/s')
  })

  it('rejects an invalid patch with a clean error and writes nothing', () => {
    expect(() =>
      writeDatabusSettings({ subAgentNesting: 'on' as unknown as boolean }, { homeDir }),
    ).toThrow(/"subAgentNesting" must be a boolean/)
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('rejects a patch applied onto an invalid existing file (fail-fast)', () => {
    writeRaw(JSON.stringify({ skillsDir: 42 }))
    expect(() => writeDatabusSettings({ subAgentNesting: true }, { homeDir })).toThrow(
      /"skillsDir" must be a string/,
    )
    // 坏数据没有把原文件覆盖掉。
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).skillsDir).toBe(42)
  })
})

describe('atomic write + backup', () => {
  it('leaves a .bak of the previous version and no .tmp residue', () => {
    writeDatabusSettings({ skillsDir: 'v1' }, { homeDir })
    writeDatabusSettings({ skillsDir: 'v2' }, { homeDir })

    const bakPath = `${settingsPath}.bak`
    expect(existsSync(bakPath)).toBe(true)
    expect(JSON.parse(readFileSync(bakPath, 'utf8')).skillsDir).toBe('v1')
    expect(existsSync(`${settingsPath}.tmp`)).toBe(false)
  })

  it('writes valid JSON with a trailing newline', () => {
    writeDatabusSettings({ subAgentNesting: true }, { homeDir })
    const text = readFileSync(settingsPath, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toEqual({ subAgentNesting: true })
  })
})
