// resync 恢复缝隙（v0.24 缝隙 A）装配级测试：pullHistory 对内存中已有 items 的
// 会话也无条件整体替换——旧逻辑「items 非空就不拉」会让 resync 后内存尚在的
// 会话丢失断线/重启期间的变更。App.tsx 装配层此前零覆盖，这里提取的 pullHistory
// 是 onResync 恢复路径的可单测单元（gate 已删除，无 shouldResyncHistory 决策）。
// v0.29 追加：整体替换时对 resync 微小窗口内尚未落盘的 local- 乐观 user 条目
// 做 content 数量对齐保护（详见 session-store.applyHistoryItems）。

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/api/token', () => ({ command: vi.fn(), readToken: vi.fn() }))

import { command } from '../src/api/token'
import { pullHistory } from '../src/App'
import { useSessionStore, type SessionView } from '../src/state/session-store'
import type { ConversationTurn, GateSignal } from '../src/api/contract'

const commandMock = vi.mocked(command)

beforeEach(() => {
  commandMock.mockReset()
  useSessionStore.setState({
    sessions: {},
    sessionList: [],
    logs: [],
    pendingRequests: [],
    activeSessionId: null,
  })
})

const seedSession = (items: SessionView['items']): void => {
  useSessionStore.setState({
    sessions: {
      s1: { permissionFull: false, queuedCount: 0, items, timeline: [], artifacts: [], running: false, inFlightTurnIds: new Set() },
    },
  })
}

describe('pullHistory（resync 恢复：无条件整体替换）', () => {
  it('items 非空的已加载会话也被整体替换，optimistic user 占位不重复', async () => {
    seedSession([
      { type: 'user', id: 'local-1', text: 'hello' },
      { type: 'turn', turnId: 'stale-turn', text: 'stale', thinking: '', toolCalls: {}, toolCallOrder: [] },
    ])
    const turns: ConversationTurn[] = [
      { id: 'u1', role: 'user', content: 'hello', at: 1 },
      { id: 'a1', role: 'assistant', content: 'done', at: 2 },
    ]
    commandMock.mockResolvedValue({ ok: true, result: turns })

    await pullHistory('s1')

    const items = useSessionStore.getState().sessions['s1']!.items
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ type: 'user', id: 'u1', text: 'hello' })
    expect(items.some((i) => i.type === 'user' && i.id === 'local-1')).toBe(false)
    expect(items.some((i) => i.type === 'turn' && i.turnId === 'stale-turn')).toBe(false)
    expect(commandMock).toHaveBeenCalledWith({ kind: 'session.history', sessionId: 's1' })
  })

  it('替换后 WS 增量经 turnId 继续命中（不产生重复 turn）', async () => {
    seedSession([{ type: 'user', id: 'local-1', text: 'hello' }])
    const turns: ConversationTurn[] = [
      { id: 'u1', role: 'user', content: 'hello', at: 1 },
      { id: 'a1', role: 'assistant', content: 'done', at: 2 },
    ]
    commandMock.mockResolvedValue({ ok: true, result: turns })

    await pullHistory('s1')
    useSessionStore.getState().handleSignal({ kind: 'assistant.delta', sessionId: 's1', turnId: 'a1', text: '!' })

    const items = useSessionStore.getState().sessions['s1']!.items
    expect(items).toHaveLength(2)
    expect(items[1]).toMatchObject({ type: 'turn', turnId: 'a1', text: 'done!' })
  })

  it('command 失败（ok:false）→ 本地 items 原样保留', async () => {
    seedSession([{ type: 'turn', turnId: 'keep', text: 'x', thinking: '', toolCalls: {}, toolCallOrder: [] }])
    commandMock.mockResolvedValue({ ok: false, error: 'session not found' })

    await pullHistory('s1')

    const items = useSessionStore.getState().sessions['s1']!.items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'turn', turnId: 'keep' })
  })
})

describe('pullHistory（resync 微小窗口：未确认 local- 条目保护）', () => {
  it('窗口场景：快照落在「已 optimistic append、后端未落盘 user 回合」之间 → local- 保留不暂隐', async () => {
    seedSession([
      { type: 'user', id: 'local-1', text: 'hello' },
      { type: 'turn', turnId: 'stale-turn', text: 'stale', thinking: '', toolCalls: {}, toolCallOrder: [] },
    ])
    // 快照里没有 local-1 对应的 user 回合（毫秒级窗口），只有更早的回合。
    const turns: ConversationTurn[] = [
      { id: 'u0', role: 'user', content: 'earlier', at: 1 },
      { id: 'a0', role: 'assistant', content: 'ok', at: 2 },
    ]
    commandMock.mockResolvedValue({ ok: true, result: turns })

    await pullHistory('s1')

    const items = useSessionStore.getState().sessions['s1']!.items
    expect(items.map((i) => i.type)).toEqual(['user', 'turn', 'user'])
    expect(items[2]).toMatchObject({ type: 'user', id: 'local-1', text: 'hello' })
    expect(items.some((i) => i.type === 'turn' && i.turnId === 'stale-turn')).toBe(false)
  })

  it('同文本两条：history 确认一条 → 剩一条真 + 一条 local-', async () => {
    seedSession([
      { type: 'user', id: 'local-1', text: 'ping' },
      { type: 'user', id: 'local-2', text: 'ping' },
    ])
    const turns: ConversationTurn[] = [
      { id: 'u1', role: 'user', content: 'ping', at: 1 },
      { id: 'a1', role: 'assistant', content: 'reply', at: 2 },
    ]
    commandMock.mockResolvedValue({ ok: true, result: turns })

    await pullHistory('s1')

    const items = useSessionStore.getState().sessions['s1']!.items
    const users = items.filter((i) => i.type === 'user')
    expect(users).toHaveLength(2)
    expect(users[0]).toMatchObject({ type: 'user', id: 'u1' })
    expect(users[1]).toMatchObject({ type: 'user', id: 'local-2', text: 'ping' })
  })

  it('正常场景回归：快照已确认 → local- 清除、单副本（不重复显示）', async () => {
    seedSession([{ type: 'user', id: 'local-1', text: 'hello' }])
    const turns: ConversationTurn[] = [
      { id: 'u1', role: 'user', content: 'hello', at: 1 },
      { id: 'a1', role: 'assistant', content: 'done', at: 2 },
    ]
    commandMock.mockResolvedValue({ ok: true, result: turns })

    await pullHistory('s1')

    const items = useSessionStore.getState().sessions['s1']!.items
    expect(items).toHaveLength(2)
    expect(items.filter((i) => i.type === 'user')).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'user', id: 'u1' })
  })
})

describe('pullHistory（mid-turn resync：in-flight 流式尾部保护）', () => {
  const turnEnd = (): GateSignal => ({
    kind: 'turn.end',
    sessionId: 's1',
    result: {
      terminated: false, reason: 'completed', finalState: 'Running', hits: [], turns: 1,
      metrics: { lastRequestTokens: 1, totalTokens: 2, promptTokens: 1, completionTokens: 1, reasoningTokens: 0, stepCount: 1, toolCallCount: 0, consecutiveToolErrors: 0, elapsedMs: 10 },
    },
  })

  it('流式中 resync → in-flight 条目保留 + 后续 delta 续写同一 item + turn.end 收敛', async () => {
    // 经 handleSignal 构造流式中途状态（turnId 生命周期与真实信号序一致）。
    useSessionStore.getState().handleSignal({ kind: 'assistant.delta', sessionId: 's1', turnId: 'turn-2', text: 'par' })
    expect(useSessionStore.getState().sessions['s1']!.inFlightTurnIds!.has('turn-2')).toBe(true)

    // resync：history 快照只含已完成轮次（canonical 尚无 turn-2）。
    const turns: ConversationTurn[] = [
      { id: 'u1', role: 'user', content: 'go', at: 1 },
      { id: 'turn-1', role: 'assistant', content: 'round one', at: 2 },
    ]
    commandMock.mockResolvedValue({ ok: true, result: turns })

    await pullHistory('s1')

    // user + turn-1（history 重建）+ turn-2（in-flight partial 保留）。
    let items = useSessionStore.getState().sessions['s1']!.items
    expect(items).toHaveLength(3)
    expect(items[1]).toMatchObject({ type: 'turn', turnId: 'turn-1', recovered: true })
    expect(items[2]).toMatchObject({ type: 'turn', turnId: 'turn-2', text: 'par' })

    // 后续 delta 续写同一 item（修复前：partial 被冲掉 → 从空重建 → 文本截断为 'tial'）。
    useSessionStore.getState().handleSignal({ kind: 'assistant.delta', sessionId: 's1', turnId: 'turn-2', text: 'tial' })
    items = useSessionStore.getState().sessions['s1']!.items
    expect(items).toHaveLength(3)
    expect(items[2]).toMatchObject({ turnId: 'turn-2', text: 'partial' })

    // turn.end 收敛：in-flight 清空、running=false、条目不重复。
    useSessionStore.getState().handleSignal(turnEnd())
    const sess = useSessionStore.getState().sessions['s1']!
    expect(sess.inFlightTurnIds!.size).toBe(0)
    expect(sess.running).toBe(false)
    expect(sess.items).toHaveLength(3)
  })

  it('与 local- 保护叠加：流式尾部 + 未确认 user 条目同时保留、相对顺序不变', async () => {
    useSessionStore.getState().appendLocalUserMessage('s1', 'mid-turn msg')
    useSessionStore.getState().handleSignal({ kind: 'assistant.delta', sessionId: 's1', turnId: 'turn-2', text: 'par' })

    // 快照里既没有 local-1 对应的 user 回合，也没有 turn-2。
    const turns: ConversationTurn[] = [
      { id: 'u0', role: 'user', content: 'earlier', at: 1 },
      { id: 'a0', role: 'assistant', content: 'ok', at: 2 },
    ]
    commandMock.mockResolvedValue({ ok: true, result: turns })

    await pullHistory('s1')

    const items = useSessionStore.getState().sessions['s1']!.items
    expect(items.map((i) => (i.type === 'turn' ? i.turnId : i.type))).toEqual(['user', 'a0', 'user', 'turn-2'])
    expect(items[2].type).toBe('user')
    expect((items[2] as { id: string }).id.startsWith('local-')).toBe(true)
    expect(items[2]).toMatchObject({ text: 'mid-turn msg' })
    expect(items[3]).toMatchObject({ turnId: 'turn-2', text: 'par' })
  })
})
