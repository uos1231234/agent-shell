// v0.21 Signal Gate — createSignalGate 实现（类型见 types.ts）。
//
//   - emit/on：kind 过滤的同步广播；订阅者 throw 被吞掉并 warn（跟随
//     Databus.append / RenderingSignalBus.emit 的先例——单个订阅者故障
//     不中断广播，也不中断其他订阅者）。
//   - request/resolve：request 生成 requestId → 同步广播完整 GateRequest
//     → 挂起 promise；resolve 收到回包后落地。超时（默认 300s）fail-closed：
//     reject + 清理挂起表；迟到回包静默忽略（预期时序，非异常）。
//   - command：按 cmd.kind 路由到宿主注入的 handlers。approval.decision /
//     ask_user.answer 是请求回包的命令形态——路由进 resolve；ask_user.answer
//     组装成 request_user_input.ts 消费契约的 { answers, cancelled? } 形状。
//   - snapshot：只报告 gate 自己拥有的状态（见 GateSnapshot 注释）。
//
// v0.34 C1（用户拍板 2026-09-10）：gate 的定位由「纯路由」升级为
// 「纯路由 + 会话级并发控制」。理由：gate 是唯一的前后端中转站，所有前端
// （CLI / webapp / headless）都从它过——并发防线放在这里，一处设防全端受益，
// 不必在每条产线各补一份守卫。串行化只作用于**同一会话内部**，跨会话仍并行。
// 见 session-queue.ts 与 command() 的 user.prompt / turn.cancel 分支。

import { randomUUID } from 'node:crypto'

import { createSessionQueue } from './session-queue.js'
import type { QueuedPromptReceipt } from './session-queue.js'
import { createChunkMode } from './chunk-mode.js'
import { splitChunk, DEFAULT_CHUNK_TOKENS } from './chunk.js'
import type { IMLoopResult } from '../im/loop.js'
import type {
  GateCommand,
  GateRequest,
  GateRequestInput,
  GateSignal,
  GateSnapshot,
  GateSubscriptionKind,
  GateSubscriber,
  SignalGate,
  SignalGateHandlers,
} from './types.js'

/** 请求超时默认值：300s fail-closed（与 approval-hook 的 300s 超时语义对齐）。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000

export type SignalGateOptions = {
  /** request() 的默认超时 ms。默认 300_000。 */
  requestTimeoutMs?: number | undefined
  handlers: SignalGateHandlers
}

type PendingRequest = {
  resolve: (payload: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export const createSignalGate = (opts: SignalGateOptions): SignalGate => {
  const handlers = opts.handlers
  const defaultTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  // kind → 订阅回调列表。'*' 是通配 kind（前端桥转发全量信号用）。
  const subscribers = new Map<GateSubscriptionKind, GateSubscriber[]>()
  // requestId → 挂起的 promise 落点 + 超时定时器。
  const pending = new Map<string, PendingRequest>()
  // emit/command 流中观察到的 sessionId 集合（"活跃 session"的诚实近似）。
  const sessions = new Set<string>()
  let emitted = 0

  // v0.34 C1（用户拍板 2026-09-10）：会话级回合串行化。放在 gate 是因为它是唯一的
  // 前后端中转站——所有前端（CLI / webapp / headless）都从它过，一处设防全端受益。
  // 语义：同会话第二条 user.prompt 排队不丢弃（D2）；取消丢掉排队中的、在途不受影响
  // （D3）；排队发 turn.queue 让前端看得见（D9）。见 session-queue.ts 的语义说明。
  const queue = createSessionQueue()

  // v0.42 大输入切块（用户拍板 2026-09-15）：会话级切块模式状态。与 queue 同级
  // 挂在 gate——切块是大输入上传的前方基础，一处设防全端受益（v0.34 C1 先例）。
  const chunkMode = createChunkMode()

  /**
   * 广播该会话的**权威**排队条数（D9：排队必须前端可见）。
   * 入队 / 出队 / 取消丢弃 / 会话关闭都会发一条——前端只镜像 pending，不自己推算，
   * 因此不会因为漏掉某条状态转移而显示错误（例如取消后仍显示"排队中"）。
   */
  const emitQueueState = (sessionId: string): void => {
    emit({ kind: 'turn.queue', sessionId, pending: queue.pending(sessionId) })
  }

  /**
   * 启动一个回合。**失败路径必须补推进**：宿主装配层只在成功后 emit turn.end
   * （见 assembly.ts 的 runPrompt handler），失败路径没有任何信号——不补的话会话
   * 永久卡在 busy，后续消息全部排队且永不执行。
   */
  const startTurn = (sessionId: string, text: string, warnOnFailure = false): Promise<IMLoopResult> => {
    const p = handlers.runPrompt(sessionId, text)
    void p.catch((e: unknown) => {
      if (warnOnFailure) {
        // 出队回合没有调用方在等，无人上报——这里必须自己留痕。
        console.warn('[signal-gate] queued prompt failed', {
          sessionId,
          err: e instanceof Error ? e.message : String(e),
        })
      }
      advanceQueue(sessionId)
    })
    return p
  }

  /**
   * 回合结束后推进该会话的队列：有排队就接着跑下一条，没有就解除 busy。
   *
   * 触发来源：
   *   1. `emit` 拦截到 `turn.end` —— 正常收尾路径
   *   2. `startTurn` 的失败分支 —— 该路径没有 turn.end
   */
  const advanceQueue = (sessionId: string): void => {
    const next = queue.finish(sessionId)
    emitQueueState(sessionId)
    if (next === undefined) return
    // 出队的回合由 gate 自己驱动；它完成时会再 emit turn.end → 再出队（链式）。
    // 调用方的 command() 早已返回（带 queued 回执），故此处无人 await。
    void startTurn(sessionId, next, true)
  }

  /**
   * v0.42 切块模式下的 user.prompt：把超长输入切成 N 个分卷，全部压入该会话
   * 队列串行执行。复用 SessionQueue 的串行 / 前端可见 / turn.cancel 丢队列语义
   * ——唯一区别是"对首也入队"：对首入队后由返回的 `next` 启动，其余分卷由
   * advanceQueue 链式驱动。
   *
   * 返回 `{ next: string, chunks: number }`：next 是第一个分卷（调用方 startTurn），
   * chunks 是总分卷数（调用方据此回执前端）。
   */
  const enqueueChunks = (sessionId: string, parts: string[]): { next: string; chunks: number } => {
    // 只复用 queue 的"占用字段"：第一个 begin 标记 busy，后续标记排队。
    // 不直接扔进 SessionQueue.begin 的 run 语义（它不会自己启动），我们手动
    // 启动第一个，链式由 advanceQueue 接续。
    let next = ''
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!
      const outcome = queue.begin(sessionId, part)
      if (i === 0) next = part
      // 后续的 begin 因为会话已 busy 全部返回 queued——对首虽返回 run（busy）
      // 但不自动执行，由调用方手动 start。
    }
    emitQueueState(sessionId)
    return { next, chunks: parts.length }
  }

  const countSubscribers = (): number => {
    let n = 0
    for (const list of subscribers.values()) n += list.length
    return n
  }

  /** 同步广播；先精确 kind 再 '*'，订阅者 throw 被吞掉（不中断广播）。 */
  const dispatch = (sig: GateSignal | GateRequest): void => {
    // GateRequest 的 sessionId 可选（审批 handler 跨会话共享，wiring 尽力标注）。
    if ('sessionId' in sig && typeof sig.sessionId === 'string') sessions.add(sig.sessionId)
    const targets = [...(subscribers.get(sig.kind) ?? []), ...(subscribers.get('*') ?? [])]
    for (const cb of targets) {
      try {
        cb(sig)
      } catch (e) {
        console.warn('[signal-gate] subscriber threw', {
          kind: sig.kind,
          err: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }

  const emit = (sig: GateSignal): void => {
    emitted++
    dispatch(sig)
    // v0.34 C1：turn.end 是出队时机——回合已彻底结束，可以跑下一条。
    // 放在 dispatch 之后：订阅者先看到本回合 turn.end，再被下一条回合的
    // delta 信号接续（避免前端在 turn 未收尾时就收到新 turn 的内容）。
    if (sig.kind === 'turn.end') advanceQueue(sig.sessionId)
  }

  const on = (kind: GateSubscriptionKind, cb: GateSubscriber): (() => void) => {
    const list = subscribers.get(kind) ?? []
    list.push(cb)
    subscribers.set(kind, list)
    return () => {
      const cur = subscribers.get(kind)
      if (cur === undefined) return
      const idx = cur.indexOf(cb)
      if (idx >= 0) cur.splice(idx, 1)
    }
  }

  const request = (input: GateRequestInput, reqOpts?: { timeoutMs?: number | undefined }): Promise<unknown> => {
    const requestId = `req-${randomUUID()}`
    const timeoutMs = reqOpts?.timeoutMs ?? defaultTimeoutMs
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`Signal gate request "${input.kind}" (${requestId}) timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      pending.set(requestId, { resolve, reject, timer })
      // 广播完整 GateRequest（含 requestId）；前端据此弹出审批/提问 UI，
      // 再通过 command('approval.decision' / 'ask_user.answer') 回包。
      dispatch({ ...input, requestId })
    })
  }

  const resolve = (requestId: string, payload: unknown): void => {
    const p = pending.get(requestId)
    if (p === undefined) return
    clearTimeout(p.timer)
    pending.delete(requestId)
    p.resolve(payload)
  }

  const command = async (cmd: GateCommand): Promise<unknown> => {
    switch (cmd.kind) {
      case 'user.prompt': {
        sessions.add(cmd.sessionId)
        // v0.42：切块模式已启用则把大输入切成多卷入队串行，否则走原并发控制。
        const chunkTokens = chunkMode.tokensOf(cmd.sessionId)
        if (chunkTokens !== undefined && cmd.text.length > chunkTokens) {
          const parts = splitChunk(cmd.text, chunkTokens)
          const { next } = enqueueChunks(cmd.sessionId, parts)
          // 对首分卷直接启动；其余分卷由 turn.end → advanceQueue 链式驱动。
          // 回执告诉前端"这次被切成了几卷"（前端据此显示"已切分 N 卷"）。
          await startTurn(cmd.sessionId, next)
          return { chunked: true, chunks: parts.length }
        }
        // v0.34 C1：同会话串行。空闲 → 立即执行；在途 → 排队（不丢弃、不顶替）。
        const outcome = queue.begin(cmd.sessionId, cmd.text)
        if (outcome.kind === 'queued') {
          // D9（用户拍板）：排队的是用户自己的消息，必须让前端看得见。
          emitQueueState(cmd.sessionId)
          // 决策 A：回执自带排队信息，前端不必等 WS 往返即可显示"已排队（第 n 位）"。
          // HTTP 层（webshell/server.ts）会再包一层 `{ ok: true, result }`——`ok`
          // 由信封承担，故此处不重复；CLI 直连 gate，拿到的是本对象。
          const receipt: QueuedPromptReceipt = { queued: true, position: outcome.position }
          return receipt
        }
        return startTurn(cmd.sessionId, cmd.text)
      }
      case 'session.create':
        // sessionId 由 SessionManager mint，gate 无从观察，不进 sessions。
        return handlers.session.create(cmd.payload)
      case 'session.open':
        sessions.add(cmd.sessionId)
        return handlers.session.open(cmd.sessionId)
      case 'session.close':
        queue.forget(cmd.sessionId)
        chunkMode.forget(cmd.sessionId)
        // 顺序要紧：emitQueueState 经 dispatch 会把 sessionId 记入 sessions（"观察即
        // 计入"），必须**先发再删**——否则刚关闭的会话会被自己的队列信号复活进观察集合。
        emitQueueState(cmd.sessionId)
        sessions.delete(cmd.sessionId)
        return handlers.session.close(cmd.sessionId)
      case 'session.delete':
        queue.forget(cmd.sessionId)
        chunkMode.forget(cmd.sessionId)
        emitQueueState(cmd.sessionId)
        sessions.delete(cmd.sessionId)
        return handlers.session.delete(cmd.sessionId)
      case 'session.list':
        return handlers.session.list()
      case 'session.history':
        sessions.add(cmd.sessionId)
        return handlers.session.history(cmd.sessionId)
      case 'session.rename': {
        // v0.26 Wave A（/title）：校验与落盘都在宿主 handler（session.json），
        // gate 纯路由。无出站信号——改名后调用方按需重新 session.list。
        if (handlers.session.rename === undefined) {
          throw new Error('Signal gate: command "session.rename" requires a session.rename handler')
        }
        sessions.add(cmd.sessionId)
        return handlers.session.rename(cmd.sessionId, cmd.title)
      }
      // 【session.compact 已注释下线（用户拍板 2026-09-08）】/compact 旁路
      // 与未来双压缩模式（标准 harness / 自研，同时间只启用一种）冲突。
      // 恢复时连同 types.ts 的契约成员、drive-coordinator 的 compactNow
      // 一起（实现备查于 git 历史与下方注释）。
      // case 'session.compact': {
      //   if (handlers.session.compact === undefined) {
      //     throw new Error('Signal gate: command "session.compact" requires a session.compact handler')
      //   }
      //   sessions.add(cmd.sessionId)
      //   return handlers.session.compact(cmd.sessionId)
      // }
      case 'session.fork': {
        // v0.29 Wave B2（/fork）：会话分叉（不切换）。复制与落盘在宿主 handler
        // （session-manager.forkSession）；gate 纯路由，返回新 SessionInfo。
        // fork 的 id 由 SessionManager mint，gate 无从观察，不进 sessions。
        if (handlers.session.fork === undefined) {
          throw new Error('Signal gate: command "session.fork" requires a session.fork handler')
        }
        sessions.add(cmd.sessionId)
        return handlers.session.fork(cmd.sessionId)
      }
      case 'session.undo': {
        // v0.29 Wave B2（/undo）：撤回最近 N 个任务块。范围校验（1≤N≤10）、
        // 压缩归档守卫、evict + journal 重写都在宿主 handler；gate 纯路由。
        if (handlers.session.undo === undefined) {
          throw new Error('Signal gate: command "session.undo" requires a session.undo handler')
        }
        sessions.add(cmd.sessionId)
        return handlers.session.undo(cmd.sessionId, cmd.blocks)
      }
      case 'session.rewind': {
        // v0.36（/rewind）：把 AI 改过的**文件**还原到改动之前。范围校验
        // （1≤entries≤50）、快照索引读取与还原都在宿主 handler（快照层见
        // im/tools/file-history.ts）。与 session.undo 正交——那个撤对话，这个
        // 撤文件——所以两条命令各自独立，不互相调用。gate 纯路由。
        if (handlers.session.rewind === undefined) {
          throw new Error('Signal gate: command "session.rewind" requires a session.rewind handler')
        }
        sessions.add(cmd.sessionId)
        return handlers.session.rewind(cmd.sessionId, cmd.entries)
      }
      case 'turn.cancel':
        sessions.add(cmd.sessionId)
        // v0.34 C1 / D3（用户拍板）：取消 = 用户意图是停——丢掉该会话排队中的消息。
        // **在途回合不动**：abort 是协作式的，它会以正常终止路径收尾并发 turn.end，
        // 届时 advanceQueue 才解除 busy（若这里连 busy 一起清，被取消的回合还在收尾
        // 时新消息就能启动，同会话又跑起两个回合）。
        queue.dropPending(cmd.sessionId)
        // 被丢掉的条数必须让前端知道（否则 UI 会一直显示"排队中"等待永不发生的执行）。
        emitQueueState(cmd.sessionId)
        handlers.cancel(cmd.sessionId)
        return undefined
      case 'approval.decision':
        resolve(cmd.requestId, cmd.decision)
        return undefined
      case 'ask_user.answer': {
        // 组装成 request_user_input.ts 消费契约的形状 { answers, cancelled? }。
        const payload = cmd.cancelled === true
          ? { answers: [], cancelled: true }
          : { answers: cmd.answers }
        resolve(cmd.requestId, payload)
        return undefined
      }
      case 'permission.full':
        // per-session 权限（用户拍板 2026-09-07：全局广播已删除）。路由只到
        // 目标会话；permission.changed 推送由宿主 handler 在生效后 emit
        //（信号由状态持有者产生，gate 保持纯路由）。
        sessions.add(cmd.sessionId)
        handlers.setFullPermission(cmd.sessionId, cmd.enabled)
        return undefined
      case 'artifact.get': {
        if (handlers.getArtifact === undefined) {
          throw new Error('Signal gate: command "artifact.get" requires a getArtifact handler')
        }
        return handlers.getArtifact(cmd.artifactId)
      }
      case 'workspace.read': {
        // v0.24: 前端内嵌只读查看器。文件读取与目录列举都在宿主侧执行
        // （工作区是权限边界，包含性检查在宿主 handler 内完成）。
        if (handlers.readWorkspaceFile === undefined) {
          throw new Error('Signal gate: command "workspace.read" requires a readWorkspaceFile handler')
        }
        return handlers.readWorkspaceFile(cmd.sessionId, cmd.path)
      }
      case 'provider.list':
      case 'provider.upsert':
      case 'provider.delete':
      case 'provider.activate':
      case 'provider.select': {
        // v0.23 设置菜单：providers.json 读写，文件操作在宿主 handlers.provider。
        if (handlers.provider === undefined) {
          throw new Error(`Signal gate: command "${cmd.kind}" requires a provider handler`)
        }
        switch (cmd.kind) {
          case 'provider.list':
            return handlers.provider.list()
          case 'provider.upsert':
            return handlers.provider.upsert(cmd.name, cmd.provider)
          case 'provider.delete':
            return handlers.provider.delete(cmd.name)
          case 'provider.activate':
            return handlers.provider.activate(cmd.name)
          case 'provider.select':
            // v0.32：模型/档位选择（写路径校验在 config/write.ts）。
            return handlers.provider.select({
              ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
              ...(cmd.model !== undefined ? { model: cmd.model } : {}),
              ...(cmd.effort !== undefined ? { effort: cmd.effort } : {}),
            })
        }
      }
      case 'wiki.listCards':
      case 'wiki.addCard':
      case 'wiki.renderCard':
      case 'wiki.generate': {
        // v0.33b 知识卡片面板：数据面在宿主侧全局单库 wiki 子进程，gate 纯路由。
        if (handlers.wiki === undefined) {
          throw new Error(`Signal gate: command "${cmd.kind}" requires a wiki handler`)
        }
        switch (cmd.kind) {
          case 'wiki.listCards':
            return handlers.wiki.listCards()
          case 'wiki.addCard':
            return handlers.wiki.addCard(cmd.card)
          case 'wiki.renderCard':
            return handlers.wiki.renderCard(cmd.cardId)
          case 'wiki.generate':
            return handlers.wiki.generate(cmd.workDir)
        }
      }
      case 'goal.set':
      case 'goal.clear':
      case 'goal.get': {
        // v0.41 goal 模式：状态持有者是宿主的 per-session GoalSessionState，
        // gate 纯路由（permission.full → permission.changed 同模式：谁持有状态
        // 谁发信号，gate 不伪造同步假象）。
        if (handlers.goal === undefined) {
          throw new Error(`Signal gate: command "${cmd.kind}" requires a goal handler`)
        }
        switch (cmd.kind) {
          case 'goal.set':
            // v0.41 后续补丁：切块与 goal 互斥——切块把大文本拆成多个独立回合，
            // goal 假设一个 prompt = 一个完整任务；同时启用时 judge 只看 chunk1，
            // chunk2+ 被阻塞直到 goal 完成，语义矛盾。用户拍板 2026-09-15：互斥。
            if (chunkMode.isEnabled(cmd.sessionId)) {
              throw new Error('Signal gate: goal.set rejected — chunking is enabled for this session (goal and chunking are mutually exclusive)')
            }
            // maxRounds 可选：缺省时宿主用 DEFAULT_GOAL_MAX_ROUNDS（事实源在
            // src/im/goal/types.ts，宿主不得改写语义——铁律"不准因为前端动后端"）。
            return cmd.maxRounds !== undefined
              ? handlers.goal.set(cmd.sessionId, cmd.condition, cmd.maxRounds)
              : handlers.goal.set(cmd.sessionId, cmd.condition)
          case 'goal.clear':
            return handlers.goal.clear(cmd.sessionId)
          case 'goal.get':
            return handlers.goal.get(cmd.sessionId)
        }
      }
      case 'workflow.enable':
      case 'workflow.disable':
      case 'workflow.status':
      case 'workflow.baseline': {
        if (handlers.workflow === undefined) {
          throw new Error(`Signal gate: command "${cmd.kind}" requires a workflow handler`)
        }
        sessions.add(cmd.sessionId)
        switch (cmd.kind) {
          case 'workflow.enable':
            return handlers.workflow.enable(cmd.sessionId)
          case 'workflow.disable':
            return handlers.workflow.disable(cmd.sessionId)
          case 'workflow.status':
            return handlers.workflow.status(cmd.sessionId)
          case 'workflow.baseline':
            return handlers.workflow.baseline(cmd.sessionId)
        }
      }
      case 'chunk.set':
      case 'chunk.get': {
        // v0.42 大输入切块：状态持在 gate 自身（chunk-mode.ts），不依赖宿主
        // handler——纯路由分支的例外，与 queue（session-queue.ts）同级内联。
        switch (cmd.kind) {
          case 'chunk.set': {
            // v0.41 后续补丁：切块与 goal 互斥（同上）。启用切块时检查 goal 是否激活。
            if (cmd.enabled && handlers.goal !== undefined) {
              const goalState = await handlers.goal.get(cmd.sessionId)
              if (goalState !== undefined) {
                throw new Error('Signal gate: chunk.set rejected — goal mode is active for this session (goal and chunking are mutually exclusive)')
              }
            }
            const wasEnabled = chunkMode.isEnabled(cmd.sessionId)
            if (cmd.enabled) {
              chunkMode.enable(cmd.sessionId, cmd.chunkTokens)
            } else {
              chunkMode.disable(cmd.sessionId)
            }
            sessions.add(cmd.sessionId)
            emit({
              kind: 'chunk.changed',
              sessionId: cmd.sessionId,
              enabled: cmd.enabled,
              ...(cmd.enabled ? { chunkTokens: cmd.chunkTokens ?? DEFAULT_CHUNK_TOKENS } : {}),
            })
            return { enabled: cmd.enabled, changed: wasEnabled !== cmd.enabled }
          }
          case 'chunk.get': {
            const t = chunkMode.tokensOf(cmd.sessionId)
            return { enabled: t !== undefined, chunkTokens: t }
          }
        }
      }
      case 'mcp.list':
      case 'mcp.upsert':
      case 'mcp.delete': {
        // v0.25 设置面板：mcp.json 读写，文件操作在宿主 handlers.mcp；
        // mcp.upsert 的 server 原样透传（校验在宿主的 validateMcpServerConfig）。
        if (handlers.mcp === undefined) {
          throw new Error(`Signal gate: command "${cmd.kind}" requires a mcp handler`)
        }
        switch (cmd.kind) {
          case 'mcp.list':
            return handlers.mcp.list()
          case 'mcp.upsert':
            return handlers.mcp.upsert(cmd.server)
          case 'mcp.delete':
            return handlers.mcp.delete(cmd.name)
        }
      }
      case 'subagent.list':
      case 'subagent.upsert':
      case 'subagent.delete': {
        // v0.25 设置面板：~/.databus/agents/*.json 读写，校验与落盘在宿主侧。
        if (handlers.subagent === undefined) {
          throw new Error(`Signal gate: command "${cmd.kind}" requires a subagent handler`)
        }
        switch (cmd.kind) {
          case 'subagent.list':
            return handlers.subagent.list()
          case 'subagent.upsert':
            return handlers.subagent.upsert(cmd.agent)
          case 'subagent.delete':
            return handlers.subagent.delete(cmd.name)
        }
      }
      case 'settings.get':
      case 'settings.set': {
        // v0.25 设置面板：~/.databus/settings.json 读写（子代理向下开关在此，
        // 不单设 nesting 命令——一个文件一个命令对）。
        if (handlers.settings === undefined) {
          throw new Error(`Signal gate: command "${cmd.kind}" requires a settings handler`)
        }
        switch (cmd.kind) {
          case 'settings.get':
            return handlers.settings.get()
          case 'settings.set':
            return handlers.settings.set(cmd.patch)
        }
      }
      case 'extensions.info': {
        // v0.25 设置面板：宿主启动期已装配的扩展清单（只读快照）。
        if (handlers.extensions === undefined) {
          throw new Error('Signal gate: command "extensions.info" requires an extensions handler')
        }
        return handlers.extensions.info()
      }
      default: {
        // 穷尽性守卫：新增 GateCommand kind 而未路由时，编译期在此报错。
        const _exhaustive: never = cmd
        throw new Error(`Signal gate: unknown command ${JSON.stringify(_exhaustive)}`)
      }
    }
  }

  const snapshot = (): GateSnapshot => ({
    sessions: [...sessions].sort(),
    pendingRequests: pending.size,
    subscribers: countSubscribers(),
    emitted,
  })

  return { emit, on, request, resolve, command, snapshot }
}
