// v0.25 Wave B — Gate 新命令（mcp.* / subagent.* / settings.* / extensions.info）
// 路由单元测试。仿 gate.test.ts 的款式；provider 分支先例（v0.23）无独立测试
// 文件，本文件按同款式新建。
//
// 覆盖：9 个新命令各两态——
//   1. handler 提供时 → 正确路由到 mock handler（参数原样透传）
//   2. handler 缺省时 → 干净英文错误（requires a ... handler）

import { describe, it, expect, vi } from 'vitest'

import { createSignalGate } from '../../src/signals/gate.js'
import type { SignalGateHandlers } from '../../src/signals/types.js'
import type { SubAgentConfig } from '../../src/im/sub-agent/config.js'
import type { DatabusSettings } from '../../src/config/databus-settings.js'

/** 最小 handlers mock：required 成员给 never 分支，optional 四组按需注入。 */
const makeHandlers = (optional: Partial<SignalGateHandlers> = {}): SignalGateHandlers => ({
  runPrompt: vi.fn(async () => {
    throw new Error('runPrompt: not implemented in tests')
  }),
  session: {
    create: vi.fn(async () => {
      throw new Error('create: not implemented in tests')
    }),
    open: vi.fn(async () => {
      throw new Error('open: not implemented in tests')
    }),
    list: vi.fn(async () => []),
    close: vi.fn(async (_id: string) => {}),
    delete: vi.fn(async (_id: string) => {}),
    history: vi.fn(async (_id: string) => [] as const),
  },
  cancel: vi.fn((_sessionId: string) => {}),
  setFullPermission: vi.fn((_sessionId: string, _enabled: boolean) => {}),
  ...optional,
})

const subAgentCfg = (): SubAgentConfig => ({
  name: 'helper',
  systemPrompt: 'you help',
  toolRefs: ['read_file'],
})

describe('SignalGate Wave B commands — routed when the handler is provided', () => {
  it('routes mcp.list / mcp.upsert / mcp.delete to handlers.mcp', async () => {
    const mcp = {
      list: vi.fn(async () => ({ exists: false, configPath: '/x/mcp.json', servers: [] })),
      upsert: vi.fn(async () => ({ configPath: '/x/mcp.json' })),
      delete: vi.fn(async () => ({ configPath: '/x/mcp.json' })),
    }
    const gate = createSignalGate({ handlers: makeHandlers({ mcp }) })

    const server = { name: 's1', transport: 'stdio', command: 'npx' }
    await gate.command({ kind: 'mcp.list' })
    await gate.command({ kind: 'mcp.upsert', server })
    await gate.command({ kind: 'mcp.delete', name: 's1' })

    expect(mcp.list).toHaveBeenCalledTimes(1)
    // server 原样透传（unknown → validateMcpServerConfig 由宿主侧执行）。
    expect(mcp.upsert).toHaveBeenCalledWith(server)
    expect(mcp.delete).toHaveBeenCalledWith('s1')
  })

  it('routes subagent.list / subagent.upsert / subagent.delete to handlers.subagent', async () => {
    const subagent = {
      list: vi.fn(async () => ({ dir: '/agents', agents: [subAgentCfg()] })),
      upsert: vi.fn(async () => ({ dir: '/agents' })),
      delete: vi.fn(async () => ({ dir: '/agents' })),
    }
    const gate = createSignalGate({ handlers: makeHandlers({ subagent }) })

    const agent = subAgentCfg()
    await gate.command({ kind: 'subagent.list' })
    await gate.command({ kind: 'subagent.upsert', agent })
    await gate.command({ kind: 'subagent.delete', name: 'helper' })

    expect(subagent.list).toHaveBeenCalledTimes(1)
    expect(subagent.upsert).toHaveBeenCalledWith(agent)
    expect(subagent.delete).toHaveBeenCalledWith('helper')
  })

  it('routes settings.get / settings.set to handlers.settings', async () => {
    const settings = {
      get: vi.fn(async () => ({ subAgentNesting: true }) as DatabusSettings),
      set: vi.fn(async (patch: Partial<DatabusSettings>) => ({ subAgentNesting: true, ...patch })),
    }
    const gate = createSignalGate({ handlers: makeHandlers({ settings }) })

    await expect(gate.command({ kind: 'settings.get' })).resolves.toEqual({ subAgentNesting: true })

    const patch = { subAgentNesting: false, skillsDir: '/skills' }
    await gate.command({ kind: 'settings.set', patch })
    expect(settings.set).toHaveBeenCalledWith(patch)
  })

  it('routes extensions.info to handlers.extensions.info', async () => {
    const extensions = {
      info: vi.fn(async () => ({
        skills: ['a'],
        textSkills: [],
        servers: ['playwright'],
        skillsDir: '/skills',
      })),
    }
    const gate = createSignalGate({ handlers: makeHandlers({ extensions }) })

    const out = await gate.command({ kind: 'extensions.info' })
    expect(extensions.info).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ skills: ['a'], servers: ['playwright'] })
  })
})

describe('SignalGate Wave B commands — clean error when the handler is missing', () => {
  it('mcp.* throws "requires a mcp handler" without one', async () => {
    const gate = createSignalGate({ handlers: makeHandlers() })
    await expect(gate.command({ kind: 'mcp.list' })).rejects.toThrow(/requires a mcp handler/)
    await expect(gate.command({ kind: 'mcp.upsert', server: {} })).rejects.toThrow(
      /"mcp\.upsert" requires a mcp handler/,
    )
    await expect(gate.command({ kind: 'mcp.delete', name: 's1' })).rejects.toThrow(
      /requires a mcp handler/,
    )
  })

  it('subagent.* throws "requires a subagent handler" without one', async () => {
    const gate = createSignalGate({ handlers: makeHandlers() })
    await expect(gate.command({ kind: 'subagent.list' })).rejects.toThrow(
      /requires a subagent handler/,
    )
    await expect(gate.command({ kind: 'subagent.upsert', agent: subAgentCfg() })).rejects.toThrow(
      /requires a subagent handler/,
    )
    await expect(gate.command({ kind: 'subagent.delete', name: 'x' })).rejects.toThrow(
      /requires a subagent handler/,
    )
  })

  it('settings.* throws "requires a settings handler" without one', async () => {
    const gate = createSignalGate({ handlers: makeHandlers() })
    await expect(gate.command({ kind: 'settings.get' })).rejects.toThrow(
      /requires a settings handler/,
    )
    await expect(gate.command({ kind: 'settings.set', patch: {} })).rejects.toThrow(
      /requires a settings handler/,
    )
  })

  it('extensions.info throws "requires an extensions handler" without one', async () => {
    const gate = createSignalGate({ handlers: makeHandlers() })
    await expect(gate.command({ kind: 'extensions.info' })).rejects.toThrow(
      /requires an extensions handler/,
    )
  })
})
