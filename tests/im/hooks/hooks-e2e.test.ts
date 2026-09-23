import { describe, it, expect } from 'vitest'
import { HookSystem } from '../../../src/im/hooks/hook-system.js'
import { createAuditHook } from '../../../src/im/hooks/audit-hook.js'
import { createErrorRecoveryHook } from '../../../src/im/hooks/error-recovery-hook.js'
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

describe('E2E: HookSystem + AuditHook', () => {
  it('records audit log after tool call', async () => {
    const hs = new HookSystem()
    const audit = createAuditHook()
    hs.register(audit)

    // Simulate a tool call
    await hs.emit('PostToolUse', makeCtx({ toolName: 'bash', duration: 50 }))

    const logs = audit.getLogs()
    expect(logs).toHaveLength(1)
    expect(logs[0]!.toolName).toBe('bash')
    expect(logs[0]!.duration).toBe(50)
    expect(logs[0]!.success).toBe(true)
  })

  it('records multiple tool calls in order', async () => {
    const hs = new HookSystem()
    const audit = createAuditHook()
    hs.register(audit)

    await hs.emit('PostToolUse', makeCtx({ toolName: 'read' }))
    await hs.emit('PostToolUse', makeCtx({ toolName: 'bash', error: new Error('cmd failed') }))
    await hs.emit('PostToolUse', makeCtx({ toolName: 'write' }))

    const logs = audit.getLogs()
    expect(logs).toHaveLength(3)
    expect(logs[0]!.toolName).toBe('read')
    expect(logs[0]!.success).toBe(true)
    expect(logs[1]!.toolName).toBe('bash')
    expect(logs[1]!.success).toBe(false)
    expect(logs[1]!.error).toBe('cmd failed')
    expect(logs[2]!.toolName).toBe('write')
    expect(logs[2]!.success).toBe(true)
  })
})

describe('E2E: HookSystem + ErrorRecoveryHook', () => {
  it('triggers suggestion after 3 consecutive failures', async () => {
    const hs = new HookSystem()
    const recovery = createErrorRecoveryHook()
    hs.register(recovery)

    // 3 consecutive failures
    await hs.emit('PostToolUse', makeCtx({ toolName: 'bash', error: new Error('fail 1') }))
    await hs.emit('PostToolUse', makeCtx({ toolName: 'bash', error: new Error('fail 2') }))
    await hs.emit('PostToolUse', makeCtx({ toolName: 'bash', error: new Error('fail 3') }))

    expect(recovery.shouldSuggestAlternatives()).toBe(true)
  })

  it('does not trigger suggestion when errors are intermittent', async () => {
    const hs = new HookSystem()
    const recovery = createErrorRecoveryHook()
    hs.register(recovery)

    // error, success, error, success, error (never 3 in a row)
    await hs.emit('PostToolUse', makeCtx({ error: new Error('fail 1') }))
    await hs.emit('PostToolUse', makeCtx())
    await hs.emit('PostToolUse', makeCtx({ error: new Error('fail 2') }))
    await hs.emit('PostToolUse', makeCtx())
    await hs.emit('PostToolUse', makeCtx({ error: new Error('fail 3') }))

    expect(recovery.shouldSuggestAlternatives()).toBe(false)
  })
})

describe('E2E: PreToolUse blocking', () => {
  it('blocks tool execution when PreToolUse handler returns false', async () => {
    const hs = new HookSystem()

    // Security-like hook that blocks write to sensitive paths
    hs.register({
      event: 'PreToolUse',
      handler: async (ctx) => {
        if (ctx.toolName === 'write' && ctx.args && (ctx.args as any).path?.includes('.env')) {
          return false
        }
      },
    })

    const blocked = await hs.emitPreToolUse(
      makeCtx({ event: 'PreToolUse', toolName: 'write', args: { path: '/project/.env' } })
    )
    expect(blocked).toBe(false)

    const allowed = await hs.emitPreToolUse(
      makeCtx({ event: 'PreToolUse', toolName: 'write', args: { path: '/project/readme.md' } })
    )
    expect(allowed).toBe(true)
  })

  it('allows tool execution when all PreToolUse handlers pass', async () => {
    const hs = new HookSystem()

    hs.register({
      event: 'PreToolUse',
      handler: async () => true,
    })
    hs.register({
      event: 'PreToolUse',
      handler: async () => undefined,
    })

    const result = await hs.emitPreToolUse(
      makeCtx({ event: 'PreToolUse', toolName: 'read' })
    )
    expect(result).toBe(true)
  })

  it('multiple hooks: audit + recovery + blocking work together', async () => {
    const hs = new HookSystem()
    const audit = createAuditHook()
    const recovery = createErrorRecoveryHook()

    hs.register(audit)
    hs.register(recovery)

    // Blocking hook
    hs.register({
      event: 'PreToolUse',
      handler: async (ctx) => {
        if (ctx.toolName === 'bash' && ctx.args && (ctx.args as any).command?.includes('rm -rf')) {
          return false
        }
      },
    })

    // Dangerous command blocked at PreToolUse
    const blocked = await hs.emitPreToolUse(
      makeCtx({ event: 'PreToolUse', toolName: 'bash', args: { command: 'rm -rf /' } })
    )
    expect(blocked).toBe(false)

    // Safe command allowed, then tracked
    const allowed = await hs.emitPreToolUse(
      makeCtx({ event: 'PreToolUse', toolName: 'bash', args: { command: 'ls -la' } })
    )
    expect(allowed).toBe(true)

    await hs.emit('PostToolUse', makeCtx({ toolName: 'bash' }))

    // Audit recorded the successful call
    expect(audit.getLogs()).toHaveLength(1)
    expect(audit.getLogs()[0]!.success).toBe(true)

    // No consecutive errors
    expect(recovery.shouldSuggestAlternatives()).toBe(false)
  })
})
