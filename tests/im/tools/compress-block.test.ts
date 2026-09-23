import { describe, it, expect } from 'vitest'
import { createCompressBlockTool } from '../../../src/im/tools/compress-block.js'
import type { SystemAgent } from '../../../src/im/system-agent.js'
import type { ChatMessage } from '../../../src/protocol/types.js'

describe('im/tools/compress-block', () => {
  it('compress_block calls the compressor agent', async () => {
    let calledMessages: unknown[] = []
    const compressor: SystemAgent = {
      run: async (input: { messages: ChatMessage[] }) => {
        calledMessages = input.messages
        return { output: 'compressed: hello world', metrics: {} as never, finalState: 'Running', reason: 'completed' as const, hits: [] }
      },
      stop() {},
      send() {},
    }
    const tool = createCompressBlockTool(compressor)
    const blockData = [{ id: 't1', role: 'tool', toolCallId: 'tc1', content: 'hello world', sourceAgentId: 'main', at: 0 }]
    const result = await tool.execute({ block: blockData, intent: 'summarize', reason: 'compress' })

    expect(result).toBe('compressed: hello world')
    expect(calledMessages).toHaveLength(1)
    const msg = calledMessages[0] as { role: string; content: string }
    const parsed = JSON.parse(msg.content)
    expect(parsed.kind).toBe('compress_block')
    // block is JSON.stringify'd array — parse it back to verify
    expect(JSON.parse(parsed.block)).toEqual(blockData)
    expect(parsed.intent).toBe('summarize')
  })
})
