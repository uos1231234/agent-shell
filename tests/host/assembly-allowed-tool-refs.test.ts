// allowedToolRefs 装配级过滤验收（experimental/eval allowlist, 2026-09-22）
//
// 背景：`HostAssemblyOptions.allowedToolRefs` 是宿主装配层的一个白名单开关，
// 默认 undefined = 不过滤（零行为变化）；设置后 exposedToolRefs 只保留名单内
// 工具。它存在的目的是评测/实验（例如只给 recall 工具、不给 read/write/bash）。
//
// 验收口径（AGENTS.md §5「实现 ≠ 接线 ≠ 生效」）——同一份白名单必须在三个面
// 保持一致，否则 LLM 看到的、请求体带的、运行时能调的三者会漂移：
//   a) attached 面：assets.exposedToolRefs（提示词 + session.event 'tools' 的源）
//   b) wire 面：LLM 请求体的 tools[]（模型实际看到的 schema）
//   c) runtime 面：registry.execute 的 ctx.allowedToolRefs 检查（已由
//      tests/shell/registry.test.ts 覆盖，本文件不再重复）
//
// 断言方法刻意不用硬编码全量清单——工具集会随版本增删，写死即过期。
// 用「无白名单的基线装配」做对照，只断言子集关系与具体名单内的可见性。

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { createHostAssembly } from '../../src/host/assembly.js'
import type { HostAssembly, HostStreamChat } from '../../src/host/assembly.js'
import type { StreamChunk } from '../../src/protocol/types.js'
import type { OpenAITool } from '../../src/protocol/types.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'assembly-allowed-tool-refs-'))

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

const TEXT_OK: StreamChunk[] = [
  { type: 'content_delta', text: 'ok' },
  { type: 'finish', reason: 'stop' },
  { type: 'done' },
]

/** HostStreamChat 的 request 形状（assembly.ts:171 的宽松 wire 投影）。 */
type CapturedRequest = { tools?: unknown[] | undefined }

const makeRecordingStreamChat = (captured: CapturedRequest[]): HostStreamChat =>
  async function* (_url, request) {
    captured.push({ tools: request.tools })
    yield* TEXT_OK
  }

const toolNamesOf = (req: CapturedRequest): string[] =>
  ((req.tools ?? []) as OpenAITool[]).map((t) => t.function.name)

/** 建一个装配并 attach 一个工作区。allowlist 缺省 = 不过滤。 */
const attach = async (
  name: string,
  captured: CapturedRequest[],
  allowedToolRefs?: readonly string[],
): Promise<{ assembly: HostAssembly; assets: Awaited<ReturnType<HostAssembly['attachSession']>> }> => {
  const ws = join(tmpRoot, `ws-${name}`)
  mkdirSync(ws, { recursive: true })
  const assembly = await createHostAssembly({
    dataDir: join(tmpRoot, `sessions-${name}`),
    providerLookup: { homeDir: join(tmpRoot, `providers-${name}`), env: { ARK_KEY: 'test-key' } },
    llmStreamChatFactory: () => makeRecordingStreamChat(captured),
    ...(allowedToolRefs !== undefined ? { allowedToolRefs } : {}),
  })
  const assets = await assembly.attachSession(ws)
  return { assembly, assets }
}

describe('allowedToolRefs: assembly-level tool exposure filter', () => {
  it('undefined allowlist exposes the full system-tool set unchanged (regression guard)', async () => {
    const captured: CapturedRequest[] = []
    const { assembly, assets } = await attach('baseline', captured)
    try {
      const baseline = assets.exposedToolRefs
      // 基线必须非空且有我们熟知的核心工具在列（证明测试没测到空集上）。
      expect(baseline.length).toBeGreaterThan(0)
      expect(baseline).toContain('read')
      expect(baseline).toContain('grep')
      expect(baseline).toContain('bash')

      // 系统智能体私有工具永不进工作代理白名单（既有纪律，白名单不得破坏它）。
      expect(baseline).not.toContain('submit_curated_memory')
      expect(baseline).not.toContain('record_m3_summary')

      // wire 面与 attached 面同源：请求体 tools[] 与 exposedToolRefs 逐个相等。
      await assembly.handlers.runPrompt(assets.handle.info.id, 'hi')
      expect(captured.length).toBe(1)
      expect(toolNamesOf(captured[0]!).sort()).toEqual([...baseline].sort())
    } finally {
      await assembly.shutdown()
    }
  })

  it('allowlist narrows exposedToolRefs and the LLM request body to the same subset', async () => {
    const captured: CapturedRequest[] = []
    // 取三个不同类别的工具：read（read 类）/ bash（command 类）/ web_fetch（联网）。
    const allowlist = ['read', 'bash', 'web_fetch']
    const { assembly, assets } = await attach('narrowed', captured, allowlist)
    try {
      // a) attached 面：只剩白名单内的（顺序跟随 registry，不承诺）。
      expect(assets.exposedToolRefs).toEqual(expect.arrayContaining(allowlist))
      for (const name of assets.exposedToolRefs) {
        expect(allowlist).toContain(name)
      }

      // b) wire 面：模型实际拿到的 tools[] 与 attached 面一致（无漂移）。
      await assembly.handlers.runPrompt(assets.handle.info.id, 'hi')
      expect(captured.length).toBe(1)
      const sent = toolNamesOf(captured[0]!)
      expect(sent.sort()).toEqual([...assets.exposedToolRefs].sort())
      expect(sent).toContain('read')
      expect(sent).toContain('bash')
      expect(sent).not.toContain('write')
      expect(sent).not.toContain('edit')
      expect(sent).not.toContain('grep')
    } finally {
      await assembly.shutdown()
    }
  })

  it('allowlist composes with noNetworkTools instead of overriding it', async () => {
    const captured: CapturedRequest[] = []
    // 白名单里显式包含联网工具，但 noNetworkTools 同时开着——两者都应生效
    // （noNetworkTools 是机制层摘除，白名单不能再把它加回来）。
    const ws = join(tmpRoot, 'ws-both')
    mkdirSync(ws, { recursive: true })
    const assembly = await createHostAssembly({
      dataDir: join(tmpRoot, 'sessions-both'),
      providerLookup: { homeDir: join(tmpRoot, 'providers-both'), env: { ARK_KEY: 'test-key' } },
      llmStreamChatFactory: () => makeRecordingStreamChat(captured),
      noNetworkTools: true,
      allowedToolRefs: ['read', 'bash', 'web_fetch', 'open_url'],
    })
    try {
      const assets = await assembly.attachSession(ws)
      expect(assets.exposedToolRefs).toContain('read')
      expect(assets.exposedToolRefs).toContain('bash')
      expect(assets.exposedToolRefs).not.toContain('web_fetch')
      expect(assets.exposedToolRefs).not.toContain('open_url')
    } finally {
      await assembly.shutdown()
    }
  })

  it('names absent from the registry are inert (no crash, no phantom refs)', async () => {
    const captured: CapturedRequest[] = []
    const { assembly, assets } = await attach('phantom', captured, ['read', 'no_such_tool'])
    try {
      expect(assets.exposedToolRefs).toEqual(['read'])
      await assembly.handlers.runPrompt(assets.handle.info.id, 'hi')
      expect(toolNamesOf(captured[0]!).sort()).toEqual(['read'])
    } finally {
      await assembly.shutdown()
    }
  })
})
