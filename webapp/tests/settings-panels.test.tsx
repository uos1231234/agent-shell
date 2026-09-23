// @vitest-environment happy-dom
//
// 设置面板（MCP / Skill / 子代理）测试。
//
// 基建：v0.25.1 起引入 happy-dom + @testing-library/react（用户拍板升级），
// 关键交互有真 DOM 测试（本文件后半交互 describe）；纯函数层（runPanelCommand
// + payload 构造器）继续保留——它们覆盖的是载荷正确性这一最易静默出 bug 的层。
//   1. runPanelCommand：成功（hint + result + refresh）/ ok:false（error 原文、
//      不刷新）/ throw（Error 与非 Error）。
//   2. 三个面板的 payload 纯函数：mcp server（stdio/http/edit 保留 env/headers）、
//      settings patch（空 = 显式 undefined 删键）、subagent（edit 保留 config）。
//   3. 九个新 GateCommand kind 的契约接线。
//   4. 关键交互（happy-dom）：载入渲染、删除、表单提交载荷、开关翻转、
//      后端错误原文渲染、本地必填校验。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../src/api/token', () => ({ command: vi.fn() }))

import { command } from '../src/api/token'
import type { GateCommand, McpServerConfig, SubAgentConfig } from '../src/api/contract'
import { runPanelCommand, parseListInput } from '../src/components/settings/panel-shared'
import McpPanel, {
  buildMcpServerPayload,
  serverSummary,
  emptyMcpForm,
  type McpFormState,
} from '../src/components/settings/McpPanel'
import SkillPanel, { buildSettingsPatch, dirPlaceholder } from '../src/components/settings/SkillPanel'
import SubAgentPanel, {
  buildSubAgentPayload,
  emptySubAgentForm,
  type SubAgentFormState,
} from '../src/components/settings/SubAgentPanel'

const commandMock = vi.mocked(command)
beforeEach(() => {
  commandMock.mockReset()
})

describe('runPanelCommand（成功操作 → 参数正确 + hint；失败 → error 原文）', () => {
  it('ok:true → 返回 hint + result 并调用 refresh', async () => {
    commandMock.mockResolvedValue({ ok: true, result: { skillsDir: 'D:/skills' } })
    const refresh = vi.fn(async () => {})
    const r = await runPanelCommand({ kind: 'settings.get' }, '已保存', refresh)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.hint).toBe('已保存')
      expect(r.result).toEqual({ skillsDir: 'D:/skills' })
    }
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(commandMock).toHaveBeenCalledWith({ kind: 'settings.get' })
  })

  it('refresh 可省略（settings.set 不需要刷列表）', async () => {
    commandMock.mockResolvedValue({ ok: true, result: {} })
    const r = await runPanelCommand({ kind: 'settings.get' }, 'ok')
    expect(r.ok).toBe(true)
    expect(commandMock).toHaveBeenCalledTimes(1)
  })

  it('ok:false → error 为后端原文，且不调用 refresh', async () => {
    commandMock.mockResolvedValue({ ok: false, error: 'Unknown toolRefs in sub-agent config: readx' })
    const refresh = vi.fn(async () => {})
    const r = await runPanelCommand({ kind: 'subagent.upsert', agent: { name: 'a', systemPrompt: 'p', toolRefs: ['readx'] } }, '已新增', refresh)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('Unknown toolRefs in sub-agent config: readx')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('command throw（Error / 非 Error）→ error 原文，不静默', async () => {
    commandMock.mockRejectedValue(new Error('network down'))
    const r1 = await runPanelCommand({ kind: 'mcp.list' }, 'x')
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error).toBe('network down')

    commandMock.mockRejectedValue('boom')
    const r2 = await runPanelCommand({ kind: 'mcp.list' }, 'x')
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error).toBe('boom')
  })
})

describe('McpPanel payload', () => {
  const stdioForm: McpFormState = {
    transport: 'stdio',
    name: '  fs  ',
    command: ' npx ',
    args: '-y, @x/fs , server',
    url: '',
    timeoutMs: '5000',
    description: ' file tools ',
  }

  it('stdio 全字段：trim + args 解析 + timeout/description', () => {
    expect(buildMcpServerPayload(stdioForm)).toStrictEqual({
      name: 'fs',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@x/fs', 'server'],
      timeoutMs: 5000,
      description: 'file tools',
    })
  })

  it('可选字段为空 → 键省略（不是 undefined 值）', () => {
    const p = buildMcpServerPayload({ ...emptyMcpForm, name: 'fs', command: 'npx', timeoutMs: 'abc' })
    expect(p).toStrictEqual({ name: 'fs', transport: 'stdio', command: 'npx' })
  })

  it('http 分支：url + 可选字段', () => {
    const p = buildMcpServerPayload({ ...emptyMcpForm, transport: 'http', name: 'remote', url: ' https://mcp.example.com ' })
    expect(p).toStrictEqual({ name: 'remote', transport: 'http', url: 'https://mcp.example.com' })
  })

  it('编辑保留 env/headers（表单不编辑该字段）；transport 换向则丢弃', () => {
    const stdioExisting: McpServerConfig = { name: 'fs', transport: 'stdio', command: 'npx', env: { KEY: 'v' } }
    const kept = buildMcpServerPayload({ ...stdioForm, name: 'fs' }, stdioExisting)
    expect(kept).toMatchObject({ env: { KEY: 'v' } })

    const switched = buildMcpServerPayload({ ...emptyMcpForm, transport: 'http', name: 'fs', url: 'https://x' }, stdioExisting)
    expect(switched).toStrictEqual({ name: 'fs', transport: 'http', url: 'https://x' })

    const httpExisting: McpServerConfig = { name: 'r', transport: 'http', url: 'https://old', headers: { A: 'b' } }
    const keptHeaders = buildMcpServerPayload({ ...emptyMcpForm, transport: 'http', name: 'r', url: 'https://new' }, httpExisting)
    expect(keptHeaders).toMatchObject({ url: 'https://new', headers: { A: 'b' } })
  })

  it('serverSummary：stdio = command+args，http = url', () => {
    expect(serverSummary({ name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'fs'] })).toBe('npx -y fs')
    expect(serverSummary({ name: 'r', transport: 'http', url: 'https://x' })).toBe('https://x')
  })
})

describe('SkillPanel settings patch', () => {
  it('两个目录都 patch 且 trim', () => {
    expect(buildSettingsPatch({ skillsDir: ' D:/a ', textSkillsDir: 'D:/b' })).toStrictEqual({
      skillsDir: 'D:/a',
      textSkillsDir: 'D:/b',
    })
  })

  it('空输入 = 显式 undefined（后端 writeDatabusSettings 语义：删键）', () => {
    expect(buildSettingsPatch({ skillsDir: '', textSkillsDir: '  ' })).toStrictEqual({
      skillsDir: undefined,
      textSkillsDir: undefined,
    })
  })

  it('dirPlaceholder：未配置 → 任务规定文案；已配置 → 路径', () => {
    expect(dirPlaceholder(undefined)).toBe('未配置 skills 目录')
    expect(dirPlaceholder('', '文本 skill')).toBe('未配置 文本 skill 目录')
    expect(dirPlaceholder('D:/skills')).toBe('D:/skills')
  })
})

describe('SubAgentPanel payload', () => {
  const form: SubAgentFormState = { name: ' scout ', systemPrompt: ' You scout. ', toolRefs: 'read, grep , ' }

  it('新增：trim + toolRefs 解析，无 config 键', () => {
    expect(buildSubAgentPayload(form)).toStrictEqual({
      name: 'scout',
      systemPrompt: 'You scout.',
      toolRefs: ['read', 'grep'],
    })
  })

  it('编辑保留 existing.config（守卫阈值不被表单静默清掉）', () => {
    const existing: SubAgentConfig = { name: 'scout', systemPrompt: 'old', toolRefs: ['read'], config: { maxSubAgentDepth: 2 } }
    expect(buildSubAgentPayload(form, existing)).toMatchObject({ config: { maxSubAgentDepth: 2 } })

    const noConfig: SubAgentConfig = { name: 'scout', systemPrompt: 'old', toolRefs: ['read'] }
    expect(buildSubAgentPayload(form, noConfig)).toStrictEqual({
      name: 'scout',
      systemPrompt: 'You scout.',
      toolRefs: ['read', 'grep'],
    })
  })
})

describe('九个新 GateCommand kind 契约接线（builders 输出直接喂命令）', () => {
  it('mcp.* 三命令可路由', () => {
    const list: GateCommand = { kind: 'mcp.list' }
    const upsert: GateCommand = { kind: 'mcp.upsert', server: buildMcpServerPayload({ ...emptyMcpForm, name: 'fs', command: 'npx' }) }
    const del: GateCommand = { kind: 'mcp.delete', name: 'fs' }
    expect([list, upsert, del].map((c) => c.kind)).toEqual(['mcp.list', 'mcp.upsert', 'mcp.delete'])
  })

  it('subagent.* / settings.* / extensions.info 可路由', () => {
    const list: GateCommand = { kind: 'subagent.list' }
    const upsert: GateCommand = {
      kind: 'subagent.upsert',
      agent: buildSubAgentPayload({ ...emptySubAgentForm, name: 'scout', systemPrompt: 'p', toolRefs: 'read' }),
    }
    const del: GateCommand = { kind: 'subagent.delete', name: 'scout' }
    const get: GateCommand = { kind: 'settings.get' }
    const set: GateCommand = { kind: 'settings.set', patch: buildSettingsPatch({ skillsDir: 'a', textSkillsDir: 'b' }) }
    const info: GateCommand = { kind: 'extensions.info' }
    expect([list, upsert, del, get, set, info].map((c) => c.kind)).toEqual([
      'subagent.list',
      'subagent.upsert',
      'subagent.delete',
      'settings.get',
      'settings.set',
      'extensions.info',
    ])
    if (set.kind === 'settings.set') {
      expect(set.patch).toEqual({ skillsDir: 'a', textSkillsDir: 'b' })
    }
  })
})

describe('parseListInput（MCP args / subagent toolRefs 共用）', () => {
  it('逗号分隔 + trim + 丢空项', () => {
    expect(parseListInput('a, b,c')).toEqual(['a', 'b', 'c'])
    expect(parseListInput('')).toEqual([])
    expect(parseListInput(' , , ')).toEqual([])
  })
})

describe('组件冒烟（SSR 渲染加载态——无 DOM 基建下的最低渲染验证）', () => {
  it('三个面板默认导出可渲染，命中加载态', () => {
    expect(renderToStaticMarkup(<McpPanel />)).toContain('加载中')
    expect(renderToStaticMarkup(<SkillPanel />)).toContain('加载中')
    expect(renderToStaticMarkup(<SubAgentPanel />)).toContain('加载中')
  })

  it('渲染产物包含面板核心结构（提示条 / 开关小字）', () => {
    const mcp = renderToStaticMarkup(<McpPanel />)
    expect(mcp).toContain('~/.databus/mcp.json')
    const skill = renderToStaticMarkup(<SkillPanel />)
    expect(skill).toContain('Skill 目录')
    const sub = renderToStaticMarkup(<SubAgentPanel />)
    expect(sub).toContain('允许子代理再创建/运行子代理')
    expect(sub).toContain('深度上限 3')
  })
})

// ---- 关键交互（happy-dom 真 DOM）----
// mock command 按 kind 分发并模拟后端状态（删除后 list 变短），验证的是
// "用户操作 → Gate 命令参数 → 界面反馈"整条链路。

afterEach(cleanup)

type CmdResult = { ok: boolean; result?: unknown; error?: string }

describe('McpPanel 关键交互', () => {
  const stdio: McpServerConfig = { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'fs'] }
  const http: McpServerConfig = { name: 'remote', transport: 'http', url: 'https://mcp.example.com' }

  const makeDispatch = (overrides?: { upsertResult?: CmdResult }) => {
    const servers = [stdio, http]
    const calls: GateCommand[] = []
    commandMock.mockImplementation(async (cmd: GateCommand): Promise<CmdResult> => {
      calls.push(cmd)
      switch (cmd.kind) {
        case 'mcp.list':
          return { ok: true, result: { exists: true, configPath: '~/.databus/mcp.json', servers: [...servers] } }
        case 'mcp.delete': {
          const i = servers.findIndex((s) => s.name === cmd.name)
          if (i >= 0) servers.splice(i, 1)
          return { ok: true, result: { configPath: '~/.databus/mcp.json' } }
        }
        case 'mcp.upsert':
          return overrides?.upsertResult ?? { ok: true, result: { configPath: '~/.databus/mcp.json' } }
        default:
          return { ok: false, error: `unexpected command: ${cmd.kind}` }
      }
    })
    return calls
  }

  it('载入渲染列表（stdio/http 两行），删除点击 → 命令参数正确且该行消失', async () => {
    const user = userEvent.setup()
    const calls = makeDispatch()
    render(<McpPanel />)

    expect(await screen.findByText('fs')).toBeTruthy()
    expect(screen.getByText('remote')).toBeTruthy()
    expect(screen.getByText('npx -y fs')).toBeTruthy()
    expect(screen.getByText('https://mcp.example.com')).toBeTruthy()

    const row = screen.getByText('fs').closest('div.rounded-md') as HTMLElement
    await user.click(within(row).getByRole('button', { name: '删除' }))

    await waitFor(() => expect(calls.some((c) => c.kind === 'mcp.delete' && c.name === 'fs')).toBe(true))
    await waitFor(() => expect(screen.queryByText('fs')).toBeNull())
    expect(screen.getByText('remote')).toBeTruthy()
  })

  it('新增表单：填写 → 保存 → mcp.upsert 载荷与表单输入一致', async () => {
    const user = userEvent.setup()
    const calls = makeDispatch()
    render(<McpPanel />)
    await screen.findByText('fs')

    await user.click(screen.getByRole('button', { name: '＋ 新增服务器' }))
    await user.type(screen.getByPlaceholderText('名称（如 filesystem）'), 'fs2')
    await user.type(screen.getByPlaceholderText('command（如 npx）'), 'npx')
    await user.type(screen.getByPlaceholderText(/args（逗号分隔/), '-y, @x/fs2')
    await user.click(screen.getByRole('button', { name: '保存' }))

    const upsert = calls.find((c) => c.kind === 'mcp.upsert') as { kind: 'mcp.upsert'; server: McpServerConfig }
    expect(upsert).toBeTruthy()
    expect(upsert.server).toStrictEqual({
      name: 'fs2',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@x/fs2'],
    })
    await screen.findByText('已新增 "fs2"')
  })

  it('后端校验失败 → 表单下方渲染错误原文，不显示成功 hint', async () => {
    const user = userEvent.setup()
    const calls = makeDispatch({ upsertResult: { ok: false, error: 'MCP server "x": name is reserved.' } })
    render(<McpPanel />)
    await screen.findByText('fs')

    await user.click(screen.getByRole('button', { name: '＋ 新增服务器' }))
    await user.type(screen.getByPlaceholderText('名称（如 filesystem）'), 'x')
    await user.type(screen.getByPlaceholderText('command（如 npx）'), 'npx')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('MCP server "x": name is reserved.')).toBeTruthy()
    expect(screen.queryByText(/已新增/)).toBeNull()
    expect(calls.filter((c) => c.kind === 'mcp.upsert')).toHaveLength(1)
  })
})

describe('SubAgentPanel 关键交互', () => {
  const scout: SubAgentConfig = { name: 'scout', systemPrompt: 'You scout.', toolRefs: ['read', 'grep'] }

  const makeDispatch = (initialNesting: boolean, setFail?: string) => {
    const agents = [scout]
    let nesting = initialNesting
    const calls: GateCommand[] = []
    commandMock.mockImplementation(async (cmd: GateCommand): Promise<CmdResult> => {
      calls.push(cmd)
      switch (cmd.kind) {
        case 'subagent.list':
          return { ok: true, result: { dir: '~/.databus/agents', agents: [...agents] } }
        case 'settings.get':
          return { ok: true, result: { subAgentNesting: nesting } }
        case 'settings.set': {
          if (setFail !== undefined) return { ok: false, error: setFail }
          nesting = (cmd.patch as { subAgentNesting?: boolean }).subAgentNesting === true
          return { ok: true, result: { subAgentNesting: nesting } }
        }
        case 'subagent.delete': {
          const i = agents.findIndex((a) => a.name === cmd.name)
          if (i >= 0) agents.splice(i, 1)
          return { ok: true, result: { dir: '~/.databus/agents' } }
        }
        default:
          return { ok: false, error: `unexpected command: ${cmd.kind}` }
      }
    })
    return calls
  }

  it('向下开关：初始 off → 点击 → settings.set({subAgentNesting:true}) → aria-checked 翻转（以后端合并结果为准）', async () => {
    const user = userEvent.setup()
    const calls = makeDispatch(false)
    render(<SubAgentPanel />)

    const toggle = await screen.findByRole('switch', { name: '允许子代理再创建/运行子代理' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    await user.click(toggle)

    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    expect(calls).toContainEqual(expect.objectContaining({ kind: 'settings.set', patch: { subAgentNesting: true } }))
    expect(await screen.findByText('已开启向下配置')).toBeTruthy()
  })

  it('开关后端拒绝 → 顶部 error 原文，aria-checked 不变', async () => {
    const user = userEvent.setup()
    makeDispatch(false, 'settings.json is not writable')
    render(<SubAgentPanel />)

    const toggle = await screen.findByRole('switch', { name: '允许子代理再创建/运行子代理' })
    await user.click(toggle)

    expect(await screen.findByText('settings.json is not writable')).toBeTruthy()
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('列表渲染 toolRefs chips → 删除点击 → subagent.delete 参数正确且行消失', async () => {
    const user = userEvent.setup()
    const calls = makeDispatch(true)
    render(<SubAgentPanel />)

    expect(await screen.findByText('scout')).toBeTruthy()
    expect(screen.getByText('read')).toBeTruthy()
    expect(screen.getByText('grep')).toBeTruthy()

    const row = screen.getByText('scout').closest('div.rounded-md') as HTMLElement
    await user.click(within(row).getByRole('button', { name: '删除' }))

    await waitFor(() => expect(calls.some((c) => c.kind === 'subagent.delete' && c.name === 'scout')).toBe(true))
    await waitFor(() => expect(screen.queryByText('scout')).toBeNull())
  })

  it('空表单提交 → 本地必填校验文案，不发 subagent.upsert', async () => {
    const user = userEvent.setup()
    const calls = makeDispatch(false)
    render(<SubAgentPanel />)
    await screen.findByText('scout')

    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('名称、systemPrompt、toolRefs 均为必填')).toBeTruthy()
    expect(calls.some((c) => c.kind === 'subagent.upsert')).toBe(false)
  })
})

describe('SkillPanel 关键交互', () => {
  it('载入渲染已配置目录 → 编辑模块目录 → 保存 → patch 参数正确 + 输入框用后端合并结果回写', async () => {
    const user = userEvent.setup()
    const calls: GateCommand[] = []
    let settings: { skillsDir?: string; textSkillsDir?: string } = { skillsDir: 'D:/a', textSkillsDir: 'D:/b' }
    commandMock.mockImplementation(async (cmd: GateCommand): Promise<CmdResult> => {
      calls.push(cmd)
      if (cmd.kind === 'extensions.info') {
        return { ok: true, result: { skills: ['code-review'], textSkills: [], servers: ['playwright'], skillsDir: settings.skillsDir, textSkillsDir: settings.textSkillsDir } }
      }
      if (cmd.kind === 'settings.get') return { ok: true, result: { ...settings } }
      if (cmd.kind === 'settings.set') {
        settings = { ...settings, ...(cmd.patch as object) }
        return { ok: true, result: { ...settings } }
      }
      return { ok: false, error: `unexpected command: ${cmd.kind}` }
    })
    render(<SkillPanel />)

    const moduleInput = await screen.findByPlaceholderText('如 C:\\skills\\modules')
    expect((moduleInput as HTMLInputElement).value).toBe('D:/a')
    expect(await screen.findByText('code-review')).toBeTruthy()
    expect(screen.getByText('playwright')).toBeTruthy()

    await user.clear(moduleInput)
    await user.type(moduleInput, 'D:/new-skills')
    await user.click(screen.getByRole('button', { name: '保存目录' }))

    await waitFor(() => {
      const set = calls.find((c) => c.kind === 'settings.set') as { patch: { skillsDir?: string; textSkillsDir?: string } }
      expect(set?.patch).toStrictEqual({ skillsDir: 'D:/new-skills', textSkillsDir: 'D:/b' })
    })
    await screen.findByText('已保存——重启 web-host 后生效')
    expect((moduleInput as HTMLInputElement).value).toBe('D:/new-skills')
  })
})
