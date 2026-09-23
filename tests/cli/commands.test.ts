// v0.26 Wave 4 — /命令系统单测（计划 DoD Wave 4）。
//
// 覆盖：resolveSlashInput 三分（message / builtin / blocked / 未知降级 /
// 别名 / 参数切分）；tabComplete（名字前缀 + 别名归一 + subagent 参数补全）；
// buildHelpLines 覆盖全部注册表条目；executeCommand 快乐路径（stub gate 录制
// 发出的命令）+ 错误路径（gate.command 拒绝 → 状态行、不向调用方抛出）；
// /export 真实落盘（node:fs，临时目录）。

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import type { GateCommand, SignalGate } from '../../src/signals/types.js'
import type { SessionInfo } from '../../src/im/session/types.js'
import type { ConversationTurn } from '../../src/im/conversation-memory.js'
import type { IMLoopResult } from '../../src/im/loop.js'
import type { GoalState } from '../../src/im/goal/types.js'
import type { WorkflowState } from '../../src/host/workflow/types.js'
import { createMetrics } from '../../src/shell/metrics.js'
import { LineEditor } from '../../cli/editor.js'
import { InputRouter } from '../../cli/input-state.js'
import { applySignal, createSessionView, setActiveSession } from '../../cli/session-view.js'
import {
  buildVersionLines,
  cliVersion,
  executeCommand,
  extractLastAssistantText,
  maskKey,
  parseKeyValueArgs,
  type CommandContext,
} from '../../cli/commands/handlers.js'
import { buildHelpLines, resolveSlashInput, tabComplete } from '../../cli/commands/dispatch.js'
import { CLI_SLASH_COMMANDS } from '../../cli/commands/registry.js'

// ---------------------------------------------------------------------------
// stub 基础设施
// ---------------------------------------------------------------------------

/** 录制命令的假 gate：replies 按 cmd.kind 给回执；Error 值 = 该命令拒绝；
 *  `{ __throw: v }` = 抛出非 Error 值 v（测非 Error 抛出物收敛）。 */
const stubGate = (replies: Partial<Record<GateCommand['kind'], unknown>> = {}) => {
  const issued: GateCommand[] = []
  const gate: SignalGate = {
    emit: () => {},
    on: () => () => {},
    request: async () => undefined,
    resolve: () => {},
    snapshot: () => ({ sessions: [], pendingRequests: 0, subscribers: 0, emitted: 0 }),
    command: async (cmd) => {
      issued.push(cmd)
      const r = replies[cmd.kind]
      if (r instanceof Error) throw r
      if (typeof r === 'object' && r !== null && '__throw' in r) {
        throw (r as { __throw: unknown }).__throw
      }
      return r
    },
  }
  return { gate, issued }
}

const makeCtx = (gate: SignalGate, over: Partial<CommandContext> = {}) => {
  const status: string[][] = []
  let quitCalled = false
  const ctx: CommandContext = {
    view: createSessionView(),
    gate,
    sessionId: undefined,
    workDir: 'D:\\tmp-cli-ws',
    editor: new LineEditor(),
    router: new InputRouter(),
    quit: () => {
      quitCalled = true
    },
    renderStatus: (lines) => status.push(lines),
    ...over,
  }
  return { ctx, status, quitCalled: () => quitCalled }
}

const loopResult = (): IMLoopResult => ({
  terminated: false,
  reason: 'completed',
  finalState: 'Running',
  hits: [],
  turns: 3,
  metrics: { ...createMetrics(), totalTokens: 150, elapsedMs: 2000 },
})

const info = (id: string, workDir: string | undefined, lastActiveAt = 0): SessionInfo => ({
  id,
  title: `会话 ${id}`,
  workingAgentId: 'main',
  createdAt: 0,
  lastActiveAt,
  turnCount: 3,
  layer: 'M0',
  snapshotExpired: false,
  ...(workDir !== undefined ? { workDir } : {}),
})

const historyTurns: ConversationTurn[] = [
  { id: 't1', role: 'user', content: '帮我写文件', at: 1 },
  {
    id: 't2',
    role: 'assistant',
    content: '好的',
    toolCalls: [{ id: 'c1', type: 'function', function: { name: 'write', arguments: '{"path":"a.txt","content":"hi"}' } }],
    at: 2,
  },
  { id: 't3', role: 'tool', toolCallId: 'c1', content: '写入成功', sourceAgentId: 'main', at: 3, toolName: 'write' },
]

// ---------------------------------------------------------------------------
// resolveSlashInput
// ---------------------------------------------------------------------------

describe('resolveSlashInput', () => {
  it('无前导 / → message（原文）', () => {
    expect(resolveSlashInput('hello world', true)).toEqual({ kind: 'message', text: 'hello world' })
  })

  it('前导空白 trim 后再判定', () => {
    expect(resolveSlashInput('  hi  ', true)).toEqual({ kind: 'message', text: 'hi' })
  })

  it('命中注册表 → builtin，参数切分', () => {
    expect(resolveSlashInput('/status', true)).toEqual({ kind: 'builtin', name: 'status', args: '' })
    expect(resolveSlashInput('/resume abc', true)).toEqual({ kind: 'builtin', name: 'resume', args: 'abc' })
  })

  it('别名归一到主名', () => {
    expect(resolveSlashInput('/r x', true)).toEqual({ kind: 'builtin', name: 'resume', args: 'x' })
    expect(resolveSlashInput('/?', true)).toEqual({ kind: 'builtin', name: 'help', args: '' })
    expect(resolveSlashInput('/clear', true)).toEqual({ kind: 'builtin', name: 'new', args: '' })
  })

  it('idle-only 且非 idle → blocked（规范名）', () => {
    expect(resolveSlashInput('/new', false)).toEqual({ kind: 'blocked', name: 'new' })
    expect(resolveSlashInput('/export x', false)).toEqual({ kind: 'blocked', name: 'export' })
    expect(resolveSlashInput('/clear', false)).toEqual({ kind: 'blocked', name: 'new' })
  })

  it('idle-only 且 idle → 正常执行', () => {
    expect(resolveSlashInput('/export', true)).toEqual({ kind: 'builtin', name: 'export', args: '' })
  })

  it('always 命令在非 idle 时照常执行', () => {
    expect(resolveSlashInput('/cancel', false)).toEqual({ kind: 'builtin', name: 'cancel', args: '' })
  })

  it('未知 /xxx → 降级为 message（KimiCode 同款）', () => {
    expect(resolveSlashInput('/frobnicate now', true)).toEqual({ kind: 'message', text: '/frobnicate now' })
  })
})

// ---------------------------------------------------------------------------
// tabComplete
// ---------------------------------------------------------------------------

describe('tabComplete', () => {
  it('空前缀 → 全部规范名（排序，带 / 前缀）', () => {
    const all = tabComplete('/')
    expect(all).toEqual(CLI_SLASH_COMMANDS.map((c) => `/${c.name}`).sort())
  })

  it('非 / 行 → 空', () => {
    expect(tabComplete('')).toEqual([])
    expect(tabComplete('hello')).toEqual([])
  })

  it('名字前缀过滤', () => {
    expect(tabComplete('/he')).toEqual(['/help'])
    expect(tabComplete('/s')).toEqual(['/sessions', '/skills', '/status', '/subagent'])
    expect(tabComplete('/x')).toEqual([])
  })

  it('别名命中归一到规范名', () => {
    expect(tabComplete('/h')).toEqual(['/help'])
    expect(tabComplete('/q')).toEqual(['/quit'])
  })

  it('subagent 参数补全', () => {
    expect(tabComplete('/subagent o')).toEqual(['/subagent on', '/subagent off'])
    expect(tabComplete('/subagent st')).toEqual(['/subagent status'])
  })

  it('无 completeArgs 的带参行 → 空', () => {
    expect(tabComplete('/status ')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// buildHelpLines
// ---------------------------------------------------------------------------

describe('buildHelpLines', () => {
  const lines = buildHelpLines()

  it('覆盖全部注册表条目（名字 + 描述）', () => {
    expect(lines).toHaveLength(CLI_SLASH_COMMANDS.length)
    for (const c of CLI_SLASH_COMMANDS) {
      expect(lines.some((l) => l.includes(`/${c.name}`) && l.includes(c.description))).toBe(true)
    }
  })

  it('展示别名与参数提示', () => {
    const help = lines.find((l) => l.includes('/help'))!
    expect(help).toContain('(h, ?)')
    const approve = lines.find((l) => l.includes('/approve'))!
    expect(approve).toContain('<y|n>')
  })

  it('描述列对齐（所有行描述起始列相同）', () => {
    const descStarts = CLI_SLASH_COMMANDS.map((c, i) => lines[i]!.indexOf(c.description))
    expect(new Set(descStarts).size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// executeCommand — 本地命令
// ---------------------------------------------------------------------------

describe('executeCommand — local', () => {
  it('/help 输出注册表派生的面板', async () => {
    const { gate } = stubGate()
    const { ctx, status } = makeCtx(gate)
    await executeCommand('help', '', ctx)
    expect(status).toHaveLength(1)
    expect(status[0]!.join('\n')).toContain('/quit')
  })

  it('/workspace 输出工作区路径', async () => {
    const { gate } = stubGate()
    const { ctx, status } = makeCtx(gate, { workDir: 'D:\\ws\\demo' })
    await executeCommand('workspace', '', ctx)
    expect(status[0]).toEqual(['D:\\ws\\demo'])
  })

  it('/quit 触发 ctx.quit', async () => {
    const { gate } = stubGate()
    const { ctx, quitCalled } = makeCtx(gate)
    await executeCommand('quit', '', ctx)
    expect(quitCalled()).toBe(true)
  })

  it('/status 无会话 → 提示', async () => {
    const { gate } = stubGate()
    const { ctx, status } = makeCtx(gate)
    await executeCommand('status', '', ctx)
    expect(status[0]![0]).toContain('没有活跃会话')
  })

  it('/status / /usage 读取活跃分片统计', async () => {
    const { gate } = stubGate()
    const { ctx, status } = makeCtx(gate, { sessionId: 's1' })
    applySignal(ctx.view, { kind: 'turn.end', sessionId: 's1', result: loopResult() })
    await executeCommand('status', '', ctx)
    const joined = status[0]!.join('\n')
    expect(joined).toContain('s1')
    expect(joined).toContain('idle')
    expect(joined).toContain('tokens 150')
    await executeCommand('usage', '', ctx)
    expect(status[1]!.join('\n')).toContain('tokens（turn.end 累积）: 150')
    expect(status[1]!.join('\n')).toContain('LLM 往返 3')
  })
})

// ---------------------------------------------------------------------------
// executeCommand — 会话命令
// ---------------------------------------------------------------------------

describe('executeCommand — sessions', () => {
  it('/new 发 session.create（携带 workDir）并切活跃会话', async () => {
    // 回执形状 = 真实 SessionHandle（id 在 .info.id；Wave 5 修正此前误读 created.id）。
    const { gate, issued } = stubGate({ 'session.create': { info: { id: 's9' } } })
    const { ctx, status } = makeCtx(gate)
    await executeCommand('new', '', ctx)
    expect(issued).toEqual([{ kind: 'session.create', payload: { workDir: 'D:\\tmp-cli-ws' } }])
    expect(ctx.view.activeSessionId).toBe('s9')
    expect(status[0]!.join('')).toContain('s9')
  })

  it('/sessions 列出会话并标记当前工作区', async () => {
    const { gate } = stubGate({
      'session.list': [info('a1', 'D:\\tmp-cli-ws'), info('b2', 'D:\\other'), info('c3', undefined)],
    })
    const { ctx, status } = makeCtx(gate)
    await executeCommand('sessions', '', ctx)
    const joined = status[0]!.join('\n')
    expect(joined).toContain('a1')
    expect(joined).toContain('* a1')
    expect(joined).toContain('  b2')
    expect(joined).toContain('c3')
    expect(joined).toContain('（未指定工作区）')
  })

  it('/resume 无参恢复当前工作区最近的会话并 hydrate', async () => {
    const { gate, issued } = stubGate({
      'session.list': [info('old', 'D:\\tmp-cli-ws', 100), info('new', 'D:\\tmp-cli-ws', 200)],
      'session.history': historyTurns,
    })
    const { ctx, status } = makeCtx(gate)
    await executeCommand('resume', '', ctx)
    expect(issued.map((c) => c.kind)).toEqual(['session.list', 'session.open', 'session.history'])
    expect(issued.some((c) => c.kind === 'session.open' && c.sessionId === 'new')).toBe(true)
    expect(ctx.view.activeSessionId).toBe('new')
    const shard = ctx.view.shards.get('new')!
    expect(shard.hydrated).toBe(true)
    expect(shard.items.some((it) => it.kind === 'user' && it.text === '帮我写文件')).toBe(true)
    expect(shard.items.some((it) => it.kind === 'tool' && it.status === 'success')).toBe(true)
    expect(status[0]!.join('')).toContain('已恢复')
  })

  it('/resume 跨工作区 → 拒绝并提示 cd（✅G5）', async () => {
    const { gate, issued } = stubGate({
      'session.list': [info('far', 'D:\\elsewhere')],
    })
    const { ctx, status } = makeCtx(gate)
    await executeCommand('resume', 'far', ctx)
    expect(issued).toHaveLength(1) // 只 list，不 open
    expect(status[0]!.join('')).toContain('cd <dir>')
  })

  it('/resume 找不到会话 → 提示', async () => {
    const { gate } = stubGate({ 'session.list': [] })
    const { ctx, status } = makeCtx(gate)
    await executeCommand('resume', 'ghost', ctx)
    expect(status[0]!.join('')).toContain('找不到会话 ghost')
  })
})

// ---------------------------------------------------------------------------
// executeCommand — 审批 / 回合 / 权限
// ---------------------------------------------------------------------------

describe('executeCommand — approval / turn / permission', () => {
  const seedApproval = (ctx: CommandContext, requestId = 'rq-1') => {
    setActiveSession(ctx.view, 's1')
    applySignal(ctx.view, {
      kind: 'approval',
      requestId,
      payload: { toolName: 'write', args: { path: 'a.txt' }, reason: '工作区写审批' },
    })
  }

  it('/approve y → approval.decision approved + 队列移除', async () => {
    const { gate, issued } = stubGate()
    const { ctx, status } = makeCtx(gate, { sessionId: 's1' })
    seedApproval(ctx)
    await executeCommand('approve', 'y', ctx)
    expect(issued).toEqual([{ kind: 'approval.decision', requestId: 'rq-1', decision: 'approved' }])
    expect(ctx.view.shards.get('s1')!.pendingRequests).toHaveLength(0)
    expect(status[0]!.join('')).toContain('已批准')
  })

  it('/approve n（含 no/reject 变体）→ rejected', async () => {
    const { gate, issued } = stubGate()
    const { ctx } = makeCtx(gate, { sessionId: 's1' })
    seedApproval(ctx)
    await executeCommand('approve', 'REJECT', ctx)
    expect(issued[0]).toMatchObject({ decision: 'rejected' })
  })

  it('/approve 无挂起 → 状态行提示，零命令', async () => {
    const { gate, issued } = stubGate()
    const { ctx, status } = makeCtx(gate, { sessionId: 's1' })
    await executeCommand('approve', 'y', ctx)
    expect(issued).toHaveLength(0)
    expect(status[0]).toEqual(['没有待审批的请求'])
  })

  it('/approve 参数非法 → 用法提示', async () => {
    const { gate, issued } = stubGate()
    const { ctx, status } = makeCtx(gate, { sessionId: 's1' })
    seedApproval(ctx)
    await executeCommand('approve', 'maybe', ctx)
    expect(issued).toHaveLength(0)
    expect(status[0]!.join('')).toContain('用法')
  })

  it('/cancel 发 turn.cancel；无会话则提示', async () => {
    const { gate, issued } = stubGate()
    const { ctx, status } = makeCtx(gate, { sessionId: 's1' })
    await executeCommand('cancel', '', ctx)
    expect(issued).toEqual([{ kind: 'turn.cancel', sessionId: 's1' }])
    const { ctx: empty, status: st2 } = makeCtx(gate)
    await executeCommand('cancel', '', empty)
    expect(st2[0]![0]).toContain('没有活跃会话')
  })

  it('/permission 无参切换 + on/off 显式', async () => {
    const { gate, issued } = stubGate()
    const { ctx, status } = makeCtx(gate, { sessionId: 's1' })
    applySignal(ctx.view, { kind: 'turn.end', sessionId: 's1', result: loopResult() })
    await executeCommand('permission', '', ctx)
    expect(issued[0]).toEqual({ kind: 'permission.full', sessionId: 's1', enabled: true })
    await executeCommand('permission', 'off', ctx)
    expect(issued[1]).toEqual({ kind: 'permission.full', sessionId: 's1', enabled: false })
    expect(status[1]!.join('')).toContain('审批模式')
  })

  it('/chunk status 读 chunk.get；on/off 写 chunk.set', async () => {
    const { gate, issued } = stubGate({ 'chunk.get': { enabled: true, chunkTokens: 40_000 } })
    const { ctx, status } = makeCtx(gate, { sessionId: 's1' })
    applySignal(ctx.view, { kind: 'turn.end', sessionId: 's1', result: loopResult() })

    await executeCommand('chunk', '', ctx)
    expect(issued[0]).toEqual({ kind: 'chunk.get', sessionId: 's1' })
    expect(status[0]!.join('')).toContain('开启')

    await executeCommand('chunk', 'off', ctx)
    expect(issued[1]).toEqual({ kind: 'chunk.set', sessionId: 's1', enabled: false })
    expect(status[1]!.join('')).toContain('关闭')

    await executeCommand('chunk', 'on', ctx)
    expect(issued[2]).toEqual({ kind: 'chunk.set', sessionId: 's1', enabled: true })
    expect(status[2]!.join('')).toContain('切块已开启')
  })

  it('/chunk 无会话则提示', async () => {
    const { gate } = stubGate()
    const { ctx, status } = makeCtx(gate)
    await executeCommand('chunk', '', ctx)
    expect(status[0]![0]).toContain('没有活跃会话')
  })
})

// ---------------------------------------------------------------------------
// executeCommand — 扩展 / 设置
// ---------------------------------------------------------------------------

describe('executeCommand — extensions / settings', () => {
  it('/mcp 展示服务器清单', async () => {
    const { gate } = stubGate({
      'mcp.list': { exists: true, configPath: '~/.databus/mcp.json', servers: [
        { name: 'playwright', transport: 'stdio', command: 'npx' },
        { name: 'wiki', transport: 'http', url: 'http://localhost' },
      ] },
    })
    const { ctx, status } = makeCtx(gate)
    await executeCommand('mcp', '', ctx)
    const joined = status[0]!.join('\n')
    expect(joined).toContain('mcp.json')
    expect(joined).toContain('playwright（stdio）')
    expect(joined).toContain('wiki（http）')
  })

  it('/skills 展示扩展快照与目录', async () => {
    const { gate } = stubGate({
      'extensions.info': {
        skills: ['code-review'],
        textSkills: ['tdd'],
        servers: ['playwright'],
        skillsDir: '~/.databus/skills',
        textSkillsDir: '~/.databus/text-skills',
      },
    })
    const { ctx, status } = makeCtx(gate)
    await executeCommand('skills', '', ctx)
    const joined = status[0]!.join('\n')
    expect(joined).toContain('code-review')
    expect(joined).toContain('tdd')
    expect(joined).toContain('~/.databus/skills')
  })

  it('/subagent status 读 settings.get；on/off 写 settings.set + 新会话生效提示', async () => {
    const { gate, issued } = stubGate({ 'settings.get': { subAgentNesting: false } })
    const { ctx, status } = makeCtx(gate)
    await executeCommand('subagent', '', ctx)
    expect(issued).toEqual([{ kind: 'settings.get' }])
    expect(status[0]!.join('')).toContain('关闭')

    await executeCommand('subagent', 'on', ctx)
    expect(issued[1]).toEqual({ kind: 'settings.set', patch: { subAgentNesting: true } })
    expect(status[1]!.join('')).toContain('新会话生效，运行中会话不变')

    await executeCommand('subagent', 'off', ctx)
    expect(issued[2]).toEqual({ kind: 'settings.set', patch: { subAgentNesting: false } })

    await executeCommand('subagent', 'bogus', ctx)
    expect(status[3]!.join('')).toContain('用法')
  })
})

// ---------------------------------------------------------------------------
// executeCommand — export（真实落盘）
// ---------------------------------------------------------------------------

describe('executeCommand — export', () => {
  const dirs: string[] = []
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true })
  })

  const tempWorkDir = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), 'cli-export-'))
    dirs.push(d)
    return d
  }

  it('无参 → 默认落 workDir/exports/<短id>-<时间戳>.md', async () => {
    const workDir = await tempWorkDir()
    const { gate, issued } = stubGate({ 'session.history': historyTurns })
    const { ctx, status } = makeCtx(gate, { sessionId: 'abcdefgh-1234', workDir })
    await executeCommand('export', '', ctx)
    expect(issued).toEqual([{ kind: 'session.history', sessionId: 'abcdefgh-1234' }])
    const line = status[0]![0]!
    expect(line).toContain('已导出:')
    const path = line.replace('已导出: ', '').trim()
    expect(path).toContain(join('exports', 'abcdefgh-'))
    const md = await readFile(path, 'utf8')
    expect(md).toContain('# Session abcdefgh-1234')
    expect(md).toContain('## user')
    expect(md).toContain('帮我写文件')
    expect(md).toContain('### 工具调用 `write`')
    expect(md).toContain('写入成功')
  })

  it('显式路径：完全信任 resolve + 自动建目录（拍板③）', async () => {
    const workDir = await tempWorkDir()
    const target = join(workDir, 'deep', 'nested', 'out.md')
    const { gate } = stubGate({ 'session.history': [] })
    const { ctx, status } = makeCtx(gate, { sessionId: 's1', workDir })
    await executeCommand('export', target, ctx)
    const md = await readFile(target, 'utf8')
    expect(md).toContain('# Session s1')
    expect(status[0]![0]).toContain(target)
  })

  it('无活跃会话 → 提示，零命令', async () => {
    const { gate, issued } = stubGate()
    const { ctx, status } = makeCtx(gate)
    await executeCommand('export', '', ctx)
    expect(issued).toHaveLength(0)
    expect(status[0]![0]).toContain('没有活跃会话')
  })
})

// ---------------------------------------------------------------------------
// 错误路径
// ---------------------------------------------------------------------------

describe('executeCommand — error path', () => {
  it('gate.command 拒绝 → 状态行 + 绝不抛出', async () => {
    const { gate, issued } = stubGate({
      'mcp.list': new Error('the host does not provide an mcp handler'),
    })
    const { ctx, status } = makeCtx(gate)
    await expect(executeCommand('mcp', '', ctx)).resolves.toBeUndefined()
    expect(issued).toHaveLength(1)
    expect(status[0]).toEqual(['/mcp 失败: the host does not provide an mcp handler'])
  })

  it('非 Error 抛出物同样收敛', async () => {
    const { gate } = stubGate({ 'settings.get': { __throw: 'boom-string' } })
    const { ctx, status } = makeCtx(gate)
    await expect(executeCommand('subagent', '', ctx)).resolves.toBeUndefined()
    expect(status[0]![0]).toBe('/subagent 失败: boom-string')
  })

  it('穷尽性哨兵：注册表 25 条、名字唯一（switch 的 never 检查在编译期保证每个名字有分支）', () => {
    const names: readonly string[] = CLI_SLASH_COMMANDS.map((c) => c.name)
    // v0.42 新增 /chunk（第 25 条；v0.42 LongHorizon 加了 /workflow 第 26 条）。这个数字是刻意的
    // 哨兵：加命令必须显式改它，于是"注册了但 handlers 里没有分支"会在编译期
    // （never 守卫）与这里同时暴露。
    expect(names).toHaveLength(26)
    expect(new Set(names).size).toBe(26)
    expect(names).toContain('goal')
    expect(names).toContain('chunk')
  })

  it('v0.41 /goal 是 idle-only（停止条件应在回合开始前设定，streaming 时拒绝并还原输入）', () => {
    const goal = CLI_SLASH_COMMANDS.find((c) => c.name === 'goal')
    expect(goal).toBeDefined()
    expect(goal!.availability).toBe('idle-only')
    expect(goal!.argumentHint).toBe('<目标条件> | off | status')
    // 自由文本的目标条件不补全，只补两个子命令
    expect(goal!.completeArgs?.('')).toEqual(['off', 'status'])
    expect(goal!.completeArgs?.('o')).toEqual(['off'])
  })

  it('/workflow 是 idle-only 并提供状态、开关、基线补全', () => {
    const workflow = CLI_SLASH_COMMANDS.find((c) => c.name === 'workflow')
    expect(workflow).toBeDefined()
    expect(workflow!.availability).toBe('idle-only')
    expect(workflow!.completeArgs?.('')).toEqual(['on', 'off', 'status', 'baseline'])
    expect(resolveSlashInput('/workflow baseline', true)).toEqual({ kind: 'builtin', name: 'workflow', args: 'baseline' })
  })
})

// ---------------------------------------------------------------------------
// executeCommand — fork / undo（v0.29 Wave B2）
// ---------------------------------------------------------------------------

describe('executeCommand — fork / undo (Wave B2)', () => {
  it('/fork 发 session.fork，状态行报告新会话 id（不切换活跃会话）', async () => {
    const { gate, issued } = stubGate({
      'session.fork': info('fork-1', 'D:\\tmp-cli-ws'),
    })
    const { ctx, status } = makeCtx(gate, { sessionId: 's1' })
    await executeCommand('fork', '', ctx)
    expect(issued).toEqual([{ kind: 'session.fork', sessionId: 's1' }])
    expect(status[0]![0]).toBe('/fork → 新会话 fork-1（/resume 可切）')
    expect(ctx.view.activeSessionId).toBeUndefined() // fork 不切换
  })

  it('/fork 无会话 → 提示；gate 拒绝 → 收敛为状态行', async () => {
    const { gate, issued } = stubGate()
    const { ctx, status } = makeCtx(gate)
    await executeCommand('fork', '', ctx)
    expect(issued).toHaveLength(0)
    expect(status[0]![0]).toContain('没有活跃会话')

    const { gate: g2 } = stubGate({
      'session.fork': new Error('Session not found: s1'),
    })
    const { ctx: c2, status: st2 } = makeCtx(g2, { sessionId: 's1' })
    await expect(executeCommand('fork', '', c2)).resolves.toBeUndefined()
    expect(st2[0]![0]).toBe('/fork 失败: Session not found: s1')
  })

  it('/undo 缺省 N=1；回执 + history 重投影进视图（stats 保留）', async () => {
    const { gate, issued } = stubGate({
      'session.undo': { blocks: 1, evicted: 3 },
      'session.history': historyTurns,
    })
    const { ctx, status } = makeCtx(gate, { sessionId: 's1' })
    applySignal(ctx.view, { kind: 'turn.end', sessionId: 's1', result: loopResult() })
    await executeCommand('undo', '', ctx)
    expect(issued.map((c) => c.kind)).toEqual(['session.undo', 'session.history'])
    expect(issued[0]).toEqual({ kind: 'session.undo', sessionId: 's1', blocks: 1 })
    expect(status[0]![0]).toBe('/undo → 已撤回最近 1 个任务块（驱逐 3 条）')
    const shard = ctx.view.shards.get('s1')!
    expect(shard.hydrated).toBe(true)
    expect(shard.items.some((it) => it.kind === 'user' && it.text === '帮我写文件')).toBe(true)
    expect(shard.stats.totalTokens).toBe(150) // 撤回不改写回合累计用量
  })

  it('/undo 2 → blocks=2 透传', async () => {
    const { gate, issued } = stubGate({
      'session.undo': { blocks: 2, evicted: 6 },
      'session.history': [],
    })
    const { ctx, status } = makeCtx(gate, { sessionId: 's1' })
    await executeCommand('undo', '2', ctx)
    expect(issued[0]).toEqual({ kind: 'session.undo', sessionId: 's1', blocks: 2 })
    expect(status[0]![0]).toBe('/undo → 已撤回最近 2 个任务块（驱逐 6 条）')
  })

  it('/undo 非法 N（0 / 11 / abc）→ 用法行，零命令', async () => {
    for (const bad of ['0', '11', 'abc']) {
      const { gate, issued } = stubGate()
      const { ctx, status } = makeCtx(gate, { sessionId: 's1' })
      await executeCommand('undo', bad, ctx)
      expect(issued).toHaveLength(0)
      expect(status[0]![0]).toContain('用法: /undo [N]')
    }
  })

  it('/undo 宿主拒绝（含已压缩范围）→ 收敛为状态行', async () => {
    const { gate } = stubGate({
      'session.undo': new Error('cannot undo 1 block(s) of session "s1": 1 archived raw record(s) overlap the range'),
    })
    const { ctx, status } = makeCtx(gate, { sessionId: 's1' })
    await expect(executeCommand('undo', '', ctx)).resolves.toBeUndefined()
    expect(status[0]![0]).toContain('/undo 失败: cannot undo')
  })
})

// ---------------------------------------------------------------------------
// executeCommand — title / copy / version（Wave A）
// ---------------------------------------------------------------------------

describe('executeCommand — title / copy / version (Wave A)', () => {
  it('/title 无参 → 显示当前标题（session.list 为事实源）', async () => {
    const { gate, issued } = stubGate({ 'session.list': [info('s1', 'D:\\tmp-cli-ws')] })
    const { ctx, status } = makeCtx(gate, { sessionId: 's1' })
    await executeCommand('title', '', ctx)
    expect(issued.map((c) => c.kind)).toEqual(['session.list'])
    expect(status[0]!.join('')).toContain('当前会话标题: 会话 s1')
    expect(status[0]!.join('')).toContain('/title <新标题>')
  })

  it('/title <新标题> → session.rename（args trim 后透传）', async () => {
    const { gate, issued } = stubGate()
    const { ctx, status } = makeCtx(gate, { sessionId: 's1' })
    await executeCommand('title', '  新名字  ', ctx)
    expect(issued).toEqual([{ kind: 'session.rename', sessionId: 's1', title: '新名字' }])
    expect(status[0]!.join('')).toContain('已改名: 新名字')
  })

  it('/title 超限 → 宿主拒绝，收敛为状态行绝不抛出', async () => {
    const { gate } = stubGate({
      'session.rename': new Error('session title must be at most 200 characters'),
    })
    const { ctx, status } = makeCtx(gate, { sessionId: 's1' })
    await expect(executeCommand('title', 'x'.repeat(201), ctx)).resolves.toBeUndefined()
    expect(status[0]![0]).toBe('/title 失败: session title must be at most 200 characters')
  })

  it('/title 无会话 → 提示', async () => {
    const { gate, issued } = stubGate()
    const { ctx, status } = makeCtx(gate)
    await executeCommand('title', '', ctx)
    expect(issued).toHaveLength(0)
    expect(status[0]![0]).toContain('没有活跃会话')
  })

  it('/copy 复制最后一条 assistant 正文（注入 stub，不碰真剪贴板）', async () => {
    const { gate, issued } = stubGate({ 'session.history': historyTurns })
    const copied: string[] = []
    const { ctx, status } = makeCtx(gate, {
      sessionId: 's1',
      copyToClipboard: async (t) => {
        copied.push(t)
      },
    })
    await executeCommand('copy', '', ctx)
    expect(issued.map((c) => c.kind)).toEqual(['session.history'])
    expect(copied).toEqual(['好的'])
    expect(status[0]!.join('')).toContain('已复制最后回复（2 字符）')
  })

  it('/copy 无 assistant 正文 → 提示；无会话 → 提示 + 零命令', async () => {
    const { gate } = stubGate({
      'session.history': [
        { id: 't3', role: 'tool', toolCallId: 'c1', content: '写入成功', sourceAgentId: 'main', at: 3, toolName: 'write' },
      ],
    })
    const { ctx, status } = makeCtx(gate, { sessionId: 's1' })
    await executeCommand('copy', '', ctx)
    expect(status[0]![0]).toContain('没有可复制的回复')

    const { gate: g2, issued } = stubGate()
    const { ctx: empty, status: st2 } = makeCtx(g2)
    await executeCommand('copy', '', empty)
    expect(issued).toHaveLength(0)
    expect(st2[0]![0]).toContain('没有活跃会话')
  })

  it('/version 输出版本行（版本号格式 + Node 版本）', async () => {
    const { gate } = stubGate()
    const { ctx, status } = makeCtx(gate)
    await executeCommand('version', '', ctx)
    expect(status[0]).toEqual(buildVersionLines(cliVersion(), process.version))
    expect(status[0]![0]).toMatch(/^agent-shell v\d+\.\d+\.\d+/)
  })
})

// ---------------------------------------------------------------------------
// executeCommand — /provider /model（Wave B1）
// ---------------------------------------------------------------------------

describe('executeCommand — provider / model (Wave B1)', () => {
  const providerListResult = {
    exists: true,
    configPath: '~/.agent-shell/providers.json',
    active: 'ark',
    providers: {
      ark: { url: 'https://ark.example.com/api/v3/chat/completions', apiKey: 'abcd1234efgh5678', model: 'glm-5.3-flash' },
      relay: { url: 'https://relay.example.com/v1/chat/completions', model: 'deepseek-v3', upstreamTrusted: false },
    },
  }

  it('parseKeyValueArgs：任意顺序 + 值含 = 取第一个 = 之后全部 + 无 = 忽略', () => {
    expect(parseKeyValueArgs(['model=m', 'name=a=b', 'baseUrl=https://x', 'badtoken'])).toEqual({
      model: 'm',
      name: 'a=b',
      baseUrl: 'https://x',
    })
  })

  it('maskKey：长 key 首尾各 4 位，短 key 全掩码', () => {
    expect(maskKey('abcd1234efgh5678')).toBe('abcd…5678')
    expect(maskKey('short')).toBe('****')
    expect(maskKey('12345678')).toBe('****')
  })

  it('/provider 无参 → provider.list + active 标记 + key 掩码 + host', async () => {
    const { gate, issued } = stubGate({ 'provider.list': providerListResult })
    const { ctx, status } = makeCtx(gate)
    await executeCommand('provider', '', ctx)
    expect(issued).toEqual([{ kind: 'provider.list' }])
    const joined = status[0]!.join('\n')
    expect(joined).toContain('* ark')
    expect(joined).toContain('ark.example.com')
    expect(joined).toContain('glm-5.3-flash')
    expect(joined).toContain('abcd…5678')
    expect(joined).toContain('上游不可信')
    expect(joined).not.toContain('abcd1234efgh5678') // 明文不回显
    expect(joined).toContain('下一轮对话即使用新服务商')
  })

  it('/provider use <名> → provider.activate + 全局生效提示；缺参 → 用法', async () => {
    const { gate, issued } = stubGate()
    const { ctx, status } = makeCtx(gate)
    await executeCommand('provider', 'use relay', ctx)
    expect(issued).toEqual([{ kind: 'provider.activate', name: 'relay' }])
    expect(status[0]!.join('')).toContain('已切换服务商: relay')
    expect(status[0]!.join('')).toContain('下一轮对话')

    const { gate: g2, issued: i2 } = stubGate()
    const { ctx: c2, status: s2 } = makeCtx(g2)
    await executeCommand('provider', 'use', c2)
    expect(i2).toHaveLength(0)
    expect(s2[0]![0]).toContain('用法')
  })

  it('/provider add → provider.upsert（key=value 乱序；key 缺省合法）', async () => {
    const { gate, issued } = stubGate()
    const { ctx, status } = makeCtx(gate)
    await executeCommand(
      'provider',
      'add model=glm-5.3-flash name=ark baseUrl=https://ark.example.com/api key=k-xyz',
      ctx,
    )
    expect(issued).toEqual([
      {
        kind: 'provider.upsert',
        name: 'ark',
        provider: { url: 'https://ark.example.com/api', model: 'glm-5.3-flash', apiKey: 'k-xyz' },
      },
    ])
    expect(status[0]!.join('')).toContain('已保存服务商 ark')

    const { gate: g2, issued: i2 } = stubGate()
    const { ctx: c2, status: s2 } = makeCtx(g2)
    await executeCommand('provider', 'add name=nokey baseUrl=https://x/v1 model=m1', c2)
    expect(i2[0]).toEqual({
      kind: 'provider.upsert',
      name: 'nokey',
      provider: { url: 'https://x/v1', model: 'm1' },
    })

    const { gate: g3, issued: i3 } = stubGate()
    const { ctx: c3, status: s3 } = makeCtx(g3)
    await executeCommand('provider', 'add name=only', c3)
    expect(i3).toHaveLength(0)
    expect(s3[0]![0]).toContain('用法')
  })

  it('/provider remove → provider.delete；宿主拒绝删 active 收敛为状态行', async () => {
    const { gate, issued } = stubGate()
    const { ctx, status } = makeCtx(gate)
    await executeCommand('provider', 'remove relay', ctx)
    expect(issued).toEqual([{ kind: 'provider.delete', name: 'relay' }])
    expect(status[0]!.join('')).toContain('已删除服务商 relay')

    const { gate: g2, issued: i2 } = stubGate({
      'provider.delete': new Error('provider "ark" is active — activate another provider before deleting it'),
    })
    const { ctx: c2, status: s2 } = makeCtx(g2)
    await expect(executeCommand('provider', 'remove ark', c2)).resolves.toBeUndefined()
    expect(i2).toHaveLength(1)
    expect(s2[0]![0]).toContain('is active')
  })

  it('/provider 未知子命令 → 用法；gate 缺 provider handler 收敛为状态行', async () => {
    const { gate, issued } = stubGate()
    const { ctx, status } = makeCtx(gate)
    await executeCommand('provider', 'frobnicate', ctx)
    expect(issued).toHaveLength(0)
    expect(status[0]![0]).toContain('用法')

    const { gate: g2 } = stubGate({ 'provider.list': new Error('the host does not provide a provider handler') })
    const { ctx: c2, status: s2 } = makeCtx(g2)
    await expect(executeCommand('provider', '', c2)).resolves.toBeUndefined()
    expect(s2[0]![0]).toBe('/provider 失败: the host does not provide a provider handler')
  })

  it('/model 无参 → active provider 的 model + 来源', async () => {
    const { gate, issued } = stubGate({ 'provider.list': providerListResult })
    const { ctx, status } = makeCtx(gate)
    await executeCommand('model', '', ctx)
    expect(issued).toEqual([{ kind: 'provider.list' }])
    expect(status[0]!.join('\n')).toContain('当前模型: glm-5.3-flash（providers.json: ark）')
  })

  it('/model 无 active → env 回落来源展示', async () => {
    const { gate } = stubGate({
      'provider.list': { exists: false, configPath: 'p', active: undefined, providers: {} },
    })
    const { ctx, status } = makeCtx(gate)
    await executeCommand('model', '', ctx)
    expect(status[0]!.join('\n')).toContain('环境变量/默认')
  })

  it('/model <模型 id> = provider.select（v0.32 多模型目录；切模型清档位）', async () => {
    const { gate, issued } = stubGate({
      'provider.list': {
        exists: true, configPath: 'x', active: 'ark',
        providers: { ark: { url: 'https://a', model: 'deepseek-v4-flash' } },
        catalog: [{ name: 'ark', active: true, selectedModel: 'deepseek-v4-flash', reasoningEffort: 'low',
          models: [{ id: 'deepseek-v4-flash' }, { id: 'glm-5.3-flash' }] }],
      },
    })
    const { ctx, status } = makeCtx(gate)
    await executeCommand('model', 'glm-5.3-flash', ctx)
    expect(issued).toEqual([{ kind: 'provider.list' }, { kind: 'provider.select', model: 'glm-5.3-flash' }])
    expect(status[0]!.join('')).toContain('已切换模型: glm-5.3-flash')
  })
})

// ---------------------------------------------------------------------------
// 纯函数 — extractLastAssistantText / buildVersionLines
// ---------------------------------------------------------------------------

describe('extractLastAssistantText / buildVersionLines (Wave A)', () => {
  it('取最后一条非空 assistant 正文（tool 回合在其后不影响）', () => {
    expect(extractLastAssistantText(historyTurns)).toBe('好的')
  })

  it('最后一条 assistant 正文为空白时回退到更早的非空正文', () => {
    expect(
      extractLastAssistantText([
        { id: 'a', role: 'assistant', content: '第一版', at: 1 },
        { id: 'b', role: 'assistant', content: '   ', at: 2 },
      ]),
    ).toBe('第一版')
  })

  it('没有可复制的正文 → null', () => {
    expect(extractLastAssistantText([])).toBeNull()
    expect(extractLastAssistantText(historyTurns.filter((t) => t.role === 'tool'))).toBeNull()
  })

  it('版本行格式', () => {
    expect(buildVersionLines('0.1.0', 'v20.0.0')).toEqual(['agent-shell v0.1.0', 'Node.js v20.0.0'])
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

// ---------------------------------------------------------------------------
// executeCommand — /goal（v0.41 goal 模式）
// ---------------------------------------------------------------------------

describe('executeCommand — /goal (v0.41)', () => {
  const activeCtx = (replies: Partial<Record<GateCommand['kind'], unknown>> = {}) => {
    const { gate, issued } = stubGate(replies)
    const { ctx, status } = makeCtx(gate, { sessionId: 's1' })
    // 建立活跃分片（与 /permission 测试同款写法）
    applySignal(ctx.view, { kind: 'turn.end', sessionId: 's1', result: loopResult() })
    return { ctx, status, issued }
  }

  const goalState = (over: Partial<GoalState> = {}): GoalState => ({
    condition: '写出 a.txt 与 b.txt', maxRounds: 7, roundsUsed: 2, ...over,
  })

  it('/goal <条件> 发 goal.set，然后**回读** goal.get 显示真实上限', async () => {
    const { ctx, status, issued } = activeCtx({ 'goal.get': goalState({ maxRounds: 7 }) })

    await executeCommand('goal', '写出 a.txt 与 b.txt', ctx)

    expect(issued[0]).toEqual({ kind: 'goal.set', sessionId: 's1', condition: '写出 a.txt 与 b.txt' })
    expect(issued[1]).toEqual({ kind: 'goal.get', sessionId: 's1' })
    // 上限来自回读的 7，不是 DEFAULT_GOAL_MAX_ROUNDS 的 24——证明 CLI 没有
    // 复制第二份阈值常量（事实源只在 src/im/goal/types.ts）。
    const lines = status[0]!
    expect(lines[0]).toContain('上限 7 轮')
    expect(lines[0]).not.toContain('24')
    expect(lines[1]).toBe('目标: 写出 a.txt 与 b.txt')
  })

  it('目标条件原样保留（前后空格 trim，但内部大小写与空格不动——它逐字进提醒的 #OBJECTIVE）', async () => {
    const { ctx, issued } = activeCtx({ 'goal.get': goalState() })
    await executeCommand('goal', '  Fix Issue #42 in Repo X  ', ctx)
    expect(issued[0]).toEqual({ kind: 'goal.set', sessionId: 's1', condition: 'Fix Issue #42 in Repo X' })
  })

  it('/goal off 发 goal.clear', async () => {
    const { ctx, status, issued } = activeCtx()
    await executeCommand('goal', 'off', ctx)
    expect(issued).toEqual([{ kind: 'goal.clear', sessionId: 's1' }])
    expect(status[0]![0]).toContain('goal 模式已关闭')
  })

  it('/goal OFF 大写同样是关闭（子命令大小写不敏感，但目标条件不是）', async () => {
    const { ctx, issued } = activeCtx()
    await executeCommand('goal', 'OFF', ctx)
    expect(issued).toEqual([{ kind: 'goal.clear', sessionId: 's1' }])
  })

  it('/goal status 有目标时显示轮次进度、条件与最近裁决', async () => {
    const { ctx, status } = activeCtx({
      'goal.get': goalState({ lastVerdict: { verdict: 'not_met', reason: 'b.txt 无写入证据' } }),
    })
    await executeCommand('goal', 'status', ctx)
    const lines = status[0]!
    expect(lines[0]).toContain('第 2/7 轮')
    expect(lines[0]).toContain('分歧循环数')
    expect(lines[1]).toBe('目标: 写出 a.txt 与 b.txt')
    expect(lines[2]).toContain('not_met')
    expect(lines[2]).toContain('b.txt 无写入证据')
  })

  it('/goal status 无目标时给用法提示，不报错', async () => {
    const { ctx, status, issued } = activeCtx({ 'goal.get': undefined })
    await executeCommand('goal', 'status', ctx)
    expect(issued).toEqual([{ kind: 'goal.get', sessionId: 's1' }])
    expect(status[0]![0]).toBe('goal 模式：未设置目标')
    expect(status[0]![1]).toContain('/goal <目标条件> | off | status')
  })

  it('/goal 空参等价于 status（不发 goal.set 把条件设成空串）', async () => {
    const { ctx, issued } = activeCtx({ 'goal.get': undefined })
    await executeCommand('goal', '   ', ctx)
    expect(issued).toEqual([{ kind: 'goal.get', sessionId: 's1' }])
  })

  it('/goal STATUS 大写等价于 status', async () => {
    const { ctx, issued } = activeCtx({ 'goal.get': undefined })
    await executeCommand('goal', 'STATUS', ctx)
    expect(issued).toEqual([{ kind: 'goal.get', sessionId: 's1' }])
  })

  it('无活跃会话时不发任何命令', async () => {
    const { gate, issued } = stubGate()
    const { ctx, status } = makeCtx(gate)
    await executeCommand('goal', '写文件', ctx)
    expect(issued).toEqual([])
    expect(status[0]![0]).toBe('没有活跃会话')
  })

  it('goal.set 抛错时被 executeCommand 收敛成状态行（不穿透到 TUI）', async () => {
    const { ctx, status } = activeCtx({ 'goal.set': { __throw: 'session "s1" is not open' } })
    await expect(executeCommand('goal', '写文件', ctx)).resolves.toBeUndefined()
    expect(status[0]![0]).toBe('/goal 失败: session "s1" is not open')
  })
})

describe('executeCommand — /workflow', () => {
  const state = (over: Partial<WorkflowState> = {}): WorkflowState => ({
    version: 1,
    sessionId: 's1',
    enabled: true,
    phase: 'ready',
    skillActive: true,
    baseline: { status: 'completed', completedRoles: ['structure', 'verification', 'risk'] },
    evidenceCount: 4,
    updatedAt: 1,
    ...over,
  })

  it('status and on/off only use workflow Gate commands', async () => {
    const { gate, issued } = stubGate({ 'workflow.status': state(), 'workflow.enable': state(), 'workflow.disable': state({ enabled: false, skillActive: false, phase: 'idle' }) })
    const { ctx, status } = makeCtx(gate, { sessionId: 's1' })
    applySignal(ctx.view, { kind: 'turn.end', sessionId: 's1', result: loopResult() })

    await executeCommand('workflow', 'status', ctx)
    await executeCommand('workflow', 'on', ctx)
    await executeCommand('workflow', 'off', ctx)

    expect(issued).toEqual([
      { kind: 'workflow.status', sessionId: 's1' },
      { kind: 'workflow.enable', sessionId: 's1' },
      { kind: 'workflow.disable', sessionId: 's1' },
    ])
    expect(status[0]![0]).toContain('长程工作流')
  })

  it('baseline reports completed and failed roles', async () => {
    const result = { runId: 'run-1', records: {}, completedRoles: ['structure'] as const, failedRoles: ['risk'] as const }
    const { gate, issued } = stubGate({ 'workflow.baseline': result })
    const { ctx, status } = makeCtx(gate, { sessionId: 's1' })
    applySignal(ctx.view, { kind: 'turn.end', sessionId: 's1', result: loopResult() })
    await executeCommand('workflow', 'baseline', ctx)
    expect(issued).toEqual([{ kind: 'workflow.baseline', sessionId: 's1' }])
    expect(status[0]).toEqual(['基线 scout 已完成：1/2', '失败角色: risk'])
  })
})
