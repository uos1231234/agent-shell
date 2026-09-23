// headless 批处理模式（对标 KimiCode 的 -p 打印模式）。
//
// 流程：createHostAssembly（进程内 gate）→ session.create（workDir 必填——
// 权限边界，headless 无交互问询）→ [--yolo] permission.full true → runPrompt
// → 按输出格式打印 → shutdown → 返回退出码（completed=0 / 其他=1）。
//
// 入站动作统一经信号关：所有 4 个入站动作（session.create / permission.full /
// user.prompt / session.history）一律走 **gate.command()** 路由——前端宿主
// （webapp 与 CLI）的入站动作只经信号关中转，不直调 handlers（架构决策，
// 同 webapp 纪律）。
//
// 事件取数（json 模式，NDJSON）：
//   - session.created / turn.start / turn.end / assistant.message /
//     session.completed —— 从 runPrompt 返回值 + session.history **派生**
//     （测试确定性优先，不依赖信号时序）；
//   - tool.started / tool.result / approval.request / memory.activity ——
//     运行期事件，runPrompt 返回值里没有，挂 gate.on 实时订阅。
//     memory.activity（v0.30）= 上下文压缩 / M3 归档事件的批处理可见化：
//     json 模式发 NDJSON 事件行；text 模式走 stderr 通知（stdout 纪律不变）。
//
// 审批语义（无人值守，实现决策）：headless 没有人守着审批浮层。不带 --yolo
// 时收到审批请求 → 输出事件 + **主动 gate.resolve(requestId, 'rejected')**
// 拒绝该挂起审批（fail-closed），让 door 落地为 deny、loop 继续走到自然收场
// → 批处理退出码 1（无人值守出现审批请求 = 批处理失败，无论 loop 最终
// reason）。**不**等 300s 超时（批处理 fail-fast）。
//
// 为什么不调 turn.cancel 真取消回合：[已验证] runPromptOnce（src/host/
// assembly.ts）创建的 AbortController 从未作为 signal 传进 buildLoopOptions/
// runIMLoop——handlers.cancel 的 abort 今天对 loop 是 no-op，loop 会卡在
// 审批等待直到 300s。真正能解除阻塞的只有 settle 挂起的审批 promise。给
// runPromptOnce 接 signal 是 src/ 改动，超出本任务边界（只碰 cli/ 与
// tests/cli/）；届时 headless 无需改动——退出码逻辑与事件流不受影响。
// --yolo 则在 session.create 后立即 permission.full true，审批门在 door 层
// 短路（write-approval.ts: fullPermission → allow），根本不会产生审批请求。
//
// stdout 纪律：text 模式 stdout 只含最终 assistant 文本（可管道消费）；审批
// 请求等人类可读说明一律走 stderr。
//
// 日志出口（2026-09-11 用户拍板②）：装配层 keepStderr:false 关掉了 stderr
// 原始 JSON，此前 headless 下日志无任何出口（可诊断性黑洞）。本订阅把 gate
// log 信号接入：json 模式转 NDJSON 事件行（type:"log"，消费方按 type 过滤），
// text 模式只把 warn/error 以人类可读写 stderr。
//
// 收尾 drain（2026-09-11 用户拍板③）：fireDriveCoordinator 不 await，最后
// 一轮 fire 的压缩（compressor 的 LLM 调用 + 落盘）若不等待就会随
// process.exit 被硬杀——finally 里先 drain（带超时）再 shutdown，让压缩的
// memory.activity 事件在批处理流里可见。超时后放弃等待照常退出（数据无损：
// canonical 完整，下次进程的 tick 会重试）。

import { createHostAssembly } from '../src/host/index.js'
import type { ConversationTurn } from '../src/signals/index.js'
import type { SessionHandle } from '../src/im/session/types.js'
import type { IMLoopResult } from '../src/im/loop.js'
// v0.41：goal 事件的一行摘要。session-view.js 是零 I/O 的纯投影层（文件头纪律），
// 所以从这里取文案不会把 TUI 渲染器拖进 headless。
import { goalEventLabel } from './session-view.js'

export type HeadlessOutputFormat = 'text' | 'json'

export type HeadlessOptions = {
  /** 已校验存在的工作区绝对路径（main 负责校验；--resume 续跑时省略——
   * 会话已有工作区，校验与必填约束都在 main 的参数分支）。 */
  workDir?: string
  prompt: string
  outputFormat: HeadlessOutputFormat
  yolo: boolean
  dataDir: string
  mock?: boolean
  /** 演示/测试用：压低 M1 压缩触发阈值（默认 200_000）。 */
  m1?: number
  /** 续跑已有会话（多段批处理流水共享同一会话）；给出时忽略 workDir。 */
  resume?: string
  /** 空网评测：装配层剔除全部联网通道（web_fetch/open_url + skills + MCP）。 */
  noNetworkTools: boolean
  /**
   * v0.41 goal 模式：目标条件。给出时在 user.prompt **之前**发 goal.set，
   * 于是这一段的每次轮次收尾都由独立 judge 裁决，未达成自动续跑。
   * DeepSWE 长程评测的入口（"所有测试都是 goal 模式"）。
   */
  goal?: string
  /**
   * v0.41：覆盖分歧循环上限。缺省时由宿主用 DEFAULT_GOAL_MAX_ROUNDS
   * （事实源 src/im/goal/types.ts）——headless 刻意不复制该常量，避免两个事实源。
   * 计的是"judge 说没达成"的次数，不是 LLM 轮数。
   */
  goalRounds?: number
  /**
   * v0.42 大输入切块：给出时在 user.prompt **之前**发 chunk.set(true)，
   * 于是本段 prompt 超过 40K 会被 gate 切成多卷排队串行处理（避免 1M 数据
   * 一股脑上 wire）。阈值事实源在 src/signals/chunk.ts，headless 不复制常量。
   */
  chunk?: boolean
  /** 启动时为当前会话启用 LongHorizon 工作流。 */
  workflow?: boolean
  /** 启用工作流后立即运行可恢复的只读基线 scout。 */
  workflowBaseline?: boolean
  /** 系统智能体固定默认 provider 名（compressor/warehouse/recall 锚定，不随工作代理切换）。 */
  systemAgentProvider?: string
}

/** headless 参数错误的用法说明（退出码 2 时打印到 stderr）。 */
export const HEADLESS_USAGE = [
  '用法: npx tsx cli/main.ts -p "<prompt>" --workdir <目录> [选项]',
  '  -p, --print <prompt>        headless 批处理：跑完即退，不进 TUI',
  '  --workdir <目录>            工作区（headless 必填；目录必须已存在）',
  '  --output-format <text|json> 输出格式（缺省 text：stdout 只含最终回复；json：NDJSON 事件流）',
  '  --yolo                      会话级完全权限（跳过审批；无人值守批处理用）',
  '  --mock                      强制 mock LLM',
  '  --data-dir <目录>           会话持久化目录',
  '  --resume <会话ID>           续跑已有会话（多段流水共享同一会话；此时 --workdir 可省）',
  '  --no-network-tools          空网评测：装配层剔除全部联网通道（web_fetch/open_url + skills + MCP）',
  '  --goal <目标条件>           goal 模式：每轮收尾由独立 judge 裁决，未达成自动续跑',
  '  --goal-rounds <n>           goal 分歧循环上限（缺省 24；计的是 judge 裁决次数，不是 LLM 轮数）',
  '  --chunk                    大输入切块：超长 prompt 切成 40K 一卷排队串行处理',
  '  --workflow                 启用当前会话的 LongHorizon 工作流',
  '  --workflow-baseline        启用工作流并运行一次可恢复基线 scout',
].join('\n')

/** tool.result 的 content 摘要上限（NDJSON 单行不携带全文）。 */
const CONTENT_SUMMARY_MAX = 200

/** ③ 收尾 drain 的上限：压缩是数十秒的 LLM 调用，120s 覆盖慢上游；超时后
 * 放弃等待照常退出（数据无损——canonical 完整，下次进程的 tick 会重试）。 */
const DRAIN_TIMEOUT_MS = 120_000

/** 会话历史中 assistant 回合的非空文本（按序）。 */
const assistantContents = (turns: readonly ConversationTurn[]): string[] =>
  turns.flatMap((t) =>
    t.role === 'assistant' && typeof t.content === 'string' && t.content.trim() !== ''
      ? [t.content]
      : [],
  )

/**
 * headless 主流程。返回退出码（不调用 process.exit——测试可进程内断言；
 * direct-invocation 包装器负责按码退出）。
 */
export const runHeadless = async (opts: HeadlessOptions): Promise<number> => {
  const out = (line: string): void => {
    process.stdout.write(line)
  }
  const errOut = (line: string): void => {
    process.stderr.write(line + '\n')
  }
  const emit = (event: Record<string, unknown>): void => {
    if (opts.outputFormat === 'json') out(JSON.stringify(event) + '\n')
  }
  const announcedSessionIds = new Set<string>()

  const assembly = await createHostAssembly({
    dataDir: opts.dataDir,
    ...(opts.mock !== undefined ? { mock: opts.mock } : {}),
    logComponent: 'he-cli',
    // 原始 JSON 日志不上 stderr（json 模式 stderr 保持干净；text 模式 stdout
    // 纯净不受影响）。
    logToStderr: false,
    ...(opts.m1 !== undefined
      ? { memoryConfig: { m1MinTokens: opts.m1, m2MinTokens: 500_000, m3MinTokens: 900_000 } }
      : {}),
    noNetworkTools: opts.noNetworkTools,
    ...(opts.systemAgentProvider !== undefined ? { systemAgentProvider: opts.systemAgentProvider } : {}),
  })

  // 无人值守审批：只处理第一次请求（拒绝后 loop 自然收场；即便模型重发审批
  // 请求，approvalHandled 已置位，不再重复处理）。
  let approvalHandled = false
  const unsubs = [
    assembly.gate.on('tool.started', (sig) => {
      if (sig.kind !== 'tool.started') return
      emit({ type: 'tool.started', sessionId: sig.sessionId, toolName: sig.toolName, args: sig.args })
    }),
    assembly.gate.on('tool.result', (sig) => {
      if (sig.kind !== 'tool.result') return
      emit({
        type: 'tool.result',
        sessionId: sig.sessionId,
        toolName: sig.toolName,
        isError: sig.result.isError === true,
        content: sig.result.content.slice(0, CONTENT_SUMMARY_MAX),
      })
    }),
    assembly.gate.on('approval', (sig) => {
      if (sig.kind !== 'approval') return
      emit({
        type: 'approval.request',
        requestId: sig.requestId,
        toolName: sig.payload.toolName,
        reason: sig.payload.reason,
      })
      if (opts.outputFormat === 'text') {
        errOut(
          `[HE-CLI] 审批请求: ${sig.payload.toolName} — ${sig.payload.reason}` +
            '（headless 无人值守 → 已拒绝该审批，批处理将以失败收场；--yolo 可跳过审批）',
        )
      }
      if (!opts.yolo && !approvalHandled) {
        approvalHandled = true
        // 解除 door 的挂起 promise（fail-closed rejected）。不调 handlers.cancel：
        // runPromptOnce 未把 abort signal 接进 loop（见文件头注释），cancel 是 no-op。
        assembly.gate.resolve(sig.requestId, 'rejected')
      }
    }),
    // v0.30：压缩事件（memory.activity）批处理可见化。detail 唯一生产者是
    // src/signals/wiring/state-line.ts（{ layer, stamp, taskGoal }），非契约形态
    // 不发事件、与 TUI 的 isMemoryDetail 收窄同口径。
    assembly.gate.on('memory.activity', (sig) => {
      if (sig.kind !== 'memory.activity') return
      if (sig.activity !== 'memory.compressed' && sig.activity !== 'memory.archived') return
      const d = (sig.detail ?? {}) as { layer?: unknown; taskGoal?: unknown }
      const layer = d.layer === 'M1/M2' || d.layer === 'M3' ? d.layer : ''
      const taskGoal = typeof d.taskGoal === 'string' ? d.taskGoal : ''
      emit({ type: 'memory.activity', sessionId: sig.sessionId, activity: sig.activity, layer, taskGoal })
      if (opts.outputFormat === 'text') {
        errOut(
          `[HE-CLI] ${sig.activity === 'memory.archived' ? '📦 记忆已归档' : '🗜 上下文已压缩'}` +
            ` · ${layer}${taskGoal !== '' ? ` · ${taskGoal}` : ''}`,
        )
      }
    }),
    // v0.41：goal 事件批处理可见化。json 模式发完整 GoalEvent（评测脚本据此
    // 还原裁决序列与 G1/G2 压缩情况）；text 模式往 stderr 打一行摘要，与 TUI
    // 共用 session-view 的 goalEventLabel（同一份文案，不两处漂移）。
    // stdout 的既有契约不变：只含最终回复。
    assembly.gate.on('goal.changed', (sig) => {
      if (sig.kind !== 'goal.changed') return
      emit({ type: 'goal.changed', sessionId: sig.sessionId, event: sig.event })
      if (opts.outputFormat === 'text') {
        errOut(`[HE-CLI] ${goalEventLabel(sig.event)}`)
      }
    }),
    assembly.gate.on('workflow.changed', (sig) => {
      if (sig.kind !== 'workflow.changed') return
      // session.create/session.open emits the initial disabled snapshot before
      // headless has announced its session. Keep that lifecycle detail out of
      // the long-standing output contract; explicit workflow commands remain
      // visible after session.created.
      if (!announcedSessionIds.has(sig.sessionId)) return
      emit({ type: 'workflow.changed', sessionId: sig.sessionId, state: sig.state })
      if (opts.outputFormat === 'text') {
        errOut(`[HE-CLI] 长程工作流: ${sig.state.enabled ? '开启' : '关闭'} · ${sig.state.phase}`)
      }
    }),
    assembly.gate.on('workflow.run', (sig) => {
      if (sig.kind !== 'workflow.run') return
      emit({ type: 'workflow.run', sessionId: sig.sessionId, event: sig.event })
      if (opts.outputFormat === 'text') {
        const e = sig.event
        errOut(`[HE-CLI] workflow ${e.phase}${e.role !== undefined ? ` · ${e.role}` : ''}`)
      }
    }),
    // ② 批处理日志出口：gate log 信号 → 事件流 / stderr（见文件头注释）。
    assembly.gate.on('log', (sig) => {
      if (sig.kind !== 'log') return
      if (opts.outputFormat === 'json') {
        emit({
          type: 'log',
          level: sig.level,
          msg: sig.msg,
          ...(sig.fields !== undefined ? { fields: sig.fields } : {}),
          ...(sig.component !== undefined ? { component: sig.component } : {}),
        })
      } else if (sig.level === 'warn' || sig.level === 'error') {
        errOut(`[HE-CLI] ${sig.level}: ${sig.msg}`)
      }
    }),
  ]

  // finally 的 drain 需要拿到会话句柄（失败路径也要 drain——prompt 失败前
  // 可能已有 fire 出去的压缩）。
  let handle: SessionHandle | undefined
  try {
    // gate.command 静态返回 unknown——回执类型与直调 handlers 一致，按 cli/
    // commands/handlers.ts 的 command<T> 同款在调用点断言。
    // --resume：session.open 续跑已有会话（多段流水共享同一会话）；缺省全新 create。
    handle = (await (opts.resume !== undefined
      ? assembly.gate.command({ kind: 'session.open', sessionId: opts.resume })
      : assembly.gate.command({
          kind: 'session.create',
          payload: { workDir: opts.workDir },
        }))) as SessionHandle
    const sessionId = handle.info.id
    announcedSessionIds.add(sessionId)
    emit({ type: 'session.created', sessionId })

    if (opts.yolo)
      await assembly.gate.command({ kind: 'permission.full', sessionId, enabled: true })

    if (opts.workflow === true || opts.workflowBaseline === true) {
      await assembly.gate.command({ kind: 'workflow.enable', sessionId })
    }
    if (opts.workflowBaseline === true) {
      await assembly.gate.command({ kind: 'workflow.baseline', sessionId })
    }

    // v0.41：goal 必须在 user.prompt **之前**设置——否则第一轮收尾时 goal 还没
    // 生效，beforeComplete hook 立即弃权，judge 一次都不会被调用。
    // goalRounds 缺省时不带该字段，由宿主用 DEFAULT_GOAL_MAX_ROUNDS（事实源在
    // src/im/goal/types.ts，headless 不复制常量）。
    if (opts.goal !== undefined) {
      await assembly.gate.command(
        opts.goalRounds !== undefined
          ? { kind: 'goal.set', sessionId, condition: opts.goal, maxRounds: opts.goalRounds }
          : { kind: 'goal.set', sessionId, condition: opts.goal },
      )
    }

    // v0.42：大输入切块同样必须在 user.prompt **之前**设置——切块是发送时行为
    // （gate 收到 prompt 的瞬间判断是否切分），开启晚于第一条 prompt 就不生效。
    if (opts.chunk === true) {
      await assembly.gate.command({ kind: 'chunk.set', sessionId, enabled: true })
    }

    emit({ type: 'turn.start', sessionId })

    let result: IMLoopResult
    try {
      result = (await assembly.gate.command({
        kind: 'user.prompt',
        sessionId,
        text: opts.prompt,
      })) as IMLoopResult
    } catch (e) {
      errOut(`[HE-CLI] runPrompt 失败: ${e instanceof Error ? e.message : String(e)}`)
      emit({ type: 'turn.end', sessionId, reason: 'failed', finalState: 'Tripped', turns: 0, tokens: 0 })
      emit({ type: 'session.completed', sessionId })
      return 1
    }

    const history = (await assembly.gate.command({
      kind: 'session.history',
      sessionId,
    })) as readonly ConversationTurn[]
    const texts = assistantContents(history)
    if (opts.outputFormat === 'text') {
      const last = texts[texts.length - 1]
      if (last !== undefined) out(last.endsWith('\n') ? last : last + '\n')
    } else {
      for (const content of texts) emit({ type: 'assistant.message', sessionId, content })
    }

    emit({
      type: 'turn.end',
      sessionId,
      reason: result.reason,
      finalState: result.finalState,
      turns: result.turns,
      tokens: result.metrics.totalTokens,
    })
    emit({ type: 'session.completed', sessionId })
    // 无人值守下出现过审批请求 = 批处理失败（审批被拒、工具未执行成功），
    // 即使 loop 对 denied 工具照常走完（reason=completed）——退出码如实非 0。
    return result.reason === 'completed' && !approvalHandled ? 0 : 1
  } finally {
    // ③ 收尾 drain：等最后一次 fire 的压缩落盘（带超时，防 LLM 挂死拖住批
    // 处理退出）。放在 unsub 之前——压缩产生的 memory.activity 事件要走上面
    // 的订阅进事件流。timer unref：drain 先完成时超时计时不拖住进程退出。
    const drainDeadline = new Promise<void>((resolve) => { setTimeout(resolve, DRAIN_TIMEOUT_MS).unref() })
    await Promise.race([handle?.runtime.driveCoordinator.drain() ?? Promise.resolve(), drainDeadline])
    for (const unsub of unsubs) unsub()
    await assembly.shutdown()
  }
}
