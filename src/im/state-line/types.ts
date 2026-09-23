// v0.10.2 state-line type declarations.
// All schemas are ADR-016 §2.2 verbatim — no metadata field, no runtime validation.
// stamp is `string` (NOT number) per ADR-016 §2.2 + state-query.ts:4.

import type { ChatMessage } from '../../protocol/types.js'
import type { Logger } from '../../shared/logger.js'

/** ADR-016 §2.2 11-field schema (6 required top-level + 1 optional + 5 required working_state). */
export type CuratedMemory = {
  task_goal: string
  causal_steps: Array<{ intent: string; tool_action: string; result: string }>
  evidence_fragments: Array<{ source: string; fragment: string; relevance: string }>
  conclusion: string
  next_action: string
  working_state: {
    current_goal: string
    effective_decisions: string[]
    rejected_decisions: string[]
    architecture_boundaries: string[]
    remaining_work: string[]
  }
  status_hint?: 'DONE' | 'PENDING' | 'UNKNOWN'
}

/** M3 summary written by the warehouse agent to index.jsonl.
 * source_summary_stamps: the _stamps of the M1/M2 CuratedMemory blocks
 *   this summary aggregates (multi-to-one join, "十合一" index). Determined
 *   Node-side by the drive coordinator via metadata; the LLM must not
 *   fabricate it. record_m3_summary merges it from ctx.archiveSourceStamps.
 * raw_archive_ids: the archiveIds of the raw-archive records (full original
 *   canonical turns) backing those curated blocks. Same Node-side provenance
 *   (ctx.archiveRawArchiveIds). Enables M3 deep recall to fetch original
 *   history via state_query({ rawArchiveIds }). */
export type M3Summary = {
  stamp: string
  m1_stamp: string          // kept for backward compatibility with old jsonl
  summary_text: string
  layer: 'M3'
  at: number
  source_summary_stamps?: string[]   // 十合一: back-references to M1/M2 block _stamps
  raw_archive_ids?: string[]          // back-references to raw-archive archiveIds
}

/** Stamp → path mapping written to stamps.jsonl. */
export type StampRecord = {
  stamp: string
  path: string
  layer: 'M1' | 'M2' | 'M3'
  written_at: number
}

/**
 * G2 折叠血缘条目（v0.41 血缘可发现性补丁，用户拍板 2026-09-22）。
 *
 * - `stamp`：被折叠信封的原戳——`state_query({stamps:[…]})` 仍可解析（召回不断链）。
 * - `covers`：该戳对应内容的一行描述（`任务=…；结论=…`，Node 侧从信封正文解析
 *   后截断生成，LLM 永不产出）。模型不召回就能判断"这个戳大概讲什么"。
 * - `generation`：该戳自身的世代（1 = 原始块直接压缩产物，2 = 信封折叠产物）。
 *   代数硬闸只允许 G1→G2，故条目 generation 恒为 1、宿主块恒为 2。
 *
 * 取代早期的 `string[]` 平铺列表：平铺列表只有一串不可解读的 ID，没有内容、
 * 没有代际，等于没有可发现性（§6.26：信息变形后，模型必须能发现并召回）。
 */
export type StampLineageEntry = {
  stamp: string
  covers: string
  generation: number
}

/**
 * CuratedMemory 的**落盘形态**：LLM 产出的 11 字段 + Node 侧运行时元数据。
 *
 * - `_stamp` 由 appendBlock 内部生成（或接受调用方预生成的，见 CompressorInterface）。
 * - `_sourceStamps`（v0.41 G2）：信封折叠时记录被合并的那些块的结构化血缘
 *   （戳 + covers + 代际），多对一。**只由 drive coordinator 在 Node 侧写入，
 *   LLM 永不产出**——与 `M3Summary.source_summary_stamps` 同纪律（见上方
 *   M3Summary 的注释）。折叠后原块的 curatedMemory.jsonl 行与 raw-archive
 *   记录都还在，所以 `state_query({stamps:[原戳]})` 仍然可解析，召回不断链。
 *
 * 血缘走这个运行时字段而不是加进 11 字段 schema：schema 对 LLM 是闭合的
 * （compressor/distill 提示词的硬规则 1"不得新增字段"），而落盘形态可以携带
 * LLM 看不见的元数据——`_stamp` 早已是这个先例。
 */
export type CuratedBlockInput = CuratedMemory & { _sourceStamps?: StampLineageEntry[] }

/** Union returned by query(). CuratedMemory variants carry optional runtime metadata. */
export type StateLineEntry = (CuratedBlockInput & { _stamp?: string }) | M3Summary

/** Configuration for createStateLine. */
export type StateLineConfig = {
  databusPath?: string
  pythonTimeoutMs?: number
  /** Growth-detection threshold (bytes) for jsonl reads; warns once, does not change behavior. */
  jsonlWarnBytes?: number
  /** v0.14: per-state-line structured logger. Emits `appendBlock ok/failed`,
   * `appendSummary ok/failed`, `rawArchive.append ok/failed` records with
   * stamp/path/layer fields. Defaults to defaultLogger when omitted. */
  logger?: Logger
}

// M1 and M2 currently share the 11-field CuratedMemory schema. M2 (summary compression)
// is expected to diverge into a shorter form later; the layer tag distinguishes them so a
// future schema split does not require a data migration. Do not assume M1 === M2 forever.

/** Compressor-only write API (M1/M2).
 * stamp: optional externally-pre-generated stamp (e.g. from the drive
 * coordinator). When omitted, appendBlock generates one internally
 * (`S-${Date.now()}-${rand}`). Passing it lets the caller correlate the
 * CuratedMemory block with a raw archive record written alongside it.
 *
 * v0.41：第一参用 CuratedBlockInput 而非 CuratedMemory，G2 折叠的血缘
 * `_sourceStamps` 随 block 传入——已有三个可选位置参数，再加第四个会让
 * 调用点变成 `appendBlock(b, 'M1', s, undefined, [...])` 这种数位置的形式。 */
export type CompressorInterface = {
  appendBlock(block: CuratedBlockInput, layer?: 'M1' | 'M2', stamp?: string): Promise<void>
}

/** Warehouse-only write API (M3). */
export type WarehouseInterface = {
  appendSummary(summary: M3Summary): Promise<void>
  queryM3(
    queryText: string,
    limit: number,
  ): Promise<
    | { ok: true; results: Array<{ stamp: string; distance: number; document: string }> }
    | { ok: false; error: string }
  >
}

/** Query filter for StateLine.query(). */
export type StateLineQueryFilter = {
  stamps?: string[]
  range?: [number, number]
  layer?: 'M1' | 'M2' | 'M3'
  limit?: number
}

/** Raw canonical history archived before eviction, so compressed turns can
 * be recalled in full (M3 deep recall). Written to raw-archive.jsonl.
 * One record per compressed task block — the full user/assistant/tool
 * sequence that was evicted, keyed by the canonical turn ids it covered.
 * summaryStamp: the _stamp of the CuratedMemory block this archive covers,
 * pre-generated by the drive coordinator and shared with appendBlock so the
 * raw archive can be joined back to its curated summary (stage 2a). */
export type RawArchiveRecord = {
  archiveId: string
  sourceTurnIds: string[]
  messages: ChatMessage[]
  layer: 'M1' | 'M2'
  at: number
  summaryStamp: string
}

/** Raw-archive write/query API. Query filters are conjunctive (all set
 * filters must match). sourceTurnIds matches if the record's sourceTurnIds
 * overlaps the filter's sourceTurnIds (any intersection). archiveIds matches
 * if the record's archiveId is in the filter's archiveIds. summaryStamps
 * matches if the record's summaryStamp is in the filter's summaryStamps.
 * archiveIds and summaryStamps may be combined (AND). */
export type RawArchiveInterface = {
  append(record: RawArchiveRecord): Promise<void>
  query(filter: { sourceTurnIds?: string[]; layer?: 'M1' | 'M2'; archiveIds?: string[]; summaryStamps?: string[]; limit?: number }): Promise<RawArchiveRecord[]>
}

/** The StateLine object returned by createStateLine. */
export type StateLine = {
  compressor: CompressorInterface
  warehouse: WarehouseInterface
  rawArchive: RawArchiveInterface
  query(filter: StateLineQueryFilter): readonly StateLineEntry[]
  subscribe(filter: StateLineQueryFilter, cb: (entry: StateLineEntry) => void): () => void
  close(): void
}
