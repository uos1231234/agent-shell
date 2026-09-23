// 宿主级 wiki 知识库生成任务（用户拍板 2026-09-10）：用户选择一个现有工作区，
// wiki agent 阅读工作区的文档与代码后自动生成知识卡片（全局单库，工作区是
// 卡片上的 workspace 标签）。
//
// 组装：临时 registry（createBuiltinTools cwd=workDir——read/grep/ls/find 等
// 文件工具锚定在用户工作区）+ wiki-pool 单例连接（经 createWikiAgent 注册成
// wiki__* 工具 + isWikiAgent guard）。任务指令走首条 user 消息——WIKI_AGENT_
// PROMPT 是"知识库管理员"的角色提示词，保持原样不掺任务细节。
//
// 连接所有权：createWikiAgent 会把注入连接的 close() 纳入自己的生命周期
// （stop/closeConnection 都会关连接），而这里的连接是 wiki-pool 的宿主级
// 单例——用 close 无操作的代理包一层，所有权始终留在 pool。
//
// 互斥：wiki server 单进程单库，并发 add_card 有 per-type JSON 文件的写竞态
// ——同一时刻只允许一个生成任务，第二个请求抛干净错误。

import { basename } from 'node:path'

import { createBuiltinTools } from '../im/tools/index.js'
import { createNoopStateLine } from '../im/state-line/index.js'
import { Mailbox } from '../im/mailbox/index.js'
import { createWikiAgent } from '../im/system-agents/wiki-agent.js'
import type { McpConnection } from '../mcp/index.js'
import type { WikiGenerateStatus } from '../signals/index.js'
import type { WikiPool } from './wiki-pool.js'
import type { HostStreamChat } from './assembly.js'

export type { WikiGenerateStatus }

export type WikiGenerateManager = {
  /** 当前运行中任务的工作区；无任务时 undefined。 */
  runningWorkDir(): string | undefined
  /** 启动生成任务（异步跑，状态经 onStatus 回调）。互斥：已有任务抛干净错误。 */
  start(workDir: string): void
  /** 宿主 shutdown 时停止在跑任务（连接由 pool 关闭，这里只停 loop）。 */
  shutdown(): void
}

/** 卡片计数：任务前后 list_cards 差值 = 本次新增卡数。 */
const countCards = async (conn: McpConnection): Promise<number> => {
  const raw = await conn.callTool('list_cards', {})
  const parsed = JSON.parse(raw) as { count: number }
  return parsed.count
}

export const createWikiGenerateManager = (deps: {
  pool: WikiPool
  /** 每次启动现解析（热切换语义：providers.json 是磁盘事实源）。 */
  resolveLlm: () => { url: string; model: string; streamChat: HostStreamChat; strictAlternation: boolean }
  onStatus: (status: WikiGenerateStatus) => void
  /** 任务新增卡片后回调（宿主借此广播 wiki.changed）。 */
  onChanged: () => void
}): WikiGenerateManager => {
  let running: { workDir: string; stop: () => void } | undefined

  const taskText = (workDir: string): string => {
    const tag = `workspace:${basename(workDir)}`
    return [
      `为工作区 ${workDir} 生成知识卡片知识库：`,
      '1. 先用 ls / grep / read 工具浏览该工作区的文档（README、AGENTS.md、ARCHITECTURE.md 等）与核心代码，理解架构与关键模块。',
      '2. 把值得沉淀的知识整理成知识卡片——每张卡一个概念（module/interface/function/class/pattern/concept 六类），用 wiki__add_card 写入；每张卡的 tags 必须包含 `' + tag + '`。',
      '3. 卡片之间存在明确关系（派生/调用/从属等）时，用 wiki__update_relations 建立关联。',
      '4. 全部写完后用 wiki__render_md（mode:"snapshot"）渲染全库快照作为收尾。',
    ].join('\n')
  }

  return {
    runningWorkDir: () => running?.workDir,
    start: (workDir: string) => {
      if (running !== undefined) {
        throw new Error(
          `A wiki generation task is already running for "${running.workDir}" — wait for it to finish`,
        )
      }
      // 互斥标志在同步路径上先占位（异步 setup 窗口期两次 start 都过检查的
      // 竞态）；setup 完成后替换为真 stop，失败路径在 catch 里兜底清理。
      const task: { workDir: string; stop: () => void } = { workDir, stop: () => undefined }
      running = task
      void (async () => {
        let agent: Awaited<ReturnType<typeof createWikiAgent>> | undefined
        let conn: McpConnection | undefined
        let before = 0
        try {
          const { url, model, streamChat, strictAlternation } = deps.resolveLlm()
          const registry = createBuiltinTools({ cwd: workDir })
          conn = await deps.pool.connection()
          // close 无操作代理：createWikiAgent 视注入连接为己有（stop 即关），
          // 但连接归 wiki-pool 所有——池是唯一 close 点。
          const borrowed: McpConnection = { ...conn, close: async () => undefined }
          agent = await createWikiAgent({
            registry,
            stateLine: createNoopStateLine(),
            llmStreamChat: streamChat,
            url,
            model,
            mailbox: new Mailbox(),
            connection: borrowed,
            // v0.41 D19 覆盖面扩展：wiki agent 经 createSystemAgent 构造，请求
            // 尾部带一条空 user 消息，严格交替 provider 会 400。
            ...(strictAlternation ? { strictAlternation: true } : {}),
          })
          task.stop = () => agent?.stop()
          deps.onStatus({ status: 'started', workDir })

          try {
            before = await countCards(conn)
          } catch {
            before = 0
          }
          await agent.run({ messages: [{ role: 'user', content: taskText(workDir) }] })
          let after = before
          try {
            after = await countCards(conn)
          } catch {
            after = before
          }
          deps.onStatus({ status: 'completed', workDir, cardsCreated: Math.max(0, after - before) })
          deps.onChanged()
        } catch (e) {
          deps.onStatus({
            status: 'failed',
            workDir,
            error: e instanceof Error ? e.message : String(e),
          })
        } finally {
          if (running === task) running = undefined
          // 渲染 rule 注销 + 连接代理（close 为 no-op，池连接不受影响）。
          if (agent !== undefined) await agent.closeConnection()
        }
      })()
    },
    shutdown: () => {
      running?.stop()
      running = undefined
    },
  }
}
