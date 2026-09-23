import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BaselineCheckpoint, BaselineStage, ScoutRole, ScoutRunRecord, WorkflowState } from './types.js'

export const defaultWorkflowState = (sessionId: string): WorkflowState => ({
  version: 1,
  sessionId,
  enabled: false,
  phase: 'idle',
  skillActive: false,
  baseline: { status: 'idle', completedRoles: [] },
  evidenceCount: 0,
  updatedAt: Date.now(),
})

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object'

const roleValues = new Set<ScoutRole>(['structure', 'verification', 'risk'])

const normalizeState = (sessionId: string, value: unknown): WorkflowState => {
  if (!isObject(value) || value.version !== 1 || value.sessionId !== sessionId) {
    throw new Error(`Invalid workflow state for session "${sessionId}"`)
  }
  const baseline = isObject(value.baseline) ? value.baseline : undefined
  if (typeof value.enabled !== 'boolean' || typeof value.skillActive !== 'boolean' || baseline === undefined) {
    throw new Error(`Invalid workflow state for session "${sessionId}"`)
  }
  const completedRoles = Array.isArray(baseline.completedRoles)
    ? baseline.completedRoles.filter((role): role is ScoutRole => typeof role === 'string' && roleValues.has(role as ScoutRole))
    : []
  const state: WorkflowState = {
    version: 1,
    sessionId,
    enabled: value.enabled,
    phase: value.phase === 'baseline' || value.phase === 'ready' ? value.phase : 'idle',
    skillActive: value.skillActive,
    baseline: {
      status: baseline.status === 'running' || baseline.status === 'completed' || baseline.status === 'failed' ? baseline.status : 'idle',
      completedRoles,
    },
    evidenceCount: typeof value.evidenceCount === 'number' && Number.isInteger(value.evidenceCount) && value.evidenceCount >= 0
      ? value.evidenceCount
      : 0,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
  }
  if (typeof baseline.runId === 'string') state.baseline.runId = baseline.runId
  if (typeof baseline.startedAt === 'number') state.baseline.startedAt = baseline.startedAt
  if (typeof baseline.endedAt === 'number') state.baseline.endedAt = baseline.endedAt
  if (typeof baseline.error === 'string') state.baseline.error = baseline.error
  if (Array.isArray(baseline.warnings)) state.baseline.warnings = baseline.warnings.filter((warning): warning is string => typeof warning === 'string')
  if (typeof value.lastReportId === 'string') state.lastReportId = value.lastReportId
  if (isObject(value.lastGuard) && Array.isArray(value.lastGuard.ids) && typeof value.lastGuard.at === 'number') {
    state.lastGuard = { ids: value.lastGuard.ids.filter((id): id is string => typeof id === 'string'), at: value.lastGuard.at }
  }
  return state
}

export class WorkflowStore {
  readonly dataDir: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
  }

  sessionDir(sessionId: string): string {
    return join(this.dataDir, sessionId, 'state', 'workflow')
  }

  statePath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'workflow.json')
  }

  baselineDir(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'baseline')
  }

  rolePath(sessionId: string, role: ScoutRole): string {
    return join(this.baselineDir(sessionId), `${role}.json`)
  }

  rawPath(sessionId: string, role: ScoutRole): string {
    return join(this.baselineDir(sessionId), `${role}.raw.txt`)
  }

  summaryPath(sessionId: string): string {
    return join(this.baselineDir(sessionId), 'baseline.json')
  }

  checkpointPath(sessionId: string, role: ScoutRole, stage: BaselineStage): string {
    return join(this.baselineDir(sessionId), `${role}.${stage}.checkpoint.json`)
  }

  stageRawPath(sessionId: string, role: ScoutRole, stage: BaselineStage): string {
    return join(this.baselineDir(sessionId), `${role}.${stage}.raw.txt`)
  }

  async load(sessionId: string): Promise<WorkflowState> {
    try {
      const raw = await readFile(this.statePath(sessionId), 'utf8')
      return normalizeState(sessionId, JSON.parse(raw) as unknown)
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return defaultWorkflowState(sessionId)
      throw error
    }
  }

  async save(state: WorkflowState): Promise<void> {
    const dir = this.sessionDir(state.sessionId)
    await mkdir(dir, { recursive: true })
    const tmp = `${this.statePath(state.sessionId)}.tmp`
    await writeFile(tmp, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2), 'utf8')
    await rename(tmp, this.statePath(state.sessionId))
  }

  async saveScoutRecord(sessionId: string, record: ScoutRunRecord): Promise<string> {
    const dir = this.baselineDir(sessionId)
    await mkdir(dir, { recursive: true })
    const rawPath = this.rawPath(sessionId, record.role)
    await writeFile(rawPath, record.report.rawOutput, 'utf8')
    const rolePath = this.rolePath(sessionId, record.role)
    const tmp = `${rolePath}.tmp`
    await writeFile(tmp, JSON.stringify({ ...record, rawOutputPath: rawPath }, null, 2), 'utf8')
    await rename(tmp, rolePath)
    return rawPath
  }

  async saveBaselineCheckpoint(sessionId: string, checkpoint: BaselineCheckpoint, rawOutput: string): Promise<BaselineCheckpoint> {
    const dir = this.baselineDir(sessionId)
    await mkdir(dir, { recursive: true })
    const rawOutputPath = this.stageRawPath(sessionId, checkpoint.role, checkpoint.stage)
    await writeFile(rawOutputPath, rawOutput, 'utf8')
    const persisted = { ...checkpoint, rawOutputPath }
    const path = this.checkpointPath(sessionId, checkpoint.role, checkpoint.stage)
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(persisted, null, 2), 'utf8')
    await rename(tmp, path)
    return persisted
  }

  async loadBaselineCheckpoint(sessionId: string, role: ScoutRole, stage: BaselineStage): Promise<BaselineCheckpoint | undefined> {
    try {
      const raw = await readFile(this.checkpointPath(sessionId, role, stage), 'utf8')
      const parsed = JSON.parse(raw) as BaselineCheckpoint
      return parsed.sessionId === sessionId && parsed.role === role && parsed.stage === stage ? parsed : undefined
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined
      return undefined
    }
  }

  async loadBaselineStageOutput(sessionId: string, role: ScoutRole, stage: BaselineStage): Promise<string | undefined> {
    try {
      return await readFile(this.stageRawPath(sessionId, role, stage), 'utf8')
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined
      return undefined
    }
  }

  async loadScoutRecord(sessionId: string, role: ScoutRole): Promise<ScoutRunRecord | undefined> {
    try {
      const raw = await readFile(this.rolePath(sessionId, role), 'utf8')
      const parsed = JSON.parse(raw) as ScoutRunRecord
      return parsed.role === role ? parsed : undefined
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined
      return undefined
    }
  }

  async saveBaselineSummary(sessionId: string, summary: unknown): Promise<void> {
    const dir = this.baselineDir(sessionId)
    await mkdir(dir, { recursive: true })
    const path = this.summaryPath(sessionId)
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(summary, null, 2), 'utf8')
    await rename(tmp, path)
  }

  async appendEvidence(sessionId: string, evidence: unknown): Promise<void> {
    const previous = this.evidenceWrites.get(sessionId) ?? Promise.resolve()
    const write = previous.then(async () => {
      const dir = this.sessionDir(sessionId)
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, 'evidence.ndjson'),
        `${JSON.stringify(evidence)}\n`,
        { encoding: 'utf8', flag: 'a' },
      )
    })
    this.evidenceWrites.set(sessionId, write.catch(() => undefined))
    await write
  }

  private readonly evidenceWrites = new Map<string, Promise<void>>()
}
