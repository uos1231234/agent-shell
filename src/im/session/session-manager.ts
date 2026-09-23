// v0.17 session manager: create / open / list / close / delete sessions.
//
// A SessionManager owns one SessionStore (on-disk layout) + one
// SessionBusRegistry (in-memory bus ownership). It mints a fresh UUID per
// createSession and returns a SessionHandle that bundles the live runtime
// objects (memory/databus/state-line/sub-agent registry/drive coordinator) +
// a buildLoopOptions helper that merges session-scoped fields with
// caller-supplied infrastructure.
//
// The sessionId (UUID) is shared between the session mechanism and the
// SecurityRouter: buildLoopOptions threads the same sessionId into
// IMLoopOptions so registry.execute → SecurityRouter dispatches per-session
// approval state. The session mechanism never imports SecurityRouter — only
// the string value is shared (decoupling rationale in v0.17 plan).

import { randomUUID } from 'node:crypto'
import type {
  SessionId,
  SessionInfo,
  SessionHandle,
  SessionLoopBase,
  SessionManager,
  SessionManagerOptions,
  SessionRuntime,
} from './types.js'
import type { ConversationTurn } from '../conversation-memory.js'
import type { IMLoopOptions, SystemAgents } from '../loop.js'
import { SessionStore } from './session-store.js'
import { SessionBusRegistry } from './bus-registry.js'
import { ConversationMemory } from '../conversation-memory.js'
import { Databus } from '../databus.js'
import { Mailbox } from '../mailbox/index.js'
import { createStateLine } from '../state-line/index.js'
import { SubAgentRegistry } from '../sub-agent/index.js'
import { createNoopDriveCoordinator } from '../system-agents/drive-coordinator.js'
import { recoverSession, type CompressionDeps } from './recovery.js'
import { defaultLogger } from '../../shared/logger.js'

// v0.25: 空暴露清单告警走 ADR-020 纪律的 logger（component 绑定一次）。
const sessionManagerLog = defaultLogger.child({ component: 'session-manager' })

// Default system agents when the caller does not supply any. Mirrors
// minimal.ts: noop agents that throw on run() with a clear message.
const noopSystemAgent = {
  run: async () => { throw new Error('no system agents configured; provide real systemAgents in SessionLoopBase to enable system-agent-backed tools') },
  stop() {},
  send() {},
}
const defaultSystemAgents: SystemAgents = {
  warehouse: noopSystemAgent,
  compressor: noopSystemAgent,
  recall: noopSystemAgent,
}

export function createSessionManager(opts?: SessionManagerOptions): SessionManager {
  const store = new SessionStore({
    ...(opts?.basePath ? { basePath: opts.basePath } : {}),
    ...(opts?.snapshot?.ttlDays ? { ttlDays: opts.snapshot.ttlDays } : {}),
  })
  const busRegistry = new SessionBusRegistry()

  // ---- shared SessionHandle assembler ----
  const assembleHandle = (
    info: SessionInfo,
    sessionId: SessionId,
    conversationMemory: ConversationMemory,
    databus: Databus,
    stateLine: ReturnType<typeof createStateLine>,
    subAgentRegistry: SubAgentRegistry,
    writes: {
      persistTurn: SessionRuntime['persistTurn']
      enqueueSnapshotWrite: SessionRuntime['enqueueSnapshotWrite']
    },
    driveCoordinator: SessionRuntime['driveCoordinator'],
  ): SessionHandle => {
    // v0.25: per-session 空清单告警幂等标志——同一句柄的 buildLoopOptions
    // 无论调用多少次，只 warn 一次。
    let warnedEmptyToolRefs = false
    const handle: SessionHandle = {
      info,
      runtime: {
        sessionId,
        conversationMemory,
        databus,
        stateLine,
        subAgentRegistry,
        driveCoordinator,
        persistTurn: writes.persistTurn,
        enqueueSnapshotWrite: writes.enqueueSnapshotWrite,
      },
      buildLoopOptions(base: SessionLoopBase): IMLoopOptions {
        // The session owns session-scoped fields; base owns shared infra.
        // mailbox/systemAgents default to noops when the caller omits them
        // (matches minimal.ts behaviour) so the returned options always
        // satisfy IMLoopOptions' required mailbox/systemAgents fields.
        const mailbox: Mailbox = base.mailbox ?? new Mailbox()
        const systemAgents: SystemAgents = base.systemAgents ?? defaultSystemAgents
        const systemToolRefs: string[] = base.systemToolRefs ?? []
        // v0.25: 宿主装配遗漏检测——registry 里注册了系统工具但宿主没声明
        // systemToolRefs 白名单，真实 LLM 的 tools 数组会为空（模型发起不了
        // 任何系统工具调用）。告警不阻断（空 refs 是合法意图，纯聊天代理），
        // 不改变返回值；同一句柄只 warn 一次。
        const registrySystemToolCount = base.registry.listSystemTools().length
        if (systemToolRefs.length === 0 && registrySystemToolCount > 0 && !warnedEmptyToolRefs) {
          warnedEmptyToolRefs = true
          sessionManagerLog.warn(
            'session has empty systemToolRefs while the registry exposes system tools; the model will not be able to call any system tool',
            { sessionId, registrySystemToolCount },
          )
        }
        const mcpRefs = base.mcpRefs ?? []
        const skillRefs: string[] = base.skillRefs ?? []
        const merged: IMLoopOptions = {
          config: base.config,
          registry: base.registry,
          streamChat: base.streamChat,
          url: base.url,
          model: base.model,
          systemPrompt: base.systemPrompt,
          userTemplate: base.userTemplate,
          databus,
          conversationMemory,
          stateLine,
          workingAgentId: info.workingAgentId,
          sessionId,
          // v0.20: 用户工作文件夹（session-scoped）——注入源据此读 MEMORY.md/ARCHITECTURE.md
          ...(info.workDir !== undefined ? { workDir: info.workDir } : {}),
          mailbox,
          systemAgents,
          systemToolRefs,
          mcpRefs,
          skillRefs,
          // 读 runtime 引用而非闭包快照：宿主装配层（attachHandle）会在
          // createSession 返回后把 noop coordinator 覆盖为真实现（压缩调度
          // 接线，mailbox/systemAgents 在装配层才齐备）。装配后的每轮 tick
          // 必须走覆盖后的 coordinator。
          driveCoordinator: handle.runtime.driveCoordinator,
          subAgentDepth: 0,
          persistTurn: writes.persistTurn,
          ...(base.ctxDatabus !== undefined ? { ctxDatabus: base.ctxDatabus } : {}),
          ...(base.subAgentDepth !== undefined ? { subAgentDepth: base.subAgentDepth } : {}),
          ...(base.initialMetrics !== undefined ? { initialMetrics: base.initialMetrics } : {}),
          ...(base.memoryConfig !== undefined ? { memoryConfig: base.memoryConfig } : {}),
          ...(base.logger !== undefined ? { logger: base.logger } : {}),
          ...(base.requestHandler !== undefined ? { requestHandler: base.requestHandler } : {}),
          ...(base.isWikiAgent !== undefined ? { isWikiAgent: base.isWikiAgent } : {}),
          // v0.20 hook repair: 转发 hook 机制 + 补齐 drift 字段。
          // 缺失这些字段会导致走 SessionManager 的会话静默丢失 hook 能力。
          ...(base.hooks !== undefined ? { hooks: base.hooks } : {}),
          ...(base.hookSystem !== undefined ? { hookSystem: base.hookSystem } : {}),
          // v0.21: 流式增量旁路（信号关 delta-bridge 接入口）。
          ...(base.onStreamChunk !== undefined ? { onStreamChunk: base.onStreamChunk } : {}),
          // 思维链落盘门控透传（赋值面 = 落盘面，2026-09-12 用户拍板）。
          ...(base.persistReasoning !== undefined ? { persistReasoning: base.persistReasoning } : {}),
          // v0.41 D19：严格交替 provider 的出站转写开关透传。
          ...(base.strictAlternation !== undefined ? { strictAlternation: base.strictAlternation } : {}),
          ...(base.tokenCounter !== undefined ? { tokenCounter: base.tokenCounter } : {}),
          ...(base.largeRecall !== undefined ? { largeRecall: base.largeRecall } : {}),
          ...(base.directRecallLedger !== undefined ? { directRecallLedger: base.directRecallLedger } : {}),
          ...(base.directRecallLimitTokens !== undefined ? { directRecallLimitTokens: base.directRecallLimitTokens } : {}),
          ...(base.contextInjector !== undefined ? { contextInjector: base.contextInjector } : {}),
          // v0.20: per-session 渲染基座（bus + base + store）
          ...(base.rendering !== undefined ? { rendering: base.rendering } : {}),
          ...(base.dynamicSchemas !== undefined ? { dynamicSchemas: base.dynamicSchemas } : {}),
          ...(base.toolPolicy !== undefined ? { toolPolicy: base.toolPolicy } : {}),
          // v0.19: promptLayers/promptMode — 当前未接入 composePrompt，预留接口。
          // ...(base.promptLayers !== undefined ? { promptLayers: base.promptLayers } : {}),
          // ...(base.promptMode !== undefined ? { promptMode: base.promptMode } : {}),
          ...(base.signal !== undefined ? { signal: base.signal } : {}),
          ...(base.compressZone !== undefined ? { compressZone: base.compressZone } : {}),
          ...(base.injectTextSkills !== undefined ? { injectTextSkills: base.injectTextSkills } : {}),
          ...(base.archiveSourceStamps !== undefined ? { archiveSourceStamps: base.archiveSourceStamps } : {}),
          ...(base.archiveRawArchiveIds !== undefined ? { archiveRawArchiveIds: base.archiveRawArchiveIds } : {}),
        }
        return merged
      },
      async saveInfo(patch: Partial<SessionInfo>): Promise<void> {
        Object.assign(info, patch)
        await store.writeInfo({ ...info })
      },
      async close(): Promise<void> {
        busRegistry.unregisterSession(sessionId)
        stateLine.close()
      },
    }
    return handle
  }

  // ---- persistTurn + snapshot-rewrite factory (shared by create + open) ----
  // 会话级写串行队列：conversation.jsonl / databus.jsonl 的全部写共用一条
  // FIFO 链。persistTurn 增量 append 在 loop 回合内同步入队（enqueue 是回调
  // 首个同步语句，loop 在 appendCanonicalTurn 后立即调用——无 await 缝隙），
  // coordinator 的快照重写由宿主经 enqueueSnapshotWrite 入队；coordinator
  // tick 是 fire-and-forget（与下一轮并发），无此队列 rewrite 会与 append
  // 交错产生重复行/丢行。队列执行时读"当下"的内存快照，收敛于内存真相。
  const makeConversationWrites = (
    sessionId: SessionId,
  ): {
    persistTurn: SessionRuntime['persistTurn']
    enqueueSnapshotWrite: SessionRuntime['enqueueSnapshotWrite']
  } => {
    let chain: Promise<void> = Promise.resolve()
    const enqueue = (job: () => Promise<void>): Promise<void> => {
      const run = chain.then(job)
      chain = run.catch(() => {})
      return run
    }
    const persistTurn: SessionRuntime['persistTurn'] = async (turn, databusTurn) => {
      await enqueue(async () => {
        await store.appendConversationTurn(sessionId, turn)
        if (turn.role === 'tool') {
          await store.appendDatabusTurn(sessionId, databusTurn ?? turn)
        }
      })
    }
    // 入队时冻结快照（2026-09-13）：执行时读 live memory 会把「rewrite 入队后、
    // 执行前」新 append 的回合写进快照，随后它们自己的 persistTurn 再 append 一次
    // → 磁盘重复行。入队时捕获 = 磁盘收敛于「rewrite 入队时刻的内存」，后续回合
    // 由各自的 append 正常追加。
    const enqueueSnapshotWrite: SessionRuntime['enqueueSnapshotWrite'] = (
      conversation: ConversationMemory,
      databus: Databus,
    ) => {
      const turnsSnapshot = [...conversation.turns()]
      const databusSnapshot = [...databus.turns()]
      return enqueue(async () => {
        await store.rewriteConversation(sessionId, turnsSnapshot)
        await store.rewriteDatabus(sessionId, databusSnapshot)
      })
    }
    return { persistTurn, enqueueSnapshotWrite }
  }

  const createSession = async (createOpts?: {
    title?: string
    workingAgentId?: string
    workDir?: string
  }): Promise<SessionHandle> => {
    const sessionId: SessionId = randomUUID()
    const now = Date.now()
    const info: SessionInfo = {
      id: sessionId,
      title: createOpts?.title ?? 'Untitled session',
      workingAgentId: createOpts?.workingAgentId ?? 'main',
      createdAt: now,
      lastActiveAt: now,
      turnCount: 0,
      layer: 'M0',
      snapshotExpired: false,
      // v0.20: 用户工作文件夹——上下文注入源据此读取 MEMORY.md / ARCHITECTURE.md
      ...(createOpts?.workDir !== undefined ? { workDir: createOpts.workDir } : {}),
    }
    await store.writeInfo(info)

    const conversationMemory = new ConversationMemory()
    const databus = new Databus({ sessionId })
    const stateLine = createStateLine({ databusPath: store.sessionDir(sessionId) })
    const subAgentRegistry = new SubAgentRegistry()
    const driveCoordinator = createNoopDriveCoordinator()
    const writes = makeConversationWrites(sessionId)

    busRegistry.registerSession(sessionId, {
      own: databus,
      family: new Databus({ sessionId }),
    })

    return assembleHandle(
      info, sessionId, conversationMemory, databus, stateLine,
      subAgentRegistry, writes, driveCoordinator,
    )
  }

  const openSession = async (
    id: SessionId,
    openOpts?: { compression?: CompressionDeps },
  ): Promise<SessionHandle> => {
    const recovered = await recoverSession({
      store,
      sessionId: id,
      ...(openOpts?.compression ? { compression: openOpts.compression } : {}),
    })

    // Re-register (or replace) the session's bus pair. openSession may be
    // called on a session that was previously closed (bus unregistered) or
    // never registered; registerOrUpdate is idempotent.
    busRegistry.registerOrUpdate(id, {
      own: recovered.databus,
      family: new Databus({ sessionId: id }),
    })

    // Refresh lastActiveAt on open.
    const info = await store.readInfo(id)
    if (info) {
      const patched: SessionInfo = { ...info, lastActiveAt: Date.now() }
      await store.writeInfo(patched)
      // Use the patched info for the handle so callers see the fresh timestamp.
      const writes = makeConversationWrites(id)
      return assembleHandle(
        patched, id, recovered.conversationMemory, recovered.databus,
        recovered.stateLine, recovered.subAgentRegistry, writes,
        recovered.driveCoordinator,
      )
    }
    // recoverSession already threw if info was null, so this is unreachable.
    throw new Error(`Session not found: ${id}`)
  }

  const closeSession = async (id: SessionId): Promise<void> => {
    busRegistry.unregisterSession(id)
    const info = await store.readInfo(id)
    if (info) {
      await store.writeInfo({ ...info, lastActiveAt: Date.now() })
    }
  }

  // v0.29 Wave B2（/fork，对标 KimiCode fork 不切换）：复制快照对为全新 UUID
  // 的会话。info 复制（title 加 " (fork)" 后缀、createdAt/lastActiveAt = now、
  // turnCount 继承）；state/ 梯度不复制（copySnapshot 只拷 conversation.jsonl
  // + databus.jsonl）——fork 的上下文仍全量在 canonical，压缩梯度从零。
  // 不自动 open：不注册 bus registry、宿主不接入信号关；handle 的 runtime 由
  // recoverSession 按副本快照重建（副本无 state/ → 无驱逐记录 → canonical
  // 全量回内存），调用方拿到的是可直接续聊的真实句柄；gate 侧只取 .info 返回。
  const forkSession = async (
    id: SessionId,
    forkOpts?: { title?: string },
  ): Promise<SessionHandle> => {
    const source = await store.readInfo(id)
    if (source === null) {
      throw new Error(`Session not found: ${id}`)
    }
    const newId: SessionId = randomUUID()
    await store.copySnapshot(id, newId)
    const now = Date.now()
    const info: SessionInfo = {
      ...source,
      id: newId,
      title: forkOpts?.title ?? `${source.title} (fork)`,
      createdAt: now,
      lastActiveAt: now,
      snapshotExpired: false,
    }
    await store.writeInfo(info)

    const recovered = await recoverSession({ store, sessionId: newId })
    const writes = makeConversationWrites(newId)
    return assembleHandle(
      info, newId, recovered.conversationMemory, recovered.databus,
      recovered.stateLine, recovered.subAgentRegistry, writes,
      recovered.driveCoordinator,
    )
  }

  const deleteSession = async (id: SessionId): Promise<void> => {
    busRegistry.unregisterSession(id)
    await store.deleteSessionDir(id)
  }

  const listSessions = async (): Promise<SessionInfo[]> => {
    const ids = await store.listSessionIds()
    const infos: SessionInfo[] = []
    for (const id of ids) {
      const info = await store.readInfo(id)
      if (info) infos.push(info)
    }
    infos.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    return infos
  }

  const pruneExpiredSnapshots = async (): Promise<number> => {
    return store.pruneExpiredSnapshots()
  }

  return {
    createSession,
    openSession,
    closeSession,
    deleteSession,
    forkSession,
    listSessions,
    pruneExpiredSnapshots,
  }
}
