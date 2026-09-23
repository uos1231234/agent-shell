// v0.33b — Gate wiki.* 命令路由 + 全局单库 wiki round trip。
//
// 两层覆盖：
//   1. gate 路由（仿 gate-waveb-commands 款式）：handler 提供时参数原样透传；
//      缺省时干净英文错误。
//   2. wiki-pool → 真 wiki_server.js 子进程 round trip（WIKI_DATA_DIR 指向
//      临时目录）：空库建骨架目录 → add_card → list_cards → render_md(card)。
//      这是 config.js WIKI_DATA_DIR 覆盖 + ensureDir 骨架的全真验证。

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSignalGate } from '../../src/signals/gate.js'
import type { SignalGateHandlers } from '../../src/signals/types.js'
import { createWikiPool } from '../../src/host/wiki-pool.js'
import type { McpConnection } from '../../src/mcp/index.js'

const makeHandlers = (optional: Partial<SignalGateHandlers> = {}): SignalGateHandlers => ({
  runPrompt: vi.fn(async () => {
    throw new Error('runPrompt: not implemented in tests')
  }),
  session: {
    create: vi.fn(async () => {
      throw new Error('create: not implemented in tests')
    }),
    open: vi.fn(async () => {
      throw new Error('open: not implemented in tests')
    }),
    list: vi.fn(async () => []),
    close: vi.fn(async (_id: string) => {}),
    delete: vi.fn(async (_id: string) => {}),
    history: vi.fn(async (_id: string) => [] as const),
  },
  cancel: vi.fn((_sessionId: string) => {}),
  setFullPermission: vi.fn((_sessionId: string, _enabled: boolean) => {}),
  ...optional,
})

describe('SignalGate wiki.* commands', () => {
  it('routes to handlers.wiki with args passed through', async () => {
    const wiki = {
      listCards: vi.fn(async () => ({ cards: [] })),
      addCard: vi.fn(async () => ({ id: 'user-x' })),
      renderCard: vi.fn(async () => ({ cardId: 'user-x', title: 'T', html: '<p>x</p>' })),
      generate: vi.fn(async () => {}),
    }
    const gate = createSignalGate({ handlers: makeHandlers({ wiki }) })

    const card = { type: 'concept', title: 'T', summary: 'S', content: 'C', tags: ['probe'] }
    await gate.command({ kind: 'wiki.listCards' })
    await gate.command({ kind: 'wiki.addCard', card })
    await gate.command({ kind: 'wiki.renderCard', cardId: 'user-x' })
    await gate.command({ kind: 'wiki.generate', workDir: 'D:\\ws' })

    expect(wiki.addCard).toHaveBeenCalledWith(card)
    expect(wiki.renderCard).toHaveBeenCalledWith('user-x')
    expect(await gate.command({ kind: 'wiki.listCards' })).toEqual({ cards: [] })
  })

  it('throws a clean error when the wiki handler is absent', async () => {
    const gate = createSignalGate({ handlers: makeHandlers() })
    await expect(gate.command({ kind: 'wiki.listCards' })).rejects.toThrow(
      /requires a wiki handler/,
    )
  })
})

describe('wiki-pool → real wiki_server.js round trip (global single store)', () => {
  let dataDir: string
  let pool: ReturnType<typeof createWikiPool>
  let conn: McpConnection

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'wiki-pool-'))
    process.env.WIKI_DATA_DIR = dataDir
    pool = createWikiPool()
    conn = await pool.connection()
  }, 30_000)

  afterAll(async () => {
    await pool?.close()
    delete process.env.WIKI_DATA_DIR
    rmSync(dataDir, { recursive: true, force: true })
    // render_md 会往仓库 visualizer/exports 写单卡快照（v0.13.1 约定目录，
    // 内置 fixture 也在此）——测试只清自己生成的卡片文件。
    rmSync(join(process.cwd(), 'src/mcp-servers/wiki-mcp/visualizer/exports/card-user-probe1.md'), { force: true })
  })

  it('add_card on an empty store succeeds (skeleton dirs auto-created)', async () => {
    const raw = await conn.callTool('add_card', {
      card: {
        id: 'user-probe1',
        type: 'concept',
        title: '探针卡片',
        summary: '全局单库 round trip',
        content: '# 内容\n\n正文',
        tags: ['workspace:probe'],
      },
    })
    expect(JSON.parse(raw)).toMatchObject({ success: true })
  })

  it('list_cards returns the created card', async () => {
    const raw = await conn.callTool('list_cards', {})
    const parsed = JSON.parse(raw) as { count: number; results: Array<{ id: string }> }
    expect(parsed.results.map((c) => c.id)).toContain('user-probe1')
  })

  it('render_md(card) returns full markdown containing the title', async () => {
    const raw = await conn.callTool('render_md', { mode: 'card', card_id: 'user-probe1' })
    const parsed = JSON.parse(raw) as { success: boolean; markdown: string }
    expect(parsed.success).toBe(true)
    expect(parsed.markdown).toContain('探针卡片')
  })

  it('pool.connection() is a singleton; close() tears it down', async () => {
    const again = await pool.connection()
    expect(again).toBe(conn)
    await pool.close()
    await expect(conn.callTool('list_cards', {})).rejects.toThrow(/closed/)
  })
})
