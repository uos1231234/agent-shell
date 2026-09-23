/**
 * ProcessRegistry — 会话级进程监督（v0.29）。
 *
 * 跟踪本会话通过 bash/powershell spawn 的进程：记录 pid、命令、启动时刻。
 * 用途：
 *   - list_processes 工具：LLM 自查"现在有哪些进程在跑、跑了多久"（计时器语义）
 *   - kill_process 工具：终止跟踪中的进程（**只允许杀本会话跟踪的 pid**，
 *     不扫描系统进程、不允许碰未跟踪 pid——会话边界即权限边界）
 *
 * 生命周期：进程退出（exit/error）时自动移除；kill 时先 SIGTERM，
 * 10 秒未退出再 SIGKILL（Windows 上 SIGTERM 语义弱，靠 SIGKILL 兜底）。
 *
 * 挂载：createBuiltinTools 每会话一个实例（registry 即 per-session），
 * bash/powershell 构造时注入——不新增全局状态，不破既有 execute 契约。
 */

export type TrackedProcess = {
  pid: number
  /** 原始命令（截断到 120 字符，防提示词注入/展示膨胀）。 */
  command: string
  /** Date.now() 启动时刻——list_processes 据此给运行秒数。 */
  startedAt: number
  /** Harness deadline; absent means explicit unlimited approval. */
  deadlineAt?: number
}

const COMMAND_DISPLAY_MAX = 120

export class ProcessRegistry {
  private readonly processes = new Map<number, TrackedProcess>()

  /** 注册一个新 spawn 的进程；返回对应的跟踪条目（已存在则刷新时刻）。 */
  track(pid: number, command: string, timeoutSeconds?: number): TrackedProcess {
    const startedAt = Date.now()
    const entry: TrackedProcess = {
      pid,
      command: command.length > COMMAND_DISPLAY_MAX
        ? `${command.slice(0, COMMAND_DISPLAY_MAX)}…`
        : command,
      startedAt,
      ...(timeoutSeconds !== undefined ? { deadlineAt: startedAt + timeoutSeconds * 1000 } : {}),
    }
    // 同一 pid 重复 track（罕见）视为重跑——覆盖旧条目
    this.processes.set(pid, entry)
    return entry
  }

  /** 进程退出时移除（bash/powershell 的 exit/error 回调调用）。 */
  untrack(pid: number): void {
    this.processes.delete(pid)
  }

  /** 当前跟踪中的进程（按启动时刻升序，稳定的列表顺序）。 */
  list(): TrackedProcess[] {
    return [...this.processes.values()].sort((a, b) => a.startedAt - b.startedAt)
  }

  /**
   * 终止一个被跟踪的进程。只接受本会话跟踪中的 pid——其余一律拒绝
   * （错误信息带跟踪清单，帮助 LLM 找到正确的 pid）。
   * 返回终止结果；进程本就不在跟踪中 → null。
   */
  async kill(pid: number): Promise<{ ok: true; pid: number } | { ok: false; reason: 'not-tracked' | 'unavailable' }> {
    const entry = this.processes.get(pid)
    if (entry === undefined) {
      return { ok: false, reason: 'not-tracked' }
    }

    // 分层终止：SIGTERM（优雅）→ 10s 宽限窗口（200ms 探活，进程提前退出即
    // 结束）→ 仍活着补 SIGKILL（强制）。窗口的意义：让进程有机会清理
    // （关文件/释放资源）；10s 是用户拍板的宽限值——覆盖常见清理路径，
    // kill_process 是同步工具，LLM 侧等待上限可接受。SIGKILL 兜底忽略
    // 信号的卡死进程。Windows 上 SIGTERM 语义弱（Node 模拟），SIGKILL 兜底。
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // ESRCH —— 进程已不在，跟踪到此结束
      this.untrack(pid)
      return { ok: true, pid }
    }

    const alive = await new Promise<boolean>((resolve) => {
      let polls = 0
      const timer = setInterval(() => {
        polls += 1
        let isAlive = true
        try {
          process.kill(pid, 0) // 探活（不发送信号）
        } catch {
          isAlive = false // ESRCH —— 进程已退出
        }
        if (!isAlive) {
          clearInterval(timer)
          resolve(false)
          return
        }
        if (polls * 200 >= 10000) { // 10s 上限（用户拍板），仍活着 → 需要 SIGKILL
          clearInterval(timer)
          resolve(true)
        }
      }, 200)
    })

    if (alive) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 竞态下进程恰好退出 → 无需补刀
      }
    }

    // 无论结果如何，该 pid 的跟踪到此结束（进程已被要求终止）。
    this.untrack(pid)
    return { ok: true, pid }
  }
}
