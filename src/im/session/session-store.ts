// v0.17 session-store: on-disk layout for sessions.
//
//   <basePath>/<sessionId>/
//     session.json         — SessionInfo metadata
//     conversation.jsonl   — full canonical turns (snapshot, TTL)
//     databus.jsonl        — tool-only turns (snapshot, TTL)
//     state/               — per-session state-line gradient (durable, no TTL)
//
// Snapshot TTL: conversation.jsonl + databus.jsonl are a reconstructable copy
// for same-session resume and are pruned after ttlDays of inactivity.
// state/ (the compressed gradient) is durable and never pruned here.
//
// Reuses state-line's jsonl-writer (appendJsonl) for atomic line appends —
// no new persistence primitive.

import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import {
  copyFile,
  mkdir, readdir, readFile, writeFile, rm, stat, rename,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { appendJsonl } from '../state-line/jsonl-writer.js'
import type { SessionId, SessionInfo, SessionSnapshotConfig } from './types.js'
import type { ConversationTurn } from '../conversation-memory.js'
import type { ToolTurn } from '../databus.js'
import type { MailItem } from '../mailbox/types.js'

const DEFAULT_SESSIONS_ROOT = (): string => join(homedir(), '.databus', 'sessions')
export const DEFAULT_TTL_DAYS = 3

export type SessionStoreConfig = {
  basePath?: string
  ttlDays?: number
}

export class SessionStore {
  readonly basePath: string
  readonly ttlDays: number
  /**
   * 已删除的会话（进程内）。
   *
   * 删除会话 = 整目录 rm（deleteSessionDir）。但在途回合并不知道会话被删了，
   * 它随后仍会调 append*；而 appendJsonl 写前会 `mkdir -p`，于是把刚删掉的
   * 目录重建出来 —— 留下一个只有一行 jsonl、没有 session.json 的**僵尸目录**
   * （listSessionIds 以 session.json 为判定，所以它不会被列成会话，但残留磁盘
   * 且干扰按目录遍历的 pruneExpiredSnapshots）。
   *
   * 守卫边界：**一切会 mkdir 的写入路径**（writeInfo / append* / copySnapshot）。
   * 不落盘 —— 僵尸只可能在同一进程生命周期内产生（在途回合与删除动作必须同
   * 进程），重启后不存在在途回合。
   *
   * 注意：pruneExpiredSnapshots 只删 conversation.jsonl / databus.jsonl 而保留
   * session.json 与 state/（会话仍存在，快照是"可重建副本"），**不在此列** ——
   * prune 之后的 append 必须照常重建快照。
   */
  private readonly deletedIds = new Set<SessionId>()

  constructor(config?: SessionStoreConfig) {
    this.basePath = config?.basePath ?? DEFAULT_SESSIONS_ROOT()
    this.ttlDays = config?.ttlDays ?? DEFAULT_TTL_DAYS
  }

  // ---- path helpers ----
  sessionDir(id: SessionId): string { return join(this.basePath, id) }
  sessionFile(id: SessionId): string { return join(this.sessionDir(id), 'session.json') }
  conversationFile(id: SessionId): string { return join(this.sessionDir(id), 'conversation.jsonl') }
  databusFile(id: SessionId): string { return join(this.sessionDir(id), 'databus.jsonl') }
  mailboxFile(id: SessionId): string { return join(this.sessionDir(id), 'mailbox.jsonl') }
  stateDir(id: SessionId): string { return join(this.sessionDir(id), 'state') }

  // ---- session.json ----
  async writeInfo(info: SessionInfo): Promise<void> {
    if (this.deletedIds.has(info.id)) return
    await mkdir(this.sessionDir(info.id), { recursive: true })
    await writeFile(this.sessionFile(info.id), JSON.stringify(info, null, 2), 'utf-8')
  }

  async readInfo(id: SessionId): Promise<SessionInfo | null> {
    const file = this.sessionFile(id)
    if (!existsSync(file)) return null
    try {
      const raw = await readFile(file, 'utf-8')
      return JSON.parse(raw) as SessionInfo
    } catch {
      return null
    }
  }

  // ---- snapshot appends (conversation + databus) ----
  // 已删除会话的追加一律丢弃（不写、不 mkdir）——见 deletedIds 的说明。
  async appendConversationTurn(id: SessionId, turn: ConversationTurn): Promise<void> {
    if (this.deletedIds.has(id)) return
    await appendJsonl(this.conversationFile(id), turn)
  }

  async appendDatabusTurn(id: SessionId, turn: ToolTurn): Promise<void> {
    if (this.deletedIds.has(id)) return
    await appendJsonl(this.databusFile(id), turn)
  }

  // ---- v0.34 D10：mailbox 落盘（每会话一行一封，与 conversation/databus 同粒度）----
  //
  // 为什么单独落盘而不是塞进 session.json：邮件的生命周期与 TTL（按 sentAt 3 天）
  // 与会话快照不同，append-only + 惰性读更贴合"只增、偶尔回写清理"的用法。
  async appendMail(id: SessionId, item: MailItem): Promise<void> {
    // 已删除会话 → 丢弃（与 appendConversationTurn 同一守卫语义）。
    if (this.deletedIds.has(id)) return
    await appendJsonl(this.mailboxFile(id), item)
  }

  /** Read all mails. Tolerant of partial writes (jsonl)。 */
  async readMails(id: SessionId): Promise<MailItem[]> {
    return this.readJsonl<MailItem>(this.mailboxFile(id))
  }

  /** Rewrite mailbox.jsonl from in-memory state（过期清理后回写，避免文件只增不减）。 */
  async rewriteMails(id: SessionId, items: readonly MailItem[]): Promise<void> {
    await this.rewriteJsonl(this.mailboxFile(id), items)
  }

  // ---- snapshot reads (for recovery) ----
  /** Read all conversation turns. Tolerant of partial writes (jsonl). */
  async readConversation(id: SessionId): Promise<ConversationTurn[]> {
    return this.readJsonl<ConversationTurn>(this.conversationFile(id))
  }

  /** Read all tool turns (databus projection). */
  async readDatabus(id: SessionId): Promise<ToolTurn[]> {
    return this.readJsonl<ToolTurn>(this.databusFile(id))
  }

  // ---- v0.29 Wave B2: snapshot copy + journal rewrite (/fork, /undo) ----

  /**
   * Copy the snapshot pair (conversation.jsonl + databus.jsonl) from one
   * session to another (byte-exact copyFile — /fork's "new id's conversation
   * matches the source" guarantee). Missing files are skipped (a session may
   * have zero tool turns). state/ IS copied (2026-09-13) — 信封修复后 fork 的
   * canonical 只有信封，块原文在 state/raw-archive；不拷则 fork 里
   * state_query({stamps}) 查空库（信封 #NOTE 指引死链）。拷贝后两边梯度独立演进。
   */
  async copySnapshot(fromId: SessionId, toId: SessionId): Promise<void> {
    if (this.deletedIds.has(toId)) return
    await mkdir(this.sessionDir(toId), { recursive: true })
    for (const [src, dst] of [
      [this.conversationFile(fromId), this.conversationFile(toId)],
      [this.databusFile(fromId), this.databusFile(toId)],
    ] as const) {
      if (existsSync(src)) await copyFile(src, dst)
    }
    await this.copyDirIfExists(this.stateDir(fromId), this.stateDir(toId))
  }

  /** Recursive directory copy; no-op when src missing. */
  private async copyDirIfExists(src: string, dst: string): Promise<void> {
    if (!existsSync(src)) return
    await mkdir(dst, { recursive: true })
    const entries = await readdir(src, { withFileTypes: true })
    for (const e of entries) {
      const s = join(src, e.name)
      const d = join(dst, e.name)
      if (e.isDirectory()) await this.copyDirIfExists(s, d)
      else if (e.isFile()) await copyFile(s, d)
    }
  }

  /** Rewrite conversation.jsonl from in-memory state (/undo journal rewrite). */
  async rewriteConversation(id: SessionId, turns: readonly ConversationTurn[]): Promise<void> {
    await this.rewriteJsonl(this.conversationFile(id), turns)
  }

  /** Rewrite databus.jsonl from in-memory state (/undo journal rewrite). */
  async rewriteDatabus(id: SessionId, turns: readonly ToolTurn[]): Promise<void> {
    await this.rewriteJsonl(this.databusFile(id), turns)
  }

  /** Atomic rewrite: write .tmp → rename over the target (rename replaces on win32). */
  private async rewriteJsonl(filePath: string, rows: readonly unknown[]): Promise<void> {
    const tmp = `${filePath}.tmp`
    const body = rows.length === 0 ? '' : rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
    await writeFile(tmp, body, 'utf-8')
    await rename(tmp, filePath)
  }

  // ---- listing / lifecycle ----
  /** List session ids present on disk (has session.json). */
  async listSessionIds(): Promise<SessionId[]> {
    if (!existsSync(this.basePath)) return []
    const entries = await readdir(this.basePath, { withFileTypes: true })
    const ids: SessionId[] = []
    for (const e of entries) {
      if (e.isDirectory() && existsSync(join(this.basePath, e.name, 'session.json'))) {
        ids.push(e.name)
      }
    }
    return ids.sort()
  }

  /** Whether the snapshot (conversation.jsonl) still exists for this session. */
  async hasSnapshot(id: SessionId): Promise<boolean> {
    return existsSync(this.conversationFile(id))
  }

  /** Delete a session directory entirely (snapshot + state-line gradient). */
  async deleteSessionDir(id: SessionId): Promise<void> {
    this.deletedIds.add(id)
    await rm(this.sessionDir(id), { recursive: true, force: true })
  }

  /**
   * Prune snapshots whose conversation.jsonl / databus.jsonl are older than
   * ttlDays (based on session.json lastActiveAt). The state/ gradient is kept.
   * Returns the number of sessions whose snapshot was removed.
   */
  async pruneExpiredSnapshots(): Promise<number> {
    const now = Date.now()
    const cutoff = now - this.ttlDays * 24 * 60 * 60 * 1000
    let pruned = 0
    for (const id of await this.listSessionIds()) {
      const info = await this.readInfo(id)
      if (!info) continue
      if (info.lastActiveAt >= cutoff) continue
      // Snapshot expired: remove conversation.jsonl + databus.jsonl, keep state/.
      let removed = false
      for (const file of [this.conversationFile(id), this.databusFile(id)]) {
        if (existsSync(file)) {
          await rm(file, { force: true })
          removed = true
        }
      }
      if (removed) {
        pruned += 1
        await this.writeInfo({ ...info, snapshotExpired: true })
      }
    }
    return pruned
  }

  // ---- internal ----
  private async readJsonl<T>(filePath: string): Promise<T[]> {
    if (!existsSync(filePath)) return []
    const content = await readFile(filePath, 'utf-8')
    const out: T[] = []
    for (const line of content.split('\n')) {
      const t = line.trim()
      if (t.length === 0) continue
      try {
        out.push(JSON.parse(t) as T)
      } catch {
        // tolerant: skip corrupted line (append-only jsonl)
      }
    }
    return out
  }
}
