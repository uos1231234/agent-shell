// file-history-integration.test.ts — v0.36 端到端验证（registry 真实执行 + gate 路由）。
//
// 与单元测试（file-history.test.ts，测纯函数）互补：这里测的是「工具层怎么把
// 快照挂上去、gate 命令怎么把回滚送下来」的**接线**，全部走真实对象不 mock。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBuiltinTools } from '../../../src/im/tools/index.js'
import type { ToolContext } from '../../../src/shared/tool-context.js'
import { createFileHistory, type FileHistory } from '../../../src/im/tools/file-history.js'
import { createSignalGate } from '../../../src/signals/gate.js'
import type { SignalGate, SignalGateHandlers } from '../../../src/signals/types.js'

let cwd: string
let dataDir: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-shell-fhit-cwd-'))
  dataDir = mkdtempSync(join(tmpdir(), 'agent-shell-fhit-data-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

const S1 = 'session-a'

/** 带 sessionId 的最小 ToolContext（registry.execute 的第三参）。 */
const ctxFor = (sessionId: string): ToolContext => ({ sessionId })

/** gate handler 的最小 mock：只实现本测试用到的成员，其余缺省或 throw。 */
const minimalHandlers = (rewind?: SignalGateHandlers['session']['rewind']): SignalGateHandlers =>
  ({
    session: {
      create: async () => {
        throw new Error('not used')
      },
      open: async () => {
        throw new Error('not used')
      },
      list: async () => [],
      close: async () => undefined,
      delete: async () => undefined,
      history: async () => [],
      ...(rewind !== undefined ? { rewind } : {}),
    },
    runPrompt: async () => {
      throw new Error('not used')
    },
    cancel: () => undefined,
    setFullPermission: () => undefined,
  }) as SignalGateHandlers

/**
 * 与 assembly 同构：**外部**建快照层实例 → 注入 registry → 测试自己持有引用。
 *
 * v0.36.1：原先从 registry 的私有挂载点（`registry.fileHistory`）取实例，那是
 * 死代码——生产路径一直是注入，装配方拿的就是自己 new 的那个。测试改成注入后
 * 反而更贴近真实用法。
 */
const build = (): { registry: ReturnType<typeof createBuiltinTools>; fileHistory: FileHistory } => {
  const fileHistory = createFileHistory({ dataRoot: join(dataDir, 'file-history'), cwd })
  const registry = createBuiltinTools({ cwd, dataDir, fileHistory })
  return { registry, fileHistory }
}

describe('registry → file-history wiring', () => {
  it('write tool snapshots before overwriting; rewind restores', async () => {
    const { registry, fileHistory } = build()
    const p = join(cwd, 'a.ts')
    writeFileSync(p, 'const a = 1\n')

    // AI 第一写（快照记下 v1）→ 第二写改坏成 v2 → rewind 应还原 v1。
    await registry.execute('write', { path: p, content: 'const a = 2\n', reason: 'test' }, ctxFor(S1))
    expect(readFileSync(p, 'utf8')).toBe('const a = 2\n')
    expect(await fileHistory.list(S1)).toHaveLength(1)

    await registry.execute('write', { path: p, content: 'const a = 3\n', reason: 'test' }, ctxFor(S1))
    expect(await fileHistory.list(S1)).toHaveLength(2)

    const out = await fileHistory.rewind(S1, 2)
    expect(out.restored).toEqual(['a.ts'])
    expect(readFileSync(p, 'utf8')).toBe('const a = 1\n')
  })

  it('write creates a new file without snapshot ctx-less (no sessionId → no record)', async () => {
    const { registry, fileHistory } = build()
    const p = join(cwd, 'b.ts')
    // 无 sessionId（单测/无宿主路径）→ 不快照（设计意图：不可归属的执行不记）。
    await registry.execute('write', { path: p, content: 'x\n', reason: 'test' })
    expect(existsSync(p)).toBe(true)
    expect(await fileHistory.list(S1)).toHaveLength(0)
  })

  it('write of a NEW file records existedBefore:false; rewind deletes it', async () => {
    const { registry, fileHistory } = build()
    const p = join(cwd, 'new-file.ts')
    await registry.execute('write', { path: p, content: 'generated\n', reason: 'test' }, ctxFor(S1))
    expect(readFileSync(p, 'utf8')).toBe('generated\n')

    const out = await fileHistory.rewind(S1, 1)
    expect(out.deleted).toEqual(['new-file.ts'])
    expect(existsSync(p)).toBe(false)
  })

  it('edit tool snapshots original bytes; rewind restores them (incl. line endings)', async () => {
    const { registry, fileHistory } = build()
    const p = join(cwd, 'c.ts')
    writeFileSync(p, 'hello world\nbye world\n')

    await registry.execute(
      'edit',
      { path: p, edits: [{ oldText: 'hello', newText: 'goodbye' }], reason: 'test' },
      ctxFor(S1),
    )
    expect(readFileSync(p, 'utf8')).toBe('goodbye world\nbye world\n')

    const out = await fileHistory.rewind(S1, 1)
    expect(out.restored).toEqual(['c.ts'])
    expect(readFileSync(p, 'utf8')).toBe('hello world\nbye world\n')
  })

  it('search_replace snapshots every file it changes; rewind restores all', async () => {
    const { registry, fileHistory } = build()
    for (const n of ['d1.ts', 'd2.ts', 'd3.ts']) writeFileSync(join(cwd, n), 'TODO fix\n')
    writeFileSync(join(cwd, 'skip.docx'), 'not protected')

    await registry.execute(
      'search_replace',
      { pattern: 'TODO fix', replacement: 'DONE', path: cwd, reason: 'test' },
      ctxFor(S1),
    )
    expect(readFileSync(join(cwd, 'd1.ts'), 'utf8')).toBe('DONE\n')
    expect(readFileSync(join(cwd, 'd2.ts'), 'utf8')).toBe('DONE\n')
    // docx 不在白名单 → 即使在同一目录也不受影响、也不进快照。
    expect(readFileSync(join(cwd, 'skip.docx'), 'utf8')).toBe('not protected')

    const out = await fileHistory.rewind(S1, 3)
    expect(out.restored.sort()).toEqual(['d1.ts', 'd2.ts', 'd3.ts'])
    expect(readFileSync(join(cwd, 'd1.ts'), 'utf8')).toBe('TODO fix\n')
  })

  it('bash rm is snapshotted via recordShellCommand; rewind restores the deleted file', { timeout: 30_000 }, async () => {
    const { registry, fileHistory } = build()
    const p = join(cwd, 'e.txt')
    writeFileSync(p, 'precious\n')

    // bash 真执行：rm 删掉文件（破坏已发生）→ 但快照里有它 → 回滚恢复。
    const r = await registry.execute('bash', { command: `rm -f "${p}"`, reason: 'test' }, ctxFor(S1))
    expect(String(r)).not.toMatch(/command not found|spawn .* failed/i)
    expect(existsSync(p)).toBe(false)

    const out = await fileHistory.rewind(S1, 1)
    expect(out.restored).toEqual(['e.txt'])
    expect(readFileSync(p, 'utf8')).toBe('precious\n')
  })

  it('tools write into the injected instance; an un-injected registry keeps its own', async () => {
    // 装配约定：工具写记录、宿主 rewind，两边必须看同一份索引。用"工具改完文件
    // 后注入实例能列出记录"来证明，而不是去读 registry 的私有字段（v0.36.1 已删）。
    const { registry, fileHistory } = build()
    const p = join(cwd, 'parity.ts')
    writeFileSync(p, 'a\n')
    await registry.execute('write', { path: p, content: 'b\n', reason: 'test' }, ctxFor(S1))
    expect(await fileHistory.list(S1)).toHaveLength(1)

    // 未注入的 registry 自建实例：与注入实例互不干扰（各写各的索引）。
    // 注意要用**独立** dataDir——否则两者落点都是 <dataDir>/file-history/<指纹>/，
    // 会写进同一个索引文件（实例不同、落点相同）。
    const autoDataDir = mkdtempSync(join(tmpdir(), 'agent-shell-fhit-auto-data-'))
    const auto = createBuiltinTools({ cwd, dataDir: autoDataDir })
    const p2 = join(cwd, 'auto.ts')
    writeFileSync(p2, 'a\n')
    await auto.execute('write', { path: p2, content: 'b\n', reason: 'test' }, ctxFor(S1))
    expect(await fileHistory.list(S1)).toHaveLength(1)
    rmSync(autoDataDir, { recursive: true, force: true })
  })

  it('tells the user when a written file cannot be undone (P1-2)', async () => {
    const { registry, fileHistory } = build()

    // 白名单外：确实被改了，但 /rewind 撤不回来 —— 必须说，不能默认用户知道。
    const d = join(cwd, 'report.docx')
    const r = await registry.execute('write', { path: d, content: 'x', reason: 'test' }, ctxFor(S1))
    expect(String(r)).toContain('not undoable via /rewind')
    expect(String(r)).toContain('report.docx')
    expect(await fileHistory.list(S1)).toEqual([])

    // 受保护文件不该有噪音提示。
    const p = join(cwd, 'ok.ts')
    const r2 = await registry.execute('write', { path: p, content: 'x', reason: 'test' }, ctxFor(S1))
    expect(String(r2)).not.toContain('not undoable')
  })

  it('summarises the gap in one line for a multi-file search_replace', async () => {
    const { registry } = build()
    writeFileSync(join(cwd, 'a.ts'), 'TODO\n')
    writeFileSync(join(cwd, 'b.docx'), 'TODO\n')

    const r = await registry.execute(
      'search_replace',
      { pattern: 'TODO', replacement: 'DONE', path: cwd, reason: 'test' },
      ctxFor(S1),
    )
    // 一次改 2 个文件、其中 1 个不可撤 → 汇总一行，而不是逐文件刷屏。
    expect(JSON.stringify(r)).toContain('1 of 2 changed files are not undoable')
  })
})

describe('gate → session.rewind routing', () => {
  it('routes the command to the rewind handler', async () => {
    const seen: { sessionId: string; entries: number }[] = []
    const gate: SignalGate = createSignalGate({
      handlers: minimalHandlers(async (id: string, entries: number) => {
        seen.push({ sessionId: id, entries })
        return { restored: ['a.ts'], deleted: [], unbacked: [], entries }
      }),
    })
    const result = await gate.command({ kind: 'session.rewind', sessionId: 's9', entries: 3 })
    expect(seen).toEqual([{ sessionId: 's9', entries: 3 }])
    expect(result).toEqual({ restored: ['a.ts'], deleted: [], unbacked: [], entries: 3 })
  })

  it('throws a clean error when the rewind handler is missing', async () => {
    const gate: SignalGate = createSignalGate({ handlers: minimalHandlers() })
    await expect(gate.command({ kind: 'session.rewind', sessionId: 's9', entries: 1 }))
      .rejects.toThrow(/session\.rewind.*requires a session\.rewind handler/)
  })
})

describe('end-to-end: tool damage → gate rewind', () => {
  it('full loop: write via registry, rewind via gate handler backed by same instance', async () => {
    // 模拟宿主装配：一个 fileHistory 实例同时喂给 registry（工具层写入用）
    // 和 gate handler（回滚用）——与 assembly.ts 的 SessionAssets.fileHistory 同构。
    const { registry, fileHistory } = build()

    const p = join(cwd, 'z.ts')
    writeFileSync(p, 'const z = 1\n')
    await registry.execute('write', { path: p, content: 'const z = 999 // AI 改坏了\n', reason: 'test' }, ctxFor(S1))
    expect(readFileSync(p, 'utf8')).toContain('999')

    let rewindResult: unknown
    const gate: SignalGate = createSignalGate({
      handlers: minimalHandlers(async (id: string, entries: number) => {
        const r = await fileHistory.rewind(id, entries)
        rewindResult = r
        return { restored: r.restored, deleted: r.deleted, unbacked: r.unbacked, entries: r.entries }
      }),
    })

    await gate.command({ kind: 'session.rewind', sessionId: S1, entries: 1 })
    expect(rewindResult).toBeDefined()
    expect(readFileSync(p, 'utf8')).toBe('const z = 1\n')
  })
})
