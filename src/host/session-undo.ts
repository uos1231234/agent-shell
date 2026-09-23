// v0.29 Wave B2 — session.undo 的撤回核心（/undo 的宿主落点）。
//
// 语义（用户拍板，对标 KimiCode /undo）：从 canonical **尾部**撤回最近 N 个
// 完整任务块（user→next-user 且含工具轮、通过配对校验——与 drive-coordinator
// 的 TaskBlock 定义完全同源，复用 findNextTaskBlock，不造第二套切块器）。
// 尾部不完整 span（还没有下一个 user 边界的在途任务）不动。
//
// 执行顺序沿袭 dispatchCompression 的原子性纪律——**先落盘、后驱逐**：
//   1. rawArchive 前置校验（撤回范围 ∩ 已压缩归档 → 拒绝，干净错误）
//   2. journal 重写（conversation.jsonl / databus.jsonl 原子 rename 覆写，
//      只删本次撤回的 id——更早被压缩驱逐的前缀历史保留在 journal，
//      raw-archive 仍能按 sourceTurnIds 对上）
//   3. 内存驱逐（evictRange + databus.evictByIds，纯内存操作不会失败）
// 任何一步 throw 时两存储均未改动（步骤 1/2 在驱逐之前）。
//
// 本文件零 npm 依赖；对 src/** 只依赖既有函数（findNextTaskBlock / SessionStore）。

import { findNextTaskBlock } from '../im/system-agents/drive-coordinator.js'
import type { TaskBlock } from '../im/system-agents/drive-coordinator.js'
import type { ConversationMemory } from '../im/conversation-memory.js'
import type { Databus } from '../im/databus.js'
import type { StateLine } from '../im/state-line/types.js'
import type { SessionStore } from '../im/session/session-store.js'
import type { SessionUndoResult } from '../signals/types.js'

/** /undo 允许的块数范围（gate 契约注释同款；宿主是最终校验点）。 */
export const UNDO_MAX_BLOCKS = 10

export type UndoTaskBlocksDeps = {
  sessionId: string
  conversationMemory: ConversationMemory
  databus: Databus
  stateLine: StateLine
  /**
   * journal 的读-改-写落点。与 SessionManager 内部 store 同 basePath 的独立
   * 实例即可（文件是唯一事实源）——assembly 传入装配层已有的 sessionStore。
   */
  store: Pick<
    SessionStore,
    'readConversation' | 'readDatabus' | 'rewriteConversation' | 'rewriteDatabus'
  >
}

/**
 * 撤回最近 blocks 个完整任务块。返回回执（实际撤回块数 + 驱逐回合数）。
 * 抛干净英文错误的情形：
 *   - blocks 非整数或越界（1 ≤ N ≤ 10）；
 *   - canonical 的完整任务块不足 N 个；
 *   - 撤回范围内有回合已被压缩进 raw archive。
 */
export async function undoTaskBlocks(
  deps: UndoTaskBlocksDeps,
  blocks: number,
): Promise<SessionUndoResult> {
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > UNDO_MAX_BLOCKS) {
    throw new Error(`session.undo requires an integer blocks in [1, ${UNDO_MAX_BLOCKS}], got ${blocks}`)
  }

  // ---- 定位：从 canonical 枚举全部完整任务块，取尾部 N 个 ----
  const turns = deps.conversationMemory.turns()
  const all: TaskBlock[] = []
  for (
    let b = findNextTaskBlock(turns, 0);
    b !== undefined;
    b = findNextTaskBlock(turns, b.endIndexExclusive)
  ) {
    all.push(b)
  }
  if (all.length < blocks) {
    throw new Error(
      `session "${deps.sessionId}" has only ${all.length} complete task block(s); cannot undo ${blocks}`,
    )
  }
  const selected = all.slice(-blocks)
  const start = selected[0]!.startIndex
  const end = selected[selected.length - 1]!.endIndexExclusive
  const rangeTurns = turns.slice(start, end)
  const rangeIds = rangeTurns.map((t) => t.id)

  // ---- 前置校验：撤回范围不得触及已压缩归档（raw-archive 按 sourceTurnIds
  // 的任意交集匹配——命中即说明该范围（部分）已被压缩驱逐过，撤回会破坏
  // curated/raw-archive 与 canonical 的对应关系，拒绝而非静默错删）。
  const archived = await deps.stateLine.rawArchive.query({ sourceTurnIds: rangeIds })
  if (archived.length > 0) {
    throw new Error(
      `cannot undo ${blocks} block(s) of session "${deps.sessionId}": ` +
        `${archived.length} archived raw record(s) overlap the range ` +
        `(e.g. ${archived[0]!.archiveId}) — the turns were already compressed`,
    )
  }

  // ---- journal 重写（先落盘）：只删本次撤回的 id ----
  const removedIds = new Set(rangeIds)
  const journalTurns = await deps.store.readConversation(deps.sessionId)
  const keptTurns = journalTurns.filter((t) => !removedIds.has(t.id))
  const journalToolTurns = await deps.store.readDatabus(deps.sessionId)
  const keptToolTurns = journalToolTurns.filter((t) => !removedIds.has(t.id))
  await deps.store.rewriteConversation(deps.sessionId, keptTurns)
  await deps.store.rewriteDatabus(deps.sessionId, keptToolTurns)

  // ---- 内存驱逐（后驱逐）：与 journal 重写同集合 ----
  deps.conversationMemory.evictRange(start, end)
  const removedToolIds = rangeTurns
    .filter((t) => t.role === 'tool')
    .map((t) => t.id)
  deps.databus.evictByIds(removedToolIds)

  return { blocks: selected.length, evicted: rangeTurns.length }
}
