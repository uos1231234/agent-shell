// v0.17 session recovery tests: reconstruct live IM objects from a durable snapshot.
//
// Scenario:
//   1. tmpdir basePath; write session.json + 3 conversation turns + 2 tool turns.
//   2. Hand-write a raw-archive.jsonl record whose sourceTurnIds covers 1 conv
//      turn id + 1 tool turn id (simulating prior compression eviction).
//   3. recoverSession → conversationMemory has 2 turns (1 evicted filtered),
//      databus has BOTH tool turns (方案 A: no filter), stateLine non-null,
//      driveCoordinator is noop when no compression supplied.
//   4. With a mock compression object, recoverSession still works (no throw).
//   5. recoverSession throws on missing session.

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../../../src/im/session/session-store.js'
import { recoverSession, type CompressionDeps } from '../../../src/im/session/recovery.js'
import type { SessionInfo } from '../../../src/im/session/types.js'
import type { ConversationTurn } from '../../../src/im/conversation-memory.js'
import type { ToolTurn } from '../../../src/im/databus.js'
import type { RawArchiveRecord } from '../../../src/im/state-line/types.js'
import type { ChatMessage } from '../../../src/protocol/types.js'

let baseDir: string

const makeInfo = (id: string): SessionInfo => ({
  id,
  title: `session-${id}`,
  workingAgentId: 'main',
  createdAt: 1000,
  lastActiveAt: 1000,
  turnCount: 5,
  layer: 'M0',
  snapshotExpired: false,
})

const convTurn = (
  id: string,
  role: 'user' | 'assistant',
  at: number,
): ConversationTurn => ({ id, role, content: `${role}-${id}`, at })

const toolTurn = (id: string, at: number): ToolTurn => ({
  id,
  role: 'tool',
  toolCallId: `tc-${id}`,
  content: `result-${id}`,
  sourceAgentId: 'main',
  at,
})

describe('im/session/recovery', () => {
  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'session-recovery-'))
  })

  it('recovers conversation with evicted filter; databus keeps ALL tools (方案 A)', async () => {
    const store = new SessionStore({ basePath: baseDir })
    await store.writeInfo(makeInfo('s1'))

    // 3 conversation turns: c1 (evicted), c2, c3 (active)
    await store.appendConversationTurn('s1', convTurn('c1', 'user', 1))
    await store.appendConversationTurn('s1', convTurn('c2', 'assistant', 2))
    await store.appendConversationTurn('s1', convTurn('c3', 'user', 3))

    // 2 tool turns: d1 (evicted), d2 (active)
    await store.appendDatabusTurn('s1', toolTurn('d1', 10))
    await store.appendDatabusTurn('s1', toolTurn('d2', 20))

    // Hand-write a raw-archive.jsonl record whose sourceTurnIds covers c1 + d1.
    const stateDir = store.stateDir('s1')
    await mkdir(stateDir, { recursive: true })
    const archiveMessages: ChatMessage[] = [
      { role: 'user', content: 'c1 original' },
    ]
    const record: RawArchiveRecord = {
      archiveId: 'arc-1',
      sourceTurnIds: ['c1', 'd1'],
      messages: archiveMessages,
      layer: 'M1',
      at: 100,
      summaryStamp: 'S-1',
    }
    await writeFile(join(stateDir, 'raw-archive.jsonl'), JSON.stringify(record) + '\n', 'utf-8')

    const recovered = await recoverSession({ store, sessionId: 's1' })

    // conversation turns: only c2 + c3 (c1 evicted)
    const convIds = recovered.conversationMemory.turns().map(t => t.id)
    expect(convIds).toEqual(['c2', 'c3'])

    // databus turns: ALL tools kept (方案 A — stamps stay recallable)
    const toolIds = recovered.databus.turns().map(t => t.id)
    expect(toolIds).toEqual(['d1', 'd2'])

    // stateLine non-null and functional (rawArchive query returns the record)
    expect(recovered.stateLine).toBeDefined()
    const archive = await recovered.stateLine.rawArchive.query({})
    expect(archive).toHaveLength(1)
    expect(archive[0]!.archiveId).toBe('arc-1')

    // driveCoordinator is noop when no compression supplied
    expect(recovered.driveCoordinator).toBeDefined()

    // subAgentRegistry present
    expect(recovered.subAgentRegistry).toBeDefined()

    // sessionId echoed back
    expect(recovered.sessionId).toBe('s1')

    // cleanup state-line subscribers
    recovered.stateLine.close()
  })

  it('recoverSession throws on missing session', async () => {
    const store = new SessionStore({ basePath: baseDir })
    await expect(recoverSession({ store, sessionId: 'nope' })).rejects.toThrow(/Session not found/)
  })

  it('recoverSession with mock compression deps does not throw and wires driveCoordinator', async () => {
    const store = new SessionStore({ basePath: baseDir })
    await store.writeInfo(makeInfo('s2'))
    await store.appendConversationTurn('s2', convTurn('c1', 'user', 1))

    // Minimal mock compression deps. createDriveCoordinator only needs the
    // shape; we do not tick it here, just verify recoverSession does not throw
    // when compression is supplied (driveCoordinator becomes non-noop).
    const mockCompression = {
      bus: { on: () => () => {}, emit: () => {}, off: () => {} },
      compressor: { run: async () => {}, stop() {}, send() {} },
      warehouse: { run: async () => {}, stop() {}, send() {} },
      mailbox: { send: async () => '', receive: async () => undefined, close() {} },
      workingAgentId: 'main',
    } as unknown as CompressionDeps

    const recovered = await recoverSession({
      store,
      sessionId: 's2',
      compression: mockCompression,
    })
    expect(recovered.driveCoordinator).toBeDefined()
    expect(recovered.conversationMemory.turns()).toHaveLength(1)
    recovered.stateLine.close()
  })
})
