// Tests for loadPromptLayers — filesystem-based prompt layer loading.
//
// Invariants:
//   - Files that don't exist are silently skipped (no error thrown).
//   - Empty files are skipped.
//   - Files exceeding 20KB are truncated.
//   - basePath without project/local files returns only managed/user layers.
//   - Default file names are AGENTS.md (project) and .claude/local.md (local).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Mock fs/promises so we control file contents
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

const mockedReadFile = vi.mocked(readFile)

// Platform-agnostic path matching: normalize to forward slashes
function normalize(p: string): string {
  return String(p).replace(/\\/g, '/')
}

async function importLoader() {
  return import('../../../src/im/prompt/file-loader.js')
}

describe('loadPromptLayers', () => {
  let originalHome: string | undefined
  let originalUserProfile: string | undefined

  beforeEach(() => {
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    mockedReadFile.mockReset()
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    vi.restoreAllMocks()
  })

  it('returns 4 layers when all files exist', async () => {
    process.env.HOME = '/fake/home'

    mockedReadFile.mockImplementation(async (filePath: any) => {
      const p = normalize(filePath)
      if (p.endsWith('managed.md')) return 'managed content'
      if (p.endsWith('.agent-shell/PROMPT.md')) return 'user content'
      if (p.endsWith('AGENTS.md')) return 'project content'
      if (p.endsWith('.claude/local.md')) return 'local content'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const { loadPromptLayers } = await importLoader()
    const layers = await loadPromptLayers({
      basePath: '/project',
      globalPath: '/fake/managed.md',
    })

    expect(layers).toHaveLength(4)
    expect(layers.map(l => l.name)).toEqual(['managed', 'user', 'project', 'local'])
    expect(layers.map(l => l.priority)).toEqual([0, 10, 20, 30])
  })

  it('skips files that do not exist without throwing', async () => {
    process.env.HOME = '/fake/home'

    mockedReadFile.mockImplementation(async (filePath: any) => {
      const p = normalize(filePath)
      // Only AGENTS.md exists
      if (p.endsWith('AGENTS.md')) return 'project content'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const { loadPromptLayers } = await importLoader()
    const layers = await loadPromptLayers({
      basePath: '/project',
    })

    expect(layers).toHaveLength(1)
    expect(layers[0]!.name).toBe('project')
  })

  it('skips empty files', async () => {
    process.env.HOME = '/fake/home'

    mockedReadFile.mockImplementation(async (filePath: any) => {
      const p = normalize(filePath)
      if (p.endsWith('AGENTS.md')) return 'project content'
      if (p.endsWith('.claude/local.md')) return ''  // empty file
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const { loadPromptLayers } = await importLoader()
    const layers = await loadPromptLayers({
      basePath: '/project',
    })

    expect(layers).toHaveLength(1)
    expect(layers[0]!.name).toBe('project')
  })

  it('loads files exceeding 20KB in full (no truncation, 2026-09-12)', async () => {
    process.env.HOME = '/fake/home'
    const bigContent = 'x'.repeat(25 * 1024) // 25KB — former cap, now loaded whole

    mockedReadFile.mockImplementation(async (filePath: any) => {
      const p = normalize(filePath)
      if (p.endsWith('AGENTS.md')) return bigContent
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const { loadPromptLayers } = await importLoader()
    const layers = await loadPromptLayers({
      basePath: '/project',
    })

    expect(layers).toHaveLength(1)
    expect(layers[0]!.content).toBe(bigContent)
  })

  it('returns only user layer when basePath has no project/local files', async () => {
    process.env.HOME = '/fake/home'

    mockedReadFile.mockImplementation(async (filePath: any) => {
      const p = normalize(filePath)
      if (p.endsWith('.agent-shell/PROMPT.md')) return 'user content'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const { loadPromptLayers } = await importLoader()
    const layers = await loadPromptLayers({
      basePath: '/nonexistent',
    })

    expect(layers).toHaveLength(1)
    expect(layers[0]!.name).toBe('user')
  })

  it('uses custom projectFile and localFile names', async () => {
    process.env.HOME = '/fake/home'

    mockedReadFile.mockImplementation(async (filePath: any) => {
      const p = normalize(filePath)
      if (p.endsWith('CUSTOM.md')) return 'custom project'
      if (p.endsWith('CUSTOM_LOCAL.md')) return 'custom local'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const { loadPromptLayers } = await importLoader()
    const layers = await loadPromptLayers({
      basePath: '/project',
      projectFile: 'CUSTOM.md',
      localFile: 'CUSTOM_LOCAL.md',
    })

    expect(layers).toHaveLength(2)
    expect(layers[0]!.name).toBe('project')
    expect(layers[0]!.content).toBe('custom project')
    expect(layers[1]!.name).toBe('local')
    expect(layers[1]!.content).toBe('custom local')
  })
})
