// v0.21 Signal Gate — hook-system wiring 单元测试。
//
// 覆盖 wireHookSystemToGate 的行为：
//   1. 注册 handler 到 HookSystem（SessionStart/TurnEnd/SessionEnd/PostToolUse）
//   2. HookSystem emit → gate.emit('session.event') 带正确 sessionId + data
//   3. HookContext.sessionId 缺省时回退 wiring 的 getSessionId()
//   4. dispose 是 no-op（HookSystem 无 unregister）

import { describe, it, expect, vi } from 'vitest'
import { wireHookSystemToGate } from '../../src/signals/wiring/hook-system.js'
import { HookSystem } from '../../src/im/hooks/hook-system.js'
import type { SignalGate, GateSignal } from '../../src/signals/types.js'

const makeGate = () => {
  const emitted: GateSignal[] = []
  const gate: SignalGate = {
    emit: vi.fn((sig: GateSignal) => { emitted.push(sig) }),
    on: vi.fn(() => () => {}),
    request: vi.fn(),
    resolve: vi.fn(),
    command: vi.fn(),
    snapshot: vi.fn(() => ({ sessions: [], pendingRequests: 0, subscribers: 0, emitted: 0 })),
  }
  return { gate, emitted }
}

describe('wireHookSystemToGate', () => {
  it('bridges SessionStart → session.event signal', async () => {
    const { gate, emitted } = makeGate()
    const hookSystem = new HookSystem()
    wireHookSystemToGate({ gate, hookSystem, getSessionId: () => 's1' })

    await hookSystem.emit('SessionStart', { event: 'SessionStart', sessionId: 's1', agentId: 'main' })

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toEqual({
      kind: 'session.event',
      sessionId: 's1',
      event: 'SessionStart',
      data: { agentId: 'main', toolName: undefined, duration: undefined, error: undefined },
    })
  })

  it('bridges TurnEnd → session.event signal', async () => {
    const { gate, emitted } = makeGate()
    const hookSystem = new HookSystem()
    wireHookSystemToGate({ gate, hookSystem, getSessionId: () => 's1' })

    await hookSystem.emit('TurnEnd', { event: 'TurnEnd', sessionId: 's1' })

    expect(emitted).toHaveLength(1)
    expect((emitted[0] as { event: string }).event).toBe('TurnEnd')
  })

  it('bridges PostToolUse → session.event signal with toolName', async () => {
    const { gate, emitted } = makeGate()
    const hookSystem = new HookSystem()
    wireHookSystemToGate({ gate, hookSystem, getSessionId: () => 's1' })

    await hookSystem.emit('PostToolUse', {
      event: 'PostToolUse',
      sessionId: 's1',
      toolName: 'bash',
      duration: 500,
    })

    expect(emitted).toHaveLength(1)
    const sig = emitted[0] as { event: string; data: { toolName?: string; duration?: number } }
    expect(sig.event).toBe('PostToolUse')
    expect(sig.data.toolName).toBe('bash')
    expect(sig.data.duration).toBe(500)
  })

  it('SessionEnd → session.event signal', async () => {
    const { gate, emitted } = makeGate()
    const hookSystem = new HookSystem()
    wireHookSystemToGate({ gate, hookSystem, getSessionId: () => 's1' })

    await hookSystem.emit('SessionEnd', { event: 'SessionEnd', sessionId: 's1' })

    expect(emitted).toHaveLength(1)
    expect((emitted[0] as { event: string }).event).toBe('SessionEnd')
  })

  it('fallback sessionId from getSessionId when HookContext.sessionId is undefined', async () => {
    const { gate, emitted } = makeGate()
    const hookSystem = new HookSystem()
    wireHookSystemToGate({ gate, hookSystem, getSessionId: () => 'fallback-sid' })

    await hookSystem.emit('SessionStart', { event: 'SessionStart' })

    expect(emitted).toHaveLength(1)
    expect((emitted[0] as { sessionId: string }).sessionId).toBe('fallback-sid')
  })

  it('PreToolUse is NOT bridged (bidirectional semantics, not in v0.21)', async () => {
    const { gate, emitted } = makeGate()
    const hookSystem = new HookSystem()
    wireHookSystemToGate({ gate, hookSystem, getSessionId: () => 's1' })

    // PreToolUse returns boolean — the wiring does NOT register a PreToolUse handler
    // So hookSystem.emitPreToolUse should have no registered handlers.
    const result = await hookSystem.emitPreToolUse({ event: 'PreToolUse', sessionId: 's1' })
    // No handlers registered for PreToolUse → default behavior (true = allow)
    expect(result).toBe(true)
    expect(emitted).toHaveLength(0)
  })

  it('dispose is a no-op (does not throw)', () => {
    const { gate } = makeGate()
    const hookSystem = new HookSystem()
    const dispose = wireHookSystemToGate({ gate, hookSystem, getSessionId: () => 's1' })

    expect(() => dispose()).not.toThrow()
  })
})
