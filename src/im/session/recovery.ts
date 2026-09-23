// v0.17 session recovery: reconstruct live IM objects from a durable snapshot.
//
// A session snapshot on disk is:
//   <sessionId>/session.json         — SessionInfo metadata
//   <sessionId>/conversation.jsonl   — full canonical turns (TTL snapshot)
//   <sessionId>/databus.jsonl        — tool-only turns (TTL snapshot)
//   <sessionId>/state/               — state-line gradient (durable)
//     state/curatedMemory.jsonl, state/index.jsonl, state/stamps.jsonl,
//     state/raw-archive.jsonl
//
// Recovery reconstructs the *live* ConversationMemory + Databus by re-reading
// the snapshot. Conversation turns that prior compression recorded in
// raw-archive.jsonl's sourceTurnIds are filtered out (legacy append-only
// snapshots still hold evicted spans on disk). Databus keeps ALL tool turns —
// block compression no longer evicts databus (方案 A), so tool stamps stay
// recallable after restart. The StateLine is re-opened against the same
// on-disk gradient so it continues to serve curated blocks / M3 summaries /
// raw archive queries. A fresh SubAgentRegistry is created (sub-agent configs
// are not session-scoped on disk; the caller re-loads them if needed). The
// drive coordinator is either wired from caller-supplied compression deps or
// a noop.

import type { SessionId } from './types.js'
import type { SessionStore } from './session-store.js'
import type { StateLine } from '../state-line/types.js'
import type { DriveCoordinator, DriveDeps } from '../system-agents/drive-coordinator.js'
import type { SignalBus } from '../memory-layers.js'
import type { SystemAgent } from '../system-agent.js'
import type { Mailbox } from '../mailbox/index.js'
import type { AgentId } from '../databus.js'
import type { Logger } from '../../shared/logger.js'
import { ConversationMemory } from '../conversation-memory.js'
import { Databus } from '../databus.js'
import { createStateLine } from '../state-line/index.js'
import { SubAgentRegistry } from '../sub-agent/index.js'
import {
  createDriveCoordinator,
  createNoopDriveCoordinator,
} from '../system-agents/drive-coordinator.js'

export type RecoveryResult = {
  sessionId: SessionId
  conversationMemory: ConversationMemory
  databus: Databus
  stateLine: StateLine
  subAgentRegistry: SubAgentRegistry
  driveCoordinator: DriveCoordinator
}

/** Caller-supplied compression deps. When omitted, a noop coordinator is used. */
export type CompressionDeps = {
  bus: SignalBus
  compressor: SystemAgent
  warehouse: SystemAgent
  mailbox: Mailbox
  workingAgentId: AgentId
  /** 原位信封落盘（2026-09-13）：透传给 DriveDeps.rewriteSnapshot——压缩成功
   *  后把含信封的内存快照原子重写到磁盘。宿主应走与 persistTurn 同队列。 */
  rewriteSnapshot?: (conversation: ConversationMemory, databus: Databus) => Promise<void>
  logger?: Logger
}

export type RecoveryOptions = {
  store: SessionStore
  sessionId: SessionId
  /** Compression deps. When omitted the drive coordinator is a noop. */
  compression?: CompressionDeps
}

/**
 * Reconstruct a live session from its on-disk snapshot.
 *
 * Steps:
 * 1. read session.json (throws if missing)
 * 2. read conversation.jsonl + databus.jsonl (all turns)
 * 3. open the StateLine against the session's state/ gradient and query its
 *    raw-archive to collect turn ids that were evicted by prior compression
 * 4. filter snapshot turns to only those still active (not evicted)
 * 5. rebuild ConversationMemory + Databus from the active turns
 * 6. reuse the same StateLine instance for the recovered session
 * 7. create a fresh SubAgentRegistry (no disk sub-agent state to recover)
 * 8. wire a real drive coordinator if compression deps were supplied, else noop
 */
export async function recoverSession(opts: RecoveryOptions): Promise<RecoveryResult> {
  const { store, sessionId } = opts

  // 1. session metadata
  const info = await store.readInfo(sessionId)
  if (!info) {
    throw new Error(`Session not found: ${sessionId}`)
  }

  // 2. snapshot turns
  const allTurns = await store.readConversation(sessionId)
  const allToolTurns = await store.readDatabus(sessionId)

  // 3. open the StateLine once. createStateLine builds `join(databusPath,'state')`
  //    internally, so databusPath must be the *session* dir (not the state/ dir).
  //    store.stateDir(id) returns <sessionDir>/state — that would double-nest to
  //    <sessionDir>/state/state. Pass store.sessionDir(id) instead.
  const stateLine = createStateLine({ databusPath: store.sessionDir(sessionId) })

  // Collect evicted turn ids from the raw archive. rawArchive.query is async.
  // Conversation only: block compression evicts canonical but keeps databus
  // (方案 A 2026-09-13) so tool stamps stay recallable across restart.
  // Filtering conversation still handles legacy append-only snapshots where
  // evicted turns remain on disk.
  const archiveRecords = await stateLine.rawArchive.query({})
  const evictedIds = new Set<string>()
  for (const r of archiveRecords) {
    for (const id of r.sourceTurnIds) evictedIds.add(id)
  }

  // 4. filter conversation to active turns; databus keeps ALL tools
  const activeTurns = allTurns.filter(t => !evictedIds.has(t.id))

  // 5. rebuild live memory + databus
  const conversationMemory = new ConversationMemory()
  for (const t of activeTurns) conversationMemory.append(t)

  const databus = new Databus({ sessionId: info.id })
  for (const t of allToolTurns) databus.append(t)

  // 6. stateLine is reused (already opened in step 3)

  // 7. fresh sub-agent registry
  const subAgentRegistry = new SubAgentRegistry()

  // 8. drive coordinator
  const driveCoordinator: DriveCoordinator = opts.compression
    ? createDriveCoordinator({
        bus: opts.compression.bus,
        compressor: opts.compression.compressor,
        warehouse: opts.compression.warehouse,
        stateLine,
        mailbox: opts.compression.mailbox,
        workingAgentId: opts.compression.workingAgentId,
        ...(opts.compression.rewriteSnapshot
          ? { rewriteSnapshot: opts.compression.rewriteSnapshot }
          : {}),
        ...(opts.compression.logger ? { logger: opts.compression.logger } : {}),
      } satisfies DriveDeps)
    : createNoopDriveCoordinator()

  return {
    sessionId,
    conversationMemory,
    databus,
    stateLine,
    subAgentRegistry,
    driveCoordinator,
  }
}
