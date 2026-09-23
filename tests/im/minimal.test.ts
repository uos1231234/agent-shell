// v0.12: verify createMinimalIM wires ctxDatabus from the AgentTree root.
//
// When a subAgentRegistry is provided, the working agent's private databus
// becomes root.ownDatabus (so children see the working agent's events via
// parent.ownDatabus), and ctxDatabus = [root.ownDatabus, root.familyDatabus]
// (D5) so the working agent sees its own history plus all children's events.
// Caller-supplied ctxDatabus is appended. When no registry is provided,
// behavior is identical to v0.11 (backward compat).

import { describe, it, expect } from 'vitest'
import { createMinimalIM, DEFAULT_WORKING_AGENT_TOOL_REFS } from '../../src/im/minimal.js'
import { Databus } from '../../src/im/databus.js'
import { SubAgentRegistry } from '../../src/im/sub-agent/index.js'
import { createConfig } from '../../src/shell/config.js'
import { ToolRegistry } from '../../src/shell/registry.js'
import { createNoopDriveCoordinator } from '../../src/im/system-agents/drive-coordinator.js'
import { Mailbox } from '../../src/im/mailbox/index.js'

const noopStreamChat = async function* (): AsyncIterable<never> {}

const makeBase = () => ({
  config: createConfig(),
  registry: new ToolRegistry(),
  streamChat: noopStreamChat as unknown as Parameters<typeof createMinimalIM>[0]['streamChat'],
  url: 'https://x',
  model: 'gpt-4',
  systemPrompt: '',
  userTemplate: '',
})

describe('im/minimal — ctxDatabus auto-wiring', () => {
  it('wires [root.ownDatabus, root.familyDatabus] when subAgentRegistry is provided', () => {
    const sub = new SubAgentRegistry()
    const opts = createMinimalIM({
      ...makeBase(),
      subAgentRegistry: sub,
    })
    expect(Array.isArray(opts.ctxDatabus)).toBe(true)
    const arr = opts.ctxDatabus as Databus[]
    expect(arr).toHaveLength(2)
    expect(arr[0]).toBe(sub.agentTree.root.ownDatabus)
    expect(arr[1]).toBe(sub.agentTree.root.familyDatabus)
  })

  it('binds base.databus to root.ownDatabus when subAgentRegistry is provided', () => {
    // v0.12: the working agent's private bus MUST be the root's ownDatabus so
    // children's ctxDatabus (which includes parent.ownDatabus) sees the working
    // agent's events. A caller-supplied opts.databus becomes root.ownDatabus via
    // rebindRoot — the caller bus IS the root bus, not ignored.
    const callerBus = new Databus()
    const sub = new SubAgentRegistry()
    const opts = createMinimalIM({
      ...makeBase(),
      databus: callerBus,
      subAgentRegistry: sub,
    })
    expect(opts.databus).toBe(sub.agentTree.root.ownDatabus)
    expect(sub.agentTree.root.ownDatabus).toBe(callerBus) // caller bus becomes root bus
  })

  it('wires only [own bus] when no subAgentRegistry and no caller ctxDatabus', () => {
    // v0.11.2 S2: when only the own bus would be present, ctxDatabus is NOT
    // set — the loop falls back to opts.databus. No single-element array,
    // no MultiDatabus wrapper.
    const opts = createMinimalIM({
      ...makeBase(),
    })
    expect(opts.ctxDatabus).toBeUndefined()
  })

  it('appends caller-supplied ctxDatabus (single Databus) after root buses', () => {
    const sub = new SubAgentRegistry()
    const extra = new Databus()
    const opts = createMinimalIM({
      ...makeBase(),
      subAgentRegistry: sub,
      ctxDatabus: extra,
    })
    const arr = opts.ctxDatabus as Databus[]
    expect(arr).toHaveLength(3)
    expect(arr[0]).toBe(sub.agentTree.root.ownDatabus)
    expect(arr[1]).toBe(sub.agentTree.root.familyDatabus)
    expect(arr[2]).toBe(extra)
  })

  it('appends caller-supplied ctxDatabus (array) after root buses', () => {
    const sub = new SubAgentRegistry()
    const extra1 = new Databus()
    const extra2 = new Databus()
    const opts = createMinimalIM({
      ...makeBase(),
      subAgentRegistry: sub,
      ctxDatabus: [extra1, extra2],
    })
    const arr = opts.ctxDatabus as Databus[]
    expect(arr).toHaveLength(4)
    expect(arr[0]).toBe(sub.agentTree.root.ownDatabus)
    expect(arr[1]).toBe(sub.agentTree.root.familyDatabus)
    expect(arr[2]).toBe(extra1)
    expect(arr[3]).toBe(extra2)
  })

  it('wires [own bus, extra] when caller ctxDatabus given but no subAgentRegistry', () => {
    // v0.11.2 S2: own + extra = 2 buses, so ctxDatabus IS set as an array.
    const own = new Databus()
    const extra = new Databus()
    const opts = createMinimalIM({
      ...makeBase(),
      databus: own,
      ctxDatabus: extra,
    })
    const arr = opts.ctxDatabus as Databus[]
    expect(arr).toHaveLength(2)
    expect(arr[0]).toBe(own)
    expect(arr[1]).toBe(extra)
  })

  it('passes driveCoordinator through when provided (G3)', () => {
    // v0.11.2 G3: createMinimalIM does NOT construct a driveCoordinator —
    // it only forwards what the caller gives. When omitted, the field is absent.
    const dc = createNoopDriveCoordinator()
    const opts = createMinimalIM({
      ...makeBase(),
      driveCoordinator: dc,
    })
    expect(opts.driveCoordinator).toBe(dc)
  })

  it('omits driveCoordinator when not provided (G3)', () => {
    const opts = createMinimalIM({
      ...makeBase(),
    })
    expect(opts.driveCoordinator).toBeUndefined()
  })

  it('syncs tree root id with custom workingAgentId', () => {
    // v0.12: rebindRoot aligns the tree root id with the caller's workingAgentId
    // before any children exist, so run_subagent can look up the current agent.
    const sub = new SubAgentRegistry()
    const opts = createMinimalIM({
      ...makeBase(),
      workingAgentId: 'custom-agent',
      subAgentRegistry: sub,
    })
    expect(sub.agentTree.root.id).toBe('custom-agent')
    expect(opts.workingAgentId).toBe('custom-agent')
  })

  it('rebindRoot rejects when tree already has children', () => {
    // v0.12: fail-closed — a tree that already has children cannot rebind its
    // root (would orphan the existing subtree). createMinimalIM must throw.
    const sub = new SubAgentRegistry()
    sub.agentTree.registerChild('main', 'child-1')
    expect(() =>
      createMinimalIM({
        ...makeBase(),
        workingAgentId: 'renamed',
        subAgentRegistry: sub,
      }),
    ).toThrow('Cannot rebind root: tree already has children')
  })

  it('auto-injects agentTree into Mailbox when subAgentRegistry is provided', () => {
    // v0.12 P0-fix: createMinimalIM must wire subAgentRegistry.agentTree into
    // the default Mailbox so verifyRoute enforces lineage isolation in
    // production. This was the P0 bug — the tree was never passed to Mailbox.
    const sub = new SubAgentRegistry()
    const opts = createMinimalIM({
      ...makeBase(),
      subAgentRegistry: sub,
    })
    // Register two cousin agents to test route enforcement
    sub.agentTree.registerChild('main', 'child-a')
    sub.agentTree.registerChild('main', 'child-b')
    sub.agentTree.registerChild('child-a', 'grandchild-a1')
    sub.agentTree.registerChild('child-b', 'grandchild-b1')
    // Cousin mail (grandchild-a1 -> grandchild-b1) must be rejected
    expect(() =>
      opts.mailbox!.send({ from: 'grandchild-a1', to: 'grandchild-b1', subject: 'x', body: 'x' }),
    ).toThrow('Mailbox route rejected')
    // Direct lineage mail (main -> child-a) must succeed
    const id = opts.mailbox!.send({ from: 'main', to: 'child-a', subject: 'hello', body: 'hello' })
    expect(id).toMatch(/^M-/)
  })

  it('does not inject agentTree when no subAgentRegistry (backward compat)', () => {
    // v0.12: without a registry, Mailbox has no tree — route checks are no-op.
    // This preserves backward compat for callers that don't use sub-agents.
    const opts = createMinimalIM({
      ...makeBase(),
    })
    // Any agent can send to any agent (no route enforcement)
    const id = opts.mailbox!.send({ from: 'agent-x', to: 'agent-y', subject: 'x', body: 'x' })
    expect(id).toMatch(/^M-/)
  })

  it('respects caller-supplied mailbox without injecting agentTree', () => {
    // v0.12: when the caller provides their own mailbox, createMinimalIM
    // uses it as-is. The caller is responsible for wiring agentTree if needed.
    const callerMailbox = new Mailbox()
    const sub = new SubAgentRegistry()
    const opts = createMinimalIM({
      ...makeBase(),
      subAgentRegistry: sub,
      mailbox: callerMailbox,
    })
    expect(opts.mailbox).toBe(callerMailbox)
    // callerMailbox has no tree, so route checks are no-op
    const id = opts.mailbox!.send({ from: 'anyone', to: 'anyone-else', subject: 'x', body: 'x' })
    expect(id).toMatch(/^M-/)
  })
})

describe('im/minimal — default systemToolRefs (v0.12.2)', () => {
  it('uses DEFAULT_WORKING_AGENT_TOOL_REFS when systemToolRefs is omitted', () => {
    const opts = createMinimalIM({ ...makeBase() })
    expect(opts.systemToolRefs).toEqual([...DEFAULT_WORKING_AGENT_TOOL_REFS])
    // compress_block must be absent (retired)
    expect(opts.systemToolRefs).not.toContain('compress_block')
    // ask_recall must be present (working -> recall bridge)
    expect(opts.systemToolRefs).toContain('ask_recall')
  })

  it('uses the caller-supplied systemToolRefs when explicitly provided', () => {
    const opts = createMinimalIM({
      ...makeBase(),
      systemToolRefs: ['state_query'],
    })
    expect(opts.systemToolRefs).toEqual(['state_query'])
  })
})

describe('im/minimal — v0.16 security sessionId (Q1-B)', () => {
  it('mints a fresh sessionId per call (one call = one session)', () => {
    const a = createMinimalIM({ ...makeBase() })
    const b = createMinimalIM({ ...makeBase() })
    expect(a.sessionId).toBeDefined()
    expect(b.sessionId).toBeDefined()
    expect(a.sessionId).not.toBe(b.sessionId)
  })

  it('two calls sharing a registry do not crash (getOrCreateSession is idempotent)', () => {
    // Regression for the P0 bug: createSession('main') would throw on the
    // second createMinimalIM call sharing a registry. Q1-B fixes this by
    // minting a fresh UUID per call instead of keying on workingAgentId.
    const registry = new ToolRegistry()
    const sub = new SubAgentRegistry()
    const first = createMinimalIM({ ...makeBase(), registry, subAgentRegistry: sub })
    const second = createMinimalIM({ ...makeBase(), registry, subAgentRegistry: sub })
    expect(first.sessionId).toBeDefined()
    expect(second.sessionId).toBeDefined()
    // The registry lazily creates each UUID session — no throw, no shared state.
    const s1 = registry.getOrCreateSession(first.sessionId)
    const s2 = registry.getOrCreateSession(second.sessionId)
    expect(s1).not.toBe(s2)
  })

  it('respects a caller-pinned securitySessionId', () => {
    const opts = createMinimalIM({
      ...makeBase(),
      securitySessionId: 'pinned-session',
    })
    expect(opts.sessionId).toBe('pinned-session')
  })
})
