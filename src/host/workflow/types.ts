import type { GuardHit } from '../../shell/guards.js'

export const SCOUT_ROLES = ['structure', 'verification', 'risk'] as const
export type ScoutRole = (typeof SCOUT_ROLES)[number]

export const BASELINE_STAGES = ['inventory', 'evidence', 'synthesis'] as const
export type BaselineStage = (typeof BASELINE_STAGES)[number]

export type BaselineCheckpoint = {
  sessionId: string
  runId: string
  role: ScoutRole
  stage: BaselineStage
  completed: boolean
  startedAt: number
  endedAt: number
  rawOutputPath: string
  evidenceStamps: string[]
  pendingRanges: Array<{ path: string; start: number; end?: number }>
  warnings: string[]
  stageReport?: Omit<ScoutReport, 'rawOutput'>
}

export type ScoutConfidence = 'verified' | 'read-unverified' | 'unknown'

export type ScoutOpenQuestion = {
  question: string
  verifyPath?: string
}

export type ScoutEvidence = {
  stamp?: string
  path?: string
  startLine?: number
  endLine?: number
  range?: string
  tool?: string
  command?: string
}

export type ScoutFinding = {
  claim: string
  path: string
  startLine?: number
  endLine?: number
  evidenceStamps?: string[]
  evidence?: ScoutEvidence[]
  tools?: string[]
  commands?: string[]
  confidence: ScoutConfidence
  impact: string
}

export type ScoutReportStatus = 'completed' | 'guard-tripped' | 'invalid-report'

export type ScoutReport = {
  role: ScoutRole
  status: ScoutReportStatus
  findings: ScoutFinding[]
  commands: string[]
  openQuestions: string[]
  openQuestionDetails?: ScoutOpenQuestion[]
  schemaVersion?: 1
  kind?: 'baseline.scout'
  stage?: BaselineStage
  summary?: string
  coveredRanges?: ScoutRange[]
  uncoveredRanges?: ScoutRange[]
  nextAction?: string
  rawOutput: string
  warnings?: string[]
  extractionMode?: 'plain-json' | 'fenced-json' | 'embedded-json' | 'invalid'
}

export type ScoutRange = {
  path: string
  startLine?: number
  endLine?: number
  range?: string
}

export type ScoutRunRecord = {
  role: ScoutRole
  scoutInstanceId?: string
  status: ScoutReportStatus
  startedAt: number
  endedAt: number
  report: ScoutReport
  rawOutputPath: string
  evidenceStamps: string[]
  guard?: GuardHit[]
}

export type WorkflowRunStatus = 'idle' | 'running' | 'completed' | 'failed'

export type WorkflowState = {
  version: 1
  sessionId: string
  enabled: boolean
  phase: 'idle' | 'baseline' | 'ready'
  skillActive: boolean
  baseline: {
    status: WorkflowRunStatus
    runId?: string
    completedRoles: ScoutRole[]
    startedAt?: number
    endedAt?: number
    error?: string
    warnings?: string[]
  }
  evidenceCount: number
  lastGuard?: { ids: string[]; at: number }
  lastReportId?: string
  updatedAt: number
}

export type WorkflowRunEvent = {
  runId: string
  mode: 'baseline'
  phase: 'started' | 'scout.completed' | 'completed' | 'failed'
  role?: ScoutRole
  record?: ScoutRunRecord
  error?: string
}

export type WorkflowStatus = WorkflowState
