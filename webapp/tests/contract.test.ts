// 契约链路冒烟：import type 从库源码解析成功 + 关键类型形状正确。
// 这是 v0.22 计划的第一实现步——先证明类型链路，再写功能代码。
import { describe, it, expect } from 'vitest'
import type {
  GateSignal,
  GateCommand,
  ConversationTurn,
  ArtifactHandle,
  SessionInfo,
} from '../src/api/contract'

describe('contract type chain (import type from ../src/signals)', () => {
  it('GateSignal assistant.delta shape matches backend', () => {
    const sig: GateSignal = {
      kind: 'assistant.delta',
      sessionId: 's1',
      turnId: 'turn-1',
      text: 'hello',
    }
    expect(sig.kind).toBe('assistant.delta')
  })

  it('GateCommand session.history is routable', () => {
    const cmd: GateCommand = { kind: 'session.history', sessionId: 's1' }
    expect(cmd.kind).toBe('session.history')
  })

  it('ConversationTurn user/assistant/tool variants', () => {
    const turns: ConversationTurn[] = [
      { id: 'u1', role: 'user', content: 'hi', at: 1 },
      { id: 'a1', role: 'assistant', content: 'hello', at: 2 },
      {
        id: 't1',
        role: 'tool',
        toolCallId: 'c1',
        content: 'ok',
        sourceAgentId: 'main',
        at: 3,
      },
    ]
    expect(turns).toHaveLength(3)
  })

  it('ArtifactHandle / SessionInfo shapes', () => {
    const h: ArtifactHandle = { id: 'a', kind: 'markdown', title: 'T', source: 'wiki', at: 1 }
    const s: SessionInfo = {
      id: 'sid',
      title: 'session',
      workingAgentId: 'main',
      createdAt: 1,
      lastActiveAt: 1,
      turnCount: 0,
      layer: 'M0',
      snapshotExpired: false,
    }
    expect(h.kind).toBe('markdown')
    expect(s.layer).toBe('M0')
  })
})
