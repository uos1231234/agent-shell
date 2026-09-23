// v0.26 Wave 5 — TuiApp：CLI 集成根（计划 §3.2 / §4.6 / §5）。
//
// 职责（全部在本文件汇流，别处不再有第二份装配逻辑）：
//   1. 持有 TuiScreen + LineEditor（注册进 InputRouter 的 editor 态）+
//      SessionView + subscribeToGate（gate → applySignal → requestRender）+
//      ApprovalQueue + CommandContext（executeCommand 的执行环境）。
//   2. 根组件渲染整帧：banner → 活跃会话条目（assistant 走 markdown 缩水
//      渲染；user 用 '❯ ' 前缀；tool 卡一行一枚：状态图标 + 工具名 + 产物
//      路径；memory 压缩事件 = dim 分隔行；**thinking 永不渲染为正文**——只在流式且尚无正文时给一条
//      '…（思考中）' 占位）→ 状态行（会话短 id / phase / 统计 / 挂起审批
//      数）→ 最近一条日志（暗色，可选）→ 底部编辑器行。浮层激活时
//      screen.showOverlay 盖掉帧底部（编辑器区）——输入统一走 InputRouter。
//   3. Enter 提交管线（计划 §4.6）：现算 idle（activeShard.phase==='idle'
//      && pendingApprovalCount===0 && pendingAskCount===0）→
//      resolveSlashInput(input, idle) → blocked：editor.setLine 还原 + 状态
//      提示；builtin：await executeCommand（/sessions 在 app 层升级为
//      picker 浮层）；message：appendUserMessage + gate.command('user.prompt')
//      （fire-and-forget，失败收敛为状态行）。
//   4. 审批/提问接线：请求到达 → 入队 → router 在 editor 态且请求属于活跃
//      会话时自动挂浮层；浮层决议走与 /approve **相同的执行原语**
//      （gate.command('approval.decision') + view.settleRequest +
//      queue.settle）→ exitToEditor → 自动展示下一条挂起请求。
//   5. Ctrl-C 语义（选定并记录）：streaming 中 = gate.command('turn.cancel')；
//      空闲中第一次只提示、2 秒内第二次才退出（防误触；/quit 永远可用）。
//      Esc 在编辑器态 = 编辑器内置 no-op（不清行——清行交给 Ctrl-U）。
//
// 诚实的边界（写给未来维护者）：
//   - 会话切换时 queue.cancelAll() 只清**本地 UI 队列**；host 侧请求仍是
//     挂起状态（300s fail-closed 超时兜底）——被清掉的请求会静静超时，
//     本 app 不伪造 reject。切回该会话时从分片 pendingRequests 重新认领
//     仍活着的请求。
//   - 命令历史是进程内内存数组（进程生命周期 = "session-persisted" 的
//     范围），不落盘。
//   - message 意图不因 streaming 阻塞（与 web-host 同语义）：并发 prompt
//     到同一会话是 host 层既有行为，app 不加第二条护栏。
//   - memory 压缩分隔行是 live-only（v0.30）：session.history 不回放
//     StateLine 写入，hydrate/resync 后标记从对话流消失——有意行为，不做
//     历史重建兜底。

import type { SignalGate, GateSignal, GateRequest } from '../src/signals/types.js'
import { isQueuedPromptReceipt } from '../src/signals/session-queue.js'
import type { SessionInfo } from '../src/im/session/types.js'

import { TuiScreen, type TuiComponent, type TuiIo } from './tui/renderer.js'
import { renderMarkdownToLines, truncateVisible, visibleWidth, wrapText } from './tui/markdown.js'
import { LineEditor } from './editor.js'
import { InputRouter } from './input-state.js'
import { ApprovalQueue, ApprovalOverlay, AskUserOverlay, resolveAskUserLine } from './tui/overlays.js'
import { SessionPickerOverlay } from './picker.js'
import {
  applySignal as viewApplySignal,
  activeShard,
  appendUserMessage,
  createSessionView,
  goalEventLabel,
  pendingApprovalCount,
  pendingAskCount,
  settleRequest,
} from './session-view.js'
import type { SessionShard, SessionView, ViewItem } from './session-view.js'
import { resolveSlashInput } from './commands/dispatch.js'
import { executeCommand, type CommandContext } from './commands/handlers.js'
import { subscribeToGate } from './gate-subscription.js'

const CTRL_C_QUIT_WINDOW_MS = 2_000
const STATUS_HINT_CAP = 6
const OVERLAY_PERCENT_HEIGHT = 50

/** 退出时的 resume 提示行（对标 KimiCode 退出提示；纯函数便于断言）。 */
export const buildResumeHint = (sessionId: string): string =>
  `要恢复此会话: npx tsx cli/main.ts --resume ${sessionId}`

/**
 * memory 项 → dim 分隔行（v0.30 上下文压缩事件可见化；纯函数便于断言）：
 *   ── 🗜 上下文已压缩 · M1/M2 · {taskGoal} ──
 *   ── 📦 记忆已归档 · M3 · {taskGoal} ──
 * taskGoal 按 CJK 宽度截断到行内剩余列数（复用 markdown.ts 的宽度口径）。
 */
export const renderMemoryLine = (item: Extract<ViewItem, { kind: 'memory' }>, width: number): string => {
  const label = item.activity === 'memory.compressed' ? '🗜 上下文已压缩' : '📦 记忆已归档'
  const prefix = `── ${label} · ${item.layer}`
  const goalSep = ' · '
  const suffix = ' ──'
  // 预算 = width - 前后缀 - goal 分隔符 - 2 列 emoji 余量（🗜/📦 在 charWidth
  // 里按 1 计、实际渲染 2 列——不扣则极端情况溢出 1-2 列）。
  const goalW = Math.max(0, width - visibleWidth(prefix) - goalSep.length - visibleWidth(suffix) - 2)
  const goal = item.taskGoal === '' ? '' : `${goalSep}${truncateVisible(item.taskGoal, goalW)}`
  return `\x1b[2m${prefix}${goal}${suffix}\x1b[0m`
}

/**
 * goal 项 → dim 分隔行（v0.41 goal.changed 可见化；纯函数便于断言）。
 * 与 renderMemoryLine 同一视觉语言：`── … ──`，按 CJK 宽度截断到行内剩余列数。
 * 文案本体是 session-view.ts 的 goalEventLabel（headless 批处理摘要共用同一份，
 * 带 never 穷尽守卫——新增 GoalEvent status 会编译报错而不是静默漏渲染）。
 */
export const renderGoalLine = (item: Extract<ViewItem, { kind: 'goal' }>, width: number): string => {
  const prefix = '── '
  const suffix = ' ──'
  // emoji 在 charWidth 里按 1 计、实际渲染 2 列——留 2 列余量，同 renderMemoryLine。
  const budget = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix) - 2)
  return `\x1b[2m${prefix}${truncateVisible(goalEventLabel(item.event), budget)}${suffix}\x1b[0m`
}

/** TuiApp 构造依赖（全部注入——headless 测试可全 fake）。 */
export type TuiAppOptions = {
  io: TuiIo
  gate: SignalGate
  /** 当前工作区（权限边界；命令执行与 picker 分区依据）。 */
  workDir: string
  /** 用户退出（/quit 或 Ctrl-C×2）的落点——main 负责 stop + shutdown + exit。 */
  onQuit: () => void
  /** 帧顶 banner 行（main 填：工作区 / LLM 模式 / 快捷键提示）。 */
  bannerLines?: readonly string[]
  /** 渲染节流（测试可传 0）；缺省 TuiScreen 默认 16ms。 */
  throttleMs?: number
}

/** 浮层给 TuiScreen 的展示投影：剥掉 handleInput，输入单路走 InputRouter。 */
const displayOnly = (c: TuiComponent): TuiComponent => ({
  render: (w) => c.render(w),
  invalidate: () => c.invalidate(),
})

/** 找到挂有该 requestId 的分片（请求归属；找不到 undefined）。 */
const findRequestOwner = (view: SessionView, requestId: string): SessionShard | undefined => {
  for (const shard of view.shards.values()) {
    if (shard.pendingRequests.some((r) => r.requestId === requestId)) return shard
  }
  return undefined
}

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

export class TuiApp {
  readonly view: SessionView = createSessionView()
  readonly editor = new LineEditor()
  readonly router = new InputRouter()
  readonly screen: TuiScreen
  readonly queue = new ApprovalQueue()

  private readonly gate: SignalGate
  private readonly workDir: string
  private readonly onQuit: () => void
  private readonly bannerLines: readonly string[]
  private readonly unsubscribe: () => void
  /** 退出提示的写出点（与 TuiScreen 同一 stdout——保持注入纪律）。 */
  private readonly stdout: TuiIo['stdout']

  /** 进程内命令历史（编辑器 Up/Down 导航源；含命令行与消息行，空行不入）。 */
  private readonly history: string[] = []
  private statusLines: string[] = []
  private lastAbortAt = 0
  private quitRequested = false

  private overlayHandle: { close(): void } | null = null
  private approvalOverlay: ApprovalOverlay | undefined
  private askOverlay: AskUserOverlay | undefined
  private askOverlayRequestId: string | undefined

  private readonly root: TuiComponent = {
    render: (width) => this.renderFrame(width),
    invalidate: () => {},
    handleInput: (data) => this.router.route(data),
  }

  private readonly commandCtx: CommandContext

  constructor(opts: TuiAppOptions) {
    this.gate = opts.gate
    this.workDir = opts.workDir
    this.onQuit = opts.onQuit
    this.stdout = opts.io.stdout
    this.bannerLines = opts.bannerLines ?? []
    this.screen = new TuiScreen(
      opts.io,
      // exactOptionalPropertyTypes：throttleMs 未传时不显式写 undefined。
      opts.throttleMs !== undefined ? { throttleMs: opts.throttleMs } : {},
    )

    // 编辑器三件套：提交回调 / Ctrl-C 钩子 / 历史注入。
    this.editor.onCommit((line) => this.handleCommit(line))
    this.editor.onAbort(() => this.handleAbort())
    this.editor.setHistory(() => this.history)
    this.router.setEditor(this.editor)

    const app = this
    this.commandCtx = {
      view: this.view,
      gate: this.gate,
      get sessionId() {
        return app.view.activeSessionId
      },
      workDir: this.workDir,
      editor: this.editor,
      router: this.router,
      quit: () => this.requestQuit(),
      renderStatus: (lines) => this.setStatus(lines),
    }

    this.unsubscribe = subscribeToGate(this.gate, { apply: (sig) => this.onSignal(sig) })
  }

  // ==========================================================================
  // 生命周期
  // ==========================================================================

  /** 挂根组件 + 进 raw mode（headless 下 stdin 无 tty 自动跳过）。 */
  start(): void {
    this.screen.setRoot(this.root)
    this.screen.start()
  }

  /** 退订 gate（screen.stop / assembly.shutdown 归 main 的 onQuit 流程）。 */
  dispose(): void {
    this.unsubscribe()
  }

  // ==========================================================================
  // 信号入口（gate → 视图 → 队列/浮层 → 渲染）
  // ==========================================================================

  private onSignal(sig: GateSignal | GateRequest): void {
    viewApplySignal(this.view, sig)
    if (sig.kind === 'approval' || sig.kind === 'ask_user') {
      // 归属会话与 reducer 的落片规则一致（无 sessionId → 活跃会话）。
      const owner = findRequestOwner(this.view, sig.requestId)
      // 只把**活跃会话**（或归属不明）的请求放进 UI 队列——后台会话的请求
      // 留在各自分片里，切过去时再认领（见 onActiveSessionChanged）。
      const active = this.view.activeSessionId
      if (owner === undefined || owner.sessionId === active) {
        const last = owner?.pendingRequests[owner.pendingRequests.length - 1]
        if (last !== undefined) this.queue.enqueue(last)
      }
    }
    this.pruneQueue()
    this.maybeShowOverlay()
    this.screen.requestRender()
  }

  /** 清掉视图侧已消失（已被 /approve 等路径 settle）的队列残留。 */
  private pruneQueue(): void {
    for (const req of this.queue.snapshot) {
      if (findRequestOwner(this.view, req.requestId) === undefined) {
        // decision 参数仅审批语义，此处只做"从 UI 队列移除"。
        this.queue.settle(req.requestId, 'approved')
      }
    }
  }

  // ==========================================================================
  // 浮层（approval / ask_user / picker）挂载与退出
  // ==========================================================================

  private closeOverlayIfOpen(): void {
    if (this.overlayHandle !== null) {
      this.overlayHandle.close()
      this.overlayHandle = null
    }
    if (this.router.state !== 'editor') this.router.exitToEditor()
  }

  /** editor 态且有挂起请求时挂浮层（一次一个，队首优先）。 */
  private maybeShowOverlay(): void {
    this.pruneQueue()
    if (this.router.state !== 'editor') return
    const current = this.queue.current
    if (current === undefined) return
    const owner = findRequestOwner(this.view, current.requestId)
    // 队列只收活跃会话的请求（onSignal 保证）；归属不明也展示（请求无
    // sessionId 语义 = 活跃会话）。
    if (owner !== undefined && owner.sessionId !== this.view.activeSessionId) return

    if (current.kind === 'approval') {
      this.approvalOverlay ??= new ApprovalOverlay({
        current: () => this.queue.current,
        onDecision: (requestId, decision) => void this.decideApproval(requestId, decision),
        // 全屏参数预览（v0.29 Wave B2）：换高度 = 重挂浮层（showOverlay 内部
        // prevLines=null + requestRender，即 renderer.invalidate() 的整帧重绘
        // 效果——不建 alt-screen）。
        onExpandChange: (expanded) => this.remountApprovalOverlay(expanded),
      })
      // 换请求时复位预览态（render 里只防御复位——不在 composeFrame 内重挂）。
      this.approvalOverlay.alignRequest(current.requestId)
      this.router.enter('approval', this.approvalOverlay)
      this.overlayHandle = this.screen.showOverlay(displayOnly(this.approvalOverlay), {
        percentHeight: this.approvalOverlay.isExpanded ? 100 : OVERLAY_PERCENT_HEIGHT,
      })
    } else {
      // 新请求换 requestId 时重建（浮层渲染的是构造时注入的问题清单）。
      let overlay = this.askOverlay
      if (overlay === undefined || this.askOverlayRequestId !== current.requestId) {
        overlay = new AskUserOverlay({
          requestId: current.requestId,
          questions: current.payload.questions,
          passthrough: this.editor,
        })
        this.askOverlay = overlay
        this.askOverlayRequestId = current.requestId
      }
      this.router.enter('ask_user', overlay)
      this.overlayHandle = this.screen.showOverlay(displayOnly(overlay), {
        percentHeight: OVERLAY_PERCENT_HEIGHT,
      })
    }
    this.screen.requestRender()
  }

  /**
   * 审批浮层全屏预览态切换的重挂（v0.29 Wave B2）。只关浮层句柄、不退
   * router（approval 态保持独占键盘）；showOverlay 自带整帧重绘。
   */
  private remountApprovalOverlay(expanded: boolean): void {
    if (this.router.state !== 'approval' || this.approvalOverlay === undefined) return
    this.overlayHandle?.close()
    this.overlayHandle = this.screen.showOverlay(displayOnly(this.approvalOverlay), {
      percentHeight: expanded ? 100 : OVERLAY_PERCENT_HEIGHT,
    })
  }

  /**
   * 审批决议（浮层 y/n 落点）——与 /approve 相同的执行原语：
   * gate.command('approval.decision') + settleRequest + queue.settle，只是
   * requestId 显式来自浮层队首（executeCommand 的 /approve 分支按"活跃分片
   * 最早挂起审批"取，与队首在同一不变量下等价；这里显式传参更直读）。
   */
  private async decideApproval(requestId: string, decision: 'approved' | 'rejected'): Promise<void> {
    try {
      await this.gate.command({ kind: 'approval.decision', requestId, decision })
    } catch (cause) {
      this.setStatus([`审批应答失败: ${errorMessage(cause)}`])
    }
    const owner = findRequestOwner(this.view, requestId)
    if (owner !== undefined) settleRequest(this.view, owner.sessionId, requestId)
    this.queue.settle(requestId, decision)
    this.closeOverlayIfOpen()
    this.maybeShowOverlay() // 队列下一条自动顶上（一屏一个）
    this.screen.requestRender()
  }

  // ==========================================================================
  // Enter 提交管线（计划 §4.6）
  // ==========================================================================

  private handleCommit(line: string): void {
    if (line.trim() !== '') this.history.push(line)
    void this.dispatchCommit(line)
  }

  private async dispatchCommit(line: string): Promise<void> {
    // ask_user 浮层态：提交行 = 提问答案（计划 §3.3——浮层态不收命令输入）。
    if (this.router.state === 'ask_user') {
      await this.answerAskUser(line)
      this.screen.requestRender()
      return
    }

    const idle = this.computeIdle()
    const intent = resolveSlashInput(line, idle)
    switch (intent.kind) {
      case 'blocked':
        // KimiCode restoreInputText 细节：输入文本还原，命令文本不产生任何副作用。
        this.editor.setLine(line)
        this.setStatus([`回合进行中，/${intent.name} 已被搁置（回合结束后重试）`])
        break
      case 'builtin': {
        if (intent.name === 'sessions') {
          // Wave 5：/sessions 升级为 picker 浮层（registry 的 always 语义不变）。
          await this.openPicker()
          break
        }
        await executeCommand(intent.name, intent.args, this.commandCtx)
        this.pruneQueue()
        break
      }
      case 'message': {
        if (intent.text === '') break // 空行提交忽略（编辑器契约：Enter 恒触发）
        this.sendMessage(intent.text)
        break
      }
    }
    this.screen.requestRender()
  }

  /** 计划 §4.6：idle = 阶段空闲 && 无挂起审批 && 无挂起提问。 */
  private computeIdle(): boolean {
    const shard = activeShard(this.view)
    return (
      (shard === undefined || shard.phase === 'idle') &&
      pendingApprovalCount(this.view) === 0 &&
      pendingAskCount(this.view) === 0
    )
  }

  private sendMessage(text: string): void {
    const sessionId = this.view.activeSessionId
    if (sessionId === undefined) {
      this.setStatus(['没有活跃会话 — /new 创建或 /resume 恢复'])
      return
    }
    // 协议层没有 user.message 出站信号（v0.22 已知局限）——本地投影是唯一入口。
    appendUserMessage(this.view, sessionId, text)
    // v0.34 C1 / D9：本会话已有回合在途时，gate 会**排队**而不是丢弃（用户拍板
    // 方案 A——排队的是用户自己的消息，吞了不合适）。所以这里不拦、不挡，
    // 只在回执告诉我们是排队时如实告知排队位置。
    this.gate
      .command({ kind: 'user.prompt', sessionId, text })
      .then((receipt: unknown) => {
        if (isQueuedPromptReceipt(receipt)) {
          this.setStatus([`已排队（第 ${receipt.position} 位）— 当前回合结束后自动执行`])
          this.screen.requestRender()
        }
      })
      .catch((cause: unknown) => this.setStatus([`发送失败: ${errorMessage(cause)}`]))
  }

  /** ask_user 浮层态的提交行 → ask_user.answer（序号选择或自由文本，见 resolveAskUserLine）。 */
  private async answerAskUser(line: string): Promise<void> {
    const current = this.queue.current
    if (current === undefined || current.kind !== 'ask_user') {
      this.closeOverlayIfOpen()
      return
    }
    const answer = resolveAskUserLine(line, current.payload.questions)
    try {
      await this.gate.command({ kind: 'ask_user.answer', requestId: current.requestId, answers: [answer] })
    } catch (cause) {
      this.setStatus([`回答提交失败: ${errorMessage(cause)}`])
    }
    const owner = findRequestOwner(this.view, current.requestId)
    if (owner !== undefined) settleRequest(this.view, owner.sessionId, current.requestId)
    this.queue.settle(current.requestId, 'approved') // decision 参数无语义（非审批）
    this.closeOverlayIfOpen()
    this.maybeShowOverlay()
  }

  // ==========================================================================
  // Ctrl-C（选定语义，见文件头注释 5）
  // ==========================================================================

  private handleAbort(): void {
    const shard = activeShard(this.view)
    if (shard !== undefined && shard.phase === 'streaming') {
      this.gate
        .command({ kind: 'turn.cancel', sessionId: shard.sessionId })
        .then(() => this.setStatus(['已请求取消在途回合']))
        .catch((cause: unknown) => this.setStatus([`取消失败: ${errorMessage(cause)}`]))
      this.screen.requestRender()
      return
    }
    const now = Date.now()
    if (now - this.lastAbortAt <= CTRL_C_QUIT_WINDOW_MS) {
      this.requestQuit()
      return
    }
    this.lastAbortAt = now
    this.setStatus(['再按一次 Ctrl-C 退出（或输入 /quit）'])
    this.screen.requestRender()
  }

  private requestQuit(): void {
    if (this.quitRequested) return
    this.quitRequested = true
    this.scheduleResumeHint()
    this.onQuit()
  }

  /**
   * 退出 resume 提示（对标 KimiCode）：若有活跃会话，在 screen.stop 之后、
   * 进程退出之前打印一行恢复命令。时序依据：main 的 onQuit 同步段先执行
   * app.dispose + screen.stop，再 await 异步收尾——setImmediate 回调必然
   * 落在 TUI 拆卸之后；process.exit 在 await 之后才调用，提示必然先落盘。
   */
  private scheduleResumeHint(): void {
    const id = this.view.activeSessionId
    if (id === undefined) return
    setImmediate(() => {
      this.stdout.write(`${buildResumeHint(id)}\n`)
    })
  }

  // ==========================================================================
  // 会话切换（picker / main 启动路径共用）
  // ==========================================================================

  /** 活跃会话变化后的 UI 收尾：清 UI 队列 → 认领新会话的挂起请求 → 重挂浮层。 */
  private onActiveSessionChanged(): void {
    this.closeOverlayIfOpen()
    this.queue.cancelAll() // 只清本地 UI 队列；host 侧 300s 超时兜底（文件头注释）
    const shard = activeShard(this.view)
    if (shard !== undefined) {
      for (const req of shard.pendingRequests) this.queue.enqueue(req)
    }
    this.maybeShowOverlay()
    this.screen.requestRender()
  }

  /** /sessions → picker 浮层（清单经 gate 预取；浮层态挂载失败静默退回）。 */
  async openPicker(): Promise<void> {
    if (this.router.state !== 'editor') return
    let infos: readonly SessionInfo[]
    try {
      infos = (await this.gate.command({ kind: 'session.list' })) as readonly SessionInfo[]
    } catch (cause) {
      this.setStatus([`/sessions 失败: ${errorMessage(cause)}`])
      this.screen.requestRender()
      return
    }
    if (this.router.state !== 'editor') return // 等待清单期间来了请求 → 让位浮层
    const picker = new SessionPickerOverlay({
      entries: infos,
      workDir: this.workDir,
      // Wave A：活跃会话标记（ '*' 行标注）。
      ...(this.view.activeSessionId !== undefined
        ? { activeSessionId: this.view.activeSessionId }
        : {}),
      onPick: (info) => void this.pickSession(info.id),
      onForeignPick: (info) => {
        this.closeOverlayIfOpen()
        this.setStatus([`该会话属于其他工作区：cd ${info.workDir ?? '（未指定）'} 后用 /resume ${info.id}`])
        this.screen.requestRender()
      },
      onCancel: () => {
        this.closeOverlayIfOpen()
        this.screen.requestRender()
      },
    })
    this.router.enter('picker', picker)
    this.overlayHandle = this.screen.showOverlay(displayOnly(picker), { percentHeight: 60 })
    this.screen.requestRender()
  }

  /** picker 选中（当前工作区会话）→ 复用 /resume 执行路径（open+history+hydrate）。 */
  private async pickSession(id: string): Promise<void> {
    await executeCommand('resume', id, this.commandCtx)
    this.afterSessionCommand()
  }

  /** main 启动路径：开新会话（/new 执行路径：session.create + hydrate 空历史）。 */
  async startNewSession(): Promise<void> {
    await executeCommand('new', '', this.commandCtx)
    this.afterSessionCommand()
  }

  /** main 启动路径：按 id 恢复（/resume 执行路径，G5 workDir 校验内置）。 */
  async resumeSession(id: string): Promise<void> {
    await executeCommand('resume', id, this.commandCtx)
    this.afterSessionCommand()
  }

  /** executeCommand 之后统一收尾：队列同步 + 活跃会话变化检测。 */
  private afterSessionCommand(): void {
    this.pruneQueue()
    this.onActiveSessionChanged()
  }

  // ==========================================================================
  // 渲染
  // ==========================================================================

  private setStatus(lines: string[]): void {
    this.statusLines = lines
    this.screen.requestRender()
  }

  /** 完整帧（根组件与测试共用的同一函数——一条渲染路径）。 */
  renderFrame(width: number): string[] {
    const lines: string[] = []
    for (const banner of this.bannerLines) lines.push(banner)

    const shard = activeShard(this.view)
    if (shard === undefined) {
      lines.push('（没有活跃会话 — /new 创建或 /resume 恢复）')
    } else {
      this.renderItems(shard, width, lines)
    }

    lines.push('')
    for (const hint of this.statusLines.slice(-STATUS_HINT_CAP)) lines.push(hint)
    lines.push(this.statusBar())
    const lastLog = this.view.recentLogs[this.view.recentLogs.length - 1]
    if (lastLog !== undefined) lines.push(`\x1b[2m· ${lastLog.msg}\x1b[0m`)
    lines.push(...this.editor.render(width))
    return lines
  }

  /**
   * 会话条目 → 帧行。渲染口径（文件头注释 2 的展开）：
   *   - user：'❯ ' 前缀 + 宽度换行（续行两格缩进）。
   *   - assistant：markdown 缩水渲染；thinking 缓冲**永不**渲染为正文，仅在
   *     流式且正文为空时显示占位（'…（思考中）' / '…'）。
   *   - tool：一行一枚——状态图标（⋯ 运行中 / ✓ 成功 / ✗ 失败）+ 工具名 +
   *     产物路径（成功 write/edit/search_replace 的 args.path）。
   *   - memory：dim 分隔行（上下文压缩 / M3 归档事件的可见化，live-only）。
   */
  private renderItems(shard: SessionShard, width: number, lines: string[]): void {
    for (const item of shard.items) {
      if (item.kind === 'user') {
        const wrapped = wrapText(item.text, Math.max(4, width - 2))
        lines.push(`❯ ${wrapped[0] ?? ''}`)
        for (const cont of wrapped.slice(1)) lines.push(`  ${cont}`)
      } else if (item.kind === 'assistant') {
        if (item.streaming && item.text === '') {
          lines.push(item.thinking === '' ? '…' : '…（思考中）')
        } else {
          lines.push(...renderMarkdownToLines(item.text, width))
        }
      } else if (item.kind === 'memory') {
        lines.push(renderMemoryLine(item, width))
      } else if (item.kind === 'goal') {
        lines.push(renderGoalLine(item, width))
      } else {
        const icon = item.status === 'running' ? '⋯' : item.status === 'success' ? '✓' : '✗'
        const loc = item.producedPath !== undefined ? ` → ${item.producedPath}` : ''
        lines.push(`  ${icon} ${item.toolName}${loc}${item.status === 'failure' ? '（失败）' : ''}`)
      }
    }
  }

  private statusBar(): string {
    const shard = activeShard(this.view)
    const parts: string[] = [shard === undefined ? '无会话' : `会话 ${shard.sessionId.slice(0, 8)}`]
    parts.push(shard?.phase === 'streaming' ? '回合进行中' : '空闲')
    // v0.34 C1 / D9：排队条数常驻可见——用户的消息在等着执行，不能只在发送那
    // 一刻提示一次就消失。清零时机：turn.end 递减，或在 /stop 取消时整体丢弃。
    if (shard !== undefined && shard.queuedCount > 0) parts.push(`排队 ${shard.queuedCount}`)
    // v0.41：goal 激活指示——轮次进度常驻状态栏（详细状态经 /goal status）。
    if (shard !== undefined && shard.goal !== undefined) {
      parts.push(`🎯 ${shard.goal.roundsUsed}/${shard.goal.maxRounds}`)
    }
    if (shard !== undefined && shard.stats.turnEnds > 0) {
      parts.push(`回合 ${shard.stats.turnEnds}`)
    }
    // Wave B1：token 上下文指示。装配层/ShellConfig 没有暴露 context 上限
    // 字段——不伪造百分比，只显示累计 token（turn.end 累积口径，tok N）。
    if (shard !== undefined) parts.push(`tok ${shard.stats.totalTokens}`)
    const approvals = pendingApprovalCount(this.view)
    const asks = pendingAskCount(this.view)
    if (approvals > 0) parts.push(`待审批 ${approvals}`)
    if (asks > 0) parts.push(`待提问 ${asks}`)
    // v0.29: 关闭按钮提示——终端不设 per-run 时间上限，用户主动关闭。
    parts.push('[q] 关闭')
    return `[${parts.join(' · ')}]`
  }
}
