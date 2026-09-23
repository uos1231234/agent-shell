// Wave B1 — provider 热切换：runPromptOnce 的 streamChat/url/model 从启动绑定
// 改为每次调用时解析（providers.json 磁盘事实源）。
//
// 可测形态（设计说明）：注入 llmStreamChatFactory 录制每次构建时的 LLMPlan，
// 不发真 HTTP——useMock=false（providers.json 条目带 apiKey）时装配层走
// factory 缝，录到的 plan 即每轮真正喂给 loop 的 url/model。mock 路径不受
// factory 影响（断言 mock: true 时 factory 零调用）。

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { createHostAssembly, resolveLLMPlan } from '../../src/host/assembly.js'
import type { HostAssembly, HostStreamChat } from '../../src/host/assembly.js'
import type { StreamChunk } from '../../src/protocol/types.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'host-hot-switch-'))
const home = join(tmpRoot, 'home')
const dataDir = join(tmpRoot, 'sessions')
const ws = join(tmpRoot, 'ws')

const URL_A = 'https://provider-a.test/v1/chat/completions'
const URL_B = 'https://provider-b.test/v1/chat/completions'

const writeProviders = (active: string): void => {
  writeFileSync(
    join(home, 'providers.json'),
    JSON.stringify({
      active,
      providers: {
        a: { url: URL_A, apiKey: 'key-a', model: 'model-a' },
        b: { url: URL_B, apiKey: 'key-b', model: 'model-b' },
      },
    }),
    'utf8',
  )
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

/** 干净完成文本的假 streamChat；逐次调用记录 loop 实际收到的 url + request.model。 */
const recordedCalls: { url: string; model: string }[] = []
const fakeStreamChat: HostStreamChat = async function* (url, request) {
  recordedCalls.push({ url, model: request.model })
  const chunks: StreamChunk[] = [
    { type: 'content_delta', text: 'ok' },
    { type: 'finish', reason: 'stop' },
    { type: 'done' },
  ]
  yield* chunks
}

describe('provider hot-switch (Wave B1)', () => {
  it('activateProvider 后下一个 runPrompt 即用新 provider；同 provider 连续轮次复用缓存实例', async () => {
    mkdirSync(home, { recursive: true })
    mkdirSync(ws, { recursive: true })
    writeProviders('a')
    recordedCalls.length = 0

    const factoryCalls: string[] = []
    const assembly: HostAssembly = await createHostAssembly({
      dataDir,
      providerLookup: { homeDir: home },
      llmStreamChatFactory: (plan) => {
        factoryCalls.push(`${plan.providerName}:${plan.model}:${plan.url}`)
        return fakeStreamChat
      },
    })

    try {
      const handle = await assembly.handlers.session.create({ workDir: ws })
      const sessionId = handle.info.id

      // 第 1 轮：active = a（loop 实际收到 a 的 url/model）。
      await assembly.handlers.runPrompt(sessionId, 'hi')
      expect(recordedCalls[0]).toEqual({ url: URL_A, model: 'model-a' })

      // 热切换：activate b（写 providers.json）→ 第 2 轮即用 b。
      await assembly.handlers.provider!.activate('b')
      await assembly.handlers.runPrompt(sessionId, 'hi again')
      expect(recordedCalls[1]).toEqual({ url: URL_B, model: 'model-b' })

      // 第 3 轮不切换 → 仍是 b；streamChat 实例按 url|key|model 缓存——
      // factory 只在 a、b 各构建一次（第 3 轮命中缓存，无新 factory 调用）。
      await assembly.handlers.runPrompt(sessionId, 'third')
      expect(recordedCalls[2]).toEqual({ url: URL_B, model: 'model-b' })
      expect(factoryCalls).toEqual([`a:model-a:${URL_A}`, `b:model-b:${URL_B}`])
    } finally {
      await assembly.shutdown()
    }
  })

  it('mock: true 时恒用内部 mock streamChat，factory 零调用（--mock 不受 providers.json 影响）', async () => {
    let factoryCalls = 0
    const assembly = await createHostAssembly({
      dataDir: join(tmpRoot, 'sessions-mock'),
      mock: true,
      providerLookup: { homeDir: home },
      llmStreamChatFactory: () => {
        factoryCalls++
        return fakeStreamChat
      },
    })
    try {
      const handle = await assembly.handlers.session.create({ workDir: ws })
      // mock 首轮回放 write 工具调用 → 审批闭环（assembly.test.ts 同款）。
      const approvalIds: string[] = []
      assembly.gate.on('approval', (req) => {
        if (req.kind === 'approval') approvalIds.push(req.requestId)
      })
      const pending = assembly.handlers.runPrompt(handle.info.id, 'hi')
      await vi.waitFor(() => expect(approvalIds.length).toBeGreaterThan(0), { timeout: 5000 })
      assembly.gate.resolve(approvalIds[0]!, 'approved')
      const result = await pending
      expect(result.reason).toBe('completed')
      expect(factoryCalls).toBe(0)
    } finally {
      await assembly.shutdown()
    }
  }, 20_000)

  it('provider.* gate 命令读写注入的 homeDir；upsert 同名换 url 后缓存键随连接参数失效', async () => {
    const assembly = await createHostAssembly({
      dataDir: join(tmpRoot, 'sessions-cfg'),
      providerLookup: { homeDir: home },
      llmStreamChatFactory: () => fakeStreamChat,
    })
    try {
      const provider = assembly.handlers.provider!
      const list = await provider.list()
      expect(list.exists).toBe(true)
      expect(list.active).toBe('b') // 上一用例 activate b 持久化的结果
      expect(Object.keys(list.providers).sort()).toEqual(['a', 'b'])

      // upsert 同名条目换 url —— 下一轮解析出新连接参数（不按 name 缓存）。
      await provider.upsert('a', {
        url: 'https://provider-a2.test/v1/chat/completions',
        apiKey: 'key-a2',
        model: 'model-a2',
      })
      const plan = resolveLLMPlan({ lookup: { homeDir: home } })
      expect(plan).toMatchObject({
        providerName: 'b',
        url: URL_B,
        model: 'model-b',
      })
      // 切回 a：拿到的是 upsert 后的新连接参数。
      await provider.activate('a')
      const planA = resolveLLMPlan({ lookup: { homeDir: home } })
      expect(planA).toMatchObject({
        providerName: 'a',
        url: 'https://provider-a2.test/v1/chat/completions',
        model: 'model-a2',
        apiKey: 'key-a2',
      })

      // 删 active 被配置层拒绝（fail-fast 不变式——先 activate 另一个再删）。
      await expect(provider.delete('a')).rejects.toThrow(/is active/)
      await provider.activate('b')
      await provider.delete('a')
      const after = await provider.list()
      expect(after.providers['a']).toBeUndefined()

      // 写盘落点 = 注入的 homeDir（不污染真实 ~/.agent-shell）。
      const onDisk = JSON.parse(readFileSync(join(home, 'providers.json'), 'utf8')) as {
        providers: Record<string, unknown>
      }
      expect(Object.keys(onDisk.providers)).toEqual(['b'])
    } finally {
      await assembly.shutdown()
    }
  })
})

describe('resolveLLMPlan — lookup 注入与回落路径', () => {
  it('按注入的 homeDir 解析显式 provider，并拒绝不存在的系统 provider', () => {
    const plan = resolveLLMPlan({
      lookup: { homeDir: home, env: {} },
      providerName: 'b',
    })
    expect(plan).toMatchObject({ providerName: 'b', url: URL_B, model: 'model-b' })
    expect(() => resolveLLMPlan({
      lookup: { homeDir: home, env: {} },
      providerName: 'missing',
    })).toThrow(/Provider "missing" was not found/)
  })

  it('providers.json 缺失 → 回落 env（lookup.env 可注入，不读进程真实 env）', () => {
    const plan = resolveLLMPlan({
      lookup: { configPath: join(tmpRoot, 'no-such-providers.json'), env: { ARK_KEY: 'env-key' } },
    })
    expect(plan.providerName).toBeUndefined()
    expect(plan.apiKey).toBe('env-key')
    expect(plan.model).toBe('glm-5.3-flash')
    expect(plan.useMock).toBe(false)
  })

  it('providers.json 解析失败 → throw 干净错误（不静默回落 env——load.ts fail-fast 纪律）', () => {
    const bad = join(tmpRoot, 'bad-providers.json')
    writeFileSync(bad, '{ not json', 'utf8')
    expect(() =>
      resolveLLMPlan({ lookup: { configPath: bad, env: { ARK_KEY: 'k' } } }),
    ).toThrow(/not valid JSON/)
  })

  it('providers.json 缺失且无 key → useMock（auto 判定）', () => {
    const plan = resolveLLMPlan({
      lookup: { configPath: join(tmpRoot, 'no-such-providers.json'), env: {} },
    })
    expect(plan.useMock).toBe(true)
  })
})
