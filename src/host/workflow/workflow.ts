import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { ToolTurn } from '../../im/databus.js'
import type { LoopHooks } from '../../im/loop-hooks.js'
import type { ContextInjectionSource } from '../../im/hooks/context-injection.js'
import type { RunSubagentDeps } from '../../im/tools/run-subagent.js'
import type { SubAgentRegistry } from '../../im/sub-agent/index.js'
import { stampOfToolTurn } from '../../im/databus.js'
import { runBaselineScouts, type BaselineRunResult } from './scout.js'
import { WorkflowStore, defaultWorkflowState } from './store.js'
import { checkWorkflowWorkspace } from './workspace.js'
import type { ScoutRole, WorkflowRunEvent, WorkflowState } from './types.js'

export type LongHorizonWorkflowOptions = {
  sessionId: string
  workDir: string
  dataDir: string
  subAgentRegistry: SubAgentRegistry
  scoutDeps: RunSubagentDeps
  onEvent?: (event: WorkflowRunEvent) => void
}

export class LongHorizonWorkflow {
  readonly sessionId: string
  readonly store: WorkflowStore
  private stateValue: WorkflowState
  private readonly workDir: string
  private readonly subAgentRegistry: SubAgentRegistry
  private readonly scoutDeps: RunSubagentDeps
  private readonly onEvent: ((event: WorkflowRunEvent) => void) | undefined
  private skillText = ''
  private evidenceWrite: Promise<void> = Promise.resolve()
  private stateWrite: Promise<void> = Promise.resolve()
  private baselineRun: Promise<BaselineRunResult> | undefined

  private constructor(options: LongHorizonWorkflowOptions, state: WorkflowState) {
    this.sessionId = options.sessionId
    this.store = new WorkflowStore(options.dataDir)
    this.stateValue = state
    this.workDir = options.workDir
    this.subAgentRegistry = options.subAgentRegistry
    this.scoutDeps = options.scoutDeps
    this.onEvent = options.onEvent
  }

  static async open(options: LongHorizonWorkflowOptions): Promise<LongHorizonWorkflow> {
    const workflow = new LongHorizonWorkflow(options, await new WorkflowStore(options.dataDir).load(options.sessionId))
    try {
      workflow.skillText = await readFile(fileURLToPath(new URL('../../../skills/long-horizon-workflow.md', import.meta.url)), 'utf8')
    } catch {
      workflow.skillText = '# LongHorizon workflow\nWorkflow skill file is unavailable; use the persisted workflow state and baseline reports.\n'
    }
    return workflow
  }

  get state(): WorkflowState {
    return structuredClone(this.stateValue)
  }

  async enable(): Promise<WorkflowState> {
    this.stateValue.enabled = true
    this.stateValue.skillActive = true
    this.stateValue.phase = this.stateValue.baseline.status === 'completed' ? 'ready' : 'idle'
    await this.persist()
    return this.state
  }

  async disable(): Promise<WorkflowState> {
    this.stateValue.enabled = false
    this.stateValue.skillActive = false
    this.stateValue.phase = 'idle'
    await this.persist()
    return this.state
  }

  async runBaseline(): Promise<BaselineRunResult> {
    if (!this.stateValue.enabled) throw new Error('LongHorizon workflow is disabled for this session')
    if (this.baselineRun !== undefined) return this.baselineRun
    const run = this.runBaselineOnce()
    this.baselineRun = run
    try {
      return await run
    } finally {
      if (this.baselineRun === run) this.baselineRun = undefined
    }
  }

  private async runBaselineOnce(): Promise<BaselineRunResult> {
    const startedAt = Date.now()
    const runId = `baseline-${randomUUID()}`
    this.stateValue.phase = 'baseline'
    this.stateValue.baseline = { status: 'running', runId, completedRoles: [], startedAt }
    await this.persist()
    this.onEvent?.({ runId, mode: 'baseline', phase: 'started' })
    try {
      const workspace = await checkWorkflowWorkspace(this.workDir)
      const result = await runBaselineScouts({
        sessionId: this.sessionId,
        runId,
        workDir: workspace.workDir,
        subAgentRegistry: this.subAgentRegistry,
        deps: this.scoutDeps,
        store: this.store,
        onEvent: (event) => {
          const completed = [...this.stateValue.baseline.completedRoles]
          if (!completed.includes(event.role) && event.record.status === 'completed') completed.push(event.role)
          this.stateValue.baseline.completedRoles = completed
          void this.persist()
          this.onEvent?.({ runId, mode: 'baseline', ...event, record: event.record })
        },
      })
      this.stateValue.baseline = {
        status: result.failedRoles.length === 0 ? 'completed' : 'failed',
        runId,
        completedRoles: result.completedRoles,
        startedAt,
        endedAt: Date.now(),
        ...(workspace.warnings.length > 0 ? { warnings: workspace.warnings } : {}),
      }
      this.stateValue.phase = result.failedRoles.length === 0 ? 'ready' : 'baseline'
      this.stateValue.lastReportId = result.runId
      await this.persist()
      this.onEvent?.({
        runId: result.runId,
        mode: 'baseline',
        phase: result.failedRoles.length === 0 ? 'completed' : 'failed',
        ...(result.failedRoles.length === 0 ? {} : { error: `Scout failures: ${result.failedRoles.join(', ')}` }),
      })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.stateValue.baseline = { status: 'failed', runId, completedRoles: [], startedAt, endedAt: Date.now(), error: message }
      this.stateValue.phase = 'baseline'
      await this.persist()
      this.onEvent?.({ runId, mode: 'baseline', phase: 'failed', error: message })
      throw error
    }
  }

  hooks(): LoopHooks {
    return {
      afterToolExecution: async (ctx) => {
        if (!this.stateValue.enabled) return undefined
        for (const turn of ctx.toolResults) await this.observeTool(turn)
        return undefined
      },
      afterGuards: async (ctx) => {
        if (!this.stateValue.enabled || ctx.hits.length === 0) return undefined
        this.stateValue.lastGuard = { ids: ctx.hits.map((hit) => hit.id), at: Date.now() }
        await this.persist()
        return undefined
      },
    }
  }

  injection(): ContextInjectionSource {
    return {
      name: 'long_horizon_workflow',
      priority: 90,
      position: 'afterUser',
      inject: async () => {
        if (!this.stateValue.enabled) return null
        return `${this.skillText}\n\n[LongHorizon 状态]\n${JSON.stringify(this.stateValue)}`
      },
    }
  }

  private async observeTool(turn: ToolTurn): Promise<void> {
    const evidence = {
      sessionId: this.sessionId,
      at: Date.now(),
      toolTurnId: turn.id,
      toolCallId: turn.toolCallId,
      toolName: turn.toolName,
      stamp: stampOfToolTurn(turn),
      sourceAgentId: turn.sourceAgentId,
      contentLength: turn.content.length,
      isError: turn.isError === true,
    }
    this.evidenceWrite = this.evidenceWrite
      .then(() => this.store.appendEvidence(this.sessionId, evidence))
      .then(() => {
        this.stateValue.evidenceCount += 1
        return this.persist()
      })
    await this.evidenceWrite
  }

  private async persist(): Promise<void> {
    const write = this.stateWrite.then(async () => {
      this.stateValue = { ...this.stateValue, updatedAt: Date.now() }
      await this.store.save(this.stateValue)
    })
    this.stateWrite = write.catch(() => undefined)
    await write
  }
}

export const createNoopWorkflowState = (sessionId: string): WorkflowState => defaultWorkflowState(sessionId)
