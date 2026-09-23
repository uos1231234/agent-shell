// chunk-mode.ts — v0.42 gate 会话级切块模式状态持有器。
//
// 与 session-queue.ts 同哲学：纯数据结构、无 IO、无 async、无信号。谁发信号、
// 谁在 user.prompt 分支切块，都由 gate 决定（本模块只回答「这个会话是否处于
// 切块模式、每块多大」）。
//
// 为什么放在 gate 而不是宿主（用户拍板 2026-09-15）：切块是大输入上传的**前方
// 基础**，是 gate 唯一的前后端中转站职责的一部分——同样一条大文本，CLI / webapp
// / headless 都从 gate 的 user.prompt 过，在 gate 识别切块一处设防全端受益
// （v0.34 C1 把回合串行化放 gate 是同一先例）。
//
// 纯手动（用户拍板）：只有显式 enable 的会话才切；不做自动阈值判断。

/**
 * 会话 → 切块配置。`undefined` = 该会话未启用。
 * chunkTokens 是每分卷预算（默认 DEFAULT_CHUNK_TOKENS，见 chunk.ts）。
 */
type ChunkConfig = { chunkTokens: number }

export type ChunkMode = {
  /** 启用切块。返回 true 表示此前未启用（本次从关到开）。 */
  enable(sessionId: string, chunkTokens?: number): boolean
  /** 停用切块。返回 true 表示此前确实启用（真有关可关）。 */
  disable(sessionId: string): boolean
  /** 该会话是否处于切块模式。 */
  isEnabled(sessionId: string): boolean
  /** 该会话的每分卷预算；未启用返回 undefined。 */
  tokensOf(sessionId: string): number | undefined
  /** 忘记该会话（session.close / session.delete 时随队列一起清）。 */
  forget(sessionId: string): void
}

export const createChunkMode = (): ChunkMode => {
  const modes = new Map<string, ChunkConfig>()

  const enable = (sessionId: string, chunkTokens?: number): boolean => {
    const was = modes.has(sessionId)
    modes.set(sessionId, { chunkTokens: chunkTokens ?? 40_000 })
    return !was
  }

  const disable = (sessionId: string): boolean => modes.delete(sessionId)

  const isEnabled = (sessionId: string): boolean => modes.has(sessionId)

  const tokensOf = (sessionId: string): number | undefined => modes.get(sessionId)?.chunkTokens

  const forget = (sessionId: string): void => {
    modes.delete(sessionId)
  }

  return { enable, disable, isEnabled, tokensOf, forget }
}