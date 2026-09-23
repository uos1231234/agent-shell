// D5（ADR-036）：有界且可审计的大召回报告。
//
// 主代理对同一内容的直接召回超过 200K 时，databus_query 把阅读转交给临时
// recall 系统智能体（调用级只读 toolRefs/policy 由本模块的 metadata 固定）。
// 临时代理分页读完 raw 内容后，主代理收到的不是原文，而是一份带事实、
// 证据戳、覆盖/未覆盖 token 范围和开放问题的结构化摘要；原始输出始终落盘
// （rawOutputPath 可审计），转交结果本身再经 turn.ts 的 20K 投影回主代理。
//
// 解析策略与 src/host/workflow/report.ts 同构（宽入口、严核心、raw 保留），
// 但那是 host 层文件——im 层不得反向依赖 host，故此处保留同构的独立实现。

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Databus, type ToolTurn } from '../databus.js'
import type { SystemAgent } from '../system-agent.js'
import type { TokenRange } from '../tools/databus-recall.js'

export type LargeRecallConfidence = 'verified' | 'read-unverified' | 'unknown'

export type LargeRecallFact = {
  claim: string
  evidenceStamps: string[]
  coveredRanges: TokenRange[]
  confidence: LargeRecallConfidence
}

export type LargeRecallReport = {
  mode: 'delegated'
  status: 'completed' | 'guard-tripped' | 'invalid-report'
  facts: LargeRecallFact[]
  uncoveredRanges: TokenRange[]
  openQuestions: string[]
  requestedRange: TokenRange
  rawOutputPath?: string
  warnings?: string[]
  extractionMode?: 'plain-json' | 'fenced-json' | 'embedded-json' | 'invalid'
}

export type LargeRecallRequest = {
  question: string
  stamp?: string
  requestedRange: TokenRange
  sourceDatabus: unknown
  signal?: AbortSignal
}

export type LargeRecallDeps = {
  recallAgent: Pick<SystemAgent, 'run'>
  sessionId: string
  rawOutputDir: string
}

// 提示词里的报告形状：facts 非空是硬要求（"找到了"不算命中），未验证的
// 内容必须进 openQuestions 并附验证路径。
export const LARGE_RECALL_REPORT_SHAPE = JSON.stringify({
  facts: [{
    claim: 'one verified fact per entry',
    evidenceStamps: ['stamp of the tool turn that proves it'],
    coveredRanges: [{ startToken: 0, endToken: 20_000 }],
    confidence: 'verified | read-unverified | unknown',
  }],
  uncoveredRanges: [{ startToken: 20_000, endToken: 250_000 }],
  openQuestions: ['what you could not verify, and how to verify it'],
}, null, 2)

const LARGE_RECALL_INSTRUCTION = [
  'Read the requested range in pages with databus_query (tokenRange + cursor); do not ask for the whole range at once.',
  'Report only facts you actually read, each with the evidence stamps and token ranges that prove it.',
  'Return ONE JSON object and nothing else, shaped as:',
  LARGE_RECALL_REPORT_SHAPE,
  'An empty facts array is a failure: if you cannot verify a fact, put it in openQuestions with its verification path.',
].join('\n')

const CONFIDENCE_VALUES = new Set<LargeRecallConfidence>(['verified', 'read-unverified', 'unknown'])

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object'

type ExtractionMode = NonNullable<LargeRecallReport['extractionMode']>

const candidates = (raw: string): Array<{ text: string; mode: ExtractionMode }> => {
  const result: Array<{ text: string; mode: ExtractionMode }> = []
  const trimmed = raw.trim()
  if (trimmed.length > 0) result.push({ text: trimmed, mode: 'plain-json' })
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi
  for (const match of raw.matchAll(fenced)) {
    if (match[1]?.trim()) result.push({ text: match[1].trim(), mode: 'fenced-json' })
  }
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) result.push({ text: raw.slice(first, last + 1), mode: 'embedded-json' })
  return result
}

const tokenRanges = (value: unknown, field: string, warnings: string[]): TokenRange[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    warnings.push(`field "${field}" must be an array; ignored`)
    return []
  }
  const ranges: TokenRange[] = []
  for (const [index, item] of value.entries()) {
    if (!isObject(item)) {
      warnings.push(`${field}[${index}] must be an object; ignored`)
      continue
    }
    const startToken = item.startToken ?? item.start
    const endToken = item.endToken ?? item.end
    if (
      typeof startToken !== 'number' || !Number.isFinite(startToken)
      || typeof endToken !== 'number' || !Number.isFinite(endToken)
      || endToken < startToken
    ) {
      warnings.push(`${field}[${index}] has an invalid token range; ignored`)
      continue
    }
    ranges.push({ startToken, endToken })
  }
  return ranges
}

const evidenceStamps = (value: unknown, field: string, warnings: string[]): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    warnings.push(`field "${field}" must be an array; ignored`)
    return []
  }
  const stamps: string[] = []
  for (const [index, item] of value.entries()) {
    if (typeof item === 'string' && item.length > 0) {
      stamps.push(item)
      continue
    }
    const stamp = isObject(item)
      ? typeof item.stamp === 'string' && item.stamp.length > 0
        ? item.stamp
        : typeof item.evidenceStamp === 'string' && item.evidenceStamp.length > 0
          ? item.evidenceStamp
          : undefined
      : undefined
    if (stamp !== undefined) {
      stamps.push(stamp)
      continue
    }
    warnings.push(`${field}[${index}] has no usable stamp; ignored`)
  }
  return stamps
}

const openQuestions = (value: unknown, warnings: string[]): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    warnings.push('field "openQuestions" must be an array; ignored')
    return []
  }
  const questions: string[] = []
  for (const [index, item] of value.entries()) {
    if (typeof item === 'string' && item.trim().length > 0) {
      questions.push(item)
      continue
    }
    if (isObject(item) && typeof item.question === 'string' && item.question.trim().length > 0) {
      questions.push(item.question)
      continue
    }
    warnings.push(`openQuestions[${index}] has no usable question; ignored`)
  }
  return questions
}

const parseFact = (value: unknown, index: number, warnings: string[]): LargeRecallFact => {
  if (!isObject(value)) throw new Error(`fact ${index} must be an object`)
  const claim = typeof value.claim === 'string' ? value.claim.trim() : ''
  if (claim.length === 0) throw new Error(`fact ${index} requires a non-empty claim`)
  const rawConfidence = value.confidence
  const confidence = typeof rawConfidence === 'string' && CONFIDENCE_VALUES.has(rawConfidence as LargeRecallConfidence)
    ? rawConfidence as LargeRecallConfidence
    : 'unknown'
  if (confidence === 'unknown' && rawConfidence !== 'unknown') {
    warnings.push(`fact ${index} has missing or invalid confidence; defaulted to unknown`)
  }
  return {
    claim,
    evidenceStamps: evidenceStamps(value.evidenceStamps, `facts[${index}].evidenceStamps`, warnings),
    coveredRanges: tokenRanges(value.coveredRanges, `facts[${index}].coveredRanges`, warnings),
    confidence,
  }
}

export const invalidLargeRecallReport = (requestedRange: TokenRange, warning: string): LargeRecallReport => ({
  mode: 'delegated',
  status: 'invalid-report',
  facts: [],
  uncoveredRanges: [],
  openQuestions: ['Recall output was not valid structured JSON; inspect the preserved raw output.'],
  requestedRange,
  extractionMode: 'invalid',
  warnings: [warning],
})

export const parseLargeRecallReport = (rawOutput: string, requestedRange: TokenRange): LargeRecallReport => {
  let lastError = 'no JSON candidate found'
  for (const candidate of candidates(rawOutput)) {
    try {
      const parsed: unknown = JSON.parse(candidate.text)
      if (!isObject(parsed)) throw new Error('report must be an object')
      const rawFacts = parsed.facts
      if (!Array.isArray(rawFacts) || rawFacts.length === 0) {
        throw new Error('report facts must be a non-empty array')
      }
      const warnings: string[] = []
      const facts = rawFacts.map((fact, index) => parseFact(fact, index, warnings))
      return {
        mode: 'delegated',
        status: 'completed',
        facts,
        uncoveredRanges: tokenRanges(parsed.uncoveredRanges, 'uncoveredRanges', warnings),
        openQuestions: openQuestions(parsed.openQuestions, warnings),
        requestedRange,
        extractionMode: candidate.mode,
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  return invalidLargeRecallReport(requestedRange, lastError)
}

const rawOutputText = (output: unknown): string =>
  typeof output === 'string' ? output : JSON.stringify(output)

const persistRawOutput = async (rawOutputDir: string, text: string): Promise<string> => {
  await mkdir(rawOutputDir, { recursive: true })
  const path = join(rawOutputDir, `large-recall-${Date.now()}-${randomUUID().slice(0, 8)}.raw.txt`)
  await writeFile(path, text, 'utf8')
  return path
}

export const runLargeRecall = async (
  request: LargeRecallRequest,
  deps: LargeRecallDeps,
): Promise<LargeRecallReport> => {
  request.signal?.throwIfAborted()
  const source = request.sourceDatabus as { turns?: () => readonly ToolTurn[] }
  const snapshot = new Databus({ sessionId: deps.sessionId })
  for (const turn of source.turns?.() ?? []) snapshot.append(turn)
  const result = await deps.recallAgent.run({
    messages: [{
      role: 'user',
      content: JSON.stringify({
        kind: 'large-databus-recall',
        question: request.question,
        ...(request.stamp !== undefined ? { stamp: request.stamp } : {}),
        requestedRange: request.requestedRange,
        instruction: LARGE_RECALL_INSTRUCTION,
      }),
    }],
    metadata: {
      contextDatabus: snapshot,
      sessionId: deps.sessionId,
      toolRefsOverride: ['databus_query', 'state_query'],
      toolPolicyOverride: {
        default: 'deny',
        rules: [
          { mode: 'allow', pattern: 'databus_query' },
          { mode: 'allow', pattern: 'state_query' },
        ],
      },
      directRecallLimitTokens: Number.POSITIVE_INFINITY,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    },
  })
  const rawText = rawOutputText(result.output)
  const rawOutputPath = await persistRawOutput(deps.rawOutputDir, rawText)
  if (result.reason !== 'completed') {
    return {
      mode: 'delegated',
      status: 'guard-tripped',
      facts: [],
      uncoveredRanges: [],
      openQuestions: ['Recall agent loop terminated by a guard before producing a structured report.'],
      requestedRange: request.requestedRange,
      rawOutputPath,
      extractionMode: 'invalid',
    }
  }
  return { ...parseLargeRecallReport(rawText, request.requestedRange), rawOutputPath }
}
