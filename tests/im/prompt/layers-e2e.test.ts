// End-to-end tests: loadPromptLayers + buildLayeredPrompt integration.
//
// Verifies that the full pipeline — loading from filesystem then merging by
// priority — produces correctly ordered output.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFile } from 'node:fs/promises'

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

const mockedReadFile = vi.mocked(readFile)

// Platform-agnostic path matching: normalize to forward slashes
function normalize(p: string): string {
  return String(p).replace(/\\/g, '/')
}

describe('prompt layers e2e', () => {
  let originalHome: string | undefined

  beforeEach(() => {
    originalHome = process.env.HOME
    mockedReadFile.mockReset()
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    vi.restoreAllMocks()
  })

  it('loads 4 layers and merges in correct priority order', async () => {
    process.env.HOME = '/fake/home'

    mockedReadFile.mockImplementation(async (filePath: any) => {
      const p = normalize(filePath)
      if (p.endsWith('managed.md')) return 'MANAGED'
      if (p.endsWith('.agent-shell/PROMPT.md')) return 'USER'
      if (p.endsWith('AGENTS.md')) return 'PROJECT'
      if (p.endsWith('.claude/local.md')) return 'LOCAL'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const { buildLayeredPrompt } = await import('../../../src/im/prompt/layer-builder.js')
    const { loadPromptLayers } = await import('../../../src/im/prompt/file-loader.js')

    const layers = await loadPromptLayers({
      basePath: '/project',
      globalPath: '/fake/managed.md',
    })

    expect(layers).toHaveLength(4)

    const merged = buildLayeredPrompt(layers)
    expect(merged).toBe('MANAGED\n\nUSER\n\nPROJECT\n\nLOCAL')
  })

  it('skips missing layers in merged output', async () => {
    process.env.HOME = '/fake/home'

    mockedReadFile.mockImplementation(async (filePath: any) => {
      const p = normalize(filePath)
      if (p.endsWith('AGENTS.md')) return 'PROJECT'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const { buildLayeredPrompt } = await import('../../../src/im/prompt/layer-builder.js')
    const { loadPromptLayers } = await import('../../../src/im/prompt/file-loader.js')

    const layers = await loadPromptLayers({
      basePath: '/project',
    })

    expect(layers).toHaveLength(1)

    const merged = buildLayeredPrompt(layers)
    expect(merged).toBe('PROJECT')
  })

  it('returns empty string when no files exist', async () => {
    process.env.HOME = '/fake/home'

    mockedReadFile.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    )

    const { buildLayeredPrompt } = await import('../../../src/im/prompt/layer-builder.js')
    const { loadPromptLayers } = await import('../../../src/im/prompt/file-loader.js')

    const layers = await loadPromptLayers({
      basePath: '/nonexistent',
    })

    expect(layers).toHaveLength(0)

    const merged = buildLayeredPrompt(layers)
    expect(merged).toBe('')
  })

  it('preserves layer priority metadata after loading', async () => {
    process.env.HOME = '/fake/home'

    mockedReadFile.mockImplementation(async (filePath: any) => {
      const p = normalize(filePath)
      if (p.endsWith('managed.md')) return 'm'
      if (p.endsWith('.agent-shell/PROMPT.md')) return 'u'
      if (p.endsWith('AGENTS.md')) return 'p'
      if (p.endsWith('.claude/local.md')) return 'l'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const { loadPromptLayers } = await import('../../../src/im/prompt/file-loader.js')

    const layers = await loadPromptLayers({
      basePath: '/project',
      globalPath: '/fake/managed.md',
    })

    // Verify each layer has correct priority
    const managed = layers.find(l => l.name === 'managed')
    const user = layers.find(l => l.name === 'user')
    const project = layers.find(l => l.name === 'project')
    const local = layers.find(l => l.name === 'local')

    expect(managed?.priority).toBe(0)
    expect(user?.priority).toBe(10)
    expect(project?.priority).toBe(20)
    expect(local?.priority).toBe(30)
  })
})
