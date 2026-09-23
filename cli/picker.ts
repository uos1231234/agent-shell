// v0.26 Wave 5 — 会话 picker 浮层（计划 §3.3 / ✅G5 workDir 校验）。
//
// 职责（计划 Wave 5 行 + Wave A 增强）：列出历史会话，**当前工作区的会话排在
// 前面**；其他工作区的会话以暗色分区展示在尾部——G5 禁止在 picker 里恢复它们
// （选中只给提示 `cd <dir> 后用 /resume <id>`，不切会话）。up/down 导航、
// Enter 选择、Esc 取消。
//
// Wave A 增强（对标 KimiCode SearchableList）：顶部过滤行——**键入即过滤**
// （无需切换模式；浮层整体接管键盘，text 事件直接进查询串）、Backspace 删字、
// Ctrl-U 清空；匹配 = 大小写不敏感子序列 fuzzy（fuzzyMatch 纯函数，高分靠前，
// 平分保持分区原序）；列表项显示相对时间 + title（空 title 回落 id 前缀）+
// workDir 尾段；当前活跃会话加 '*' 标记。
//
// 纪律：本文件零 npm 依赖；对 src/** 仅 import type。会话清单由 app 在打开
// picker 前经 gate.command('session.list') 取好注入——picker 自己不发命令
// （浮层不持有 harness 通道）。workDir 相等判定与 commands/handlers.ts 的
// /resume 校验同口径（resolve 规范化 + win32 大小写不敏感）。

import { resolve as pathResolve } from 'node:path'

import type { SessionInfo } from '../src/im/session/types.js'
import type { InputHandler } from './input-state.js'
import type { TuiComponent } from './tui/renderer.js'
import { KeyDecoder } from './keys.js'

/**
 * ✅G5 workDir 相等：resolve 规范化 + win32 大小写不敏感。
 * （与 commands/handlers.ts 内部实现同口径；导出供 app/main 复用。）
 */
export const sameWorkDir = (a: string, b: string): boolean => {
  const norm = (p: string): string => {
    const r = pathResolve(p)
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

// ---------------------------------------------------------------------------
// 纯函数：fuzzy 匹配 + 相对时间（Wave A，tests 直接测）
// ---------------------------------------------------------------------------

const isWordChar = (ch: string): boolean => /[a-z0-9]/.test(ch)

/**
 * 大小写不敏感子序列 fuzzy 匹配：query 的每个字符按序出现在 text 中即命中。
 * 返回匹配分（越高越好），非子序列返回 null。计分：命中 +1；与上一个命中
 * 相邻（连续）+2；命中在文本头或分隔符（空格 - _ / . , :）之后 +3。
 * 空查询匹配一切，得 0 分（保持原序）。
 */
export const fuzzyMatch = (query: string, text: string): number | null => {
  if (query === '') return 0
  const q = [...query.toLowerCase()]
  const t = [...text.toLowerCase()]
  let score = 0
  let searchFrom = 0
  let prevIdx = -2
  for (const qc of q) {
    const idx = t.indexOf(qc, searchFrom)
    if (idx === -1) return null
    score += 1
    if (idx === prevIdx + 1) score += 2
    if (idx === 0 || !isWordChar(t[idx - 1] ?? '')) score += 3
    prevIdx = idx
    searchFrom = idx + 1
  }
  return score
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / YYYY-MM-DD（now 可注入）。 */
export const formatRelativeTime = (ts: number, now: number = Date.now()): string => {
  const diff = Math.max(0, now - ts)
  const MIN = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  if (diff < MIN) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ---------------------------------------------------------------------------
// 浮层
// ---------------------------------------------------------------------------

/** 有序条目：当前工作区在前（保持 gate 清单原序），其他工作区在后。 */
export type PickerEntry = { info: SessionInfo; here: boolean }

export type SessionPickerIo = {
  /** 会话清单（app 预取的 session.list 回执）。 */
  entries: readonly SessionInfo[]
  /** 当前 CLI 工作区（分区依据）。 */
  workDir: string
  /** 当前活跃会话（列表加 '*' 标记；未指定不标）。 */
  activeSessionId?: string
  /** 选中当前工作区会话（app：open + history + hydrate + 切视图）。 */
  onPick: (info: SessionInfo) => void
  /** 选中其他工作区会话（app：退出 picker + 提示，不切会话）。 */
  onForeignPick: (info: SessionInfo) => void
  /** Esc / Ctrl-C 取消（app：退出 picker 回编辑器）。 */
  onCancel: () => void
}

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

/** fuzzy 匹配域：title + id + workDir（按 workspace 片段搜也有用）。 */
const matchableText = (info: SessionInfo): string =>
  `${info.title} ${info.id} ${info.workDir ?? ''}`

/** workDir 尾段（最后一段路径，win/posix 分隔符都认）。 */
const tailSegment = (p: string): string => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? p : p.slice(i + 1)
}

/** 标题列：非空 title 优先，空 title 回落 id 前缀。 */
const displayTitle = (info: SessionInfo): string =>
  info.title.trim() !== '' ? info.title : info.id.slice(0, 8)

export class SessionPickerOverlay implements TuiComponent, InputHandler {
  private index = 0
  private query = ''
  private readonly decoder = new KeyDecoder()

  constructor(private readonly io: SessionPickerIo) {}

  /**
   * 可见条目：空查询 = 分区原序（当前工作区在前）；有查询 = 两分区各自按
   * fuzzy 分降序（stable sort，平分保持注入清单原序）。
   */
  get ordered(): readonly PickerEntry[] {
    const scoreOf = (info: SessionInfo): number | null =>
      fuzzyMatch(this.query, matchableText(info))
    const here: { entry: PickerEntry; score: number }[] = []
    const other: { entry: PickerEntry; score: number }[] = []
    for (const info of this.io.entries) {
      const score = scoreOf(info)
      if (score === null) continue
      const isHere = info.workDir !== undefined && sameWorkDir(info.workDir, this.io.workDir)
      ;(isHere ? here : other).push({ entry: { info, here: isHere }, score })
    }
    const byScore = (a: { score: number }, b: { score: number }): number => b.score - a.score
    return [...here.sort(byScore).map((x) => x.entry), ...other.sort(byScore).map((x) => x.entry)]
  }

  invalidate(): void {}

  render(width: number): string[] {
    void width // 浮层行不换行（与既有行为一致）；签名随 TuiComponent
    const items = this.ordered
    if (this.index >= items.length) this.index = 0
    const header =
      this.query === ''
        ? '会话选择（↑/↓ 移动 · Enter 选择 · Esc 取消 · 键入即过滤）'
        : `过滤: ${this.query}▏（Backspace 删字 · Ctrl-U 清空 · Esc 取消）`
    const rows = [header]
    if (items.length === 0) {
      rows.push(this.query === '' ? '（暂无历史会话）' : '（无匹配会话）')
      return rows
    }
    const hasForeign = items.some((it) => !it.here)
    let prevHere: boolean | undefined
    items.forEach((it, i) => {
      // 分区头：第一条外来条目前插入（当前工作区有内容且存在外来条目时，
      // 第一条当前工作区条目前也标出头，两分区视觉可分）。
      if (hasForeign && prevHere !== false && it.here !== prevHere) {
        rows.push(it.here ? '── 当前工作区 ──' : '── 其他工作区（不可在此恢复）──')
      }
      prevHere = it.here
      const sel = i === this.index ? '❯' : ' '
      const active = it.info.id === this.io.activeSessionId ? '*' : ' '
      const time = formatRelativeTime(it.info.lastActiveAt)
      const row = `${sel}${active} ${displayTitle(it.info)}  ${it.info.id.slice(0, 8)}  回合 ${it.info.turnCount} · ${time}`
      if (it.here) {
        rows.push(row)
      } else {
        const tail = it.info.workDir !== undefined ? tailSegment(it.info.workDir) : '（未指定工作区）'
        rows.push(`${DIM}${row}  ${tail}${RESET}`)
      }
    })
    return rows
  }

  /** 浮层整体接管键盘（InputRouter 模态语义）；返回 true = 已消费。 */
  handleInput(data: string | Buffer): boolean {
    const events = this.decoder.feed(data)
    if (events.length === 0) return false
    for (const ev of events) {
      if (ev.kind === 'text') {
        // 键入即过滤（SearchableList 形态）：可见字符直接进查询串。
        this.query += ev.chars
        this.index = 0
        continue
      }
      switch (ev.name) {
        case 'up':
          this.index = Math.max(0, this.index - 1)
          continue
        case 'down':
          this.index = Math.min(this.ordered.length - 1, this.index + 1)
          continue
        case 'backspace':
          this.query = [...this.query].slice(0, -1).join('')
          this.index = 0
          continue
        case 'ctrl+u':
          this.query = ''
          this.index = 0
          continue
        case 'enter': {
          const entry = this.ordered[this.index]
          if (entry === undefined) return true
          if (entry.here) this.io.onPick(entry.info)
          else this.io.onForeignPick(entry.info)
          return true
        }
        case 'esc':
        case 'ctrl+c':
          this.io.onCancel()
          return true
        default:
          continue
      }
    }
    return true
  }
}
