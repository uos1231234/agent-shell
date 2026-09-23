// v0.10.2 StateLine factory.
// Append-only jsonl storage for M1/M2 (curatedMemory.jsonl) and M3 (index.jsonl + stamps.jsonl).
// Single-writer enforcement via type-level sub-objects: compressor vs warehouse.

import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { appendJsonl } from './jsonl-writer.js'
import { appendStamp } from './append-stamp.js'
import { embedM3, queryM3, DEFAULT_TIMEOUT_MS } from './chroma-bridge.js'
import { defaultLogger } from '../../shared/logger.js'
import type { Logger } from '../../shared/logger.js'
import type {
  CuratedMemory,
  CuratedBlockInput,
  M3Summary,
  StateLineConfig,
  StateLineEntry,
  StateLineQueryFilter,
  StateLine,
  CompressorInterface,
  WarehouseInterface,
  RawArchiveRecord,
  RawArchiveInterface,
} from './types.js'

const defaultDatabusPath = (): string => join(homedir(), '.databus')

// Required fields for CuratedMemory schema validation (ADR-016 §2.2).
const REQUIRED_TOP_LEVEL = [
  'task_goal',
  'causal_steps',
  'evidence_fragments',
  'conclusion',
  'next_action',
  'working_state',
] as const

const REQUIRED_WORKING_STATE = [
  'current_goal',
  'effective_decisions',
  'rejected_decisions',
  'architecture_boundaries',
  'remaining_work',
] as const

// Exported so the drive-coordinator can validate a CuratedMemory JSON produced
// by the compressor before atomically persisting it (v0.12.4 atomicity: the
// coordinator, not the compressor tool, owns the appendBlock call).
export const validateCuratedMemory = (block: CuratedMemory): void => {
  for (const key of REQUIRED_TOP_LEVEL) {
    if (block[key] === undefined || block[key] === null) {
      throw new Error(`CuratedMemory missing required field: ${key}`)
    }
  }
  const ws = block.working_state
  for (const key of REQUIRED_WORKING_STATE) {
    if (ws[key] === undefined || ws[key] === null) {
      throw new Error(`CuratedMemory.working_state missing required field: ${key}`)
    }
  }
}

// Read jsonl file → array of parsed objects. Returns [] if file doesn't exist.
// Tolerates partial writes (corrupted lines are skipped) — append-only jsonl design.
const readJsonl = <T>(filePath: string): T[] => {
  if (!existsSync(filePath)) return []
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n').filter((line) => line.trim().length > 0)
  const results: T[] = []
  for (const line of lines) {
    try {
      results.push(JSON.parse(line) as T)
    } catch {
      // append-only jsonl tolerates partial writes — skip corrupted line
    }
  }
  return results
}

type Subscriber = {
  filter: StateLineQueryFilter
  cb: (entry: StateLineEntry) => void
}

export const createStateLine = (config?: StateLineConfig): StateLine => {
  const basePath = config?.databusPath ?? defaultDatabusPath()
  const stateDir = join(basePath, 'state')

  const curatedMemoryPath = join(stateDir, 'curatedMemory.jsonl')
  const indexPath = join(stateDir, 'index.jsonl')
  const stampsPath = join(stateDir, 'stamps.jsonl')
  const rawArchivePath = join(stateDir, 'raw-archive.jsonl')

  const timeoutMs = config?.pythonTimeoutMs ?? DEFAULT_TIMEOUT_MS
  // v0.42（2026-09-16 修复）：chroma storePath 从 basePath 派生，与 jsonl 落盘
  // 同目录树 —— 旧实现硬编码全局 DEFAULT_STORE_PATH（~/.databus/...），而 jsonl
  // 已按会话隔离（sessionDir/<id>/state/）：多个会话共享同一个 m3_summaries 集合，
  // recall 的 RAG 查询会命中**别的会话**的 M3 摘要（跨会话污染，对评测就是数据
  // 泄漏）。默认路径（databusPath 缺省 → ~/.databus）与旧值逐字节一致，行为不变；
  // per-session 调用方（session-manager/recovery）自动获得 chroma 隔离。
  const bridgeOpts = { storePath: join(stateDir, 'vectors', 'chroma'), timeoutMs }

  // v0.14: structured logger for state-line IO. Wrap appendJsonl/appendStamp
  // so silent failures surface in stderr. Default to the shared defaultLogger.
  const log: Logger = (config?.logger ?? defaultLogger).child({ component: 'state-line' })

  const JSONL_WARN_BYTES = config?.jsonlWarnBytes ?? 5 * 1024 * 1024
  const readCache = new Map<string, { size: number; mtimeMs: number; parsed: unknown[] }>()
  const warnedPaths = new Set<string>()

  // Query-time read path: serves repeated queries from cache while the file
  // is unchanged (size + mtime), re-parses on any change — including writes
  // by external producers. Format, tolerance of corrupted lines, and the
  // public API are unchanged; this only avoids O(file size) re-reads per query.
  const readJsonlCached = <T>(filePath: string): T[] => {
    if (!existsSync(filePath)) return []
    const st = statSync(filePath)
    const cached = readCache.get(filePath)
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      return cached.parsed as T[]
    }
    const parsed = readJsonl<T>(filePath)
    readCache.set(filePath, { size: st.size, mtimeMs: st.mtimeMs, parsed })
    if (st.size > JSONL_WARN_BYTES && !warnedPaths.has(filePath)) {
      warnedPaths.add(filePath)
      console.warn(`[state-line] ${filePath} grew past ${Math.round(st.size / 1024 / 1024)}MB - jsonl reads are O(file size); M3 archival recommended`)
    }
    return parsed
  }

  const subscribers: Subscriber[] = []

  const matchesFilter = (entry: StateLineEntry, stamp: string | undefined, writtenAt: number | undefined, filter: StateLineQueryFilter): boolean => {
    if (filter.stamps && stamp !== undefined) {
      if (!filter.stamps.includes(stamp)) return false
    }
    if (filter.range && writtenAt !== undefined) {
      const [start, end] = filter.range
      if (writtenAt < start || writtenAt > end) return false
    }
    if (filter.layer) {
      // M3 entries have layer: 'M3' in their object.
      // M1/M2 entries are CuratedMemory (no layer field) — stamp record determines layer.
      // For simplicity: if filter.layer is 'M3', only M3Summary entries match.
      // If filter.layer is 'M1' or 'M2', only CuratedMemory entries match.
      const isM3 = 'layer' in entry && entry.layer === 'M3'
      if (filter.layer === 'M3' && !isM3) return false
      if ((filter.layer === 'M1' || filter.layer === 'M2') && isM3) return false
    }
    return true
  }

  const notifySubscribers = (entry: StateLineEntry, stamp: string | undefined, writtenAt: number | undefined): void => {
    for (const sub of subscribers) {
      if (matchesFilter(entry, stamp, writtenAt, sub.filter)) {
        sub.cb(entry)
      }
    }
  }

  // M1 and M2 currently share the 11-field CuratedMemory schema. M2 (summary compression)
  // is expected to diverge into a shorter form later; the layer tag distinguishes them so a
  // future schema split does not require a data migration. Do not assume M1 === M2 forever.
  const compressor: CompressorInterface = {
    async appendBlock(block: CuratedBlockInput, layer: 'M1' | 'M2' = 'M2', stamp?: string): Promise<void> {
      validateCuratedMemory(block)

      // Use the externally-provided stamp when given (e.g. pre-generated by the
      // drive coordinator so a raw archive record can point back at this block).
      // Otherwise generate one internally. The format must stay identical so
      // externally- and internally-generated stamps are indistinguishable.
      const usedStamp = stamp ?? `S-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      // v0.41：spread 顺带把 Node 侧运行时元数据（G2 折叠血缘 _sourceStamps）
      // 一起落盘。validateCuratedMemory 只校验 11 字段的存在性，多余字段合法
      // ——LLM 侧的 schema 仍然是闭合的（提示词硬规则 1），元数据由 coordinator
      // 在 Node 侧附加，与 M3Summary.source_summary_stamps 同纪律。
      const recordToWrite = { ...block, _stamp: usedStamp }

      try {
        await appendJsonl(curatedMemoryPath, recordToWrite)
        await appendStamp(stampsPath, usedStamp, 'curatedMemory.jsonl', layer)
        log.debug('appendBlock ok', { stamp: usedStamp, path: 'curatedMemory.jsonl', layer })
      } catch (e) {
        log.error('appendBlock failed', {
          stamp: usedStamp,
          path: 'curatedMemory.jsonl',
          layer,
          err: e instanceof Error ? e.message : String(e),
        })
        throw e
      }

      notifySubscribers(recordToWrite, usedStamp, Date.now())
    },
  }

  const warehouse: WarehouseInterface = {
    async appendSummary(summary: M3Summary): Promise<void> {
      try {
        await appendJsonl(indexPath, summary)
        await appendStamp(stampsPath, summary.stamp, 'index.jsonl', 'M3')
        log.debug('appendSummary ok', { stamp: summary.stamp, path: 'index.jsonl', layer: 'M3' })
      } catch (e) {
        log.error('appendSummary failed', {
          stamp: summary.stamp,
          path: 'index.jsonl',
          layer: 'M3',
          err: e instanceof Error ? e.message : String(e),
        })
        throw e
      }

      // best-effort: jsonl is source of truth; embed failure leaves the block
      // metadata-queryable but absent from RAG. Do not throw on embed failure.
      // v0.42（2026-09-16）：失败**留痕**——此前 embed 失败被静默吞掉，RAG 对
      // 中文失效（embed.py 的 stdin/GBK 误读）时毫无线索，久远 M3 索引"搜不到"
      // 变成不可诊断的隐性问题。
      const embedRes = await embedM3(
        [{ stamp: summary.stamp, text: summary.summary_text }],
        bridgeOpts,
      )
      if (!embedRes.ok) {
        log.warn('M3 embed failed — RAG index absent (metadata still queryable by stamp)', {
          stamp: summary.stamp,
          err: embedRes.error,
        })
      }

      notifySubscribers(summary, summary.stamp, summary.at)
    },

    queryM3(queryText: string, limit: number) {
      return queryM3(queryText, limit, bridgeOpts)
    },
  }

  // Raw archive: full canonical ChatMessage[] of each compressed block,
  // persisted BEFORE eviction so the evicted turns remain recallable for
  // M3 deep recall. Same append-only jsonl style as curatedMemory/index.
  // One record per compressed task block, keyed by the canonical turn ids
  // the block covered.
  const rawArchive: RawArchiveInterface = {
    async append(record: RawArchiveRecord): Promise<void> {
      try {
        await appendJsonl(rawArchivePath, record)
        log.debug('rawArchive.append ok', {
          archiveId: record.archiveId,
          path: 'raw-archive.jsonl',
          layer: record.layer,
          summaryStamp: record.summaryStamp,
        })
      } catch (e) {
        log.error('rawArchive.append failed', {
          archiveId: record.archiveId,
          path: 'raw-archive.jsonl',
          layer: record.layer,
          summaryStamp: record.summaryStamp,
          err: e instanceof Error ? e.message : String(e),
        })
        throw e
      }
    },
    async query(filter: { sourceTurnIds?: string[]; layer?: 'M1' | 'M2'; archiveIds?: string[]; summaryStamps?: string[]; limit?: number }): Promise<RawArchiveRecord[]> {
      const all = readJsonlCached<RawArchiveRecord>(rawArchivePath)
      const results: RawArchiveRecord[] = []
      for (const r of all) {
        if (filter.layer !== undefined && r.layer !== filter.layer) continue
        if (filter.sourceTurnIds !== undefined) {
          const wanted = new Set(filter.sourceTurnIds)
          if (!r.sourceTurnIds.some(id => wanted.has(id))) continue
        }
        if (filter.archiveIds !== undefined) {
          if (!filter.archiveIds.includes(r.archiveId)) continue
        }
        if (filter.summaryStamps !== undefined) {
          if (!filter.summaryStamps.includes(r.summaryStamp)) continue
        }
        results.push(r)
      }
      if (filter.limit !== undefined) return results.slice(0, filter.limit)
      return results
    },
  }

  const query = (filter: StateLineQueryFilter): readonly StateLineEntry[] => {
    // Read all entries from both files.
    const curatedEntries = readJsonlCached<CuratedMemory & { _stamp?: string }>(curatedMemoryPath)
    const m3Entries = readJsonlCached<M3Summary>(indexPath)
    const stampRecords = readJsonlCached<{ stamp: string; path: string; layer: string; written_at: number }>(stampsPath)

    // Build stamp → layer map for M1/M2 entries (CuratedMemory has no layer field).
    const stampLayerMap = new Map<string, string>()
    for (const sr of stampRecords) {
      if (!stampLayerMap.has(sr.stamp)) {
        stampLayerMap.set(sr.stamp, sr.layer)
      }
    }

    const results: StateLineEntry[] = []

    // Process M3 entries.
    for (const m3 of m3Entries) {
      if (matchesFilter(m3, m3.stamp, m3.at, filter)) {
        results.push(m3)
      }
    }

    // Process M1/M2 entries.
    for (const cm of curatedEntries) {
      const stamp = cm._stamp
      // Find written_at from stamp records.
      const sr = stampRecords.find((r) => r.stamp === stamp)
      const writtenAt = sr?.written_at
      const layer = stamp ? stampLayerMap.get(stamp) : undefined

      // If filter.layer is specified, check against stamp record's layer.
      if (filter.layer && filter.layer !== 'M3') {
        if (layer !== filter.layer) continue
      } else if (filter.layer === 'M3') {
        continue
      }

      if (matchesFilter(cm, stamp, writtenAt, filter)) {
        results.push(cm as CuratedMemory & { _stamp?: string })
      }
    }

    if (filter.limit !== undefined) {
      return results.slice(0, filter.limit)
    }
    return results
  }

  const subscribe = (filter: StateLineQueryFilter, cb: (entry: StateLineEntry) => void): (() => void) => {
    const sub: Subscriber = { filter, cb }
    subscribers.push(sub)
    return () => {
      const idx = subscribers.indexOf(sub)
      if (idx >= 0) subscribers.splice(idx, 1)
    }
  }

  const close = (): void => {
    subscribers.length = 0
  }

  return { compressor, warehouse, rawArchive, query, subscribe, close }
}

// NoopStateLine: used when caller does not pass a real StateLine (v0.10.2 optional).
// state_query will return "state-line not configured" when this is in use.
export function createNoopStateLine(): StateLine {
  return {
    compressor: {
      async appendBlock() { throw new Error('no state-line configured; provide a real stateLine in IMLoopOptions') },
    },
    warehouse: {
      async appendSummary() { throw new Error('no state-line configured; provide a real stateLine in IMLoopOptions') },
      async queryM3() { return { ok: false, error: 'no state-line configured' } },
    },
    rawArchive: {
      async append() { throw new Error('no state-line configured; provide a real stateLine in IMLoopOptions') },
      async query() { return [] },
    },
    query: () => [],
    subscribe: () => () => {},
    close() {},
  }
}

// Re-export types for convenience.
export type {
  CuratedMemory,
  M3Summary,
  StampRecord,
  StateLineEntry,
  StateLineConfig,
  StateLineQueryFilter,
  StateLine,
  CompressorInterface,
  WarehouseInterface,
  RawArchiveRecord,
  RawArchiveInterface,
} from './types.js'
