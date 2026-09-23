// v0.30 — 模型能力声明 → 出站请求增强 + define_subagent 动态 schema。
//
// 用户拍板（2026-09-09）：providers.json capabilities/thinking 由装配层引用——
//   1. 出站请求注入 max_tokens（模型声明输出上限，消除服务商默认 ~12000 截断）
//      + thinking（缺省 'max'，DeepSeek thinking.reasoning_effort 档位）；
//   2. define_subagent 的 config.maxTokens 描述带宿主模型真实上限（AI 配子代理
//      预算不再盲配）+ 超模型 maxInputTokens 时定义期拒绝。
//
// 本测试走真实 createHostAssembly 链路（providerLookup 注入临时 HOME），出站
// 请求由本地 http server 捕获——断言的是"生产组装发出的真实 body"。

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createHostAssembly, resolveLLMPlan } from '../../src/host/assembly.js'
import type { HostAssembly } from '../../src/host/assembly.js'
import type { ModelCapabilities } from '../../src/config/types.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'model-caps-test-'))

// ---- 本地"服务商"：捕获出站 body，回一个最小 SSE 流 ----
let captured: Array<Record<string, unknown>> = []
let server: Server
let port = 0

const sseBody =
  'data: {"choices":[{"delta":{"content":"hi"}}],"usage":null}\n\n'
  + 'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105}}\n\n'
  + 'data: [DONE]\n\n'

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c })
    req.on('end', () => {
      captured.push(JSON.parse(raw) as Record<string, unknown>)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sseBody)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(tmpRoot, { recursive: true, force: true })
})

const writeProviders = (
  caps?: ModelCapabilities,
  thinking?: 'max' | 'high' | 'low' | 'off',
  opts?: { model?: string; declareReasoning?: boolean },
): string => {
  const home = mkdtempSync(join(tmpRoot, 'home-'))
  mkdirSync(home, { recursive: true })
  const model = opts?.model ?? 'test-model'
  const provider: Record<string, unknown> = {
    url: `http://127.0.0.1:${port}/chat`,
    apiKey: 'test-key',
    model,
  }
  if (caps !== undefined) provider['capabilities'] = caps
  if (thinking !== undefined) provider['thinking'] = thinking
  if (opts?.declareReasoning === true) {
    // 显式声明思考能力（默认档 max）——未知模型的"缺省 max"从此声明获得
    // （v0.32 保守方案：未知且未声明 → 不注入）。
    provider['models'] = [{ id: model, reasoning: { efforts: ['max', 'high', 'low', 'off'], defaultEffort: 'max' } }]
  }
  writeFileSync(join(home, 'providers.json'), JSON.stringify({
    active: 'test',
    providers: { test: provider },
  }))
  return home
}

describe('resolveLLMPlan: capabilities/thinking 读取', () => {
  it('声明 reasoning → thinking 缺省走 defaultEffort(max)；capabilities 照读', () => {
    const home = writeProviders({ maxInputTokens: 1000000, maxOutputTokens: 384000 }, undefined, { declareReasoning: true })
    const plan = resolveLLMPlan({ lookup: { homeDir: home, env: {} } })
    expect(plan.modelCaps).toEqual({ maxInputTokens: 1000000, maxOutputTokens: 384000 })
    expect(plan.thinking).toBe('max')
  })

  it('v0.32 保守方案：未知且未声明 reasoning → thinking undefined（不发思考字段）', () => {
    const home = writeProviders({ maxInputTokens: 1000000, maxOutputTokens: 384000 })
    const plan = resolveLLMPlan({ lookup: { homeDir: home, env: {} } })
    expect(plan.thinking).toBeUndefined()
  })

  it('内置表命中（deepseek-v4*）无需声明 → 缺省 max', () => {
    const home = writeProviders(undefined, undefined, { model: 'deepseek-v4-flash' })
    const plan = resolveLLMPlan({ lookup: { homeDir: home, env: {} } })
    expect(plan.thinking).toBe('max')
  })

  it('未声明 capabilities → modelCaps undefined；thinking 显式 off 生效（provider 级强制）', () => {
    const home = writeProviders(undefined, 'off')
    const plan = resolveLLMPlan({ lookup: { homeDir: home, env: {} } })
    expect(plan.modelCaps).toBeUndefined()
    expect(plan.thinking).toBe('off')
  })
})

describe('出站请求增强（真实 assembly → 本地服务商捕获）', () => {
  it('声明 reasoning + 默认档 → body 含 max_tokens 与 thinking{enabled,max}', async () => {
    const home = writeProviders({ maxInputTokens: 1000000, maxOutputTokens: 384000 }, undefined, { declareReasoning: true })
    const assembly: HostAssembly = await createHostAssembly({
      dataDir: join(tmpRoot, 'sessions-a'),
      providerLookup: { homeDir: home },
    })
    try {
      const handle = await assembly.handlers.session.create({ workDir: join(tmpRoot, 'ws-a') })
      await assembly.handlers.runPrompt(handle.info.id, 'hi')
      expect(captured.length).toBeGreaterThan(0)
      const body = captured[captured.length - 1]!
      expect(body['max_tokens']).toBe(384000)
      expect(body['thinking']).toEqual({ type: 'enabled', reasoning_effort: 'max' })
      expect(body['model']).toBe('test-model')
    } finally {
      await assembly.shutdown()
    }
  })

  it('thinking: off → body 含 thinking{disabled}；未声明 capabilities → 无 max_tokens', async () => {
    captured = []
    const home = writeProviders(undefined, 'off')
    const assembly: HostAssembly = await createHostAssembly({
      dataDir: join(tmpRoot, 'sessions-b'),
      providerLookup: { homeDir: home },
    })
    try {
      const handle = await assembly.handlers.session.create({ workDir: join(tmpRoot, 'ws-b') })
      await assembly.handlers.runPrompt(handle.info.id, 'hi')
      const body = captured[captured.length - 1]!
      expect(body['thinking']).toEqual({ type: 'disabled' })
      expect(body['max_tokens']).toBeUndefined()
    } finally {
      await assembly.shutdown()
    }
  })
})

describe('define_subagent: 动态 schema + 超模型输入校验（单元级，直接驱动工具）', () => {
  it('schema description 带宿主模型真实上限（AI 不再盲配）', async () => {
    const home = writeProviders({ maxInputTokens: 1000000, maxOutputTokens: 384000 })
    const assembly: HostAssembly = await createHostAssembly({
      dataDir: join(tmpRoot, 'sessions-c'),
      providerLookup: { homeDir: home },
    })
    try {
      const assets = await assembly.attachSession(join(tmpRoot, 'ws-c'))
      const tool = assets.registry.getSystemTool('define_subagent')
      expect(tool).toBeDefined()
      const props = (tool!.parameters as unknown as { properties: { config: { description: string } } }).properties
      expect(props.config.description).toContain('1000000')
      expect(props.config.description).toContain('384000')
      expect(props.config.description).toContain('NOT an output cap')
    } finally {
      await assembly.shutdown()
    }
  })

  it('config.maxTokens 超模型 maxInputTokens → 定义期拒绝（AI 盲配防线）', async () => {
    const home = writeProviders({ maxInputTokens: 50000 })
    const assembly: HostAssembly = await createHostAssembly({
      dataDir: join(tmpRoot, 'sessions-d'),
      providerLookup: { homeDir: home },
    })
    try {
      const assets = await assembly.attachSession(join(tmpRoot, 'ws-d'))
      const tool = assets.registry.getSystemTool('define_subagent')!
      await expect(
        tool.execute({
          name: 'oversized',
          systemPrompt: 's',
          toolRefs: [],
          config: { maxTokens: 60000 },
          reason: 'test oversize rejection',
        }),
      ).rejects.toThrow(/exceeds the host model's max input tokens/)
    } finally {
      await assembly.shutdown()
    }
  })
})
