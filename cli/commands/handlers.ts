// v0.26 Wave 4 — /命令执行器（计划 §3.3 分发 switch + §5 命令表契约链）。
//
// 纪律（计划 §4.4）：命令文本永不进模型历史；有会话副作用的命令**只**通过
// 既有 GateCommand 产生副作用——本文件对 src/** 仅 import type，对
// ~/.databus 文件零直接读取（宿主在 gate 另一侧完成），唯一的运行时 I/O
// 是 /export 的 node:fs 直写（计划拍板③：KimiCode 同款，用户命令=用户权威，
// 不过门不设界）。
//
// 错误路径：任何 gate.command 拒绝（含 "the host does not provide …"）都被
// executeCommand 的顶层 catch 收敛为一条状态行，绝不向 loop/调用方抛出。
// 会话视图操作（hydrate/setActive/settle）走 cli/session-view 的纯函数
// ——视图层投影，不绕过 gate 产生任何新的 harness 副作用。

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { createRequire } from 'node:module'

import type {
  SignalGate,
  GateCommand,
  ExtensionsInfo,
  SessionUndoResult,
} from '../../src/signals/types.js'
import type { SessionInfo, SessionHandle } from '../../src/im/session/types.js'
import type { ConversationTurn } from '../../src/im/conversation-memory.js'
import type { McpListResult } from '../../src/mcp/write.js'
import type { DatabusSettings } from '../../src/config/databus-settings.js'
import type { ProviderListResult } from '../../src/config/types.js'
// v0.41 goal 模式：goal.get 的回执形状。
import type { GoalState } from '../../src/im/goal/types.js'
import type { WorkflowState } from '../../src/host/workflow/types.js'
import type { BaselineRunResult } from '../../src/host/workflow/scout.js'
import type { LineEditor } from '../editor.js'
import type { InputRouter } from '../input-state.js'
import type { PendingRequest, SessionShard, SessionView } from '../session-view.js'
import { hydrateHistory, setActiveSession, settleRequest } from '../session-view.js'
import { copyToClipboard } from './clipboard.js'
import { buildHelpLines } from './dispatch.js'
import type { BuiltinCommandName } from './registry.js'

// ============================================================================
// 上下文 + 执行入口
// ============================================================================

/** app（Wave 5）注入的执行环境——全部副作用都经这里发生。 */
export type CommandContext = {
  /** 会话视图（session-view reducer 的实例；handlers 只做投影操作）。 */
  view: SessionView
  /** 信号关——唯一 harness 通道。 */
  gate: SignalGate
  /** 当前活跃会话（app 维护；与 view.activeSessionId 同步）。 */
  sessionId: string | undefined
  /** 当前工作区（权限边界；session.create / export 默认路径 / resume 校验）。 */
  workDir: string
  /** 行编辑器（app 持有；blocked 还原由 app 在 resolve 出 blocked 意图后做）。 */
  editor: LineEditor
  /** 输入态机路由（浮层挂载/退出归 app；handlers 不切态）。 */
  router: InputRouter
  /** /quit 的落点（app 决定如何退出）。 */
  quit: () => void
  /** 状态行输出（app 决定渲染到哪：状态栏 / 消息区）。 */
  renderStatus(lines: string[]): void
  /**
   * /copy 的剪贴板出口（Wave A）。缺省用平台实现（clipboard.ts：win32 clip /
   * darwin pbcopy / linux xclip→wl-copy）；测试注入 stub，不真碰系统剪贴板。
   */
  copyToClipboard?: (text: string) => Promise<void>
}

/**
 * 执行一条内置命令。永不 throw——gate 拒绝 / 回执形状不符都收敛为一条
 * 状态行（`/cmd 失败: …`），调用方（app 分发循环）可以裸 await。
 */
export const executeCommand = async (
  name: BuiltinCommandName,
  args: string,
  ctx: CommandContext,
): Promise<void> => {
  try {
    switch (name) {
      case 'help':
        ctx.renderStatus(buildHelpLines())
        return

      case 'new': {
        // session.create 回执是 SessionHandle（id 在 .info.id）——Wave 5 修正：
        // 此前 cast 成 {id} 读 created.id 得 undefined，/new 从未真正建立活跃会话。
        const created = await command<SessionHandle>(ctx, {
          kind: 'session.create',
          payload: { workDir: ctx.workDir },
        })
        hydrateHistory(ctx.view, created.info.id, [])
        setActiveSession(ctx.view, created.info.id)
        ctx.renderStatus([`已创建新会话 ${created.info.id}`])
        return
      }

      case 'sessions': {
        const infos = await command<readonly SessionInfo[]>(ctx, { kind: 'session.list' })
        if (infos.length === 0) {
          ctx.renderStatus(['（暂无历史会话）'])
          return
        }
        ctx.renderStatus([
          '历史会话（* = 当前工作区；/resume [会话ID] 恢复）：',
          ...infos.map((s) => {
            const here = s.workDir !== undefined && sameWorkDir(s.workDir, ctx.workDir)
            const dir = s.workDir ?? '（未指定工作区）'
            return `${here ? '*' : ' '} ${s.id}  ${s.title}  回合 ${s.turnCount}  ${dir}`
          }),
        ])
        return
      }

      case 'resume': {
        const infos = await command<readonly SessionInfo[]>(ctx, { kind: 'session.list' })
        const argId = args.trim()
        const target =
          argId === ''
            ? newestForWorkDir(infos, ctx.workDir)
            : infos.find((s) => s.id === argId)
        if (target === undefined) {
          ctx.renderStatus([argId === '' ? '当前工作区没有可恢复的会话' : `找不到会话 ${argId}`])
          return
        }
        // ✅G5：workDir 校验——不符拒绝并提示 cd（KimiCode 同款）。
        if (target.workDir === undefined || !sameWorkDir(target.workDir, ctx.workDir)) {
          ctx.renderStatus([
            `会话 ${target.id} 属于工作区 ${target.workDir ?? '（未指定）'} — cd <dir> 后再恢复`,
          ])
          return
        }
        await openAndHydrate(ctx, target.id)
        ctx.renderStatus([`已恢复会话 ${target.id}（${target.title}，回合 ${target.turnCount}）`])
        return
      }

      case 'title': {
        if (ctx.sessionId === undefined) {
          ctx.renderStatus(['没有活跃会话'])
          return
        }
        const next = args.trim()
        if (next === '') {
          // 无参 = 查看当前标题（清单以磁盘 session.json 为事实源）。
          const infos = await command<readonly SessionInfo[]>(ctx, { kind: 'session.list' })
          const current = infos.find((s) => s.id === ctx.sessionId)
          ctx.renderStatus([`当前会话标题: ${current?.title ?? '（未知）'}（/title <新标题> 修改）`])
          return
        }
        // ≤200 校验在宿主（assembly）执行——超限的干净错误经顶层 catch 成状态行。
        await command(ctx, { kind: 'session.rename', sessionId: ctx.sessionId, title: next })
        ctx.renderStatus([`已改名: ${next}`])
        return
      }

      case 'status': {
        const shard = currentShard(ctx)
        if (shard === undefined) {
          ctx.renderStatus(['没有活跃会话 — /new 创建或 /resume 恢复'])
          return
        }
        const s = shard.stats
        ctx.renderStatus([
          `会话: ${shard.sessionId}`,
          `状态: ${shard.phase === 'streaming' ? 'streaming（回合进行中）' : 'idle'}`,
          `回合完成 ${s.turnEnds} · LLM 往返 ${s.loopTurns} · 工具调用 ${s.toolCalls}`,
          `tokens ${s.totalTokens} · 累计耗时 ${(s.elapsedMs / 1000).toFixed(1)}s`,
          `权限: ${shard.permissionFull ? '完全权限' : '审批模式'}`,
          ...(s.lastReason !== undefined ? [`上次终止: ${s.lastReason}`] : []),
        ])
        return
      }

      case 'usage': {
        const shard = currentShard(ctx)
        if (shard === undefined) {
          ctx.renderStatus(['没有活跃会话'])
          return
        }
        const s = shard.stats
        ctx.renderStatus([
          `tokens（turn.end 累积）: ${s.totalTokens}`,
          `LLM 往返 ${s.loopTurns} · 工具调用 ${s.toolCalls} · 回合完成 ${s.turnEnds} · 累计耗时 ${(s.elapsedMs / 1000).toFixed(1)}s`,
        ])
        return
      }

      case 'approve': {
        const found = currentApproval(ctx)
        if (found === undefined) {
          ctx.renderStatus(['没有待审批的请求'])
          return
        }
        const decision = decideApproval(args)
        if (decision === undefined) {
          ctx.renderStatus(['用法: /approve y|n（y=批准 n=拒绝；浮层态直接按 y/n/Esc）'])
          return
        }
        await command(ctx, {
          kind: 'approval.decision',
          requestId: found.request.requestId,
          decision,
        })
        settleRequest(ctx.view, found.shard.sessionId, found.request.requestId)
        ctx.renderStatus([
          `已${decision === 'approved' ? '批准' : '拒绝'} ${found.request.payload.toolName} 的审批`,
        ])
        return
      }

      case 'cancel': {
        if (ctx.sessionId === undefined) {
          ctx.renderStatus(['没有活跃会话'])
          return
        }
        await command(ctx, { kind: 'turn.cancel', sessionId: ctx.sessionId })
        ctx.renderStatus(['已请求取消在途回合'])
        return
      }

      case 'permission': {
        const shard = currentShard(ctx)
        if (shard === undefined) {
          ctx.renderStatus(['没有活跃会话'])
          return
        }
        const arg = args.trim().toLowerCase()
        const enabled = arg === 'on' ? true : arg === 'off' ? false : !shard.permissionFull
        await command(ctx, { kind: 'permission.full', sessionId: shard.sessionId, enabled })
        ctx.renderStatus([
          `已请求${enabled ? '开启完全权限' : '回到审批模式'}（会话 ${shard.sessionId}）`,
        ])
        return
      }

      case 'mcp': {
        const r = await command<McpListResult>(ctx, { kind: 'mcp.list' })
        const lines = [
          `MCP 配置${r.exists ? '' : '（文件尚不存在）'}: ${r.configPath}`,
          ...(r.servers.length === 0
            ? ['（未配置服务器）']
            : r.servers.map((s) => `· ${s.name}（${s.transport}）`)),
        ]
        ctx.renderStatus(lines)
        return
      }

      case 'skills': {
        const info = await command<ExtensionsInfo>(ctx, { kind: 'extensions.info' })
        ctx.renderStatus([
          `模块技能 (${info.skills.length}): ${info.skills.join(', ') || '（无）'}`,
          `文本技能 (${info.textSkills.length}): ${info.textSkills.join(', ') || '（无）'}`,
          `MCP 服务器 (${info.servers.length}): ${info.servers.join(', ') || '（无）'}`,
          ...(info.skillsDir !== undefined ? [`技能目录: ${info.skillsDir}`] : []),
          ...(info.textSkillsDir !== undefined ? [`文本技能目录: ${info.textSkillsDir}`] : []),
        ])
        return
      }

      case 'subagent': {
        const arg = args.trim().toLowerCase()
        if (arg === '' || arg === 'status') {
          const s = await command<DatabusSettings>(ctx, { kind: 'settings.get' })
          ctx.renderStatus([
            `子代理向下开关: ${s.subAgentNesting === true ? '开启' : '关闭'}`,
          ])
          return
        }
        if (arg !== 'on' && arg !== 'off') {
          ctx.renderStatus(['用法: /subagent [on|off|status]'])
          return
        }
        await command(ctx, { kind: 'settings.set', patch: { subAgentNesting: arg === 'on' } })
        ctx.renderStatus([
          `子代理向下开关已${arg === 'on' ? '开启' : '关闭'} — 新会话生效，运行中会话不变`,
        ])
        return
      }

      case 'provider': {
        await runProviderCommand(ctx, args)
        return
      }

      // v0.41 goal 模式：会话级停止条件。设置后每次轮次本应以 completed 结束时
      // 先由独立 judge 裁决；未达成则追加续跑提醒接着跑（上限 maxRounds 次分歧
      // 循环，计的不是 LLM 轮数）。
      case 'goal': {
        const shard = currentShard(ctx)
        if (shard === undefined) {
          ctx.renderStatus(['没有活跃会话'])
          return
        }
        const arg = args.trim()
        const lower = arg.toLowerCase()

        if (arg === '' || lower === 'status') {
          const g = await command<GoalState | undefined>(ctx, { kind: 'goal.get', sessionId: shard.sessionId })
          if (g === undefined) {
            ctx.renderStatus([
              'goal 模式：未设置目标',
              '用法: /goal <目标条件> | off | status',
            ])
            return
          }
          ctx.renderStatus([
            `goal 模式：第 ${g.roundsUsed}/${g.maxRounds} 轮（计的是"judge 说没达成"的分歧循环数，不是 LLM 轮数）`,
            `目标: ${g.condition}`,
            ...(g.lastVerdict !== undefined
              ? [`最近裁决: ${g.lastVerdict.verdict} — ${g.lastVerdict.reason}`]
              : []),
          ])
          return
        }

        if (lower === 'off') {
          await command(ctx, { kind: 'goal.clear', sessionId: shard.sessionId })
          ctx.renderStatus(['goal 模式已关闭 — 后续回合按普通对话收尾'])
          return
        }

        await command(ctx, { kind: 'goal.set', sessionId: shard.sessionId, condition: arg })
        // 回读而不是在 CLI 里复制 DEFAULT_GOAL_MAX_ROUNDS：阈值事实源只有一处
        // （src/im/goal/types.ts），宿主决定实际生效值。
        const set = await command<GoalState | undefined>(ctx, { kind: 'goal.get', sessionId: shard.sessionId })
        ctx.renderStatus([
          `goal 模式已设置${set !== undefined ? `（上限 ${set.maxRounds} 轮）` : ''}`,
          `目标: ${arg}`,
          '下一条消息起生效：每轮收尾由独立 judge 裁决，未达成会自动续跑',
        ])
        return
      }

      case 'workflow': {
        const shard = currentShard(ctx)
        if (shard === undefined) {
          ctx.renderStatus(['没有活跃会话'])
          return
        }
        const arg = args.trim().toLowerCase()
        if (arg === '' || arg === 'status') {
          const state = await command<WorkflowState>(ctx, { kind: 'workflow.status', sessionId: shard.sessionId })
          ctx.renderStatus(formatWorkflowStatus(state))
          return
        }
        if (arg === 'on' || arg === 'enable') {
          const state = await command<WorkflowState>(ctx, { kind: 'workflow.enable', sessionId: shard.sessionId })
          ctx.renderStatus([`长程工作流已开启（${state.sessionId}）`, ...formatWorkflowStatus(state)])
          return
        }
        if (arg === 'off' || arg === 'disable') {
          const state = await command<WorkflowState>(ctx, { kind: 'workflow.disable', sessionId: shard.sessionId })
          ctx.renderStatus([`长程工作流已关闭（${state.sessionId}）`])
          return
        }
        if (arg === 'baseline') {
          const result = await command<BaselineRunResult>(ctx, { kind: 'workflow.baseline', sessionId: shard.sessionId })
          ctx.renderStatus([
            `基线 scout 已完成：${result.completedRoles.length}/${result.completedRoles.length + result.failedRoles.length}`,
            ...(result.failedRoles.length > 0 ? [`失败角色: ${result.failedRoles.join(', ')}`] : []),
          ])
          return
        }
        ctx.renderStatus(['用法: /workflow [on|off|status|baseline]'])
        return
      }

      // v0.42 大输入切块：手动开启的会话，超长单条输入被切成多卷（各卷独立 user
      // 回合）排队串行——避免 1M 数据一股脑上 wire。门控阈值事实源在
      // src/signals/chunk.ts（DEFAULT_CHUNK_TOKENS=40K），此处只读回执。
      case 'chunk': {
        const shard = currentShard(ctx)
        if (shard === undefined) {
          ctx.renderStatus(['没有活跃会话'])
          return
        }
        const arg = args.trim().toLowerCase()

        if (arg === '' || arg === 'status') {
          const r = await command<{ enabled: boolean; chunkTokens?: number }>(ctx, {
            kind: 'chunk.get',
            sessionId: shard.sessionId,
          })
          ctx.renderStatus([
            `大输入切块: ${r.enabled ? `开启（每卷 ${r.chunkTokens ?? 40_000} 字符）` : '关闭'}`,
            '用法: /chunk [on|off|status]',
          ])
          return
        }
        if (arg !== 'on' && arg !== 'off') {
          ctx.renderStatus(['用法: /chunk [on|off|status]'])
          return
        }
        await command(ctx, { kind: 'chunk.set', sessionId: shard.sessionId, enabled: arg === 'on' })
        ctx.renderStatus([
          arg === 'on'
            ? `大输入切块已开启 — 超长输入将切成 40K 一卷排队处理（会话 ${shard.sessionId}）`
            : `大输入切块已关闭 — 输入将原样发送（会话 ${shard.sessionId}）`,
        ])
        return
      }

      case 'model': {
        await runModelCommand(ctx, args)
        return
      }

      case 'effort': {
        await runEffortCommand(ctx, args)
        return
      }

      case 'workspace':
        ctx.renderStatus([ctx.workDir])
        return

      case 'copy': {
        if (ctx.sessionId === undefined) {
          ctx.renderStatus(['没有活跃会话'])
          return
        }
        const turns = await command<readonly ConversationTurn[]>(ctx, {
          kind: 'session.history',
          sessionId: ctx.sessionId,
        })
        const text = extractLastAssistantText(turns)
        if (text === null) {
          ctx.renderStatus(['没有可复制的回复'])
          return
        }
        await (ctx.copyToClipboard ?? copyToClipboard)(text)
        ctx.renderStatus([`已复制最后回复（${[...text].length} 字符）`])
        return
      }

      case 'version':
        ctx.renderStatus(buildVersionLines(cliVersion(), process.version))
        return

      case 'fork': {
        // 回执是新会话的 SessionInfo（fork 不切换活跃会话——对标 KimiCode）。
        if (ctx.sessionId === undefined) {
          ctx.renderStatus(['没有活跃会话'])
          return
        }
        const forked = await command<SessionInfo>(ctx, { kind: 'session.fork', sessionId: ctx.sessionId })
        ctx.renderStatus([`/fork → 新会话 ${forked.id}（/resume 可切）`])
        return
      }

      case 'undo': {
        if (ctx.sessionId === undefined) {
          ctx.renderStatus(['没有活跃会话'])
          return
        }
        // 块数校验给友好用法行（1≤N≤10）；宿主 handler 是最终校验点。
        const arg = args.trim()
        let blocks = 1
        if (arg !== '') {
          const parsed = Number(arg)
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
            ctx.renderStatus(['用法: /undo [N]（撤回最近 N 个任务块，1≤N≤10，缺省 1）'])
            return
          }
          blocks = parsed
        }
        const r = await command<SessionUndoResult>(ctx, {
          kind: 'session.undo',
          sessionId: ctx.sessionId,
          blocks,
        })
        // 视图对齐：撤回改写了 canonical——拉一次 history 整体重投影（与
        // /resume 同一条渲染路径，零新 harness 副作用）。stats 是回合累计
        // 用量（撤回不改变已发生的消耗），跨投影保留。
        const statsBefore = ctx.view.shards.get(ctx.sessionId)?.stats
        const turns = await command<readonly ConversationTurn[]>(ctx, {
          kind: 'session.history',
          sessionId: ctx.sessionId,
        })
        hydrateHistory(ctx.view, ctx.sessionId, turns)
        const shardAfter = ctx.view.shards.get(ctx.sessionId)
        if (statsBefore !== undefined && shardAfter !== undefined) shardAfter.stats = statsBefore
        ctx.renderStatus([`/undo → 已撤回最近 ${r.blocks} 个任务块（驱逐 ${r.evicted} 条）`])
        return
      }

      case 'export': {
        if (ctx.sessionId === undefined) {
          ctx.renderStatus(['没有活跃会话'])
          return
        }
        const turns = await command<readonly ConversationTurn[]>(ctx, {
          kind: 'session.history',
          sessionId: ctx.sessionId,
        })
        const md = buildExportMarkdown(ctx.sessionId, ctx.workDir, turns)
        const arg = args.trim()
        // 拍板③：显式路径 resolve 完全信任（相对 cwd），无包含性检查。
        const target = arg === '' ? defaultExportPath(ctx.workDir, ctx.sessionId) : pathResolve(arg)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, md, 'utf8')
        ctx.renderStatus([`已导出: ${target}`])
        return
      }

      case 'quit':
        ctx.quit()
        return

      default: {
        const _exhaustive: never = name
        return _exhaustive
      }
    }
  } catch (cause) {
    ctx.renderStatus([`/${name} 失败: ${errorMessage(cause)}`])
  }
}

// ============================================================================
// /provider /model — 模型服务商管理（Wave B1，对标 KimiCode /provider /model）
// ============================================================================

/**
 * key=value 参数解析（/provider add 的脚本化友好形式）：空格分隔、可任意
 * 顺序；值含 `=` 时取第一个 `=` 之后的全部（key 值 base64 尾填常见）。
 * 无 `=` 或空 key 的 token 忽略——宿主侧必填校验兜底缺参。
 */
export const parseKeyValueArgs = (tokens: readonly string[]): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const tok of tokens) {
    const eq = tok.indexOf('=')
    if (eq <= 0) continue
    out[tok.slice(0, eq)!] = tok.slice(eq + 1)
  }
  return out
}

/** API key 掩码（列表/回执不回显明文）。 */
export const maskKey = (key: string): string =>
  key.length <= 8 ? '****' : `${key.slice(0, 4)}…${key.slice(-4)}`

/** baseUrl 的 host 部分（解析失败原样返回，不造错误路径）。 */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const PROVIDER_USAGE =
  '用法: /provider [list | use <服务商名> | add name=<名> baseUrl=<URL> key=<APIKEY> model=<模型> | remove <服务商名>]'

/** /provider 子命令分发（list/use/add/remove）。错误路径由 executeCommand 顶层收敛。 */
const runProviderCommand = async (ctx: CommandContext, args: string): Promise<void> => {
  const argv = args.trim().split(/\s+/).filter((t) => t !== '')
  const sub = (argv[0] ?? 'list').toLowerCase()

  if (sub === 'list') {
    const r = await command<ProviderListResult>(ctx, { kind: 'provider.list' })
    ctx.renderStatus(buildProviderLines(r))
    return
  }

  if (sub === 'use') {
    const name = argv[1]
    if (name === undefined) {
      ctx.renderStatus(['用法: /provider use <服务商名>'])
      return
    }
    await command(ctx, { kind: 'provider.activate', name })
    ctx.renderStatus([`已切换服务商: ${name} — 全局生效，下一轮对话即使用新服务商`])
    return
  }

  if (sub === 'add') {
    // 对 KimiCode TabbedModelSelector 对话框的务实降级：v1 用 key=value 行内
    // 参数（脚本化友好），不做 TUI 多字段表单。
    const kv = parseKeyValueArgs(argv.slice(1))
    const name = kv['name']
    const baseUrl = kv['baseUrl']
    const model = kv['model']
    if (name === undefined || baseUrl === undefined || model === undefined) {
      ctx.renderStatus(['用法: /provider add name=<名> baseUrl=<URL> key=<APIKEY> model=<模型>（key 可省略=回落环境变量）'])
      return
    }
    const apiKey = kv['key']
    await command(ctx, {
      kind: 'provider.upsert',
      name,
      provider: {
        url: baseUrl,
        model,
        ...(apiKey !== undefined ? { apiKey } : {}),
      },
    })
    ctx.renderStatus([
      `已保存服务商 ${name}（${hostOf(baseUrl)} · ${model}）— 全局生效，下一轮对话即使用`,
    ])
    return
  }

  if (sub === 'remove') {
    const name = argv[1]
    if (name === undefined) {
      ctx.renderStatus(['用法: /provider remove <服务商名>'])
      return
    }
    // 注：删除 active 服务商被配置层拒绝（fail-fast 不变式——先 use 另一个再删），
    // 错误消息经顶层 catch 成状态行，不做"回落 env"的静默语义。
    await command(ctx, { kind: 'provider.delete', name })
    ctx.renderStatus([`已删除服务商 ${name}`])
    return
  }

  ctx.renderStatus([PROVIDER_USAGE])
}

/** /provider（无参）的列表投影：active 标记 / host / model / key 掩码 / 信任标记。 */
export const buildProviderLines = (r: ProviderListResult): string[] => {
  const lines = [`providers.json${r.exists ? '' : '（尚不存在）'}: ${r.configPath}`]
  const entries = Object.entries(r.providers)
  if (entries.length === 0) {
    lines.push('（未配置服务商 — /provider add name= baseUrl= key= model=）')
    return lines
  }
  for (const [name, p] of entries) {
    lines.push(
      `${name === r.active ? '*' : ' '} ${name}  ${hostOf(p.url)}  ${p.model}` +
        (p.apiKey !== undefined ? `  key ${maskKey(p.apiKey)}` : '  key（env 回落）') +
        (p.upstreamTrusted === false ? '  上游不可信' : ''),
    )
  }
  lines.push('全局生效：/provider use <名> 切换后，下一轮对话即使用新服务商')
  return lines
}

/**
 * /model — 当前服务商内的模型切换（v0.32 多模型目录）。无参 = 列出目录与
 * 当前选中；带参 = provider.select {model}（切模型清档位、跟随新模型默认，
 * dsh choose 语义）。服务商切换回归 /provider use（不再等价）。
 */
const runModelCommand = async (ctx: CommandContext, args: string): Promise<void> => {
  const arg = args.trim()
  const r = await command<ProviderListResult>(ctx, { kind: 'provider.list' })
  const activeName = r.active ?? (r.exists ? Object.keys(r.providers)[0] : undefined)
  const active = activeName !== undefined ? r.providers[activeName] : undefined
  const catalog = r.catalog ?? []

  if (arg !== '') {
    if (activeName === undefined) {
      ctx.renderStatus(['没有 active 服务商——先 /provider add 或 /provider use'])
      return
    }
    // 模型 id 可能命中非 active 服务商的目录 → 顺带切换服务商（dsh selectModel
    // 的 {provider, model} 全局选择语义）。
    const owner = catalog.find((e) => e.models.some((m) => m.id === arg))
    await command(ctx, {
      kind: 'provider.select',
      ...(owner !== undefined && owner.name !== activeName ? { provider: owner.name } : {}),
      model: arg,
    })
    ctx.renderStatus(['已切换模型: ' + arg + ' — 下一轮对话生效（思考档位跟随该模型默认）'])
    return
  }

  if (active !== undefined) {
    const entry = catalog.find((e) => e.active)
    const lines = ['当前模型: ' + active.model + '（providers.json: ' + activeName + '）']
    if (entry !== undefined) {
      lines.push('思考档位: ' + (entry.reasoningEffort ?? '跟随默认'))
      const modelIds = entry.models.map((m) => m.id)
      if (modelIds.length > 1) lines.push('可选模型: ' + modelIds.join(', '))
    }
    lines.push('切换: /model <模型 id>　服务商: /provider use <名>　档位: /effort')
    ctx.renderStatus(lines)
    return
  }
  // 无 active provider：loop 将回落 env（CLI 与宿主同进程，env 即共享事实源；
  // 此处只做展示，无 harness 副作用）。--mock 启动时实际为 mock——见横幅。
  const envModel = process.env.ARK_MODEL ?? 'glm-5.3-flash'
  ctx.renderStatus([
    '当前模型: ' + envModel + '（环境变量/默认 — 无 active provider）',
    '配置: /provider add name= baseUrl= key= model= 后 /model <名>',
  ])
}

/**
 * /effort — 思考档位（v0.32，dsh 式单 enum）。无参 = 显示当前档位与可选档；
 * 带参 = provider.select {effort}（写路径校验 ∈ 模型有效档位，未知模型拒绝）。
 */
const runEffortCommand = async (ctx: CommandContext, args: string): Promise<void> => {
  const arg = args.trim().toLowerCase()
  const r = await command<ProviderListResult>(ctx, { kind: 'provider.list' })
  const entry = (r.catalog ?? []).find((e) => e.active)
  if (entry === undefined) {
    ctx.renderStatus(['没有 active 服务商——先 /provider add 或 /provider use'])
    return
  }
  const model = entry.models.find((m) => m.id === entry.selectedModel)
  const tiers = model?.reasoning?.efforts ?? []
  if (arg === '') {
    ctx.renderStatus([
      '思考档位: ' + (entry.reasoningEffort ?? '跟随默认（' + (model?.reasoning?.defaultEffort ?? 'max') + '）') + '（模型 ' + entry.selectedModel + '）',
      tiers.length > 0
        ? '可选: ' + tiers.join(' / ')
        : '该模型未声明思考能力（不发思考字段）——可在 providers.json models[].reasoning 声明',
    ])
    return
  }
  if (!['off', 'low', 'high', 'max'].includes(arg)) {
    ctx.renderStatus(['用法: /effort [off|low|high|max]'])
    return
  }
  await command(ctx, { kind: 'provider.select', effort: arg as 'off' | 'low' | 'high' | 'max' })
  ctx.renderStatus(['思考档位已设为 ' + arg + ' — 下一轮对话生效'])
}

// ============================================================================
// 内部 helpers
// ============================================================================

// ---------------------------------------------------------------------------
// /copy — 最后一条 assistant 正文（纯函数，tests 直接测）
// ---------------------------------------------------------------------------

/**
 * 取 canonical turns 里**最后一条**非空 assistant 正文；没有（无 assistant
 * 回合，或最后一条正文为空/纯工具调用轮）返回 null。空正文按"没有可复制"
 * 处理——/copy 复制的是可读回复，不是空气。
 */
export const extractLastAssistantText = (turns: readonly ConversationTurn[]): string | null => {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!
    if (
      turn.role === 'assistant' &&
      typeof turn.content === 'string' &&
      turn.content.trim() !== ''
    ) {
      return turn.content
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// /version — 版本行（package.json 读一次 + Node 版本）
// ---------------------------------------------------------------------------

const requireFromHere = createRequire(import.meta.url)
let cachedVersion: string | undefined

/** agent-shell 版本（repo 根 package.json；进程内读一次，缺失回落 'unknown'）。 */
export const cliVersion = (): string => {
  if (cachedVersion === undefined) {
    try {
      const pkg = requireFromHere('../../package.json') as { version?: string }
      cachedVersion = pkg.version ?? 'unknown'
    } catch {
      cachedVersion = 'unknown'
    }
  }
  return cachedVersion
}

/** 版本状态行（纯函数便于断言格式）。 */
export const buildVersionLines = (version: string, nodeVersion: string): string[] => [
  `agent-shell v${version}`,
  `Node.js ${nodeVersion}`,
]

/** 发一条 gate 命令；失败抛错（由 executeCommand 顶层统一转状态行）。 */
const command = async <T>(ctx: CommandContext, cmd: GateCommand): Promise<T> =>
  (await ctx.gate.command(cmd)) as T

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const currentShard = (ctx: CommandContext): SessionShard | undefined =>
  ctx.sessionId === undefined ? undefined : ctx.view.shards.get(ctx.sessionId)

const formatWorkflowStatus = (state: WorkflowState): string[] => [
  `长程工作流: ${state.enabled ? '开启' : '关闭'} · 阶段 ${state.phase}`,
  `基线: ${state.baseline.status} · 已完成 ${state.baseline.completedRoles.join(', ') || '无'}`,
  `证据索引: ${state.evidenceCount} 条`,
]

/** 活跃分片里最早的挂起审批（一屏一个纪律的命令侧对应物）。 */
const currentApproval = (
  ctx: CommandContext,
): { shard: SessionShard; request: Extract<PendingRequest, { kind: 'approval' }> } | undefined => {
  const shard = currentShard(ctx)
  const request = shard?.pendingRequests.find((r): r is Extract<PendingRequest, { kind: 'approval' }> => r.kind === 'approval')
  return shard !== undefined && request !== undefined ? { shard, request } : undefined
}

const decideApproval = (args: string): 'approved' | 'rejected' | undefined => {
  switch (args.trim().toLowerCase()) {
    case 'y':
    case 'yes':
    case 'approve':
      return 'approved'
    case 'n':
    case 'no':
    case 'reject':
      return 'rejected'
    default:
      return undefined
  }
}

/** session.open + history + 与实时路径同一 reducer 重建（计划 §4.5 一条渲染路径）。 */
const openAndHydrate = async (ctx: CommandContext, id: string): Promise<void> => {
  await command(ctx, { kind: 'session.open', sessionId: id })
  const turns = await command<readonly ConversationTurn[]>(ctx, {
    kind: 'session.history',
    sessionId: id,
  })
  hydrateHistory(ctx.view, id, turns)
  setActiveSession(ctx.view, id)
}

/** ✅G5 workDir 相等：resolve 规范化 + win32 大小写不敏感。 */
const sameWorkDir = (a: string, b: string): boolean => {
  const norm = (p: string): string => {
    const r = pathResolve(p)
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

/** 当前工作区里最近的会话（/resume 无参落点；按 lastActiveAt 取最大）。 */
const newestForWorkDir = (infos: readonly SessionInfo[], workDir: string): SessionInfo | undefined =>
  infos
    .filter((s) => s.workDir !== undefined && sameWorkDir(s.workDir, workDir))
    .reduce<SessionInfo | undefined>(
      (best, s) => (best === undefined || s.lastActiveAt > best.lastActiveAt ? s : best),
      undefined,
    )

// ============================================================================
// /export — markdown 组装 + 落盘（唯一运行时 I/O）
// ============================================================================

/** 无参默认路径：workDir/exports/<短id>-<时间戳>.md（计划拍板③）。 */
const defaultExportPath = (workDir: string, sessionId: string): string =>
  join(workDir, 'exports', `${sessionId.slice(0, 8)}-${timestamp()}.md`)

const timestamp = (d = new Date()): string => {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * canonical turns → markdown。段落按回合角色分节：user / assistant（含
 * 工具调用 json 块）/ 工具结果。thinking 不入历史（ConversationTurn 无此
 * 字段），导出自然不含。
 */
export const buildExportMarkdown = (
  sessionId: string,
  workDir: string,
  turns: readonly ConversationTurn[],
): string => {
  const out: string[] = [
    `# Session ${sessionId}`,
    '',
    `- 工作区: ${workDir}`,
    `- 导出时间: ${new Date().toISOString()}`,
  ]
  for (const t of turns) {
    if (t.role === 'user') {
      out.push('', '## user', '', userExportText(t.content))
    } else if (t.role === 'assistant') {
      out.push('', '## assistant', '', t.content ?? '（无文本回复）')
      for (const call of t.toolCalls ?? []) {
        out.push('', `### 工具调用 \`${call.function.name}\``, '', '```json', call.function.arguments, '```')
      }
    } else {
      out.push(
        '',
        `### 工具结果 \`${t.toolName ?? t.toolCallId}\`${t.isError === true ? '（错误）' : ''}`,
        '',
        t.content,
      )
    }
  }
  out.push('')
  return out.join('\n')
}

const userExportText = (content: string | readonly { type: string; text?: string }[]): string =>
  typeof content === 'string'
    ? content
    : content
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('')
