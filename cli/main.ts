// v0.26 Wave 5 — CLI 入口（计划 §3.2 顶部：parseCliArgs + main）。
//
// 两条路径：
//   headless（-p <prompt>，v0.26 后补）：参数解析 → workDir 必须由 --workdir
//   传入（缺失 = 退出码 2 + 用法说明）→ runHeadless（cli/headless.ts，进程内
//   gate → runPrompt → 按格式打印）→ 返回退出码（completed=0/失败=1/参数
//   错误=2）；direct-run 包装器按码 process.exit。
//   交互 TUI：参数解析 → workDir 解析（--workdir 或交互询问；目录必须已存在——
// 工作区是权限边界，CLI 比宿主装配层更严：attachSession 会 mkdir，CLI 拒绝
// 不存在的路径，见 validateWorkDir 注释）→ createHostAssembly（dataDir 默认
// <repo>/cli-data；--mock 强制 mock，缺省 auto = 无 API key 即 mock，解析在
// 装配层 resolveLLMPlan）→ 会话初始化（--resume [id] / bare --resume 起始
// picker / 默认 /new 路径）→ TUI 启动 → 优雅退出（/quit 或 Ctrl-C×2 →
// screen.stop + assembly.shutdown + exit 0）。
//
// workDir 缺省 UX（计划 §7 待决项，本实现选定）：无 --workdir 时在 TUI 启动
// **之前**用非 raw 的 readline 逐行询问（同一进程 stdin/stdout，简单可测），
// 无效输入当场报错重问；EOF/Ctrl-D 退出码 1。

import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createHostAssembly, resolveLLMPlan } from '../src/host/index.js'
import { TuiApp } from './app.js'
import { HEADLESS_USAGE, runHeadless } from './headless.js'
import { sameWorkDir } from './picker.js'

/** CLI 参数（计划 §3.2：--workdir / --mock / --resume [id] / --session 别名；
 *  headless 批处理：-p/--print + --output-format + --yolo）。 */
export type CliArgs = {
  workDir?: string
  mock?: boolean
  /** true = 裸 --resume（启动即弹 picker）；string = 直接恢复指定会话。 */
  resume?: string | true
  dataDir?: string
  /** headless 模式：prompt 原文（-p/--print 的值）。 */
  print?: string
  /** headless 输出格式（缺省 text）。 */
  outputFormat?: 'text' | 'json'
  /** headless 无人值守：session.create 后立即 permission.full true。 */
  yolo?: boolean
  /** 演示/测试用：压低 M1 压缩触发阈值（默认 200_000），如 --m1 8000。 */
  m1?: number
  /** 空网评测：装配层剔除全部联网通道（web_fetch/open_url + skills + MCP）。 */
  noNetworkTools?: boolean
  /** v0.41 goal 模式：目标条件（headless 在 user.prompt 之前发 goal.set）。 */
  goal?: string
  /** v0.41：覆盖 goal 分歧循环上限（缺省由宿主的 DEFAULT_GOAL_MAX_ROUNDS 决定）。 */
  goalRounds?: number
  /** v0.42 大输入切块：headless 模式在 user.prompt 前开切块（超长 prompt 分卷排队）。 */
  chunk?: boolean
  /** headless 模式：启用当前会话的 LongHorizon 工作流。 */
  workflow?: boolean
  /** headless 模式：启用工作流并运行可恢复基线 scout。 */
  workflowBaseline?: boolean
  /** 系统智能体（compressor/warehouse/recall）的固定默认 provider 名。 */
  systemAgentProvider?: string
}

export const parseCliArgs = (argv: readonly string[]): CliArgs => {
  const args: CliArgs = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    switch (a) {
      case '--workdir':
      case '--work-dir': {
        const v = argv[++i]
        if (v === undefined) throw new Error('--workdir 需要一个路径参数')
        args.workDir = v
        break
      }
      case '--mock':
        args.mock = true
        break
      case '-p':
      case '--print': {
        const v = argv[++i]
        if (v === undefined) throw new Error('--print 需要一个 prompt 参数')
        args.print = v
        break
      }
      case '--output-format': {
        const v = argv[++i]
        if (v === undefined) throw new Error('--output-format 需要一个参数（text 或 json）')
        if (v !== 'text' && v !== 'json') throw new Error(`--output-format 只支持 text|json，收到: ${v}`)
        args.outputFormat = v
        break
      }
      case '--yolo':
        args.yolo = true
        break
      case '--resume': {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          args.resume = next
          i++
        } else {
          args.resume = true
        }
        break
      }
      case '--session': {
        const next = argv[++i]
        if (next === undefined) throw new Error('--session 需要一个会话 ID（--resume 的别名）')
        args.resume = next
        break
      }
      case '--data-dir': {
        const v = argv[++i]
        if (v === undefined) throw new Error('--data-dir 需要一个路径参数')
        args.dataDir = v
        break
      }
      case '--m1': {
        const v = argv[++i]
        const n = v !== undefined ? Number(v) : NaN
        if (!Number.isFinite(n) || n < 1) throw new Error('--m1 需要一个正数（token 阈值），如 --m1 8000')
        args.m1 = n
        break
      }
      case '--goal': {
        const v = argv[++i]
        if (v === undefined || v.trim() === '') throw new Error('--goal 需要一个非空的目标条件，如 --goal "两个文件都写出来"')
        args.goal = v
        break
      }
      case '--goal-rounds': {
        const v = argv[++i]
        const n = v !== undefined ? Number(v) : NaN
        if (!Number.isInteger(n) || n < 1) throw new Error('--goal-rounds 需要一个正整数（分歧循环上限），如 --goal-rounds 8')
        args.goalRounds = n
        break
      }
      case '--no-network-tools':
        args.noNetworkTools = true
        break
      case '--chunk':
        args.chunk = true
        break
      case '--workflow':
        args.workflow = true
        break
      case '--workflow-baseline':
        args.workflowBaseline = true
        args.workflow = true
        break
      case '--system-agent-provider': {
        const v = argv[++i]
        if (v === undefined || v.trim() === '') throw new Error('--system-agent-provider 需要一个 provider 名（providers.json 条目 key）')
        args.systemAgentProvider = v
        break
      }
      default:
        throw new Error(
          `未知参数: ${a}（支持 -p <prompt> --workdir <路径> --output-format <text|json> --yolo --mock --resume [会话ID] --session <会话ID> --data-dir <路径> --m1 <token阈值> --no-network-tools --goal <目标条件> --goal-rounds <n> --chunk --workflow --workflow-baseline）`,
        )
    }
  }
  return args
}

// ---------------------------------------------------------------------------
// workDir 校验（权限边界）
// ---------------------------------------------------------------------------

/**
 * 工作区必须**已存在**。宿主装配层（attachSession / session.create）对缺失
 * 目录会 mkdirSync 兜底，但 CLI 选更严格的一档：权限边界应该是用户有意给出
 * 的目录，而不是拼错路径时静默新建的空目录。无效返回错误描述，有效返回
 * resolve 后的绝对路径。
 */
export const validateWorkDir = (raw: string): { ok: true; dir: string } | { ok: false; error: string } => {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, error: '路径为空' }
  const dir = pathResolve(trimmed)
  if (!existsSync(dir)) return { ok: false, error: `目录不存在: ${dir}（工作区必须已存在——它是权限边界）` }
  if (!statSync(dir).isDirectory()) return { ok: false, error: `不是目录: ${dir}` }
  return { ok: true, dir }
}

/**
 * 行模式单行读取（不经 readline）。readline 的 terminal-mode 键处理机制在
 * close() 后会污染 TTY stdin 的状态，后续 TUI 的 raw-mode 读取拿不到任何
 * 输入、事件循环清空 → 会话创建完成后进程干净退出（真机实证）。行模式只
 * 挂一个 'data' 监听读一行就摘掉，backspace/中文由控制台行驱动处理，
 * stdin 对象不被改动。
 */
const readLineLineMode = (): Promise<string> =>
  new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('stdin 不是 TTY：交互问询不可用，请用 --workdir <路径> 传入'))
      return
    }
    const onData = (chunk: Buffer | string): void => {
      cleanup()
      resolve(String(chunk).replace(/\r\n$/, '').replace(/\r$/, '').replace(/\n$/, ''))
    }
    const onError = (e: Error): void => {
      cleanup()
      reject(e)
    }
    const cleanup = (): void => {
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('error', onError)
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', onData)
    process.stdin.on('error', onError)
  })

/** TUI 启动前的行模式询问（无效则重问；EOF/错误抛出 → main 退出码 1）。 */
export const promptForWorkDir = async (): Promise<string> => {
  for (;;) {
    process.stdout.write('工作区目录（权限边界；目录必须已存在）: ')
    const answer = await readLineLineMode()
    const verdict = validateWorkDir(answer)
    if (verdict.ok) return verdict.dir
    console.error(`[HE-CLI] ${verdict.error}`)
  }
}

// repo 根（cli/main.ts 的上一级）——默认 dataDir 落这里。
const REPO_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 直接运行（npx tsx cli/main.ts）时才自动 main——被 import 时不执行。 */
const invokedDirectly = (): boolean => {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return (
      pathToFileURL(pathResolve(entry)).href.toLowerCase() ===
      pathToFileURL(fileURLToPath(import.meta.url)).href.toLowerCase()
    )
  } catch {
    return false
  }
}

export const main = async (argv: readonly string[] = process.argv.slice(2)): Promise<number | void> => {
  // headless 意图预扫描：parseCliArgs 失败时 headless 走参数错误退出码 2 +
  // 用法说明；交互路径保持原行为（throw → 包装器 exit 1）。
  // 注意：headless 分支的输出一律 process.stderr.write 直写（不经 console.error
  // ——console 在 vitest 里被拦截，测试的 stderr spy 捕获不到）。
  const headless = argv.includes('-p') || argv.includes('--print')
  const errOut = (line: string): void => {
    process.stderr.write(line + '\n')
  }
  let args: CliArgs
  try {
    args = parseCliArgs(argv)
  } catch (e) {
    if (!headless) throw e
    errOut(`[HE-CLI] ${e instanceof Error ? e.message : String(e)}`)
    errOut(HEADLESS_USAGE)
    return 2
  }

  const dataDir = args.dataDir !== undefined ? pathResolve(args.dataDir) : join(REPO_ROOT, 'cli-data')

  // ---- headless 批处理路径（不进 TUI）----
  if (args.print !== undefined) {
    if (args.resume === true) {
      errOut('[HE-CLI] headless 模式（-p）的 --resume 需要一个会话 ID（裸 --resume 是 TUI 的 picker）')
      return 2
    }
    // --resume <id>：续跑已有会话（多段批处理流水共享同一会话——压缩事件
    // 验证依赖同会话多条 prompt）；此时 --workdir 不再必填（会话已有工作区）。
    let resumedId: string | undefined
    let newWorkDir: string | undefined
    if (typeof args.resume === 'string') {
      resumedId = args.resume
    } else {
      if (args.workDir === undefined) {
        errOut('[HE-CLI] headless 模式（-p）必须用 --workdir <目录> 传入工作区（批处理无法交互问询）')
        errOut(HEADLESS_USAGE)
        return 2
      }
      const verdict = validateWorkDir(args.workDir)
      if (!verdict.ok) {
        errOut(`[HE-CLI] ${verdict.error}`)
        errOut(HEADLESS_USAGE)
        return 2
      }
      newWorkDir = verdict.dir
    }
    return runHeadless({
      ...(resumedId !== undefined ? { resume: resumedId } : { workDir: newWorkDir! }),
      prompt: args.print,
      outputFormat: args.outputFormat ?? 'text',
      yolo: args.yolo === true,
      dataDir,
      ...(args.mock !== undefined ? { mock: args.mock } : {}),
      ...(args.m1 !== undefined ? { m1: args.m1 } : {}),
      noNetworkTools: args.noNetworkTools === true,
      // v0.41 goal 模式：条件与轮次上限都只在给出时才带（缺省由宿主决定）。
      ...(args.goal !== undefined ? { goal: args.goal } : {}),
      ...(args.goalRounds !== undefined ? { goalRounds: args.goalRounds } : {}),
      ...(args.chunk === true ? { chunk: true } : {}),
      ...(args.workflow === true ? { workflow: true } : {}),
      ...(args.workflowBaseline === true ? { workflowBaseline: true } : {}),
      ...(args.systemAgentProvider !== undefined ? { systemAgentProvider: args.systemAgentProvider } : {}),
    })
  }

  // ---- 交互 TUI 路径（原有行为不变）----
  // workDir：参数优先（无效 = 硬错误退出），否则交互询问（可重问）。
  let workDir: string
  if (args.workDir !== undefined) {
    const verdict = validateWorkDir(args.workDir)
    if (!verdict.ok) {
      console.error(`[HE-CLI] ${verdict.error}`)
      process.exit(1)
    }
    workDir = verdict.dir
  } else {
    workDir = await promptForWorkDir()
  }

  // exactOptionalPropertyTypes：mock 未传时不显式写 undefined（缺省 = auto）。
  const plan = resolveLLMPlan(args.mock !== undefined ? { mock: args.mock } : {})

  const assembly = await createHostAssembly({
    dataDir,
    ...(args.mock !== undefined ? { mock: args.mock } : {}),
    logComponent: 'he-cli',
    // 原始 JSON 日志只走 gate 信号（TUI 的日志面板渲染），不上 stderr——
    // stderr 裸 JSON 会打碎终端 UI。
    logToStderr: false,
    ...(args.m1 !== undefined
      ? { memoryConfig: { m1MinTokens: args.m1, m2MinTokens: 500_000, m3MinTokens: 900_000 } }
      : {}),
    noNetworkTools: args.noNetworkTools === true,
    ...(args.systemAgentProvider !== undefined ? { systemAgentProvider: args.systemAgentProvider } : {}),
  })

  let quitting = false
  const shutdownAndExit = async (): Promise<void> => {
    if (quitting) return
    quitting = true
    app.dispose()
    app.screen.stop()
    await assembly.shutdown()
    process.exit(0)
  }

  const app = new TuiApp({
    io: { stdout: process.stdout, stdin: process.stdin },
    gate: assembly.gate,
    workDir,
    bannerLines: [
      `[HE-CLI] 工作区: ${workDir}`,
      `[HE-CLI] LLM: ${plan.useMock ? 'mock（--mock 或未解析到 API key）' : `${plan.model}`}`,
      '[HE-CLI] /help 查看命令 · Ctrl-C 取消回合 / 两次退出',
    ],
    onQuit: () => {
      void shutdownAndExit()
    },
  })

  app.screen.installCrashGuard()
  app.start()

  if (typeof args.resume === 'string') {
    await app.resumeSession(args.resume) // /resume 路径：G5 workDir 校验内置
  } else if (args.resume === true) {
    await app.openPicker() // 裸 --resume：启动即 picker
  } else {
    await app.startNewSession() // 默认：/new 路径开新会话
  }
}

if (invokedDirectly()) {
  main()
    .then((code) => {
      // headless 路径返回退出码（0/1/2）；TUI 路径自行 process.exit。
      if (typeof code === 'number') process.exit(code)
    })
    .catch((cause: unknown) => {
      console.error('[HE-CLI] 启动失败:', cause instanceof Error ? cause.message : String(cause))
      process.exit(1)
    })
}

// 供 main/测试复用的 workDir 相等判定（picker 同款口径）——re-export 保持
// 单一事实源。
export { sameWorkDir }
