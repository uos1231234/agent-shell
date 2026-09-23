// v0.26 Wave 4 — 审批/提问浮层 + 审批队列（计划 §3.2 ② / ✅G2 / ✅P1-2）。
//
// 队列纪律（P1-2）：请求排队、一屏一个（current = 队首）；会话切换时
// cancelAll（UI 失败兜底 cancelled，loop 不悬挂——cancelAll 只清队列展示，
// loop 侧的 300s fail-closed 超时仍是最终兜底）。
//
// 浮层纪律（G2）：浮层态整体接管键盘（InputRouter 模态语义），ApprovalOverlay
// 的 y/Enter/n/Esc 经 onDecision 回调走与 /approve **相同**的执行路径
// （app 把它接到 executeCommand('approve', …)）；AskUserOverlay 只负责展示
// 问题 + 键盘透传给编辑器（答案的提交组装归 app/Wave 5）。
//
// 本文件零 npm 依赖；对 src/** 仅 import type。

import type { AskQuestion } from '../../src/signals/types.js'
import type { ApprovalRequest } from '../../src/im/tools/security/approval-store.js'
import type { PendingRequest } from '../session-view.js'
import type { InputHandler } from '../input-state.js'
import type { TuiComponent } from './renderer.js'
import { wrapText } from './markdown.js'

// ============================================================================
// ApprovalQueue —— 一次一个的请求队列（✅P1-2）
// ============================================================================

/**
 * 审批/提问请求队列（FIFO）。请求经 enqueue 进队，settle(requestId) 把
 * 匹配项移出（无论它在队首还是队中——迟到应答不阻塞后续），队列自然前移；
 * 会话切换 cancelAll 清空。
 */
export class ApprovalQueue {
  private items: PendingRequest[] = []

  enqueue(request: PendingRequest): void {
    this.items.push(request)
  }

  /** 当前展示的请求（队首）；空队列 undefined。 */
  get current(): PendingRequest | undefined {
    return this.items[0]
  }

  get size(): number {
    return this.items.length
  }

  /** 只读快照（测试 / 状态栏用）。 */
  get snapshot(): readonly PendingRequest[] {
    return [...this.items]
  }

  /**
   * 移除匹配 requestId 的请求并返回它；未找到返回 undefined（迟到回包 /
   * 已被 cancelAll 清掉的请求——静默忽略，与 gate.resolve 语义对齐）。
   * decision 记入签名以便调用点自文档化，队列本身不消费。
   */
  settle(requestId: string, decision: 'approved' | 'rejected'): PendingRequest | undefined {
    const idx = this.items.findIndex((r) => r.requestId === requestId)
    if (idx === -1) return undefined
    return this.items.splice(idx, 1)[0]
  }

  /** 会话切换/退出时清空（P1-2；loop 侧超时仍是最终兜底）。 */
  cancelAll(): void {
    this.items.length = 0
  }
}

// ============================================================================
// ApprovalOverlay —— 审批浮层（一次渲染队列队首的一条审批）
// ============================================================================

export type ApprovalOverlayIo = {
  /** 当前请求（通常 = ApprovalQueue.current）；undefined 时渲染空提示。 */
  current: () => PendingRequest | undefined
  /**
   * 决议回调——app 接到与 /approve 相同的执行路径
   * （executeCommand('approve', decision === 'approved' ? 'y' : 'n', ctx)）。
   */
  onDecision: (requestId: string, decision: 'approved' | 'rejected') => void
  /**
   * 全屏预览态切换回调（v0.29 Wave B2）。app 据此把浮层重挂为整屏高度
   * （expanded）或恢复常规高度——浮层自身只管渲染与状态，高度归挂载方。
   */
  onExpandChange?: (expanded: boolean) => void
}

const ARGS_PREVIEW_MAX = 120
/** write/edit 内容预览的最大行数（超出折叠为一条提示行）。 */
export const CONTENT_PREVIEW_MAX_LINES = 20

/** bash/powershell 命令行高亮（纯色，不用加粗——终端兼容面更宽）。 */
const ANSI_YELLOW = '\x1b[33m'
const ANSI_RESET = '\x1b[0m'

const WRITE_LIKE_TOOLS = new Set(['write', 'edit'])
const SHELL_LIKE_TOOLS = new Set(['bash', 'powershell'])

/** 取 args 对象里的 string 字段（args 非纯对象 / 字段非 string → undefined）。 */
const argField = (args: unknown, key: string): string | undefined => {
  if (typeof args !== 'object' || args === null) return undefined
  const v = (args as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}

/**
 * 审批详情行（纯函数，测试直测）：
 *   - write/edit → 文件路径行 + 内容预览（args.content，≤20 行，行首 '+'），
 *     超出折叠为「…（共 N 行，[e] 查看全部）」；
 *   - bash/powershell → 命令文本单独高亮行；
 *   - 其余工具 → []（调用方维持通用参数行现状）。
 * args 形状不符（如 path 缺失）时返回 []，同样回落通用参数行——不猜参数。
 */
export const approvalDetailLines = (toolName: string, args: unknown, width: number): string[] => {
  const max = Math.max(20, width - 4)
  if (WRITE_LIKE_TOOLS.has(toolName)) {
    const path = argField(args, 'path')
    if (path === undefined) return []
    const lines = [`文件: ${truncate(path, max)}`]
    const content = argField(args, 'content')
    if (content !== undefined) {
      const split = content.split('\n')
      // 尾部 '\n' 产生的空尾行不算内容行。
      const body = split.length > 1 && split[split.length - 1] === '' ? split.slice(0, -1) : split
      for (const l of body.slice(0, CONTENT_PREVIEW_MAX_LINES)) lines.push(`+ ${truncate(l, max)}`)
      if (body.length > CONTENT_PREVIEW_MAX_LINES) {
        lines.push(`…（共 ${body.length} 行，[e] 查看全部）`)
      }
    }
    return lines
  }
  if (SHELL_LIKE_TOOLS.has(toolName)) {
    const command = argField(args, 'command')
    if (command === undefined) return []
    return [`${ANSI_YELLOW}$ ${truncate(command, Math.max(20, width - 6))}${ANSI_RESET}`]
  }
  return []
}

/**
 * ApprovalOverlay：常规态 y/Enter → 批准，n/Esc → 拒绝，e → 全屏参数预览；
 * 预览态独占键盘（Esc/q 返回，不决议不透传——防止扫读参数时误触 y）。
 */
export class ApprovalOverlay implements TuiComponent {
  private readonly io: ApprovalOverlayIo
  /** 全屏参数预览态（Esc/q 退出；换请求自动复位）。 */
  private expanded = false
  /** 上次渲染的请求 id——换请求时复位预览态的依据。 */
  private lastRequestId: string | undefined

  constructor(io: ApprovalOverlayIo) {
    this.io = io
  }

  invalidate(): void {}

  /** 当前是否处于全屏预览态（app 重挂浮层时定高度用）。 */
  get isExpanded(): boolean {
    return this.expanded
  }

  /**
   * app 挂载前对齐请求：换 requestId 时复位预览态（不在 render 里回调
   * onExpandChange——render 发生在 composeFrame 内，中途重挂浮层会撕裂帧）。
   */
  alignRequest(requestId: string): void {
    if (this.lastRequestId !== requestId) {
      this.lastRequestId = requestId
      this.expanded = false
    }
  }

  render(width: number): string[] {
    const req = this.io.current()
    if (req === undefined || req.kind !== 'approval') {
      return req === undefined ? ['（没有待审批的请求）'] : ['（当前请求不是审批）']
    }
    const p = req.payload
    // 防御性复位：alignRequest 之外的路径（如测试直连）换了请求也复位。
    this.alignRequest(req.requestId)
    if (this.expanded) return this.renderExpanded(p, width)

    const detail = approvalDetailLines(p.toolName, p.args, width)
    const argsJson = p.args === undefined ? '（无参数）' : truncate(JSON.stringify(p.args) ?? String(p.args), ARGS_PREVIEW_MAX)
    return [
      `审批请求 [队列 ${req.requestId.slice(0, 8)}]`,
      `工具: ${p.toolName}`,
      `原因: ${truncate(p.reason, Math.max(20, width - 4))}`,
      ...(detail.length > 0 ? detail : [`参数: ${argsJson}`]),
      ...(p.dangerous !== undefined ? [`风险: ${p.dangerous}`] : []),
      ...(p.args !== undefined ? ['[y] 批准 [n] 拒绝 [Esc] 拒绝 [e] 完整参数'] : ['[y] 批准 [n] 拒绝 [Esc] 拒绝']),
    ]
  }

  /** 全屏参数预览：完整 args 逐行写满终端行（长行按宽度折行），不建 alt-screen。 */
  private renderExpanded(p: ApprovalRequest, width: number): string[] {
    const lines = [`完整参数 [${p.toolName}]（Esc / q 返回审批）`]
    if (p.args === undefined) {
      lines.push('（无参数）')
      return lines
    }
    const text = typeof p.args === 'string' ? p.args : JSON.stringify(p.args, null, 2) ?? String(p.args)
    const w = Math.max(20, width - 2)
    for (const raw of text.split('\n')) {
      lines.push(...wrapText(raw, w))
    }
    return lines
  }

  handleInput(data: string): boolean {
    const req = this.io.current()
    if (req === undefined || req.kind !== 'approval') return false
    // 与渲染同源对齐（换请求复位预览态——handleInput 先于 render 发生）。
    this.alignRequest(req.requestId)
    if (this.expanded) {
      // 预览态独占键盘：只认返回键，其余吞掉（不决议、不透传编辑器）。
      switch (data) {
        case '\x1b': // 裸 Esc
        case 'q':
        case 'Q':
          this.expanded = false
          this.io.onExpandChange?.(false)
          return true
        default:
          return true
      }
    }
    switch (data) {
      case 'y':
      case 'Y':
      case '\r':
      case '\n':
        this.io.onDecision(req.requestId, 'approved')
        return true
      case 'n':
      case 'N':
        this.io.onDecision(req.requestId, 'rejected')
        return true
      case 'e':
      case 'E':
        // 无参数可看时不消费（维持未识别键语义）。
        if (req.payload.args === undefined) return false
        this.expanded = true
        this.io.onExpandChange?.(true)
        return true
      case '\x1b': // Esc（裸 ESC；与后续字节的组合序列落 default 不消费）
        this.io.onDecision(req.requestId, 'rejected')
        return true
      default:
        return false
    }
  }
}

// ============================================================================
// AskUserOverlay —— 提问浮层（展示问题 + 键盘透传）
// ============================================================================

export type AskUserOverlayIo = {
  requestId: string
  questions: readonly AskQuestion[]
  /** 键盘透传目标（编辑器）；浮层只展示问题，不拦截输入。 */
  passthrough: InputHandler
}

/** 单问题带选项时选项可用序号选择（数字行 → label）；其余形态一律自由文本。 */
const hasIndexableOptions = (questions: readonly AskQuestion[]): AskQuestion | undefined => {
  const q = questions.length === 1 ? questions[0] : undefined
  return q !== undefined && q.options !== undefined && q.options.length > 0 ? q : undefined
}

/**
 * ask_user 浮层的提交行 → 答案（纯函数，与 AskUserOverlay 展示同源）：
 *   - 单问题带选项："2" → 该选项 label；"1,3"（多选）→ label 数组；
 *     序号越界 / 单选填多个序号 → 回落自由文本（不误解用户输入，不报错）；
 *   - 其余输入（含多问题、自由文本题）→ 原样 trimmed = 自由打字回答
 *     （deepseek"或者输入其他回答"语义，选项永远不封死打字通道）。
 */
export const resolveAskUserLine = (
  line: string,
  questions: readonly AskQuestion[],
): string | string[] => {
  const text = line.trim()
  const q = hasIndexableOptions(questions)
  if (q === undefined || !/^\d+(?:\s*[,，]\s*\d+)*$/.test(text)) return text
  const nums = text.split(/[,，]/).map((s) => Number(s.trim()))
  const options = q.options!
  if (nums.some((n) => n < 1 || n > options.length)) return text
  const labels = nums.map((n) => options[n - 1]!.label)
  if (q.multiSelect === true) return [...new Set(labels)]
  return labels.length === 1 ? labels[0]! : text
}

export class AskUserOverlay implements TuiComponent {
  private readonly io: AskUserOverlayIo

  constructor(io: AskUserOverlayIo) {
    this.io = io
  }

  invalidate(): void {}

  render(width: number): string[] {
    const indexable = hasIndexableOptions(this.io.questions) !== undefined
    const lines = [
      indexable
        ? `提问 [${this.io.requestId.slice(0, 8)}]（输入序号选择${this.io.questions[0]?.multiSelect === true ? '（多选如 1,3）' : ''}，或直接输入其他回答，Enter 提交）`
        : `提问 [${this.io.requestId.slice(0, 8)}]（输入回答，Enter 提交）`,
    ]
    this.io.questions.forEach((q, i) => {
      lines.push(`${i + 1}. ${truncate(q.question, Math.max(20, width - 4))}`)
      ;(q.options ?? []).forEach((opt, j) => {
        const marker = indexable ? `${j + 1})` : '·'
        lines.push(`   ${marker} ${opt.label}${opt.description !== undefined ? ` — ${truncate(opt.description, Math.max(16, width - 10))}` : ''}`)
      })
    })
    return lines
  }

  /** 透传：浮层不消费任何键，答案由透传目标（编辑器）处理。 */
  handleInput(data: string): boolean {
    return this.io.passthrough.handleInput(data)
  }
}

// ============================================================================

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`
