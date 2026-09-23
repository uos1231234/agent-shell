// v0.33b 第二轮 — wiki.generate 生成任务管理器测试。
//
// 全真链路：wiki-pool 真子进程（WIKI_DATA_DIR 临时目录）+ createMockStreamChat
// 的 wiki 剧本（ls → wiki__add_card → 完成文本）→ manager.start 异步跑完整
// wiki agent loop → onStatus 序列断言 started→completed、cardsCreated=1、
// onChanged 调用一次；互斥：跑完后再启动（以及运行中再启动抛错）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { createWikiPool } from '../../src/host/wiki-pool.js'
import { createWikiGenerateManager } from '../../src/host/wiki-generate.js'
import { createMockStreamChat } from '../../src/host/mock.js'
import type { WikiGenerateStatus } from '../../src/signals/index.js'

describe('wiki-generate manager (real wiki server + mock wiki script)', () => {
  let dataDir: string
  let workDir: string
  let pool: ReturnType<typeof createWikiPool>

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wiki-gen-store-'))
    workDir = mkdtempSync(join(tmpdir(), 'wiki-gen-ws-'))
    writeFileSync(join(workDir, 'README.md'), '# 探针工作区\n\n用于生成任务测试。\n', 'utf-8')
    process.env.WIKI_DATA_DIR = dataDir
    pool = createWikiPool()
  }, 30_000)

  afterAll(async () => {
    await pool?.close()
    delete process.env.WIKI_DATA_DIR
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(workDir, { recursive: true, force: true })
    // wiki agent 收尾会调 render_md(card)——往仓库 visualizer/exports 写
    // 单卡快照（v0.13.1 约定目录）——测试只清自己生成的卡片文件。
    rmSync(join(process.cwd(), 'src/mcp-servers/wiki-mcp/visualizer/exports/card-user-mockwiki1.md'), { force: true })
  })

  it('start() runs the wiki agent end-to-end and reports started → completed', async () => {
    const statuses: WikiGenerateStatus[] = []
    let changed = 0
    let done!: () => void
    const finished = new Promise<void>((resolve) => (done = resolve))

    const manager = createWikiGenerateManager({
      pool,
      resolveLlm: () => ({ url: 'mock://llm', model: 'mock', streamChat: createMockStreamChat(), strictAlternation: false }),
      onStatus: (s) => {
        statuses.push(s)
        if (s.status === 'completed' || s.status === 'failed') done()
      },
      onChanged: () => {
        changed++
      },
    })

    manager.start(workDir)
    expect(manager.runningWorkDir()).toBe(workDir)
    await finished

    expect(statuses[0]).toEqual({ status: 'started', workDir })
    const last = statuses[statuses.length - 1]
    expect(last).toMatchObject({ status: 'completed', workDir, cardsCreated: 1 })
    expect(changed).toBe(1)
    expect(manager.runningWorkDir()).toBeUndefined()

    // 卡片真实落库（全局单库 = dataDir），tags 带工作区标签。
    const conn = await pool.connection()
    const raw = await conn.callTool('list_cards', {})
    const parsed = JSON.parse(raw) as { results: Array<{ id: string }> }
    expect(parsed.results.map((c) => c.id)).toContain('user-mockwiki1')
    // tag 提取锁死：任务指令里的 workspace: 标签必须原样落到卡片 tags
    // （请求尾部有空 userTemplate 补位——mock 用"首条含标记的 user 消息"）。
    const cardRaw = await conn.callTool('get_card', { card_id: 'user-mockwiki1' })
    const card = JSON.parse(cardRaw) as { tags?: string[] }
    expect(card.tags).toContain(`workspace:${basename(workDir)}`)
  }, 30_000)

  it('second concurrent start() throws a clean mutual-exclusion error', async () => {
    // 用一个永不完成的 streamChat 制造"运行中"窗口。
    const never: (url: string, request: unknown) => AsyncIterable<never> = () =>
      (async function* () {
        await new Promise(() => undefined)
      })()
    const manager = createWikiGenerateManager({
      pool,
      resolveLlm: () => ({ url: 'mock://llm', model: 'mock', streamChat: never as never, strictAlternation: false }),
      onStatus: () => undefined,
      onChanged: () => undefined,
    })
    manager.start(workDir)
    expect(() => manager.start(workDir)).toThrow(/already running/)
    manager.shutdown()
  }, 30_000)
})
