// v0.32 — 生产装配契约测试（Phase 3 第一优先）。
//
// 价值：断言 createHostAssembly 产出的 loop options 里「该接上的东西确实被接上了」。
// 单元测试自己 new HookSystem / new ContextInjector 测逻辑，从不走生产装配路径，
// 于是「实现了但没接线」的缺陷（P0：事件型 HookSystem 全未接线）会让所有单测全绿、
// 生产零触发。本测试从装配入口出发，拦截真正传给 runIMLoop 的 options 并断言其契约。
//
// 任何未来的「实现了但没接线」都会立刻红灯：contextInjector / mailbox / systemToolRefs /
// systemPrompt / hooks / signal / streamChat 缺失即失败。

import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// 拦截 runIMLoop，捕获生产装配真正传给主循环的 options（不跑真循环）。
const { captured } = vi.hoisted(() => ({ captured: { opts: undefined as any } }))
vi.mock('../../src/im/loop.js', async (importOriginal) => {
  const mod = (await importOriginal()) as any
  return {
    ...mod,
    runIMLoop: async (opts: any) => {
      captured.opts = opts
      return { reason: 'completed', finalState: 'Running', turns: [] }
    },
  }
})

import { createHostAssembly } from '../../src/host/assembly.js'
import type { HostAssembly } from '../../src/host/assembly.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'assembly-contract-'))
let assembly: HostAssembly
let sessionId: string
let workDir: string

beforeAll(async () => {
  assembly = await createHostAssembly({ dataDir: join(tmpRoot, 'sessions'), mock: true })
  workDir = join(tmpRoot, 'ws')
  const handle = await assembly.handlers.session.create({ workDir })
  sessionId = handle.info.id
  // 授予全权限，避免写审批走 gate 阻塞，确保 runPrompt 进到 runIMLoop。
  await assembly.gate.command({ kind: 'permission.full', sessionId, enabled: true })
  // 跑一轮，runIMLoop 被拦截、options 落入 captured。
  await assembly.handlers.runPrompt(sessionId, 'hi')
})

afterAll(async () => {
  await assembly?.shutdown()
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('production loop options contract (wired-in assertions)', () => {
  it('captures the loop options produced by createHostAssembly', () => {
    expect(captured.opts).toBeDefined()
  })

  it('systemPrompt is a non-empty string (built from v0.19 Chinese template + tool list)', () => {
    expect(typeof captured.opts.systemPrompt).toBe('string')
    expect(captured.opts.systemPrompt.length).toBeGreaterThan(0)
  })

  it('contextInjector is wired (MEMORY.md/ARCHITECTURE.md runtime injection reaches the model)', () => {
    expect(captured.opts.contextInjector).toBeDefined()
  })

  it('mailbox is wired (per-session agent-to-agent communication survives across turns)', () => {
    expect(captured.opts.mailbox).toBeDefined()
  })

  it('systemToolRefs is a non-empty array (model actually receives system tools, not an empty tools array)', () => {
    expect(Array.isArray(captured.opts.systemToolRefs)).toBe(true)
    expect(captured.opts.systemToolRefs.length).toBeGreaterThan(0)
  })

  it('streamChat is a function (LLM transport resolved, not undefined)', () => {
    expect(typeof captured.opts.streamChat).toBe('function')
  })

  it('signal is a real AbortSignal (turn.cancel actually propagates to the loop)', () => {
    expect(captured.opts.signal).toBeInstanceOf(AbortSignal)
  })

  it('hooks chain is wired (tool-table fold + rendering forward + gate hooks merged)', () => {
    expect(captured.opts.hooks).toBeDefined()
    expect(typeof captured.opts.hooks.afterToolExecution).toBe('function')
  })

  it('registry is wired (builtin + system + mcp tools registered into the session)', () => {
    expect(captured.opts.registry).toBeDefined()
  })

  it('keeps compressor-private submit_curated_memory out of the working agent surface', () => {
    expect(captured.opts.registry.getSystemTool('submit_curated_memory')).toBeDefined()
    expect(captured.opts.systemToolRefs).not.toContain('submit_curated_memory')
    expect(captured.opts.systemPrompt).not.toContain('submit_curated_memory')
  })

  // ---- B 逐字段核查：装配产出的每个字段，loop 是否真的消费 ----
  it('driveCoordinator is wired (was previously a noop; compressor scheduling now live)', () => {
    // loop.ts:553 `if (!opts.driveCoordinator) return` —— 可选链静默跳过候选。
    // 此处断言它确实被装配层传入（非 undefined），否则压缩调度静默失效。
    expect(captured.opts.driveCoordinator).toBeDefined()
    expect(typeof captured.opts.driveCoordinator.tick).toBe('function')
  })

  it('onStreamChunk is wired (delta-bridge 流式增量旁路接入 loop)', () => {
    expect(typeof captured.opts.onStreamChunk).toBe('function')
  })

  it('requestHandler is wired (宿主请求处理器接入 loop)', () => {
    expect(typeof captured.opts.requestHandler).toBe('function')
  })

  it('rendering base is wired (bus + base + store 透传给 loop 渲染路径)', () => {
    expect(captured.opts.rendering).toBeDefined()
    expect(captured.opts.rendering.bus).toBeDefined()
    expect(captured.opts.rendering.base).toBeDefined()
    expect(captured.opts.rendering.store).toBeDefined()
  })

  it('workDir is threaded into loop options (context-injection 根目录 = 用户工作文件夹, not cwd)', () => {
    expect(typeof captured.opts.workDir).toBe('string')
    expect(captured.opts.workDir).toBe(workDir)
  })

  it('mcpRefs / skillRefs are arrays (tool disclosure surface present)', () => {
    expect(Array.isArray(captured.opts.mcpRefs)).toBe(true)
    expect(Array.isArray(captured.opts.skillRefs)).toBe(true)
  })

  it('subAgentDepth is set (0 = top-level working agent)', () => {
    expect(captured.opts.subAgentDepth).toBe(0)
  })

  it('systemAgents is wired (default non-noop)', () => {
    expect(captured.opts.systemAgents).toBeDefined()
  })

  it('conversationMemory / databus / stateLine / workingAgentId present (loop core deps)', () => {
    expect(captured.opts.conversationMemory).toBeDefined()
    expect(captured.opts.databus).toBeDefined()
    expect(captured.opts.stateLine).toBeDefined()
    expect(typeof captured.opts.workingAgentId).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// C — 两宿主一致性：CLI(main/headless) 与 web-host 都只调用 createHostAssembly，
// 传入的仅是配置级参数（dataDir/mock/logComponent/memoryConfig/skillsDir/
// textSkillsDir/untrustedUpstream）。真正的 loop 接线全部集中在 assembly.ts 内部，
// 与宿主无关。本组锁定：无论用哪套宿主参数创建装配，产出的 loop options 接线集合完全一致。
// ---------------------------------------------------------------------------
describe('production loop options contract — host consistency (CLI vs web-host)', () => {
  const profiles = [
    { label: 'cli-main', opts: { mock: true, logComponent: 'he-cli', logToStderr: false } as const },
    { label: 'web-host', opts: { mock: true, logComponent: 'web-host', untrustedUpstream: true } as const },
  ]
  const captures: Record<string, any> = {}
  const assemblies: HostAssembly[] = []
  const tmpDirs: string[] = []

  beforeAll(async () => {
    for (const p of profiles) {
      const dir = mkdtempSync(join(tmpdir(), `assembly-consistency-${p.label}-`))
      tmpDirs.push(dir)
      const assembly = await createHostAssembly({ dataDir: join(dir, 'sessions'), ...p.opts })
      assemblies.push(assembly)
      const handle = await assembly.handlers.session.create({ workDir })
      await assembly.gate.command({ kind: 'permission.full', sessionId: handle.info.id, enabled: true })
      await assembly.handlers.runPrompt(handle.info.id, 'hi')
      captures[p.label] = captured.opts
    }
  })

  afterAll(async () => {
    for (const a of assemblies) await a.shutdown()
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
  })

  const WIRING_KEYS = [
    'systemPrompt', 'contextInjector', 'mailbox', 'systemToolRefs', 'streamChat',
    'signal', 'hooks', 'registry', 'driveCoordinator', 'onStreamChunk', 'requestHandler',
    'rendering', 'conversationMemory', 'databus', 'stateLine', 'workingAgentId',
  ] as const

  for (const p of profiles) {
    it(`[${p.label}] all wiring keys present`, () => {
      for (const k of WIRING_KEYS) expect(captured.opts?.[k] ?? captures[p.label][k], `${p.label}.${k}`).toBeDefined()
    })
  }

  it('web-host profile yields the same wiring shape as cli-main profile (no capability dropped on one line)', () => {
    for (const k of WIRING_KEYS) {
      const a = captures['cli-main'][k]
      const b = captures['web-host'][k]
      // 同一契约：同类字段要么都 defined、要么都 undefined；不允许一个接上一个没接。
      expect((a === undefined) === (b === undefined), `wiring mismatch on ${k}`).toBe(true)
    }
    // 工具面与提示词必须一致（同一 registry 暴露清单）。
    expect(captures['web-host'].systemToolRefs).toEqual(captures['cli-main'].systemToolRefs)
    expect(typeof captures['web-host'].systemPrompt).toBe(typeof captures['cli-main'].systemPrompt)
  })
})

// ---------------------------------------------------------------------------
// v0.34 D10：mailbox 落盘/恢复**接线验收**（AGENTS.md §5）。
// 单测能证明 Mailbox 类会写盘，但证明不了「生产装配把它接上了」——那正是历史上
// 反复出现的「实现≠接线≠生效」。本组从装配入口出发，落盘/回灌两条路径都验。
// ---------------------------------------------------------------------------
describe('mailbox persistence wiring (v0.34 D10)', () => {
  // 注意：`captured` 是文件级共享持有者，前面的 host-consistency describe 的
  // beforeAll 会把它覆盖成另一个装配（不同 dataDir）的 options。这里必须重新
  // 在本 describe 的装配上跑一轮，才能拿到**本会话**真正的 loop options。
  beforeAll(async () => {
    await assembly.handlers.runPrompt(sessionId, 'hi')
  })

  const waitFor = async (cond: () => boolean, timeoutMs = 3000): Promise<boolean> => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (cond()) return true
      await new Promise((r) => setTimeout(r, 10))
    }
    return cond()
  }

  it('生产装配置出的 mailbox 落盘：systemSend 后会话目录出现 mailbox.jsonl', async () => {
    const mb = captured.opts.mailbox as { systemSend: (m: any) => string }
    mb.systemSend({ from: 'drive-coordinator', to: 'compressor', subject: 'wired-check', body: 'go' })

    const file = join(tmpRoot, 'sessions', sessionId, 'mailbox.jsonl')
    // 落盘端口是 fire-and-forget（发送 API 同步），故轮询而非固定 sleep。
    const ok = await waitFor(() => existsSync(file) && readFileSync(file, 'utf-8').includes('wired-check'))
    expect(ok, `expected ${file} to contain the mail`).toBe(true)
  })

  it('新装配 open 同一会话时回灌未读邮件（重启不丢信）', async () => {
    const file = join(tmpRoot, 'sessions', sessionId, 'mailbox.jsonl')
    // 直接在磁盘上放一封"上次进程遗留"的邮件，模拟重启前的状态。
    appendFileSync(
      file,
      JSON.stringify({
        id: 'M-777-persisted',
        from: 'drive-coordinator',
        to: 'compressor',
        subject: 'survived-restart',
        body: 'work item',
        sentAt: Date.now(),
        read: false,
      }) + '\n',
      'utf-8',
    )

    const second = await createHostAssembly({ dataDir: join(tmpRoot, 'sessions'), mock: true })
    try {
      await second.handlers.session.open(sessionId)
      await second.handlers.runPrompt(sessionId, 'hi') // 触发 buildLoopOptions，captured 刷新
      const mb = captured.opts.mailbox as { readOwnInbox: (a: string) => readonly { subject: string }[] }
      const unread = mb.readOwnInbox('compressor')
      expect(unread.some((m) => m.subject === 'survived-restart')).toBe(true)
    } finally {
      await second.shutdown()
    }
  })

  it('markRead 热路径回写：send 后立即读，重开装配已读状态不回退（方案 A）', async () => {
    const mb = captured.opts.mailbox as {
      systemSend: (m: { from: string; to: string; subject: string; body: string }) => string
      markRead: (a: string) => void
    }
    // send（append 在飞）与 markRead（rewrite）背靠背——装配的写串行队列
    // 保证 rewrite 落在 append 之后，文件不坏行、read 状态确定性落盘。
    mb.systemSend({ from: 'drive-coordinator', to: 'compressor', subject: 'read-check', body: 'go' })
    mb.markRead('compressor')

    const file = join(tmpRoot, 'sessions', sessionId, 'mailbox.jsonl')
    const ok = await waitFor(() => existsSync(file) && readFileSync(file, 'utf-8').includes('"read":true'))
    expect(ok, `expected ${file} to contain "read":true`).toBe(true)

    // 重开装配（模拟重启）：已读邮件不再计入未读。
    const second = await createHostAssembly({ dataDir: join(tmpRoot, 'sessions'), mock: true })
    try {
      await second.handlers.session.open(sessionId)
      await second.handlers.runPrompt(sessionId, 'hi')
      const mb2 = captured.opts.mailbox as {
        readOwnInbox: (a: string, o?: { unreadOnly?: boolean }) => readonly { subject: string; read: boolean }[]
      }
      expect(mb2.readOwnInbox('compressor').some((m) => m.subject === 'read-check')).toBe(false)
      const all = mb2.readOwnInbox('compressor', { unreadOnly: false })
      expect(all.some((m) => m.subject === 'read-check' && m.read === true)).toBe(true)
    } finally {
      await second.shutdown()
    }
  })
})

// ---------------------------------------------------------------------------
// noNetworkTools（DeepSWE 空网评测）：装配层剔除全部联网通道。机制层禁——
// 工具不进 systemToolRefs，提示词清单与 tools 数组同源同步消失，不存在
// "提示词说不能上网、工具列表却有"的自相矛盾。
// ---------------------------------------------------------------------------
describe('noNetworkTools (air-gapped eval: network channels stripped at assembly)', () => {
  const NETWORK_TOOLS = ['web_fetch', 'open_url']
  let netAssembly: HostAssembly
  let plainAssembly: HostAssembly
  let netSessionId: string
  let plainSessionId: string
  const dirs: string[] = []

  beforeAll(async () => {
    const netDir = mkdtempSync(join(tmpdir(), 'assembly-nonet-'))
    const plainDir = mkdtempSync(join(tmpdir(), 'assembly-plain-'))
    dirs.push(netDir, plainDir)
    const wsDir = join(tmpRoot, 'ws-nonet')

    netAssembly = await createHostAssembly({ dataDir: join(netDir, 'sessions'), mock: true, noNetworkTools: true })
    plainAssembly = await createHostAssembly({ dataDir: join(plainDir, 'sessions'), mock: true })
    const h1 = await netAssembly.handlers.session.create({ workDir: wsDir })
    const h2 = await plainAssembly.handlers.session.create({ workDir: wsDir })
    netSessionId = h1.info.id
    plainSessionId = h2.info.id
    await netAssembly.gate.command({ kind: 'permission.full', sessionId: netSessionId, enabled: true })
    await plainAssembly.gate.command({ kind: 'permission.full', sessionId: plainSessionId, enabled: true })
  })

  afterAll(async () => {
    await netAssembly?.shutdown()
    await plainAssembly?.shutdown()
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  // captured 是文件级共享单槽：每次捕获前先跑对应装配的一轮，读后立即存。
  it('noNetworkTools 装配剔除 web_fetch/open_url；默认装配保留；系统工具面只少这两个', async () => {
    await netAssembly.handlers.runPrompt(netSessionId, 'hi')
    const net = { ...captured.opts }
    await plainAssembly.handlers.runPrompt(plainSessionId, 'hi')
    const plain = { ...captured.opts }

    for (const t of NETWORK_TOOLS) {
      expect(net.systemToolRefs.includes(t), `noNetworkTools should strip ${t}`).toBe(false)
      expect(plain.systemToolRefs.includes(t), `default assembly should keep ${t}`).toBe(true)
    }
    // net ⊆ plain：只有被剔除的联网工具差异。
    expect(net.systemToolRefs.filter((n: string) => !plain.systemToolRefs.includes(n))).toEqual([])
    expect(net.systemToolRefs.length).toBe(plain.systemToolRefs.length - NETWORK_TOOLS.length)
  })
})
  // ---------------------------------------------------------------------------
// P0 红灯发现（已确认，转为 it.todo 待用户裁决 —— 不改 src）：
// createHostAssembly.runPromptOnce 在 buildLoopOptions 时从不传 hookSystem，
// 而 loop.ts 的 4 个生命周期 emit（SessionStart/TurnEnd/SessionEnd/PostToolUse，
// 加 PreToolUse）全部是 opts.hookSystem?.emit(...)。生产环境 hookSystem 恒为
// undefined → 5 类事件零触发。临时断言 expect(captured.opts.hookSystem).toBeDefined()
// 实测失败（undefined），证实 P0。修复方向：assembly 内 new HookSystem() 并传入
// buildLoopOptions 的 hookSystem 字段。
// ---------------------------------------------------------------------------
describe('production loop options contract — KNOWN GAP (P0, not yet wired)', () => {
  it.todo(
    'hookSystem must be wired into production loop options — P0: createHostAssembly never constructs ' +
      'HookSystem, so SessionStart/TurnEnd/SessionEnd/PreToolUse/PostToolUse never fire in production. ' +
      'Fix in src/host/assembly.ts (new HookSystem() + pass into buildLoopOptions.hookSystem).',
  )
})
