/**
 * when-to-read injection — v0.42（合并 memory_md + architecture_desc 两源）
 *
 * MEMORY.md / ARCHITECTURE.md 不再每轮全量注入，改为 when-to-read 机制：
 *   1. 引导段常驻（列出现存文档 + 说明全文按需读取）——每轮注入但极短；
 *   2. 文档内容哈希与"已读基线"不一致 → 未读 → 注入未读提示与选项
 *      （A = 读取 MEMORY.md 全文 · C = 读取 ARCHITECTURE.md 全文 · B = 暂不读取）；
 *   3. 模型在下一轮回复以选项字母开头 → 注入源从 ctx.conversationHistory
 *      自行解析（宽松：大小写/空白/标点/中文引导词/全角字母），命中则全量
 *      拉取对应文档喂进上下文，并把当前哈希写入基线（markread）；
 *   4. 选 B 或未识别 → 不拉取，未读保留（下轮继续提示）。
 *
 * 实验实证（probe-conversation-history.ts，2026-09-13）：注入源 inject() 时
 * ctx.conversationHistory 已含上一轮 assistant 完整回复文本——两轮语义自洽，
 * 无需 loop 传值、零新工具、不动状态机。
 *
 * 状态按 agentId 分桶：工作代理与子代理各自持有未读视图（子代理 loop 的
 * 首次 inject 以当时哈希建基线），避免子代理回复里偶然的 "A..." 误消费
 * 父代理的未读。会话生命周期单例，状态不落盘（重启后回到无提示基线）。
 */

import type { ContextInjectionSource, InjectionContext } from '../context-injection.js'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

/** 单个文档的未读视图。 */
type DocState = {
  /** 已读基线（上次喂给该模型的内容哈希）；null = 尚未建立（首次 inject 建立，不提示）。 */
  readHash: string | null
  pendingHash: string | null
}

type DocContent = { content: string; hash: string }

const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** 每个模型的未读视图组（memory + architecture + 上次已消费的选项回复）。 */
type AgentViewState = {
  memory: DocState
  architecture: DocState
  /** 已消费过选项的 assistant 回复原文——工具轮链中 content 为 null 时
   *  最后一条带文本的 assistant 仍是它，防止同一回复被反复消费。 */
  lastHonoredText: string | null
}

export function createWhenToReadInjection(): ContextInjectionSource {
  const views = new Map<string, AgentViewState>()

  const viewOf = (agentId: string | undefined): AgentViewState => {
    const key = agentId ?? ''
    let v = views.get(key)
    if (v === undefined) {
      v = {
        memory: { readHash: null, pendingHash: null },
        architecture: { readHash: null, pendingHash: null },
        lastHonoredText: null,
      }
      views.set(key, v)
    }
    return v
  }

  return {
    name: 'docs_when_to_read',
    priority: 15,
    position: 'afterUser',
    inject: async (ctx: InjectionContext) => {
      if (!ctx.workDir) return null
      const memoryDoc = await readMemoryDoc(ctx.workDir)
      const archDoc = await readArchitectureDoc(ctx.workDir)
      if (memoryDoc === null && archDoc === null) return null

      const view = viewOf(ctx.agentId)
      refreshPending(view.memory, memoryDoc)
      refreshPending(view.architecture, archDoc)

      // 上轮模型回复 → 宽松解析选项 → 命中未读则全量拉取 + 同步基线。
      const lastText = lastAssistantText(ctx.conversationHistory)
      let honoredMemory: string | null = null
      let honoredArch: string | null = null
      if (lastText !== null && lastText !== view.lastHonoredText) {
        const choice = parseChoice(lastText)
        if (choice === 'A' && view.memory.pendingHash !== null && memoryDoc !== null) {
          honoredMemory = memoryDoc.content
          view.memory.readHash = memoryDoc.hash
          view.memory.pendingHash = null
          view.lastHonoredText = lastText
        } else if (choice === 'C' && view.architecture.pendingHash !== null && archDoc !== null) {
          honoredArch = archDoc.content
          view.architecture.readHash = archDoc.hash
          view.architecture.pendingHash = null
          view.lastHonoredText = lastText
        }
        // B 或未识别：不拉取，未读保留。
      }

      const blocks: string[] = []
      // 引导段：列出现存文档（每轮常驻，极短）。
      const listing: string[] = []
      if (memoryDoc !== null) listing.push('- MEMORY.md — 跨会话记忆（项目索引、用户偏好、决策记录）')
      if (archDoc !== null) listing.push('- ARCHITECTURE.md — 架构描述（模块结构、核心依赖、扩展点）')
      blocks.push('# 工作区文档索引\n' + listing.join('\n') + '\n全文不随每轮注入；文档更新时会出现未读提示，按提示以选项字母开头回复即可读取全文。')

      if (honoredMemory !== null) blocks.push('【MEMORY.md 全文】\n' + honoredMemory)
      if (honoredArch !== null) blocks.push('【ARCHITECTURE.md 全文】\n' + honoredArch)

      // 未读提示（三选一同时给；仅列未读文档的选项 + B）。
      const options: string[] = []
      if (view.memory.pendingHash !== null) options.push('**A** = 读取 MEMORY.md 全文')
      if (view.architecture.pendingHash !== null) options.push('**C** = 读取 ARCHITECTURE.md 全文')
      if (options.length > 0) {
        options.push('**B** = 暂不读取')
        blocks.push(`⚠ **文档有未读变化**：以下一轮回复以选项字母开头——${options.join(' · ')}`)
      }

      return blocks.join('\n\n')
    },
  }
}

// ---- 文档读取 ---------------------------------------------------------------

async function readMemoryDoc(workDir: string): Promise<DocContent | null> {
  try {
    const content = await readFile(join(workDir, 'MEMORY.md'), 'utf-8')
    if (content.trim().length === 0) return null
    return { content, hash: sha16(content) }
  } catch {
    return null
  }
}

/**
 * ARCHITECTURE.md 经 "## 架构文档 path:" 字段引用子文档，实际注入的是子文档
 * 内容——哈希按最终注入内容计算（与旧 architecture_desc 的可见行为一致：
 * 主文档除该字段外的变化从不进入注入面）。
 */
async function readArchitectureDoc(workDir: string): Promise<DocContent | null> {
  try {
    const raw = await readFile(join(workDir, 'ARCHITECTURE.md'), 'utf-8')
    const match = raw.match(/## 架构文档\s*\n\s*path:\s*(.+)/)
    if (!match || match[1] === undefined) return null
    const docPath = resolve(workDir, match[1].trim())
    const content = await readFile(docPath, 'utf-8').catch(() => null)
    if (content === null || content.trim().length === 0) return null
    const trimmed = content.trim()
    return { content: trimmed, hash: sha16(trimmed) }
  } catch {
    return null
  }
}

/** 对比当前内容与已读基线，刷新未读。首次见到（基线 null）只建基线不提示。 */
function refreshPending(state: DocState, doc: DocContent | null): void {
  if (doc === null) {
    state.pendingHash = null
    return
  }
  if (state.readHash === null) {
    state.readHash = doc.hash
    state.pendingHash = null
    return
  }
  state.pendingHash = doc.hash !== state.readHash ? doc.hash : null
}

// ---- 上轮回复与选项解析 -----------------------------------------------------

/** 最后一条带非空文本的 assistant 回复（跳过 content 为 null 的工具轮）。 */
function lastAssistantText(history: readonly unknown[]): string | null {
  const turns = history as ReadonlyArray<{ role?: string; content?: unknown }>
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!
    if (t.role === 'assistant' && typeof t.content === 'string' && t.content.trim().length > 0) {
      return t.content
    }
  }
  return null
}

/**
 * 宽松选项解析（用户拍板：大小写/空白/标点/中文夹杂均可识别）。
 * 单层正则：行首允许任意个（空白/括号/标点/加粗星号/反引号/中文引导词
 * 选|选择|答|答案），随后一个选项字母（含全角），其后不得紧跟 ASCII 字母
 * ——"A。" "B 暂不需要" "（选）A" "**答案：A**" 命中；"API 设计" "Apple" 不命中。
 */
const CHOICE_RE =
  /^(?:[\s()[\]:,.!?"'\u2018\u2019\u201c\u201d·、\-*`【】（）：，。！？—-]|选|选择|答|答案)*?([A-Ca-c])(?![A-Za-z])/

export function parseChoice(text: string): 'A' | 'B' | 'C' | null {
  // NFKC 先把全角字母/标点（Ｃ、（）：等）归一为 ASCII，单层正则即可覆盖。
  const t = text.trim().normalize('NFKC')
  const m = t.match(CHOICE_RE)
  if (m === null) return null
  const c = m[1]!.toUpperCase()
  return c === 'A' || c === 'B' || c === 'C' ? c : null
}
