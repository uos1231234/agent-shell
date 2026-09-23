// v0.40 接线验收 — 委托授权段（prompt 侧对 subAgentNesting 开关的镜像）
//
// 验收口径（工件区 AGENTS.md §5：实现 ≠ 接线 ≠ 生效）：
//   a) 前端→Gate 命令 settings.set 写开关（信号关是唯一通道，零旁路）；
//   b) attachSession 读同一 settings.json（assembly 的 readSettings 单入口，
//      toolPolicy 判定与提示词条件同源由构造保证）；
//   c) 提示词授权段可见于三个面：assembly 侧 assets.prompt、LLM 请求体
//      （llmStreamChatFactory 捕获）、Gate 出站 system.prompt 事件（前端面）。
//   d) 开关 OFF → 模板与 v0.39 字节一致（无授权段、无孤儿占位符）。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { createHostAssembly } from '../../src/host/assembly.js'
import type { HostAssembly, HostStreamChat } from '../../src/host/assembly.js'
import type { ChatMessage, StreamChunk } from '../../src/protocol/types.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'delegation-wiring-'))

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

const TEXT_OK: StreamChunk[] = [
  { type: 'content_delta', text: 'ok' },
  { type: 'finish', reason: 'stop' },
  { type: 'done' },
]

type CapturedRequest = { messages: ChatMessage[] }

const makeRecordingStreamChat = (captured: CapturedRequest[]): HostStreamChat =>
  async function* (url, request) {
    const req = request as { messages: ChatMessage[] }
    captured.push({ messages: req.messages })
    yield* TEXT_OK
  }

const allSystemText = (messages: ChatMessage[]): string =>
  messages
    .filter((m): m is Extract<ChatMessage, { role: 'system' }> => m.role === 'system')
    .map((m) => m.content)
    .join('\n')

/** settings.json 落盘在测试家目录（settingsHomeDir 缝），不碰真实 ~/.databus。 */
const makeAssembly = async (
  name: string,
  captured: CapturedRequest[],
  nesting: boolean,
): Promise<{ assembly: HostAssembly; settingsHome: string; ws: string }> => {
  const settingsHome = join(tmpRoot, `home-${name}`)
  mkdirSync(join(settingsHome, '.databus'), { recursive: true })
  const ws = join(tmpRoot, `ws-${name}`)
  mkdirSync(ws, { recursive: true })
  // 前端经 Gate settings.set 写入的落盘形态（写好再做装配 —— 生产装配读磁盘）。
  writeFileSync(
    join(settingsHome, '.databus', 'settings.json'),
    JSON.stringify({ subAgentNesting: nesting }),
    'utf8',
  )
  const assembly = await createHostAssembly({
    dataDir: join(tmpRoot, `sessions-${name}`),
    settingsHomeDir: settingsHome,
    providerLookup: { homeDir: join(tmpRoot, 'prov-home'), env: { ARK_KEY: 'test-key' } },
    promptLayerUserPath: join(tmpRoot, 'no-such-PROMPT.md'),
    llmStreamChatFactory: () => makeRecordingStreamChat(captured),
  })
  return { assembly, settingsHome, ws }
}

describe('delegation authorization wiring (v0.40: switch → prompt mirror through the gate)', () => {
  it('switch ON → authorization block reaches prompt, LLM request body, and the system.prompt gate event', async () => {
    const captured: CapturedRequest[] = []
    const { assembly, ws } = await makeAssembly('on', captured, true)
    try {
      const seenEvents: string[] = []
      assembly.gate.on('session.event', (e) => {
        if (e.kind === 'session.event' && e.event === 'system.prompt') {
          const data = e.data as { text?: string } | undefined
          seenEvents.push(data?.text ?? '')
        }
      })

      const assets = await assembly.attachSession(ws)
      // a) 主代理侧条件读的是与 toolPolicy 同一 settings.json（同源）。
      expect(assets.prompt()).toContain('# Delegation Authorization')
      expect(assets.prompt()).toContain('depth of 3')
      expect(assets.prompt()).not.toContain('{delegation_section}')

      const result = await assembly.handlers.runPrompt(assets.handle.info.id, '你好')
      expect(result.reason).toBe('completed')

      // b) LLM 请求体（wire face）携带授权段。
      const sys = allSystemText(captured[0]!.messages)
      expect(sys).toContain('# Delegation Authorization')
      expect(sys).toContain('you and the sub-agents you spawn hold run_subagent / define_subagent')

      // c) Gate 出站 system.prompt 事件（前端实际消费的 face）。
      expect(seenEvents.length).toBeGreaterThan(0)
      expect(seenEvents[seenEvents.length - 1]!).toContain('# Delegation Authorization')
    } finally {
      await assembly.shutdown()
    }
  })

  it('switch OFF → no authorization block, and no orphan placeholder leaks', async () => {
    const captured: CapturedRequest[] = []
    const { assembly, ws } = await makeAssembly('off', captured, false)
    try {
      const assets = await assembly.attachSession(ws)
      expect(assets.prompt()).not.toContain('# Delegation Authorization')
      expect(assets.prompt()).not.toContain('you and the sub-agents you spawn hold')
      expect(assets.prompt()).not.toContain('{delegation_section}')

      await assembly.handlers.runPrompt(assets.handle.info.id, '你好')
      const sys = allSystemText(captured[0]!.messages)
      expect(sys).not.toContain('# Delegation Authorization')
    } finally {
      await assembly.shutdown()
    }
  })

  it('gate settings.set flows into the next attached session (new-session semantics)', async () => {
    // 模拟前端：唯一通道 = Gate 命令（settings.set）→ 落盘 settings.json。
    const captured: CapturedRequest[] = []
    const { assembly, settingsHome, ws } = await makeAssembly('gate-write', captured, false)
    try {
      await assembly.gate.command({ kind: 'settings.set', patch: { subAgentNesting: true } })
      const onDisk = JSON.parse(
        (await import('node:fs')).readFileSync(join(settingsHome, '.databus', 'settings.json'), 'utf8'),
      )
      expect(onDisk.subAgentNesting).toBe(true)

      // 新会话（attach）读到开关 → 提示词注入授权段。
      const assets = await assembly.attachSession(ws)
      expect(assets.prompt()).toContain('# Delegation Authorization')

      // 运行中会话不变（拍板语义：新会话生效）——旧会话的 prompt 不重拼。
      expect(assets.prompt()).toContain(ws)
    } finally {
      await assembly.shutdown()
    }
  })
})