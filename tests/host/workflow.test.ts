import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { createHostAssembly } from '../../src/host/assembly.js'
import { parseScoutReport } from '../../src/host/workflow/report.js'
import { baselineStagePrompt } from '../../src/host/workflow/prompts.js'
import { WorkflowStore } from '../../src/host/workflow/store.js'
import { checkWorkflowWorkspace } from '../../src/host/workflow/workspace.js'
import type { BaselineCheckpoint, ScoutRunRecord } from '../../src/host/workflow/types.js'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('LongHorizon workflow report and persistence', () => {
  it('parses structured scout output and preserves invalid raw output', () => {
    const valid = parseScoutReport('structure', [
      '```json',
      JSON.stringify({
        role: 'structure',
        findings: [{ claim: 'entry exists', path: 'src/index.ts', confidence: 'verified', impact: 'maps the entrypoint' }],
        commands: ['npm test'],
        openQuestions: [],
      }),
      '```',
    ].join('\n'))
    expect(valid.status).toBe('completed')
    expect(valid.findings[0]?.path).toBe('src/index.ts')

    const raw = 'model output that is not JSON'
    const invalid = parseScoutReport('risk', raw)
    expect(invalid.status).toBe('invalid-report')
    expect(invalid.rawOutput).toBe(raw)
  })

  it('accepts explanatory text around fenced JSON and records compatibility warnings', () => {
    const report = parseScoutReport('risk', [
      'I inspected the repository. Here is the structured result:',
      '```json',
      JSON.stringify({
        role: 'risk',
        findings: [{ conclusion: 'door exists', file: 'src/security/door.ts', confidence: 'verified', whyItMatters: 'protects writes' }],
      }),
      '```',
    ].join('\n'))
    expect(report.status).toBe('completed')
    expect(report.extractionMode).toBe('fenced-json')
    expect(report.findings[0]).toMatchObject({ claim: 'door exists', path: 'src/security/door.ts', impact: 'protects writes' })
    expect(report.warnings).toContain('missing optional field: commands')
  })

  it('normalizes string, object, and mixed openQuestions without rejecting the report', () => {
    const report = parseScoutReport('risk', JSON.stringify({
      schemaVersion: 1,
      kind: 'baseline.scout',
      role: 'risk',
      findings: [{
        claim: 'approval door exists',
        path: 'src/security/door.ts',
        confidence: 'verified',
        impact: 'protects writes',
        tools: ['read'],
        commands: ['npm test'],
        evidence: [
          'stamp-1',
          { stamp: 'stamp-2', path: 'src/security/door.ts', startLine: 4, endLine: 8, tool: 'read' },
          { path: 'src/security/door.ts', range: '4-8' },
        ],
      }],
      commands: ['npm test'],
      openQuestions: [
        'does the door cover MCP tools?',
        { question: 'does the door cover skills?', verifyPath: 'src/security/router.ts' },
        { question: 'missing verify path is still valid' },
        { verifyPath: 'src/security/router.ts' },
      ],
      coveredRanges: [{ path: 'src/security/door.ts', startLine: 4, endLine: 8 }],
      uncoveredRanges: [{ path: 'src/security/router.ts', range: 'not supported' }],
    }))
    expect(report.status).toBe('completed')
    expect(report.openQuestions).toEqual([
      'does the door cover MCP tools?',
      'does the door cover skills?',
      'missing verify path is still valid',
    ])
    expect(report.openQuestionDetails).toEqual([
      { question: 'does the door cover MCP tools?' },
      { question: 'does the door cover skills?', verifyPath: 'src/security/router.ts' },
      { question: 'missing verify path is still valid' },
    ])
    expect(report.findings[0]?.evidenceStamps).toEqual(['stamp-1', 'stamp-2'])
    expect(report.findings[0]?.evidence?.[1]).toMatchObject({ path: 'src/security/door.ts', startLine: 4, endLine: 8 })
    expect(report.findings[0]?.tools).toEqual(['read'])
    expect(report.findings[0]?.commands).toEqual(['npm test'])
    expect(report.coveredRanges).toEqual([{ path: 'src/security/door.ts', startLine: 4, endLine: 8 }])
    expect(report.uncoveredRanges).toEqual([{ path: 'src/security/router.ts', range: 'not supported' }])
    expect(report.warnings?.some((warning) => warning.includes('openQuestions[3]'))).toBe(true)
  })

  it('keeps legacy reports valid and only rejects explicit incompatible metadata', () => {
    const legacy = parseScoutReport('structure', '{"findings":[],"commands":[],"openQuestions":["check later"]}')
    expect(legacy.status).toBe('completed')
    expect(legacy.openQuestions).toEqual(['check later'])

    const wrongVersion = parseScoutReport('structure', '{"schemaVersion":2,"findings":[],"commands":[],"openQuestions":[]}')
    expect(wrongVersion.status).toBe('invalid-report')
    expect(wrongVersion.rawOutput).toContain('schemaVersion')

    const wrongStage = parseScoutReport('structure', '{"stage":"evidence","findings":[],"commands":[],"openQuestions":[]}', 'inventory')
    expect(wrongStage.status).toBe('invalid-report')
    expect(wrongStage.rawOutput).toContain('stage')
  })

  it('does not let malformed auxiliary command fields invalidate core findings', () => {
    const report = parseScoutReport('verification', JSON.stringify({
      role: 'verification',
      findings: [{
        claim: 'package boundary exists',
        path: 'package.json',
        confidence: 'verified',
        impact: 'supports deterministic test entry points',
        tools: ['read', { name: 'grep' }],
        commands: { command: 'npm test' },
      }],
      commands: ['npm test', { command: 'npm run typecheck' }],
      openQuestions: [],
    }))
    expect(report.status).toBe('completed')
    expect(report.findings[0]?.tools).toEqual(['read'])
    expect(report.findings[0]?.commands).toEqual([])
    expect(report.commands).toEqual(['npm test'])
    expect(report.warnings?.some((warning) => warning.includes('non-string entries'))).toBe(true)
  })

  it('uses one outer report shape for inventory, evidence, and synthesis prompts', () => {
    for (const stage of ['inventory', 'evidence', 'synthesis'] as const) {
      const prompt = baselineStagePrompt('structure', stage, 'C:/workspace', [])
      expect(prompt).toContain('"schemaVersion":1')
      expect(prompt).toContain('"kind":"baseline.scout"')
      expect(prompt).toContain(`"stage":"${stage}"`)
      expect(prompt).toContain('openQuestions')
    }
  })

  it('round-trips session state, role report, and raw output under the workflow directory', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'workflow-store-'))
    tempDirs.push(dataDir)
    const store = new WorkflowStore(dataDir)
    const state = {
      version: 1 as const,
      sessionId: 'session-a',
      enabled: true,
      phase: 'ready' as const,
      skillActive: true,
      baseline: { status: 'completed' as const, completedRoles: ['structure' as const] },
      evidenceCount: 2,
      updatedAt: 1,
    }
    await store.save(state)
    const loaded = await store.load('session-a')
    expect(loaded).toMatchObject({ sessionId: 'session-a', enabled: true, phase: 'ready' })
    expect(loaded.updatedAt).toBeGreaterThan(1)

    const record: ScoutRunRecord = {
      role: 'structure',
      status: 'completed',
      startedAt: 1,
      endedAt: 2,
      report: parseScoutReport('structure', '{"findings":[],"commands":[],"openQuestions":[]}'),
      rawOutputPath: '',
      evidenceStamps: [],
    }
    const rawPath = await store.saveScoutRecord('session-a', record)
    expect(readFileSync(rawPath, 'utf8')).toContain('findings')
    expect((await store.loadScoutRecord('session-a', 'structure'))?.status).toBe('completed')

    const checkpoint: BaselineCheckpoint = {
      sessionId: 'session-a',
      runId: 'baseline-1',
      role: 'structure',
      stage: 'inventory',
      completed: true,
      startedAt: 1,
      endedAt: 2,
      rawOutputPath: '',
      evidenceStamps: ['abc123def456'],
      pendingRanges: [{ path: 'src/index.ts', start: 1, end: 20 }],
      warnings: [],
    }
    const savedCheckpoint = await store.saveBaselineCheckpoint('session-a', checkpoint, 'inventory output')
    expect(savedCheckpoint.rawOutputPath).toContain('structure.inventory.raw.txt')
    expect((await store.loadBaselineCheckpoint('session-a', 'structure', 'inventory'))?.completed).toBe(true)
    expect(await store.loadBaselineStageOutput('session-a', 'structure', 'inventory')).toBe('inventory output')
  })
})

describe('LongHorizon workflow session boundary', () => {
  it('enables one session without changing another session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-assembly-'))
    tempDirs.push(root)
    const assembly = await createHostAssembly({ dataDir: join(root, 'data'), mock: true })
    try {
      const a = await assembly.gate.command({ kind: 'session.create', payload: { workDir: join(root, 'ws-a') } }) as { info: { id: string } }
      const b = await assembly.gate.command({ kind: 'session.create', payload: { workDir: join(root, 'ws-b') } }) as { info: { id: string } }
      await assembly.gate.command({ kind: 'workflow.enable', sessionId: a.info.id })
      const enabled = await assembly.gate.command({ kind: 'workflow.status', sessionId: a.info.id }) as { enabled: boolean; skillActive: boolean }
      const untouched = await assembly.gate.command({ kind: 'workflow.status', sessionId: b.info.id }) as { enabled: boolean; skillActive: boolean }
      expect(enabled).toMatchObject({ enabled: true, skillActive: true })
      expect(untouched).toMatchObject({ enabled: false, skillActive: false })
      await assembly.gate.command({ kind: 'workflow.disable', sessionId: a.info.id })
      expect((await assembly.gate.command({ kind: 'workflow.status', sessionId: a.info.id }) as { enabled: boolean }).enabled).toBe(false)
    } finally {
      await assembly.shutdown()
    }
  })

  it('blocks a prompt until an enabled workflow has a completed baseline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-baseline-gate-'))
    tempDirs.push(root)
    const assembly = await createHostAssembly({ dataDir: join(root, 'data'), mock: true })
    try {
      const session = await assembly.gate.command({ kind: 'session.create', payload: { workDir: join(root, 'empty-workspace') } }) as { info: { id: string } }
      await assembly.gate.command({ kind: 'workflow.enable', sessionId: session.info.id })
      await expect(assembly.handlers.runPrompt(session.info.id, 'should not start')).rejects.toThrow('baseline is not completed')

      await expect(assembly.gate.command({ kind: 'workflow.baseline', sessionId: session.info.id })).rejects.toThrow('workspace is empty')
      const state = await assembly.gate.command({ kind: 'workflow.status', sessionId: session.info.id }) as { baseline: { status: string; error?: string } }
      expect(state.baseline.status).toBe('failed')
      expect(state.baseline.error).toContain('workspace is empty')
    } finally {
      await assembly.shutdown()
    }
  })

  it('turns the workflow into a no-op after disable and keeps ordinary prompting available', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-disable-'))
    tempDirs.push(root)
    const assembly = await createHostAssembly({ dataDir: join(root, 'data'), mock: true })
    try {
      const session = await assembly.gate.command({ kind: 'session.create', payload: { workDir: join(root, 'workspace') } }) as { info: { id: string } }
      await assembly.gate.command({ kind: 'workflow.enable', sessionId: session.info.id })
      await assembly.gate.command({ kind: 'workflow.disable', sessionId: session.info.id })
      await assembly.gate.command({ kind: 'permission.full', sessionId: session.info.id, enabled: true })
      const result = await assembly.handlers.runPrompt(session.info.id, 'ordinary mode remains available')
      expect(result.reason).toBe('completed')
    } finally {
      await assembly.shutdown()
    }
  })

  it('accepts a readable non-empty workspace without requiring a specific manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-workspace-'))
    tempDirs.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'notes.txt'), 'task-specific workspace', 'utf8')
    const checked = await checkWorkflowWorkspace(workspace)
    expect(checked.workDir).toBe(workspace)
    expect(checked.warnings).toHaveLength(1)
  })
})
