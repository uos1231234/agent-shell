import type { BaselineStage, ScoutConfidence, ScoutEvidence, ScoutFinding, ScoutOpenQuestion, ScoutRange, ScoutReport, ScoutRole } from './types.js'

const CONFIDENCE_VALUES = new Set<ScoutConfidence>(['verified', 'read-unverified', 'unknown'])

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object'

const stringArray = (value: unknown, field: string, warnings: string[]): string[] => {
  if (value === undefined) {
    warnings.push(`missing optional field: ${field}`)
    return []
  }
  if (!Array.isArray(value)) {
    warnings.push(`field "${field}" must be an array; ignored`)
    return []
  }
  const strings = value.filter((item): item is string => typeof item === 'string')
  if (strings.length !== value.length) warnings.push(`field "${field}" contains non-string entries; ignored them`)
  return strings
}

const positiveLine = (value: unknown, field: string, warnings: string[]): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value
  warnings.push(`field "${field}" has an invalid line; ignored`)
  return undefined
}

const normalizeEvidence = (
  value: unknown,
  field: string,
  warnings: string[],
): { stamps: string[]; details: ScoutEvidence[] } => {
  if (value === undefined) return { stamps: [], details: [] }
  if (!Array.isArray(value)) {
    warnings.push(`field "${field}" must be an array; ignored`)
    return { stamps: [], details: [] }
  }
  const stamps: string[] = []
  const details: ScoutEvidence[] = []
  for (const [index, item] of value.entries()) {
    if (typeof item === 'string') {
      stamps.push(item)
      details.push({ stamp: item })
      continue
    }
    if (!isObject(item)) {
      warnings.push(`field "${field}[${index}]" must be a string or object; ignored`)
      continue
    }
    const stamp = typeof item.stamp === 'string'
      ? item.stamp
      : typeof item.evidenceStamp === 'string'
        ? item.evidenceStamp
        : undefined
    const detail: ScoutEvidence = {
      ...(stamp !== undefined ? { stamp } : {}),
      ...(typeof item.path === 'string' ? { path: item.path } : {}),
      ...(typeof item.range === 'string' ? { range: item.range } : {}),
      ...(typeof item.tool === 'string' ? { tool: item.tool } : {}),
      ...(typeof item.command === 'string' ? { command: item.command } : {}),
    }
    const startLine = positiveLine(item.startLine ?? item.start, `${field}[${index}].startLine`, warnings)
    const endLine = positiveLine(item.endLine ?? item.end, `${field}[${index}].endLine`, warnings)
    if (startLine !== undefined) detail.startLine = startLine
    if (endLine !== undefined) detail.endLine = endLine
    if (Object.keys(detail).length === 0) {
      warnings.push(`field "${field}[${index}]" has no usable evidence; ignored`)
      continue
    }
    if (stamp !== undefined) stamps.push(stamp)
    details.push(detail)
  }
  return { stamps, details }
}

const normalizeOpenQuestions = (
  value: unknown,
  warnings: string[],
): { questions: string[]; details: ScoutOpenQuestion[] } => {
  if (value === undefined) {
    warnings.push('missing optional field: openQuestions')
    return { questions: [], details: [] }
  }
  if (!Array.isArray(value)) {
    warnings.push('field "openQuestions" must be an array; ignored')
    return { questions: [], details: [] }
  }
  const questions: string[] = []
  const details: ScoutOpenQuestion[] = []
  for (const [index, item] of value.entries()) {
    if (typeof item === 'string') {
      questions.push(item)
      details.push({ question: item })
      continue
    }
    if (!isObject(item) || typeof item.question !== 'string' || item.question.trim().length === 0) {
      warnings.push(`openQuestions[${index}] must contain a non-empty question; ignored`)
      continue
    }
    const question = item.question
    const detail: ScoutOpenQuestion = {
      question,
      ...(typeof item.verifyPath === 'string' ? { verifyPath: item.verifyPath } : {}),
    }
    questions.push(question)
    details.push(detail)
  }
  return { questions, details }
}

const normalizeRanges = (value: unknown, field: string, warnings: string[]): ScoutRange[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    warnings.push(`field "${field}" must be an array; ignored`)
    return []
  }
  const ranges: ScoutRange[] = []
  for (const [index, item] of value.entries()) {
    if (!isObject(item) || typeof item.path !== 'string' || item.path.trim().length === 0) {
      warnings.push(`${field}[${index}] must contain a non-empty path; ignored`)
      continue
    }
    const range: ScoutRange = { path: item.path }
    if (item.range !== undefined) {
      if (typeof item.range === 'string' && item.range.trim().length > 0) range.range = item.range
      else warnings.push(`field "${field}[${index}].range" has an invalid range; ignored`)
    }
    const startLine = positiveLine(item.startLine ?? item.start, `${field}[${index}].startLine`, warnings)
    const endLine = positiveLine(item.endLine ?? item.end, `${field}[${index}].endLine`, warnings)
    if (startLine !== undefined) range.startLine = startLine
    if (endLine !== undefined) range.endLine = endLine
    ranges.push(range)
  }
  return ranges
}

const parseFinding = (value: unknown, index: number, warnings: string[]): ScoutFinding => {
  if (!isObject(value)) throw new Error(`Scout finding ${index} must be an object`)
  const claim = typeof value.claim === 'string' ? value.claim : typeof value.conclusion === 'string' ? value.conclusion : ''
  const path = typeof value.path === 'string' ? value.path : typeof value.file === 'string' ? value.file : ''
  const impact = typeof value.impact === 'string'
    ? value.impact
    : typeof value.whyItMatters === 'string'
      ? value.whyItMatters
      : ''
  if (claim.length === 0) throw new Error(`Scout finding ${index} requires a non-empty claim`)
  if (path.length === 0) throw new Error(`Scout finding ${index} requires a non-empty path`)
  if (impact.length === 0) warnings.push(`finding ${index} is missing impact/whyItMatters`)
  const rawConfidence = value.confidence
  const confidence = typeof rawConfidence === 'string' && CONFIDENCE_VALUES.has(rawConfidence as ScoutConfidence)
    ? rawConfidence as ScoutConfidence
    : 'unknown'
  if (confidence === 'unknown' && rawConfidence !== 'unknown') {
    warnings.push(`finding ${index} has missing or invalid confidence; defaulted to unknown`)
  }
  const finding: ScoutFinding = {
    claim,
    path,
    confidence,
    impact: impact || 'impact not provided by scout',
  }
  const tools = value.tools ?? value.usedTools
  if (tools !== undefined) finding.tools = stringArray(tools, `findings[${index}].tools`, warnings)
  const commands = value.commands ?? value.usedCommands
  if (commands !== undefined) finding.commands = stringArray(commands, `findings[${index}].commands`, warnings)
  const startLine = value.startLine ?? value.start
  const endLine = value.endLine ?? value.end
  if (startLine !== undefined) {
    if (typeof startLine !== 'number' || !Number.isInteger(startLine) || startLine < 1) warnings.push(`finding ${index} has an invalid start line`)
    else finding.startLine = startLine
  }
  if (endLine !== undefined) {
    if (typeof endLine !== 'number' || !Number.isInteger(endLine) || endLine < 1) warnings.push(`finding ${index} has an invalid end line`)
    else finding.endLine = endLine
  }
  const evidence = value.evidenceStamps ?? value.evidence
  if (evidence !== undefined) {
    const normalized = normalizeEvidence(evidence, `findings[${index}].evidence`, warnings)
    finding.evidenceStamps = normalized.stamps
    if (normalized.details.length > 0) finding.evidence = normalized.details
  }
  return finding
}

type ExtractionMode = NonNullable<ScoutReport['extractionMode']>

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

export const invalidScoutReport = (role: ScoutRole, rawOutput: string, warning?: string): ScoutReport => ({
  role,
  status: 'invalid-report',
  findings: [],
  commands: [],
  openQuestions: ['Scout output was not valid structured JSON; inspect the preserved raw output.'],
  rawOutput,
  extractionMode: 'invalid',
  ...(warning !== undefined ? { warnings: [warning] } : {}),
})

export const parseScoutReport = (role: ScoutRole, rawOutput: string, expectedStage?: BaselineStage): ScoutReport => {
  let lastError = 'no JSON candidate found'
  for (const candidate of candidates(rawOutput)) {
    try {
      const parsed: unknown = JSON.parse(candidate.text)
      if (!isObject(parsed)) throw new Error('report must be an object')
      if (parsed.role !== undefined && parsed.role !== role) throw new Error(`report role must be ${role}`)
      const warnings: string[] = []
      if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1) {
        throw new Error('report schemaVersion must be 1')
      }
      if (parsed.kind !== undefined && parsed.kind !== 'baseline.scout') {
        throw new Error('report kind must be baseline.scout')
      }
      if (parsed.stage !== undefined && parsed.stage !== 'inventory' && parsed.stage !== 'evidence' && parsed.stage !== 'synthesis') {
        warnings.push('report stage is unknown; ignored')
      }
      if (
        expectedStage !== undefined
        && (parsed.stage === 'inventory' || parsed.stage === 'evidence' || parsed.stage === 'synthesis')
        && parsed.stage !== expectedStage
      ) {
        throw new Error(`report stage must be ${expectedStage}`)
      }
      const rawFindings = parsed.findings ?? parsed.items ?? []
      if (!Array.isArray(rawFindings)) throw new Error('report findings must be an array')
      const findings = rawFindings.map((finding, index) => parseFinding(finding, index, warnings))
      const commands = stringArray(parsed.commands ?? parsed.verificationCommands, 'commands', warnings)
      const normalizedQuestions = normalizeOpenQuestions(parsed.openQuestions ?? parsed.questions, warnings)
      const coveredRanges = normalizeRanges(parsed.coveredRanges, 'coveredRanges', warnings)
      const uncoveredRanges = normalizeRanges(parsed.uncoveredRanges, 'uncoveredRanges', warnings)
      const report: ScoutReport = {
        role,
        status: 'completed',
        findings,
        commands,
        openQuestions: normalizedQuestions.questions,
        rawOutput,
        extractionMode: candidate.mode,
        ...(normalizedQuestions.details.length > 0 ? { openQuestionDetails: normalizedQuestions.details } : {}),
        ...(parsed.schemaVersion === 1 ? { schemaVersion: 1 as const } : {}),
        ...(parsed.kind === 'baseline.scout' ? { kind: 'baseline.scout' as const } : {}),
        ...(parsed.stage === 'inventory' || parsed.stage === 'evidence' || parsed.stage === 'synthesis'
          ? { stage: parsed.stage }
          : {}),
        ...(typeof parsed.summary === 'string' ? { summary: parsed.summary } : {}),
        ...(coveredRanges.length > 0 ? { coveredRanges } : {}),
        ...(uncoveredRanges.length > 0 ? { uncoveredRanges } : {}),
        ...(typeof parsed.nextAction === 'string' ? { nextAction: parsed.nextAction } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      }
      return report
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  return invalidScoutReport(role, rawOutput, lastError)
}
