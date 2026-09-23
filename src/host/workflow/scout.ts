import { randomUUID } from 'node:crypto'
import type { SubAgentConfig } from '../../im/sub-agent/config.js'
import type { RunSubagentDeps, ConfiguredSubagentRun } from '../../im/tools/run-subagent.js'
import type { SubAgentRegistry } from '../../im/sub-agent/index.js'
import { runConfiguredSubagent } from '../../im/tools/run-subagent.js'
import { BASELINE_SCOUT_POLICY, BASELINE_SCOUT_TOOL_REFS, baselineStagePrompt } from './prompts.js'
import { invalidScoutReport, parseScoutReport } from './report.js'
import { WorkflowStore } from './store.js'
import { BASELINE_STAGES, SCOUT_ROLES, type BaselineStage, type ScoutRole, type ScoutReport, type ScoutRunRecord } from './types.js'

export type BaselineScoutRunnerOptions = {
  sessionId: string
  runId?: string
  workDir: string
  subAgentRegistry: SubAgentRegistry
  deps: RunSubagentDeps
  store: WorkflowStore
  onEvent?: (event: { phase: 'scout.completed'; role: ScoutRole; record: ScoutRunRecord }) => void
}

export type BaselineRunResult = {
  runId: string
  records: Partial<Record<ScoutRole, ScoutRunRecord>>
  completedRoles: ScoutRole[]
  failedRoles: ScoutRole[]
}

const stageConfig = (role: ScoutRole, stage: BaselineStage): SubAgentConfig => ({
  name: `baseline-${role}-${stage}`,
  systemPrompt: `You are the ${role} read-only baseline scout in the ${stage} stage.`,
  toolRefs: [...BASELINE_SCOUT_TOOL_REFS],
  toolPolicy: BASELINE_SCOUT_POLICY,
  createdBy: 'agent',
})

const failedRecord = (role: ScoutRole, startedAt: number, error: unknown): ScoutRunRecord => {
  const rawOutput = `Scout failed before producing output: ${error instanceof Error ? error.message : String(error)}`
  const report: ScoutReport = invalidScoutReport(role, rawOutput)
  return {
    role,
    status: 'invalid-report',
    startedAt,
    endedAt: Date.now(),
    report,
    rawOutputPath: '',
    evidenceStamps: [],
  }
}

const recordFromRun = (
  role: ScoutRole,
  run: ConfiguredSubagentRun,
  startedAt: number,
): ScoutRunRecord => {
  const report = run.status === 'guard-tripped'
    ? {
        role,
        status: 'guard-tripped' as const,
        findings: [],
        commands: [],
        openQuestions: ['Scout loop terminated by a guard.'],
        rawOutput: run.output,
      }
    : parseScoutReport(role, run.output, 'synthesis')
  const evidenceStamps = report.findings.flatMap((finding) => finding.evidenceStamps ?? [])
  return {
    role,
    scoutInstanceId: run.instanceId,
    status: report.status,
    startedAt,
    endedAt: Date.now(),
    report,
    rawOutputPath: '',
    evidenceStamps,
    ...(run.trippedHint !== undefined ? { guard: [{ id: run.trippedHint, reason: 'sub-agent guard tripped' }] } : {}),
  }
}

export const runBaselineScouts = async (options: BaselineScoutRunnerOptions): Promise<BaselineRunResult> => {
  const runId = options.runId ?? `baseline-${randomUUID()}`
  const existing = await Promise.all(SCOUT_ROLES.map(async (role) => [role, await options.store.loadScoutRecord(options.sessionId, role)] as const))
  const records: Partial<Record<ScoutRole, ScoutRunRecord>> = {}
  for (const [role, record] of existing) if (record !== undefined) records[role] = record

  // Only a completed record is a resumable result. Invalid/guard-tripped
  // records remain on disk for audit, but must be retried on the next run.
  const resumable = await Promise.all(SCOUT_ROLES.map(async (role) => {
    if (records[role]?.status !== 'completed') return false
    const checkpoint = await options.store.loadBaselineCheckpoint(options.sessionId, role, 'synthesis')
    if (checkpoint?.completed !== true) return false
    return (await options.store.loadBaselineStageOutput(options.sessionId, role, 'synthesis')) !== undefined
  }))
  const pending = SCOUT_ROLES.filter((_, index) => resumable[index] !== true)
  const tasks = pending.map(async (role) => {
    const startedAt = Date.now()
    try {
      const stageOutputs: string[] = []
      let synthesisRun: ConfiguredSubagentRun | undefined
      for (const stage of BASELINE_STAGES) {
        const checkpoint = await options.store.loadBaselineCheckpoint(options.sessionId, role, stage)
        const savedOutput = checkpoint?.completed === true
          ? await options.store.loadBaselineStageOutput(options.sessionId, role, stage)
          : undefined
        if (checkpoint?.completed === true && savedOutput !== undefined) {
          stageOutputs.push(savedOutput)
          if (stage === 'synthesis') synthesisRun = { instanceId: `recovered-${role}-${stage}`, output: savedOutput, status: 'completed' }
          continue
        }
        const run = await runConfiguredSubagent({
          cfg: stageConfig(role, stage),
          input: baselineStagePrompt(role, stage, options.workDir, stageOutputs),
          deps: options.deps,
          subAgentRegistry: options.subAgentRegistry,
          parentAgentId: 'main',
        })
        const stageReport = run.status === 'guard-tripped'
          ? invalidScoutReport(role, run.output, 'scout loop terminated by a guard')
          : parseScoutReport(role, run.output, stage)
        const completed = run.status === 'completed' && stageReport.status === 'completed'
        await options.store.saveBaselineCheckpoint(options.sessionId, {
          sessionId: options.sessionId,
          runId,
          role,
          stage,
          completed,
          startedAt,
          endedAt: Date.now(),
          rawOutputPath: '',
          evidenceStamps: stageReport.findings.flatMap((finding) => finding.evidenceStamps ?? []),
          pendingRanges: (stageReport.uncoveredRanges ?? [])
            .filter((range): range is typeof range & { startLine: number } => range.startLine !== undefined)
            .map((range) => ({ path: range.path, start: range.startLine, ...(range.endLine !== undefined ? { end: range.endLine } : {}) })),
          warnings: completed ? (stageReport.warnings ?? []) : [
            ...(stageReport.warnings ?? []),
            `stage did not complete: ${stage}`,
          ],
          ...(completed
            ? { stageReport: (({ rawOutput: _rawOutput, ...structured }) => structured)(stageReport) }
            : {}),
        }, run.output)
        await options.store.appendEvidence(options.sessionId, {
          sessionId: options.sessionId,
          runId,
          role,
          stage,
          at: Date.now(),
          rawOutputPath: options.store.stageRawPath(options.sessionId, role, stage),
          completed,
        })
        stageOutputs.push(run.output)
        if (stage === 'synthesis') synthesisRun = run
        if (!completed) throw new Error(`Baseline scout ${role} stopped during ${stage}`)
      }
      if (synthesisRun === undefined) throw new Error(`Baseline scout ${role} has no synthesis result`)
      const record = recordFromRun(role, synthesisRun, startedAt)
      record.rawOutputPath = await options.store.saveScoutRecord(options.sessionId, record)
      records[role] = record
      options.onEvent?.({ phase: 'scout.completed', role, record })
      return record
    } catch (error) {
      const record = failedRecord(role, startedAt, error)
      record.rawOutputPath = await options.store.saveScoutRecord(options.sessionId, record)
      records[role] = record
      options.onEvent?.({ phase: 'scout.completed', role, record })
      return record
    }
  })
  await Promise.allSettled(tasks)

  const completedRoles = SCOUT_ROLES.filter((role) => records[role]?.status === 'completed')
  const failedRoles = SCOUT_ROLES.filter((role) => records[role] !== undefined && records[role]!.status !== 'completed')
  await options.store.saveBaselineSummary(options.sessionId, {
    runId,
    sessionId: options.sessionId,
    records,
    completedRoles,
    failedRoles,
    generatedAt: Date.now(),
  })
  return { runId, records, completedRoles, failedRoles }
}
