import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

import { createHostAssembly, type HostStreamChat } from '../../src/host/assembly.js'
import type { ChatMessage, StreamChunk } from '../../src/protocol/types.js'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

const done = (text: string): StreamChunk[] => [
  { type: 'content_delta', text },
  { type: 'finish', reason: 'stop' },
  { type: 'done' },
]

const runProjection = async (model: string): Promise<string> => {
  const root = mkdtempSync(join(tmpdir(), `token-counter-${model}-`))
  roots.push(root)
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(home, 'providers.json'), JSON.stringify({
    active: 'test',
    providers: { test: { url: 'https://provider.test/chat', apiKey: 'key', model } },
  }), 'utf8')
  writeFileSync(join(workspace, 'large.txt'), '中'.repeat(30_000), 'utf8')

  const captured: Array<{ messages: ChatMessage[] }> = []
  const streamChat: HostStreamChat = async function* (_url, request) {
    captured.push(request as { messages: ChatMessage[] })
    if (captured.length === 1) {
      yield { type: 'tool_call_delta', index: 0, id: 'read-large', name: 'read' }
      yield {
        type: 'tool_call_delta',
        index: 0,
        arguments_delta: JSON.stringify({ path: 'large.txt', reason: 'verify provider token counter' }),
      }
      yield { type: 'finish', reason: 'tool_calls' }
      yield { type: 'done' }
      return
    }
    yield* done('completed')
  }

  const assembly = await createHostAssembly({
    dataDir: join(root, 'sessions'),
    providerLookup: { homeDir: home },
    promptLayerUserPath: join(home, 'missing-PROMPT.md'),
    llmStreamChatFactory: () => streamChat,
  })
  try {
    const session = await assembly.handlers.session.create({ workDir: workspace })
    const result = await assembly.handlers.runPrompt(session.info.id, 'read the large file')
    expect(result.reason).toBe('completed')
    const tool = captured[1]!.messages.find((message) => message.role === 'tool')
    return tool?.role === 'tool' && typeof tool.content === 'string' ? tool.content : ''
  } finally {
    await assembly.shutdown()
  }
}

describe('host token counter wiring', () => {
  it('uses the active model route in the real loop-to-tool projection path', async () => {
    const genericProjection = await runProjection('glm-5.3-flash')
    const deepSeekProjection = await runProjection('deepseek-v4-flash')

    expect(genericProjection).toContain('[tool-result-projection]')
    expect(deepSeekProjection).not.toContain('[tool-result-projection]')
  })
})
