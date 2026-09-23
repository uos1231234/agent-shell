// v0.26 Wave 5 — TuiApp 集成测试（headless，全注入）。
//
// 用**真实的** createHostAssembly（mock LLM）+ fake TuiIo（写捕获 stdout /
// PassThrough 语义的 stdin 监听捕获）驱动完整回路：
//   stdin 字节 → TuiScreen → InputRouter → 编辑器/浮层 → dispatch → gate →
//   信号 → SessionView → 帧。
//
// 诚实边界（无 tty）：断言落在 (1) 视图状态（app.view / router.state /
// editor.getLine）与 (2) 捕获的帧内容（app.renderFrame 输出 + stdout wire
// payload）上——不声称验证了真实终端视觉效果。

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createHostAssembly } from '../../src/host/assembly.js'
import type { HostAssembly } from '../../src/host/assembly.js'
import { TuiApp } from '../../cli/app.js'
import { activeShard, pendingApprovalCount } from '../../cli/session-view.js'
import { stripAnsi } from '../../cli/tui/markdown.js'
import type { TuiIo } from '../../cli/tui/renderer.js'
import { parseCliArgs, validateWorkDir } from '../../cli/main.js'

// ---------------------------------------------------------------------------
// Fake I/O（无 tty；renderer.test.ts 同款形态 + stdin data 监听捕获）
// ---------------------------------------------------------------------------

const WIDTH = 100

function makeIo(): {
  io: TuiIo
  writes: string[]
  feed: (s: string) => void
} {
  const writes: string[] = []
  const stdout = {
    columns: WIDTH,
    write: vi.fn((payload: string) => {
      writes.push(payload)
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  }
  const stdin = {
    isTTY: false,
    setRawMode: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  }
  const io = { stdout, stdin } as unknown as TuiIo
  const feed = (s: string): void => {
    const call = (stdin.on as ReturnType<typeof vi.fn>).mock.calls.find(([ev]) => ev === 'data')
    if (call === undefined) throw new Error('screen.start() was not called — no stdin data listener')
    ;(call[1] as (chunk: Buffer) => void)(Buffer.from(s, 'utf8'))
  }
  return { io, writes, feed }
}

// ---------------------------------------------------------------------------
// 共享装置
// ---------------------------------------------------------------------------

const tmpRoot = mkdtempSync(join(tmpdir(), 'cli-app-test-'))
const ws = join(tmpRoot, 'ws-main')
const otherWs = join(tmpRoot, 'ws-other')

let assembly: HostAssembly
let app: TuiApp
let io: ReturnType<typeof makeIo>
let quitSpy: ReturnType<typeof vi.fn>

const frameLines = (): string[] => app.renderFrame(WIDTH).map(stripAnsi)
const frameText = (): string => frameLines().join('\n')

/** 强制全量重绘并取走 wire payload（浮层内容只在 screen 合成帧里出现）。 */
const composedWireText = async (): Promise<string> => {
  io.writes.length = 0
  app.screen.invalidate()
  await vi.waitFor(() => expect(io.writes.length).toBeGreaterThan(0), { timeout: 2000, interval: 10 })
  return io.writes.join('')
}

const waitUntil = async (fn: () => boolean | void, timeout = 10_000): Promise<void> => {
  await vi.waitFor(fn, { timeout, interval: 20 })
}

beforeAll(async () => {
  mkdirSync(ws, { recursive: true })
  mkdirSync(otherWs, { recursive: true })
  assembly = await createHostAssembly({ dataDir: join(tmpRoot, 'sessions'), mock: true })
  quitSpy = vi.fn()
  io = makeIo()
  app = new TuiApp({
    io: io.io,
    gate: assembly.gate,
    workDir: ws,
    bannerLines: [`[HE-CLI] 工作区: ${ws}`, '[HE-CLI] LLM: mock', '[HE-CLI] /help 查看命令'],
    onQuit: () => quitSpy(),
  })
  app.start()
})

afterAll(async () => {
  app?.dispose()
  await assembly?.shutdown()
  rmSync(tmpRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// a-f 场景（顺序执行，共享一个装配体——与 tests/host/assembly.test.ts 同型）
// ---------------------------------------------------------------------------

describe('TuiApp integration (real host assembly, mock LLM, headless TUI)', () => {
  let originalSessionId = ''

  it('a. BOOT: /new 路径建会话；帧含 banner + 状态行 + 编辑器行', async () => {
    await app.startNewSession()

    originalSessionId = app.view.activeSessionId!
    expect(originalSessionId).toBeDefined()
    // 会话确实经 assembly 建出（gate 观察到）。
    expect(assembly.gate.snapshot().sessions).toContain(originalSessionId)

    const text = frameText()
    expect(text).toContain('[HE-CLI] 工作区:')
    expect(text).toContain('[HE-CLI] LLM: mock')
    expect(text).toContain(`会话 ${originalSessionId.slice(0, 8)}`)
    expect(text).toContain('空闲')
    // 编辑器行在帧底（PROMPT '> ' + 反video 光标位，stripAnsi 后以 '>' 开头）。
    const last = frameLines()[frameLines().length - 1]!
    expect(last.startsWith('>')).toBe(true)
    // wire 上真实画过 banner（全量首帧）。
    await expect(composedWireText()).resolves.toContain('[HE-CLI]')
  }, 20_000)

  it('b. MESSAGE LOOP: mock 审批闭环（浮层 → y → 工具卡收口 + 完成文本 + idle）', async () => {
    io.feed('hi\n')

    // write door → gate.request → onSignal 入队 → editor 态自动挂审批浮层。
    await waitUntil(() => expect(app.router.state).toBe('approval'))
    // 审批浮层在合成帧（screen 层）可见——视图态与帧内容双断言。
    expect(app.queue.size).toBe(1)
    const wire = await composedWireText()
    expect(wire).toContain('审批请求')
    expect(wire).toContain('write')
    expect(activeShard(app.view)!.phase).toBe('streaming')

    io.feed('y') // 浮层决议：approval.decision → 工具执行 → 第二轮完成
    await waitUntil(() => expect(app.router.state).toBe('editor'))
    await waitUntil(() => expect(activeShard(app.view)!.phase).toBe('idle'))

    const shard = activeShard(app.view)!
    const user = shard.items.find((it) => it.kind === 'user')
    expect(user).toMatchObject({ kind: 'user', text: 'hi' })
    const assistant = shard.items.find((it) => it.kind === 'assistant')
    expect(assistant && assistant.kind === 'assistant' && assistant.text.includes('我来创建一个文件')).toBe(true)
    const card = shard.items.find((it) => it.kind === 'tool')
    expect(card).toMatchObject({ kind: 'tool', toolName: 'write', status: 'success', producedPath: 'hello.txt' })
    expect(pendingApprovalCount(app.view)).toBe(0)
    expect(frameText()).toContain('✓ write → hello.txt')
    // mock 真落盘（同一工作区）。
    expect(existsSync(join(ws, 'hello.txt'))).toBe(true)
  }, 20_000)

  it('c. BLOCKED: streaming 中 /new 被搁置——输入还原 + 提示 + 未建会话', async () => {
    io.feed('again\n')
    // appendUserMessage 同步置 streaming（发送管线无 await 前置）。
    expect(activeShard(app.view)!.phase).toBe('streaming')

    io.feed('/new\n')
    expect(app.editor.getLine()).toBe('/new') // KimiCode restoreInputText 语义
    expect(frameText()).toContain('回合进行中')
    expect(frameText()).toContain('已被搁置')
    expect(assembly.gate.snapshot().sessions.length).toBe(1) // 没有建新会话

    await waitUntil(() => expect(activeShard(app.view)!.phase).toBe('idle'))
  }, 20_000)

  it('e. PICKER: 分区展示 + 外来会话拒绝 + 本工作区切换（同一 reducer hydrate）', async () => {
    // scenario c 的 blocked 还原把 '/new' 留在了编辑器里——真实用户会先清行，
    // 这里同样 Ctrl-U 清掉再输入（否则 '/sessions' 会拼成 '/new/sessions'
    // 降级为普通 prompt 发给模型）。
    io.feed('\x15')
    // 同毫秒创建会让 lastActiveAt 排序不稳定——错开保证 picker 顺序确定。
    await new Promise((r) => setTimeout(r, 5))
    const own2 = await assembly.handlers.session.create({ workDir: ws })
    await new Promise((r) => setTimeout(r, 5))
    const foreign = await assembly.handlers.session.create({ workDir: otherWs })

    io.feed('/sessions\n')
    await waitUntil(() => expect(app.router.state).toBe('picker'))
    // picker 是浮层——内容只出现在 screen 合成帧（wire），不在根帧里。
    const pickerText = stripAnsi(await composedWireText())
    expect(pickerText).toContain('当前工作区')
    expect(pickerText).toContain('其他工作区')
    expect(pickerText).toContain(foreign.info.id.slice(0, 8))

    // 清单序（lastActiveAt 降序）：own2 新于 boot 会话 → [own2, boot, foreign]。
    // ↓↓ 移到外来条目 → Enter → 提示 + 不切换。
    io.feed('\x1b[B\x1b[B')
    io.feed('\r')
    await waitUntil(() => expect(app.router.state).toBe('editor'))
    expect(frameText()).toContain('属于其他工作区')
    expect(app.view.activeSessionId).toBe(originalSessionId)

    // 选中本工作区会话（own2，index 0）→ 切换 + hydrate（空历史）。
    io.feed('/sessions\n')
    await waitUntil(() => expect(app.router.state).toBe('picker'))
    io.feed('\r')
    await waitUntil(() => expect(app.view.activeSessionId).toBe(own2.info.id))
    expect(app.view.shards.get(own2.info.id)!.hydrated).toBe(true)

    // 切回 boot 会话 → 历史条目经同一渲染路径出现（scenario b 的回合）。
    io.feed('/sessions\n')
    await waitUntil(() => expect(app.router.state).toBe('picker'))
    io.feed('\x1b[B') // index 1 = boot 会话（own2 刚 open，仍最新）
    io.feed('\r')
    await waitUntil(() => expect(app.view.activeSessionId).toBe(originalSessionId))
    expect(activeShard(app.view)!.items.length).toBeGreaterThan(0)
  }, 20_000)

  it('f. EXPORT: /export 落盘 workDir/exports，markdown 含历史回合', async () => {
    io.feed('/export\n')
    await waitUntil(() => expect(frameText()).toContain('已导出'))

    const exportsDir = join(ws, 'exports')
    expect(existsSync(exportsDir)).toBe(true)
    const files = readdirSync(exportsDir).filter((f) => f.endsWith('.md'))
    expect(files.length).toBe(1)
    const md = readFileSync(join(exportsDir, files[0]!), 'utf8')
    // [已验证] canonical 历史只有 assistant/tool 回合——runIMLoop 不落 user
    // 回合（harness 事实，v0.26 零 harness 改动约束；user 侧只能靠视图本地
    // 投影）。因此导出断言只看 assistant 与工具回合。
    expect(md).toContain('## assistant')
    expect(md).toContain('我来创建一个文件')
    expect(md).toContain('### 工具调用 `write`')
    expect(md).toContain('hello.txt')
  }, 20_000)

  it('d. /help 与 /usage 进状态区；/quit 触发退出回调', async () => {
    io.feed('/help\n')
    // 状态区只保留最后 6 行（STATUS_HINT_CAP）——help 面板 22 条，断言尾部可见行。
    await waitUntil(() => expect(frameText()).toContain('/quit (q, exit)'))
    await waitUntil(() => expect(frameText()).toContain('/fork'))

    io.feed('/usage\n')
    await waitUntil(() => expect(frameText()).toContain('tokens（turn.end 累积）'))

    io.feed('/quit\n')
    await waitUntil(() => expect(quitSpy).toHaveBeenCalledTimes(1))
    // Wave A：退出 resume 提示（screen.stop 之后的 setImmediate 落点）——
    // 含恢复命令与活跃会话 id。
    await vi.waitFor(
      () =>
        expect(io.writes.join('')).toContain(
          `要恢复此会话: npx tsx cli/main.ts --resume ${originalSessionId}`,
        ),
      { timeout: 2000, interval: 10 },
    )
  }, 20_000)

  it('d2. Ctrl-C×2 退出（独立轻量 app；空闲态第一击只提示）', async () => {
    const io2 = makeIo()
    const quitSpy2 = vi.fn()
    const app2 = new TuiApp({ io: io2.io, gate: assembly.gate, workDir: ws, onQuit: quitSpy2 })
    app2.start()

    io2.feed('\x03')
    await waitUntil(() => expect(app2.renderFrame(WIDTH).map(stripAnsi).join('\n')).toContain('再按一次 Ctrl-C'))
    expect(quitSpy2).not.toHaveBeenCalled()

    io2.feed('\x03') // 2s 窗口内第二击 → 退出
    expect(quitSpy2).toHaveBeenCalledTimes(1)
    // Wave A：无活跃会话 → 退出不打印 resume 提示。
    await new Promise((r) => setImmediate(r))
    expect(io2.writes.join('')).not.toContain('要恢复此会话')

    app2.dispose()
    app2.screen.stop()
  }, 20_000)
})

// ---------------------------------------------------------------------------
// main.ts 纯函数单元（参数解析 + workDir 校验）
// ---------------------------------------------------------------------------

describe('parseCliArgs / validateWorkDir', () => {
  it('解析全部开关；--resume 裸/带 id 两态；--session 别名', () => {
    expect(parseCliArgs(['--workdir', 'X', '--mock'])).toEqual({ workDir: 'X', mock: true })
    expect(parseCliArgs(['--resume'])).toEqual({ resume: true })
    expect(parseCliArgs(['--resume', 'abc'])).toEqual({ resume: 'abc' })
    expect(parseCliArgs(['--session', 'abc'])).toEqual({ resume: 'abc' })
    expect(parseCliArgs(['--data-dir', 'D'])).toEqual({ dataDir: 'D' })
    expect(parseCliArgs(['--no-network-tools'])).toEqual({ noNetworkTools: true })
    // v0.42 大输入切块：--chunk 开关 headless 切块模式。
    expect(parseCliArgs(['--chunk'])).toEqual({ chunk: true })
    expect(parseCliArgs(['--workflow'])).toEqual({ workflow: true })
    expect(parseCliArgs(['--workflow-baseline'])).toEqual({ workflow: true, workflowBaseline: true })
    expect(() => parseCliArgs(['--bogus'])).toThrow(/未知参数/)
  })

  it('workDir 必须已存在且是目录（权限边界，CLI 严于宿主 mkdir 兜底）', () => {
    expect(validateWorkDir('')).toMatchObject({ ok: false })
    expect(validateWorkDir(join(tmpRoot, 'no-such-dir'))).toMatchObject({ ok: false })
    expect(validateWorkDir(ws)).toMatchObject({ ok: true, dir: ws })
  })
})
