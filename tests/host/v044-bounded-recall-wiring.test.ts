import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

import { createHostAssembly, type HostAssembly, type HostStreamChat } from '../../src/host/assembly.js'
import { stampOfToolTurn, type ToolTurn } from '../../src/im/databus.js'
import { estimateTokens } from '../../src/shared/token-estimate.js'
import type { ChatMessage, StreamChunk } from '../../src/protocol/types.js'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

const makeAssembly = async (
  root: string,
  streamChat: HostStreamChat,
): Promise<HostAssembly> => createHostAssembly({
  dataDir: join(root, 'sessions'),
  providerLookup: { homeDir: join(root, 'home'), env: { ARK_KEY: 'test-key' } },
  promptLayerUserPath: join(root, 'home', 'missing-PROMPT.md'),
  llmStreamChatFactory: () => streamChat,
})

const done = (text: string): StreamChunk[] => [
  { type: 'content_delta', text },
  { type: 'finish', reason: 'stop' },
  { type: 'done' },
]

describe('v0.44 production wiring', () => {
  it('stores a complete tool result while the next model request sees only the bounded projection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'v044-projection-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const captured: Array<{ messages: ChatMessage[] }> = []
    const streamChat: HostStreamChat = async function* (_url, request) {
      captured.push(request as { messages: ChatMessage[] })
      if (captured.length === 1) {
        yield { type: 'tool_call_delta', index: 0, id: 'read-large', name: 'read' }
        yield {
          type: 'tool_call_delta',
          index: 0,
          arguments_delta: JSON.stringify({ path: 'large.txt', reason: 'verify bounded tool projection' }),
        }
        yield { type: 'finish', reason: 'tool_calls' }
        yield { type: 'done' }
        return
      }
      yield* done('completed')
    }
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'large.txt'), '中'.repeat(30_000), 'utf8')
    const assembly = await makeAssembly(root, streamChat)
    try {
      const session = await assembly.handlers.session.create({ workDir: workspace })
      const result = await assembly.handlers.runPrompt(session.info.id, 'read the large file')
      expect(result.reason).toBe('completed')
      expect(captured).toHaveLength(2)

      const toolMessage = captured[1]!.messages.find((message) => message.role === 'tool')
      expect(toolMessage?.role).toBe('tool')
      const projected = toolMessage?.role === 'tool' && typeof toolMessage.content === 'string'
        ? toolMessage.content
        : ''
      expect(projected).toContain('[tool-result-projection]')
      expect(estimateTokens(projected)).toBeLessThanOrEqual(20_000)

      const full = session.runtime.databus.turns()[0]?.content
      expect(full).toBeDefined()
      expect(full!.length).toBeGreaterThan(projected.length)
    } finally {
      await assembly.shutdown()
    }
  })

  it('delegates an oversized recall through a temporary read-only tool surface', async () => {
    const root = mkdtempSync(join(tmpdir(), 'v044-recall-'))
    roots.push(root)
    const captured: Array<{ messages: ChatMessage[]; tools: unknown[] }> = []
    let targetStamp = ''
    const streamChat: HostStreamChat = async function* (_url, request) {
      const req = request as { messages: ChatMessage[]; tools?: unknown[] }
      captured.push({ messages: req.messages, tools: req.tools ?? [] })
      const systemText = typeof req.messages[0]?.content === 'string' ? req.messages[0].content : ''
      if (systemText.includes('Recall Agent')) {
        const recallCalls = captured.filter((entry) => {
          const first = entry.messages[0]
          return first?.role === 'system' && typeof first.content === 'string' && first.content.includes('Recall Agent')
        }).length
        if (recallCalls === 1) {
          yield { type: 'tool_call_delta', index: 0, id: 'recall-page', name: 'databus_query' }
          yield {
            type: 'tool_call_delta',
            index: 0,
            arguments_delta: JSON.stringify({
              stamp: targetStamp,
              tokenRange: { startToken: 0, endToken: 250_000 },
              reason: 'read the requested range',
            }),
          }
          yield { type: 'finish', reason: 'tool_calls' }
          yield { type: 'done' }
          return
        }
        yield* done('verified summary')
        return
      }
      if (captured.filter((entry) => {
        const first = entry.messages[0]
        return first?.role === 'system' && typeof first.content === 'string' && first.content.includes('Recall Agent')
      }).length === 0) {
        yield { type: 'tool_call_delta', index: 0, id: 'recall-page', name: 'databus_query' }
        yield {
          type: 'tool_call_delta',
          index: 0,
          arguments_delta: JSON.stringify({
            stamp: targetStamp,
            tokenRange: { startToken: 0, endToken: 250_000 },
            reason: 'read the requested range',
          }),
        }
        yield { type: 'finish', reason: 'tool_calls' }
        yield { type: 'done' }
        return
      }
      yield* done('verified summary')
    }
    const assembly = await makeAssembly(root, streamChat)
    try {
      const workspace = join(root, 'workspace')
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, 'README.md'), 'baseline fixture', 'utf8')
      const session = await assembly.handlers.session.create({ workDir: workspace })
      const target: ToolTurn = {
        id: 'tool-large',
        role: 'tool',
        toolCallId: 'call-large',
        toolName: 'read',
        sourceAgentId: 'main',
        at: 1,
        content: '中'.repeat(300_000),
      }
      targetStamp = stampOfToolTurn(target)
      session.runtime.databus.append(target)
      const result = await assembly.handlers.runPrompt(session.info.id, 'summarize the large read result')
      expect(result.reason).toBe('completed')
      const recallEntry = captured.find((entry) => {
        const first = entry.messages[0]
        return first?.role === 'system' && typeof first.content === 'string' && first.content.includes('Recall Agent')
      })
      expect(recallEntry).toBeDefined()
      const names = (recallEntry?.tools ?? [])
        .map((tool) => (tool as { function?: { name?: string } }).function?.name)
        .filter((name): name is string => typeof name === 'string')
        .sort()
      expect(names).toEqual(['databus_query', 'state_query'])
      expect(names).not.toContain('write')
      expect(names).not.toContain('bash')
    } finally {
      await assembly.shutdown()
    }
  })

  it('returns a structured bounded recall report and persists the raw output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'v044-recall-report-'))
    roots.push(root)
    const captured: Array<{ messages: ChatMessage[] }> = []
    let targetStamp = ''
    const recallReport = JSON.stringify({
      facts: [{
        claim: 'The retry path double-writes chunk 7',
        evidenceStamps: ['S-recall-1'],
        coveredRanges: [{ startToken: 0, endToken: 20_000 }],
        confidence: 'verified',
      }],
      uncoveredRanges: [{ startToken: 20_000, endToken: 250_000 }],
      openQuestions: ['Whether chunk 7 predates the crash window'],
    })
    const streamChat: HostStreamChat = async function* (_url, request) {
      const req = request as { messages: ChatMessage[] }
      captured.push({ messages: req.messages })
      const systemText = typeof req.messages[0]?.content === 'string' ? req.messages[0].content : ''
      if (systemText.includes('Recall Agent')) {
        yield { type: 'content_delta', text: `Findings:\n\`\`\`json\n${recallReport}\n\`\`\`` }
        yield { type: 'finish', reason: 'stop' }
        yield { type: 'done' }
        return
      }
      if (captured.filter((entry) => {
        const first = entry.messages[0]
        return first?.role === 'system' && typeof first.content === 'string' && first.content.includes('Recall Agent')
      }).length === 0) {
        yield { type: 'tool_call_delta', index: 0, id: 'recall-page', name: 'databus_query' }
        yield {
          type: 'tool_call_delta',
          index: 0,
          arguments_delta: JSON.stringify({
            stamp: targetStamp,
            tokenRange: { startToken: 0, endToken: 250_000 },
            reason: 'read the requested range',
          }),
        }
        yield { type: 'finish', reason: 'tool_calls' }
        yield { type: 'done' }
        return
      }
      yield* done('final answer')
    }
    const assembly = await makeAssembly(root, streamChat)
    try {
      const workspace = join(root, 'workspace')
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, 'README.md'), 'baseline fixture', 'utf8')
      const session = await assembly.handlers.session.create({ workDir: workspace })
      const target: ToolTurn = {
        id: 'tool-large',
        role: 'tool',
        toolCallId: 'call-large',
        toolName: 'read',
        sourceAgentId: 'main',
        at: 1,
        content: '中'.repeat(300_000),
      }
      targetStamp = stampOfToolTurn(target)
      session.runtime.databus.append(target)
      const result = await assembly.handlers.runPrompt(session.info.id, 'summarize the large read result')
      expect(result.reason).toBe('completed')

      const toolMessage = captured[captured.length - 1]!.messages.find((message) => message.role === 'tool')
      expect(toolMessage?.role).toBe('tool')
      const toolContent = toolMessage?.role === 'tool' && typeof toolMessage.content === 'string'
        ? toolMessage.content
        : ''
      const report = JSON.parse(toolContent) as {
        mode: string
        status: string
        facts: Array<{ claim: string; evidenceStamps: string[] }>
        requestedRange: { startToken: number; endToken: number }
        rawOutputPath: string
      }
      expect(report.mode).toBe('delegated')
      expect(report.status).toBe('completed')
      expect(report.requestedRange).toEqual({ startToken: 0, endToken: 250_000 })
      expect(report.facts[0]?.claim).toBe('The retry path double-writes chunk 7')
      expect(report.facts[0]?.evidenceStamps).toEqual(['S-recall-1'])
      expect(report.rawOutputPath).toContain('large-recall')
      expect(existsSync(report.rawOutputPath)).toBe(true)
      expect(readFileSync(report.rawOutputPath, 'utf8')).toContain('The retry path double-writes chunk 7')
      expect(estimateTokens(toolContent)).toBeLessThanOrEqual(20_000)
    } finally {
      await assembly.shutdown()
    }
  })

  it('runs baseline through SignalGate, persists three stages, and resumes without rerunning completed roles', async () => {
    const root = mkdtempSync(join(tmpdir(), 'v044-baseline-'))
    roots.push(root)
    let calls = 0
    const streamChat: HostStreamChat = async function* (_url, request) {
      calls += 1
      const candidate = (request as { messages: ChatMessage[] }).messages
        .find((message) => message.role === 'user' && typeof message.content === 'string' && message.content.includes('你的角色：'))
        ?.content
      const text = typeof candidate === 'string' ? candidate : ''
      const role = /你的角色：([^\n]+)/.exec(text)?.[1] ?? 'structure'
      const stage = /当前阶段：([^\n]+)/.exec(text)?.[1] ?? 'synthesis'
      yield* done(JSON.stringify({
        role,
        stage,
        findings: [{ claim: 'verified baseline fact', path: 'README.md', confidence: 'verified', impact: 'supports long-horizon planning' }],
        commands: [],
        openQuestions: [],
      }))
    }
    const assembly = await makeAssembly(root, streamChat)
    try {
      const workspace = join(root, 'workspace')
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, 'README.md'), 'baseline fixture', 'utf8')
      const session = await assembly.handlers.session.create({ workDir: workspace })
      await assembly.gate.command({ kind: 'workflow.enable', sessionId: session.info.id })
      const first = await assembly.gate.command({ kind: 'workflow.baseline', sessionId: session.info.id }) as {
        completedRoles: string[]
        failedRoles: string[]
      }
      expect(first.completedRoles).toEqual(['structure', 'verification', 'risk'])
      expect(first.failedRoles).toEqual([])
      expect(calls).toBe(9)

      const baselineDir = join(root, 'sessions', session.info.id, 'state', 'workflow', 'baseline')
      for (const role of ['structure', 'verification', 'risk']) {
        for (const stage of ['inventory', 'evidence', 'synthesis']) {
          expect(existsSync(join(baselineDir, `${role}.${stage}.checkpoint.json`))).toBe(true)
          expect(existsSync(join(baselineDir, `${role}.${stage}.raw.txt`))).toBe(true)
          const checkpoint = JSON.parse(readFileSync(join(baselineDir, `${role}.${stage}.checkpoint.json`), 'utf8')) as {
            completed: boolean
            stageReport?: { stage?: string; findings?: unknown[] }
          }
          expect(checkpoint.completed).toBe(true)
          expect(checkpoint.stageReport?.stage).toBe(stage)
          expect(checkpoint.stageReport?.findings).toHaveLength(1)
        }
      }

      const second = await assembly.gate.command({ kind: 'workflow.baseline', sessionId: session.info.id }) as {
        completedRoles: string[]
        failedRoles: string[]
      }
      expect(second.completedRoles).toEqual(['structure', 'verification', 'risk'])
      expect(second.failedRoles).toEqual([])
      expect(calls).toBe(9)
    } finally {
      await assembly.shutdown()
    }
  })
})
