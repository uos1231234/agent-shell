// file-history.test.ts — v0.36 快照层（写前留底 + 回滚）的行为测试。
//
// 覆盖面（按用户拍板的设计）：
//   - 白名单（代码/md/html）+ 目录黑名单 + 敏感文件排除
//   - 新建文件的登记（existedBefore=false → 回滚时删除）
//   - 内容寻址去重（同内容只存一份对象）
//   - 回滚的 restored / deleted / unbacked 三分上报（不假装成功）
//   - 同路径多条记录取最早（连续改多次撤回改动前状态）
//   - 配额回收（条数上限 + 对象清扫）
//   - 单文件上限（超限只登记 → 回滚时进 unbacked）

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileHistory, isProtectedRelPath, isWriteLikeShellCommand, snapshotGapNotice, summarizeSnapshotGaps } from '../../../src/im/tools/file-history.js'

let cwd: string
let dataRoot: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-shell-fh-cwd-'))
  dataRoot = mkdtempSync(join(tmpdir(), 'agent-shell-fh-data-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
  rmSync(dataRoot, { recursive: true, force: true })
})

const SESSION = 's1'

const make = () => createFileHistory({ dataRoot, cwd })

const write = (rel: string, content: string): string => {
  const p = join(cwd, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
  return p
}

describe('isProtectedRelPath', () => {
  it('protects code, markdown and html files', () => {
    expect(isProtectedRelPath('src/index.ts')).toBe(true)
    expect(isProtectedRelPath('README.md')).toBe(true)
    expect(isProtectedRelPath('docs/page.html')).toBe(true)
    expect(isProtectedRelPath('config.json')).toBe(true)
  })

  it('skips office documents and unknown extensions (user decision: drop doc support)', () => {
    expect(isProtectedRelPath('report.docx')).toBe(false)
    expect(isProtectedRelPath('budget.xlsx')).toBe(false)
    expect(isProtectedRelPath('photo.png')).toBe(false)
    expect(isProtectedRelPath('archive.zip')).toBe(false)
  })

  it('protects extensionless well-known filenames', () => {
    expect(isProtectedRelPath('Makefile')).toBe(true)
    expect(isProtectedRelPath('Dockerfile')).toBe(true)
  })

  it('excludes build/vendor/dependency directories even for protected extensions', () => {
    expect(isProtectedRelPath('node_modules/pkg/index.js')).toBe(false)
    expect(isProtectedRelPath('dist/bundle.js')).toBe(false)
    expect(isProtectedRelPath('.git/config')).toBe(false)
    expect(isProtectedRelPath('.databus/sessions/x.jsonl')).toBe(false)
  })
})

describe('record + rewind', () => {
  it('restores an overwritten file to its previous content', async () => {
    const p = write('src/a.ts', 'const a = 1\n')
    const fh = make()
    await fh.record(p, SESSION)
    writeFileSync(p, 'const a = 2\n')

    const out = await fh.rewind(SESSION, 1)
    expect(out.restored).toEqual(['src/a.ts'])
    expect(readFileSync(p, 'utf8')).toBe('const a = 1\n')
  })

  it('deletes a file that did not exist before the write (AI-created file)', async () => {
    const p = join(cwd, 'src/new.ts')
    mkdirSync(join(cwd, 'src'), { recursive: true })
    const fh = make()
    // record BEFORE the file exists → this is a create.
    await fh.record(p, SESSION)
    writeFileSync(p, 'generated\n')

    const out = await fh.rewind(SESSION, 1)
    expect(out.deleted).toEqual(['src/new.ts'])
    expect(existsSync(p)).toBe(false)
  })

  it('does not touch files of other sessions', async () => {
    const p = write('a.md', 'v1\n')
    const fh = make()
    await fh.record(p, 'other-session')
    writeFileSync(p, 'v2\n')

    // 只撤本会话（s1，无记录）→ 无记录抛干净错误；other-session 的记录不动。
    await expect(fh.rewind(SESSION, 1)).rejects.toThrow(/no file-change snapshot records/)
    expect(await fh.list('other-session')).toHaveLength(1)
    expect(readFileSync(p, 'utf8')).toBe('v2\n')
  })

  it('keeps the EARLIEST record per path (undo a run of consecutive edits)', async () => {
    const p = write('a.md', 'v0\n')
    const fh = make()
    await fh.record(p, SESSION)
    writeFileSync(p, 'v1\n')
    await fh.record(p, SESSION)
    writeFileSync(p, 'v2\n')

    const out = await fh.rewind(SESSION, 2)
    expect(out.restored).toEqual(['a.md'])
    expect(readFileSync(p, 'utf8')).toBe('v0\n')
  })

  it('rejects entries out of range and over-count requests', async () => {
    const fh = make()
    await expect(fh.rewind(SESSION, 0)).rejects.toThrow(/requires an integer entries/)
    await expect(fh.rewind(SESSION, 51)).rejects.toThrow(/requires an integer entries/)
    await expect(fh.rewind(SESSION, 1)).rejects.toThrow(/no file-change snapshot records/)
  })

  it('removes rewound records so a second rewind does not double-undo', async () => {
    const p = write('a.md', 'v1\n')
    const fh = make()
    await fh.record(p, SESSION)
    writeFileSync(p, 'v2\n')
    await fh.rewind(SESSION, 1)
    // 用户继续改（无新 record）→ 第二次 rewind 已无记录可撤（拒绝，不空转）。
    writeFileSync(p, 'v3\n')
    await expect(fh.rewind(SESSION, 1)).rejects.toThrow(/no file-change snapshot records/)
    expect(readFileSync(p, 'utf8')).toBe('v3\n')
  })
})

describe('skip rules', () => {
  it('does not record unprotected files (docx)', async () => {
    const p = write('report.docx', 'binary-ish')
    const fh = make()
    await fh.record(p, SESSION)
    expect(await fh.list(SESSION)).toEqual([])
  })

  it('does not record sensitive files even when protected extension (.env in cwd)', async () => {
    // `.env` basename is sensitive per isSensitivePath; even though a plain
    // `.env` has no protected extension, a sneaky `secrets.json` IS protected
    // AND sensitive-adjacent — use the canonical case: credentials.json is
    // protected-extension but NOT sensitive; use id_rsa.pem (sensitive ext).
    const p = write('id_rsa.pem', 'PRIVATE KEY')
    const fh = make()
    await fh.record(p, SESSION)
    expect(await fh.list(SESSION)).toEqual([])
  })

  it('registers but does not back up files over the per-file limit', async () => {
    const p = write('big.md', 'x'.repeat(64))
    const fh = createFileHistory({ dataRoot, cwd, maxBytesPerFile: 2 })
    await fh.record(p, SESSION)
    const entries = await fh.list(SESSION)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.skipped).toBe('too-large')

    writeFileSync(p, 'destroyed\n')
    const out = await fh.rewind(SESSION, 1)
    expect(out.unbacked).toEqual(['big.md'])
    expect(readFileSync(p, 'utf8')).toBe('destroyed\n')
  })
})

describe('content addressing', () => {
  it('stores one object per unique content (dedup)', async () => {
    const a = write('a.ts', 'same content\n')
    const b = write('b.ts', 'same content\n')
    const fh = make()
    await fh.record(a, SESSION)
    await fh.record(b, SESSION)

    const { readdirSync } = await import('node:fs')
    const objectsDir = join(dataRoot, readdirSync(dataRoot)[0]!, 'objects')
    // 同内容两个文件 → 只有一个对象。
    const total = readdirSync(objectsDir).reduce((n, d) => n + readdirSync(join(objectsDir, d)).length, 0)
    expect(total).toBe(1)
  })
})

describe('prune', () => {
  it('drops oldest entries beyond maxEntries and sweeps orphaned objects', async () => {
    const fh = createFileHistory({ dataRoot, cwd, maxEntries: 2 })
    const files = ['a.ts', 'b.ts', 'c.ts'].map((n) => write(n, `content of ${n}\n`))
    for (const f of files) await fh.record(f, SESSION)
    // record 是旁路能力（失败静默），先确认三条都真的进索引了再断言回收。
    expect(await fh.list(SESSION)).toHaveLength(3)
    await fh.prune()

    const entries = await fh.list(SESSION)
    expect(entries.map((e) => e.relPath)).toEqual(['b.ts', 'c.ts'])
    // a.ts 的对象应被清扫（其内容未被后续记录引用）。
    const { readdirSync } = await import('node:fs')
    const objectsDir = join(dataRoot, readdirSync(dataRoot)[0]!, 'objects')
    const hashes = entries.filter((e) => e.hash !== null).map((e) => e.hash)
    const onDisk: string[] = []
    for (const d of readdirSync(objectsDir)) for (const f of readdirSync(join(objectsDir, d))) onDisk.push(f.replace(/\.z$/, ''))
    expect(onDisk.sort()).toEqual(hashes.sort())
  })
})

describe('recordShellCommand', () => {
  it('snapshots paths named in a destructive command (rm two files)', async () => {
    const a = write('a.ts', 'A\n')
    const b = write('b.ts', 'B\n')
    const fh = make()
    await fh.recordShellCommand(`rm ${a} ${b}`, SESSION)
    writeFileSync(a, 'gone')
    writeFileSync(b, 'gone')

    const out = await fh.rewind(SESSION, 2)
    expect(out.restored.sort()).toEqual(['a.ts', 'b.ts'])
    expect(readFileSync(a, 'utf8')).toBe('A\n')
    expect(readFileSync(b, 'utf8')).toBe('B\n')
  })

  it('ignores flags, urls and unresolvable tokens', async () => {
    const fh = make()
    await fh.recordShellCommand('rm -rf node_modules && curl https://x.example && rm $SOMETHING', SESSION)
    expect(await fh.list(SESSION)).toEqual([])
  })

  // v0.36.1 P1-1：只读命令不再留底。
  it('does NOT snapshot paths that a read-only command merely mentions', async () => {
    const fh = make()
    const a = write('a.ts', 'A\n')
    await fh.recordShellCommand(`grep -n foo ${a}`, SESSION)
    await fh.recordShellCommand(`cat ${a}`, SESSION)
    await fh.recordShellCommand(`npm run build`, SESSION)
    expect(await fh.list(SESSION)).toEqual([])
  })

  it('still snapshots paths mentioned by a write-like command', async () => {
    const fh = make()
    const a = write('a.ts', 'A\n')
    await fh.recordShellCommand(`rm ${a}`, SESSION)
    expect(await fh.list(SESSION)).toHaveLength(1)
  })
})

describe('isWriteLikeShellCommand', () => {
  const READS = [
    'grep foo.ts src/',
    'cat bar.md',
    'ls -la',
    'rg -n pattern src/',
    'npm run build',
    'git status',
    'head -20 README.md',
    'node -e "console.log(1)"',
  ]
  const WRITES = [
    'rm a.ts',
    'rm /tmp/x -rf',
    'mv a.ts b.ts',
    'cp a.ts b.ts',
    'sed -i "s/a/b/" f.ts',
    'echo x > out.md',
    'tee out.md',
    'touch a.ts',
    'chmod 644 a.sh',
    'git checkout -- a.ts',
    'git restore a.ts',
    'sudo rm a.ts',
    'for i in 1; do rm a.ts; done',
    'Remove-Item a.ts -Recurse -Force',
    'Set-Content a.txt hello',
  ]

  it('reports read-only commands as non-write', () => {
    for (const c of READS) expect(isWriteLikeShellCommand(c), c).toBe(false)
  })

  it('reports write commands as write', () => {
    for (const c of WRITES) expect(isWriteLikeShellCommand(c), c).toBe(true)
  })

  it('does not read a `>` inside quotes as a redirect', () => {
    expect(isWriteLikeShellCommand('grep "a>b" x.ts')).toBe(false)
  })

  it('fails open on commands it cannot judge (skip the snapshot, never guess)', () => {
    expect(isWriteLikeShellCommand('$MY_TOOL --go')).toBe(false)
    expect(isWriteLikeShellCommand('xargs -n1 something')).toBe(false)
  })
})

describe('record 回执（v0.36.1 P1-2：把"撤不回来"显性化）', () => {
  it('reports snapshotted for a protected file', async () => {
    const fh = make()
    const a = write('a.ts', 'A\n')
    expect(await fh.record(a, SESSION)).toEqual({ snapshotted: true, relPath: 'a.ts' })
  })

  it('reports unprotected for a file outside the protected set', async () => {
    const fh = make()
    const d = write('report.docx', 'x')
    expect(await fh.record(d, SESSION)).toEqual({
      snapshotted: false,
      reason: 'unprotected',
      relPath: 'report.docx',
    })
    expect(await fh.list(SESSION)).toEqual([])
  })

  it('reports too-large past the per-file limit, but still registers the entry', async () => {
    const fh = createFileHistory({ dataRoot, cwd, maxBytesPerFile: 4 })
    const a = write('big.txt', 'way too long')
    expect(await fh.record(a, SESSION)).toEqual({
      snapshotted: false,
      reason: 'too-large',
      relPath: 'big.txt',
    })
    // 登记而不是静默跳过 —— 这样回滚时能如实把它计入 unbacked。
    expect(await fh.list(SESSION)).toHaveLength(1)
  })

  it('reports sensitive for a protected-looking file inside a secrets dir', async () => {
    const fh = make()
    const s = write('secrets/config.json', '{}')
    expect(await fh.record(s, SESSION)).toEqual({
      snapshotted: false,
      reason: 'sensitive',
      relPath: 'secrets/config.json',
    })
    expect(await fh.list(SESSION)).toEqual([])
  })

  it('never registers a directory — a rewind would rm it', async () => {
    // 关键安全性质：目录若被按"新建"登记（existedBefore:false），rewind 会 rm 它。
    // 两条路径都要覆盖：名字过不了白名单的（早退），以及名字**像**受保护文件的
    // （必须由 isFile() 判定拦下，否则就会登记成"新建"）。
    const fh = make()
    mkdirSync(join(cwd, 'adir'), { recursive: true })
    expect((await fh.record(join(cwd, 'adir'), SESSION)).snapshotted).toBe(false)

    mkdirSync(join(cwd, 'docs.md'), { recursive: true })
    const r = await fh.record(join(cwd, 'docs.md'), SESSION)
    expect(r.snapshotted).toBe(false)
    expect(r.reason).toBeUndefined()
    expect(await fh.list(SESSION)).toEqual([])
  })

  it('formats the single-file gap notice for the tool layer', () => {
    expect(snapshotGapNotice({ snapshotted: true })).toBeUndefined()
    expect(snapshotGapNotice({ snapshotted: false })).toBeUndefined()
    expect(snapshotGapNotice({ snapshotted: false, reason: 'unprotected', relPath: 'x.docx' })).toBe(
      '[snapshot: x.docx is not undoable via /rewind — unprotected file type]',
    )
  })

  it('summarises gaps across a multi-file change', () => {
    expect(summarizeSnapshotGaps([{ snapshotted: true }, { snapshotted: true }])).toBeUndefined()
    expect(
      summarizeSnapshotGaps([
        { snapshotted: true },
        { snapshotted: false, reason: 'unprotected', relPath: 'a.docx' },
        { snapshotted: false, reason: 'unprotected', relPath: 'b.xlsx' },
      ]),
    ).toBe(
      '[snapshot: 2 of 3 changed files are not undoable via /rewind — unprotected file type ×2]',
    )
  })
})
