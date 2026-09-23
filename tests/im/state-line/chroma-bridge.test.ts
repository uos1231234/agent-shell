import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// Mock child_process.spawn by intercepting the module.
// We use a factory approach: each test sets up the desired response.

type MockChild = {
  stdin: { end: Mock }
  stdout: { on: Mock }
  stderr: { on: Mock }
  on: Mock
  kill: Mock
  _dataCb: ((chunk: Buffer) => void) | null
  _closeCb: (() => void) | null
  _emitData: (resp: Record<string, unknown>) => void
  _emitClose: () => void
}

const createMockChild = (response: Record<string, unknown> | null, delayMs = 0): MockChild => {
  const child: MockChild = {
    stdin: {
      end: vi.fn(() => {
        const emit = () => {
          if (response !== null) child._emitData(response)
          child._emitClose()
        }
        if (delayMs > 0) setTimeout(emit, delayMs)
        else emit()
      }),
    },
    stdout: {
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        if (event === 'data') child._dataCb = cb
      }),
    },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: () => void) => {
      if (event === 'close') child._closeCb = cb
    }),
    kill: vi.fn(),
    _dataCb: null,
    _closeCb: null,
    _emitData: (resp: Record<string, unknown>) => {
      if (child._dataCb) child._dataCb(Buffer.from(JSON.stringify(resp)))
    },
    _emitClose: () => {
      if (child._closeCb) child._closeCb()
    },
  }
  return child
}

// We need to mock the spawn function. Since `child_process.spawn` is not
// configurable via spyOn in this environment, we intercept at the module level.
let mockChild: MockChild | null = null
const spawnCalls: unknown[][] = []

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: ((...args: unknown[]) => {
      spawnCalls.push(args)
      if (mockChild) return mockChild
      return (actual.spawn as unknown as (...a: unknown[]) => unknown)(...args)
    }) as typeof actual.spawn,
  }
})

describe('im/state-line/chroma-bridge', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chroma-bridge-test-'))
    mockChild = null
    spawnCalls.length = 0
  })

  afterEach(() => {
    mockChild = null
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('embedM3 spawns the right Python path and script', async () => {
    mockChild = createMockChild({ ok: true, count: 1, dim: 384 })

    const { embedM3 } = await import('../../../src/im/state-line/chroma-bridge.js')
    await embedM3([{ stamp: 'S-1', text: 'hello' }], { storePath: tmpDir })

    expect(spawnCalls[0]?.[0]).toBe('D:\\trae\\runtime\\python\\python.exe')
    // v0.42：脚本路径改为**模块相对**绝对路径（旧实现按 process.cwd() 找
    // 'scripts/embed.py'，drive_mrcr 的 cwd=workdir 下必然 ENOENT → RAG 静默全废）。
    expect(spawnCalls[0]?.[1]).toEqual([
      fileURLToPath(new URL('../../../scripts/embed.py', import.meta.url)),
    ])
  })

  it('embedM3 JSON.stringify inputs correctly to stdin', async () => {
    mockChild = createMockChild({ ok: true, count: 1, dim: 384 })

    const { embedM3 } = await import('../../../src/im/state-line/chroma-bridge.js')
    await embedM3([{ stamp: 'S-1', text: 'hello world' }], { storePath: tmpDir })

    const stdinData = mockChild!.stdin.end.mock.calls[0]![0] as string
    const parsed = JSON.parse(stdinData)
    expect(parsed.command).toBe('embed')
    expect(parsed.collection).toBe('m3_summaries')
    expect(parsed.items).toEqual([{ id: 'S-1', stamp: 'S-1', text: 'hello world' }])
  })

  it('queryM3 returns results from Python response', async () => {
    mockChild = createMockChild({
      ok: true,
      results: [
        { stamp: 'S-1', distance: 0.5, document: 'doc1' },
        { stamp: 'S-2', distance: 0.8, document: 'doc2' },
      ],
    })

    const { queryM3 } = await import('../../../src/im/state-line/chroma-bridge.js')
    const result = await queryM3('test query', 5, { storePath: tmpDir })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.results.length).toBe(2)
      expect(result.results[0]!.stamp).toBe('S-1')
      expect(result.results[0]!.distance).toBe(0.5)
    }
  })

  it('Python error → {ok:false,error}', async () => {
    mockChild = createMockChild({ ok: false, error: 'chromadb not found' })

    const { embedM3 } = await import('../../../src/im/state-line/chroma-bridge.js')
    const result = await embedM3([{ stamp: 'S-1', text: 'hi' }], { storePath: tmpDir })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('chromadb not found')
    }
  })

  it('Python timeout → {ok:false,error:"timeout"}', async () => {
    mockChild = createMockChild({ ok: true, count: 1 }, 200)

    const { embedM3 } = await import('../../../src/im/state-line/chroma-bridge.js')
    const result = await embedM3(
      [{ stamp: 'S-1', text: 'hi' }],
      { storePath: tmpDir, timeoutMs: 50 },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('timeout')
    }
    expect(mockChild!.kill).toHaveBeenCalled()
  })
})
