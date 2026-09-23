// session-store reducer 单测：9 种信号的事件矩阵 + history-merge join +
// resync 窗口的未确认 local- 条目保护（applyHistoryItems）。
// reduceSignal / historyToItems / applyHistoryItems 是纯函数——不依赖 zustand 实例直接测。

import { describe, it, expect } from 'vitest'
import {
  reduceSignal,
  historyToItems,
  applyHistoryItems,
  type StoreState,
  type ChatItem,
  type TurnView,
  type UserMessageView,
  type MemoryItemView,
} from '../src/state/session-store'
import type { GateSignal, ConversationTurn } from '../src/api/contract'

const blank = (): StoreState => ({
  sessions: {},
  sessionList: [],
  logs: [],
  pendingRequests: [],
  providerCatalog: undefined,
  wikiChangedAt: 0,
  wikiGen: undefined,
  activeSessionId: null,
})

const delta = (text: string, turnId = 'turn-1'): GateSignal => ({
  kind: 'assistant.delta',
  sessionId: 's1',
  turnId,
  text,
})

describe('reduceSignal: assistant.delta', () => {
  it('accumulates text; new turnId opens a new turn', () => {
    let s = blank()
    s = reduceSignal(s, delta('he'), 1)
    s = reduceSignal(s, delta('llo'), 2)
    s = reduceSignal(s, delta('world', 'turn-2'), 3)
    const items = s.sessions['s1']!.items
    expect(items).toHaveLength(2)
    expect((items[0] as TurnView).text).toBe('hello')
    expect((items[1] as TurnView).text).toBe('world')
  })
})

describe('reduceSignal: tool lifecycle', () => {
  it('tool.started creates a pending card; tool.result fills it', () => {
    let s = blank()
    s = reduceSignal(s, delta('doing'), 1)
    s = reduceSignal(
      s,
      { kind: 'tool.started', sessionId: 's1', turnId: 'turn-1', toolName: 'write', callId: 'c1', args: { path: 'a.txt' } },
      2,
    )
    s = reduceSignal(
      s,
      {
        kind: 'tool.result',
        sessionId: 's1',
        turnId: 'turn-1',
        toolName: 'write',
        callId: 'c1',
        result: { id: 't1', role: 'tool', toolCallId: 'c1', content: 'wrote 10 bytes', sourceAgentId: 'main', at: 3 },
      },
      3,
    )
    const turn = s.sessions['s1']!.items[0] as TurnView
    const call = turn.toolCalls['c1']
    expect(call.pending).toBe(false)
    expect(call.name).toBe('write')
    expect(call.args).toEqual({ path: 'a.txt' })
    expect(call.result).toBe('wrote 10 bytes')
    expect(call.isError).toBeUndefined()
  })

  it('tool.result without started builds the card (recovery/lost frame)', () => {
    let s = blank()
    s = reduceSignal(s, delta('go', 'turn-1'), 1)
    s = reduceSignal(
      s,
      {
        kind: 'tool.result',
        sessionId: 's1',
        turnId: 'turn-1',
        toolName: 'read',
        callId: 'cx',
        result: { id: 't1', role: 'tool', toolCallId: 'cx', content: 'body', isError: true, sourceAgentId: 'main', at: 2 },
      },
      2,
    )
    const turn = s.sessions['s1']!.items[0] as TurnView
    expect(turn.toolCalls['cx'].result).toBe('body')
    expect(turn.toolCalls['cx'].isError).toBe(true)
  })
})

describe('reduceSignal: turn.end', () => {
  it('stores lastResult and clears running', () => {
    let s = blank()
    s = reduceSignal(s, { kind: 'user.side', sessionId: 's1' } as unknown as GateSignal, 0) // 无关信号不炸
    void s
    s = blank()
    s = reduceSignal(
      s,
      {
        kind: 'turn.end',
        sessionId: 's1',
        result: {
          terminated: false,
          reason: 'completed',
          finalState: 'Running',
          hits: [],
          turns: 2,
          metrics: {
            lastRequestTokens: 100,
            totalTokens: 250,
            promptTokens: 150,
            completionTokens: 100,
            reasoningTokens: 0,
            stepCount: 3,
            toolCallCount: 1,
            consecutiveToolErrors: 0,
            elapsedMs: 5000,
          },
        },
      },
      1,
    )
    const sess = s.sessions['s1']!
    expect(sess.running).toBe(false)
    expect(sess.lastResult?.reason).toBe('completed')
    expect(sess.lastResult?.metrics.totalTokens).toBe(250)
  })
})

describe('reduceSignal: approval / ask_user / artifact / log', () => {
  it('approval request enters pendingRequests and timeline', () => {
    let s = blank()
    s = reduceSignal(
      s,
      { kind: 'approval', requestId: 'r1', payload: { toolName: 'write', args: {}, reason: 'fs' }, sessionId: 's1' },
      1,
    )
    expect(s.pendingRequests).toHaveLength(1)
    expect(s.sessions['s1']!.timeline[0].kind).toBe('approval')
  })

  it('ask_user enters pendingRequests', () => {
    let s = blank()
    s = reduceSignal(
      s,
      { kind: 'ask_user', requestId: 'r2', payload: { questions: [{ question: 'Q?' }] }, sessionId: 's1' },
      1,
    )
    expect(s.pendingRequests[0].kind).toBe('ask_user')
  })

  it('artifact upserts by id', () => {
    let s = blank()
    s = reduceSignal(s, { kind: 'artifact', sessionId: 's1', handle: { id: 'a1', kind: 'markdown', title: 'T', source: 'wiki', at: 1 } }, 1)
    s = reduceSignal(s, { kind: 'artifact', sessionId: 's1', handle: { id: 'a1', kind: 'html', title: 'T2', source: 'wiki', at: 2 } }, 2)
    const arts = s.sessions['s1']!.artifacts
    expect(arts).toHaveLength(1)
    expect(arts[0].title).toBe('T2')
  })

  it('log accumulates into the global ring (cap 1000)', () => {
    let s = blank()
    for (let i = 0; i < 1200; i++) {
      s = reduceSignal(s, { kind: 'log', level: 'info', msg: `m${i}`, ts: i }, i + 1)
    }
    expect(s.logs).toHaveLength(1000)
    expect(s.logs[0].msg).toBe('m200')
    expect(s.logs[999].msg).toBe('m1199')
  })

  it('session.event system.prompt is captured', () => {
    let s = blank()
    s = reduceSignal(s, { kind: 'session.event', sessionId: 's1', event: 'system.prompt', data: { text: 'You are...' } }, 1)
    expect(s.sessions['s1']!.systemPrompt).toBe('You are...')
  })
})

describe('reduceSignal: session.event tools (v0.28 工具自描述清单)', () => {
  const toolsSig = (data: unknown): GateSignal => ({ kind: 'session.event', sessionId: 's1', event: 'tools', data })

  it('stores the tools inventory and pushes a timeline entry', () => {
    let s = blank()
    s = reduceSignal(
      s,
      toolsSig({ tools: [{ name: 'read', description: 'read a file' }, { name: 'edit', description: 'edit a file' }] }),
      1,
    )
    const sess = s.sessions['s1']!
    expect(sess.tools).toEqual([
      { name: 'read', description: 'read a file' },
      { name: 'edit', description: 'edit a file' },
    ])
    expect(sess.timeline).toHaveLength(1)
    expect(sess.timeline[0]).toMatchObject({ kind: 'session.event', detail: 'tools' })
  })

  it('data without tools keeps the existing inventory; timeline still recorded', () => {
    let s = blank()
    s = reduceSignal(s, toolsSig({ tools: [{ name: 'read', description: 'r' }] }), 1)
    s = reduceSignal(s, toolsSig(undefined), 2)
    const sess = s.sessions['s1']!
    expect(sess.tools).toEqual([{ name: 'read', description: 'r' }])
    expect(sess.timeline).toHaveLength(2)
  })

  it('system.prompt branch is unaffected (both events land on the same session)', () => {
    let s = blank()
    s = reduceSignal(s, { kind: 'session.event', sessionId: 's1', event: 'system.prompt', data: { text: 'You are...' } }, 1)
    s = reduceSignal(s, toolsSig({ tools: [{ name: 'read', description: 'r' }] }), 2)
    const sess = s.sessions['s1']!
    expect(sess.systemPrompt).toBe('You are...')
    expect(sess.tools).toEqual([{ name: 'read', description: 'r' }])
    expect(sess.timeline.map((e) => e.detail)).toEqual(['system.prompt', 'tools'])
  })
})

describe('reduceSignal: permission.changed（per-session 权限推送）', () => {
  const permSig = (full: boolean, sessionId = 's1'): GateSignal => ({
    kind: 'permission.changed',
    sessionId,
    full,
  })

  it('updates permissionFull of the target session only; unknown sessions default false', () => {
    let s = blank()
    s = reduceSignal(s, permSig(true, 's1'), 1)
    s = reduceSignal(s, permSig(true, 's2'), 2)
    expect(s.sessions['s1']!.permissionFull).toBe(true)
    expect(s.sessions['s2']!.permissionFull).toBe(true)

    // 只关 s1：s2 不受影响（每会话权限独立）。
    s = reduceSignal(s, permSig(false, 's1'), 3)
    expect(s.sessions['s1']!.permissionFull).toBe(false)
    expect(s.sessions['s2']!.permissionFull).toBe(true)
    // timeline 记录台账。
    expect(s.sessions['s1']!.timeline.at(-1)).toMatchObject({ kind: 'permission.changed' })
  })
})

describe('reduceSignal: workflow.changed / workflow.run（per-session LongHorizon 投影）', () => {
  const state = {
    version: 1 as const,
    sessionId: 's1',
    enabled: true,
    phase: 'ready' as const,
    skillActive: true,
    baseline: { status: 'completed' as const, completedRoles: ['structure' as const] },
    evidenceCount: 2,
    updatedAt: 1,
  }

  it('只更新目标 session，运行事件进入该 session 台账', () => {
    let s = blank()
    s = reduceSignal(s, { kind: 'workflow.changed', sessionId: 's1', state }, 1)
    s = reduceSignal(s, { kind: 'workflow.run', sessionId: 's1', event: { runId: 'r1', mode: 'baseline', phase: 'started' } }, 2)
    expect(s.sessions['s1']!.workflow).toEqual(state)
    expect(s.sessions['s2']).toBeUndefined()
    expect(s.sessions['s1']!.timeline.map((e) => e.kind)).toEqual(['workflow.changed', 'workflow.run'])
  })
})

describe('reduceSignal: memory.activity（v0.30 上下文压缩 / M3 归档展示，live-only）', () => {
  const memSig = (activity: string, detail?: unknown): GateSignal => ({
    kind: 'memory.activity',
    sessionId: 's1',
    activity,
    ...(detail !== undefined ? { detail } : {}),
  })

  it('memory.compressed：items 尾部追加 memory 条目 + timeline 台账', () => {
    let s = blank()
    s = reduceSignal(s, delta('working'), 1)
    s = reduceSignal(s, memSig('memory.compressed', { layer: 'M1/M2', stamp: 'st-1', taskGoal: '整理日志' }), 2)
    const sess = s.sessions['s1']!
    expect(sess.items).toHaveLength(2)
    const mem = sess.items[1] as MemoryItemView
    expect(mem.type).toBe('memory')
    expect(mem.id).toBe('memory-2')
    expect(mem.activity).toBe('memory.compressed')
    expect(mem.layer).toBe('M1/M2')
    expect(mem.taskGoal).toBe('整理日志')
    expect(sess.timeline[1]).toMatchObject({ kind: 'memory.activity' })
  })

  it('timeline detail 丰富为 activity · layer · taskGoal 形态', () => {
    let s = blank()
    s = reduceSignal(s, memSig('memory.compressed', { layer: 'M1/M2', stamp: 'st-1', taskGoal: '七擒七放' }), 1)
    expect(s.sessions['s1']!.timeline[0].detail).toBe('memory.compressed · M1/M2 · 七擒七放')
  })

  it('memory.archived：M3 归档形态（layer=M3）', () => {
    let s = blank()
    s = reduceSignal(
      s,
      memSig('memory.archived', { layer: 'M3', stamp: 'st-9', taskGoal: '归档摘要文本' }),
      1,
    )
    const mem = s.sessions['s1']!.items[0] as MemoryItemView
    expect(mem.activity).toBe('memory.archived')
    expect(mem.layer).toBe('M3')
    expect(mem.taskGoal).toBe('归档摘要文本')
    expect(s.sessions['s1']!.timeline[0].detail).toBe('memory.archived · M3 · 归档摘要文本')
  })

  it('detail 缺失：timeline detail 降级为 activity 本身，item 字段为空串', () => {
    let s = blank()
    s = reduceSignal(s, memSig('memory.compressed'), 1)
    expect(s.sessions['s1']!.timeline[0].detail).toBe('memory.compressed')
    const mem = s.sessions['s1']!.items[0] as MemoryItemView
    expect(mem.layer).toBe('')
    expect(mem.taskGoal).toBe('')
  })

  it('live-only：applyHistoryItems 整体替换冲掉 memory 条目（有意行为，不重建）', () => {
    let s = blank()
    s = reduceSignal(s, memSig('memory.compressed', { layer: 'M1/M2', stamp: 'st', taskGoal: 'g' }), 1)
    const current: ChatItem[] = s.sessions['s1']!.items
    const turns: ConversationTurn[] = [{ id: 'u1', role: 'user', content: 'hi', at: 1 }]
    const items = applyHistoryItems(current, turns)
    expect(items.some((i) => i.type === 'memory')).toBe(false)
    expect(items).toEqual(historyToItems(turns))
  })
})

describe('historyToItems', () => {
  it('joins assistant toolCalls with tool results by callId (OpenAI ToolCall shape)', () => {
    const turns: ConversationTurn[] = [
      { id: 'u1', role: 'user', content: 'write a file', at: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: 'I will write it.',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'write', arguments: '{"path":"a.txt"}' } }],
        at: 2,
      },
      { id: 't1', role: 'tool', toolCallId: 'c1', content: 'wrote', sourceAgentId: 'main', at: 3 },
      { id: 'a2', role: 'assistant', content: 'Done.', at: 4 },
    ]
    const items = historyToItems(turns)
    expect(items).toHaveLength(3)
    const [user, turn1, turn2] = items
    expect(user.type).toBe('user')
    expect((user as { text: string }).text).toBe('write a file')
    const t1 = turn1 as TurnView
    expect(t1.toolCalls['c1'].name).toBe('write')
    expect(t1.toolCalls['c1'].args).toEqual({ path: 'a.txt' })
    expect(t1.toolCalls['c1'].result).toBe('wrote')
    expect(t1.recovered).toBe(true)
    expect((turn2 as TurnView).text).toBe('Done.')
  })

  it('tool turn after user message (no preceding assistant) is dropped safely', () => {
    const turns: ConversationTurn[] = [
      { id: 'u1', role: 'user', content: 'hi', at: 1 },
      { id: 't1', role: 'tool', toolCallId: 'cx', content: 'orphan', sourceAgentId: 'main', at: 2 },
    ]
    const items = historyToItems(turns)
    expect(items).toHaveLength(1)
  })

  it('思维链落盘：历史 assistant 回合的 reasoning 投影为 thinking（恢复后折叠块可见）', () => {
    const turns: ConversationTurn[] = [
      {
        id: 'a1', role: 'assistant', content: '答案是 42。',
        reasoning: '分析请求：直接回答即可。', at: 1,
      },
      { id: 'a2', role: 'assistant', content: '无思考的旧回合', at: 2 },
    ]
    const items = historyToItems(turns)
    expect((items[0] as TurnView).thinking).toBe('分析请求：直接回答即可。')
    expect((items[1] as TurnView).thinking).toBe('')
  })
})

describe('applyHistoryItems（resync 窗口：未确认 local- 条目保护）', () => {
  const localUser = (id: string, text: string): UserMessageView => ({ type: 'user', id, text })

  it('窗口场景：history 无该 user 回合 → local- 保留在末尾（不暂隐）', () => {
    const current: ChatItem[] = [
      localUser('local-1', 'hello'),
      { type: 'turn', turnId: 'stale', text: 'stale', thinking: '', toolCalls: {}, toolCallOrder: [] },
    ]
    const turns: ConversationTurn[] = [
      { id: 'u0', role: 'user', content: 'earlier', at: 1 },
      { id: 'a0', role: 'assistant', content: 'ok', at: 2 },
    ]
    const items = applyHistoryItems(current, turns)
    expect(items.map((i) => i.type)).toEqual(['user', 'turn', 'user'])
    const kept = items[2] as UserMessageView
    expect(kept).toMatchObject({ id: 'local-1', text: 'hello' })
    // stale turn 仍被整体替换冲掉（v0.24 语义不变）。
    expect(items.some((i) => i.type === 'turn' && i.turnId === 'stale')).toBe(false)
  })

  it('正常场景：history 有同 content user 回合 → local- 清除、单副本', () => {
    const current: ChatItem[] = [
      localUser('local-1', 'hello'),
      { type: 'turn', turnId: 'stale', text: 'x', thinking: '', toolCalls: {}, toolCallOrder: [] },
    ]
    const turns: ConversationTurn[] = [
      { id: 'u1', role: 'user', content: 'hello', at: 1 },
      { id: 'a1', role: 'assistant', content: 'done', at: 2 },
    ]
    const items = applyHistoryItems(current, turns)
    expect(items).toEqual(historyToItems(turns))
    expect(items.filter((i) => i.type === 'user')).toHaveLength(1)
    expect((items[0] as UserMessageView).id).toBe('u1')
  })

  it('同文本两条：history 只确认一条 → 剩一条真 + 一条 local-（数量对齐）', () => {
    const current: ChatItem[] = [
      localUser('local-1', 'ping'),
      localUser('local-2', 'ping'),
    ]
    const turns: ConversationTurn[] = [
      { id: 'u1', role: 'user', content: 'ping', at: 1 },
      { id: 'a1', role: 'assistant', content: 'reply', at: 2 },
    ]
    const items = applyHistoryItems(current, turns)
    const users = items.filter((i): i is UserMessageView => i.type === 'user')
    expect(users).toHaveLength(2)
    expect(users[0]).toMatchObject({ id: 'u1' })
    // 未确认差额保留 send 顺序末尾的那条。
    expect(users[1]).toMatchObject({ id: 'local-2', text: 'ping' })
  })

  it('同文本两条 + 既有真条目：旧的真 user 条目不参与抵消新 local-', () => {
    const current: ChatItem[] = [
      { type: 'user', id: 'u0', text: 'ping' },
      localUser('local-1', 'ping'),
      localUser('local-2', 'ping'),
    ]
    // 快照确认了旧真条目 + 第一条 local- 对应的回合 → 剩第二条 local-。
    const turns: ConversationTurn[] = [
      { id: 'u0', role: 'user', content: 'ping', at: 1 },
      { id: 'u1', role: 'user', content: 'ping', at: 2 },
      { id: 'a1', role: 'assistant', content: 'reply', at: 3 },
    ]
    const items = applyHistoryItems(current, turns)
    const users = items.filter((i): i is UserMessageView => i.type === 'user')
    expect(users).toHaveLength(3)
    expect(users.map((u) => u.id)).toEqual(['u0', 'u1', 'local-2'])
  })

  it('无 local- 条目时与纯整体替换严格相等（既有语义零回归）', () => {
    const turns: ConversationTurn[] = [
      { id: 'u1', role: 'user', content: 'write a file', at: 1 },
      { id: 'a1', role: 'assistant', content: 'I will write it.', at: 2 },
      { id: 't1', role: 'tool', toolCallId: 'c1', content: 'wrote', sourceAgentId: 'main', at: 3 },
    ]
    expect(applyHistoryItems([], turns)).toEqual(historyToItems(turns))
  })
})

describe('reduceSignal: in-flight turnId 生命周期（mid-turn resync 感知，语义对齐 CLI session-view.ts）', () => {
  const toolStarted = (turnId: string, callId: string): GateSignal => ({
    kind: 'tool.started', sessionId: 's1', turnId, toolName: 'read', callId, args: {},
  })
  const toolResult = (turnId: string, callId: string): GateSignal => ({
    kind: 'tool.result', sessionId: 's1', turnId, toolName: 'read', callId,
    result: { id: 't1', role: 'tool', toolCallId: callId, content: 'ok', sourceAgentId: 'main', at: 1 },
  })
  const turnEnd = (): GateSignal => ({
    kind: 'turn.end',
    sessionId: 's1',
    result: {
      terminated: false, reason: 'completed', finalState: 'Running', hits: [], turns: 2,
      metrics: { lastRequestTokens: 1, totalTokens: 2, promptTokens: 1, completionTokens: 1, stepCount: 1, toolCallCount: 0, reasoningTokens: 0, consecutiveToolErrors: 0, elapsedMs: 10 },
    },
  })

  it('assistant/thinking delta 加入；tool.started/tool.result 移除；turn.end 清空', () => {
    let s = blank()
    s = reduceSignal(s, delta('a', 'turn-1'), 1)
    s = reduceSignal(s, { kind: 'thinking.delta', sessionId: 's1', turnId: 'turn-1', text: 't' }, 2)
    s = reduceSignal(s, delta('b', 'turn-2'), 3)
    expect([...s.sessions['s1']!.inFlightTurnIds!].sort()).toEqual(['turn-1', 'turn-2'])

    // 工具信号到达 = 该轮正文已被 finalizeRound 持久化 → 移出在途集合。
    s = reduceSignal(s, toolStarted('turn-1', 'c1'), 4)
    expect([...s.sessions['s1']!.inFlightTurnIds!]).toEqual(['turn-2'])
    s = reduceSignal(s, toolResult('turn-1', 'c1'), 5)
    expect([...s.sessions['s1']!.inFlightTurnIds!]).toEqual(['turn-2'])

    // turn.end 清空（此后同 turnId 的迟到 delta 视为新一轮）。
    s = reduceSignal(s, turnEnd(), 6)
    expect(s.sessions['s1']!.inFlightTurnIds!.size).toBe(0)
  })

  it('纯函数纪律：旧 state 持有的 Set 不被原地修改', () => {
    let s = blank()
    s = reduceSignal(s, delta('a', 'turn-1'), 1)
    const before = s.sessions['s1']!.inFlightTurnIds!
    s = reduceSignal(s, delta('b', 'turn-2'), 2)
    expect(before.has('turn-2')).toBe(false)
    expect([...s.sessions['s1']!.inFlightTurnIds!].sort()).toEqual(['turn-1', 'turn-2'])
  })
})

describe('applyHistoryItems（mid-turn resync：in-flight 流式尾部保护）', () => {
  const partial = (text: string): TurnView => ({
    type: 'turn', turnId: 'turn-2', text, thinking: '', toolCalls: {}, toolCallOrder: [],
  })

  it('流式中 resync：in-flight 条目保留在历史之后；已完成轮次由 history 重建不重复', () => {
    const current: ChatItem[] = [
      { type: 'user', id: 'u1', text: 'go' },
      {
        type: 'turn', turnId: 'turn-1', text: 'round one', thinking: '',
        toolCalls: { c1: { callId: 'c1', name: 'read', args: {}, pending: false } },
        toolCallOrder: ['c1'],
      },
      partial('par'),
    ]
    // 快照只含已完成的 turn-1 轮（canonical 尚无 turn-2——assistant 回合在
    // finalizeRound 才落盘）。
    const turns: ConversationTurn[] = [
      { id: 'u1', role: 'user', content: 'go', at: 1 },
      {
        id: 'turn-1', role: 'assistant', content: 'round one',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }], at: 2,
      },
      { id: 't1', role: 'tool', toolCallId: 'c1', content: 'ok', sourceAgentId: 'main', at: 3 },
    ]
    const items = applyHistoryItems(current, turns, new Set(['turn-2']))

    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ type: 'user', id: 'u1' })
    // 已完成轮次：history 重建版（recovered + 工具结果 join），live 副本被冲掉、不重复。
    const done = items[1] as TurnView
    expect(done.recovered).toBe(true)
    expect(done.toolCalls['c1'].result).toBe('ok')
    expect(items.filter((i) => i.type === 'turn' && i.turnId === 'turn-1')).toHaveLength(1)
    // partial 正文保留（修复前：被整体替换冲掉 → 后续 delta 从中途重建 → 截断）。
    expect(items[2]).toMatchObject({ type: 'turn', turnId: 'turn-2', text: 'par' })
  })

  it('turnId 不在 in-flight 集合的 live 条目照常被替换冲掉（v0.24 语义不变）', () => {
    const current: ChatItem[] = [partial('par')]
    const turns: ConversationTurn[] = [{ id: 'a1', role: 'assistant', content: 'done', at: 1 }]
    expect(applyHistoryItems(current, turns, new Set())).toEqual(historyToItems(turns))
  })

  it('无在途（缺省第三参）时与纯整体替换严格相等（零回归）', () => {
    const current: ChatItem[] = [
      { type: 'user', id: 'u1', text: 'go' },
      partial('par'),
    ]
    const turns: ConversationTurn[] = [
      { id: 'u1', role: 'user', content: 'go', at: 1 },
      { id: 'a1', role: 'assistant', content: 'done', at: 2 },
    ]
    expect(applyHistoryItems(current, turns)).toEqual(historyToItems(turns))
  })

  it('与 local- 保护叠加：local- 在流式 turn 之前 → 相对顺序保留', () => {
    const current: ChatItem[] = [
      { type: 'user', id: 'u0', text: 'earlier' },
      { type: 'user', id: 'local-1', text: 'mid-turn msg' },
      partial('par'),
    ]
    const turns: ConversationTurn[] = [
      { id: 'u0', role: 'user', content: 'earlier', at: 1 },
      { id: 'a0', role: 'assistant', content: 'ok', at: 2 },
    ]
    const items = applyHistoryItems(current, turns, new Set(['turn-2']))
    expect(items.map((i) => (i.type === 'turn' ? i.turnId : i.type))).toEqual(['user', 'a0', 'user', 'turn-2'])
    expect(items[2]).toMatchObject({ id: 'local-1', text: 'mid-turn msg' })
    expect(items[3]).toMatchObject({ turnId: 'turn-2', text: 'par' })
  })

  it('与 local- 保护叠加：local- 在流式 turn 之后 → 相对顺序仍保留（不颠倒）', () => {
    const current: ChatItem[] = [
      partial('par'),
      { type: 'user', id: 'local-1', text: 'mid-turn msg' },
    ]
    const turns: ConversationTurn[] = [
      { id: 'u0', role: 'user', content: 'earlier', at: 1 },
      { id: 'a0', role: 'assistant', content: 'ok', at: 2 },
    ]
    const items = applyHistoryItems(current, turns, new Set(['turn-2']))
    expect(items.map((i) => (i.type === 'turn' ? i.turnId : i.type))).toEqual(['user', 'a0', 'turn-2', 'user'])
    expect(items[3]).toMatchObject({ id: 'local-1', text: 'mid-turn msg' })
  })
})
