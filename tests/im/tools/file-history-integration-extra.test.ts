// file-history-integration-extra.test.ts — 独立复核补充（general-purpose-1）。
//
// 主集成测试（file-history-integration.test.ts）覆盖主链路。本文件补它没钉住的点：
//   A. rewind 时目标文件/父目录已被外部破坏 → 能重建还原
//   B. edit 对 CRLF 文件的字节级还原（zlib 往返保真）
//   C. search_replace 的 limit 截断 → 只有实际被改的文件进快照
//   D. 跨会话隔离 + 未知会话经 gate（真实 rewindSessionFiles 接线）抛干净错误
//   E. 快照目录结构 / index.jsonl 行格式 / sha256 完整性（对象可解压且 hash 对上）
//   F. 目标对象文件丢失 → unbacked 如实上报、不抛异常
//   G. 无 sessionId 时连快照数据根都不创建（更强的"不快照"证据）
//   H. 已知缺口复现：search_replace 会改写白名单外文件（docx），但快照静默不保护
//      ——文件变了却撤不回来（断言当前行为，作为修复驱动）
//
// 全部走真实 registry / gate / host 装配，无 mock。临时目录 afterEach 清除。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'

import { createBuiltinTools } from '../../../src/im/tools/index.js'
import { createFileHistory, type FileHistory } from '../../../src/im/tools/file-history.js'
import type { ToolContext } from '../../../src/shared/tool-context.js'
import { createSignalGate } from '../../../src/signals/gate.js'
import type { SignalGateHandlers } from '../../../src/signals/types.js'
import { rewindSessionFiles } from '../../../src/host/session-rewind.js'

let cwd: string
let dataDir: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-shell-fhitx-cwd-'))
  dataDir = mkdtempSync(join(tmpdir(), 'agent-shell-fhitx-data-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

const ctxFor = (sessionId: string): ToolContext => ({ sessionId })

/** 快照实际落点：createBuiltinTools 用 <dataDir>/file-history/<项目指纹>/。 */
const historyDir = (): string => {
  const root = readdirSync(dataDir)[0]!
  const project = readdirSync(join(dataDir, root))[0]!
  return join(dataDir, root, project)
}

/**
 * 与 assembly 同构：**外部**建快照层实例 → 注入 registry。
 *
 * v0.36.1：原先从 registry 的私有挂载点取实例；那是死代码（生产路径一直靠注入，
 * 装配方持有的就是自己 new 的那个），已删除。测试改为注入后与真实装配一致。
 */
const build = () => {
  const fh = createFileHistory({ dataRoot: join(dataDir, 'file-history'), cwd })
  const registry = createBuiltinTools({ cwd, dataDir, fileHistory: fh })
  return { registry, fh }
}

/** 与 assembly.ts 同款接线：gate 的 rewind handler 走真实 host 函数。 */
const gateWithRewind = (fh: FileHistory, rewind?: NonNullable<SignalGateHandlers['session']['rewind']>) => {
  const handlers: SignalGateHandlers = {
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
      rewind:
        rewind ??
        ((id: string, entries: number | 'last-turn') => rewindSessionFiles({ sessionId: id, fileHistory: fh }, entries)),
    },
    runPrompt: async () => {
      throw new Error('not used')
    },
    cancel: () => undefined,
    setFullPermission: () => undefined,
  }
  return createSignalGate({ handlers })
}

describe('A. rewind 面对被外部破坏的目标', () => {
  it('目标文件的父目录都被删了，rewind 仍能重建并还原', async () => {
    const { registry, fh } = build()
    await registry.execute('write', { path: 'deep/nested/x.ts', content: 'a\n', reason: 'test' }, ctxFor('s1'))
    await registry.execute('write', { path: 'deep/nested/x.ts', content: 'b\n', reason: 'test' }, ctxFor('s1'))
    expect(readFileSync(join(cwd, 'deep/nested/x.ts'), 'utf8')).toBe('b\n')

    // 外部（用户/git clean）把整棵目录删了——rewind 必须自己建目录重建。
    rmSync(join(cwd, 'deep'), { recursive: true, force: true })
    expect(existsSync(join(cwd, 'deep'))).toBe(false)

    const out = await fh.rewind('s1', 1)
    expect(out.restored).toEqual(['deep/nested/x.ts'])
    expect(readFileSync(join(cwd, 'deep/nested/x.ts'), 'utf8')).toBe('a\n')
  })
})

describe('B. edit 对 CRLF 的字节级还原', () => {
  it('CRLF 文件被 edit 后 rewind 还原为逐字节一致', async () => {
    const { registry, fh } = build()
    const p = join(cwd, 'crlf.md')
    const original = 'line1\r\nline2\r\nline3\r\n'
    writeFileSync(p, original, 'utf8')

    await registry.execute('edit', { path: p, edits: [{ oldText: 'line2', newText: 'LINE2' }], reason: 'test' }, ctxFor('s1'))
    expect(readFileSync(p, 'utf8')).toContain('LINE2')

    const out = await fh.rewind('s1', 1)
    expect(out.restored).toEqual(['crlf.md'])
    expect(readFileSync(p)).toEqual(Buffer.from(original, 'utf8'))
  })
})

describe('C. search_replace 的 limit 截断与快照对齐', () => {
  it('limit=1 时只快照实际被改的那一个文件', async () => {
    const { registry, fh } = build()
    writeFileSync(join(cwd, 'c1.txt'), 'TODO\n')
    writeFileSync(join(cwd, 'c2.txt'), 'TODO\n')

    const res = (await registry.execute(
      'search_replace',
      { pattern: 'TODO', replacement: 'DONE', path: cwd, limit: 1, reason: 'test' },
      ctxFor('s1'),
    )) as { filesChanged: number; changes: { file: string; count: number }[] }

    expect(res.filesChanged).toBe(1)
    // 只有一个文件实际被改（另一个仍是 TODO）。
    const doneFiles = [join(cwd, 'c1.txt'), join(cwd, 'c2.txt')]
      .filter((f) => readFileSync(f, 'utf8').includes('DONE'))
    expect(doneFiles).toHaveLength(1)
    // 快照条数与实际改动数一致（不是扫描数）。
    expect(await fh.list('s1')).toHaveLength(1)

    const rel = res.changes[0]!.file.replace(/\\/g, '/').split('/').pop()
    const out = await fh.rewind('s1', 1)
    expect(out.restored).toHaveLength(1)
    expect(readFileSync(join(cwd, rel!), 'utf8')).toBe('TODO\n')
    expect(await fh.list('s1')).toHaveLength(0)
  })
})

describe('D. 跨会话隔离 + 未知会话（经 gate 走真实 host 函数）', () => {
  it('s1 无记录时 rewind 报干净错误；s2 的记录不被 s1 的 rewind 消费', async () => {
    const { registry, fh } = build()
    await registry.execute('write', { path: 'shared.ts', content: 'from-s2\n', reason: 'test' }, ctxFor('s2'))
    const gate = gateWithRewind(fh)

    // s1 从没写过 → 经 gate 也应抛"无记录"，而不是空转成功。
    await expect(gate.command({ kind: 'session.rewind', sessionId: 's1', entries: 1 }))
      .rejects.toThrow(/no file-change snapshot records/)

    // s1 写入后 rewind 只撤 s1，s2 的旧内容被还原且其记录保留。
    await registry.execute('write', { path: 'shared.ts', content: 'from-s1\n', reason: 'test' }, ctxFor('s1'))
    const out = await gate.command({ kind: 'session.rewind', sessionId: 's1', entries: 1 })
    expect(out).toMatchObject({ restored: ['shared.ts'] })
    expect(readFileSync(join(cwd, 'shared.ts'), 'utf8')).toBe('from-s2\n')
    expect(await fh.list('s2')).toHaveLength(1)
  })
})

describe('E. 快照落盘形态（目录结构 / index 行 / sha256 完整性）', () => {
  it('objects/<2位>/<sha256>.z + index.jsonl，hash 可解压回原文', async () => {
    const { registry, fh } = build()
    // 先有基线内容，让 registry 的第一次 write 生成带 hash 的快照。
    mkdirSync(join(cwd, 'sub/dir'), { recursive: true })
    writeFileSync(join(cwd, 'sub/dir/e1.ts'), 'alpha\n', 'utf8')
    await registry.execute('write', { path: 'sub/dir/e1.ts', content: 'beta\n', reason: 'test' }, ctxFor('s1'))

    const projects = readdirSync(dataDir)
    expect(projects).toEqual(['file-history'])
    const dir = historyDir()
    expect(existsSync(join(dir, 'index.jsonl'))).toBe(true)
    expect(existsSync(join(dir, 'objects'))).toBe(true)

    // index.jsonl：每一行都是完整 JSON，字段齐全。
    const entries = await fh.list('s1')
    expect(entries).toHaveLength(1)
    const e = entries[0]!
    expect(e).toMatchObject({
      sessionId: 's1',
      relPath: 'sub/dir/e1.ts',
      existedBefore: true,
    })
    expect(e.skipped).toBeUndefined()
    expect(typeof e.ts).toBe('string')
    expect(e.size).toBe(6) // 'alpha\n'
    expect(e.hash).toBe(createHash('sha256').update('alpha\n', 'utf8').digest('hex'))

    // 对象文件的真实落点与内容：
    const bucket = join(dir, 'objects', e.hash!.slice(0, 2))
    expect(existsSync(bucket)).toBe(true)
    const obj = join(bucket, `${e.hash}.z`)
    expect(existsSync(obj)).toBe(true)
    expect(inflateSync(readFileSync(obj)).toString('utf8')).toBe('alpha\n')
  })
})

describe('F. 目标对象文件丢失 → unbacked 如实上报', () => {
  it('对象被删后 rewind 不抛异常、把该文件计入 unbacked', async () => {
    const { registry, fh } = build()
    // 基线内容（无快照）→ registry.write 生成的快照才有 hash 可指向对象。
    writeFileSync(join(cwd, 'lost.ts'), 'v1\n', 'utf8')
    await registry.execute('write', { path: 'lost.ts', content: 'v2\n', reason: 'test' }, ctxFor('s1'))
    expect(await fh.list('s1')).toHaveLength(1)

    // 找到并删掉对象文件（模拟存储损坏/被回收误删）。
    const dir = historyDir()
    const e = (await fh.list('s1'))[0]!
    expect(e.hash).not.toBeNull()
    const bucket = join(dir, 'objects', e.hash!.slice(0, 2))
    rmSync(bucket, { recursive: true, force: true })

    // 外部再改一下文件，让 rewind 有实际还原动作可做。
    writeFileSync(join(cwd, 'lost.ts'), 'v3\n', 'utf8')
    const out = await fh.rewind('s1', 1)
    expect(out.unbacked).toEqual(['lost.ts'])
    expect(out.restored).toEqual([])
    expect(readFileSync(join(cwd, 'lost.ts'), 'utf8')).toBe('v3\n')
  })
})

describe('G. 无 sessionId 的更强证据', () => {
  it('ctx 为空对象时连 <dataDir>/file-history 都不创建', async () => {
    const { registry } = build()
    await registry.execute('write', { path: 'g.txt', content: 'x\n', reason: 'test' }, {})
    expect(readFileSync(join(cwd, 'g.txt'), 'utf8')).toBe('x\n')
    expect(readdirSync(dataDir)).toEqual([])
  })
})

describe('H. 已知缺口复现（不作为"通过"的依据，作为修复驱动）', () => {
  it('search_replace 会改写白名单外文件，但快照静默不保护 → 撤不回来', async () => {
    const { registry, fh } = build()
    // 一个"假装是 docx"的文本文件：search_replace 不看扩展名，会读到并改写它。
    writeFileSync(join(cwd, 'a.docx'), 'TODO fix\n', 'utf8')

    const res = (await registry.execute(
      'search_replace',
      { pattern: 'TODO fix', replacement: 'DONE', path: cwd, reason: 'test' },
      ctxFor('s1'),
    )) as { filesChanged: number; snapshotNotice?: string }

    // docx 被真实改写了（walk 不按白名单过滤）。
    expect(res.filesChanged).toBe(1)
    expect(readFileSync(join(cwd, 'a.docx'), 'utf8')).toBe('DONE\n')
    // 但快照层按白名单 skip → 没有任何记录可撤。
    expect(await fh.list('s1')).toEqual([])
    await expect(fh.rewind('s1', 1)).rejects.toThrow(/no file-change snapshot records/)
    // 文件保持被改后的状态。
    expect(readFileSync(join(cwd, 'a.docx'), 'utf8')).toBe('DONE\n')
    // v0.36.1 起不再"完全静默"：工具回执里带一行提示，用户知道这次改动撤不回来。
    // （rewind 本身仍然没有 unbacked 可报——白名单外文件从来不进索引。）
    expect(res.snapshotNotice).toContain('not undoable via /rewind')
  })
})

describe('I. entries="last-turn"（前端撤销按钮的取数语义）', () => {
  it('rewinds the newest contiguous cluster and reports how many records it used', async () => {
    const { registry, fh } = build()
    // 预先放好 a.ts：这样"这一批改动之前"的状态是 a0，回滚目标明确。
    writeFileSync(join(cwd, 'a.ts'), 'a0\n', 'utf8')
    await registry.execute('write', { path: 'a.ts', content: 'a1\n', reason: 'test' }, ctxFor('s1'))
    await registry.execute('write', { path: 'a.ts', content: 'a2\n', reason: 'test' }, ctxFor('s1'))
    await registry.execute('write', { path: 'b.ts', content: 'b1\n', reason: 'test' }, ctxFor('s1'))

    expect(await fh.countLastTurnRecords('s1')).toBe(3)
    const gate = gateWithRewind(fh)
    const result = (await gate.command({ kind: 'session.rewind', sessionId: 's1', entries: 'last-turn' })) as {
      restored: string[]
      deleted: string[]
      entries: number
    }
    // 语义 = 撤到"这批改动之前"：a.ts 回到 a0（取最早那条记录），b.ts 是新建 → 删除。
    expect(result.entries).toBe(3)
    expect(result.restored).toEqual(['a.ts'])
    expect(result.deleted).toEqual(['b.ts'])
    expect(readFileSync(join(cwd, 'a.ts'), 'utf8')).toBe('a0\n')
    expect(existsSync(join(cwd, 'b.ts'))).toBe(false)
    expect(await fh.list('s1')).toEqual([])
  })

  it('returns an empty outcome (not an error) when there is nothing to rewind', async () => {
    const { fh } = build()
    const gate = gateWithRewind(fh)
    // 空结果是刻意选择：前端据此显示"没有可撤销的改动"，不必解析错误文案。
    await expect(gate.command({ kind: 'session.rewind', sessionId: 's1', entries: 'last-turn' })).resolves.toEqual(
      { restored: [], deleted: [], unbacked: [], entries: 0 },
    )
  })

  it('splits clusters on a >10 minute gap (the documented approximation)', async () => {
    const { registry, fh } = build()
    writeFileSync(join(cwd, 'old.ts'), 'o0\n', 'utf8')
    await registry.execute('write', { path: 'old.ts', content: 'o1\n', reason: 'test' }, ctxFor('s1'))
    // 把第一条记录的 ts 改成 30 分钟前 → 时间簇断开，只有后两条算"最近一个 turn"。
    const indexFile = join(historyDir(), 'index.jsonl')
    const lines = readFileSync(indexFile, 'utf8').trim().split('\n')
    const first = JSON.parse(lines[0]!) as { ts: string }
    first.ts = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    lines[0] = JSON.stringify(first)
    writeFileSync(indexFile, `${lines.join('\n')}\n`, 'utf8')

    writeFileSync(join(cwd, 'a.ts'), 'a0\n', 'utf8')
    await registry.execute('write', { path: 'a.ts', content: 'a1\n', reason: 'test' }, ctxFor('s1'))
    await registry.execute('write', { path: 'a.ts', content: 'a2\n', reason: 'test' }, ctxFor('s1'))

    expect(await fh.countLastTurnRecords('s1')).toBe(2)
    const result = (await gateWithRewind(fh).command({
      kind: 'session.rewind',
      sessionId: 's1',
      entries: 'last-turn',
    })) as { restored: string[]; entries: number }
    expect(result.entries).toBe(2)
    expect(result.restored).toEqual(['a.ts'])
    expect(readFileSync(join(cwd, 'a.ts'), 'utf8')).toBe('a0\n')
    // 断簇外的 old.ts 记录保持原样（不被这次撤销消费）。
    expect(await fh.list('s1')).toHaveLength(1)
  })
})