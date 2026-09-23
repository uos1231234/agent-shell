import type { AgentId } from '../databus.js'
import type { AgentTree } from '../sub-agent/tree.js'
import type { MailItem } from './types.js'

// v0.11.1 P2.5: sender names reserved for system use. Sub-agents and tools
// must not impersonate these senders — only the system (drive-coordinator,
// warehouse, etc.) may send from them.
const RESERVED_SENDERS = new Set(['databus', 'system', 'drive-coordinator'])

// v0.11.1 P2.6: capacity limits to prevent unbounded mailbox growth.
const MAX_INBOX_SIZE = 1000
const MAX_BODY_LENGTH = 10_000

/**
 * 单次读信条数上限（用户拍板 2026-09-22）：mailbox_read / mailbox_read_any
 * 实际返回超过此数即报错，指引分页（offset）或委派召回代理——防止模型一次
 * 把几百封邮件全文拉进上下文打爆窗口。判据在**工具层按实际返回条数**执行
 * （不看 limit 参数：不传 limit 的全量读才是真正的敞口）。
 */
export const MAX_MAILS_PER_READ = 50

/**
 * 邮件存活天数（按 `sentAt` 计）。
 *
 * v0.34 D5/D12（用户拍板 2026-09-10）：邮件**读完不删除**（`markRead` 只置
 * `read`/`readAt`），而是 **3 天后过期自动删除** —— 与 `SessionStore` 的会话快照
 * TTL 同口径。宿主装配时应传 `store.ttlDays` 覆盖，以保持"一处常量"；
 * 本常量只是无宿主场景（examples / 单测）的缺省。
 */
export const DEFAULT_MAIL_TTL_DAYS = 3
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 邮件落盘端口（v0.34 D10）。**返回 void 是刻意的**：`Mailbox.send` /
 * `systemSend` 是同步 API（被 LLM 工具与 drive-coordinator 同步调用），
 * 实现方在内部处理异步写入与错误——不为落盘把整条发送路径改成 async。
 *
 * `rewrite`（2026-09-11 用户拍板方案 A）：内存态变化后的**全量回写**——
 * `markRead` 只改内存，append-only 端口写不进 read 状态，重启后已读回退
 * 未读。Mailbox 传入权威快照（`dump()`，已过滤过期），实现方负责落盘；
 * append 与 rewrite 是不同形态的文件写，实现方应自行串行化（见 assembly
 * 的写队列）。
 */
export type MailboxPersistence = {
  append(item: MailItem): void
  rewrite(items: readonly MailItem[]): void
}

export type MailboxOptions = {
  persistence?: MailboxPersistence
  /** 邮件存活天数，缺省 `DEFAULT_MAIL_TTL_DAYS`。宿主应传 `store.ttlDays`。 */
  ttlDays?: number
}

export class Mailbox {
  private readonly inboxes: Map<AgentId, MailItem[]> = new Map()
  private nextId: number = 0
  // v0.12: optional AgentTree for route enforcement. When present, send()
  // rejects messages between agents not in the same lineage (self, parent/
  // child, grandparent/grandchild, siblings). When absent, Mailbox behaves
  // exactly as before — no route checks (backward compat). Declared as
  // `| undefined` (not `?`) to stay compatible with exactOptionalPropertyTypes.
  private readonly agentTree: AgentTree | undefined
  private readonly persistence: MailboxPersistence | undefined
  private readonly ttlMs: number

  constructor(agentTree?: AgentTree, opts?: MailboxOptions) {
    this.agentTree = agentTree
    this.persistence = opts?.persistence
    this.ttlMs = (opts?.ttlDays ?? DEFAULT_MAIL_TTL_DAYS) * DAY_MS
  }

  /** 过期判定：按 `sentAt` 起算（D12——与会话快照 TTL 同口径）。 */
  private isExpired(item: MailItem, now: number): boolean {
    return now - item.sentAt > this.ttlMs
  }

  /**
   * 清掉某信箱里过期的邮件，返回清掉条数。
   * 在**写入前**调用：否则过期邮件会一直占着 MAX_INBOX_SIZE 的容量，把新邮件挡在
   * "inbox is full" 之外——这与"3 天后自动删除"的意图相反。
   */
  private purgeExpired(agentId: AgentId, now: number): number {
    const inbox = this.inboxes.get(agentId)
    if (inbox === undefined) return 0
    const kept = inbox.filter((item) => !this.isExpired(item, now))
    const dropped = inbox.length - kept.length
    if (dropped > 0) this.inboxes.set(agentId, kept)
    return dropped
  }

  /**
   * 清掉全部信箱里的过期邮件，返回清掉条数。宿主在会话恢复时调用一次，把结果
   * 写回 `mailbox.jsonl`（否则文件只增不减）。
   */
  pruneExpired(): number {
    const now = Date.now()
    let dropped = 0
    for (const agentId of [...this.inboxes.keys()]) {
      dropped += this.purgeExpired(agentId, now)
    }
    return dropped
  }

  /**
   * 从落盘邮件回灌（会话恢复路径）。跳过过期、按 (信箱, id) 去重，并推进
   * `nextId` 以避免新邮件与历史 id 冲突。返回实际装入条数。
   */
  restore(items: readonly MailItem[]): number {
    const now = Date.now()
    let loaded = 0
    for (const item of items) {
      if (this.isExpired(item, now)) continue
      let inbox = this.inboxes.get(item.to)
      if (inbox === undefined) {
        inbox = []
        this.inboxes.set(item.to, inbox)
      }
      if (inbox.some((m) => m.id === item.id)) continue
      inbox.push(item)
      loaded += 1
      // id 形如 `M-<seq>-<base36>`：恢复 seq 上界，避免新邮件 id 撞历史。
      const seq = Number.parseInt(item.id.split('-')[1] ?? '', 10)
      if (Number.isFinite(seq) && seq > this.nextId) this.nextId = seq
    }
    return loaded
  }

  // v0.12: verify that `from` may send to `to` per the AgentTree lineage rules.
  // Throws on rejection. No-op when no tree is configured. Self-mail (from ===
  // to) is always allowed (plan §7.3). Unknown agents fail closed inside
  // AgentTree.canCommunicate.
  private verifyRoute(from: AgentId, to: AgentId): void {
    if (this.agentTree === undefined) return
    if (from === to) return
    if (this.agentTree.canCommunicate(from, to)) return
    throw new Error(`Mailbox route rejected: "${from}" cannot send to "${to}" (not in same lineage)`)
  }

  // Public send — used by the mailbox_send tool (LLM-facing). Enforces
  // P2.5 reserved-sender isolation and P2.6 capacity limits. A sub-agent
  // cannot impersonate 'databus', 'system', or 'drive-coordinator'.
  // v0.12: when an AgentTree is configured, enforces lineage route checks
  // across ALL recipients before any delivery (no partial delivery on reject).
  send(msg: { from: AgentId; to: AgentId | AgentId[]; subject: string; body: string; replyTo?: string; summary?: string }): string {
    if (RESERVED_SENDERS.has(msg.from)) {
      throw new Error(`Mailbox sender name '${msg.from}' is reserved for system use`)
    }
    const recipients = Array.isArray(msg.to) ? msg.to : [msg.to]
    for (const to of recipients) {
      this.verifyRoute(msg.from, to)
    }
    return this.deliver(msg)
  }

  // System-internal send — used by databus_subscribe, drive-coordinator, and
  // other framework code that legitimately sends from a reserved identity.
  // Not exported to tools; only the framework calls this directly.
  systemSend(msg: { from: AgentId; to: AgentId | AgentId[]; subject: string; body: string; replyTo?: string; summary?: string }): string {
    return this.deliver(msg)
  }

  private deliver(msg: { from: AgentId; to: AgentId | AgentId[]; subject: string; body: string; replyTo?: string; summary?: string }): string {
    if (msg.body.length > MAX_BODY_LENGTH) {
      throw new Error(`Mailbox message body exceeds ${MAX_BODY_LENGTH} characters`)
    }
    const id = `M-${++this.nextId}-${Date.now().toString(36)}`
    const recipients = Array.isArray(msg.to) ? msg.to : [msg.to]
    const sentAt = Date.now()
    for (const to of recipients) {
      // 写入前先清过期（v0.34）：否则过期邮件会一直占着 MAX_INBOX_SIZE 的容量，
      // 把新邮件挡在 "inbox is full" 之外——与"3 天后自动删除"的意图相反。
      this.purgeExpired(to, sentAt)
      let inbox = this.inboxes.get(to)
      if (!inbox) {
        inbox = []
        this.inboxes.set(to, inbox)
      }
      if (inbox.length >= MAX_INBOX_SIZE) {
        throw new Error(`Inbox for '${to}' is full (${MAX_INBOX_SIZE} messages)`)
      }
      const item: MailItem = {
        id,
        from: msg.from,
        to,
        subject: msg.subject,
        body: msg.body,
        sentAt,
        read: false,
      }
      if (msg.replyTo !== undefined) {
        item.replyTo = msg.replyTo
      }
      if (msg.summary !== undefined) {
        // 不截断（2026-09-12 用户拍板）：summary 原样投递。
        item.summary = msg.summary
      }
      inbox.push(item)
      // v0.34 D10：落盘（fire-and-forget）。多收件人时同一 id 会为每个收件人各写
      // 一行——`to` 字段区分归属，恢复时按 (信箱, id) 去重。
      this.persistence?.append(item)
    }
    return id
  }

  readOwnInbox(agentId: AgentId, opts?: { unreadOnly?: boolean; limit?: number; offset?: number }): readonly MailItem[] {
    const inbox = this.inboxes.get(agentId)
    if (!inbox) return []
    // v0.34 D11：读取时惰性过滤过期邮件——两次写入之间也可能跨过 TTL 边界，
    // 不能只靠写入前/恢复时的清理。
    const now = Date.now()
    let result = inbox.filter((item) => !this.isExpired(item, now))
    if (opts?.unreadOnly !== false) {
      result = result.filter(item => !item.read)
    }
    result.sort((a, b) => a.sentAt - b.sentAt)
    // offset（2026-09-22）：配合 MAX_MAILS_PER_READ 的 50 封/批上限翻页。
    // 先切 offset 再套 limit，模型才能按 sentAt 升序逐页读完一个大信箱。
    if (opts?.offset !== undefined && opts.offset > 0) {
      result = result.slice(opts.offset)
    }
    if (opts?.limit !== undefined) {
      result = result.slice(0, opts.limit)
    }
    return result
  }

  markRead(agentId: AgentId, ids?: readonly string[]): void {
    const inbox = this.inboxes.get(agentId)
    if (!inbox) return
    const readAt = Date.now()
    let changed = 0
    if (ids) {
      const idSet = new Set(ids)
      for (const item of inbox) {
        if (idSet.has(item.id)) {
          item.read = true
          item.readAt = readAt
          changed += 1
        }
      }
    } else {
      for (const item of inbox) {
        if (!item.read) {
          item.read = true
          item.readAt = readAt
          changed += 1
        }
      }
    }
    // 热路径回写（2026-09-11 方案 A）：append-only 写不进 read 状态，重启后
    // 已读回退未读。有实际变更才回写——dump() 已过滤过期，顺带压紧文件。
    // markRead 是低频操作（显式读信），全量重写的代价可忽略。
    if (changed > 0) this.persistence?.rewrite(this.dump())
  }

  // v0.12.1: sender-side read receipt query. Only mails SENT BY `agentId`
  // are visible — privacy invariant: no other agent's mail content or
  // existence is exposed. `found: false` covers unknown ids and evicted/
  // foreign mails alike, without leaking which.
  sentStatus(agentId: AgentId, mailId: string): {
    found: boolean; read: boolean; summary: string | undefined;
    sentAt: number | undefined; readAt: number | undefined; ageMs: number; now: number
  } {
    const now = Date.now()
    for (const inbox of this.inboxes.values()) {
      const item = inbox.find((m) => m.id === mailId)
      if (item !== undefined && item.from === agentId) {
        return {
          found: true,
          read: item.read,
          summary: item.summary,
          sentAt: item.sentAt,
          readAt: item.read ? item.readAt : undefined,
          ageMs: now - item.sentAt,
          now,
        }
      }
    }
    return { found: false, read: false, summary: undefined, sentAt: undefined, readAt: undefined, ageMs: 0, now }
  }

  /**
   * 导出全部**未过期**的在存邮件（落盘回写用）。
   *
   * 为什么需要它：`mailbox.jsonl` 是 append-only，过期条目不会被自动擦除。
   * 宿主在会话恢复时用 `restore()` 装载、再按需 `dump()` 把清理后的集合回写，
   * 否则文件只增不减。过期判定留在本类，不泄漏到宿主。
   */
  dump(): readonly MailItem[] {
    const now = Date.now()
    const out: MailItem[] = []
    for (const inbox of this.inboxes.values()) {
      for (const item of inbox) {
        if (!this.isExpired(item, now)) out.push(item)
      }
    }
    return out
  }

  hasUnread(agentId: AgentId): boolean {
    const inbox = this.inboxes.get(agentId)
    if (!inbox) return false
    const now = Date.now()
    // v0.34 D11：过期邮件不计为未读（惰性过滤，同 readOwnInbox）。
    return inbox.some(item => !item.read && !this.isExpired(item, now))
  }

  inboxSize(agentId: AgentId): number {
    const inbox = this.inboxes.get(agentId)
    if (inbox === undefined) return 0
    const now = Date.now()
    return inbox.filter((item) => !this.isExpired(item, now)).length
  }
}
