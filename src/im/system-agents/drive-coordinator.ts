// v0.10.4: Deterministic task-block selector + auto-drive coordinator.
//
// The coordinator runs fire-and-forget at the end of each working round.
// When context crosses the M1 threshold (>=200K), it finds one complete
// task block from canonical memory — a user turn through just before the
// next user turn, containing at least one tool turn and passing pairing
// validation — and delivers it directly to the compressor as ChatMessage[].
//
// v0.12.4 atomicity: the compressor no longer calls record_curated_block.
// Instead it returns a CuratedMemory JSON object as its final reply. The
// coordinator parses + validates that JSON, then performs the full
// persistence sequence atomically (appendBlock → rawArchive.append →
// evictRange → envelope insert → rewriteSnapshot) in one try block with no
// LLM between the IO calls. If any step throws, a mailbox note is sent and
// stores remain unchanged (eviction is aborted — no data loss).
//
// 2026-09-13 用户拍板方案 A：块压缩**不再** databus.evictByIds。canonical
// evict 腾 LLM 上下文；databus 是工具事件召回库（ADR-016），戳 = 全文哈希，
// 清空 databus = 工具级戳永久死链。工具全文随会话 TTL 留在 databus。
//
// At M3 (>=900K), curated M1/M2 material is handed to the warehouse agent
// for archival (one-shot on the crossing). The compression drive also
// continues on every M3 tick: M3 is the terminal layer, so crossing-only
// dispatch would strand canonical memory at high-water with no recovery
// path. M3 content is never injected into the working prompt.
//
// Constraints (plan §1): no timestamp sort, no toolCallId reconstruction,
// no Databus query for block content, no free-text parser, no new
// guard/metric/config field. The canonical sequence is the only ordering
// authority.

import type { ConversationTurn, ConversationMemory } from '../conversation-memory.js'
import type { Databus } from '../databus.js'
import type { ChatMessage } from '../../protocol/types.js'
import { turnToMessage, turnToMessageWithCounter, mintTurnId } from '../turn.js'
import { classifyMemoryLayer, type MemoryLayer, type SignalBus } from '../memory-layers.js'
import type { MemoryConfig } from '../../shell/memory-config.js'
import { DEFAULT_MEMORY_CONFIG } from '../../shell/memory-config.js'
import type { SystemAgent } from '../system-agent.js'
import type { StateLine, RawArchiveRecord, CuratedMemory, M3Summary, StampLineageEntry } from '../state-line/types.js'
import { validateCuratedMemory } from '../state-line/index.js'
import type { Mailbox } from '../mailbox/index.js'
import type { AgentId } from '../databus.js'
import type { Logger } from '../../shared/logger.js'
import { defaultLogger } from '../../shared/logger.js'
// v0.41（D12 压缩率可观测）：比较产出信封与原块的规模。用 CJK 感知口径，
// 不用 chars/4（对中文低估 3-6 倍，见 shared/token-estimate.ts 头注释）。
import { GENERIC_TOKEN_COUNTER, type TokenCounter } from '../../shared/token-counter.js'
// 压缩失败调试：compressor 原始回复落盘（仅当 parse 完全失败时写）。
import { appendFileSync } from 'node:fs'

// 常驻诊断通道（2026-09-17 用户拍板保留）：env COMPRESSOR_DEBUG_LOG 指向落盘
// 路径；空 = 关闭。仅在压缩器回复完全无法解析时写入前 1000 字符，用于压缩
// 有效性分析（§6.24 可观测性口径）时抓取模型真实输出。诊断用，非截断机制。
const COMPRESSOR_DEBUG_LOG = process.env['COMPRESSOR_DEBUG_LOG'] ?? ''

// ---------------------------------------------------------------------------
// TaskBlock — the deterministic slice selected from canonical memory.
// ---------------------------------------------------------------------------

export type TaskBlock = {
  startIndex: number
  endIndexExclusive: number
  startUserTurnId: string
  boundaryUserTurnId: string
  turns: readonly ConversationTurn[]
  messages: readonly ChatMessage[]
  toolTurnIds: readonly string[]
}

/**
 * 块尺寸的统一估算口径（v0.41）：wire 形态序列化后按 CJK 感知估算，与
 * loop 的 estimateContextTokens（同为 turnToMessage 之后 stringify）同源。
 *
 * 住在这里而不是 goal/ 是因为它是 TaskBlock 的属性；两个消费者（G1 的触发
 * 判定、D12 的压缩率上报）都从这里取，避免 goal/ 与本模块双向依赖。
 */
export const estimateBlockTokens = (block: TaskBlock, tokenCounter = GENERIC_TOKEN_COUNTER): number =>
  tokenCounter.count(block.messages.map(m => JSON.stringify(m)).join(''))

// ---------------------------------------------------------------------------
// findNextTaskBlock — scan canonical turns for one eligible user-to-next-user
// span (v0.30 B4: tool turns no longer required — pure-conversation spans are
// eligible) that passes pairing validation when it contains tool turns.
// Returns undefined when no eligible block exists from `fromIndex`.
// ---------------------------------------------------------------------------

// 块边界判据（**一处事实源**）：findNextTaskBlock 用它选块，locateTaskBlock 用
// 它在并发落盘后重新定位同一个块。两处必须同判据——否则"重定位"会认出一个
// 与选块时不同边界的区间，逐出就打到错误的回合上。
const isEnvelope = (t: ConversationTurn): boolean =>
  t.role === 'user' && t.id.startsWith('mem-')

// 用户停止标记回合（id 前缀 'stop-'，turn.ts buildUserStopMarkerTurn）：
// 不作为块起点/边界——它是被打断块的**终止符号**（上一条真实 user 回合是
// 起始符号），必须留在切片内作为块的最后一条消息，compressor 才能看到它并
// 按提示词把该块标为 DONE（2026-09-17 用户拍板）。与信封相反：信封出切片，
// 停止标记留切片。
const isStopMarker = (t: ConversationTurn): boolean =>
  t.role === 'user' && t.id.startsWith('stop-')

const isBoundaryCandidate = (t: ConversationTurn): boolean =>
  t.role === 'user' && !isEnvelope(t) && !isStopMarker(t)

// 块的**下界 fence**（2026-09-22 根因修复，用户拍板）：mem- 信封自己不开始新块，
// 但**必须终结前面的块**。信封是已关闭块的替代物——块跨过它 = 对已压缩摘要做二次
// 有损压缩。MRCR-3M r1 实证事故：失败块重试时跨度跨过 S10-13 的四个信封长成 6 条
// （turnCount 2→4→6），最后一次"成功"把四个信封正文连同血缘一并销毁，窗口里这四节
// 凭空消失。findNextTaskBlock 与 locateTaskBlock 必须同用本判据（见文件头"一处
// 事实源"注释）。
const isBlockEndFence = (t: ConversationTurn): boolean =>
  isBoundaryCandidate(t) || isEnvelope(t)

/**
 * 重新定位一个**已经选好、但 canonical 可能已经漂移**的块（C3 受控并行的落盘
 * 前置检查）。
 *
 * 为什么必须重定位：块区间在 `findNextTaskBlock` 时按下标记录，而落盘排在
 * LLM 调用之后。并行度 > 1 时，更早领取槽位的块会先完成"逐出 + 原位插信封"，
 * 数组下标整体前移；单飞时宿主也可能在飞期间追加回合。按 id 重定位并**逐字
 * 核对切片成员**，任何不一致都视为漂移。
 *
 * 返回 undefined = 该块不再原样占据某段连续区间（起点消失 / 无右边界 / 成员
 * 变了）。调用方必须 fail closed：不逐出、不留写。
 */
export function locateTaskBlock(
  turns: readonly ConversationTurn[],
  block: TaskBlock,
): { startIndex: number; endIndexExclusive: number } | undefined {
  const startIndex = turns.findIndex((t) => t.id === block.startUserTurnId)
  if (startIndex === -1) return undefined

  let endIndexExclusive = -1
  for (let i = startIndex + 1; i < turns.length; i += 1) {
    if (isBlockEndFence(turns[i]!)) {
      endIndexExclusive = i
      break
    }
  }
  if (endIndexExclusive === -1) return undefined

  const live = turns.slice(startIndex, endIndexExclusive)
  if (live.length !== block.turns.length) return undefined
  for (let i = 0; i < live.length; i += 1) {
    if (live[i]!.id !== block.turns[i]!.id) return undefined
  }
  return { startIndex, endIndexExclusive }
}

export function findNextTaskBlock(
  turns: readonly ConversationTurn[],
  fromIndex = 0,
  skipStartUserTurnIds?: ReadonlySet<string>,
  tokenCounter?: TokenCounter,
): TaskBlock | undefined {
  // Find the first user turn at or after fromIndex.
  let startIndex = -1
  for (let i = fromIndex; i < turns.length; i += 1) {
    if (isBoundaryCandidate(turns[i]!)) {
      startIndex = i
      break
    }
  }
  if (startIndex === -1) return undefined

  // Find the next boundary fence (real user turn OR mem- envelope) after
  // startIndex — the fence keeps a block from ever spanning an envelope.
  let endIndexExclusive = -1
  for (let i = startIndex + 1; i < turns.length; i += 1) {
    if (isBlockEndFence(turns[i]!)) {
      endIndexExclusive = i
      break
    }
  }
  // No next user boundary yet — the span is incomplete, not a block.
  if (endIndexExclusive === -1) return undefined

  // 跳过已标记失败的块：前一块压缩失败不消费跨越位，下一 tick 从
  // endIndexExclusive 继续扫，尝试后续块。参考同类实现：
  // "只有压缩成功才写 compressedLayer，降级摘要不进缓存——否则一次 API
  // 故障会被永久固化，后续轮次再也不会重试压缩。"
  if (skipStartUserTurnIds?.has(turns[startIndex]!.id)) {
    return findNextTaskBlock(turns, endIndexExclusive, skipStartUserTurnIds, tokenCounter)
  }

  const slice = turns.slice(startIndex, endIndexExclusive)

  // v0.30 (B4, 用户拍板 2026-09-09): 块 = user→next-user 跨度本身，不再要求
  // "≥1 工具轮"——纯对话回合（无工具）同样是合法任务块，纯文本会话从此可以被
  // 压缩（此前它们永远不会触发 M1，也无法在会话收尾被压缩）。配对校验
  // （validatePairing）保留：含工具轮的块仍须通过防半块校验；纯对话块不含
  // tool turn，校验自然通过。toolTurnIds 允许为空。
  const toolTurnIds: string[] = []
  for (const t of slice) {
    if (t.role === 'tool') {
      toolTurnIds.push(t.id)
    }
  }

  // Pairing validation: no leading tool, no orphan tool result, no
  // outstanding assistant tool_call at the end of the slice.
  if (!validatePairing(slice)) {
    return findNextTaskBlock(turns, endIndexExclusive, skipStartUserTurnIds, tokenCounter)
  }

  const startUserTurnId = slice[0]!.id
  const boundaryTurn = turns[endIndexExclusive]!
  // boundaryTurn is guaranteed to be role:'user' by the scan above.
  const boundaryUserTurnId = boundaryTurn.id

  const messages = slice.map(turn => turnToMessageWithCounter(turn, tokenCounter))

  return {
    startIndex,
    endIndexExclusive,
    startUserTurnId,
    boundaryUserTurnId,
    turns: slice,
    messages,
    toolTurnIds,
  }
}

// File-local pairing validation. Rejects:
//   - a leading tool turn (tool before any assistant tool_call)
//   - a tool whose tool_call_id is not outstanding from a prior assistant
//   - an assistant tool_call that remains outstanding (no matching tool result)
function validatePairing(slice: readonly ConversationTurn[]): boolean {
  if (slice.length === 0) return false
  if (slice[0]!.role === 'tool') return false

  // Collect all tool_call ids declared by assistant turns, in order.
  const outstanding = new Set<string>()
  for (const turn of slice) {
    if (turn.role === 'assistant') {
      if (turn.toolCalls) {
        for (const tc of turn.toolCalls) {
          outstanding.add(tc.id)
        }
      }
    }
    if (turn.role === 'tool') {
      if (!outstanding.has(turn.toolCallId)) return false
      outstanding.delete(turn.toolCallId)
    }
  }
  // Every assistant tool_call must have a matching tool result within the slice.
  if (outstanding.size > 0) return false
  return true
}

// ---------------------------------------------------------------------------
// parseCuratedMemoryOutput — extract a CuratedMemory object from the
// compressor's final reply. The compressor is instructed to reply with pure
// JSON, but we tolerate ```json ... ``` fenced blocks as a fallback (some
// models wrap JSON in markdown fences despite instructions). Throws on
// unrecoverable parse failure or schema validation failure — the caller's
// catch block turns that into a mailbox notice (no eviction, no data loss).
// ---------------------------------------------------------------------------

export function parseCuratedMemoryOutput(output: unknown): CuratedMemory {
  if (typeof output !== 'string') {
    throw new Error('compressor produced no reply text (expected CuratedMemory JSON)')
  }
  const trimmed = output.trim()
  if (trimmed.length === 0) {
    throw new Error('compressor reply was empty (expected CuratedMemory JSON)')
  }

  let obj: unknown
  // First attempt: the reply is pure JSON.
  try {
    obj = JSON.parse(trimmed)
  } catch {
    // Fallback: the reply wraps JSON in a ```json ... ``` (or ``` ... ```)
    // markdown fenced block. Strip the fence and retry.
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (!fenceMatch) {
      // 调试：压缩失败时把 compressor 原始回复前部落盘（仅当完全解析失败执行，
      // 不影响成功路径；落盘失败不阻断 dispatch）。
      if (COMPRESSOR_DEBUG_LOG !== '') {
        try {
          appendFileSync(
            COMPRESSOR_DEBUG_LOG,
            `${new Date().toISOString()} LN=${trimmed.length}\n${trimmed.slice(0, 1000)}\n---\n`,
          )
        } catch { /* debug logging must never break dispatch */ }
      }
      throw new Error('compressor reply was not valid JSON and contained no ```json fenced block')
    }
    const inner = fenceMatch[1]!.trim()
    try {
      obj = JSON.parse(inner)
    } catch {
      throw new Error('compressor reply contained a ```json fenced block but its content was not valid JSON')
    }
  }

  // Validate the parsed object against the 11-field CuratedMemory schema.
  // validateCuratedMemory throws on missing required fields.
  validateCuratedMemory(obj as CuratedMemory)
  return obj as CuratedMemory
}

// ---------------------------------------------------------------------------
// Envelope replacement block (2026-09-13 用户拍板，机制参考同类实现
// context-amplifier 的 renderBlockMessage)：压缩逐出后，原位置插入一条
// role:'user' 的替代回合——参考实现 同款闭合信封（#STAMP 头 + #END_BLOCK 尾），
// 正文完整渲染 CuratedMemory（不截断）。没有它，模型视野在原块位置静默留空，
// 既不知道"这里被压缩过"也不知道戳的存在（根因见工作区 AGENTS.md §6.26）。
// ---------------------------------------------------------------------------

const renderEnvelopeBody = (m: CuratedMemory): string => {
  const lines: string[] = []
  lines.push(`[任务] ${m.task_goal}`)
  if (m.causal_steps.length > 0) {
    lines.push('[因果链]')
    m.causal_steps.forEach((s, i) => {
      lines.push(`  ${i + 1}. 意图: ${s.intent}`)
      lines.push(`     工具: ${s.tool_action}`)
      lines.push(`     结果: ${s.result}`)
    })
  }
  if (m.evidence_fragments.length > 0) {
    lines.push('[证据片段]')
    for (const e of m.evidence_fragments) lines.push(`  - ${e.source}: ${e.fragment}（${e.relevance}）`)
  }
  lines.push(`[结论] ${m.conclusion}`)
  lines.push(`[下一步] ${m.next_action}`)
  lines.push('[工作状态]')
  lines.push(`  当前目标: ${m.working_state.current_goal}`)
  for (const d of m.working_state.effective_decisions) lines.push(`  已生效决策: ${d}`)
  for (const d of m.working_state.rejected_decisions) lines.push(`  已否决决策: ${d}`)
  for (const b of m.working_state.architecture_boundaries) lines.push(`  架构边界: ${b}`)
  for (const w of m.working_state.remaining_work) lines.push(`  待办: ${w}`)
  return lines.join('\n')
}

/** 截断到 n 字符（covers 一行式专用：防止长结论把 #LINEAGE 清单撑爆）。 */
const truncateCovers = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n)}…`

/**
 * 单封邮件正文预算（2026-09-22）。mailbox.deliver 的硬上限是 10_000 字符，
 * 超了直接抛错拒收——而墓碑的 systemSend 外面就是 catch+log.error，拒收 =
 * **墓碑静默丢失**（归档成功但模型失去换出痕迹）。所以发送前自检：正常体
 * 超预算就降级成"只报数量+原戳+召回方式"的紧凑体。宁可少列几条 covers，
 * 不能让通知发不出去。9_000 留 1_000 余量给未来文案增量。
 */
export const MAIL_BODY_BUDGET = 9_000
export const fitMailBody = (body: string, fallback: string): string =>
  body.length <= MAIL_BODY_BUDGET ? body : fallback

/**
 * 从信封正文解析一行"内容描述"（Node 侧生成，LLM 永不产出）：
 * `任务=<task_goal>；结论=<conclusion>`，各截断到 60/80 字符。
 *
 * 用途：(1) G2 信封 #LINEAGE 逐戳清单的 covers 列；(2) mailbox 换出墓碑。
 * 目的：模型**不召回**也能判断某个戳大概对应什么、值不值得查——戳的
 * 可发现性不能依赖"先召回才知道里面是什么"（用户拍板 2026-09-22）。
 */
export const parseEnvelopeCovers = (content: string): string => {
  const goal = content.match(/^\[任务\]\s*(.*)$/m)?.[1]?.trim() ?? ''
  const conclusion = content.match(/^\[结论\]\s*(.*)$/m)?.[1]?.trim() ?? ''
  if (goal === '' && conclusion === '') return '（信封无任务/结论行）'
  return `任务=${truncateCovers(goal, 60) || '（空）'}；结论=${truncateCovers(conclusion, 80) || '（空）'}`
}

/**
 * 信封世代：1 = 原始块直接压缩产物（G1），2 = 信封折叠产物（G2）。
 * 判据 = 是否存在 `#LINEAGE` 标记行（buildCompressionEnvelope 只给二代块渲染它）。
 *
 * 服务于代数硬闸（用户拍板 2026-09-22）：**只允许 G1→G2，禁止 G2→G3**——
 * 二代信封本身已是 LLM 转写产物，再折叠就是转写的转写（复利保真损失
 * p^n），且血缘要多跳。窗口压力改由 M3 归档出口承接（换出 + 墓碑 + 可召回）。
 */
export const envelopeGeneration = (content: string): 1 | 2 =>
  /^#LINEAGE\b/m.test(content) ? 2 : 1

export const buildCompressionEnvelope = (
  stamp: string,
  zone: 'M1' | 'M2',
  memory: CuratedMemory,
  lineage?: readonly StampLineageEntry[],
): string => {
  const status = memory.status_hint === 'DONE' ? 'DONE' : 'PENDING'
  // #STATUS 语义与 参考实现 一致：DONE 已结束、PENDING 尚未结束——提示词告诫
  // 模型不得把 PENDING 当已完成；#END_BLOCK 防止跨块混合事实。
  //
  // v0.41 G2：折叠块必须**逐戳**交代血缘。否则模型看到的是一个来历不明的块，
  // 既不知道它比看上去更"厚"，也无法按原戳召回被合并的那几块（§6.26
  // 可发现性判据：信息变形后，模型必须能发现并召回）。#LINEAGE 每行一个原戳，
  // 带代际与 covers（任务/结论一行式）——不召回就知道每个戳大概讲什么、
  // 是第几代（用户拍板 2026-09-22）。硬闸下被折叠信封全是一代，其祖先集 =
  // 自身，故这份清单即**全展平**血缘，任意原始戳一步 state_query 命中。
  const lineageBlock = lineage !== undefined && lineage.length > 0
    ? [
        `#LINEAGE gen=2 sources=${lineage.length}`,
        ...lineage.map((e) => `  - ${e.stamp} (gen=${e.generation}): ${e.covers}`),
      ].join('\n')
    : ''
  const lineageNote = lineageBlock !== ''
    ? '。本块为二代折叠（gen=2），全部一代原戳及各自内容见下方 #LINEAGE，可按戳单独召回：state_query({stamps:[\'<原戳>\']})'
    : ''
  return [
    `#STAMP ${stamp}`,
    `#LAYER ${zone}`,
    `#STATUS ${status}`,
    `#NOTE 对话序列经 raw-archive 保留；工具全文仍在 databus（工具戳可 databus_query）。块召回：state_query({layer:'${zone}',stamps:['${stamp}']}) 或 ask_recall${lineageNote}`,
    ...(lineageBlock !== '' ? [lineageBlock] : []),
    renderEnvelopeBody(memory),
    '#END_BLOCK',
  ].join('\n')
}

// ---------------------------------------------------------------------------

export type DriveSnapshot = {
  contextTokens: number
  conversation: ConversationMemory
  databus: Databus
  // v0.14: caller-supplied memory-layer thresholds. The coordinator's
  // classifyMemoryLayer call uses this so its layer decision agrees with the
  // loop's projection. Optional — defaults to DEFAULT_MEMORY_CONFIG inside
  // the tick (identical to the pre-v0.14 module-constant path).
  memoryConfig?: MemoryConfig
  /** Provider/model counter selected by the host for this run. */
  tokenCounter?: TokenCounter
}

/**
 * v0.29 Wave B2（/compact，已下线）：一次压缩调度的结果摘要。dispatchCompression
 * 的返回值从 void 升级为本类型——fire-and-forget 的 tick 路径忽略它（行为不变）。
 *
 * 【/compact 已注释下线（用户拍板 2026-09-08）】未来规划两种压缩模式
 * （标准 harness 压缩 / 自研压缩模式，同时间只启用一种），手动旁路命令
 * 与该设计冲突——compactNow 及其 gate 命令（session.compact）注释保留，
 * 不删除。dispatchCompression 返回 CompactSummary 本身无害，保留。
 */
export type CompactSummary = {
  /** 本次调度使用的压缩档位。 */
  zone: 'M1' | 'M2'
  /** 是否完成了一次"切块 → 压缩 → 落盘 → 驱逐"。false 时 reason 说明原因。 */
  compressed: boolean
  /**
   * compressed=false 时的机器可读原因：
   *   'no-eligible-block' — canonical 里没有完整任务块（user→next-user 且含工具轮）；
   *   'in-flight'         — 已有调度在途（防重入，本次跳过）；
   *   'stopped'           — coordinator 已停止；
   *   'noop'              — noop coordinator（压缩调度未接线）；
   *   'failed: <message>' — 压缩或持久化序列抛错（两存储均未改动）。
   */
  reason?: string
  /** 被驱逐的 canonical 回合数。 */
  evicted: number
  /** 归档的消息数（curated block + raw archive 持久化的消息条数）。 */
  archived: number
  /** noop coordinator 专有标记——CLI 据此显示"压缩调度未接线"。 */
  noop?: boolean
}

export type DriveCoordinator = {
  tick(snapshot: DriveSnapshot): Promise<void>
  /**
   * C3（用户拍板 2026-09-17）：最旧的**未被领取、未失败**任务块。
   *
   * 为什么要由 coordinator 代选：领取登记表（claims）与失败集合是它的私有状态。
   * 调用方（goal 路径的 G1）直接 `findNextTaskBlock(turns)` 看不到这两份集合，
   * 就会与跨越驱动争抢同一个块——两条路径各自以为独占，落盘时互相逐出对方的
   * 回合。块边界判据仍在 findNextTaskBlock 里，本方法只多传一个 skip 集。
   */
  nextEligibleBlock(turns: readonly ConversationTurn[], tokenCounter?: TokenCounter): TaskBlock | undefined
  /**
   * v0.41 G1：把一个已关闭的 goal 块落盘为压缩块。**同步等待**完成——与
   * fire-and-forget 的 tick 不同，G1 必须在下一轮 composePrompt 之前生效，
   * 否则下一轮仍带着未压缩的块上 wire，尺寸门控失效。
   *
   * 生产者（memory）由调用方给出：goal 路径用 src/im/goal/block-merge.ts 的
   * 确定性本地合并（无 LLM），落盘序列与 dispatchCompression 完全一致
   * （persistTaskBlock 共用）。
   *
   * 返回 undefined = 本次跳过（已有调度在飞，或 coordinator 已停止）。块留在
   * canonical 里，下一轮再试。
   */
  mergeGoalBlock?(input: {
    snapshot: DriveSnapshot
    block: TaskBlock
    memory: CuratedMemory
  }): Promise<{ stamp: string; blockTokens: number; envelopeTokens: number } | undefined>
  /**
   * v0.41 G2：把 canonical 里一段**连续的 mem- 信封**折叠成一个新块（N→1）。
   *
   * 这一档提供与块形状无关的压缩率下界：G1 的比例只来自"丢掉输入材料"，所以
   * "短问题 + 长回答"的块 G1 几乎不压（1:1）；G2 用 N→1 兜住这种形状。
   *
   * 与 mergeGoalBlock 的三点差异：
   * 1. 替换而非逐出——`replaceRange(start, endExclusive, [新信封])`，因为被折叠
   *    的已经是信封（压缩产物），不是原始任务块。
   * 2. **不写 raw-archive**：被折叠那几个块的原文在各自 G1 时已经归档过，
   *    再写一遍是同一批消息的重复归档。召回链靠 `_sourceStamps` 血缘 +
   *    原块在 curatedMemory.jsonl / raw-archive.jsonl 里的既有记录。
   * 3. 血缘写进 `_sourceStamps`（Node 侧运行时元数据，LLM 永不产出）。
   *
   * `range` 用纯基本类型而不是从 goal/ 引入 DistillRun：drive-coordinator 已经
   * 被 goal/ 依赖（findNextTaskBlock / estimateBlockTokens / parseCuratedMemoryOutput），
   * 反向引入会形成双向依赖。
   */
  distillEnvelopes?(input: {
    snapshot: DriveSnapshot
    memory: CuratedMemory
    range: { startIndex: number; endIndexExclusive: number; sourceStamps: string[] }
  }): Promise<{ stamp: string; beforeTokens: number; afterTokens: number } | undefined>
  stop(): void
  /**
   * 等待当前在飞的压缩落盘完成（不做新工作、不做新跨越判断）。无 in-flight
   * 时立即返回。宿主收尾用：tick 是 fire-and-forget，宿主不 drain 就退出会
   * 硬杀最后一次压缩（compressor 的 LLM 调用 + 落盘序列）——批处理退出前
   * 必须 drain（timeout 由调用方约定）。
   */
  drain(): Promise<void>
  /**
   * 【/compact 已注释下线（用户拍板 2026-09-08）】手动按需压缩一次的接口。
   * 未来双压缩模式拍板后按需恢复实现（实现已在 git 历史与下方注释中）。
   * 与 tick 的自动驱动共用 dispatchCompression（同一防重入、同一原子持久化
   * 序列）。zone 选档：M2 派发已注释下线（2026-09-12，形态未上线见 tick
   * 内恢复点注释），当前唯一可用档 = 'M1'。
   */
  // compactNow(snapshot: DriveSnapshot): Promise<CompactSummary>
}

export type DriveDeps = {
  bus: SignalBus
  compressor: SystemAgent
  /**
   * C3（用户拍板 2026-09-16/17）：第二个压缩机实例。
   *
   * 为什么必须是**实例**而不是"把同一个实例调用两次"：SystemAgent 的提交捕获槽
   * （`submit_curated_memory` 的参数快照）是实例级闭包状态，run() 开头清零——
   * 同一实例并发跑两次，后跑的会在前一次读走之前把它的结果覆盖掉。所以并行度
   * 上限天然等于实例数，不是另配一个数字。
   *
   * 缺省不传 = 池容量 1 = v0.42 的单飞行为（一次一个块，逐字节不变）。
   * 两实例同名 `'compressor'`：`submit_curated_memory` 的身份守卫按 agentId 判定
   * （§6.3.2），全局只注册一次该工具，第二个实例复用同一 agentId 即合法。
   */
  compressorOverflow?: SystemAgent
  warehouse: SystemAgent
  stateLine: StateLine
  mailbox: Mailbox
  workingAgentId: AgentId
  /** Resolves the counter used by background compression when no run snapshot supplied one. */
  tokenCounter?: TokenCounter | (() => TokenCounter)
  // 原位信封落盘（2026-09-13 用户拍板）：压缩成功后把"内存 canonical（含
  // 信封替代块）+ databus"全量原子写盘，磁盘 ≡ 模型所见——跨重启后信封
  // 不消失。实现方（宿主装配）负责走与会话 persistTurn 相同的写串行队列，
  // 防 fire-and-forget tick 与下一轮 append 交错。
  rewriteSnapshot?: (conversation: ConversationMemory, databus: Databus) => Promise<void>
  /**
   * v0.41 D7（用户拍板）：goal 模式是否激活。激活时 tick 的**块压缩派发**
   * 全部让位给 goal 路径（G1 本地合并 + G2 信封折叠），M3 归档驱动与
   * lastLayer 记账保留。
   *
   * 用 getter 而非布尔：/goal 可在运行中设置或清除，装配层据会话级
   * GoalSessionState 现算（`goalModeActive: () => assets.goal.current !== undefined`）。
   * 缺省 undefined = 非 goal 模式，tick 行为逐字节不变。
   */
  goalModeActive?: () => boolean
  // v0.14: per-coordinator logger. Every dispatch path emits a structured
  // record (start / ok / error / skipped) so callers can trace compression
  // + archive behaviour without depending on the mailbox notice path
  // (which itself can fail when the inbox is full or the route is blocked).
  // Optional for backward compat; defaults to a noop-bound default logger
  // so existing callers see no behaviour change.
  logger?: Logger
}

export function createDriveCoordinator(deps: DriveDeps): DriveCoordinator {
  const log = (deps.logger ?? defaultLogger).child({ component: 'drive-coordinator', workingAgentId: deps.workingAgentId })
  let lastLayer: MemoryLayer = 'M0'
  let stopped = false
  // 最近一次派发的 promise（drain 的等待目标）。
  let inFlightDrain: Promise<unknown> | null = null
  // 已失败块的 startUserTurnId 集合（宿主应用 pipeline.ts:971 同源原则）。
  // dispatchCompression 失败时加入；成功时清空（上下文已变，之前失败的块
  // 可能现在能成功）；M0 重置时清空。findNextTaskBlock 跳过这些块，让后续
  // 块有机会被压缩——前一块失败不影响后面块。
  let failedBlockIds: Set<string> = new Set()
  const resolveCounter = (snapshot?: DriveSnapshot): TokenCounter =>
    snapshot?.tokenCounter
      ?? (typeof deps.tokenCounter === 'function' ? deps.tokenCounter() : deps.tokenCounter)
      ?? GENERIC_TOKEN_COUNTER

  // -------------------------------------------------------------------------
  // C3 受控并行：领取登记表（claims）+ FIFO 落盘屏障（claimTail）
  //
  // 为什么不是"再来一个 boolean"：并行度 > 1 时两条压缩可以在 LLM 阶段真的同时
  // 在飞，它们**必须**领到不同的块（否则两条路径逐出同一段回合），且落盘**必须**
  // 按 canonical 里块的先后次序排队（否则磁盘上的戳序与阅读序相反，M3 归档与
  // 血缘都失去意义）。一个 boolean 表达不了这两件事。
  //
  // 领取（同步）与落盘（异步）分离：tryClaim 在 tick 的同步段执行完，所以同一
  // 波次里的第二次派发必然看到第一次的领取记录，自然选到下一块。
  // -------------------------------------------------------------------------

  /** 压缩机实例池。长度即块压缩并行度上限；未接第二实例时长度 1。 */
  const compressionPool: readonly SystemAgent[] = deps.compressorOverflow === undefined
    ? [deps.compressor]
    : [deps.compressor, deps.compressorOverflow]

  type ClaimKind = 'block' | 'distill'
  type Claim = {
    kind: ClaimKind
    /** 占用的池实例下标；'distill' 不跑压缩机，恒为 -1。 */
    instance: number
    /** 领取序号（单调递增），只用于日志与次序断言。 */
    order: number
    /** FIFO 屏障：resolve = 比我更早领取的那次落盘已结束。 */
    gate: Promise<void>
    release: () => void
  }
  const claims = new Map<string, Claim>()
  let claimSeq = 0
  let claimTail: Promise<void> = Promise.resolve()

  /**
   * 领取一次落盘槽位；拿不到即返回 undefined（调用方跳过，不排队不重试——
   * tick 每轮再来，块留在 canonical 里不会丢）。
   *
   * 三条互斥规则（次序保证的全部来源）：
   * 1. 块压缩槽位 = 空闲池实例；池满即不领（并行度 = 实例数，不另配数字）。
   * 2. G2 折叠改的是连续的 mem- 信封，与块压缩落在同一个数组上，两边**完全
   *    互斥**：有 distill 在飞则块压缩不领，有任何领取则 distill 也不领。
   * 3. 同一个 key 不会被领两次（claims 命中即拒），跨路径争抢同一个块在这里封口。
   */
  const tryClaim = (key: string, kind: ClaimKind): Claim | undefined => {
    if (claims.has(key)) return undefined
    for (const c of claims.values()) {
      if (c.kind === 'distill') return undefined
    }
    if (kind === 'distill') {
      if (claims.size > 0) return undefined
    } else if (claims.size >= compressionPool.length) {
      return undefined
    }
    const used = new Set<number>()
    for (const c of claims.values()) used.add(c.instance)
    let instance = -1
    for (let i = 0; i < compressionPool.length; i += 1) {
      if (!used.has(i)) {
        instance = i
        break
      }
    }

    const gate = claimTail
    let release!: () => void
    claimTail = new Promise<void>((resolve) => { release = resolve })
    const claim: Claim = {
      kind,
      instance: kind === 'distill' ? -1 : instance,
      order: (claimSeq += 1),
      gate,
      release,
    }
    claims.set(key, claim)
    return claim
  }

  /** 交还槽位：先删登记，再放行后继（顺序反了会让后继在 claims 仍含自己时起跑）。 */
  const releaseClaim = (key: string, claim: Claim): void => {
    claims.delete(key)
    claim.release()
  }

  /** findNextTaskBlock 的 skip 集 = 在飞块 ∪ 已失败块。 */
  const blockSkipIds = (): Set<string> => {
    const skip = new Set(failedBlockIds)
    for (const [id, c] of claims) if (c.kind === 'block') skip.add(id)
    return skip
  }

  // v0.42（用户拍板 2026-09-16 方案 A）：M3 归档的增量游标状态。
  // m3ArchiveInFlight —— 单飞守卫：tick 是 fire-and-forget，M3 批量归档是 LLM
  // 调用，不守卫会叠批。它与上面的 claims 是**两套独立守卫**——归档读的是已落盘
  // 的 curated 块，块压缩写的是 canonical，两者不冲突，不该互相阻塞。
  // m3ConsecutiveFailures —— 连续失败计数：mailbox 通知只在第 1 次 + 每 10 次
  // 触发，避免仓库故障期间每 tick 轰炸；成功清零。
  let m3ArchiveInFlight = false
  let inFlightM3Archive: Promise<unknown> | null = null
  let m3ConsecutiveFailures = 0
  // 单次 warehouse run 归档的 curated 块上限。批太小 → warehouse 每批一轮
  // 交互开销大；批太大 → 巨型消息 + 单 loop guard 中断会让该批部分写入。
  const M3_BATCH_SIZE = 8

  /**
   * 原位信封落盘（跨重启，2026-09-13 用户拍板）：磁盘 ≡ 模型所见——会话快照按
   * 内存现状（含信封）全量原子重写。走宿主的会话级写串行队列（与 persistTurn
   * append 同队列，防 fire-and-forget tick 交错）。
   *
   * 失败不推翻压缩本身（state/ 梯度持久，信封缺失由提示词"查记忆层"兜底），
   * 留痕并通知工作代理。persistTaskBlock 与 distillEnvelopes 共用（v0.41）。
   */
  const rewriteSnapshotSafely = async (
    snapshot: DriveSnapshot,
    label: string,
    blockStartUserTurnId: string,
    zone: 'M1' | 'M2',
  ): Promise<void> => {
    if (deps.rewriteSnapshot === undefined) return
    try {
      await deps.rewriteSnapshot(snapshot.conversation, snapshot.databus)
    } catch (rwErr) {
      log.error('snapshot rewrite failed', {
        zone,
        label,
        blockStartUserTurnId,
        err: rwErr instanceof Error ? rwErr.message : String(rwErr),
      })
      try {
        deps.mailbox.systemSend({
          from: 'drive-coordinator',
          to: deps.workingAgentId,
          subject: '[drive] snapshot rewrite failed',
          body: `Compression succeeded and the envelope block is in canonical memory, but the disk snapshot rewrite threw: ${rwErr instanceof Error ? rwErr.message : String(rwErr)}. Memory and disk may diverge until the next successful rewrite.`,
        })
      } catch (mailErr2) {
        log.error('mailbox notice failed (snapshot rewrite error)', {
          err: mailErr2 instanceof Error ? mailErr2.message : String(mailErr2),
        })
      }
    }
  }

  /**
   * 任务块压缩的原子持久化尾段：
   *   appendBlock → rawArchive.append → evictRange → 信封插入 → 一致性检查 → 快照重写
   *
   * 生产者（LLM compressor / v0.41 G1 本地合并）只负责产出 CuratedMemory，
   * 落盘序列必须完全一致——它是崩溃安全的承重结构（计划约束 6）：appendBlock
   * 与 rawArchive.append 都在 evictRange **之前**，任一步抛错都在逐出前中止，
   * 原文不会丢。纯搬移自 dispatchCompression（v0.41 Wave 3），行为零变化。
   *
   * 返回块与信封的 token 数，供调用方上报压缩率（D12）与 GoalEvent。
   *
   * C3（用户拍板 2026-09-17）：**进序列第一件事是按 id 重定位区间**。block 里的
   * 下标是领取时刻的快照，而落盘排在 LLM 调用之后——并行度 > 1 时更早领取的块
   * 会先完成"逐出 + 原位插信封"，整个数组前移。按 id 重定位、逐字核对成员，
   * 任何漂移都在 appendBlock 之前抛错（两存储未动、原文未逐出）。
   */
  const persistTaskBlock = async (input: {
    snapshot: DriveSnapshot
    block: TaskBlock
    memory: CuratedMemory
    zone: 'M1' | 'M2'
    stamp: string
    /** 日志标识：'dispatchCompression' | 'mergeGoalBlock' */
    label: string
  }): Promise<{
    evicted: number
    blockTokens: number
    envelopeTokens: number
    startIndex: number
    endIndexExclusive: number
  }> => {
    const { snapshot, block, memory, zone, stamp, label } = input

    const live = locateTaskBlock(snapshot.conversation.turns(), block)
    if (live === undefined) {
      throw new Error(
        `block ${block.startUserTurnId} no longer occupies its canonical range (canonical drifted since the claim)`,
      )
    }

    await deps.stateLine.compressor.appendBlock(memory, zone, stamp)
    // 消息串与抽取前逐字一致（日志词汇表是可观测行为，跨版本可 grep）；
    // 区分生产者靠 label 字段，不靠改消息。
    log.debug('appendBlock ok', { zone, stamp, label })

    const archiveRecord: RawArchiveRecord = {
      archiveId: `RA-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sourceTurnIds: block.turns.map(t => t.id),
      messages: [...block.messages],
      layer: zone,
      at: Date.now(),
      summaryStamp: stamp,
    }
    await deps.stateLine.rawArchive.append(archiveRecord)
    log.debug('rawArchive.append ok', { zone, archiveId: archiveRecord.archiveId, label })

    // Evict the exact canonical range only. Databus is left intact (方案 A)
    // so tool-level stamps stay recallable via databus_query after the block
    // is compressed out of the working prompt.
    // `live` 而非 `block.startIndex`：下标自领取起可能已被更早落盘的并发调度挪动，
    // 逐出与插信封都必须用重定位后的同一对下标（错一位就逐出邻居块的回合）。
    const removed = snapshot.conversation.evictRange(
      live.startIndex,
      live.endIndexExclusive,
    )
    // 原位信封替代块（2026-09-13 用户拍板，机制参考同类实现
    // renderBlockMessage）：逐出后立即在原块起点插入 role:'user' 替代回合，
    // 保证"模型在原位置看到压缩块"而非静默空洞——完整渲染 CuratedMemory，
    // 戳在信封头部，#END_BLOCK 闭合。start===end 的 replaceRange 是纯插入。
    const envelopeContent = buildCompressionEnvelope(stamp, zone, memory)
    const envelope: ConversationTurn = {
      id: mintTurnId('mem'),
      role: 'user',
      content: envelopeContent,
      at: Date.now(),
    }
    snapshot.conversation.replaceRange(live.startIndex, live.startIndex, [envelope])
    // Consistency check only (方案 A: no evictByIds). The range came from
    // canonical, so a mismatch means our slice accounting drifted — warn,
    // but never touch databus (tool stamps must stay queryable).
    const removedToolIds = removed
      .filter(t => t.role === 'tool')
      .map(t => (t as { id: string }).id)
    const expectedIds = new Set(block.toolTurnIds)
    const idsMatch = removedToolIds.every(id => expectedIds.has(id))
      && removedToolIds.length === block.toolTurnIds.length
    if (!idsMatch) {
      log.warn('evictRange tool-id mismatch (databus untouched)', {
        zone,
        label,
        blockStartUserTurnId: block.startUserTurnId,
        expectedCount: block.toolTurnIds.length,
        removedCount: removedToolIds.length,
      })
      try {
        deps.mailbox.systemSend({
          from: 'drive-coordinator',
          to: deps.workingAgentId,
          subject: '[drive] evictRange tool-id mismatch',
          body: `Block ${block.startUserTurnId} canonical range was evicted but tool id verification failed. Databus was not modified (方案 A). Curated block and raw archive were already committed.`,
        })
      } catch (e) {
        log.error('mailbox notice failed (evictRange mismatch)', {
          err: e instanceof Error ? e.message : String(e),
        })
      }
    }

    // v0.41 D12（原则 7：压缩率测出来，不限出来）：产出信封超过原块一半时
    // 留痕。**不加 cap、不拒绝、不重试**——D8/D9 已拍板去掉一切字数上限
    // （字数限制本质是截断信息），低压缩率是要被看见的事实，不是要被
    // 悄悄修正的错误。
    const counter = resolveCounter(snapshot)
    const blockTokens = estimateBlockTokens(block, counter)
    const envelopeTokens = counter.count(envelopeContent)
    if (blockTokens > 0 && envelopeTokens * 2 > blockTokens) {
      log.warn('low compression ratio', {
        label, stamp, blockTokens, envelopeTokens,
        ratio: Number((blockTokens / Math.max(1, envelopeTokens)).toFixed(2)),
      })
    }

    // 原位信封落盘（跨重启）：见 rewriteSnapshotSafely。
    await rewriteSnapshotSafely(snapshot, label, block.startUserTurnId, zone)

    return {
      evicted: removed.length, blockTokens, envelopeTokens,
      startIndex: live.startIndex, endIndexExclusive: live.endIndexExclusive,
    }
  }

  // One compression dispatch: select a block, hand it to the compressor, and
  // evict after successful persistence. Shared by the crossing-driven M1/M2
  // path and the sustained M3 path. v0.29 Wave B2: returns a CompactSummary
  // so the manual /compact path can surface the outcome; the fire-and-forget
  // tick path ignores it (behaviour unchanged).
  const dispatchCompression = async (snapshot: DriveSnapshot, zone: 'M1' | 'M2'): Promise<CompactSummary> => {
    // C3：块压缩的互斥单位是"块"，不是"有没有人在飞"。选块时跳过在飞与已失败
    // 的块，再为选中的块领取一个池实例——池满（或 G2 独占）才返回 'in-flight'。
    const turns = snapshot.conversation.turns()
    const block = findNextTaskBlock(turns, 0, blockSkipIds(), resolveCounter(snapshot))
    if (!block) {
      log.debug('dispatchCompression skipped (no eligible block)', { zone, failedBlockIds: [...failedBlockIds] })
      return { zone, compressed: false, reason: 'no-eligible-block', evicted: 0, archived: 0 }
    }

    const claim = tryClaim(block.startUserTurnId, 'block')
    if (claim === undefined) {
      log.debug('dispatchCompression skipped (in-flight)', {
        zone,
        blockStartUserTurnId: block.startUserTurnId,
        claims: [...claims.keys()],
        parallelism: compressionPool.length,
      })
      return { zone, compressed: false, reason: 'in-flight', evicted: 0, archived: 0 }
    }
    const compressor = compressionPool[claim.instance]!

    log.info('dispatchCompression start', {
      zone,
      blockStartUserTurnId: block.startUserTurnId,
      turnCount: block.turns.length,
      toolTurnCount: block.toolTurnIds.length,
      claimOrder: claim.order,
      instance: claim.instance,
    })

    try {
      // v0.12.4 atomicity: the compressor no longer calls record_curated_block
      // to write to disk. Instead it returns a CuratedMemory JSON object as
      // its final reply text. The coordinator parses that JSON, validates it,
      // and then performs the full persistence sequence atomically:
      //   appendBlock → rawArchive.append → evictRange → envelope insert
      // (方案 A 2026-09-13: no databus.evictByIds — tool stamps stay live.)
      // All steps are consecutive IO calls with no LLM in between. If any
      // step throws, the catch block fires a mailbox notice and nothing is
      // partially committed (appendBlock failure → no archive, no eviction;
      // rawArchive failure → no eviction; the curated block written by
      // appendBlock is append-only and a duplicate on retry, acceptable).

      // Pre-generate the stamp so both the CuratedMemory block (appendBlock)
      // and the raw archive record share it. Format matches state-line/index.ts
      // internal generation so the two paths are indistinguishable.
      const stamp = `S-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      // v0.42 提交协议（宿主应用 curator-client.ts 同款）：生产结果来自
      // submit_curated_memory 工具参数（服务端 schema 约束），不解析自由文本 JSON。
      //
      // 重试闭环（2026-09-22 用户拍板）：结构性失败（未调 submit_curated_memory /
      // 载荷 schema 校验不过）在**同一次派发内**带反馈重试一次——错误说明作为追加
      // user 消息回灌 compressor（submit_curated_memory 对话内拒绝通道同款语义），
      // 不把整轮 LLM 工作丢给下一 tick 重切。语义转写不设硬闸（用户拍板 2026-09-22：
      // 允许 LLM 转写，实测正常块事实标识保真 ≈97%），本重试只兜结构性失败。
      let parsed: CuratedMemory | undefined
      let feedback: string | undefined
      let lastError = 'compressor did not submit curated memory (expected a submit_curated_memory tool call)'
      for (let attempt = 1; attempt <= 2 && parsed === undefined; attempt += 1) {
        const result = await compressor.run({
          messages: feedback === undefined
            ? [...block.messages]
            : [...block.messages, { role: 'user', content: feedback }],
          metadata: { kind: 'compress', zone },
        })
        log.debug('compressor run finished', {
          zone,
          blockStartUserTurnId: block.startUserTurnId,
          attempt,
          reason: result.reason,
          finalState: result.finalState,
        })
        const submitted = result.submitted as CuratedMemory | undefined
        if (submitted === undefined) {
          lastError = 'compressor did not submit curated memory (expected a submit_curated_memory tool call)'
          feedback = '上一轮以纯文本回复收尾，没有调用 submit_curated_memory——纯文本回复 = 压缩失败。请立即调用 submit_curated_memory，以 11 字段 schema 提交本块的 CuratedMemory。'
          continue
        }
        try {
          // 纵深防御：捕获的是工具参数快照，模型可能以无效载荷收尾——校验失败
          // 带反馈重修，两次仍失败才落 catch（不逐出、不留写）。
          validateCuratedMemory(submitted)
        } catch (ve) {
          lastError = ve instanceof Error ? ve.message : String(ve)
          feedback = `提交被拒绝：${lastError}。请补全后重新调用 submit_curated_memory。`
          continue
        }
        parsed = submitted
      }
      if (parsed === undefined) {
        throw new Error(lastError)
      }

      // Atomic persistence sequence — shared verbatim with the v0.41 G1 local
      // merge path (see persistTaskBlock). No LLM between these calls.
      //
      // C3 FIFO 落盘屏障：LLM 阶段并行，落盘阶段按**领取次序**排队。不排队会怎样
      // ——两个块同时 evictRange/replaceRange，谁先写谁就把对方的下标挪位，磁盘上
      // 的戳序与 canonical 的阅读序可能相反（M3 归档与血缘继承都按戳序讲先后）。
      await claim.gate
      const { evicted, startIndex, endIndexExclusive } = await persistTaskBlock({
        snapshot, block, memory: parsed, zone, stamp, label: 'dispatchCompression',
      })

      log.info('dispatchCompression ok', {
        zone,
        blockStartUserTurnId: block.startUserTurnId,
        persistedMessages: block.messages.length,
        // 工具 id 数量（canonical 已逐出；databus 保留供戳召回）
        archivedToolIds: block.toolTurnIds.length,
      })

      // 成功：清空失败集合。上下文已变（该块被逐出），之前失败的块可能现在能成功。
      failedBlockIds.clear()

      // Notify the working agent that compression completed.
      try {
        deps.mailbox.systemSend({
          from: 'drive-coordinator',
          to: deps.workingAgentId,
          subject: `[drive] compressed block ${block.startUserTurnId}`,
          body: `Persisted ${block.messages.length} messages from canonical range [${startIndex}, ${endIndexExclusive}). Tool projections evicted: ${block.toolTurnIds.length}.\n换出墓碑：本块已压缩为信封 stamp=${stamp}，窗口内原位只留信封。内容概要：任务=${truncateCovers(parsed.task_goal, 60) || '（空）'}；结论=${truncateCovers(parsed.conclusion, 80) || '（空）'}。召回方式：state_query({rawSummaryStamps:['${stamp}']}) 取回逐字原文 / state_query({layer:'${zone}',stamps:['${stamp}']}) 查摘要 / ask_recall 问答式召回；工具全文仍在 databus（databus_query）。`,
        })
      } catch (e) {
        // Mailbox failure must not break the success path. Caller can still
        // observe the success via the logger record above.
        log.error('mailbox notice failed (success)', {
          err: e instanceof Error ? e.message : String(e),
        })
      }

      return {
        zone,
        compressed: true,
        evicted,
        archived: block.messages.length,
      }
    } catch (e) {
      // Persistence failed — either the compressor run threw, the reply was
      // not valid CuratedMemory JSON, validation rejected the block, or an IO
      // step (appendBlock / rawArchive.append) threw. Send a mailbox notice
      // and leave both stores unchanged. Because appendBlock and rawArchive
      // run before evictRange in the atomic sequence, a failure in either IO
      // step aborts before eviction — no data is lost. (A curated block
      // committed by appendBlock before a later rawArchive failure is
      // append-only and harmless; the next retry writes a new stamp.)
      log.error('dispatchCompression failed', {
        zone,
        blockStartUserTurnId: block.startUserTurnId,
        err: e instanceof Error ? e.message : String(e),
        errStack: e instanceof Error ? e.stack : undefined,
      })
      // 记录失败块：下一 tick 跳过它，尝试后续块——前一块失败不影响后面块。
      // 跨越位不消费（tick M1 分支只在 compressed=true 时 lastLayer=layer），
      // 所以只要还有未失败的块，下一 tick 就会继续尝试。
      failedBlockIds.add(block.startUserTurnId)
      try {
        deps.mailbox.systemSend({
          from: 'drive-coordinator',
          to: deps.workingAgentId,
          subject: `[drive] compression failed for block ${block.startUserTurnId}`,
          body: `压缩失败：${e instanceof Error ? e.message : String(e)}。Canonical 与 Databus 未改动、原文未逐出。Block ${block.startUserTurnId} 本次派发已带反馈重试；仍失败则标记失败——下一 tick 先跳过它继续后续块，任何一次压缩成功后会重新重试它。`,
        })
      } catch (mailErr) {
        log.error('mailbox notice failed (compression error)', {
          err: mailErr instanceof Error ? mailErr.message : String(mailErr),
        })
      }
      return {
        zone,
        compressed: false,
        reason: `failed: ${e instanceof Error ? e.message : String(e)}`,
        evicted: 0,
        archived: 0,
      }
    } finally {
      // 交还槽位 + 放行 FIFO 后继。失败路径同样要走到这里：后继若在领取方抛错
      // 时等不到 release，就会永久卡在屏障上，后续所有块再也不落盘。
      releaseClaim(block.startUserTurnId, claim)
    }
  }

  // v0.42（用户拍板 2026-09-16 方案 A）：M3 归档的增量游标。取代旧的
  // M2→M3 跨越一次性全量归档（失败永不重试、一次巨型消息无断点）。
  //
  // 无状态幂等：已索引集合 = 既有 M3 摘要的 source_summary_stamps（每次从
  // state-line 重建，重启不失忆、部分写入可续跑）。只归档未索引的块，单批
  // ≤ M3_BATCH_SIZE。失败不消费（本批戳不进入已索引集合）→ 下一 tick 自动
  // 重试。curated 块始终留在 state-line 磁盘上；M3 内容永不注入工作 prompt。
  const runM3ArchiveBatch = async (_snapshot: DriveSnapshot): Promise<void> => {
    const m1Entries = deps.stateLine.query({ layer: 'M1' })
    const m2Entries = deps.stateLine.query({ layer: 'M2' })
    const allEntries = [...m1Entries, ...m2Entries]
    log.debug('M3 archive scanned', { m1: m1Entries.length, m2: m2Entries.length })
    if (allEntries.length === 0) {
      m3ConsecutiveFailures = 0
      return
    }

    // 已索引集合：无状态重建（M3Summary.source_summary_stamps），天然幂等。
    const indexed = new Set<string>()
    for (const m3 of deps.stateLine.query({ layer: 'M3' })) {
      const src = (m3 as M3Summary).source_summary_stamps
      if (Array.isArray(src)) for (const s of src) indexed.add(s)
    }

    // 未索引且可归档（必须有 _stamp 才能幂等去重 + raw-archive 关联）的块，
    // 取最旧的一批。缺 _stamp 的条目跳过（appendBlock 总会附加，出现即异常）。
    const unindexed: Array<CuratedMemory & { _stamp: string }> = []
    for (const e of allEntries) {
      const cm = e as CuratedMemory & { _stamp?: string }
      if (cm._stamp === undefined) continue
      if (indexed.has(cm._stamp)) continue
      unindexed.push(cm as CuratedMemory & { _stamp: string })
    }
    if (unindexed.length === 0) {
      m3ConsecutiveFailures = 0
      return
    }
    const batch = unindexed.slice(0, M3_BATCH_SIZE)

    const sourceStamps = batch.map((b) => b._stamp)
    const rawRecords = await deps.stateLine.rawArchive.query({ summaryStamps: sourceStamps })
    const rawArchiveIds = rawRecords.map((r) => r.archiveId)
    const digestLines = batch.map((cm) => `stamp=<${cm._stamp}> goal=<${cm.task_goal}> conclusion=<${cm.conclusion}>`)
    // goal 截断 60（2026-09-22）：task_goal 是自由文本，8 条长 goal 直推会把
    // body 顶过 mailbox 的 10K 硬限 → 拒收 → catch 吞掉 → 墓碑静默丢失。
    // 清单行只承担"这个戳大概讲什么"，全 goal 本来就在 state_query 里。
    const tombstoneLines = batch.map((cm) => `  stamp=<${cm._stamp}> goal=<${truncateCovers(cm.task_goal, 60)}>`)

    log.info('M3 archive dispatch start', { batch: batch.length })
    const archiveMessage: ChatMessage = {
      role: 'user',
      content: `Archive these curated blocks into M3 summaries. For each block, write one record_m3_summary whose summary_text summarizes it:\n${digestLines.join('\n')}`,
    }
    try {
      await deps.warehouse.run({
        messages: [archiveMessage],
        metadata: { kind: 'archive', zone: 'M3', sourceStamps, rawArchiveIds },
      })
      m3ConsecutiveFailures = 0
      log.info('M3 archive batch ok', { archived: batch.length, sourceStamps: sourceStamps.length, rawArchiveIds: rawArchiveIds.length })
      try {
        // 双体预算（2026-09-22）：full 正常发；超 9K 降级为紧凑体（数量+原戳
        // 列表+召回方式，去掉逐条清单）。绝不让 systemSend 因长度被拒收。
        const recallWay = '召回方式：state_query({layer:\'M3\'}) 列出全部摘要 / state_query({queryText:\'…\'}) 语义检索 / state_query({rawArchiveIds:[…]}) 取回逐字原文 / ask_recall 问答式召回。原始消息在 raw-archive，工具全文仍在 databus（databus_query）。'
        deps.mailbox.systemSend({
          from: 'drive-coordinator',
          to: deps.workingAgentId,
          subject: '[drive] M3 archive completed',
          body: fitMailBody(
            `换出墓碑（M3 归档）：以下 ${batch.length} 个 curated 块已归档为 M3 摘要，不再注入窗口，仅可召回：\n${tombstoneLines.join('\n')}\n${recallWay}`,
            `换出墓碑（M3 归档）：${batch.length} 个 curated 块已归档为 M3 摘要，不再注入窗口，仅可召回。逐条清单超预算已省略（原戳：${sourceStamps.join(', ')}）。\n${recallWay}`,
          ),
        })
      } catch (e) {
        log.error('mailbox notice failed (M3 archive ok)', {
          err: e instanceof Error ? e.message : String(e),
        })
      }
    } catch (e) {
      m3ConsecutiveFailures += 1
      log.error('M3 archive batch failed', {
        batch: batch.length,
        consecutiveFailures: m3ConsecutiveFailures,
        err: e instanceof Error ? e.message : String(e),
        errStack: e instanceof Error ? e.stack : undefined,
      })
      if (m3ConsecutiveFailures === 1 || m3ConsecutiveFailures % 10 === 0) {
        try {
          deps.mailbox.systemSend({
            from: 'drive-coordinator',
            to: deps.workingAgentId,
            subject: '[drive] M3 archive failed',
            body: `The warehouse run threw an error (consecutive failures: ${m3ConsecutiveFailures}). Curated blocks remain on disk and will be retried.`,
          })
        } catch (mailErr) {
          log.error('mailbox notice failed (M3 archive error)', {
            err: mailErr instanceof Error ? mailErr.message : String(mailErr),
          })
        }
      }
    }
  }

  const tick = async (snapshot: DriveSnapshot): Promise<void> => {
    if (stopped) {
      log.debug('tick skipped (stopped)')
      return
    }
    const layer = classifyMemoryLayer(
      snapshot.contextTokens,
      snapshot.memoryConfig ?? DEFAULT_MEMORY_CONFIG,
    )
    log.trace('tick', { contextTokens: snapshot.contextTokens, layer, lastLayer, claimsInFlight: claims.size })

    // M3 archive drive — v0.42（用户拍板 2026-09-16 方案 A）：增量游标，替代
    // 旧的 M2→M3 跨越一次性归档。layer==='M3' 时每 tick 检查一次：单飞守卫防
    // 叠批，runM3ArchiveBatch 内部无状态幂等（已索引的戳不重复派发）+ 失败
    // 不消费（下一 tick 自动重试）。curated 块仍留在磁盘；M3 内容永不注入
    // 工作 prompt。
    if (layer === 'M3') {
      if (m3ArchiveInFlight) {
        log.trace('M3 archive skipped (previous batch still in flight)')
      } else {
        m3ArchiveInFlight = true
        const archivePromise = runM3ArchiveBatch(snapshot)
        inFlightM3Archive = archivePromise
        try {
          await archivePromise
        } finally {
          m3ArchiveInFlight = false
          if (inFlightM3Archive === archivePromise) inFlightM3Archive = null
        }
      }
    }

    // v0.41 D7（用户拍板）：goal 模式激活 → 块压缩派发权移交 goal 路径
    // （G1 本地合并 + G2 信封折叠，src/im/goal/）。位置在 M3 归档驱动**之后**：
    // 归档与块压缩是两个关注点，warehouse 索引不该因 goal 断供。
    //
    // 为什么必须互斥而非并存（`[已验证]`）：两条路径都改同一个 canonical 数组
    // （evictRange + replaceRange），靠同一张 claims 登记表串行化；更严重的是跨越
    // 驱动会用 11 字段 LLM 形态压掉 goal 块——一个 80K 的信息分析块被压成结构化
    // 摘要，正是 G1"结论逐字全量、不设上限"（D9）要避免的。
    //
    // lastLayer 仍然记账：goal 结束后（/goal off 或目标达成）跨越判定从当前层
    // 连贯继续，不会因为 goal 期间的层变化被误判成一次新跨越而立刻压一块。
    if (deps.goalModeActive?.() === true) {
      log.debug('tick: block compression handed to goal path', { contextTokens: snapshot.contextTokens, layer })
      lastLayer = layer
      return
    }

    // M0: under the hot budget — nothing to compress. Reset state and return.
    if (layer === 'M0') {
      lastLayer = layer
      // 回到 M0 说明上下文已大幅缩减，之前失败的块可能现在能成功——清空重试。
      failedBlockIds.clear()
      return
    }

    // M1/M2/M3: sustained compression — dispatch a WAVE of blocks per tick.
    //
    // 参考实现 context-amplifier 同源经验（2026-09-16 用户拍板）：压缩必须是上下文
    // 规模的**连续函数**，不是"跨越才触发一次"的离散事件。旧设计三段割裂——M1 只在
    // M0→M1 跨越压一块（`if layer===lastLayer return`）、M2 整段下线静默、仅 M3 持续
    // ——于是 200K–900K 成了压缩真空：一次 M1 块之后 canonical 再不收缩，长会话一路
    // 涨到溢出（scanidx2 实测：真实 1.2M，整段只压 1 块，revive 必然 400）。
    //
    // 现在 M1 起就每 tick 压块（与旧 M3 sustained 同档 zone='M1'，M2 独立摘要形态
    // 仍未上线，见 git 历史的恢复点说明），死区消失：一进（每 tick 一个新块）一出
    // （每 tick 压最旧的可压块），canonical 稳定在 M1 阈值附近。lastLayer 现仅服务
    // 上方 M3 归档跨越判定，故派发后无条件记账。
    //
    // C3（用户拍板 2026-09-17）：M3 压力阀 = 一波派发**池大小**个块。为什么只有 M3
    // 开闸——M3 是唯一"入 > 出"的层（900K 之上每轮增量仍可能大于单块压缩量），
    // M1/M2 一档一块跟得上；两实例并行才追得上的前提是压缩延迟由 LLM 往返主导，
    // 串行等第二个块等于白等一次往返。
    //
    // 次序保证（用户的硬性约束：先后次序必须得到保证）：tryClaim 在 dispatchCompression
    // 的**第一个 await 之前**同步完成，所以这个 for 循环发出的每一次调用都领到"次旧"
    // 的**不同**块（blockSkipIds 把已领的块排除了）；落盘则由各自的 claim.gate 串成
    // FIFO——LLM 谁先回来不影响 appendBlock 的戳序，戳序 ≡ 领取序 ≡ canonical 先后。
    // 并行度就是池大小：未配 compressorOverflow 时 compressionPool.length === 1，
    // 行为与 v0.42 逐字节相同。
    const waveCount = layer === 'M3' ? compressionPool.length : 1
    const wave: Promise<CompactSummary>[] = []
    for (let i = 0; i < waveCount; i += 1) wave.push(dispatchCompression(snapshot, 'M1'))
    inFlightDrain = Promise.all(wave)
    await inFlightDrain
    lastLayer = layer
  }

  const stop = (): void => {
    stopped = true
  }

  // 等当前在飞的 dispatch 落盘。dispatch 内部 catch 全部失败（返回 failed 而
  // 非抛出），所以直接 await——宿主收尾用它保证“最后一次压缩完成后再退出”。
  const drain = async (): Promise<void> => {
    await Promise.all([inFlightDrain, inFlightM3Archive])
  }

  // v0.29 Wave B2（/compact）：手动按需压缩一次。zone 按当前 layer 选档——
  // M0/M1→M1（低于 M2 阈值时用最轻档），M2/M3→M2（与 tick 的 sustained 路径
  // 同档）。与 tick 共用 dispatchCompression（防重入 + 原子持久化序列不变）。
  // 【/compact 已注释下线（用户拍板 2026-09-08）：双压缩模式拍板前，手动
  // 旁路命令无意义。实现保留备查——共用 dispatchCompression 的防重入与
  // 原子序列。zone 选档恢复时注意：M2 派发已注释下线（2026-09-12，形态
  // 未上线，见 tick 内恢复点注释），恢复实现时 zone 语义以届时拍板为准。】
  // const compactNow = async (snapshot: DriveSnapshot): Promise<CompactSummary> => {
  //   if (stopped) {
  //     return { zone: 'M1', compressed: false, reason: 'stopped', evicted: 0, archived: 0 }
  //   }
  //   const layer = classifyMemoryLayer(
  //     snapshot.contextTokens,
  //     snapshot.memoryConfig ?? DEFAULT_MEMORY_CONFIG,
  //   )
  //   const zone: 'M1' | 'M2' = layer === 'M2' || layer === 'M3' ? 'M2' : 'M1'
  //   log.info('compactNow start', { contextTokens: snapshot.contextTokens, layer, zone })
  //   return dispatchCompression(snapshot, zone)
  // }

  /**
   * v0.41 G1：goal 块的落盘通道。生产者由调用方给出（src/im/goal/block-merge.ts
   * 的确定性本地合并，纯函数、无 LLM），落盘序列与 dispatchCompression 完全
   * 一致——共用 persistTaskBlock（计划约束 6：不造第二套存储）。
   *
   * zone 固定 'M1'：与 tick 的 M3 sustained 路径同档（M2 摘要形态未上线，见
   * tick 内恢复点注释）。goal 块不打 'M2' 标签的理由见 D11 与 §5.7(d) 恢复点。
   *
   * 与 dispatchCompression 共用**同一张领取登记表**（claims）：两者都改同一个
   * canonical 数组（evictRange + replaceRange），必须同队列落盘。goal 模式下 tick
   * 的派发分支已被 goalModeActive 关掉，但 goal 可能在一次 tick 在飞时被 /goal
   * 打开——登记表保证那一刻两条路径不会领到同一个块。
   *
   * 失败只 log.error，不发 mailbox 通知：appendBlock 与 rawArchive.append 都在
   * evictRange 之前，任一步抛错时 canonical 未被改动，模型直接看到原块仍在
   * （自明，无需告知）；块留着下一轮自动重试。
   */
  const mergeGoalBlock = async (input: {
    snapshot: DriveSnapshot
    block: TaskBlock
    memory: CuratedMemory
  }): Promise<{ stamp: string; blockTokens: number; envelopeTokens: number } | undefined> => {
    const { snapshot, block, memory } = input
    if (stopped) {
      log.debug('mergeGoalBlock skipped', { stopped })
      return undefined
    }
    const claim = tryClaim(block.startUserTurnId, 'block')
    if (claim === undefined) {
      log.debug('mergeGoalBlock skipped (block already claimed or canonical busy)', {
        blockStartUserTurnId: block.startUserTurnId,
        claims: [...claims.keys()],
      })
      return undefined
    }
    // 与 dispatchCompression 同格式（state-line/index.ts 内部生成同形），
    // 让两条路径产出的戳不可区分。
    const stamp = `S-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    log.info('mergeGoalBlock start', {
      stamp,
      blockStartUserTurnId: block.startUserTurnId,
      turnCount: block.turns.length,
      toolTurnCount: block.toolTurnIds.length,
      claimOrder: claim.order,
    })
    try {
      await claim.gate
      const r = await persistTaskBlock({ snapshot, block, memory, zone: 'M1', stamp, label: 'mergeGoalBlock' })
      log.info('mergeGoalBlock ok', {
        stamp,
        blockStartUserTurnId: block.startUserTurnId,
        evicted: r.evicted,
        blockTokens: r.blockTokens,
        envelopeTokens: r.envelopeTokens,
      })
      try {
        deps.mailbox.systemSend({
          from: 'drive-coordinator',
          to: deps.workingAgentId,
          subject: `[drive] goal block merged ${block.startUserTurnId}`,
          body: `换出墓碑（G1 goal 合并）：块 ${block.startUserTurnId}（工作 ${block.messages.length} 条 / 工具 ${block.toolTurnIds.length} 条）已合并为信封 stamp=${stamp}，窗口内原位只留信封。内容概要：任务=${truncateCovers(memory.task_goal, 60) || '（空）'}；结论=${truncateCovers(memory.conclusion, 80) || '（空）'}。召回方式：state_query({rawSummaryStamps:['${stamp}']}) 取回逐字原文 / state_query({layer:'M1',stamps:['${stamp}']}) 查摘要 / ask_recall 问答式召回；工具全文仍在 databus（databus_query）。`,
        })
      } catch (e) {
        log.error('mailbox notice failed (success)', {
          err: e instanceof Error ? e.message : String(e),
        })
      }
      return { stamp, blockTokens: r.blockTokens, envelopeTokens: r.envelopeTokens }
    } catch (e) {
      log.error('mergeGoalBlock failed', {
        stamp,
        blockStartUserTurnId: block.startUserTurnId,
        err: e instanceof Error ? e.message : String(e),
        errStack: e instanceof Error ? e.stack : undefined,
      })
      return undefined
    } finally {
      releaseClaim(block.startUserTurnId, claim)
    }
  }

  /**
   * v0.41 G2：把一段连续的 mem- 信封折叠成一个新块（N→1）。
   *
   * 这一档提供与块形状无关的压缩率下界（计划 §3.5）：G1 的比例只来自"丢掉
   * 输入材料"，所以"短问题 + 长回答"的块 G1 几乎不压（1:1）；G2 用 N→1 兜住。
   *
   * 生产者由调用方给出（src/im/goal/distill.ts 的 LLM 保守合并）。**不写
   * raw-archive**：被折叠那几个块的原文在各自 G1 时已归档过，再写一遍是同一批
   * 消息的重复归档；召回链靠 `_sourceStamps` 血缘 + 原块的既有记录。
   */
  const distillEnvelopes = async (input: {
    snapshot: DriveSnapshot
    memory: CuratedMemory
    range: { startIndex: number; endIndexExclusive: number; sourceStamps: string[] }
  }): Promise<{ stamp: string; beforeTokens: number; afterTokens: number } | undefined> => {
    if (stopped) {
      log.debug('distillEnvelopes skipped', { stopped })
      return undefined
    }
    const { snapshot, memory, range } = input

    // C3：G2 折叠与块压缩**全互斥**（tryClaim 的 'distill' 要求登记表全空，反之
    // 有 distill 在飞时任何块都领不到槽位）。折叠改的是 N 个 mem- 信封占的整段
    // 区间，块压缩改的是单块区间——两者可以指向同一段 canonical，共用同一张登记表
    // 是唯一不引入"区间相交判定"这种脆弱几何的做法。
    const claimKey = `distill-${range.startIndex}`
    const claim = tryClaim(claimKey, 'distill')
    if (claim === undefined) {
      log.debug('distillEnvelopes skipped (canonical busy)', { claimKey, claims: [...claims.keys()] })
      return undefined
    }

    // 领取后必须走 try/finally：校验失败也是"提前返回"，槽位泄漏会让后续所有
    // 压缩永久领不到槽位。
    const stamp = `S-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    try {
      // 区间有效性校验——**必须在领取之后**。调用方定位区间与 distiller 的 LLM 调用
      // 之间隔着 await，期间 fire-and-forget 的 tick 可能已经改动 canonical（goal
      // 模式下 tick 的派发被互斥关掉，但 goal 可能是在某次 tick 在飞时才被 /goal
      // 打开的）。领取成功 = 此后无人再动数组，此时的校验才是终局校验。区间一旦
      // 失效就放弃本次折叠，下一轮重新定位——折叠错区间会把不该合并的回合吞进一个块。
      const folded = snapshot.conversation.turns().slice(range.startIndex, range.endIndexExclusive)
      const spanOk = folded.length === range.endIndexExclusive - range.startIndex
        && folded.every(t => t.role === 'user' && t.id.startsWith('mem-'))
      if (!spanOk) {
        log.warn('distillEnvelopes skipped (range no longer holds envelopes)', {
          startIndex: range.startIndex,
          endIndexExclusive: range.endIndexExclusive,
          found: folded.length,
        })
        return undefined
      }

      const counter = resolveCounter(snapshot)
      const beforeTokens = counter.count(folded.map(t => JSON.stringify(turnToMessageWithCounter(t, counter))).join(''))
      log.info('distillEnvelopes start', {
        stamp,
        sourceStamps: range.sourceStamps,
        folded: folded.length,
        beforeTokens,
        claimOrder: claim.order,
      })

      // 血缘条目在**落盘时刻**从 canonical 里的实际信封文本构建（Node 侧解析，
      // LLM 永不产出）：戳取选区血缘（range.sourceStamps，与 folded 同序）、
      // 代际看 #LINEAGE 有无、covers 取正文 [任务]/[结论] 一行式。
      //
      // 代数硬闸的 fail-closed 兜底：findDistillRun 已拒绝含二代信封的区间，
      // 但选区与落盘之间隔着 distiller 的 LLM 调用，此处按"此后无人再动数组"
      // 的领取纪律做终局校验——万一混进二代信封，放弃本次折叠也不造三代。
      const lineage: StampLineageEntry[] = folded.map((t, idx) => {
        const text = typeof t.content === 'string' ? t.content : JSON.stringify(t.content)
        return {
          stamp: range.sourceStamps[idx] ?? '(unknown)',
          generation: envelopeGeneration(text),
          covers: parseEnvelopeCovers(text),
        }
      })
      if (lineage.some((e) => e.generation !== 1)) {
        log.warn('distillEnvelopes skipped (run contains a gen-2 envelope; G2→G3 is forbidden)', {
          startIndex: range.startIndex,
          endIndexExclusive: range.endIndexExclusive,
        })
        return undefined
      }

      // 【恢复点】G2 折叠块暂标 'M1'（用户拍板 2026-09-14，计划 D11）。标 'M2'
      // 会撞上 selectStateLineBlocks（context-projection.ts:64-86）的已知缝隙——
      // M1 层只查 M1 块，M2 块从投影消失，这是 2026-09-12 M2 派发下线的原因
      // 之一。M2 形态正式上线时：(1) 此处 zone 换 'M2'；(2) selectStateLineBlocks
      // 的 M1 分支改为同时查 M1+M2（或按 §6.4 方案 B 两次 query 合并）；
      // (3) 同步翻转本文件 tick 内的 M2 派发恢复点注释；(4) 翻 v0.41 计划里
      // "G2 块标 M1" 的断言与 drive-coordinator-goal-mode.test.ts 的层标签断言。
      //
      // _sourceStamps 是 Node 侧运行时元数据（LLM 永不产出，与
      // M3Summary.source_summary_stamps 同纪律）；appendBlock 的 spread 会把它
      // 一并落盘，validateCuratedMemory 只校验 11 字段的存在性，多余字段合法。
      await deps.stateLine.compressor.appendBlock(
        { ...memory, _sourceStamps: lineage },
        'M1',
        stamp,
      )

      const envelopeContent = buildCompressionEnvelope(stamp, 'M1', memory, lineage)
      const envelope: ConversationTurn = {
        id: mintTurnId('mem'),
        role: 'user',
        content: envelopeContent,
        at: Date.now(),
      }
      snapshot.conversation.replaceRange(range.startIndex, range.endIndexExclusive, [envelope])

      const afterTokens = counter.count(envelopeContent)
      // D12：低压缩率留痕，不加 cap、不拒绝、不重试。
      if (beforeTokens > 0 && afterTokens * 2 > beforeTokens) {
        log.warn('low compression ratio', {
          label: 'distillEnvelopes', stamp, blockTokens: beforeTokens, envelopeTokens: afterTokens,
          ratio: Number((beforeTokens / Math.max(1, afterTokens)).toFixed(2)),
        })
      }

      await rewriteSnapshotSafely(snapshot, 'distillEnvelopes', stamp, 'M1')

      log.info('distillEnvelopes ok', {
        stamp, sourceStamps: range.sourceStamps, folded: folded.length, beforeTokens, afterTokens,
      })
      try {
        const g2RecallWay = '原戳仍可单独召回：state_query({stamps:[\'<原戳>\']}) 查各代摘要 / state_query({rawSummaryStamps:[\'<原戳>\']}) 取回各块逐字原文 / ask_recall 问答式召回。'
        deps.mailbox.systemSend({
          from: 'drive-coordinator',
          to: deps.workingAgentId,
          subject: `[drive] envelopes distilled ${stamp}`,
          body: fitMailBody(
            `换出墓碑（G2 折叠）：${lineage.length} 个一代信封已折叠为二代信封 stamp=${stamp}，窗口内原位只留合并信封。逐戳内容与代际：\n${lineage.map((e) => `  - ${e.stamp} (gen=${e.generation}): ${e.covers}`).join('\n')}\n${g2RecallWay}`,
            `换出墓碑（G2 折叠）：${lineage.length} 个一代信封已折叠为二代信封 stamp=${stamp}。逐戳清单超预算已省略（原戳：${lineage.map((e) => e.stamp).join(', ')}）。\n${g2RecallWay}`,
          ),
        })
      } catch (e) {
        log.error('mailbox notice failed (success)', {
          err: e instanceof Error ? e.message : String(e),
        })
      }
      return { stamp, beforeTokens, afterTokens }
    } catch (e) {
      // D16：G2 是比例优化不是正确性要求（G1 已保证上下文有界）。失败时信封
      // 原样保留、下一轮再试；不发 mailbox——模型直接看到那 N 个信封还在，
      // 自明。appendBlock 在 replaceRange 之前，抛错时 canonical 未被改动。
      log.error('distillEnvelopes failed', {
        stamp,
        sourceStamps: range.sourceStamps,
        err: e instanceof Error ? e.message : String(e),
        errStack: e instanceof Error ? e.stack : undefined,
      })
      return undefined
    } finally {
      releaseClaim(claimKey, claim)
    }
  }

  // C3：与 dispatchCompression 的选块**同一条表达式**（同起点 0、同 skip 集），
  // 只是不领取也不落盘——让 goal 路径看得见 coordinator 的私有状态（在飞块 +
  // 失败块），块边界判据仍只在 findNextTaskBlock 里存在一份。
  const nextEligibleBlock = (turns: readonly ConversationTurn[], tokenCounter?: TokenCounter): TaskBlock | undefined =>
    findNextTaskBlock(turns, 0, blockSkipIds(), tokenCounter ?? resolveCounter())

  return { tick, nextEligibleBlock, mergeGoalBlock, distillEnvelopes, stop, drain }
}

// Noop coordinator for callers that don't want auto-drive.
// 【/compact 已注释下线】compactNow 的 noop 版一并注释——恢复时随上方一起。
export function createNoopDriveCoordinator(): DriveCoordinator {
  return {
    async tick() { /* noop */ },
    // 无登记表 / 无失败集合可查——纯块边界判据，调用方拿到的是"canonical 里最旧
    // 的已关闭块"。（noop 下 mergeGoalBlock 与 distillEnvelopes 都不存在，所以
    // 本方法只影响调用方"有没有块"的判断，不产生落盘。）
    nextEligibleBlock: (turns, tokenCounter) => findNextTaskBlock(turns, 0, undefined, tokenCounter),
    stop() { /* noop */ },
    async drain() { /* noop */ },
    // async compactNow() {
    //   return { zone: 'M1', compressed: false, reason: 'noop', evicted: 0, archived: 0, noop: true }
    // },
  }
}
