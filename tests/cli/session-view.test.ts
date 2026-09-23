// v0.26 Wave 2 — session-view reducer 单测。
//
// 核心测试：**实时信号回放 与 hydrateHistory 结构同构**（计划 §4.5 一条渲染
// 路径）——同一会话事实的两种到达方式必须产出 modulo ids 完全相同的 items。
// 其余：delta 累积 / 工具卡生命周期 / turn.end 统计 / setActiveSession /
// 审批按会话排队 / sessionId 分片隔离。

import { describe, expect, it } from 'vitest'
import type { IMLoopResult } from '../../src/im/loop.js'
import { createMetrics } from '../../src/shell/metrics.js'
import type { ApprovalRequest } from '../../src/im/tools/security/approval-store.js'
import type { ToolTurn } from '../../src/im/databus.js'
import type { ConversationTurn } from '../../src/im/conversation-memory.js'
import type { GateSignal, GateRequest } from '../../src/signals/types.js'
import {
  appendUserMessage,
  activeShard,
  applySignal,
  createSessionView,
  goalEventLabel,
  hydrateHistory,
  listSessions,
  pendingApprovalCount,
  pendingAskCount,
  setActiveSession,
  settleRequest,
  type SessionView,
  type ViewItem,
} from '../../cli/session-view.js'
import type { GoalEvent } from '../../src/im/goal/types.js'
import { subscribeToGate } from '../../cli/gate-subscription.js'
import { createSignalGate } from '../../src/signals/gate.js'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const loopResult = (over: Partial<IMLoopResult> = {}): IMLoopResult => ({
  terminated: false,
  reason: 'completed',
  finalState: 'Running',
  hits: [],
  turns: 1,
  metrics: createMetrics(),
  ...over,
})

const toolTurn = (over: Partial<ToolTurn> = {}): ToolTurn => ({
  id: 'tt-1',
  role: 'tool',
  toolCallId: 'call-1',
  content: 'ok',
  sourceAgentId: 'main',
  at: 1,
  ...over,
})

const approval = (toolName = 'write'): ApprovalRequest => ({
  toolName,
  args: { path: 'a.txt', content: 'hi' },
  reason: 'write requires approval',
})

const apply = (view: SessionView, sigs: Array<GateSignal | GateRequest>): SessionView => {
  for (const s of sigs) applySignal(view, s)
  return view
}

/** 比较 shape：剥掉 id 与 thinking。thinking 剥离有因：canonical 历史不持久化
 *  推理内容（ConversationTurn 无 thinking 字段，AGENTS.md §6.16 "thinking 不入
 *  持久层"待拍板项）——它是 live-only 的流，hydrate 无法也无需重建；思考流的
 *  渲染行为由上面的 thinking.delta 单测单独覆盖。 */
const normalize = (items: readonly ViewItem[]): unknown[] =>
  items.map((it) => {
    if (it.kind === 'user') return { kind: 'user', text: it.text }
    if (it.kind === 'assistant') return { kind: 'assistant', text: it.text }
    if (it.kind === 'memory') return { kind: 'memory', activity: it.activity, layer: it.layer, taskGoal: it.taskGoal }
    // v0.41：goal 变体携带整个 GoalEvent，原样带出供按 status 断言。
    if (it.kind === 'goal') return { kind: 'goal', event: it.event }
    return {
      kind: 'tool',
      toolName: it.toolName,
      status: it.status,
      args: it.args,
      result: it.result,
      producedPath: it.producedPath,
    }
  })

// ---------------------------------------------------------------------------
// delta 累积
// ---------------------------------------------------------------------------

describe('applySignal: assistant/thinking delta', () => {
  it('accumulates assistant.delta chunks into one assistant item per turnId', () => {
    const view = apply(createSessionView(), [
      { kind: 'assistant.delta', sessionId: 's1', turnId: 'turn-0', text: 'Hello ' },
      { kind: 'assistant.delta', sessionId: 's1', turnId: 'turn-0', text: 'world' },
    ])
    const shard = view.shards.get('s1')!
    expect(shard.items).toHaveLength(1)
    const item = shard.items[0]!
    expect(item.kind === 'assistant' && item.text).toBe('Hello world')
    expect(item.kind === 'assistant' && item.streaming).toBe(true)
  })

  it('thinking.delta fills the thinking buffer of the same turnId item', () => {
    const view = apply(createSessionView(), [
      { kind: 'thinking.delta', sessionId: 's1', turnId: 'turn-0', text: 'think' },
      { kind: 'assistant.delta', sessionId: 's1', turnId: 'turn-0', text: 'answer' },
    ])
    const item = view.shards.get('s1')!.items[0]!
    expect(item.kind === 'assistant' && item.thinking).toBe('think')
    expect(item.kind === 'assistant' && item.text).toBe('answer')
  })

  it('a new turnId (next LLM round) starts a new assistant item', () => {
    const view = apply(createSessionView(), [
      { kind: 'assistant.delta', sessionId: 's1', turnId: 'turn-0', text: 'round1' },
      { kind: 'assistant.delta', sessionId: 's1', turnId: 'turn-1', text: 'round2' },
    ])
    expect(view.shards.get('s1')!.items).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 工具卡生命周期
// ---------------------------------------------------------------------------

describe('applySignal: tool lifecycle', () => {
  it('tool.started creates a running card; tool.result settles it and extracts produced path', () => {
    const view = apply(createSessionView(), [
      { kind: 'tool.started', sessionId: 's1', turnId: 'turn-0', toolName: 'write', callId: 'call-1', args: null },
      {
        kind: 'tool.result',
        sessionId: 's1',
        turnId: 'turn-0',
        toolName: 'write',
        callId: 'call-1',
        result: toolTurn({ toolName: 'write', args: { path: 'src/a.txt', content: 'x' } }),
      },
    ])
    const card = view.shards.get('s1')!.items[0]!
    expect(card).toMatchObject({
      kind: 'tool',
      callId: 'call-1',
      toolName: 'write',
      status: 'success',
      args: { path: 'src/a.txt', content: 'x' },
      result: 'ok',
      producedPath: 'src/a.txt',
    })
  })

  it('isError settles the card as failure with no produced path', () => {
    const view = apply(createSessionView(), [
      { kind: 'tool.started', sessionId: 's1', turnId: 'turn-0', toolName: 'bash', callId: 'call-1', args: null },
      {
        kind: 'tool.result',
        sessionId: 's1',
        turnId: 'turn-0',
        toolName: 'bash',
        callId: 'call-1',
        result: toolTurn({ toolName: 'bash', isError: true, content: 'boom' }),
      },
    ])
    const card = view.shards.get('s1')!.items[0]!
    expect(card.kind === 'tool' && card.status).toBe('failure')
    expect(card.kind === 'tool' && card.producedPath).toBeUndefined()
  })

  it('non-producing tools never get a produced path even on success', () => {
    const view = apply(createSessionView(), [
      {
        kind: 'tool.result',
        sessionId: 's1',
        turnId: 'turn-0',
        toolName: 'grep',
        callId: 'call-1',
        result: toolTurn({ toolName: 'grep', args: { path: 'x' }, content: 'found' }),
      },
    ])
    const card = view.shards.get('s1')!.items[0]!
    expect(card.kind === 'tool' && card.status).toBe('success')
    expect(card.kind === 'tool' && card.producedPath).toBeUndefined()
  })

  it('counts tool.started into stats.toolCalls', () => {
    const view = apply(createSessionView(), [
      { kind: 'tool.started', sessionId: 's1', turnId: 'turn-0', toolName: 'write', callId: 'c1', args: null },
      { kind: 'tool.started', sessionId: 's1', turnId: 'turn-0', toolName: 'grep', callId: 'c2', args: null },
    ])
    expect(view.shards.get('s1')!.stats.toolCalls).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// turn.end
// ---------------------------------------------------------------------------

describe('applySignal: turn.end', () => {
  it('sets phase idle, closes streaming items, accumulates stats', () => {
    const view = apply(createSessionView(), [
      { kind: 'assistant.delta', sessionId: 's1', turnId: 'turn-0', text: 'hi' },
      { kind: 'turn.end', sessionId: 's1', result: loopResult({ turns: 2, metrics: { ...createMetrics(), totalTokens: 120, elapsedMs: 800 } }) },
    ])
    const shard = view.shards.get('s1')!
    expect(shard.phase).toBe('idle')
    expect(shard.items.every((it) => it.kind !== 'assistant' || !it.streaming)).toBe(true)
    expect(shard.stats).toMatchObject({ turnEnds: 1, loopTurns: 2, totalTokens: 120, elapsedMs: 800, lastReason: 'completed' })
  })

  it('accumulates across multiple turn.end events', () => {
    const view = apply(createSessionView(), [
      { kind: 'turn.end', sessionId: 's1', result: loopResult({ metrics: { ...createMetrics(), totalTokens: 10, elapsedMs: 100 } }) },
      { kind: 'turn.end', sessionId: 's1', result: loopResult({ metrics: { ...createMetrics(), totalTokens: 15, elapsedMs: 200 } }) },
    ])
    expect(view.shards.get('s1')!.stats).toMatchObject({ turnEnds: 2, totalTokens: 25, elapsedMs: 300 })
  })
})

// ---------------------------------------------------------------------------
// turn.queue（v0.34 C1：排队可见 + 接力时不得误报空闲）
// ---------------------------------------------------------------------------

describe('applySignal: turn.queue', () => {
  it('镜像后端广播的 pending 条数（权威投影，不自己推算）', () => {
    const view = apply(createSessionView(), [
      { kind: 'turn.queue', sessionId: 's1', pending: 1 },
      { kind: 'turn.queue', sessionId: 's1', pending: 3 },
      { kind: 'turn.queue', sessionId: 's1', pending: 0 },
    ])
    expect(view.shards.get('s1')!.queuedCount).toBe(0)
  })

  it('turn.end 时若仍有排队则**不置 idle**（gate 已把队首提升为在途并接力执行）', () => {
    const view = apply(createSessionView(), [
      { kind: 'turn.queue', sessionId: 's1', pending: 1 },
      { kind: 'turn.end', sessionId: 's1', result: loopResult() },
    ])
    const shard = view.shards.get('s1')!
    // turn.end 先于 turn.queue 派发 → 此刻 pending 仍是 1 → 接力回合在跑，必须保持 streaming
    expect(shard.phase).toBe('streaming')
  })

  it('无排队时 turn.end 正常置 idle', () => {
    const view = apply(createSessionView(), [
      { kind: 'turn.end', sessionId: 's1', result: loopResult() },
    ])
    expect(view.shards.get('s1')!.phase).toBe('idle')
  })

  it('取消丢弃排队后（pending 归零）turn.end 回到 idle，不卡在 streaming', () => {
    const view = apply(createSessionView(), [
      { kind: 'turn.queue', sessionId: 's1', pending: 2 },
      { kind: 'turn.queue', sessionId: 's1', pending: 0 }, // turn.cancel 的广播
      { kind: 'turn.end', sessionId: 's1', result: loopResult() },
    ])
    const shard = view.shards.get('s1')!
    expect(shard.queuedCount).toBe(0)
    expect(shard.phase).toBe('idle')
  })

  it('排队状态按会话分片隔离，不串台', () => {
    const view = apply(createSessionView(), [
      { kind: 'turn.queue', sessionId: 's1', pending: 2 },
    ])
    expect(view.shards.get('s1')!.queuedCount).toBe(2)
    expect(view.shards.has('s2')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// session.event / artifact / permission / log
// ---------------------------------------------------------------------------

describe('applySignal: session.event / artifact / log', () => {
  it('stores system.prompt text and arbitrary event data', () => {
    const view = apply(createSessionView(), [
      { kind: 'session.event', sessionId: 's1', event: 'system.prompt', data: { text: '你是助手' } },
      { kind: 'session.event', sessionId: 's1', event: 'tools', data: { tools: [{ name: 'write', description: '写文件' }] } },
    ])
    const shard = view.shards.get('s1')!
    expect(shard.systemPrompt).toBe('你是助手')
    expect(shard.events['tools']).toEqual({ tools: [{ name: 'write', description: '写文件' }] })
  })

  it('stores artifact handles and permission state', () => {
    const handle = { artifactId: 'a-1', title: 't', createdAt: 1 } as never
    const view = apply(createSessionView(), [
      { kind: 'artifact', sessionId: 's1', handle },
      { kind: 'permission.changed', sessionId: 's1', full: true },
    ])
    const shard = view.shards.get('s1')!
    expect(shard.artifacts).toHaveLength(1)
    expect(shard.permissionFull).toBe(true)
  })

  it('keeps a capped global log ring (log signals carry no sessionId)', () => {
    const view = createSessionView()
    for (let i = 0; i < 25; i++) {
      applySignal(view, { kind: 'log', level: 'info', msg: `m${i}`, ts: i })
    }
    expect(view.recentLogs).toHaveLength(20)
    expect(view.recentLogs[0]!.msg).toBe('m5')
  })
})

// ---------------------------------------------------------------------------
// memory.activity（v0.30 上下文压缩事件可见化）
// ---------------------------------------------------------------------------

describe('applySignal: memory.activity', () => {
  it('memory.compressed → items 尾部追加 memory 项（layer/taskGoal 正确投影）', () => {
    const view = apply(createSessionView(), [
      { kind: 'assistant.delta', sessionId: 's1', turnId: 'turn-0', text: '长任务回答' },
      {
        kind: 'memory.activity',
        sessionId: 's1',
        activity: 'memory.compressed',
        detail: { layer: 'M1/M2', stamp: 'stamp-1', taskGoal: '压缩前的任务目标' },
      },
    ])
    const items = view.shards.get('s1')!.items
    expect(items).toHaveLength(2)
    expect(items[1]).toEqual({ kind: 'memory', activity: 'memory.compressed', layer: 'M1/M2', taskGoal: '压缩前的任务目标' })
  })

  it('memory.archived → M3 归档项', () => {
    const view = apply(createSessionView(), [
      {
        kind: 'memory.activity',
        sessionId: 's1',
        activity: 'memory.archived',
        detail: { layer: 'M3', stamp: '2026-09-09', taskGoal: '已归档的早期任务' },
      },
    ])
    expect(view.shards.get('s1')!.items[0]).toEqual({
      kind: 'memory',
      activity: 'memory.archived',
      layer: 'M3',
      taskGoal: '已归档的早期任务',
    })
  })

  it('hydrateHistory 后 memory 项消失（live-only 语义固化成断言）', () => {
    const view = apply(createSessionView(), [
      {
        kind: 'memory.activity',
        sessionId: 's1',
        activity: 'memory.compressed',
        detail: { layer: 'M1/M2', stamp: 's', taskGoal: '早前任务' },
      },
    ])
    expect(view.shards.get('s1')!.items.map((it) => it.kind)).toEqual(['memory'])
    // session.history 不回放 StateLine 写入 → 整体重建 items 时标记自然消失，
    // 属预期行为（cli/session-view.ts hydrateHistory 注释），不做历史重建兜底。
    hydrateHistory(view, 's1', [{ id: 'u1', role: 'user', content: '新会话继续', at: 1 }])
    expect(view.shards.get('s1')!.items.map((it) => it.kind)).toEqual(['user'])
  })

  it('未知 activity/detail 形态不产生条目（契约外形态不渲染）', () => {
    const view = apply(createSessionView(), [
      { kind: 'memory.activity', sessionId: 's1', activity: 'memory.something-else' },
      { kind: 'memory.activity', sessionId: 's1', activity: 'memory.compressed', detail: 'not-an-object' },
    ])
    expect(view.shards.get('s1')!.items).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 审批 / 提问排队
// ---------------------------------------------------------------------------

describe('applySignal: approval / ask_user queues', () => {
  it('queues approval per session and pendingApprovalCount reflects it', () => {
    const view = apply(createSessionView(), [
      { kind: 'approval', requestId: 'r1', payload: approval(), sessionId: 's1' },
      { kind: 'approval', requestId: 'r2', payload: approval('bash'), sessionId: 's1' },
      { kind: 'approval', requestId: 'r3', payload: approval(), sessionId: 's2' },
    ])
    expect(pendingApprovalCount(view, 's1')).toBe(2)
    expect(pendingApprovalCount(view, 's2')).toBe(1)
    expect(pendingApprovalCount(view)).toBe(3)
    expect(view.shards.get('s1')!.pendingRequests[0]!.requestId).toBe('r1')
  })

  it('ask_user queues separately and does not count as approval', () => {
    const view = apply(createSessionView(), [
      { kind: 'ask_user', requestId: 'q1', payload: { questions: [{ question: '继续吗?' }] }, sessionId: 's1' },
    ])
    expect(pendingAskCount(view, 's1')).toBe(1)
    expect(pendingApprovalCount(view, 's1')).toBe(0)
  })

  it('request without sessionId routes to the active session', () => {
    const view = setActiveSession(apply(createSessionView(), []), 's1')
    applySignal(view, { kind: 'approval', requestId: 'r1', payload: approval() })
    expect(view.shards.get('s1')!.pendingRequests).toHaveLength(1)
  })

  it('settleRequest removes the answered request; unknown id is a no-op', () => {
    const view = apply(createSessionView(), [
      { kind: 'approval', requestId: 'r1', payload: approval(), sessionId: 's1' },
    ])
    settleRequest(view, 's1', 'rX')
    expect(pendingApprovalCount(view, 's1')).toBe(1)
    settleRequest(view, 's1', 'r1')
    expect(pendingApprovalCount(view, 's1')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// setActiveSession + 分片隔离（G6）
// ---------------------------------------------------------------------------

describe('setActiveSession + sessionId sharding', () => {
  it('switches active shard without touching other shards', () => {
    const view = apply(createSessionView(), [
      { kind: 'assistant.delta', sessionId: 's1', turnId: 'turn-0', text: 'A is typing' },
    ])
    setActiveSession(view, 's2')
    expect(view.activeSessionId).toBe('s2')
    // s1 的在途流未被切会话影响。
    const s1First = view.shards.get('s1')!.items[0]!
    expect(s1First.kind === 'assistant' && s1First.streaming).toBe(true)
    // s2 拿到空分片（渲染层立刻有东西可画）。
    expect(view.shards.get('s2')).toMatchObject({ phase: 'idle', hydrated: false, items: [] })
  })

  it('signals for session A never mutate session B', () => {
    const view = apply(createSessionView(), [
      { kind: 'assistant.delta', sessionId: 'A', turnId: 't', text: 'aaa' },
      { kind: 'tool.started', sessionId: 'B', turnId: 't', toolName: 'grep', callId: 'cb', args: null },
      { kind: 'assistant.delta', sessionId: 'B', turnId: 't', text: 'bbb' },
      { kind: 'turn.end', sessionId: 'A', result: loopResult() },
    ])
    const a = view.shards.get('A')!
    const b = view.shards.get('B')!
    expect(a.items.map((it) => it.kind)).toEqual(['assistant'])
    expect(a.stats.turnEnds).toBe(1)
    expect(b.stats.turnEnds).toBe(0)
    expect(b.items.map((it) => it.kind)).toEqual(['tool', 'assistant'])
  })

  it('helpers: listSessions in first-seen order, activeShard', () => {
    const view = apply(createSessionView(), [
      { kind: 'assistant.delta', sessionId: 'A', turnId: 't', text: 'x' },
      { kind: 'assistant.delta', sessionId: 'B', turnId: 't', text: 'y' },
    ])
    expect(listSessions(view)).toEqual(['A', 'B'])
    setActiveSession(view, 'B')
    expect(activeShard(view)!.sessionId).toBe('B')
    expect(activeShard(createSessionView())).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// hydrateHistory
// ---------------------------------------------------------------------------

describe('hydrateHistory', () => {
  it('marks the shard hydrated + idle (never streaming)', () => {
    const view = hydrateHistory(createSessionView(), 's1', [])
    const shard = view.shards.get('s1')!
    expect(shard.hydrated).toBe(true)
    expect(shard.phase).toBe('idle')
    expect(shard.items).toEqual([])
  })

  it('rebuilds user/assistant/tool items from canonical turns', () => {
    const turns: ConversationTurn[] = [
      { id: 'u1', role: 'user', content: '帮我写文件', at: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: '好的',
        toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'write', arguments: '{"path":"a.txt"}' } }],
        at: 2,
      },
      toolTurn({ id: 't1', toolCallId: 'call-1', content: 'written', toolName: 'write', args: { path: 'a.txt' } }),
    ]
    const view = hydrateHistory(createSessionView(), 's1', turns)
    expect(view.shards.get('s1')!.items.map((it) => it.kind)).toEqual(['user', 'assistant', 'tool'])
    const card = view.shards.get('s1')!.items[2]!
    expect(card).toMatchObject({
      kind: 'tool',
      callId: 'call-1',
      toolName: 'write',
      status: 'success',
      args: { path: 'a.txt' },
      result: 'written',
      producedPath: 'a.txt',
    })
  })

  it('extracts user text from ContentPart[] user turns', () => {
    const turns: ConversationTurn[] = [
      { id: 'u1', role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image_url', image_url: { url: 'data:...' } }], at: 1 },
    ]
    const view = hydrateHistory(createSessionView(), 's1', turns)
    expect(view.shards.get('s1')!.items[0]).toEqual({ kind: 'user', id: 'u1', text: '看这张图' })
  })

  it('KEY TEST: live signal replay and hydrateHistory are structurally equal (modulo ids)', () => {
    // 同一会话事实：用户问 → 助手思考+回答 → write 工具成功（产物 a.txt）→ 回合完成。
    const live = createSessionView()
    appendUserMessage(live, 's1', '帮我写文件')
    apply(live, [
      { kind: 'thinking.delta', sessionId: 's1', turnId: 'turn-0', text: '需要调用 write' },
      { kind: 'assistant.delta', sessionId: 's1', turnId: 'turn-0', text: '好的，' },
      { kind: 'assistant.delta', sessionId: 's1', turnId: 'turn-0', text: '这就写。' },
      { kind: 'tool.started', sessionId: 's1', turnId: 'turn-0', toolName: 'write', callId: 'call-1', args: null },
      {
        kind: 'tool.result',
        sessionId: 's1',
        turnId: 'turn-0',
        toolName: 'write',
        callId: 'call-1',
        result: toolTurn({ content: 'written', toolName: 'write', args: { path: 'a.txt' } }),
      },
      { kind: 'assistant.delta', sessionId: 's1', turnId: 'turn-1', text: '写好了。' },
      {
        kind: 'turn.end',
        sessionId: 's1',
        result: loopResult({ turns: 2, metrics: { ...createMetrics(), totalTokens: 99, elapsedMs: 500 } }),
      },
    ])

    const hydrated = hydrateHistory(createSessionView(), 's1', [
      { id: 'u1', role: 'user', content: '帮我写文件', at: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: '好的，这就写。',
        toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'write', arguments: '{"path":"a.txt"}' } }],
        at: 2,
      },
      toolTurn({ id: 't1', toolCallId: 'call-1', content: 'written', toolName: 'write', args: { path: 'a.txt' } }),
      { id: 'a2', role: 'assistant', content: '写好了。', at: 3 },
    ] satisfies ConversationTurn[])

    const liveShard = live.shards.get('s1')!
    const hydShard = hydrated.shards.get('s1')!
    // 条目序列同构：live 的 assistant turn-0（思考+两段 delta + 工具卡）与
    // hydrate 的 a1 + toolCall 卡一一对应；turn-1 与 a2 对应。
    expect(normalize(liveShard.items)).toEqual(normalize(hydShard.items))
    // hydrate 后不是 streaming；live 回放经 turn.end 也回到 idle——两条路径
    // 的终态 phase 一致。（live-only 例外：hydrate 落在在途回合**中间**时，
    // 流式尾部保留 + phase 保持 streaming——见下方"在途回合"describe；本测
    // 试的回放以 turn.end 收口，不涉及该例外。）
    expect(hydShard.phase).toBe('idle')
    expect(hydShard.hydrated).toBe(true)
    expect(liveShard.phase).toBe('idle')
  })
})

// ---------------------------------------------------------------------------
// hydrateHistory × 在途回合（G6 /resume 修复）
// ---------------------------------------------------------------------------

describe('hydrateHistory × 在途回合（G6：hydrate 只补历史，不杀在途状态）', () => {
  /** 已持久化的 canonical 历史：user → assistant(正文+工具调用) → 工具结果。 */
  const historyTurns = (): ConversationTurn[] => [
    { id: 'u1', role: 'user', content: '帮我查一下', at: 1 },
    {
      id: 'a1',
      role: 'assistant',
      content: '先查一下。',
      toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } }],
      at: 2,
    },
    toolTurn({ id: 't1', toolCallId: 'call-1', content: 'found', toolName: 'grep' }),
  ]

  /** 在途回合的 live 前缀：轮 0 已完成（正文+工具已收口），轮 1 正在流。 */
  const inFlightView = (): SessionView => {
    const view = createSessionView()
    appendUserMessage(view, 's1', '帮我查一下')
    apply(view, [
      { kind: 'assistant.delta', sessionId: 's1', turnId: 'turn-0', text: '先查一下。' },
      { kind: 'tool.started', sessionId: 's1', turnId: 'turn-0', toolName: 'grep', callId: 'call-1', args: null },
      {
        kind: 'tool.result',
        sessionId: 's1',
        turnId: 'turn-0',
        toolName: 'grep',
        callId: 'call-1',
        result: toolTurn({ content: 'found', toolName: 'grep' }),
      },
      { kind: 'thinking.delta', sessionId: 's1', turnId: 'turn-1', text: '整理结论' },
      { kind: 'assistant.delta', sessionId: 's1', turnId: 'turn-1', text: '根据结果，' },
    ])
    return view
  }

  it('① 在途 turn：流式尾部保留 + phase 保持 streaming + 已持久化轮次不重复', () => {
    const view = inFlightView()
    // 在途集合只含"正文可能尚未持久化"的 turn-1（轮 0 已被工具信号移除）。
    expect(view.shards.get('s1')!.inFlightTurnIds).toEqual(new Set(['turn-1']))

    hydrateHistory(view, 's1', historyTurns())
    const shard = view.shards.get('s1')!
    expect(shard.hydrated).toBe(true)
    // phase 不被 hydrate 重置——run 还在 streaming（审批浮层判定 / Ctrl-C
    // 语义 / 状态栏都依赖它）。
    expect(shard.phase).toBe('streaming')
    // 序列：历史重建（user / assistant / tool）+ 在途尾部（turn-1）。
    expect(shard.items.map((it) => it.kind)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    // 已完成轮次只出现一次：canonical 已含其持久化 turns，live 项不保留。
    expect(shard.items.filter((it) => it.kind === 'assistant' && it.text === '先查一下。')).toHaveLength(1)
    // 流式尾部原样保留（含 thinking 缓冲——live-only 流）。
    const tail = shard.items[3]!
    expect(tail.kind === 'assistant' && tail.text).toBe('根据结果，')
    expect(tail.kind === 'assistant' && tail.thinking).toBe('整理结论')
    expect(tail.kind === 'assistant' && tail.streaming).toBe(true)
  })

  it('② 无在途回合（turn.end 已收口）：整体重置语义不回归', () => {
    const view = createSessionView()
    appendUserMessage(view, 's1', '帮我查一下')
    apply(view, [
      { kind: 'assistant.delta', sessionId: 's1', turnId: 'turn-0', text: '答案' },
      { kind: 'turn.end', sessionId: 's1', result: loopResult() },
    ])
    hydrateHistory(view, 's1', historyTurns())
    const shard = view.shards.get('s1')!
    expect(shard.phase).toBe('idle')
    expect(shard.inFlightTurnIds.size).toBe(0)
    expect(shard.items.map((it) => it.kind)).toEqual(['user', 'assistant', 'tool'])
  })

  it('②b user.prompt 已发但尚无任何 delta：phase 保持 streaming、无保留项', () => {
    const view = createSessionView()
    appendUserMessage(view, 's1', '帮我查一下')
    hydrateHistory(view, 's1', historyTurns())
    const shard = view.shards.get('s1')!
    expect(shard.phase).toBe('streaming')
    expect(shard.items.map((it) => it.kind)).toEqual(['user', 'assistant', 'tool'])
  })

  it('③ hydrate 后在途回合收尾：delta 续写保留项，turn.end 使 phase/items/stats 收敛', () => {
    const view = inFlightView()
    hydrateHistory(view, 's1', historyTurns())

    // 在途回合继续：后续 delta 落进保留的同一 item；本轮工具卡由 live 信号建/收。
    apply(view, [
      { kind: 'assistant.delta', sessionId: 's1', turnId: 'turn-1', text: '结论如下。' },
      { kind: 'tool.started', sessionId: 's1', turnId: 'turn-1', toolName: 'write', callId: 'call-2', args: null },
      {
        kind: 'tool.result',
        sessionId: 's1',
        turnId: 'turn-1',
        toolName: 'write',
        callId: 'call-2',
        result: toolTurn({ content: 'written', toolName: 'write', args: { path: 'b.txt' } }),
      },
      {
        kind: 'turn.end',
        sessionId: 's1',
        result: loopResult({ turns: 2, metrics: { ...createMetrics(), totalTokens: 42, elapsedMs: 300 } }),
      },
    ])
    const shard = view.shards.get('s1')!
    expect(shard.phase).toBe('idle')
    expect(shard.inFlightTurnIds.size).toBe(0)
    expect(shard.items.every((it) => it.kind !== 'assistant' || !it.streaming)).toBe(true)
    // 保留项被续写完整（partial + 后续 delta 是同一 item，无断裂）。
    const tail = shard.items[3]!
    expect(tail.kind === 'assistant' && tail.text).toBe('根据结果，结论如下。')
    expect(shard.items.map((it) => it.kind)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool'])
    expect(shard.items[4]).toMatchObject({ kind: 'tool', callId: 'call-2', status: 'success', producedPath: 'b.txt' })
    expect(shard.stats).toMatchObject({ turnEnds: 1, loopTurns: 2, totalTokens: 42, elapsedMs: 300, lastReason: 'completed' })
  })
})

// ---------------------------------------------------------------------------
// gate-subscription 薄胶水
// ---------------------------------------------------------------------------

/** 只测 emit/on/request 的转发——路由到的成员一律 throw（never 分支）。 */
const neverHandlers = {
  runPrompt: async () => {
    throw new Error('not implemented in tests')
  },
  session: {
    create: async () => {
      throw new Error('not implemented in tests')
    },
    open: async () => {
      throw new Error('not implemented in tests')
    },
    list: async () => [],
    close: async () => {},
    delete: async () => {},
    history: async () => [],
  },
  cancel: () => {},
  setFullPermission: () => {},
} satisfies import('../../src/signals/types.js').SignalGateHandlers

describe('subscribeToGate', () => {
  it('forwards gate emissions and requests to the sink; unsubscribe stops them', () => {
    const gate = createSignalGate({ handlers: neverHandlers })
    const seen: Array<GateSignal | GateRequest> = []
    const unsub = subscribeToGate(gate, { apply: (sig) => seen.push(sig) })

    gate.emit({ kind: 'assistant.delta', sessionId: 's1', turnId: 't', text: 'x' })
    gate.emit({ kind: 'log', level: 'info', msg: 'boot', ts: 1 })
    gate.request({ kind: 'approval', payload: approval() })
    expect(seen.map((s) => s.kind)).toEqual(['assistant.delta', 'log', 'approval'])

    unsub()
    gate.emit({ kind: 'log', level: 'info', msg: 'after', ts: 2 })
    expect(seen).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// v0.41 goal.changed 的投影与文案
// ---------------------------------------------------------------------------

describe('applySignal — goal.changed（v0.41）', () => {
  // ensureShard 只建分片、不设 activeSessionId，所以直接按 id 取（与本文件
  // 既有测试一致）；活跃指针的行为在下面的"分片隔离"用例里单独测。
  const view = (): SessionView => createSessionView()
  const shardOf = (v: SessionView, id = 's1') => v.shards.get(id)!

  const setEvent: GoalEvent = { status: 'set', condition: '写出 a.txt 与 b.txt', maxRounds: 24 }
  const roundEvent = (round: number, reason = 'b.txt 缺证据'): GoalEvent => ({
    status: 'round', round, maxRounds: 24, verdict: { verdict: 'not_met', reason },
  })

  it('set 建立 shard.goal，并往对话流推一个 goal 项', () => {
    const v = view()
    applySignal(v, { kind: 'goal.changed', sessionId: 's1', event: setEvent })
    expect(shardOf(v).goal).toEqual({ condition: '写出 a.txt 与 b.txt', maxRounds: 24, roundsUsed: 0 })
    expect(shardOf(v).items.filter((i) => i.kind === 'goal')).toHaveLength(1)
  })

  it('round 更新 roundsUsed 与 lastVerdict，条件沿用 set 时的值', () => {
    const v = view()
    applySignal(v, { kind: 'goal.changed', sessionId: 's1', event: setEvent })
    applySignal(v, { kind: 'goal.changed', sessionId: 's1', event: roundEvent(1) })
    applySignal(v, { kind: 'goal.changed', sessionId: 's1', event: roundEvent(2, '还差 b.txt') })

    const g = shardOf(v).goal
    expect(g?.roundsUsed).toBe(2)
    expect(g?.condition).toBe('写出 a.txt 与 b.txt')
    expect(g?.lastVerdict).toEqual({ verdict: 'not_met', reason: '还差 b.txt' })
  })

  it('中途接入（没有 set 就来 round）时条件留空而不编造——权威状态靠 /goal status 现拉', () => {
    const v = view()
    applySignal(v, { kind: 'goal.changed', sessionId: 's1', event: roundEvent(3) })
    const g = shardOf(v).goal
    expect(g?.condition).toBe('')
    expect(g?.roundsUsed).toBe(3)
  })

  it('四个终止型事件都清空 shard.goal（与后端 state.current = undefined 同步）', () => {
    const terminals: GoalEvent[] = [
      { status: 'met', roundsUsed: 2 },
      { status: 'impossible', roundsUsed: 1, reason: '权限不存在' },
      { status: 'rounds_exhausted', roundsUsed: 24 },
      { status: 'cleared' },
    ]
    for (const t of terminals) {
      const v = view()
      applySignal(v, { kind: 'goal.changed', sessionId: 's1', event: setEvent })
      expect(shardOf(v).goal).toBeDefined()
      applySignal(v, { kind: 'goal.changed', sessionId: 's1', event: t })
      expect(shardOf(v).goal, `status=${t.status}`).toBeUndefined()
    }
  })

  it('压缩类事件只进对话流，不影响 shard.goal', () => {
    const v = view()
    applySignal(v, { kind: 'goal.changed', sessionId: 's1', event: setEvent })
    applySignal(v, {
      kind: 'goal.changed', sessionId: 's1',
      event: { status: 'goal_block_merged', stamp: 'S-1', blockTokens: 90000, envelopeTokens: 3000, trigger: 'size' },
    })
    applySignal(v, {
      kind: 'goal.changed', sessionId: 's1',
      event: { status: 'envelopes_distilled', stamp: 'S-9', sourceStamps: ['S-1', 'S-2', 'S-3', 'S-4'], beforeTokens: 12000, afterTokens: 3000 },
    })
    applySignal(v, { kind: 'goal.changed', sessionId: 's1', event: { status: 'distill_failed', err: 'boom' } })

    expect(shardOf(v).goal).toEqual({ condition: '写出 a.txt 与 b.txt', maxRounds: 24, roundsUsed: 0 })
    // set + 3 个压缩事件 = 4 个 goal 项
    expect(shardOf(v).items.filter((i) => i.kind === 'goal')).toHaveLength(4)
  })

  it('分片隔离：别的会话的 goal 事件不碰本会话（G6）', () => {
    const v = view()
    applySignal(v, { kind: 'goal.changed', sessionId: 's1', event: setEvent })
    applySignal(v, { kind: 'goal.changed', sessionId: 's2', event: { status: 'cleared' } })
    // 两个分片各自独立：s1 有目标，s2 被 cleared 后为空
    expect(v.shards.get('s1')!.goal).toBeDefined()
    expect(v.shards.get('s2')!.goal).toBeUndefined()
    // 活跃指针切到哪个会话就读哪个的状态
    setActiveSession(v, 's1')
    expect(activeShard(v)?.goal).toBeDefined()
    setActiveSession(v, 's2')
    expect(activeShard(v)?.goal).toBeUndefined()
  })
})

describe('goalEventLabel — 九种 status 的文案（v0.41）', () => {
  it('judge_failed 的措辞与 not_met 明确区分（D15：不能让人误以为模型真没做完）', () => {
    const notMet = goalEventLabel({ status: 'round', round: 2, maxRounds: 24, verdict: { verdict: 'not_met', reason: 'b.txt 缺证据' } })
    const failed = goalEventLabel({ status: 'round', round: 2, maxRounds: 24, verdict: { verdict: 'judge_failed', reason: 'judge 调用失败：ETIMEDOUT' } })

    expect(notMet).toContain('目标未达成')
    expect(notMet).toContain('第 2/24 轮')
    expect(notMet).toContain('b.txt 缺证据')
    expect(failed).toContain('判定未跑成')
    expect(failed).toContain('ETIMEDOUT')
    expect(failed).not.toContain('目标未达成')
  })

  it('终止型与设置型文案', () => {
    expect(goalEventLabel({ status: 'set', condition: '目标X', maxRounds: 24 })).toContain('目标已设置')
    expect(goalEventLabel({ status: 'met', roundsUsed: 3 })).toContain('目标已达成')
    expect(goalEventLabel({ status: 'impossible', roundsUsed: 1, reason: '权限不存在' })).toContain('权限不存在')
    expect(goalEventLabel({ status: 'rounds_exhausted', roundsUsed: 24 })).toContain('轮次用尽')
    expect(goalEventLabel({ status: 'cleared' })).toContain('目标已关闭')
  })

  it('压缩类文案带 token 数字与触发线（跑基准时能直接看出 G1/G2 是否在跟上）', () => {
    const merged = goalEventLabel({ status: 'goal_block_merged', stamp: 'S-1', blockTokens: 90000, envelopeTokens: 3000, trigger: 'size' })
    expect(merged).toContain('90000→3000')
    expect(merged).toContain('尺寸')
    expect(goalEventLabel({ status: 'goal_block_merged', stamp: 'S-1', blockTokens: 5, envelopeTokens: 3, trigger: 'watermark' })).toContain('水位')

    const distilled = goalEventLabel({ status: 'envelopes_distilled', stamp: 'S-9', sourceStamps: ['a', 'b', 'c', 'd'], beforeTokens: 12000, afterTokens: 3000 })
    expect(distilled).toContain('4→1')
    expect(distilled).toContain('12000→3000')

    expect(goalEventLabel({ status: 'distill_failed', err: 'boom' })).toContain('保留原样')
  })

  it('九种 status 全部有非空文案（never 穷尽守卫的运行时对照）', () => {
    const all: GoalEvent[] = [
      { status: 'set', condition: 'c', maxRounds: 1 },
      { status: 'round', round: 1, maxRounds: 1, verdict: { verdict: 'not_met', reason: 'r' } },
      { status: 'goal_block_merged', stamp: 's', blockTokens: 1, envelopeTokens: 1, trigger: 'size' },
      { status: 'envelopes_distilled', stamp: 's', sourceStamps: ['a'], beforeTokens: 1, afterTokens: 1 },
      { status: 'distill_failed', err: 'e' },
      { status: 'met', roundsUsed: 1 },
      { status: 'impossible', roundsUsed: 1, reason: 'r' },
      { status: 'rounds_exhausted', roundsUsed: 1 },
      { status: 'cleared' },
    ]
    expect(all).toHaveLength(9)
    for (const e of all) expect(goalEventLabel(e).length).toBeGreaterThan(0)
  })
})
