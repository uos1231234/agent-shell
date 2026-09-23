// v0.36 — 文件改动的「可恢复」快照层（写前留底，事后可回滚）。
//
// 设计取向（用户 2026-09-11 拍板，对标见 docs/plans）：
//
//   - **只保护文本类文件**：代码 + Markdown/HTML/CSS + 结构化文本（json/yaml/toml…）。
//     办公文档（doc/docx/xlsx）刻意不保护——它们是 zip 包，AI 改一次基本是整块
//     重写，快照既无信息量又占地方，而 Office/WPS 自带版本历史；反过来代码文件
//     没有任何默认撤销机制（除非用户自己会 git），这才是本模块要补的缺口。
//
//   - **内容寻址 + zlib 压缩**：以内容 sha256 命名对象，同一内容只落一份盘
//     （结构性去重），这是针对 AtomCode 教训的正面设计——它做过 turn 级 Git
//     影子快照，v5.0.5 因磁盘占用把功能禁用了（"temporarily disabled ... to
//     protect disk space"）。所以本模块把四道闸门和功能同批交付：
//     单文件上限 / 条数上限 / 总字节上限 / LRU 回收。
//
//   - **敏感文件一律不快照**：快照的语义是把内容复制到另一个目录，绝不能因此
//     扩大凭据的落盘面。判定复用 security/sensitive-path 的 isSensitivePath，
//     与 read 工具天然对齐（.env / id_rsa / .aws/credentials 都不进快照库）。
//
//   - **record() 自己读文件**，不由调用方传入内容。三个写类工具（write / edit /
//     search_replace）的接入因此各自只需一行，接口面最小；代价是 edit 已经读过
//     的字节会被再读一次，2MB 以内的文本文件这点开销可以接受。
//
//   - **快照是旁路，任何失败都不阻断主操作**。写盘是用户真正要的事，快照只是
//     保险；TOCTOU（文件在两步之间被删）之类的失败会被静默吞掉，不制造假故障。
//
// 落点：<dataRoot>/<项目指纹>/{objects/<前2位>/<sha256>.z, index.jsonl}
//
// 索引是 append-only 的行式 JSON（损坏行跳过，与 readJsonl 同口径）；只有回滚和
// 回收会整体重写（tmp + rename 原子替换）。

import { createHash } from 'node:crypto'
import { deflate, inflate } from 'node:zlib'
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { extractShellPathCandidates, isSensitivePath } from './security/sensitive-path.js'
import { defaultLogger } from '../../shared/logger.js'

/** 快照组件的日志出口（NDJSON sink）。失败只 warn 不抛，旁路语义不变。 */
const log = defaultLogger.child({ component: 'file-history' })

/** 单文件备份上限：超过只登记不备份（2MB，与 mimo-cli 同口径）。 */
export const DEFAULT_MAX_BYTES_PER_FILE = 2 * 1024 * 1024
/** 索引条数上限。 */
export const DEFAULT_MAX_ENTRIES = 2000
/** 索引内原始字节总和上限（近似口径，见 prune 注释）。 */
export const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024

/**
 * 受保护的扩展名（文本类）。判定**只按扩展名**，不读文件内容——
 * 因此「看不懂的文件一律跳过」，没有任何格式解析逻辑。
 */
const PROTECTED_EXTENSIONS = new Set([
  // 代码
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.pyi', '.rs', '.go', '.java', '.kt', '.kts', '.scala', '.groovy',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.cs', '.m', '.mm',
  '.rb', '.php', '.swift', '.dart', '.lua', '.pl', '.pm', '.r', '.jl',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.psd1', '.bat', '.cmd',
  '.sql', '.graphql', '.gql', '.proto', '.vue', '.svelte', '.astro',
  '.ex', '.exs', '.erl', '.hs', '.clj', '.cljs', '.fs', '.fsx', '.vb',
  '.asm', '.s', '.v', '.sv', '.vhd', '.sol', '.zig', '.nim',
  // 标记 / 网页 / 样式
  '.md', '.mdx', '.markdown', '.html', '.htm', '.xhtml',
  '.css', '.scss', '.sass', '.less', '.styl',
  // 结构化文本 / 配置
  '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.conf', '.properties', '.env', '.xml', '.svg', '.txt', '.text', '.csv', '.tsv',
])

/** 无扩展名的常规文本文件（按文件名整词匹配，小写）。 */
const PROTECTED_FILENAMES = new Set([
  'makefile', 'dockerfile', 'license', 'readme', 'changelog', 'authors',
  'notice', 'copying', 'procfile', 'gemfile', 'rakefile', 'justfile',
])

/** 目录黑名单：这些目录里的文件即使扩展名命中也不保护（纯噪音、体积大）。 */
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn',
  'dist', 'build', 'out', 'output', 'coverage', 'release',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache', '.vite',
  'target', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  'vendor', 'pods', '.gradle', '.m2', '.idea',
  '.agent-shell', '.databus',
])

/** 索引中的一条快照记录。 */
export type SnapshotEntry = {
  ts: string
  sessionId: string
  /** 绝对路径（回滚时的还原目标）。 */
  path: string
  /** 相对工作目录的路径（展示用）。 */
  relPath: string
  /** 内容 sha256；null 表示没有内容副本（新建文件或超限跳过）。 */
  hash: string | null
  /** 原始字节数。 */
  size: number
  /** 写操作**之前**该文件是否存在（false ⇒ 回滚时应删除它）。 */
  existedBefore: boolean
  /** 有值表示当时没做成备份，及其原因。 */
  skipped?: 'too-large'
}

export type RewindOutcome = {
  /** 成功还原的文件（相对路径）。 */
  restored: string[]
  /** 成功删除的文件（AI 当时新建的）。 */
  deleted: string[]
  /** 当时超限没备份、因此撤不回来的文件（诚实上报，不假装成功）。 */
  unbacked: string[]
  /** 实际处理的索引条数。 */
  entries: number
}

export type FileHistory = {
  /** 写操作**之前**调用：把文件当前内容留底。任何失败都不抛。 */
  record(absPath: string, sessionId: string): Promise<SnapshotRecordResult>
  /**
   * shell 命令**执行之前**调用：从命令串抽路径候选（与 sensitive-path door
   * 同一套 token 抽取），对命令行里写明的破坏性目标（rm/mv/cp 的操作数、
   * `>` 重定向目标）逐个留底。任何失败都不抛。
   */
  recordShellCommand(command: string, sessionId: string): Promise<void>
  /** 回滚某会话最近 entries 条写操作所涉及的文件。 */
  rewind(sessionId: string, entries: number): Promise<RewindOutcome>
  /** 列出某会话的快照记录（时间升序）。 */
  list(sessionId: string): Promise<SnapshotEntry[]>
  /**
   * 「最近一个 turn 窗口」内的记录数（0 = 没有记录）。
   *
   * 给网页端「撤销更改」按钮用：前端只有 ToolTurn 视图，快照记录在宿主侧，
   * 让前端自己数就会数错。**这是近似**——详见实现处注释。
   */
  countLastTurnRecords(sessionId: string): Promise<number>
  /** 执行一次配额回收（record 内部按批触发，测试可直接调）。 */
  prune(): Promise<void>
}

export type FileHistoryOptions = {
  /** 快照数据根目录（通常是 <dataDir>/file-history）。 */
  dataRoot: string
  /** 工作目录：用于算相对路径、目录黑名单判定与项目指纹。 */
  cwd: string
  maxBytesPerFile?: number
  maxEntries?: number
  maxTotalBytes?: number
}

/**
 * 写类工具的可选第二参数——传了才做快照。
 * 不传即维持原有行为，因此现有单元测试零改动（同 v0.35 的 shell 方言参数手法）。
 */
export type SnapshotContext = {
  history: Pick<FileHistory, 'record' | 'recordShellCommand'>
  sessionId: string
}

/** 没做成快照的原因（v0.36.1 P1-2：把设计边界显性化，而不是扩大保护范围）。 */
export type SnapshotGapReason = 'unprotected' | 'too-large' | 'sensitive'

/**
 * record 的回执（v0.36.1 P1-2）。
 *
 * 为什么要有返回值：原来 record 是 void，于是「文件确实被 AI 改了、但 rewind
 * 撤不回来」这件事对用户完全不可见——他会以为 /rewind 兜住了一切。返回值让
 * 工具层能在成功文本尾部加一句提示，作用域恰好＝"写了却没留底"，不多不少。
 */
export type SnapshotRecordResult = {
  /** 是否已留底（含"原本不存在"的新建登记——回滚据此删除该文件）。 */
  snapshotted: boolean
  /** 没留底的原因。无 reason ⇒ 不是快照目标（目录 / 越界 / 意外失败），不提示。 */
  reason?: SnapshotGapReason
  /** 相对工作目录的展示路径（有值时用于提示文案）。 */
  relPath?: string
}

const GAP_TEXT: Record<SnapshotGapReason, string> = {
  unprotected: 'unprotected file type',
  'too-large': 'file exceeds the 2 MB snapshot limit',
  sensitive: 'sensitive file — never snapshotted by design',
}

/** 单文件提示行。没留底且原因可知时才产出，否则 undefined（调用方不追加）。 */
export const snapshotGapNotice = (result: SnapshotRecordResult): string | undefined => {
  if (result.snapshotted || result.reason === undefined) return undefined
  return `[snapshot: ${result.relPath ?? 'this file'} is not undoable via /rewind — ${GAP_TEXT[result.reason]}]`
}

/**
 * 批量提示行（search_replace 逐文件提示太啰嗦，汇总成一行）。
 * `results.length` = 本次成功改动的文件数，因此 "N of M" 是天然而不是凑出来的。
 */
export const summarizeSnapshotGaps = (
  results: readonly SnapshotRecordResult[],
): string | undefined => {
  const gaps = results.filter((r) => !r.snapshotted && r.reason !== undefined)
  if (gaps.length === 0) return undefined
  const byReason = new Map<SnapshotGapReason, number>()
  for (const g of gaps) {
    const reason = g.reason as SnapshotGapReason
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
  }
  const detail = [...byReason].map(([reason, n]) => `${GAP_TEXT[reason]} ×${n}`).join(', ')
  return `[snapshot: ${gaps.length} of ${results.length} changed files are not undoable via /rewind — ${detail}]`
}

/** rewind 允许的条数范围（宿主是最终校验点）。 */
export const REWIND_MAX_ENTRIES = 50

/** 受保护判断（只看路径形态，不读内容）。relPath 必须是相对工作目录的路径。 */
export const isProtectedRelPath = (relPath: string): boolean => {
  const segments = relPath.split(/[\\/]/)
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (EXCLUDED_DIRS.has(segments[i]!.toLowerCase())) return false
  }
  const name = basename(relPath).toLowerCase()
  const ext = extname(name)
  if (ext === '') return PROTECTED_FILENAMES.has(name)
  return PROTECTED_EXTENSIONS.has(ext)
}

// --- shell 命令的「写类」预判（v0.36.1 P1-1） ------------------------------
//
// 动机：原来对命令里的**任何**候选路径都留底，于是 `grep foo.ts` / `cat bar.md`
// 也生成记录——既污染 rewind 语义（可能把文件还原到比用户预期更早的版本），
// 又白占配额。只读命令不该留底。
//
// 方言混编一张小表、**不依赖危险命令分类器**：两者关心的东西不同（那个问
// "危不危险"，这个问"写不写"），共享一张表只会让两边互相牵制。
//
// 保守取向：**判不出来就不留底**。这里与分类器相反是刻意的——漏快照只是这条
// 命令不可撤（与本地未实现该能力时等同），误快照却会污染 rewind 的语义。

/** 语句分隔符（与分类器同一族；这里只用来定位「命令位」）。 */
const STATEMENT_SEPARATORS = /(?:\|\||&&|[|;&\n])/

/** 复合语句的前导关键字：`for i in 1; do <verb> ...; done` 里真正的命令位。 */
const LEADING_KEYWORDS = new Set(['do', 'then', 'else', '{', '(', '}'])

/** 权限 / 包装前缀：真正的动词在其后一个非 flag token。 */
const WRAPPER_VERBS = new Set([
  'sudo', 'doas', 'pkexec', 'nice', 'nohup', 'env', 'time', 'setsid', 'stdbuf', 'command',
])

/**
 * 写类动词（POSIX 侧 + Windows shell 侧合并，不做方言门控）。
 * 只收「会改文件内容或目录结构」的动词；`tar` 这类只读输入、写新产物的不收。
 */
const WRITE_VERBS = new Set([
  'rm', 'rmdir', 'unlink', 'shred',
  'mv', 'cp', 'install', 'ln', 'rsync', 'dd', 'truncate', 'tee', 'touch',
  'chmod', 'chown', 'chgrp', 'mkfifo', 'mknod', 'patch',
  // Windows shell cmdlet 及其常用别名
  'remove-item', 'del', 'erase', 'rd', 'ri',
  'set-content', 'add-content', 'clear-content', 'out-file', 'sc', 'ac', 'clc',
  'move-item', 'copy-item', 'new-item', 'mi',
])

/** 去掉引号包裹（`"rm"` / `'rm'`），用于取动词。 */
const unquote = (tok: string): string => {
  const t = tok.trim()
  if (t.length >= 2 && (t.startsWith('"') || t.startsWith("'")) && t.endsWith(t.charAt(0))) {
    return t.slice(1, -1)
  }
  return t
}

/** 动词归一化：去引号 → 取 basename（`/bin/rm`、`C:\...\del.exe`）→ 去可执行后缀 → 小写。 */
const normalizeVerb = (tok: string | undefined): string => {
  if (tok === undefined) return ''
  const bare = unquote(tok)
  if (bare === '') return ''
  const base = bare.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/i, '').toLowerCase()
}

/** 去掉引号内的内容：避免把字符串里的 `>` 当成重定向。 */
const stripQuotedSpans = (command: string): string =>
  command.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''")

/**
 * 该 shell 命令是否可能改动文件。true ⇒ 抽取候选路径并留底；false ⇒ 完全跳过。
 *
 * 判定：① 存在（引号外的）`>` 重定向；或 ② 命令位上的动词属于写类；
 * 或 ③ `sed -i` / `git checkout|restore|clean|reset`。
 */
export const isWriteLikeShellCommand = (command: string): boolean => {
  const bare = stripQuotedSpans(command)
  if (bare.includes('>')) return true

  for (const seg of bare.split(STATEMENT_SEPARATORS)) {
    const toks = seg.trim().split(/\s+/).filter((t) => t !== '')
    let i = 0
    while (i < toks.length && LEADING_KEYWORDS.has(unquote(toks[i]!).toLowerCase())) i += 1

    let j = i
    let verb = normalizeVerb(toks[j])
    while (WRAPPER_VERBS.has(verb) && j + 1 < toks.length) {
      j += 1
      verb = normalizeVerb(toks[j])
    }
    if (verb === '') continue
    if (WRITE_VERBS.has(verb)) return true

    // `sed -i`（就地编辑）：只看单个短选项里含 i 的写法，`--in-place` 也收。
    if (verb === 'sed') {
      const flags = toks.slice(j + 1)
      if (flags.some((t) => t === '--in-place' || (/^-[^-]/.test(t) && t.includes('i')))) return true
    }
    // 会改动工作区的 git 子命令。
    if (verb === 'git') {
      const sub = normalizeVerb(toks[j + 1])
      if (sub === 'checkout' || sub === 'restore' || sub === 'clean' || sub === 'reset') return true
    }
  }
  return false
}

const compress = (buf: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    deflate(buf, (err, out) => (err ? reject(err) : resolve(out)))
  })

const decompress = (buf: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    inflate(buf, (err, out) => (err ? reject(err) : resolve(out)))
  })

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export const createFileHistory = (opts: FileHistoryOptions): FileHistory => {
  const maxBytesPerFile = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES

  const projectKey = createHash('sha256').update(opts.cwd).digest('hex').slice(0, 16)
  const dir = join(opts.dataRoot, projectKey)
  const objectsDir = join(dir, 'objects')
  const indexPath = join(dir, 'index.jsonl')

  // 每 PRUNE_EVERY 次 record 触发一次回收检查；常态下这是一次索引读 + 一次比较。
  const PRUNE_EVERY = 32
  let sincePrune = 0

  const objectPath = (hash: string): string => join(objectsDir, hash.slice(0, 2), `${hash}.z`)

  const readIndex = async (): Promise<SnapshotEntry[]> => {
    let raw: string
    try {
      raw = await readFile(indexPath, 'utf8')
    } catch {
      return []
    }
    const out: SnapshotEntry[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        out.push(JSON.parse(trimmed) as SnapshotEntry)
      } catch {
        // 损坏行跳过：索引是 append-only，单行被截断不该让整个历史不可读。
      }
    }
    return out
  }

  const writeIndex = async (entries: readonly SnapshotEntry[]): Promise<void> => {
    await mkdir(dir, { recursive: true })
    const body = entries.length === 0 ? '' : `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`
    const tmp = `${indexPath}.tmp`
    await writeFile(tmp, body, 'utf8')
    await rename(tmp, indexPath)
  }

  const appendIndex = async (entry: SnapshotEntry): Promise<void> => {
    await mkdir(dir, { recursive: true })
    await appendFile(indexPath, `${JSON.stringify(entry)}\n`, 'utf8')
  }

  const collectReferenced = (entries: readonly SnapshotEntry[]): Set<string> => {
    const referenced = new Set<string>()
    for (const e of entries) if (e.hash !== null) referenced.add(e.hash)
    return referenced
  }

  const sweepObjects = async (referenced: Set<string>): Promise<void> => {
    let buckets: string[]
    try {
      buckets = await readdir(objectsDir)
    } catch {
      return
    }
    for (const bucket of buckets) {
      const bucketDir = join(objectsDir, bucket)
      let files: string[]
      try {
        files = await readdir(bucketDir)
      } catch {
        continue
      }
      for (const f of files) {
        const hash = f.endsWith('.z') ? f.slice(0, -2) : f
        if (!referenced.has(hash)) {
          try {
            await rm(join(bucketDir, f), { force: true })
          } catch {
            // 回收失败不阻断：残留对象只是占盘，不影响正确性。
          }
        }
      }
    }
  }

  // 配额口径是近似值：按索引里记录的**原始** size 求和，而不是对象压缩后的
  // 实际占用。理由是这样零额外 IO（不必 stat 每个对象），且偏保守（实际占用
  // 只会更小）。代价是去重带来的空间收益没有反映在配额判断上——可接受。
  const totalBytesOf = (entries: readonly SnapshotEntry[]): number =>
    entries.reduce((sum, e) => sum + e.size, 0)

  // v0.36.1 P0-1：索引操作串行化。
  //
  // 竞态：writeIndex 是 read → 写 tmp → rename，而 appendIndex 是独立的一次
  // append。两者交错时，append 可能落在**已被 rename 掉的旧 inode** 上 → 该条
  // 记录随旧 inode 一起消失。Node 是单线程事件循环，交错点只在 await 边界，概率
  // 低但不是零；Windows 上更常见的表现是 rename 被 append 句柄占用而 EPERM
  // （prune 静默失败、不回收）。
  //
  // 做法：实例内一条 Promise 队列，把所有**索引**读写串起来。只串索引——对象
  // 写入是内容寻址且幂等的，无需互斥；跨进程文件锁不做（单进程多实例，窗口
  // 极小且后果只是少一条记录，见计划 §5）。
  let indexQueue: Promise<void> = Promise.resolve()
  const withIndexLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = indexQueue.then(fn)
    // 队列尾部吞掉错误，避免一次失败毒化后续所有索引操作。
    indexQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const prune = async (): Promise<void> => {
    try {
      await withIndexLock(async () => {
        const all = await readIndex()
        if (all.length <= maxEntries && totalBytesOf(all) <= maxTotalBytes) return

        let kept = all
        while (kept.length > 0 && (kept.length > maxEntries || totalBytesOf(kept) > maxTotalBytes)) {
          kept = kept.slice(1)
        }
        await writeIndex(kept)
        await sweepObjects(collectReferenced(kept))
      })
    } catch (e) {
      // 回收失败不阻断、不抛（残留记录/对象只是占盘，不影响正确性）。但不许
      // 静默——rename 被占用时的静默失败正是 P0-2 要消除的"零观测"。
      log.warn('prune failed', { err: e instanceof Error ? e.message : String(e) })
    }
  }

  const record = async (absPath: string, sessionId: string): Promise<SnapshotRecordResult> =>
    recordInner(absPath, sessionId)

  /**
   * shell 命令的破坏性目标抽取。规则刻意保守：
   *   - 只抽 token（同一套切分，parity by construction）；
   *   - 只有「确实存在且是受保护类型」的才留底——rm a.txt b.txt、
   *     `sed -i 's/a/b/' src/x.ts`、`mv x y`、`> out.md` 都能覆盖；
   *   - 选项 token（`-rf`、`--force`）已被 tokenPathCandidates 过滤掉；
   *   - 变量/命令替换 token（含 `$`/反引号）在抽取层已被跳过——快照时无法
   *     解析，不猜（诚实边界：脚本文件内容里的删除原理上不可见，与分类器
     *     的结构性盲区一致，靠 turn 级对话 undo 或用户自己的 git 兜底）。
   */
  const recordShellCommand = async (command: string, sessionId: string): Promise<void> => {
    // v0.36.1 P1-1：只读命令不留底（否则 `grep foo.ts` / `cat bar.md` 也进历史，
    // 污染 rewind 语义并白占配额）。判不出来就不留底——见 isWriteLikeShellCommand。
    if (!isWriteLikeShellCommand(command)) return
    for (const candidate of extractShellPathCandidates(command)) {
      const abs = resolve(opts.cwd, candidate)
      await recordInner(abs, sessionId)
    }
  }

  const recordInner = async (absPath: string, sessionId: string): Promise<SnapshotRecordResult> => {
    try {
      const rel = relative(opts.cwd, absPath)
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return { snapshotted: false }
      // 统一正斜杠展示（Windows 上 relative 返回反斜杠，回执跨平台一致）。
      const relPath = rel.split(sep).join('/')
      if (!isProtectedRelPath(rel)) return { snapshotted: false, reason: 'unprotected', relPath }
      if (isSensitivePath(absPath)) return { snapshotted: false, reason: 'sensitive', relPath }

      const base = { ts: new Date().toISOString(), sessionId, path: absPath, relPath }

      // 慢 IO（stat / 读源文件 / 首次压缩）都在锁外，只有"追加一条索引"进锁。
      let prior: { isFile: boolean; size: number } | null = null
      try {
        const st = await stat(absPath)
        prior = { isFile: st.isFile(), size: st.size }
      } catch {
        prior = null
      }

      let entry: SnapshotEntry
      if (prior === null) {
        // 写之前文件不存在 → 这是新建，回滚时应当把它删掉。
        entry = { ...base, hash: null, size: 0, existedBefore: false }
      } else if (!prior.isFile) {
        // 目录等非普通文件不是快照目标。**必须**在这里返回：若按"新建"登记，
        // rewind 对 existedBefore:false 的记录是 rm —— 那会把整个目录删掉。
        return { snapshotted: false, relPath }
      } else if (prior.size > maxBytesPerFile) {
        entry = { ...base, hash: null, size: prior.size, existedBefore: true, skipped: 'too-large' }
      } else {
        const buf = await readFile(absPath)
        const hash = createHash('sha256').update(buf).digest('hex')
        const objPath = objectPath(hash)
        if (!(await fileExists(objPath))) {
          await mkdir(dirname(objPath), { recursive: true })
          await writeFile(objPath, await compress(buf))
        }
        entry = { ...base, hash, size: buf.length, existedBefore: true }
      }

      await withIndexLock(() => appendIndex(entry))

      sincePrune += 1
      if (sincePrune >= PRUNE_EVERY) {
        sincePrune = 0
        await prune()
      }

      // 超限只登记不备份 ⇒ 内容撤不回来，如实回执（工具层据此提示用户）。
      return entry.skipped === 'too-large'
        ? { snapshotted: false, reason: 'too-large', relPath }
        : { snapshotted: true, relPath }
    } catch (e) {
      // 快照是旁路能力：任何失败都不该让用户的写操作失败，也不该抛出假故障
      // （例如文件在 stat 与 read 之间被删除）。但必须留痕（v0.36.1 P0-2）——
      // 静默失败曾让"prune 没回收"看起来像"一切正常"。
      log.warn('snapshot failed', {
        path: absPath,
        sessionId,
        err: e instanceof Error ? e.message : String(e),
      })
      return { snapshotted: false }
    }
  }

  const list = async (sessionId: string): Promise<SnapshotEntry[]> => {
    const all = await readIndex()
    return all.filter((e) => e.sessionId === sessionId)
  }

  /**
   * 「最近一个 turn 窗口」的记录数（v0.36.1 §2.2，供网页端撤销按钮）。
   *
   * **近似方法，且是刻意选择的**：快照记录里没有 turn 标识（record 由工具层调用，
   * 拿不到 loop 的 turn 边界），所以只能按时间簇聚类——从最新一条往回走，相邻两条
   * 间隔 > 10 分钟即认为跨了 turn。
   *
   * 偏差方向两边都有：同一 turn 内用户停手超过 10 分钟会被切成两段（少撤）；连续
   * 两个 turn 挨得很近会被并成一段（多撤）。之所以能接受：按钮的语义就是"撤掉刚才
   * 这批改动"，而结果面板会把**具体撤了哪些文件**逐条列出来，用户能立刻看见。
   */
  const TURN_GAP_MS = 10 * 60 * 1000
  const countLastTurnRecords = async (sessionId: string): Promise<number> => {
    const mine = (await readIndex()).filter((e) => e.sessionId === sessionId)
    if (mine.length === 0) return 0
    // 索引按 append 顺序写入，时间上已是升序；这里只做相邻 ts 间隔比较。
    let count = 1
    for (let i = mine.length - 1; i > 0; i -= 1) {
      const cur = Date.parse(mine[i]!.ts)
      const prev = Date.parse(mine[i - 1]!.ts)
      if (!Number.isFinite(cur) || !Number.isFinite(prev) || cur - prev > TURN_GAP_MS) break
      count += 1
    }
    return count
  }

  const rewind = async (sessionId: string, entries: number): Promise<RewindOutcome> => {
    if (!Number.isInteger(entries) || entries < 1 || entries > REWIND_MAX_ENTRIES) {
      throw new Error(`session.rewind requires an integer entries in [1, ${REWIND_MAX_ENTRIES}], got ${entries}`)
    }
    // P0-1：还原动作与索引改写必须在同一临界区——否则「读到的索引 ⇔ 还原的文件
    // ⇔ 删掉的记录」三者可能不来自同一时刻，回滚就会撤错批次。
    return withIndexLock(() => rewindLocked(sessionId, entries))
  }

  const rewindLocked = async (sessionId: string, entries: number): Promise<RewindOutcome> => {
    const all = await readIndex()
    const mine = all.filter((e) => e.sessionId === sessionId)
    if (mine.length === 0) {
      throw new Error(`session "${sessionId}" has no file-change snapshot records; nothing to rewind`)
    }
    if (mine.length < entries) {
      throw new Error(
        `session "${sessionId}" has only ${mine.length} snapshot record(s); cannot rewind ${entries}`,
      )
    }

    const selected = mine.slice(-entries)

    // 同一路径在批次里可能有多条（连续改多次）：按时间升序只取**最早**那条，
    // 才能把文件还原到这批改动发生之前的状态。
    const earliestByPath = new Map<string, SnapshotEntry>()
    for (const e of selected) if (!earliestByPath.has(e.path)) earliestByPath.set(e.path, e)

    const restored: string[] = []
    const deleted: string[] = []
    const unbacked: string[] = []

    for (const e of earliestByPath.values()) {
      if (e.existedBefore === false) {
        try {
          await rm(e.path, { force: true })
          deleted.push(e.relPath)
        } catch (err) {
          log.warn('rewind: could not delete a file the agent had created', {
            path: e.path,
            err: err instanceof Error ? err.message : String(err),
          })
          unbacked.push(e.relPath)
        }
        continue
      }
      if (e.hash === null) {
        // 当时超限没备份：诚实上报，不假装还原成功。
        unbacked.push(e.relPath)
        continue
      }
      try {
        const buf = await decompress(await readFile(objectPath(e.hash)))
        await mkdir(dirname(e.path), { recursive: true })
        await writeFile(e.path, buf)
        restored.push(e.relPath)
      } catch (err) {
        log.warn('rewind: could not restore a file from its snapshot', {
          path: e.path,
          hash: e.hash,
          err: err instanceof Error ? err.message : String(err),
        })
        unbacked.push(e.relPath)
      }
    }

    // 已回滚的记录从索引移除（与 session-undo 的 journal 重写同口径），
    // 这样重复 rewind 不会把同一批改动再撤一次。单遍保序过滤：该会话的记录里
    // 只有「最后 entries 条」被丢弃，其余（含其他会话的全部记录）原样保留。
    const keepCount = mine.length - entries
    let seen = 0
    const kept: SnapshotEntry[] = []
    for (const e of all) {
      if (e.sessionId !== sessionId) {
        kept.push(e)
        continue
      }
      seen += 1
      if (seen <= keepCount) kept.push(e)
    }
    await writeIndex(kept)

    return { restored, deleted, unbacked, entries: selected.length }
  }

  return { record, recordShellCommand, rewind, list, prune, countLastTurnRecords }
}
