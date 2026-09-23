// v0.32 — 模型目录 + 思考档位选择单元测试。
//
// 覆盖：
//   - resolveModelReasoning：声明覆盖 > 内置表（deepseek-v4 含 off / glm-5
//     不可关）> 未知 undefined（保守）
//   - load 校验：models 数组结构 / id 唯一 / defaultEffort ∈ efforts /
//     model ∈ models
//   - selectProviderModel：切模型清 effort、目录外模型拒绝、档位 ∈ 有效
//     efforts、未知模型拒绝选档、effort 省略 = 清除跟随默认、旧配置（无
//     models）零迁移照常工作

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveModelReasoning } from '../../src/config/model-capabilities.js'
import { selectProviderModel } from '../../src/config/write.js'
import { validateProvider } from '../../src/config/load.js'

let tmpDir: string
let configPath: string

const URL_OK = 'https://api.example.com/v3/chat/completions'

const writeConfig = (providers: Record<string, unknown>, active?: string): void => {
  writeFileSync(
    configPath,
    JSON.stringify({ ...(active !== undefined ? { active } : {}), providers }, null, 2) + '\n',
    'utf8',
  )
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'catalog-test-'))
  configPath = join(tmpDir, 'providers.json')
})

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

describe('resolveModelReasoning', () => {
  it('declared overrides the built-in table', () => {
    const declared = { efforts: ['low' as const], defaultEffort: 'low' as const }
    expect(resolveModelReasoning('deepseek-v4-flash', declared)).toBe(declared)
  })

  it('deepseek-v4* supports off (verified against ARK)', () => {
    expect(resolveModelReasoning('deepseek-v4-flash')).toEqual({
      efforts: ['max', 'high', 'low', 'off'],
      defaultEffort: 'max',
    })
    expect(resolveModelReasoning('deepseek-v4-pro')).toBeDefined()
  })

  it('glm-5* is always-thinking — no off tier (verified against ARK)', () => {
    const r = resolveModelReasoning('glm-5.3-flash')
    expect(r?.efforts).not.toContain('off')
    expect(r?.defaultEffort).toBe('max')
  })

  it('unknown model → undefined (conservative: no thinking fields sent)', () => {
    expect(resolveModelReasoning('mystery-model-x')).toBeUndefined()
  })
})

describe('load validation — models catalog', () => {
  const base = { url: URL_OK, model: 'm1' }

  it('accepts a valid catalog', () => {
    expect(() =>
      validateProvider(
        {
          ...base,
          models: [
            { id: 'm1', reasoning: { efforts: ['max', 'off'], defaultEffort: 'max' } },
            { id: 'm2' },
          ],
        },
        'p',
        configPath,
      ),
    ).not.toThrow()
  })

  it('rejects duplicate ids', () => {
    expect(() =>
      validateProvider({ ...base, models: [{ id: 'm1' }, { id: 'm1' }] }, 'p', configPath),
    ).toThrow(/duplicate/)
  })

  it('rejects defaultEffort outside efforts', () => {
    expect(() =>
      validateProvider(
        { ...base, models: [{ id: 'm1', reasoning: { efforts: ['low'], defaultEffort: 'max' } }] },
        'p',
        configPath,
      ),
    ).toThrow(/defaultEffort/)
  })

  it('rejects selected model outside catalog', () => {
    expect(() => validateProvider({ ...base, models: [{ id: 'm2' }] }, 'p', configPath)).toThrow(
      /member of "models"/,
    )
  })

  it('rejects invalid effort values', () => {
    expect(() =>
      validateProvider(
        { ...base, models: [{ id: 'm1', reasoning: { efforts: ['huge' as never] } }] },
        'p',
        configPath,
      ),
    ).toThrow(/invalid value/)
  })
})

describe('selectProviderModel', () => {
  it('switches model within catalog and clears effort (follows new default)', () => {
    writeConfig(
      {
        p: {
          url: URL_OK,
          model: 'm1',
          reasoningEffort: 'low',
          models: [{ id: 'm1' }, { id: 'm2', reasoning: { efforts: ['max', 'high', 'low'], defaultEffort: 'high' } }],
        },
      },
      'p',
    )
    const r = selectProviderModel({ model: 'm2', configPath })
    const entry = r.config.providers!['p']!
    expect(entry.model).toBe('m2')
    expect(entry.reasoningEffort).toBeUndefined()
  })

  it('rejects a model outside the catalog', () => {
    writeConfig(
      { p: { url: URL_OK, model: 'm1', models: [{ id: 'm1' }] } },
      'p',
    )
    expect(() => selectProviderModel({ model: 'nope', configPath })).toThrow(/no model "nope"/)
  })

  it('sets effort validated against effective capabilities', () => {
    // deepseek-v4-flash 命中内置表（含 off）——无需声明。
    writeConfig({ p: { url: URL_OK, model: 'deepseek-v4-flash' } }, 'p')
    const r = selectProviderModel({ effort: 'off', configPath })
    expect(r.config.providers!['p']!.reasoningEffort).toBe('off')
  })

  it('rejects effort unsupported by the model (glm-5 has no off)', () => {
    writeConfig({ p: { url: URL_OK, model: 'glm-5.3-flash' } }, 'p')
    expect(() => selectProviderModel({ effort: 'off', configPath })).toThrow(
      /does not support effort "off"/,
    )
  })

  it('rejects effort selection for unknown undeclared models (conservative)', () => {
    writeConfig({ p: { url: URL_OK, model: 'mystery-x' } }, 'p')
    expect(() => selectProviderModel({ effort: 'low', configPath })).toThrow(
      /no declared reasoning capabilities/,
    )
  })

  it('explicit models[].reasoning declaration unlocks effort selection', () => {
    writeConfig(
      {
        p: {
          url: URL_OK,
          model: 'mystery-x',
          models: [{ id: 'mystery-x', reasoning: { efforts: ['high', 'off'], defaultEffort: 'high' } }],
        },
      },
      'p',
    )
    const r = selectProviderModel({ effort: 'off', configPath })
    expect(r.config.providers!['p']!.reasoningEffort).toBe('off')
  })

  it('legacy config without models keeps working (zero migration)', () => {
    writeConfig({ p: { url: URL_OK, model: 'old-model' } }, 'p')
    const r = selectProviderModel({ model: 'another-model', configPath })
    expect(r.config.providers!['p']!.model).toBe('another-model')
    expect(r.config.providers!['p']!.reasoningEffort).toBeUndefined()
  })

  it('effort omitted on a model-only call clears effort (follow default)', () => {
    writeConfig({ p: { url: URL_OK, model: 'deepseek-v4-flash', reasoningEffort: 'low' } }, 'p')
    const r = selectProviderModel({ configPath })
    expect(r.config.providers!['p']!.reasoningEffort).toBeUndefined()
  })
})
