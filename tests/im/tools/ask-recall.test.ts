import { describe, it, expect } from 'vitest'
import { createAskRecallTool } from '../../../src/im/tools/ask-recall.js'
import type { SystemAgent } from '../../../src/im/system-agent.js'
import type { ChatMessage } from '../../../src/protocol/types.js'

describe('im/tools/ask-recall', () => {
  it('ask_recall tool calls the recall agent with query and scope', async () => {
    let calledMessages: unknown[] = []
    const recall: SystemAgent = {
      run: async (input: { messages: ChatMessage[] }) => {
        calledMessages = input.messages
        return { output: 'recall result', metrics: {} as never, finalState: 'Running', reason: 'completed' as const, hits: [] }
      },
      stop() {},
      send() {},
    }
    const tool = createAskRecallTool(recall)
    const result = await tool.execute({ query: 'what happened', scope: 'compressed', reason: 'recall' })

    expect(result).toBe('recall result')
    const msg = calledMessages[0] as { role: string; content: string }
    expect(msg.role).toBe('user')
    const parsed = JSON.parse(msg.content)
    expect(parsed.kind).toBe('ask_recall')
    expect(parsed.query).toBe('what happened')
    expect(parsed.scope).toBe('compressed')
  })
})
