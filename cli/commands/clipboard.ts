// v0.26 Wave A — /copy 的剪贴板出口。
//
// 平台实现（计划 §"复制最后回复"）：
//   - win32  → clip（文本走 stdin）
//   - darwin → pbcopy（文本走 stdin）
//   - linux  → 依次尝试 xclip -selection clipboard / wl-copy，全部失败给
//     干净错误（两个都不在 PATH 是常态，报错要可读）
//
// 注入纪律：spawn 以参数形式注入（缺省 node:child_process 的真 spawn）——
// 单测 mock 子进程，永不真碰系统剪贴板。

import { spawn as nodeSpawn } from 'node:child_process'

/** copyToClipboard 所需的最小子进程面（真 ChildProcess 的窄投影）。 */
export type ClipboardChild = {
  stdin: {
    write(chunk: string): void
    end(): void
    on(event: 'error', cb: (err: Error) => void): void
  }
  on(event: 'error', cb: (err: Error) => void): void
  on(event: 'close', cb: (code: number | null) => void): void
}

export type ClipboardSpawn = (
  cmd: string,
  args: readonly string[],
  opts: { stdio: ['pipe', 'ignore', 'ignore'] },
) => ClipboardChild

const defaultSpawn: ClipboardSpawn = (cmd, args, opts) =>
  nodeSpawn(cmd, args, opts) as unknown as ClipboardChild

/** 各平台的候选命令（依次尝试；linux 两个候选都失败才报错）。 */
const candidatesFor = (platform: string): readonly (readonly string[])[] => {
  switch (platform) {
    case 'win32':
      return [['clip']]
    case 'darwin':
      return [['pbcopy']]
    default:
      return [
        ['xclip', '-selection', 'clipboard'],
        ['wl-copy'],
      ]
  }
}

/** 用单个候选命令复制：close(0) = 成功；error / 非零码 = 失败。 */
const copyVia = (text: string, argv: readonly string[], spawnFn: ClipboardSpawn): Promise<void> =>
  new Promise((resolve, reject) => {
    const cmd = argv[0]!
    const args = argv.slice(1)
    let child: ClipboardChild
    try {
      child = spawnFn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] })
    } catch (cause) {
      reject(cause instanceof Error ? cause : new Error(String(cause)))
      return
    }
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      reject(new Error(`clipboard command "${cmd}" failed: ${err.message}`))
    }
    child.on('error', fail)
    child.stdin.on('error', fail)
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (code === 0) resolve()
      else reject(new Error(`clipboard command "${cmd}" exited with code ${code}`))
    })
    child.stdin.write(text)
    child.stdin.end()
  })

/**
 * 把文本写入系统剪贴板。所有候选都失败（或平台无候选）时抛干净错误——
 * executeCommand 的顶层 catch 会把它收敛为一条状态行。platform 可注入
 * （单测验证 linux 候选链，不依赖运行平台）。
 */
export const copyToClipboard = async (
  text: string,
  spawnFn: ClipboardSpawn = defaultSpawn,
  platform: string = process.platform,
): Promise<void> => {
  const candidates = candidatesFor(platform)
  if (candidates.length === 0) {
    throw new Error(`clipboard is not supported on ${platform}`)
  }
  let lastError: Error = new Error('no clipboard candidate was attempted')
  for (const argv of candidates) {
    try {
      await copyVia(text, argv, spawnFn)
      return
    } catch (cause) {
      lastError = cause instanceof Error ? cause : new Error(String(cause))
    }
  }
  throw new Error(
    `clipboard unavailable (tried ${candidates.map((c) => c[0]).join(', ')}): ${lastError.message}`,
  )
}
