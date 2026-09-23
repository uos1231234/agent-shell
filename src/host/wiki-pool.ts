// 宿主级 wiki 连接池——全局单库懒启动单例（用户拍板 2026-09-10）。
//
// wiki 数据不按工作区分库：知识卡片描述仓库必然失真，它的价值是给人直观
// 感受，项目工程管控仍走提示词注入的文档管理（AGENTS.md/MEMORY.md）。因此
// 整个宿主一个 wiki-mcp 子进程，数据落 ~/.databus/wiki/（WIKI_DATA_DIR 可
// 覆盖——测试/演示用，与 mcp.json/providers.json 的 env 覆盖模式一致）。
//
// 与 v0.25 MCP 连接池的关系：那个池子是 per-session registry 的 LLM 工具
// 来源（mcp.json 用户配置）；本池是宿主自有资产，只服务 gate 的 wiki.*
// 命令（前端知识卡片面板），不进任何会话的 registry——LLM 不因此多出
// wiki__ 工具，系统提示词工具清单不变。

import { homedir } from 'node:os'
import { join } from 'node:path'

import { createWikiMcpConnection } from '../mcp-servers/wiki-mcp/connection-adapter.js'
import type { McpConnection } from '../mcp/index.js'

/** 全局单库数据目录。WIKI_DATA_DIR 显式覆盖（测试/演示隔离用）。 */
export const wikiDataDir = (): string =>
  process.env.WIKI_DATA_DIR ?? join(homedir(), '.databus', 'wiki')

export type WikiPool = {
  /** 懒启动单例连接；首次调用做 initialize + tools/list 握手（fail-fast）。 */
  connection(): Promise<McpConnection>
  /** 宿主 shutdown 时关闭子进程。 */
  close(): Promise<void>
}

export const createWikiPool = (): WikiPool => {
  let conn: McpConnection | undefined
  let opening: Promise<McpConnection> | undefined

  return {
    async connection() {
      if (conn !== undefined) return conn
      opening ??= (async () => {
        const c = createWikiMcpConnection({ env: { WIKI_DATA_DIR: wikiDataDir() } })
        // 握手：初始化 + 拉工具清单——子进程起不来/协议坏在这里就炸，不留半死连接。
        await c.listTools()
        conn = c
        return c
      })()
      try {
        return await opening
      } catch (e) {
        opening = undefined
        throw e
      }
    },
    async close() {
      if (conn === undefined) return
      const c = conn
      conn = undefined
      opening = undefined
      await c.close()
    },
  }
}
