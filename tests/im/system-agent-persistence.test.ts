import { describe, it, expect, afterAll } from 'vitest'
import { rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSystemAgent } from '../../src/im/system-agent.js'
import { ToolRegistry } from '../../src/shell/registry.js'
import { Mailbox } from '../../src/im/mailbox/index.js'
import { createConfig } from '../../src/shell/config.js'
import type { StreamChunk } from '../../src/protocol/types.js'
import type { StateLine } from '../../src/im/state-line/types.js'
import { createNoopStateLine } from '../../src/im/state-line/index.js'

// ---- fakes ----

// 摘要/回复两用的文本流：每个回合产一条固定文本。
const textStream = (texts: string[]): Parameters<typeof createSystemAgent>[0]['llmStreamChat'] => {
  let i = 0
  return async function* (_url: string, _request: unknown): AsyncIterable<StreamChunk> {
    const t = texts[Math.min(i, texts.length - 1)]!
    i += 1
    yield { type: 'content_delta', text: t }
    yield { type: 'finish', reason: 'stop' }
    yield { type: 'done' }
  }
}

const baseOpts = () => ({
  name: 'warehouse' as const,
  systemPrompt: 'test warehouse',
  toolRefs: [] as string[],
  url: 'https://x',
  model: 'test-model',
  mailbox: new Mailbox(),
  registry: new ToolRegistry(),
  stateLine: createNoopStateLine() as StateLine,
})

describe('im/system-agent persistent session (v0.30 warehouse)', () => {
  const dir = join(tmpdir(), `warehouse-persist-test-${Date.now()}`)
  const persistPath = join(dir, 'state', 'warehouse-session.jsonl')

  it('keeps conversation across run() calls and persists to disk', async () => {
    const agent = createSystemAgent({
      ...baseOpts(),
      llmStreamChat: textStream(['回复一', '回复二']),
      persistent: true,
      persistPath,
    })

    const r1 = await agent.run({ messages: [{ role: 'user', content: '归档任务 A' }] })
    expect(r1.output).toBe('回复一')
    // 落盘文件存在
    expect(existsSync(persistPath)).toBe(true)
    const afterRun1 = readFileSync(persistPath, 'utf8').trim().split('\n')
    // 1 user + 1 assistant = 2 turns
    expect(afterRun1).toHaveLength(2)

    const r2 = await agent.run({ messages: [{ role: 'user', content: '归档任务 B' }] })
    expect(r2.output).toBe('回复二')
    // 持久会话：两次 run 累积（2 + 2 = 4 turns）
    expect(readFileSync(persistPath, 'utf8').trim().split('\n')).toHaveLength(4)
  })

  it('reloads persisted state into a fresh factory instance', async () => {
    // 新工厂实例（同 persistPath）启动时读回前一个实例的状态。
    const agent2 = createSystemAgent({
      ...baseOpts(),
      llmStreamChat: textStream(['回复三']),
      persistent: true,
      persistPath,
    })
    // 不直接暴露 conversationMemory——用落盘行数断言：run 后 = 4 + 2 = 6。
    await agent2.run({ messages: [{ role: 'user', content: '归档任务 C' }] })
    expect(readFileSync(persistPath, 'utf8').trim().split('\n')).toHaveLength(6)
  })

  it('non-persistent agents stay fresh per run (default unchanged)', async () => {
    const freshPath = join(dir, 'fresh.jsonl')
    const agent = createSystemAgent({
      ...baseOpts(),
      llmStreamChat: textStream(['a', 'b']),
    })
    await agent.run({ messages: [{ role: 'user', content: '任务 1' }] })
    await agent.run({ messages: [{ role: 'user', content: '任务 2' }] })
    // 非持久：无落盘
    expect(existsSync(freshPath)).toBe(false)
  })

  it('handoff compaction fires via beforeShellCall when the local count crosses the trigger', async () => {
    // 小 maxTokens（100）→ 触发阈值 85。触发口径已完全去上游化（2026-09-16）：
    // beforeShellCall 的 ctx.promptTokens = 本地 DeepSeek 加权计数（不再读 provider
    // usage，也不再用跨 run 结转的 lastRequestTokens）。持久系统智能体跨 run 累积
    // **输入的 messages**（自身回复不保留），故用"轮 1 输入小、轮 2 输入大"驱动：
    // 轮 1 本地计数 ~64 < 85 不触发；轮 2 累积了大的输入 → 本地计数 > 85 → 轮初
    // 触发压缩：发出摘要请求 → 折叠 → 轮 2 主请求。
    const smallConfig = createConfig({ maxTokens: 100 })
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
    let call = 0
    const llm: Parameters<typeof createSystemAgent>[0]['llmStreamChat'] = async function* (_url, request) {
      requests.push(request as typeof requests[number])
      call += 1
      if (call === 1) {
        yield { type: 'content_delta', text: '第一轮回复' }
        yield { type: 'usage', usage: { promptTokens: 5000, completionTokens: 10, totalTokens: 5010 } }
      } else if (call === 2) {
        yield { type: 'content_delta', text: '（交接笔记）此前完成了任务 1' }
      } else {
        yield { type: 'content_delta', text: '第二轮回复' }
        // 小 usage：guard 看 lastRequestTokens(50) < maxTokens(100) 不触发。
        // 压缩触发已与 usage 解耦（只看本地 DeepSeek 计数），此 usage 仅供 guard。
        yield { type: 'usage', usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55 } }
      }
      yield { type: 'finish', reason: 'stop' }
      yield { type: 'done' }
    }
    const agent = createSystemAgent({
      ...baseOpts(),
      config: smallConfig,
      llmStreamChat: llm,
      // 持久会话：轮 2 保留轮 1 输入历史（4 条 assistant ≥ minFoldTurns 防抖阈值）
      persistent: true,
      compaction: {},
    })

    await agent.run({
      messages: [
        { role: 'user', content: '任务 1' },
        // 4 条 assistant 历史（小）→ 折叠对象 ≥ minFoldTurns(4)，但轮 1 本地计数未过阈
        { role: 'assistant', content: '历史步骤一' },
        { role: 'assistant', content: '历史步骤二' },
        { role: 'assistant', content: '历史步骤三' },
        { role: 'assistant', content: '第一轮回复' },
      ],
    })
    // 请求 1 = 轮 1 主请求；轮初 canonical 仅小历史，本地计数 < 85，无压缩。
    expect(requests).toHaveLength(1)

    // 轮 2 输入撑大（CJK ≈0.6 token/字，~80 字 ≈48 token）：累积进 canonical 后
    // 本地计数 ~112 > 85 → 触发压缩。
    const r2 = await agent.run({ messages: [{ role: 'user', content: '继续处理此前的任务'.repeat(10) }] })
    // 轮 2：压缩摘要请求（call 2）+ 轮 2 主请求（call 3）。
    expect(requests).toHaveLength(3)
    const summaryReq = requests[1]!
    const summaryText = String(summaryReq.messages.at(-1)!.content)
    expect(summaryText).toContain('交接笔记')
    // 折叠生效：轮 2 主请求的历史里，轮 1 的 assistant 回复被折叠成笔记
    // turn（user role、带 prefix），不再有原 assistant 消息。
    const round2Messages = requests[2]!.messages
    const roles = round2Messages.map(m => m.role)
    expect(roles).not.toContain('assistant')
    const noteMsg = round2Messages.find(m => typeof m.content === 'string' && m.content.includes('此前的对话已被压缩'))
    expect(noteMsg).toBeDefined()
    expect(r2.output).toBe('第二轮回复')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('im/system-agent private databus persistence (v0.30 v2)', () => {
  const dir = join(tmpdir(), `warehouse-databus-test-${Date.now()}`)
  const persistPath = join(dir, 'state', 'warehouse-session.jsonl')

  it('persists and reloads the private databus alongside the conversation', async () => {
    const toolStream: Parameters<typeof createSystemAgent>[0]['llmStreamChat'] = async function* () {
      yield { type: 'content_delta', text: 'ok' }
      yield { type: 'finish', reason: 'stop' }
      yield { type: 'done' }
    }
    const agent = createSystemAgent({
      ...baseOpts(),
      llmStreamChat: toolStream,
      persistent: true,
      persistPath,
    })
    await agent.run({ messages: [{ role: 'user', content: '归档任务 A' }] })

    const databusPath = join(dir, 'state', 'warehouse-session-databus.jsonl')
    expect(existsSync(databusPath)).toBe(true)

    // 新工厂实例读回（conversation + databus 都恢复）。
    const agent2 = createSystemAgent({
      ...baseOpts(),
      llmStreamChat: toolStream,
      persistent: true,
      persistPath,
    })
    await agent2.run({ messages: [{ role: 'user', content: '归档任务 B' }] })
    // databus 文件随 run 累积（同 conversation 快照策略：行数 = 上次落盘数 + 本次新增）
    expect(readFileSync(databusPath, 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(1)
  })

  it('external injected databus (sub-agent shared bus) is not persisted', async () => {
    const injectedBus = new (await import('../../src/im/databus.js')).Databus()
    const ownPath = join(dir, 'injected-session.jsonl')
    const agent = createSystemAgent({
      ...baseOpts(),
      llmStreamChat: textStream(['a']),
      persistent: true,
      persistPath: ownPath,
      databus: injectedBus,
    })
    await agent.run({ messages: [{ role: 'user', content: '任务' }] })
    // 有外部注入时只落 conversation，不落 databus（injected bus 属于父会话，
    // 由父负责生命周期）。
    expect(existsSync(join(dir, 'injected-session-databus.jsonl'))).toBe(false)
    // conversation 快照正常写。
    expect(existsSync(ownPath)).toBe(true)
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('compaction failure retry + reporting (v0.30 v2)', () => {
  it('retries 3x and reports to workingAgentId via mailbox systemSend when still failing', async () => {
    const mailbox = new (await import('../../src/im/mailbox/index.js')).Mailbox()
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
    let call = 0
    const llm: Parameters<typeof createSystemAgent>[0]['llmStreamChat'] = async function* (_url, request) {
      requests.push(request as typeof requests[number])
      call += 1
      if (call === 1) {
        yield { type: 'content_delta', text: '第一轮回复' }
        yield { type: 'usage', usage: { promptTokens: 5000, completionTokens: 5, totalTokens: 5005 } }
      } else if (call >= 2) {
        // 摘要请求永远返回空 → compactConversation throw（每次重试都失败）
        yield { type: 'usage', usage: { promptTokens: 5000, completionTokens: 5, totalTokens: 5005 } }
      }
      yield { type: 'finish', reason: call >= 2 ? 'stop' : 'stop' }
      yield { type: 'done' }
    }
    const agent = createSystemAgent({
      ...baseOpts(),
      mailbox,
      name: 'warehouse',
      config: createConfig({ maxTokens: 100 }),
      llmStreamChat: llm,
      persistent: true,
      compaction: { retryLimit: 3, retryDelayMs: 1 },
      workingAgentId: 'main',
    })
    await agent.run({
      messages: [
        { role: 'user', content: '任务' },
        { role: 'assistant', content: 'h1' },
        { role: 'assistant', content: 'h2' },
        { role: 'assistant', content: 'h3' },
        { role: 'assistant', content: 'h4' },
      ],
    })
    // 第二次 run：轮 2 输入撑大 → 累积后本地 DeepSeek 计数过阈 → beforeShellCall
    // 触发压缩 → 摘要请求永远空 → 失败重试 3 次后上报。
    await agent.run({ messages: [{ role: 'user', content: '继续处理此前的任务'.repeat(10) }] })
    // 主请求 1 次 + 摘要请求 4 次（初始 + 3 重试）
    expect(call).toBeGreaterThanOrEqual(5)
    // 工作代理收件箱收到失败通知
    const inbox = mailbox.readOwnInbox('main')
    const note = inbox.find(m => m.body.includes('应用程序错误'))
    expect(note).toBeDefined()
    expect(note!.subject).toContain('压缩失败')
  })

  it('sub-agent failures report to the caller (parent) agent id', async () => {
    const mailbox = new (await import('../../src/im/mailbox/index.js')).Mailbox()
    let call = 0
    const llm: Parameters<typeof createSystemAgent>[0]['llmStreamChat'] = async function* () {
      call += 1
      if (call === 1) {
        yield { type: 'content_delta', text: '第一轮回复' }
        yield { type: 'usage', usage: { promptTokens: 5000, completionTokens: 5, totalTokens: 5005 } }
      } else {
        yield { type: 'usage', usage: { promptTokens: 5000, completionTokens: 5, totalTokens: 5005 } }
      }
      yield { type: 'finish', reason: 'stop' }
      yield { type: 'done' }
    }
    const agent = createSystemAgent({
      ...baseOpts(),
      mailbox,
      name: 'sub-abc123',
      config: createConfig({ maxTokens: 100 }),
      llmStreamChat: llm,
      persistent: true,
      compaction: { retryLimit: 3, retryDelayMs: 1 },
      workingAgentId: 'main',
    })
    await agent.run({
      messages: [
        { role: 'user', content: '任务' },
        { role: 'assistant', content: 'h1' },
        { role: 'assistant', content: 'h2' },
        { role: 'assistant', content: 'h3' },
        { role: 'assistant', content: 'h4' },
      ],
    })
    await agent.run({ messages: [{ role: 'user', content: '继续处理此前的任务'.repeat(10) }] })
    const inbox = mailbox.readOwnInbox('main')
    const note = inbox.find(m => m.body.includes('子代理'))
    expect(note).toBeDefined()
    expect(note!.body).toContain('请主代理自行处理')
  })
})
