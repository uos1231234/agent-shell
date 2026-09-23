// Warehouse persistent-session storage (v0.30).
//
// 落盘位置说明（用户拍板 2026-09-09：落盘机制必须注释在 warehouse 主体代码，
// 让所有人知道 warehouse 的会话状态写到哪）：
//
//   warehouse 的持久会话 = <dataDir>/<sessionId>/state/warehouse-session.jsonl
//   warehouse 的私有 databus = <dataDir>/<sessionId>/state/warehouse-session-databus.jsonl
//
//   - dataDir 是宿主装配层的会话基目录（web-host/CLI 默认 cli-data/ 或
//     --data-dir 指定值），与 conversation.jsonl / databus.jsonl / state/
//     同属一个会话目录；persistPath 由 src/host/assembly.ts 用
//     sessionStore.stateDir(sessionId) 计算（join(stateDir, 'warehouse-session.jsonl')）
//     后经 SystemAgentDeps.warehousePersistPath 传入。databus 文件为
//     persistPath 去掉 .jsonl 后缀后追加 `-databus.jsonl`。
//   - 文件格式：JSONL，每行一个 ConversationTurn（canonical 全量快照，非
//     追加日志——每次 run 结束整体重写，原子替换 tmp→rename，旧文件留 .bak）。
//     databus 文件同理，每行一个 ToolTurn。
//   - 加载：createSystemAgent 工厂构造时（persistent=true 且无外部注入
//     databus）同步读入 ConversationMemory / Databus；文件不存在 = 全新会话。
//     损坏行跳过（容忍崩溃截断）。
//   - databus 落盘的原因（用户拍板 2026-09-09）：warehouse 等系统智能体的
//     私有 databus 记录着它们的全部工具活动（记录归档、索引写入、邮件往来
//     的调用痕迹）——跨进程重启后这些信息最宝贵，不能丢。
//   - warehouse 的跨唤醒"清醒"记忆 = 本两个文件；它的长期归档记忆仍在
//     state-line（index.jsonl/curatedMemory.jsonl），三者互补。

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ConversationMemory, ConversationTurn } from './conversation-memory.js'
import type { Databus, ToolTurn } from './databus.js'

const parseTurn = (line: string): ConversationTurn | undefined => {
  try {
    const t = JSON.parse(line) as ConversationTurn
    if (typeof t !== 'object' || t === null || typeof (t as { role?: unknown }).role !== 'string') return undefined
    return t
  } catch {
    return undefined // 容忍崩溃产生的截断尾行
  }
}

/** 工厂构造时调用：把既有持久会话读进 ConversationMemory（不存在 = 空会话）。 */
export const loadPersistedConversation = (memory: ConversationMemory, path: string | undefined): number => {
  if (path === undefined || !existsSync(path)) return 0
  let loaded = 0
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const t = parseTurn(line)
    if (t !== undefined) {
      memory.append(t)
      loaded += 1
    }
  }
  return loaded
}

/** 每次 run 结束调用：canonical 全量原子写盘（tmp → rename，旧文件留 .bak）。 */
export const savePersistedConversation = (memory: ConversationMemory, path: string | undefined): void => {
  if (path === undefined) return
  const body = memory.turns().map(t => JSON.stringify(t)).join('\n') + '\n'
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  if (existsSync(path)) {
    try {
      renameSync(path, `${path}.bak`)
    } catch {
      // .bak 失败不阻断主写路径
    }
  }
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, path)
}

// 私有 databus 的落盘文件 = persistPath 去 .jsonl 后缀 + '-databus.jsonl'。
export const databusPersistPathOf = (persistPath: string | undefined): string | undefined =>
  persistPath === undefined
    ? undefined
    : persistPath.endsWith('.jsonl')
      ? `${persistPath.slice(0, -'.jsonl'.length)}-databus.jsonl`
      : `${persistPath}-databus.jsonl`

/** 工厂构造时调用：读回私有 Databus 的工具事件（逐条 append——Databus
 *  无批量导入 API，append 即通知订阅者；恢复期无订阅者，无副作用）。 */
export const loadPersistedDatabus = (databus: Databus, path: string | undefined): number => {
  if (path === undefined || !existsSync(path)) return 0
  let loaded = 0
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const t = JSON.parse(line) as { role?: unknown } | null
      if (typeof t !== 'object' || t === null || t.role !== 'tool') continue
      databus.append(t as unknown as ToolTurn)
      loaded += 1
    } catch {
      // 容忍崩溃产生的截断尾行/损坏行
    }
  }
  return loaded
}

/** 每次 run 结束调用：私有 Databus 全量原子写盘（与 conversation 同策略）。 */
export const savePersistedDatabus = (databus: Databus, path: string | undefined): void => {
  if (path === undefined) return
  const body = databus.turns().map(t => JSON.stringify(t)).join('\n') + '\n'
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  if (existsSync(path)) {
    try {
      renameSync(path, `${path}.bak`)
    } catch {
      // .bak 失败不阻断主写路径
    }
  }
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, path)
}
