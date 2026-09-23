// session-queue.ts — v0.34 C1：会话级回合串行化器。
//
// 用户拍板（2026-09-10）：并发防线坐在 **Signal Gate 层**——gate 是唯一的前后端
// 中转站，所有前端（CLI / webapp / headless）都从它过，在这里串行化可一口气解决
// 所有前端对同一会话的并发问题。
//
// 语义（用户拍板 2026-09-10，方案 A 排队）：
//   - 同会话第二条 user.prompt **不丢弃、不顶替**，压入该会话队列，当前回合结束后
//     按序执行（D2）。排队的是用户自己的消息，吞了不合适。
//   - 排队必须**前端可见**（D9）——调用方据 QueueOutcome.position 发 turn.queue
//     信号并给回执带上 queued/position。
//   - 用户主动取消当前回合时**丢掉排队中的消息**（D3），但在途回合**不受影响**：
//     它要自己收尾（abort 是协作式的，回合会以正常终止路径结束并发 turn.end），
//     届时才解除 busy。
//
// **两种清理语义必须分开（否则会把并发洞放回去）**：
//   - `dropPending` —— turn.cancel：只丢队列，**busy 保持**。若连 busy 一起清，被取消
//     的回合还在收尾时新消息就能启动，同一个会话又跑起两个回合。
//   - `forget` —— session.close / session.delete：队列与 busy 一起清（会话都没了）。
//
// 本模块是纯数据结构：无 IO、无 async、无信号。谁发信号、谁执行下一个回合，都由
// gate 决定（本模块只回答「该跑还是该排、排第几、丢几条」）。
//
// 为什么按会话分桶而不是全局单队列：不同会话之间**必须并行**——用户开两个会话各问
// 一句，不该互相排队。串行化只作用于同一会话内部。

export type QueueOutcome =
  /** 该会话空闲，回合可以立即开始（本调用已把会话标记为 busy）。 */
  | { kind: 'run' }
  /** 该会话已有回合在途，本次已入队。position 从 1 起算（队首 = 1）。 */
  | { kind: 'queued'; position: number }

/**
 * 排队回执（用户拍板 2026-09-10，决策 A）：`gate.command('user.prompt')` 在消息
 * 被排队时返回的形状——回执自带排队信息，前端不必等 WS 往返即可显示"已排队（第 n 位）"。
 *
 * 分层注意：HTTP 层（`src/webshell/server.ts:128`）会把 gate 的返回值再包一层
 * `{ ok: true, result }`，`ok` 由信封承担；CLI 直连 gate，拿到的是本对象。
 */
export type QueuedPromptReceipt = { queued: true; position: number }

export const isQueuedPromptReceipt = (v: unknown): v is QueuedPromptReceipt => {
  if (typeof v !== 'object' || v === null) return false
  const r = v as { queued?: unknown; position?: unknown }
  return r.queued === true && typeof r.position === 'number'
}

export type SessionQueue = {
  /**
   * 请求开始一个回合。空闲 → 标记 busy 并返回 `{kind:'run'}`；
   * 在途 → 入队并返回 `{kind:'queued', position}`。
   */
  begin(sessionId: string, text: string): QueueOutcome
  /**
   * 一个回合结束。队里还有 → 取出下一条文本返回（会话保持 busy）；
   * 队空 → 清除 busy 并返回 undefined。调用方拿到文本后负责执行它。
   */
  finish(sessionId: string): string | undefined
  /**
   * 丢掉该会话排队中的消息（turn.cancel）。**在途回合与 busy 不受影响**——
   * 在途回合稍后结束时由 `finish` 解除 busy。返回丢掉的条数（供 UI 提示）。
   */
  dropPending(sessionId: string): number
  /** 完全忘记该会话（session.close / session.delete）：队列与 busy 一起清。 */
  forget(sessionId: string): void
  /** 该会话是否有回合在途。 */
  isBusy(sessionId: string): boolean
  /** 该会话排队中的条数。 */
  pending(sessionId: string): number
}

export const createSessionQueue = (): SessionQueue => {
  // busy 与 queues 分开存：busy = 「有一个回合正在跑」，queues = 「等着跑的文本」。
  // 合法组合：`busy=false, queue=[]`（空闲）、`busy=true, queue=[]`（在途无排队）、
  // `busy=true, queue=[...]`（在途且有排队）。**`busy=false` 且 queue 非空不会出现**
  // ——finish 会立即把队首提升为在途，dropPending 不会留下非空队列而不清 busy…
  // 注意 dropPending 之后是 `busy=true, queue=[]`，仍属合法组合。
  const busy = new Set<string>()
  const queues = new Map<string, string[]>()

  const begin = (sessionId: string, text: string): QueueOutcome => {
    if (!busy.has(sessionId)) {
      busy.add(sessionId)
      return { kind: 'run' }
    }
    const q = queues.get(sessionId)
    if (q === undefined) {
      queues.set(sessionId, [text])
      return { kind: 'queued', position: 1 }
    }
    q.push(text)
    return { kind: 'queued', position: q.length }
  }

  const finish = (sessionId: string): string | undefined => {
    const q = queues.get(sessionId)
    if (q !== undefined && q.length > 0) {
      const next = q.shift() as string
      if (q.length === 0) queues.delete(sessionId)
      // 会话保持 busy：队首已被提升为「在途」，调用方接着跑它。
      return next
    }
    queues.delete(sessionId)
    busy.delete(sessionId)
    return undefined
  }

  const dropPending = (sessionId: string): number => {
    const n = queues.get(sessionId)?.length ?? 0
    queues.delete(sessionId)
    // busy 不动：在途回合仍在收尾，它自己的 finish 才是解 busy 的地方。
    return n
  }

  const forget = (sessionId: string): void => {
    queues.delete(sessionId)
    busy.delete(sessionId)
  }

  const isBusy = (sessionId: string): boolean => busy.has(sessionId)
  const pending = (sessionId: string): number => queues.get(sessionId)?.length ?? 0

  return { begin, finish, dropPending, forget, isBusy, pending }
}
