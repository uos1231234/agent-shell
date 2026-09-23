import { describe, it, expect } from 'vitest'
import { createAuditHook } from '../../../src/im/hooks/audit-hook.js'
import type { HookContext } from '../../../src/im/hooks/types.js'

function makeCtx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    event: 'PostToolUse',
    toolName: 'read',
    duration: 100,
    sessionId: 'test-session',
    ...overrides,
  }
}

describe('createAuditHook', () => {
  it('returns an object with event and handler properties', () => {
    const hook = createAuditHook()
    expect(hook).toHaveProperty('event')
    expect(hook).toHaveProperty('handler')
    expect(hook.event).toBe('PostToolUse')
    expect(typeof hook.handler).toBe('function')
  })

  it('handler records a log entry when called', async () => {
    const hook = createAuditHook()
    await hook.handler(makeCtx())

    const logs = hook.getLogs()
    expect(logs).toHaveLength(1)
    expect(logs[0]!.toolName).toBe('read')
    expect(logs[0]!.duration).toBe(100)
    expect(logs[0]!.sessionId).toBe('test-session')
    expect(logs[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('getLogs returns an array', () => {
    const hook = createAuditHook()
    expect(Array.isArray(hook.getLogs())).toBe(true)
  })

  it('records success: true when no error', async () => {
    const hook = createAuditHook()
    await hook.handler(makeCtx())

    const logs = hook.getLogs()
    expect(logs[0]!.success).toBe(true)
    expect(logs[0]!.error).toBeUndefined()
  })

  it('records success: false and error message when error present', async () => {
    const hook = createAuditHook()
    await hook.handler(makeCtx({ error: new Error('file not found') }))

    const logs = hook.getLogs()
    expect(logs[0]!.success).toBe(false)
    expect(logs[0]!.error).toBe('file not found')
  })

  it('accumulates logs across multiple calls', async () => {
    const hook = createAuditHook()
    await hook.handler(makeCtx({ toolName: 'read' }))
    await hook.handler(makeCtx({ toolName: 'bash' }))
    await hook.handler(makeCtx({ toolName: 'write' }))

    const logs = hook.getLogs()
    expect(logs).toHaveLength(3)
    expect(logs[0]!.toolName).toBe('read')
    expect(logs[1]!.toolName).toBe('bash')
    expect(logs[2]!.toolName).toBe('write')
  })

  it('getLogs returns a copy (not the internal array)', async () => {
    const hook = createAuditHook()
    await hook.handler(makeCtx())

    const logs1 = hook.getLogs()
    logs1.push({ timestamp: 'fake', toolName: 'fake', success: true } as any)
    const logs2 = hook.getLogs()
    expect(logs2).toHaveLength(1)
  })

  it('uses "unknown" when toolName is missing', async () => {
    const hook = createAuditHook()
    await hook.handler({ event: 'PostToolUse' })

    const logs = hook.getLogs()
    expect(logs[0]!.toolName).toBe('unknown')
  })
})
