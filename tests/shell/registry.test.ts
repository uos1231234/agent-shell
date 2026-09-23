import { describe, it, expect } from 'vitest'
import { compose } from '../../src/shell/compose.js'
import { ToolRegistry } from '../../src/shell/registry.js'
import { createWriteApprovalDoor } from '../../src/security/doors/write-approval.js'
import { resolveShellTimeout } from '../../src/im/tools/shell.js'

const echoParams = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } as const

describe('shell/registry', () => {
  describe('registerSystemTool', () => {
    it('stores a system tool by name', () => {
      const r = new ToolRegistry()
      r.registerSystemTool({
        name: 'echo',
        description: 'echo back',
        parameters: echoParams,
        execute: async (args) => ({ echo: (args as { x: string }).x }),
      })
      const tool = r.getSystemTool('echo')
      expect(tool).toBeDefined()
      expect(tool!.name).toBe('echo')
      expect(tool!.description).toBe('echo back')
    })
  })

  describe('registerMCP', () => {
    it('groups tools under a server name and binds executor', () => {
      const r = new ToolRegistry()
      r.registerMCP('github', [
        {
          name: 'create_issue',
          description: 'create an issue',
          parameters: echoParams,
          execute: async (args) => ({ created: (args as { x: string }).x }),
        },
      ])
      const tool = r.getMCPTool('github', 'create_issue')
      expect(tool).toBeDefined()
      expect(tool!.name).toBe('create_issue')
    })
  })

  describe('registerSkill', () => {
    it('stores a skill by name', () => {
      const r = new ToolRegistry()
      r.registerSkill({ name: 'plan', description: 'plan a task', execute: async () => ({ ok: true }) })
      const skill = r.getSkill('plan')
      expect(skill).toBeDefined()
      expect(skill!.name).toBe('plan')
    })
  })

  describe('list*', () => {
    it('listSystemTools returns all registered system tool names', () => {
      const r = new ToolRegistry()
      r.registerSystemTool({ name: 'a', description: 'a', parameters: echoParams, execute: async () => ({}) })
      r.registerSystemTool({ name: 'b', description: 'b', parameters: echoParams, execute: async () => ({}) })
      expect(r.listSystemTools().sort()).toEqual(['a', 'b'])
    })

    it('listMCPServers / listMCPTools enumerate MCP content', () => {
      const r = new ToolRegistry()
      r.registerMCP('s1', [{ name: 't1', description: 'd', parameters: echoParams, execute: async () => ({}) }])
      r.registerMCP('s2', [
        { name: 't2', description: 'd', parameters: echoParams, execute: async () => ({}) },
        { name: 't3', description: 'd', parameters: echoParams, execute: async () => ({}) },
      ])
      expect(r.listMCPServers().sort()).toEqual(['s1', 's2'])
      expect(r.listMCPTools('s2').sort()).toEqual(['t2', 't3'])
    })

    it('listSkills returns all skill names', () => {
      const r = new ToolRegistry()
      r.registerSkill({ name: 's1', description: 'd', execute: async () => ({}) })
      r.registerSkill({ name: 's2', description: 'd', execute: async () => ({}) })
      expect(r.listSkills().sort()).toEqual(['s1', 's2'])
    })
  })

  describe('toOpenAIToolSchemas (形态 A native format)', () => {
    it('emits native OpenAI function tool format for system + mcp', () => {
      const r = new ToolRegistry()
      r.registerSystemTool({ name: 'echo', description: 'echo back', parameters: echoParams, execute: async () => ({}) })
      r.registerMCP('gh', [{ name: 'issue', description: 'create issue', parameters: echoParams, execute: async () => ({}) }])
      const schemas = r.toOpenAIToolSchemas()
      expect(schemas).toContainEqual({
        type: 'function',
        function: { name: 'echo', description: 'echo back', parameters: echoParams },
      })
      // MCP tools are namespaced as server__tool
      expect(schemas).toContainEqual({
        type: 'function',
        function: { name: 'gh__issue', description: 'create issue', parameters: echoParams },
      })
    })

    it('skills are also exposed as callable tools', () => {
      const r = new ToolRegistry()
      r.registerSkill({ name: 'plan', description: 'plan a task', execute: async () => ({ ok: true }) })
      const schemas = r.toOpenAIToolSchemas()
      expect(schemas).toContainEqual({
        type: 'function',
        function: { name: 'plan', description: 'plan a task', parameters: { type: 'object', properties: {} } },
      })
    })
  })

  describe('executor resolution', () => {
    it('system tool executor is callable', async () => {
      const r = new ToolRegistry()
      r.registerSystemTool({
        name: 'echo',
        description: 'echo',
        parameters: echoParams,
        execute: async (args) => ({ echo: (args as { x: string }).x }),
      })
      const result = await r.execute('echo', { x: 'hi' })
      expect(result).toEqual({ echo: 'hi' })
    })

    it('MCP tool executor is callable (via server__name)', async () => {
      const r = new ToolRegistry()
      r.registerMCP('gh', [
        {
          name: 'issue',
          description: 'd',
          parameters: echoParams,
          execute: async (args) => ({ ok: (args as { x: string }).x }),
        },
      ])
      // v0.10.5: MCP/skill tools now require a `reason` (registry guard).
      // 结果不截断不转写（2026-09-12 用户拍板）——对象原样返回，序列化在
      // loop 的单点完成。
      const result = await r.execute('gh__issue', { x: 'hi', reason: 'test' })
      expect(result).toEqual({ ok: 'hi' })
    })

    it('skill executor is callable', async () => {
      const r = new ToolRegistry()
      r.registerSkill({ name: 'plan', description: 'd', execute: async () => ({ ok: true }) })
      // v0.10.5: MCP/skill tools now require a `reason` (registry guard).
      const result = await r.execute('plan', { reason: 'test' })
      expect(result).toEqual({ ok: true })
    })

    it('execute throws if tool not registered', async () => {
      const r = new ToolRegistry()
      await expect(r.execute('nonexistent', {})).rejects.toThrow(/not registered/)
    })
  })

  // v0.10.5: MCP/skill safety-shell coverage. These tests pin the new guard
  // behaviors: reason injected into the request schema by compose, reason
  // validated at execute, results passed through untruncated (2026-09-12
  // user decision), and security hooks able to block a call before it
  // reaches the executor.
  describe('v0.10.5: MCP/skill guard', () => {
    it('compose mcp/skill parts are no-ops in v0.18 (tools loaded dynamically via load_tools)', () => {
      const r = new ToolRegistry()
      r.registerMCP('srv', [{
        name: 'echo',
        description: 'echo',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        execute: async () => 'ok',
      }])
      r.registerSkill({ name: 'plan', description: 'plan', execute: async () => 'ok' })
      const out = compose(r, [
        { type: 'system', content: 'SYS' },
        { type: 'userTemplate', content: 'T' },
        { type: 'mcp', server: 'srv', refs: ['echo'] },
        { type: 'skill', ref: 'plan' },
      ])
      // v0.18: mcp/skill parts no longer push into tools[]. Tools are loaded
      // dynamically via load_tools. Only system tools remain in tools[].
      expect(out.tools).toEqual([])
    })

    it('compose does NOT mutate the registered MCP tool schema (server original untouched)', () => {
      const r = new ToolRegistry()
      r.registerMCP('srv', [{
        name: 'echo',
        description: 'echo',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        execute: async () => 'ok',
      }])
      // Pull the schema before compose; it must NOT have reason.
      const before = r.getMCPTool('srv', 'echo')!.parameters as {
        properties: Record<string, unknown>
        required: readonly string[]
      }
      expect(before.properties.reason).toBeUndefined()
      expect(before.required).not.toContain('reason')

      compose(r, [
        { type: 'system', content: 'SYS' },
        { type: 'userTemplate', content: 'T' },
        { type: 'mcp', server: 'srv', refs: ['echo'] },
      ])

      // The registered schema is still pristine — compose only extended a copy.
      const after = r.getMCPTool('srv', 'echo')!.parameters as {
        properties: Record<string, unknown>
        required: readonly string[]
      }
      expect(after.properties.reason).toBeUndefined()
      expect(after.required).not.toContain('reason')
    })

    it('MCP execute with missing reason throws a clean sentence', async () => {
      const r = new ToolRegistry()
      r.registerMCP('srv', [{
        name: 'echo',
        description: 'echo',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => 'ok',
      }])
      // No reason supplied → guard rejects before the executor runs.
      await expect(r.execute('srv__echo', {})).rejects.toThrow(/reason/)
      await expect(r.execute('srv__echo', { reason: '' })).rejects.toThrow(/reason/)
    })

    it('skill execute with missing reason throws a clean sentence', async () => {
      const r = new ToolRegistry()
      r.registerSkill({ name: 'plan', description: 'plan', execute: async () => 'ok' })
      await expect(r.execute('plan', {})).rejects.toThrow(/reason/)
    })

    it('MCP execute with a non-string reason throws', async () => {
      const r = new ToolRegistry()
      r.registerMCP('srv', [{
        name: 'echo',
        description: 'echo',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => 'ok',
      }])
      await expect(r.execute('srv__echo', { reason: 42 })).rejects.toThrow(/reason/)
    })

    it('oversized MCP result passes through in full (no truncation, 2026-09-12)', async () => {
      const r = new ToolRegistry()
      const big = 'x'.repeat(12_000)
      r.registerMCP('srv', [{
        name: 'big',
        description: 'returns a big string',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => big,
      }])
      const result = await r.execute('srv__big', { reason: 'big test' })
      expect(result).toBe(big)
    })

    it('MCP result that is an object passes through as the raw object', async () => {
      const r = new ToolRegistry()
      r.registerMCP('srv', [{
        name: 'obj',
        description: 'returns an object',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => ({ ok: 'hi' }),
      }])
      const result = await r.execute('srv__obj', { reason: 'obj test' })
      expect(result).toEqual({ ok: 'hi' })
    })

    it('MCP executor error is wrapped as Tool "X" failed: <msg>', async () => {
      const r = new ToolRegistry()
      r.registerMCP('srv', [{
        name: 'boom',
        description: 'always throws',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => { throw new Error('kaboom') },
      }])
      await expect(r.execute('srv__boom', { reason: 'boom test' }))
        .rejects.toThrow(/Tool "srv__boom" failed: kaboom/)
    })

    it('MCP executor throwing a non-Error value is wrapped via cleanErrorMessage', async () => {
      const r = new ToolRegistry()
      r.registerMCP('srv', [{
        name: 'str-throws',
        description: 'throws a string',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => { throw 'raw string error' },
      }])
      await expect(r.execute('srv__str-throws', { reason: 'str test' }))
        .rejects.toThrow(/Tool "srv__str-throws" failed: raw string error/)
    })

    it('system tool execute is NOT double-wrapped (reason validated once by wrapTool)', async () => {
      // System tools go through wrapTool at registration; the registry guard
      // must NOT re-run requireReason on them. If it did, a system tool that
      // legitimately omits reason (e.g. called internally) would be rejected
      // by the second pass. Here we register a system tool WITHOUT wrapTool
      // to verify execute dispatches to systemTools directly and skips the
      // MCP/skill guard entirely.
      const r = new ToolRegistry()
      let executorCalled = false
      r.registerSystemTool({
        name: 'sys-raw',
        description: 'raw system tool (no wrapTool, no reason)',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => { executorCalled = true; return 'sys-ok' },
      })
      // No reason field — system path must NOT enforce reason.
      const result = await r.execute('sys-raw', {})
      expect(result).toBe('sys-ok')
      expect(executorCalled).toBe(true)
    })

    it('securityHook allow: hook returns void, execute proceeds', async () => {
      const r = new ToolRegistry()
      let hookCalled = false
      r.registerMCP('srv', [{
        name: 'echo',
        description: 'echo',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => 'ran',
      }])
      r.registerSecurityHook(() => { hookCalled = true })
      const result = await r.execute('srv__echo', { reason: 'hook-allow' })
      expect(hookCalled).toBe(true)
      expect(result).toBe('ran')
    })

    it('securityHook block: hook returns Error, execute throws before executor', async () => {
      const r = new ToolRegistry()
      let executorCalled = false
      r.registerMCP('srv', [{
        name: 'echo',
        description: 'echo',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => { executorCalled = true; return 'ran' },
      }])
      r.registerSecurityHook(() => new Error('blocked by policy'))
      await expect(r.execute('srv__echo', { reason: 'hook-block' }))
        .rejects.toThrow(/blocked by policy/)
      expect(executorCalled).toBe(false)
    })

    it('securityHook receives (args, ctx, toolName) for inspection', async () => {
      const r = new ToolRegistry()
      let captured: { args: unknown; name: string } | null = null
      r.registerMCP('srv', [{
        name: 'echo',
        description: 'echo',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => 'ran',
      }])
      r.registerSecurityHook((args, _ctx, name) => { captured = { args, name } })
      await r.execute('srv__echo', { text: 'hi', reason: 'inspect' })
      expect(captured).toEqual({ args: { text: 'hi', reason: 'inspect' }, name: 'srv__echo' })
    })

    it('multiple securityHooks run in order; first Error blocks', async () => {
      const r = new ToolRegistry()
      const order: string[] = []
      r.registerMCP('srv', [{
        name: 'echo',
        description: 'echo',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => 'ran',
      }])
      r.registerSecurityHook(() => { order.push('h1-allow') })
      r.registerSecurityHook(() => { order.push('h2-block'); return new Error('h2 says no') })
      r.registerSecurityHook(() => { order.push('h3-never') })
      await expect(r.execute('srv__echo', { reason: 'multi' })).rejects.toThrow(/h2 says no/)
      expect(order).toEqual(['h1-allow', 'h2-block'])
    })

    it('securityHook does NOT apply to system tools (trusted builtins bypass hooks)', async () => {
      const r = new ToolRegistry()
      let hookCalled = false
      r.registerSystemTool({
        name: 'sys',
        description: 'sys',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => 'sys-ok',
      })
      r.registerSecurityHook(() => { hookCalled = true; return new Error('should not run') })
      // System tool must execute despite a blocking hook.
      const result = await r.execute('sys', {})
      expect(result).toBe('sys-ok')
      expect(hookCalled).toBe(false)
    })
  })

  describe('v0.10.5: getToolCategory', () => {
    it('returns the declared category for a system tool', () => {
      const r = new ToolRegistry()
      r.registerSystemTool({
        name: 'reader',
        description: 'read-only tool',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => 'ok',
        category: 'read',
      })
      expect(r.getToolCategory('reader')).toBe('read')
    })

    it('defaults to command for a system tool without a category', () => {
      const r = new ToolRegistry()
      r.registerSystemTool({
        name: 'cmd',
        description: 'no category',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => 'ok',
      })
      expect(r.getToolCategory('cmd')).toBe('command')
    })

    it('defaults to command for MCP tools (conservative: unknown side effects)', () => {
      const r = new ToolRegistry()
      r.registerMCP('srv', [{
        name: 'mcp-tool',
        description: 'mcp',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => 'ok',
      }])
      expect(r.getToolCategory('srv__mcp-tool')).toBe('command')
    })

    it('returns the declared category for an MCP tool that opts in', () => {
      const r = new ToolRegistry()
      r.registerMCP('srv', [{
        name: 'search',
        description: 'read-only search',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => 'ok',
        category: 'read',
      }])
      expect(r.getToolCategory('srv__search')).toBe('read')
    })

    it('defaults to command for skills', () => {
      const r = new ToolRegistry()
      r.registerSkill({ name: 'plan', description: 'plan', execute: async () => 'ok' })
      expect(r.getToolCategory('plan')).toBe('command')
    })

    it('defaults to command for an unknown tool name', () => {
      const r = new ToolRegistry()
      expect(r.getToolCategory('does-not-exist')).toBe('command')
    })
  })

  // v0.10.6: text-skill registration and separation from the tool_call path.
  describe('v0.10.6: registerTextSkill / getTextSkill / getTextSkills / listTextSkills', () => {
    it('stores a text skill retrievable via getTextSkill', () => {
      const r = new ToolRegistry()
      r.registerTextSkill('style-guide', 'body content')
      const stored = r.getTextSkill('style-guide')
      expect(stored).toBeDefined()
      expect(stored!.name).toBe('style-guide')
      expect(stored!.body).toBe('body content')
      expect(stored!.whenToUse).toBeUndefined()
    })

    it('stores a text skill with an optional whenToUse hint', () => {
      const r = new ToolRegistry()
      r.registerTextSkill('poem', 'body', 'when writing poems')
      const stored = r.getTextSkill('poem')
      expect(stored!.whenToUse).toBe('when writing poems')
    })

    it('getTextSkills returns a snapshot array of all stored text skills', () => {
      const r = new ToolRegistry()
      r.registerTextSkill('a', 'body-a')
      r.registerTextSkill('b', 'body-b', 'hint-b')
      const all = r.getTextSkills()
      expect(all).toHaveLength(2)
      // Order is insertion order (Map iteration), not sorted — listTextSkills sorts.
      const names = all.map((s) => s.name)
      expect(names).toEqual(['a', 'b'])
    })

    it('listTextSkills returns sorted text-skill names', () => {
      const r = new ToolRegistry()
      r.registerTextSkill('zeta', 'b')
      r.registerTextSkill('alpha', 'b')
      r.registerTextSkill('mid', 'b')
      expect(r.listTextSkills()).toEqual(['alpha', 'mid', 'zeta'])
    })

    it('getTextSkills returns a fresh array each call (snapshot, not live)', () => {
      const r = new ToolRegistry()
      r.registerTextSkill('a', 'b')
      const first = r.getTextSkills()
      const second = r.getTextSkills()
      expect(first).not.toBe(second) // different array instances
      expect(first).toEqual(second) // same content
    })

    it('throws on duplicate text-skill registration (same name)', () => {
      const r = new ToolRegistry()
      r.registerTextSkill('dup', 'first')
      expect(() => r.registerTextSkill('dup', 'second')).toThrow(
        /Duplicate text skill registration: "dup"/,
      )
    })

    it('throws when a text skill name collides with an existing system tool', () => {
      const r = new ToolRegistry()
      r.registerSystemTool({
        name: 'bash',
        description: 'sys',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'sys',
      })
      expect(() => r.registerTextSkill('bash', 'body')).toThrow(
        /collides with an existing tool/,
      )
    })

    it('throws when a text skill name collides with an existing module skill', () => {
      const r = new ToolRegistry()
      r.registerSkill({ name: 'plan', description: 'd', execute: async () => 'ok' })
      expect(() => r.registerTextSkill('plan', 'body')).toThrow(
        /collides with an existing tool/,
      )
    })

    it('throws when a text skill name collides with an MCP flat name', () => {
      const r = new ToolRegistry()
      r.registerMCP('srv', [{
        name: 'tool',
        description: 'mcp',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'mcp',
      }])
      expect(() => r.registerTextSkill('srv__tool', 'body')).toThrow(
        /collides with MCP tool "srv__tool"/,
      )
    })
  })

  describe('v0.10.6: registerSkill rejects form:"text"', () => {
    it('throws when registerSkill is called with form:"text"', () => {
      const r = new ToolRegistry()
      expect(() =>
        r.registerSkill({
          name: 'should-be-text',
          description: 'd',
          form: 'text',
          body: 'content',
          execute: async () => 'content',
        }),
      ).toThrow(/use registerTextSkill instead/)
    })

    it('accepts form:"module" (explicit module stamping)', () => {
      const r = new ToolRegistry()
      r.registerSkill({
        name: 'mod',
        description: 'd',
        form: 'module',
        execute: async () => 'ok',
      })
      expect(r.getSkill('mod')).toBeDefined()
    })

    it('accepts skills without a form field (legacy default = module)', () => {
      const r = new ToolRegistry()
      r.registerSkill({ name: 'legacy', description: 'd', execute: async () => 'ok' })
      expect(r.getSkill('legacy')).toBeDefined()
    })
  })

  describe('v0.10.6: text skills do NOT appear in toOpenAIToolSchemas', () => {
    it('text skills are excluded from the callable tool schema list', () => {
      const r = new ToolRegistry()
      r.registerTextSkill('style-guide', 'injected content')
      r.registerSkill({ name: 'plan', description: 'callable', execute: async () => 'ok' })
      const schemas = r.toOpenAIToolSchemas()
      // Module skill appears as a callable tool.
      expect(schemas.some((s) => s.function.name === 'plan')).toBe(true)
      // Text skill does NOT appear — it is pre-injected, not callable.
      expect(schemas.some((s) => s.function.name === 'style-guide')).toBe(false)
    })
  })

  describe('v0.10.6: execute does NOT dispatch text skills', () => {
    it('execute throws "not registered" for a text-skill name', async () => {
      const r = new ToolRegistry()
      r.registerTextSkill('style-guide', 'body')
      // textSkills are not in execute's dispatch path — calling execute on a
      // text-skill name must fail with "not registered", same as an unknown name.
      await expect(r.execute('style-guide', { reason: 'test' })).rejects.toThrow(
        /not registered/,
      )
    })
  })

  // v0.16: SystemSecurityHook was superseded by the SecurityDoor system.
  // registerSystemSecurityHook is now commented out / unavailable. These tests
  // verify the new SecurityDoor-based behavior for system tools.
  describe('v0.16: SecurityDoor replaces systemSecurityHook', () => {
    it('rejects a forged tool call before SecurityDoor approval when the agent lacks the ref', async () => {
      const r = new ToolRegistry()
      let doorCalls = 0
      let executorCalls = 0
      r.registerDoor({
        name: 'approval-door',
        check: () => { doorCalls += 1; return { allow: true } },
      })
      r.registerSystemTool({
        name: 'write', description: '',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => { executorCalls += 1; return 'written' },
      })

      await expect(r.execute('write', { reason: 'forge' }, {
        allowedToolRefs: ['read'],
        sessionId: 'scout',
      })).rejects.toThrow('not available to this agent')
      expect(doorCalls).toBe(0)
      expect(executorCalls).toBe(0)
    })

    it('passes the door grant into a shell tool before execute', async () => {
      const r = new ToolRegistry()
      let handlerCalls = 0
      r.registerDoor(createWriteApprovalDoor({
        handler: async () => {
          handlerCalls++
          return 'approved'
        },
      }))
      r.registerSystemTool({
        name: 'bash', description: '',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async (args, ctx) => resolveShellTimeout(
          (args as { timeout?: unknown }).timeout,
          ctx,
          'bash',
          'npm test',
        ),
      })

      await expect(r.execute('bash', {
        command: 'npm test', timeout: null, reason: 'long test',
      }, { sessionId: 's1' })).resolves.toBeUndefined()
      expect(handlerCalls).toBe(1)
    })

    it('full permission bypasses the door and still reaches the tool as unlimited', async () => {
      const r = new ToolRegistry()
      let handlerCalls = 0
      r.registerDoor(createWriteApprovalDoor({
        handler: async () => {
          handlerCalls++
          return 'approved'
        },
      }))
      r.createSession('s1', { fullPermission: true })
      r.registerSystemTool({
        name: 'bash', description: '',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async (args, ctx) => resolveShellTimeout(
          (args as { timeout?: unknown }).timeout,
          ctx,
          'bash',
          'npm test',
        ),
      })

      await expect(r.execute('bash', {
        command: 'npm test', timeout: null, reason: 'long test',
      }, { sessionId: 's1' })).resolves.toBeUndefined()
      expect(handlerCalls).toBe(0)
    })

    it('SecurityDoor runs for system tools', async () => {
      const r = new ToolRegistry()
      let doorCalled = false
      r.registerDoor({
        name: 'test-door',
        check: () => { doorCalled = true; return { allow: true } },
      })
      r.registerSystemTool({
        name: 'sys', description: '',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => 'ok',
      })
      await r.execute('sys', { reason: 'test' })
      expect(doorCalled).toBe(true)
    })

    it('SecurityDoor can block system tool', async () => {
      const r = new ToolRegistry()
      let executorCalled = false
      r.registerDoor({
        name: 'block-door',
        check: () => ({ allow: false, reason: 'blocked by policy' }),
      })
      r.registerSystemTool({
        name: 'sys', description: '',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => { executorCalled = true; return 'ok' },
      })
      await expect(r.execute('sys', { reason: 'test' })).rejects.toThrow(/blocked by policy/)
      expect(executorCalled).toBe(false)
    })

    it('async SecurityDoor can block', async () => {
      const r = new ToolRegistry()
      r.registerDoor({
        name: 'async-block-door',
        check: async () => {
          await new Promise(resolve => setTimeout(resolve, 10))
          return { allow: false, reason: 'async blocked' }
        },
      })
      r.registerSystemTool({
        name: 'sys', description: '',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => 'ok',
      })
      await expect(r.execute('sys', { reason: 'test' })).rejects.toThrow(/async blocked/)
    })

    it('existing securityHook does NOT apply to system tools (still works)', async () => {
      // Ensure MCP/skill SecurityHook does not affect system tools.
      const r = new ToolRegistry()
      let mcpHookCalled = false
      r.registerMCP('srv', [{
        name: 'echo', description: '',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => 'echo-ok',
      }])
      r.registerSecurityHook(() => { mcpHookCalled = true; return new Error('should not run') })
      // System tool should execute despite the MCP hook.
      r.registerSystemTool({
        name: 'sys', description: '',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => 'sys-ok',
      })
      const result = await r.execute('sys', { reason: 'test' })
      expect(result).toBe('sys-ok')
      expect(mcpHookCalled).toBe(false)
    })

    it('multiple SecurityDoors run in order; first reject blocks', async () => {
      const r = new ToolRegistry()
      const order: string[] = []
      r.registerDoor({
        name: 'd1',
        check: () => { order.push('d1-allow'); return { allow: true } },
      })
      r.registerDoor({
        name: 'd2',
        check: () => { order.push('d2-block'); return { allow: false, reason: 'd2 says no' } },
      })
      r.registerDoor({
        name: 'd3',
        check: () => { order.push('d3-never'); return { allow: true } },
      })
      r.registerSystemTool({
        name: 'sys', description: '',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => 'ran',
      })
      await expect(r.execute('sys', { reason: 'multi' })).rejects.toThrow(/d2 says no/)
      expect(order).toEqual(['d1-allow', 'd2-block'])
    })

    it('SecurityDoor receives (sessionId, state, toolName, args, ctx) for inspection', async () => {
      const r = new ToolRegistry()
      let captured: { args: unknown; name: string } | null = null
      r.registerDoor({
        name: 'inspect-door',
        check: (_sessionId, _state, name, args) => { captured = { args, name }; return { allow: true } },
      })
      r.registerSystemTool({
        name: 'sys', description: '',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => 'ran',
      })
      await r.execute('sys', { text: 'hi', reason: 'inspect' })
      expect(captured).toEqual({ args: { text: 'hi', reason: 'inspect' }, name: 'sys' })
    })
  })
})
