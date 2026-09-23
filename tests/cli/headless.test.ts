// headless 批处理模式测试（-p / --output-format / --yolo）。
//
// 进程内调 main([...argv])（mock LLM + tmp workDir/dataDir，零外呼零 API 成
// 本），vi.spyOn(process.stdout/stderr, 'write') 捕获输出。main 的 headless
// 路径返回退出码而非 process.exit——测试可直接断言。
//
// 审批语义验证：不带 --yolo 时 headless 在收到审批请求的瞬间拒绝挂起审批
// （fail-closed 解除 door 阻塞，不等 300s）→ loop 对 denied 工具照常走完，
// 但批处理退出码为 1（无人值守出现审批请求 = 失败）。两个 no-yolo 场景都是
// 秒级完成，不会真等 300s。
//
// 注：turn.end 的 reason 仍是 'completed' 而非取消态——runPromptOnce 未把
// abort signal 接进 loop（src/host/assembly.ts，src/ 改动超出本任务边界），
// 无人值守的失败语义由退出码承载。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { main } from '../../cli/main.js'

// ---------------------------------------------------------------------------
// 装置：tmp 根目录 + stdout/stderr 捕获
// ---------------------------------------------------------------------------

const tmpRoot = mkdtempSync(join(tmpdir(), 'cli-headless-test-'))

const captureIo = (): {
  stdout: string[]
  stderr: string[]
  restore: () => void
} => {
  const stdout: string[] = []
  const stderr: string[] = []
  const outSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: string | Uint8Array) => {
      stdout.push(String(chunk))
      return true
    }) as typeof process.stdout.write)
  const errSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk))
      return true
    }) as typeof process.stderr.write)
  return {
    stdout,
    stderr,
    restore: () => {
      outSpy.mockRestore()
      errSpy.mockRestore()
    },
  }
}

/** 跑一次 headless main 并捕获输出（恢复 spy 在 finally，避免污染 vitest 报告）。 */
const runHeadlessMain = async (
  argv: string[],
): Promise<{ code: number | void; stdout: string; stderr: string }> => {
  const cap = captureIo()
  try {
    const code = await main(argv)
    return { code, stdout: cap.stdout.join(''), stderr: cap.stderr.join('') }
  } finally {
    cap.restore()
  }
}

/** json 模式输出 → 事件数组（每行必须合法 JSON）。 */
const parseNdjson = (stdout: string): Record<string, unknown>[] =>
  stdout
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)

/** 断言 types 是 expected 的有序子序列。 */
const expectOrderedSubsequence = (types: unknown[], expected: string[]): void => {
  let i = 0
  for (const t of types) {
    if (t === expected[i]) i++
  }
  expect(i, `事件序列 ${JSON.stringify(types)} 应包含有序子序列 ${JSON.stringify(expected)}`).toBe(
    expected.length,
  )
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

describe('CLI headless 批处理模式', () => {
  it('1. text + --yolo + --mock：退出码 0，stdout 只含最终回复，hello.txt 真落盘', async () => {
    const ws = join(tmpRoot, 'ws-text-yolo')
    mkdirSync(ws, { recursive: true })

    const { code, stdout, stderr } = await runHeadlessMain([
      '-p',
      'hi',
      '--workdir',
      ws,
      '--mock',
      '--yolo',
      '--data-dir',
      join(tmpRoot, 'data-text-yolo'),
    ])

    expect(code).toBe(0)
    // stdout 纯净 = 恰好最终 assistant 文本（mock 完成文案自带 \n）。
    expect(stdout).toBe('已写入 hello.txt。mock 端到端流程完成。\n')
    expect(stderr).toBe('')
    expect(readFileSync(join(ws, 'hello.txt'), 'utf8')).toContain('hello from')
  })

  it('2. json 不带 --yolo + --mock：approval.request 事件出现，审批被拒，退出码 1，文件未写', async () => {
    const ws = join(tmpRoot, 'ws-json-noyolo')
    mkdirSync(ws, { recursive: true })

    const { code, stdout } = await runHeadlessMain([
      '-p',
      'hi',
      '--workdir',
      ws,
      '--mock',
      '--output-format',
      'json',
      '--data-dir',
      join(tmpRoot, 'data-json-noyolo'),
    ])

    expect(code).toBe(1)
    const events = parseNdjson(stdout)
    const approval = events.find((e) => e.type === 'approval.request')
    expect(approval).toMatchObject({ toolName: 'write' })
    expect(typeof approval?.requestId).toBe('string')
    expect(typeof approval?.reason).toBe('string')
    // 审批被拒 → fail-closed deny → write 工具错误回合。
    const toolResult = events.find((e) => e.type === 'tool.result')
    expect(toolResult).toMatchObject({ toolName: 'write', isError: true })
    const turnEnd = events.find((e) => e.type === 'turn.end')
    expect(turnEnd?.reason).toBe('completed') // loop 对 denied 工具照常走完（见文件头注）
    // 文件不存在（审批从未批准）。
    expect(existsSync(join(ws, 'hello.txt'))).toBe(false)
    // 事件序列：approval.request 出现在 tool.result 之前，最后是 session.completed。
    expectOrderedSubsequence(
      events.map((e) => e.type),
      ['approval.request', 'tool.result', 'turn.end', 'session.completed'],
    )
  })

  it('2b. text 不带 --yolo + --mock：stderr 打印人类可读审批说明，退出码 1', async () => {
    const ws = join(tmpRoot, 'ws-text-noyolo')
    mkdirSync(ws, { recursive: true })

    const { code, stdout, stderr } = await runHeadlessMain([
      '-p',
      'hi',
      '--workdir',
      ws,
      '--mock',
      '--data-dir',
      join(tmpRoot, 'data-text-noyolo'),
    ])

    expect(code).toBe(1)
    // stdout 纯净 = 规格口径的"最后一条非空 assistant 回合"（审批被拒后 mock
    // 的收尾文案——如实输出，尽管文件实际未写）；审批说明走 stderr。
    expect(stdout).toBe('已写入 hello.txt。mock 端到端流程完成。\n')
    expect(stderr).toContain('审批请求')
    expect(stderr).toContain('write')
    expect(stderr).toContain('已拒绝')
    expect(existsSync(join(ws, 'hello.txt'))).toBe(false)
  })

  it('3. json + --yolo + --mock：逐行合法 JSON，事件序列完整（created→started→result→message→end→completed）', async () => {
    const ws = join(tmpRoot, 'ws-json-yolo')
    mkdirSync(ws, { recursive: true })

    const { code, stdout } = await runHeadlessMain([
      '-p',
      'hi',
      '--workdir',
      ws,
      '--mock',
      '--yolo',
      '--output-format',
      'json',
      '--data-dir',
      join(tmpRoot, 'data-json-yolo'),
    ])

    expect(code).toBe(0)
    const events = parseNdjson(stdout) // 任一行非法 JSON 会在此抛出
    expect(events.length).toBeGreaterThan(0)
    expect(events[0]).toMatchObject({ type: 'session.created' })
    expect(typeof events[0]?.sessionId).toBe('string')

    expectOrderedSubsequence(events.map((e) => e.type), [
      'session.created',
      'turn.start',
      'tool.started',
      'tool.result',
      'assistant.message',
      'turn.end',
      'session.completed',
    ])

    const toolStarted = events.find((e) => e.type === 'tool.started')
    expect(toolStarted).toMatchObject({ toolName: 'write' })
    const toolResult = events.find((e) => e.type === 'tool.result')
    expect(toolResult).toMatchObject({ toolName: 'write', isError: false })
    const turnEnd = events.find((e) => e.type === 'turn.end')
    expect(turnEnd).toMatchObject({ reason: 'completed', turns: 2 })
    expect(typeof turnEnd?.tokens).toBe('number')
    // 最后 assistant 文本与 text 模式一致（历史派生）。
    const messages = events.filter((e) => e.type === 'assistant.message')
    expect(String(messages[messages.length - 1]?.content)).toContain('已写入 hello.txt')
  })

  it('4. headless 缺 --workdir：退出码 2 + 用法说明（不进 TUI、不问询）', async () => {
    const { code, stderr } = await runHeadlessMain(['-p', 'hi', '--mock'])

    expect(code).toBe(2)
    expect(stderr).toContain('--workdir')
    expect(stderr).toContain('用法')
  })

  it('5. headless 参数错误（--output-format 非法值）：退出码 2', async () => {
    const ws = join(tmpRoot, 'ws-bad-format')
    mkdirSync(ws, { recursive: true })

    const { code, stderr } = await runHeadlessMain([
      '-p',
      'hi',
      '--workdir',
      ws,
      '--mock',
      '--output-format',
      'xml',
    ])

    expect(code).toBe(2)
    expect(stderr).toContain('--output-format')
  })

  it('6. json 模式日志出口：info 级日志以 type:"log" 进 NDJSON，既有事件序列不受影响', async () => {
    const ws = join(tmpRoot, 'ws-json-log')
    mkdirSync(ws, { recursive: true })

    const { code, stdout } = await runHeadlessMain([
      '-p',
      'hi',
      '--workdir',
      ws,
      '--mock',
      '--yolo',
      '--output-format',
      'json',
      '--data-dir',
      join(tmpRoot, 'data-json-log'),
    ])

    expect(code).toBe(0)
    const events = parseNdjson(stdout)
    // ② 日志出口：loop 的 info 级日志（runIMLoop start 等）以 type:"log" 进流。
    const logEvents = events.filter((e) => e.type === 'log')
    expect(logEvents.length).toBeGreaterThan(0)
    for (const e of logEvents) {
      expect(typeof e.level).toBe('string')
      expect(typeof e.msg).toBe('string')
    }
    // 既有事件序列不受影响（有序子序列断言，log 事件插在中间不算破坏）。
    expectOrderedSubsequence(events.map((e) => e.type), [
      'session.created', 'turn.start', 'tool.started', 'tool.result', 'assistant.message', 'turn.end', 'session.completed',
    ])
  })

  it('7. json + --goal：goal.changed 事件进 NDJSON，且 goal.set 发生在 turn.start 之前', async () => {
    const ws = join(tmpRoot, 'ws-json-goal')
    mkdirSync(ws, { recursive: true })

    const { code, stdout } = await runHeadlessMain([
      '-p',
      'hi',
      '--workdir',
      ws,
      '--mock',
      '--yolo',
      '--output-format',
      'json',
      '--goal',
      '把工作区里的报告写完',
      '--data-dir',
      join(tmpRoot, 'data-json-goal'),
    ])

    expect(code).toBe(0)
    const events = parseNdjson(stdout)
    const goalEvents = events
      .filter((e) => e.type === 'goal.changed')
      .map((e) => e.event as { status: string })

    // mock 剧本：judge 第一次 not_met（驱动一次续跑）、第二次 met（收尾）。
    expect(goalEvents.map((e) => e.status)).toEqual(['set', 'round', 'met'])

    // 顺序承重：goal 必须在 user.prompt **之前**设置，否则第一轮收尾时 goal 还没
    // 激活，beforeComplete 弃权，白跑一轮。
    const types = events.map((e) => e.type)
    expect(types.indexOf('goal.changed')).toBeLessThan(types.indexOf('turn.start'))

    // 完整 GoalEvent 原样转发（评测脚本据此还原裁决序列），不被压成一行摘要。
    const round = events.find((e) => e.type === 'goal.changed'
      && (e.event as { status: string }).status === 'round')
    expect(round?.event).toMatchObject({
      status: 'round',
      round: 1,
      maxRounds: 24,
      verdict: { verdict: 'not_met' },
    })
  })

  it('8. text + --goal：stdout 仍只含最终回复，goal 摘要走 stderr（与 TUI 共用文案）', async () => {
    const ws = join(tmpRoot, 'ws-text-goal')
    mkdirSync(ws, { recursive: true })

    const { code, stdout, stderr } = await runHeadlessMain([
      '-p',
      'hi',
      '--workdir',
      ws,
      '--mock',
      '--yolo',
      '--goal',
      '把工作区里的报告写完',
      '--data-dir',
      join(tmpRoot, 'data-text-goal'),
    ])

    expect(code).toBe(0)
    // stdout 契约不变：恰好最终 assistant 文本（goal 事件不污染管道输出）。
    expect(stdout).toBe('已写入 hello.txt。mock 端到端流程完成。\n')
    // 文案本体是 session-view 的 goalEventLabel（不两处漂移）。
    expect(stderr).toContain('[HE-CLI] 🎯 目标已设置 · 上限 24 轮 · 把工作区里的报告写完')
    expect(stderr).toContain('[HE-CLI] 🎯 目标未达成 · 第 1/24 轮')
    expect(stderr).toContain('[HE-CLI] ✅ 目标已达成 · 用了 2 轮')
  })
})
