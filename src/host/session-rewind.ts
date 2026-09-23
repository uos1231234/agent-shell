// v0.36 — session.rewind 的回滚核心（把 AI 改过的文件还原到改动之前）。
//
// 与 session-undo 正交：那个撤对话（canonical 尾部 N 个任务块）、这个撤文件
// （快照层最近 N 条写操作所涉及的文件）。两者可单独或组合使用。
//
// 执行全部委托给快照层（im/tools/file-history.ts 的 rewind）——本文件只做
// 薄装配：从 openHandles 取该会话的 file-history 实例并调用。文件不存在/
// 未打开等情形抛干净英文错误（与 session-undo 同风格）。
//
// 设计依据（用户 2026-09-11 拍板）：安全的本质是「可恢复」——AI 改错了代码，
// 用户能撤销即可。回滚权只在用户手里（LLM 不持有 rewind 能力），对齐四个
// 对标 harness 的一致做法。

import type { SessionRewindResult } from '../signals/types.js'
import type { FileHistory } from '../im/tools/file-history.js'

export type SessionRewindDeps = {
  sessionId: string
  /** 该会话（per-session registry）创建时装配的快照层实例。 */
  fileHistory: FileHistory
}

export const REWIND_MAX_ENTRIES = 50

export async function rewindSessionFiles(
  deps: SessionRewindDeps,
  entries: number | 'last-turn',
): Promise<SessionRewindResult> {
  if (entries === 'last-turn') {
    // 前端只发 'last-turn'：快照记录在宿主侧，前端数不了（也数不准）。
    const resolved = await deps.fileHistory.countLastTurnRecords(deps.sessionId)
    // 没有记录**不是错误**：空结果让前端自然落到"没有可撤销的改动"，比让它解析
    // 错误文案更干净。
    if (resolved === 0) return { restored: [], deleted: [], unbacked: [], entries: 0 }
    if (resolved > REWIND_MAX_ENTRIES) {
      throw new Error(
        `session.rewind: the last turn left ${resolved} snapshot record(s), more than the ${REWIND_MAX_ENTRIES}-entry cap; pass an explicit entries count`,
      )
    }
    return runRewind(deps, resolved)
  }
  if (!Number.isInteger(entries) || entries < 1 || entries > REWIND_MAX_ENTRIES) {
    throw new Error(`session.rewind requires an integer entries in [1, ${REWIND_MAX_ENTRIES}], got ${entries}`)
  }
  return runRewind(deps, entries)
}

async function runRewind(deps: SessionRewindDeps, entries: number): Promise<SessionRewindResult> {
  const outcome = await deps.fileHistory.rewind(deps.sessionId, entries)
  return {
    restored: outcome.restored,
    deleted: outcome.deleted,
    unbacked: outcome.unbacked,
    entries: outcome.entries,
  }
}
